/**
 * divi/detached-component — flags detached copies of approved components (confirmed via
 * Figma's detachedInfo) and, heuristically, layers that look like manually recreated
 * registry components.
 *
 * Also exports `getRecreationCandidates`, shared with divi/semantic-mapping so that a node
 * is never reported by both rules.
 */

import type {
  Certainty,
  DesignNode,
  LintContext,
  LintRule,
  RegistryComponent,
  RuleReport,
  Severity,
} from '../types';

import { componentRef } from './where';
export const RULE_ID = 'divi/detached-component';

/** Independent pieces of evidence that a layer recreates a registry component. */
export type RecreationSignal = 'name' | 'structure' | 'label';

export interface RecreationCandidate {
  component: RegistryComponent;
  /** Signals in canonical order: name, structure, label. */
  signals: RecreationSignal[];
  certainty: Certainty;
}

export interface RecreationOptions {
  /** Minimum `structural.confidence` for the structure signal. Default 80. */
  minStructuralConfidence?: number;
  /** Report candidates backed only by the structure signal. Default false. */
  reportStructureOnly?: boolean;
}

export interface DetachedComponentOptions extends Required<RecreationOptions> {
  reportUnregisteredDetached: boolean;
  certaintySeverity: Partial<Record<Certainty, Severity | 'inherit'>>;
}

export const DEFAULT_DETACHED_OPTIONS: DetachedComponentOptions = {
  minStructuralConfidence: 80,
  reportStructureOnly: false,
  reportUnregisteredDetached: true,
  certaintySeverity: { confirmed: 'inherit', likely: 'warning', 'requires-review': 'info' },
};

/** Node types this rule inspects heuristically (definitions and instances are excluded). */
const CONTAINER_TYPES = ['FRAME', 'GROUP'];
const NEVER_TYPES = ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'];

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/**
 * Registry components this node may be a manual recreation of, strongest first
 * (most signals, then component id ascending). Only candidates the detached-component
 * rule would actually report are returned:
 *  - ≥2 signals → 'likely'; a single name or label signal → 'requires-review';
 *    structure-only → 'requires-review' only when `reportStructureOnly`.
 *  - Candidates the node legitimately declares through standards metadata are skipped.
 *  - If the node contains registered descendants (a composition), only candidates with a
 *    name signal are kept.
 * Pure; does not look at `detachedInfo` or the node type.
 */
export function getRecreationCandidates(
  node: DesignNode,
  context: LintContext,
  opts: RecreationOptions = {},
): RecreationCandidate[] {
  const minConf = num(opts.minStructuralConfidence, DEFAULT_DETACHED_OPTIONS.minStructuralConfidence);
  const structureOnly = opts.reportStructureOnly === true;
  const reg = context.registry;

  const byName = reg.candidatesForName(node.baseName || '');
  const structural = node.structural && node.structural.confidence >= minConf ? node.structural.role : null;
  const byStructure = structural ? reg.candidatesForRole(structural) : [];
  const byLabel = node.fkLabel ? reg.candidatesForRole(node.fkLabel) : [];

  const ids: string[] = [];
  const comps: Record<string, RegistryComponent> = {};
  for (const c of byName.concat(byStructure, byLabel)) {
    if (!comps[c.id]) {
      comps[c.id] = c;
      ids.push(c.id);
    }
  }
  if (!ids.length) return [];

  const has = (list: RegistryComponent[], id: string): boolean => list.some((c) => c.id === id);
  const match = context.getRegistryMatch(node);
  let composition: boolean | null = null; // lazily computed

  const out: RecreationCandidate[] = [];
  for (const id of ids) {
    const c = comps[id];
    if (match && match.source === 'metadata' && match.component.id === id && c.allowMetadataMapping === true) continue;

    const signals: RecreationSignal[] = [];
    if (has(byName, id)) signals.push('name');
    if (has(byStructure, id)) signals.push('structure');
    if (has(byLabel, id)) signals.push('label');

    let certainty: Certainty | null = null;
    if (signals.length >= 2) certainty = 'likely';
    else if (signals[0] === 'name' || signals[0] === 'label') certainty = 'requires-review';
    else if (signals[0] === 'structure' && structureOnly) certainty = 'requires-review';
    if (!certainty) continue;

    if (signals.indexOf('name') === -1) {
      if (composition === null) composition = context.getNearestRegisteredDescendants(node).length > 0;
      if (composition) continue;
    }
    out.push({ component: c, signals, certainty });
  }

  out.sort((a, b) => b.signals.length - a.signals.length || (a.component.id < b.component.id ? -1 : a.component.id > b.component.id ? 1 : 0));
  return out;
}

