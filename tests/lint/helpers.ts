/**
 * Test helpers for the FigmaKit Standards linter.
 *
 * - `node()` / `instanceOf()` build plain `DesignNode` objects with sensible defaults.
 * - `finalize()` fills in tree-derived fields (ids, parentId, depth, path, order,
 *   insideInstance, instanceAncestorId). It is idempotent and is called by `lint()`
 *   and `makeContext()` automatically.
 * - `testRegistry()` is an approved, fully-keyed registry used across rule tests.
 * - `lint()` runs the whole pipeline (registry → config → engine → readiness).
 * - `makeContext()` builds a LintContext for unit-testing a single rule.
 */

import type {
  DesignNode,
  ComponentRegistry,
  LintConfig,
  IssueException,
  LintRule,
  LintRunResult,
  ReadinessResult,
  ResolvedConfig,
  RegistryIndex,
  Diagnostic,
  Severity,
  LintSettings,
} from '../../src/lint/types';
import { SPACING_SCALE } from '../../src/shared/constants';
import { loadRegistry, createRegistryIndex, emptyRegistry } from '../../src/lint/registry';
import { resolveConfig, checkRegistryCompatibility } from '../../src/lint/config';
import { createLintContext, type LintContextImpl } from '../../src/lint/context';
import { runLint } from '../../src/lint/engine';
import { evaluateReadiness } from '../../src/lint/readiness';
import { ALL_RULES } from '../../src/lint/rules/index';

const FK_PREFIX = /^\[fk:[^\]]+\]\s*/i;

export type NodeInput = Partial<DesignNode> & { name: string; type?: string; children?: DesignNode[] };

/** Build a DesignNode with defaults. Tree fields are filled in by `finalize()`. */
export function node(partial: NodeInput): DesignNode {
  const name = partial.name;
  const base: DesignNode = {
    id: '',
    name,
    type: 'FRAME',
    visible: true,
    path: [],
    parentId: null,
    depth: 0,
    order: 0,
    children: [],
    width: 100,
    height: 100,
    layoutMode: 'NONE',
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    itemSpacing: 0,
    cornerRadius: null,
    instance: null,
    detachedInfo: null,
    insideInstance: false,
    instanceAncestorId: null,
    fkLabel: null,
    baseName: name.replace(FK_PREFIX, ''),
    analysis: { role: 'container', confidence: 30, source: 'default' },
    structural: null,
    fingerprint: null,
    standardsMeta: { componentId: null },
    fills: [],
    strokes: [],
    fillStyleId: '',
    strokeStyleId: '',
    textStyleId: '',
    boundVariables: {},
    text: null,
  };
  const out = { ...base, ...partial } as DesignNode;
  if (!out.children) out.children = [];
  if (partial.baseName === undefined) out.baseName = name.replace(FK_PREFIX, '');
  return out;
}

export interface InstanceOpts {
  setKey?: string | null;
  setName?: string | null;
  componentName?: string;
  remote?: boolean;
  variantProperties?: Record<string, string> | null;
  componentProperties?: Record<string, string | boolean>;
}

/**
 * Build an INSTANCE node whose main component has `key`.
 * Pass `key = null` to simulate an unresolvable main component (deleted / missing library).
 */
export function instanceOf(key: string | null, partial: NodeInput, opts: InstanceOpts = {}): DesignNode {
  return node({
    type: 'INSTANCE',
    ...partial,
    instance: {
      mainComponent:
        key === null
          ? null
          : {
              id: 'mc-' + key,
              key,
              name: opts.componentName ?? partial.name,
              remote: opts.remote ?? true,
              componentSetKey: opts.setKey ?? null,
              componentSetName: opts.setName ?? (opts.setKey ? opts.componentName ?? partial.name : null),
            },
      variantProperties: opts.variantProperties ?? null,
      componentProperties: opts.componentProperties ?? {},
    },
  });
}

/** A TEXT node with text snapshot defaults. */
export function textNode(partial: NodeInput & { characters?: string }): DesignNode {
  const { characters, ...rest } = partial;
  return node({
    type: 'TEXT',
    analysis: { role: 'text', confidence: 90, source: 'type' },
    text: {
      fontFamily: 'Inter',
      fontStyle: 'Regular',
      fontSize: 16,
      fontWeight: 400,
      lineHeightPx: null,
      textCase: null,
      characters: characters ?? partial.name,
    },
    ...rest,
  });
}

