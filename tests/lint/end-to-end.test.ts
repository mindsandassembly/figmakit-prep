/**
 * End-to-end: RAW mock Figma nodes → snapshot → config → engine (ALL_RULES) → readiness.
 *
 * Unlike the rule tests (which build DesignNode objects directly), these tests go
 * through `buildDesignTree` with mock Figma nodes, so they exercise the snapshot
 * adapter, analyzer integration, registry loading, config resolution, every rule,
 * and readiness together.
 */

import { describe, it, expect } from 'vitest';
import {
  mockFrameNode,
  mockInstanceNode,
  mockTextNode,
  mockSolidPaint,
} from '../helpers/figma-mock';
import { buildDesignTree, createMockResolver } from '../../src/lint/snapshot';
import { resolveConfig, checkRegistryCompatibility, BUNDLED_CONFIG } from '../../src/lint/config';
import { loadRegistry } from '../../src/lint/registry';
import { runLint } from '../../src/lint/engine';
import { evaluateReadiness } from '../../src/lint/readiness';
import { ALL_RULES } from '../../src/lint/rules/index';
import type { LintConfig, ComponentRegistry } from '../../src/lint/types';
import bundledRegistry from '../../src/standards/registry.json';
import { testRegistry, TEST_NOW } from './helpers';

// ---------------------------------------------------------------------------
// Raw mock builders (explicit ids everywhere: figma-mock defaults to random ids)
// ---------------------------------------------------------------------------

const INK = { r: 17 / 255, g: 17 / 255, b: 17 / 255 };

function text(id: string, name: string, characters: string): any {
  return mockTextNode({ id, name, characters, fills: [mockSolidPaint({ color: INK })] });
}

interface MainSpec {
  key: string;
  name: string;
  setKey?: string | null;
  setName?: string | null;
}

function main(spec: MainSpec) {
  return {
    id: 'mc:' + spec.key,
    key: spec.key,
    name: spec.name,
    remote: true,
    componentSetKey: spec.setKey ?? null,
    componentSetName: spec.setName ?? null,
  };
}

/** Raw INSTANCE whose main component is resolved via the async API (as in real Figma). */
function rawInstance(id: string, name: string, spec: MainSpec | null, overrides: Record<string, unknown> = {}): any {
  const mc = spec ? main(spec) : null;
  return mockInstanceNode({
    id,
    name,
    getMainComponentAsync: async () => mc,
    ...overrides,
  });
}

/** Auto-layout container instance (section / row / column) with on-scale spacing. */
function containerInstance(id: string, name: string, key: string, children: any[], layoutMode = 'VERTICAL'): any {
  return rawInstance(id, name, { key, name }, {
    layoutMode,
    paddingTop: 24,
    paddingBottom: 24,
    paddingLeft: 16,
    paddingRight: 16,
    itemSpacing: 16,
    width: 1200,
    height: 400,
    children,
  });
}

function approvedButton(id: string): any {
  return rawInstance(
    id,
    'Button',
    { key: 'key-button', name: 'Type=Primary', setKey: 'set-button', setName: 'Divi Button' },
    {
      layoutMode: 'HORIZONTAL',
      paddingTop: 8,
      paddingBottom: 8,
      paddingLeft: 16,
      paddingRight: 16,
      itemSpacing: 8,
      width: 120,
      height: 40,
      variantProperties: { Type: 'Primary' },
      componentProperties: { 'Type': { type: 'VARIANT', value: 'Primary' }, 'Label#12:0': { type: 'TEXT', value: 'Go' } },
      children: [text(id + ':label', 'Label', 'Go')],
    },
  );
}

function approvedText(id: string): any {
  return rawInstance(id, 'Text', { key: 'key-text', name: 'Divi Text' }, {
    width: 400,
    height: 48,
    children: [text(id + ':copy', 'Copy', 'Hello world')],
  });
}