/** True when the rule inspects this node (also used by semantic-mapping to avoid double reports). */
export function isDetachedRuleTarget(node: DesignNode, context: LintContext): boolean {
  if (context.isInstanceInternal(node)) return false;
  if (NEVER_TYPES.indexOf(node.type) !== -1) return false;
  return node.detachedInfo !== null && node.detachedInfo !== undefined ? true : CONTAINER_TYPES.indexOf(node.type) !== -1;
}

function readOptions(raw: Record<string, unknown>): DetachedComponentOptions {
  const o = raw || {};
  return {
    minStructuralConfidence: num(o.minStructuralConfidence, DEFAULT_DETACHED_OPTIONS.minStructuralConfidence),
    reportStructureOnly: o.reportStructureOnly === true,
    reportUnregisteredDetached: o.reportUnregisteredDetached !== false,
    certaintySeverity:
      o.certaintySeverity && typeof o.certaintySeverity === 'object'
        ? (o.certaintySeverity as DetachedComponentOptions['certaintySeverity'])
        : DEFAULT_DETACHED_OPTIONS.certaintySeverity,
  };
}

/**
 * Resolved options of this rule from a run's config (defaults when absent).
 * Lets other rules mirror this rule's decisions deterministically.
 */
export function detachedOptionsFromContext(context: LintContext): DetachedComponentOptions {
  const rc = context.config && context.config.rules ? context.config.rules[RULE_ID] : undefined;
  return readOptions(rc ? rc.options : {});
}

const CERTAINTIES: Certainty[] = ['confirmed', 'likely', 'requires-review'];
const MAP_VALUES = ['inherit', 'error', 'warning', 'warn', 'info'];

function validateOptions(options: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const o = options || {};
  if (o.minStructuralConfidence !== undefined) {
    const v = o.minStructuralConfidence;
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100) errs.push('"minStructuralConfidence" must be a number from 0 to 100');
  }
  for (const key of ['reportStructureOnly', 'reportUnregisteredDetached']) {
    if (o[key] !== undefined && typeof o[key] !== 'boolean') errs.push(`"${key}" must be a boolean`);
  }
  if (o.certaintySeverity !== undefined) {
    const m = o.certaintySeverity;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      errs.push('"certaintySeverity" must be an object');
    } else {
      for (const k of Object.keys(m)) {
        if (CERTAINTIES.indexOf(k as Certainty) === -1) errs.push(`"certaintySeverity" has unknown certainty "${k}"`);
        else if (MAP_VALUES.indexOf((m as Record<string, unknown>)[k] as string) === -1) {
          errs.push(`"certaintySeverity.${k}" must be one of inherit, error, warning, info`);
        }
      }
    }
  }
  return errs;
}

function detachedKey(node: DesignNode): string | null {
  const d = node.detachedInfo;
  if (!d) return null;
  return d.type === 'library' ? d.componentKey : d.resolvedKey || d.resolvedComponentSetKey || null;
}