/**
 * Fill in tree-derived fields in place (pre-order across roots) and return roots.
 * Missing ids are assigned deterministically as 'n1', 'n2', ... in pre-order.
 * Idempotent: running it twice yields the same values.
 */
export function finalize(roots: DesignNode[]): DesignNode[] {
  let counter = 0;
  const used = new Set<string>();
  // Collect explicit ids first so generated ids never collide with them.
  const collect = (n: DesignNode): void => {
    if (n.id) used.add(n.id);
    for (const c of n.children) collect(c);
  };
  roots.forEach(collect);

  const visit = (n: DesignNode, parent: DesignNode | null, depth: number, path: string[], instAncestor: string | null): void => {
    counter++;
    if (!n.id) {
      let candidate = 'n' + counter;
      while (used.has(candidate)) candidate = candidate + '_';
      n.id = candidate;
      used.add(candidate);
    }
    n.parentId = parent ? parent.id : null;
    n.depth = depth;
    n.path = path.concat([n.name]);
    n.order = counter - 1;
    n.insideInstance = instAncestor !== null;
    n.instanceAncestorId = instAncestor;
    const nextAncestor = n.type === 'INSTANCE' ? n.id : instAncestor;
    for (const c of n.children) visit(c, n, depth + 1, n.path, nextAncestor);
  };
  for (const r of roots) visit(r, null, 0, [], null);
  return roots;
}

/** Approved test registry (see DESIGN.md "tests/lint/helpers.ts"). */
export function testRegistry(): ComponentRegistry {
  return {
    version: '1.0.0',
    designSystem: 'Divi 5 (test)',
    status: 'approved',
    description: 'Test registry',
    components: [
      {
        id: 'divi-section',
        name: 'Divi Section',
        diviType: 'et_pb_section',
        figmaComponentKeys: ['key-section'],
        allowedChildren: ['divi-row'],
        allowedParents: ['$root'],
        governsChildren: true,
        match: { namePatterns: ['^(divi[-_ ]?)?section$'], roles: ['section'] },
      },
      {
        id: 'divi-row',
        name: 'Divi Row',
        diviType: 'et_pb_row',
        figmaComponentKeys: ['key-row'],
        allowedChildren: ['divi-column'],
        allowedParents: ['divi-section'],
        governsChildren: true,
        match: { namePatterns: ['^(divi[-_ ]?)?row$'], roles: ['row'] },
      },
      {
        id: 'divi-column',
        name: 'Divi Column',
        diviType: 'et_pb_column',
        figmaComponentKeys: ['key-column'],
        allowedChildren: ['divi-button', 'divi-text', 'divi-image', 'divi-blurb'],
        governsChildren: true,
        match: { namePatterns: ['^(divi[-_ ]?)?(column|col)$'], roles: ['column'] },
      },
      {
        id: 'divi-button',
        name: 'Divi Button',
        diviType: 'et_pb_button',
        figmaComponentKeys: ['key-button', 'set-button'],
        requiresAutoLayout: { direction: 'HORIZONTAL' },
        requiredProperties: [{ name: 'Type', allowedValues: ['Primary', 'Secondary'] }],
        match: { namePatterns: ['^(divi[-_ ]?)?(button|btn)$'], roles: ['button'] },
      },
      {
        id: 'divi-text',
        name: 'Divi Text',
        diviType: 'et_pb_text',
        figmaComponentKeys: ['key-text'],
        match: { namePatterns: ['^(divi[-_ ]?)?text$'], roles: ['text'] },
      },
      {
        id: 'divi-image',
        name: 'Divi Image',
        diviType: 'et_pb_image',
        figmaComponentKeys: ['key-image'],
        match: { namePatterns: ['^(divi[-_ ]?)?image$'], roles: ['image'] },
      },
      {
        id: 'divi-blurb',
        name: 'Divi Blurb',
        diviType: 'et_pb_blurb',
        figmaComponentKeys: ['key-blurb'],
        allowMetadataMapping: true,
        match: { namePatterns: ['^(divi[-_ ]?)?blurb$'], roles: ['feature'] },
      },
    ],
    tokens: {
      spacing: Object.keys(SPACING_SCALE).map((name) => ({ name, value: SPACING_SCALE[name] })),
      colors: [
        { name: 'brand', value: '#4f46e5' },
        { name: 'ink', value: '#111111' },
        { name: 'white', value: '#ffffff' },
      ],
      typography: [
        { name: 'body', fontSize: 16, fontWeight: 400 },
        { name: 'h1', fontSize: 48, fontWeight: 700 },
      ],
      fontFamilies: ['Inter'],
    },
  };
}