/** Page scope root: a plain frame holding an approved Section instance. */
function page(id: string, columnChildren: any[]): any {
  const column = containerInstance(id + ':col', 'Column', 'key-column', columnChildren);
  const row = containerInstance(id + ':row', 'Row', 'key-row', [column], 'HORIZONTAL');
  const section = containerInstance(id + ':sec', 'Section', 'key-section', [row]);
  return mockFrameNode({
    id,
    name: 'Home',
    width: 1440,
    height: 900,
    fills: [mockSolidPaint({ color: { r: 1, g: 1, b: 1 } })],
    children: [section],
  });
}

function cleanPage(): any {
  return page('1:1', [approvedButton('1:10'), approvedText('1:11')]);
}

/** Same page, but the column also contains an instance of a component NOT in the registry. */
function pageWithUnapprovedInstance(): any {
  const rogue = rawInstance('2:12', 'Fancy Card', { key: 'key-rogue-card', name: 'Fancy Card' }, {
    width: 300,
    height: 200,
    children: [text('2:12:t', 'Title', 'Rogue')],
  });
  return page('2:1', [approvedButton('2:10'), approvedText('2:11'), rogue]);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(rawRoots: any[], config: LintConfig, registryInput: ComponentRegistry | unknown = testRegistry()) {
  const resolved = resolveConfig(config, ALL_RULES);
  const loaded = loadRegistry(registryInput);
  expect(loaded.index).not.toBeNull();
  const configDiagnostics = resolved.diagnostics.concat(
    checkRegistryCompatibility(resolved.config, loaded.index!.version),
  );
  const snap = await buildDesignTree(rawRoots, createMockResolver(), {
    includeHidden: resolved.config.settings.includeHidden,
  });
  const result = runLint({
    roots: snap.roots,
    rules: ALL_RULES,
    config: resolved.config,
    registry: loaded.index!,
    configDiagnostics,
    registryDiagnostics: loaded.diagnostics,
    exceptions: [],
    now: TEST_NOW,
  });
  const readiness = evaluateReadiness({ result, config: resolved.config, registry: loaded.index });
  return { snap, resolved, result, readiness };
}

/**
 * Sections/rows/columns are library instances here, so everything nested in them is an
 * instance internal. Governance of nested content therefore needs checkInstanceInternals.
 */
const GOVERNED_CONFIG: LintConfig = {
  extends: ['figmakit:recommended'],
  rulesetVersion: '1.0.0',
  settings: { checkInstanceInternals: true },
};

describe('end-to-end: raw Figma mocks → readiness', () => {
  it('bundled config resolves against ALL_RULES with no error diagnostics', () => {
    const { config, diagnostics } = resolveConfig(BUNDLED_CONFIG, ALL_RULES);
    expect(diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(Object.keys(config.rules)).toEqual(ALL_RULES.map((r) => r.meta.id));
    expect(Object.keys(config.rules)).toHaveLength(8);
    for (const id of Object.keys(config.rules)) expect(config.rules[id].enabled).toBe(true);
  });

  it('snapshot resolves instances via getMainComponentAsync and strips property ids', async () => {
    const { snap } = await runPipeline([cleanPage()], GOVERNED_CONFIG);
    const section = snap.roots[0].children[0];
    expect(section.instance?.mainComponent?.key).toBe('key-section');
    const button = section.children[0].children[0].children[0];
    expect(button.instance?.mainComponent?.componentSetKey).toBe('set-button');
    expect(button.instance?.componentProperties).toEqual({ Type: 'Primary', Label: 'Go' });
    expect(button.insideInstance).toBe(true);
    expect(snap.nodeCount).toBe(8);
  });

  it('clean approved page is READY with zero blocking issues (default settings)', async () => {
    const { result, readiness } = await runPipeline([cleanPage()], BUNDLED_CONFIG);
    expect(result.internalErrors).toEqual([]);
    expect(result.configDiagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(result.issues.filter((i) => i.blocking)).toEqual([]);
    expect(readiness.reasons).toEqual([]);
    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe('READY');
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.totals.checks).toBeGreaterThan(0);
  });

  it('clean approved page is READY with zero issues when instance internals are checked', async () => {
    const { result, readiness } = await runPipeline([cleanPage()], GOVERNED_CONFIG);
    expect(result.issues).toEqual([]);
    expect(readiness.status).toBe('READY');
    expect(readiness.blockingIssues).toEqual([]);
    for (const s of result.ruleSummaries) expect(s.status).toBe('passed');
  });

  it('unapproved instance inside a governed section blocks readiness', async () => {
    const { result, readiness } = await runPipeline([pageWithUnapprovedInstance()], GOVERNED_CONFIG);
    const unapproved = result.issues.filter((i) => i.code === 'unapproved-instance');
    expect(unapproved).toHaveLength(1);
    expect(unapproved[0]).toMatchObject({
      ruleId: 'divi/approved-component',
      nodeId: '2:12',
      nodeName: 'Fancy Card',
      severity: 'error',
      certainty: 'confirmed',
      blocking: true,
    });
    expect(unapproved[0].nodePath).toBe('Home / Section / Row / Column / Fancy Card');
    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe('NOT_READY');
    expect(readiness.blockingIssues.map((i) => i.id)).toContain(unapproved[0].id);
    expect(readiness.reasons.length).toBeGreaterThan(0);
  });

  it('bundled draft registry never certifies readiness, even for a clean page', async () => {
    const { result, readiness } = await runPipeline([cleanPage()], BUNDLED_CONFIG, bundledRegistry);
    expect(result.internalErrors).toEqual([]);
    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe('NOT_READY');
  });

  it('flags an unapproved instance swapped into an instance-based governed section by default', async () => {
    // The rogue instance sits inside the Section INSTANCE (a swap / slot). Nested instances are
    // checked by default even though ordinary instance internals are not.
    const { result, readiness } = await runPipeline([pageWithUnapprovedInstance()], BUNDLED_CONFIG);
    expect(result.issues.filter((i) => i.code === 'unapproved-instance').length).toBeGreaterThan(0);
    expect(readiness.status).toBe('NOT_READY');
  });

  it('strict preset governs the scope root: unapproved top-level instance blocks', async () => {
    const rogue = rawInstance('3:2', 'Fancy Card', { key: 'key-rogue-card', name: 'Fancy Card' }, {
      width: 300,
      height: 200,
      children: [text('3:2:t', 'Title', 'Rogue')],
    });
    const root = mockFrameNode({ id: '3:1', name: 'Landing', width: 1440, height: 900, children: [rogue] });
    const { result, readiness } = await runPipeline([root], { extends: ['figmakit:strict'], rulesetVersion: '1.0.0' });
    const unapproved = result.issues.filter((i) => i.code === 'unapproved-instance');
    expect(unapproved.map((i) => i.nodeId)).toEqual(['3:2']);
    expect(unapproved[0].blocking).toBe(true);
    expect(readiness.status).toBe('NOT_READY');

    // Same tree under the recommended preset: top level is not governed.
    const rec = await runPipeline([root], BUNDLED_CONFIG);
    expect(rec.result.issues.filter((i) => i.code === 'unapproved-instance')).toEqual([]);
  });

  it('is deterministic: two runs over freshly built trees are deep-equal', async () => {
    const a = await runPipeline([pageWithUnapprovedInstance(), cleanPage()], GOVERNED_CONFIG);
    const b = await runPipeline([pageWithUnapprovedInstance(), cleanPage()], GOVERNED_CONFIG);
    expect(b.snap.roots).toEqual(a.snap.roots);
    expect(b.result).toEqual(a.result);
    expect(b.readiness).toEqual(a.readiness);
    expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
    expect(a.result.issues.length).toBeGreaterThan(0);
  });
});