const DOCS = `
Finds layers that should be instances of approved components but are not.

**Evidence used**
- **Confirmed**: Figma's \`detachedInfo\` on a frame (library key, or the local component's resolved key) matched
  against the registry.
- **Heuristic** (no \`detachedInfo\`), per registry component:
  - *name*: the layer name matches the component's \`match.namePatterns\` or its name;
  - *structure*: the name-blind structural classifier's role is in \`match.roles\` with confidence ≥
    \`minStructuralConfidence\`;
  - *label*: the explicit FigmaKit label (\`[fk:role]\` / \`fk-type\`) is in \`match.roles\`.

**Codes & certainty**
- \`detached-approved\` (confirmed): detached from an approved component.
- \`detached-unregistered\` (confirmed, severity info): detached from a component not in the registry.
- \`recreated-component\`: two or more signals → likely; one name or label signal → requires-review;
  structure only → requires-review when \`reportStructureOnly\`, otherwise not reported.

**False-positive guards**
- Only FRAME / GROUP layers (plus anything with \`detachedInfo\`) are inspected; instances, component definitions
  and layers inside instances are skipped.
- A layer that contains registered components is a composition, not a recreation — skipped unless its *name*
  points at the component.
- A layer that declares the component via standards metadata (where the registry allows it) is skipped.

**Options**: \`minStructuralConfidence\` (80), \`reportStructureOnly\` (false), \`reportUnregisteredDetached\` (true),
\`certaintySeverity\` (confirmed: inherit, likely: warning, requires-review: info).

**Limitations**: heuristics only see FRAME/GROUP layers (a recreated text or image leaf is not detected);
\`detachedInfo\` is lost when the original component was deleted and is unavailable in older Figma versions.

**Autofix:** unsupported — re-insert an instance from the library by hand.
`.trim();

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Approved components must be used as instances, not detached or recreated.',
    docs: DOCS,
    category: 'components',
    defaultSeverity: 'error',
    defaultOptions: {
      minStructuralConfidence: DEFAULT_DETACHED_OPTIONS.minStructuralConfidence,
      reportStructureOnly: DEFAULT_DETACHED_OPTIONS.reportStructureOnly,
      reportUnregisteredDetached: DEFAULT_DETACHED_OPTIONS.reportUnregisteredDetached,
      certaintySeverity: { ...DEFAULT_DETACHED_OPTIONS.certaintySeverity },
    },
    fixable: false,
    validateOptions,
  },

  appliesTo(node: DesignNode, context: LintContext): boolean {
    return isDetachedRuleTarget(node, context);
  },

  validate(node: DesignNode, context: LintContext): RuleReport[] {
    const opts = readOptions(context.options);

    if (node.detachedInfo) {
      const match = context.getRegistryMatch(node);
      if (match && match.source === 'detached') {
        const name = match.component.name;
        return [
          {
            code: 'detached-approved',
            certainty: 'confirmed',
            message: `Detached from approved component ${name}.`,
            suggestion: `Delete this copy and drag in an instance of ${componentRef(match.component)}.`,
            expected: `Instance of ${name}`,
            actual: 'Detached copy',
            fix: {
              kind: 'UNSUPPORTED',
              description: `Insert ${componentRef(match.component)} and move any content over.`,
              operations: [],
            },
            data: { componentId: match.component.id, matchedKey: match.matchedKey, detachedType: node.detachedInfo.type },
          },
        ];
      }
      if (!opts.reportUnregisteredDetached) return [];
      return [
        {
          code: 'detached-unregistered',
          certainty: 'confirmed',
          severity: 'info',
          message: 'Detached from a component that is not in the approved registry.',
          suggestion: 'Use an approved component, or keep it as an intentional custom layer.',
          data: { detachedType: node.detachedInfo.type, componentKey: detachedKey(node) },
        },
      ];
    }

    const candidates = getRecreationCandidates(node, context, opts);
    if (!candidates.length) return [];
    const best = candidates[0];
    const name = best.component.name;
    return [
      {
        code: 'recreated-component',
        certainty: best.certainty,
        message: `Looks like a manually recreated ${name} (heuristic; evidence: ${best.signals.join(', ')}).`,
        suggestion: `Replace with an instance of ${componentRef(best.component)}. If it really must be custom, ask your design-system admin for an exception.`,
        expected: `Instance of ${name}`,
        fix: {
          kind: 'UNSUPPORTED',
          description: `Replace with an instance of ${componentRef(best.component)}.`,
          operations: [],
        },
        data: {
          componentId: best.component.id,
          evidence: best.signals.slice(),
          alternatives: candidates.slice(1).map((c) => c.component.id),
        },
      },
    ];
  },
};