export interface LintOpts {
  config?: LintConfig;
  registry?: ComponentRegistry | unknown;
  exceptions?: IssueException[];
  rules?: LintRule[];
  /** ISO timestamp used for exception expiry. Default '2026-01-01T00:00:00.000Z'. */
  now?: string;
}

export interface LintOutput {
  result: LintRunResult;
  readiness: ReadinessResult;
  config: ResolvedConfig;
  registry: RegistryIndex | null;
  configDiagnostics: Diagnostic[];
  registryDiagnostics: Diagnostic[];
}

export const TEST_NOW = '2026-01-01T00:00:00.000Z';

/**
 * Full pipeline convenience: load registry, resolve config, run engine, evaluate readiness.
 * Defaults: registry = testRegistry(), config = { extends: ['figmakit:recommended'] }, rules = ALL_RULES.
 */
export function lint(roots: DesignNode[], opts: LintOpts = {}): LintOutput {
  finalize(roots);
  const rules = opts.rules ?? ALL_RULES;
  const loaded = loadRegistry(opts.registry === undefined ? testRegistry() : opts.registry);
  const resolved = resolveConfig(opts.config ?? { extends: ['figmakit:recommended'] }, rules);
  const configDiagnostics = resolved.diagnostics.slice();
  if (loaded.index) {
    configDiagnostics.push(...checkRegistryCompatibility(resolved.config, loaded.index.version));
  }
  const index = loaded.index ?? createRegistryIndex(emptyRegistry());
  const result = runLint({
    roots,
    rules,
    config: resolved.config,
    registry: index,
    configDiagnostics,
    registryDiagnostics: loaded.diagnostics,
    exceptions: opts.exceptions ?? [],
    now: opts.now ?? TEST_NOW,
  });
  const readiness = evaluateReadiness({ result, config: resolved.config, registry: loaded.index });
  return {
    result,
    readiness,
    config: resolved.config,
    registry: loaded.index,
    configDiagnostics,
    registryDiagnostics: loaded.diagnostics,
  };
}

export interface ContextOpts {
  registry?: ComponentRegistry;
  config?: LintConfig;
  rules?: LintRule[];
  /** Rule to activate on the context (options/severity come from resolved config unless overridden). */
  ruleId?: string;
  options?: Record<string, unknown>;
  severity?: Severity;
  settings?: Partial<LintSettings>;
}

/**
 * Build a LintContext for unit-testing a rule directly (finalizes roots).
 * If `ruleId` is given and present in the resolved config, its options/severity are applied,
 * then `options` (shallow-merged) / `severity` overrides.
 */
export function makeContext(roots: DesignNode[], opts: ContextOpts = {}): LintContextImpl {
  finalize(roots);
  const rules = opts.rules ?? ALL_RULES;
  const loaded = loadRegistry(opts.registry ?? testRegistry());
  if (!loaded.index) {
    throw new Error('makeContext: registry failed to load: ' + JSON.stringify(loaded.diagnostics));
  }
  const cfg: LintConfig = { ...(opts.config ?? { extends: ['figmakit:recommended'] }) };
  if (opts.settings) cfg.settings = { ...(cfg.settings ?? {}), ...opts.settings };
  const resolved = resolveConfig(cfg, rules).config;
  const ctx = createLintContext({ roots, registry: loaded.index, config: resolved });
  const ruleId = opts.ruleId ?? 'test/rule';
  const rc = resolved.rules[ruleId];
  ctx.setRule(
    ruleId,
    opts.severity ?? (rc ? rc.severity : 'error'),
    { ...(rc ? rc.options : {}), ...(opts.options ?? {}) },
  );
  return ctx;
}

/** Depth-first pre-order list of all nodes. */
export function flatten(roots: DesignNode[]): DesignNode[] {
  const out: DesignNode[] = [];
  const visit = (n: DesignNode): void => {
    out.push(n);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

/** Find a node by name (first in pre-order). Throws if missing. */
export function byName(roots: DesignNode[], name: string): DesignNode {
  const found = flatten(roots).find((n) => n.name === name);
  if (!found) throw new Error('node not found: ' + name);
  return found;
}
