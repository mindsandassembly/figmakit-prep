import BUNDLED_CONFIG_LOCKED from '../src/standards/figmakit.config.json';
/**
 * Standards controller (Figma main-thread glue) — tested against a fake `figma` object.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFrameNode, mockInstanceNode, mockTextNode, mockSolidPaint } from './helpers/figma-mock';
import { testRegistry } from './lint/helpers';
import { verifyContentHash } from '../src/lint/reporter';
import { STANDARDS_SHARED_NAMESPACE, INTERNAL_ERROR_RULE_ID } from '../src/lint/types';
import type { HandoffReport } from '../src/lint/types';

// Allow individual tests to make the snapshot step throw.
const snapshotControl = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/lint/snapshot', async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    buildDesignTree: async (...args: any[]) => {
      if (snapshotControl.fail) throw new Error('boom: node tree unavailable');
      return orig.buildDesignTree(...args);
    },
  };
});

import {
  handleStandardsMessage,
  isStandardsMessage,
  resetStandardsState,
  slugifyComponentId,
  MARK_READY_NOTICE,
} from '../src/standards-controller';

const NOW = '2026-10-13T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Raw Figma mock fixtures
// ---------------------------------------------------------------------------

const INK = { r: 17 / 255, g: 17 / 255, b: 17 / 255 };

function text(id: string, name: string, characters: string): any {
  return mockTextNode({ id, name, characters, fills: [mockSolidPaint({ color: INK })] });
}

function rawInstance(id: string, name: string, main: { key: string; name: string; setKey?: string; setName?: string } | null, overrides: Record<string, unknown> = {}): any {
  const mc = main
    ? { id: 'mc:' + main.key, key: main.key, name: main.name, remote: true, componentSetKey: main.setKey ?? null, componentSetName: main.setName ?? null }
    : null;
  return mockInstanceNode({ id, name, getMainComponentAsync: async () => mc, ...overrides });
}

function container(id: string, name: string, key: string, children: any[], layoutMode = 'VERTICAL'): any {
  return rawInstance(id, name, { key, name }, {
    layoutMode, paddingTop: 24, paddingBottom: 24, paddingLeft: 16, paddingRight: 16, itemSpacing: 16,
    width: 1200, height: 400, children,
  });
}

function button(id: string): any {
  return rawInstance(id, 'Button', { key: 'key-button', name: 'Type=Primary', setKey: 'set-button', setName: 'Divi Button' }, {
    layoutMode: 'HORIZONTAL', paddingTop: 8, paddingBottom: 8, paddingLeft: 16, paddingRight: 16, itemSpacing: 8,
    width: 120, height: 40,
    variantProperties: { Type: 'Primary' },
    componentProperties: { Type: { type: 'VARIANT', value: 'Primary' } },
    children: [text(id + ':label', 'Label', 'Go')],
  });
}

function textModule(id: string): any {
  return rawInstance(id, 'Text', { key: 'key-text', name: 'Divi Text' }, {
    width: 400, height: 48, children: [text(id + ':copy', 'Copy', 'Hello')],
  });
}

function rogue(id: string): any {
  return rawInstance(id, 'Fancy Card', { key: 'key-rogue-card', name: 'Fancy Card' }, {
    width: 300, height: 200, children: [text(id + ':t', 'Title', 'Rogue')],
  });
}

/** "Home" frame → Section → Row → Column → columnChildren. */
function homeFrame(prefix: string, columnChildren: any[], opts: { sectionName?: string; paddingTop?: number } = {}): any {
  const column = container(prefix + ':col', 'Column', 'key-column', columnChildren);
  const row = container(prefix + ':row', 'Row', 'key-row', [column], 'HORIZONTAL');
  const section = container(prefix + ':sec', opts.sectionName ?? 'Section', 'key-section', [row]);
  return mockFrameNode({
    id: prefix,
    name: 'Home',
    width: 1440,
    height: 900,
    layoutMode: opts.paddingTop !== undefined ? 'VERTICAL' : 'NONE',
    paddingTop: opts.paddingTop ?? 0,
    fills: [mockSolidPaint({ color: { r: 1, g: 1, b: 1 } })],
    children: [section],
  });
}

function cleanHome(): any {
  return homeFrame('1:1', [button('1:10'), textModule('1:11')]);
}

function homeWithRogue(): any {
  return homeFrame('2:1', [button('2:10'), textModule('2:11'), rogue('2:12')]);
}

// ---------------------------------------------------------------------------
// Fake figma
// ---------------------------------------------------------------------------

interface FakeFigma {
  figma: any;
  store: Map<string, string>;
  nodes: Map<string, any>;
  pages: any[];
  register(node: any, parent: any): void;
}

function page(id: string, name: string, children: any[]): any {
  return { id, name, type: 'PAGE', selection: [] as any[], children };
}

function makeFigma(pages: any[]): FakeFigma {
  const store = new Map<string, string>();
  const nodes = new Map<string, any>();
  const register = (n: any, parent: any): void => {
    if (parent) n.parent = parent;
    nodes.set(n.id, n);
    for (const c of n.children || []) register(c, n);
  };
  const root: any = {
    id: '0:0',
    type: 'DOCUMENT',
    name: 'Marketing Site',
    children: pages,
    getSharedPluginData: (ns: string, key: string) => store.get(ns + '/' + key) ?? '',
    setSharedPluginData: vi.fn((ns: string, key: string, value: string) => {
      store.set(ns + '/' + key, value);
    }),
  };
  for (const p of pages) register(p, root);
  const f: any = {
    root,
    currentPage: pages[0],
    fileKey: undefined,
    currentUser: { id: 'u-1', name: 'Dana Designer' },
    getNodeByIdAsync: vi.fn(async (id: string) => nodes.get(id) ?? null),
    setCurrentPageAsync: vi.fn(async (p: any) => {
      f.currentPage = p;
    }),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    importComponentByKeyAsync: vi.fn(async (key: string) => {
      throw new Error('Component not found: ' + key);
    }),
    importComponentSetByKeyAsync: vi.fn(async (key: string) => {
      throw new Error('Component set not found: ' + key);
    }),
    ui: { postMessage: vi.fn() },
  };
  return { figma: f, store, nodes, pages, register };
}

function doc(fake: FakeFigma, key: string): string {
  return fake.store.get(STANDARDS_SHARED_NAMESPACE + '/' + key) ?? '';
}

function harness(fake: FakeFigma, adminTools = true) {
  const messages: any[] = [];
  const deps = { figma: fake.figma, now: () => NOW, postMessage: (m: any) => messages.push(m), adminTools };
  async function send(msg: any): Promise<any[]> {
    const start = messages.length;
    await handleStandardsMessage(msg, deps);
    return messages.slice(start);
  }
  return { messages, deps, send };
}

function last(msgs: any[], type: string): any {
  const found = msgs.filter((m) => m.type === type);
  return found[found.length - 1];
}

async function saveApprovedRegistry(send: (m: any) => Promise<any[]>, registry: unknown = testRegistry()): Promise<void> {
  const out = await send({ type: 'standards-save-config', registryJson: JSON.stringify(registry) });
  const saved = last(out, 'standards-config-saved');
  expect(saved.diagnostics.filter((d: any) => d.level === 'error')).toEqual([]);
  expect(saved.ok).toBe(true);
}

beforeEach(() => {
  resetStandardsState();
  snapshotControl.fail = false;
});

// ---------------------------------------------------------------------------

describe('isStandardsMessage', () => {
  it('matches only standards-* types', () => {
    expect(isStandardsMessage({ type: 'standards-run' })).toBe(true);
    expect(isStandardsMessage({ type: 'scan' })).toBe(false);
    expect(isStandardsMessage(null)).toBe(false);
    expect(isStandardsMessage({})).toBe(false);
  });
});

describe('standards-init / state', () => {
  it('reports bundled draft registry, rules and current user', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    const state = last(await send({ type: 'standards-init' }), 'standards-state');
    expect(state.designSystem).toBe('Divi 5');
    expect(state.registryStatus).toBe('draft');
    expect(state.registrySource).toBe('bundled');
    expect(state.configSource).toBe('bundled');
    expect(state.rulesetVersion).toBe('1.0.0');
    expect(state.rules).toHaveLength(8);
    expect(state.rules[0]).toEqual(expect.objectContaining({ id: expect.any(String), severity: expect.any(String), category: expect.any(String) }));
    expect(state.exceptions).toEqual([]);
    expect(state.lastReadiness).toBeNull();
    expect(state.currentUser).toEqual({ id: 'u-1', name: 'Dana Designer' });
  });

  it('currentUser is null when the API throws (missing permission)', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    Object.defineProperty(fake.figma, 'currentUser', { get() { throw new Error('permission'); } });
    const { send } = harness(fake);
    const state = last(await send({ type: 'standards-init' }), 'standards-state');
    expect(state.currentUser).toBeNull();
  });
});

describe('standards-run', () => {
  it('bundled draft registry: result + readiness posted, NOT_READY', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    const out = await send({ type: 'standards-run' });
    expect(out.filter((m) => m.type === 'standards-progress').map((m) => m.stage)).toEqual(['loading', 'snapshot', 'lint', 'done']);
    const res = last(out, 'standards-result');
    expect(res.result.nodeCount).toBeGreaterThan(0);
    expect(res.readiness.ready).toBe(false);
    expect(res.readiness.status).toBe('NOT_READY');
    expect(res.registry).toEqual({ version: '0.1.0', designSystem: 'Divi 5', status: 'draft', source: 'bundled' });
    expect(res.scope).toEqual({ type: 'page', pageId: '0:1', pageName: 'Page 1', rootNodeIds: ['1:1'], rootNodeNames: ['Home'] });
    expect(res.validatedAt).toBe(NOW);
    expect(res.rulesetVersion).toBe('1.0.0');
  });

  it('approved registry from document: clean page is READY', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    expect(res.readiness.reasons).toEqual([]);
    expect(res.readiness.ready).toBe(true);
    expect(res.readiness.status).toBe('READY');
    expect(res.registry.source).toBe('document');
    expect(res.registry.status).toBe('approved');
    for (const i of res.result.issues) expect(i).not.toHaveProperty('data');
  });

  it('uses the selection as scope when non-empty', async () => {
    const home = cleanHome();
    const p = page('0:1', 'Page 1', [home]);
    const fake = makeFigma([p]);
    p.selection = [home.children[0]];
    const { send } = harness(fake);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    expect(res.scope.type).toBe('selection');
    expect(res.scope.rootNodeIds).toEqual(['1:1:sec']);
  });

  it('corrupt document registry ⇒ NOT ready, never silently falls back to bundled', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    fake.store.set(STANDARDS_SHARED_NAMESPACE + '/registry', '{ "version": "1.0.0", oops');
    const { send } = harness(fake);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    expect(res.readiness.ready).toBe(false);
    expect(res.readiness.status).toBe('NOT_READY');
    expect(res.registry.source).toBe('document');
    expect(res.registry.designSystem).not.toBe('Divi 5');
    expect(res.diagnostics.registry.map((d: any) => d.code)).toContain('invalid-json');
    expect(res.readiness.reasons.join(' ')).toMatch(/registry/i);

    // and mark-ready is refused
    const mr = last(await send({ type: 'standards-mark-ready' }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(false);
    expect(doc(fake, 'readiness')).toBe('');
  });

  it('corrupt document config ⇒ NOT ready with invalid-json diagnostic', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    fake.store.set(STANDARDS_SHARED_NAMESPACE + '/config', 'not json');
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    expect(res.configSource).toBe('document');
    expect(res.diagnostics.config.map((d: any) => d.code)).toContain('invalid-json');
    expect(res.readiness.ready).toBe(false);
  });

  it('snapshot throwing ⇒ NOT_READY with a synthetic internal error', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    snapshotControl.fail = true;
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    expect(res.readiness.ready).toBe(false);
    expect(res.readiness.status).toBe('NOT_READY');
    expect(res.result.internalErrors).toHaveLength(1);
    expect(res.result.internalErrors[0]).toMatchObject({ ruleId: INTERNAL_ERROR_RULE_ID, code: 'snapshot-failed', blocking: true, severity: 'error' });
    expect(res.readiness.reasons[0]).toMatch(/boom/);

    const mr = last(await send({ type: 'standards-mark-ready' }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(false);
    expect(doc(fake, 'readiness')).toBe('');
  });
});

describe('standards-mark-ready', () => {
  it('scenario G: denied with blocking errors; nothing written', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [homeWithRogue()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const out = await send({ type: 'standards-mark-ready' });
    const mr = last(out, 'standards-mark-ready-result');
    expect(mr.ok).toBe(false);
    expect(mr.reasons.join(' ')).toMatch(/blocking issue/);
    expect(doc(fake, 'readiness')).toBe('');
    // it re-ran validation itself
    expect(last(out, 'standards-result').readiness.status).toBe('NOT_READY');
  });

  it('scenario G: re-runs validation instead of trusting an earlier READY run', async () => {
    const home = cleanHome();
    const p = page('0:1', 'Page 1', [home]);
    const fake = makeFigma([p]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    expect(last(await send({ type: 'standards-run' }), 'standards-result').readiness.ready).toBe(true);

    // Document changes after the run: an unapproved instance is dropped into the column.
    const column = home.children[0].children[0].children[0];
    const bad = rogue('1:99');
    column.children.push(bad);
    fake.register(bad, column);

    const mr = last(await send({ type: 'standards-mark-ready' }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(false);
    expect(doc(fake, 'readiness')).toBe('');
  });

  it('re-validates the scope the UI sends, not a selection changed by click-to-select', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    expect(res.scope.type).toBe('page');
    // Clicking an issue selects one layer on the canvas.
    await send({ type: 'standards-select', nodeId: '1:10' });
    expect(fake.figma.currentPage.selection.map((n: any) => n.id)).toEqual(['1:10']);

    const out = await send({ type: 'standards-mark-ready', scope: res.scope });
    const mr = last(out, 'standards-mark-ready-result');
    expect(mr.ok).toBe(true);
    expect(JSON.parse(doc(fake, 'readiness')).scope).toEqual(res.scope);
    expect(last(out, 'standards-result').scope).toEqual(res.scope);

    // Export with re-run validates the same pinned scope too.
    const exp = await send({ type: 'standards-export', rerun: true, scope: res.scope });
    expect(JSON.parse(last(exp, 'standards-export').json).scope).toEqual(res.scope);
  });

  it('denies Mark Ready when the validated layers no longer exist', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const scope = { type: 'selection', pageId: '0:1', pageName: 'Page 1', rootNodeIds: ['gone:1'], rootNodeNames: ['Gone'] };
    const mr = last(await send({ type: 'standards-mark-ready', scope }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(false);
    expect(mr.reasons[0]).toMatch(/changed or no longer exist/);
    expect(doc(fake, 'readiness')).toBe('');
  });

  it('success writes the readiness record to shared plugin data', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const mr = last(await send({ type: 'standards-mark-ready' }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(true);
    expect(mr.status).toBe('READY');
    expect(mr.message).toBe(MARK_READY_NOTICE);
    expect(mr.contentHash).toMatch(/^[0-9a-f]{8}$/);
    const record = JSON.parse(doc(fake, 'readiness'));
    expect(record).toEqual({
      status: 'READY',
      validatedAt: NOW,
      validatedBy: { id: 'u-1', name: 'Dana Designer' },
      rulesetVersion: '1.0.0',
      registryVersion: '1.0.0',
      scope: { type: 'page', pageId: '0:1', pageName: 'Page 1', rootNodeIds: ['1:1'], rootNodeNames: ['Home'] },
      contentHash: mr.contentHash,
      issueCountSummary: expect.objectContaining({ blocking: 0, excepted: 0 }),
    });
    expect(fake.figma.root.setSharedPluginData).toHaveBeenCalledWith(STANDARDS_SHARED_NAMESPACE, 'readiness', expect.any(String));
    // the state now exposes the record
    const state = last(await send({ type: 'standards-init' }), 'standards-state');
    expect(state.lastReadiness.contentHash).toBe(mr.contentHash);
  });

  it('sets devStatus on scope roots only when configured', async () => {
    const home = cleanHome();
    home.devStatus = null;
    const fake = makeFigma([page('0:1', 'Page 1', [home])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    let mr = last(await send({ type: 'standards-mark-ready' }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(true);
    expect(home.devStatus).toBeNull();

    const saved = last(
      await send({ type: 'standards-save-config', configJson: JSON.stringify({ extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', readiness: { setDevStatus: true } }) }),
      'standards-config-saved',
    );
    expect(saved.ok).toBe(true);
    mr = last(await send({ type: 'standards-mark-ready' }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(true);
    expect(home.devStatus).toEqual({ type: 'READY_FOR_DEV' });
  });
});

describe('standards-select', () => {
  it('selects and scrolls to a node on the current page', async () => {
    const home = cleanHome();
    const fake = makeFigma([page('0:1', 'Page 1', [home])]);
    const { send } = harness(fake);
    const out = await send({ type: 'standards-select', nodeId: '1:10' });
    expect(out).toEqual([]);
    expect(fake.figma.setCurrentPageAsync).not.toHaveBeenCalled();
    expect(fake.figma.currentPage.selection).toEqual([fake.nodes.get('1:10')]);
    expect(fake.figma.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([fake.nodes.get('1:10')]);
  });

  it('switches page for a node on another page', async () => {
    const other = mockFrameNode({ id: '9:1', name: 'Other' });
    const p1 = page('0:1', 'Page 1', [cleanHome()]);
    const p2 = page('0:2', 'Page 2', [other]);
    const fake = makeFigma([p1, p2]);
    const { send } = harness(fake);
    await send({ type: 'standards-select', nodeId: '9:1' });
    expect(fake.figma.setCurrentPageAsync).toHaveBeenCalledWith(p2);
    expect(fake.figma.currentPage).toBe(p2);
    expect(p2.selection).toEqual([other]);
    expect(fake.figma.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([other]);
  });

  it('missing node → error toast', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    const out = await send({ type: 'standards-select', nodeId: 'nope' });
    expect(out).toEqual([{ type: 'standards-toast', level: 'error', message: 'Layer no longer exists' }]);
    expect(fake.figma.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled();
  });
});

describe('fix preview & apply', () => {
  /** Section named "Frame 12" (SAFE rename) and Home frame paddingTop 23 (REQUIRES_CONFIRMATION spacing). */
  function fixable(): FakeFigma {
    return makeFigma([page('0:1', 'Page 1', [homeFrame('5:1', [button('5:10')], { sectionName: 'Frame 12', paddingTop: 23 })])]);
  }

  it('requires a prior run', async () => {
    const { send } = harness(fixable());
    const out = await send({ type: 'standards-fix-preview', mode: 'safe' });
    expect(out[0]).toMatchObject({ type: 'standards-toast', level: 'error' });
  });

  it('safe preview lists only SAFE operations; apply-fixes applies them then re-runs', async () => {
    const fake = fixable();
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const naming = res.result.issues.find((i: any) => i.code === 'auto-generated-name');
    const spacing = res.result.issues.find((i: any) => i.code === 'off-scale-spacing');
    expect(naming?.fix?.kind).toBe('SAFE');
    expect(spacing?.fix?.kind).toBe('REQUIRES_CONFIRMATION');

    const preview = last(await send({ type: 'standards-fix-preview', mode: 'safe' }), 'standards-fix-preview');
    expect(preview.operations).toEqual([{
      issueId: naming.id, kind: 'SAFE', description: 'Rename "Frame 12" → "Divi Section"',
      key: naming.id + '|Rename "Frame 12" → "Divi Section"',
    }]);
    expect(preview.requiresConfirmation).toBe(false);
    expect(preview.skipped.map((s: any) => s.issueId)).toContain(spacing.id);

    const out = await send({ type: 'standards-apply-fixes', mode: 'safe', confirmed: false });
    const types = out.map((m) => m.type);
    const fr = last(out, 'standards-fix-result');
    expect(fr.applied).toEqual([{ issueId: naming.id, description: 'Rename "Frame 12" → "Divi Section"' }]);
    expect(fr.failed).toEqual([]);
    expect(types.indexOf('standards-fix-result')).toBeLessThan(types.lastIndexOf('standards-result'));
    expect(fake.nodes.get('5:1:sec').name).toBe('Divi Section');
    expect(fake.nodes.get('5:1').paddingTop).toBe(23);
    const fresh = last(out, 'standards-result');
    expect(fresh.result.issues.find((i: any) => i.code === 'auto-generated-name')).toBeUndefined();
  });

  it('REQUIRES_CONFIRMATION fixes are refused without confirmed:true', async () => {
    const fake = fixable();
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const spacing = res.result.issues.find((i: any) => i.code === 'off-scale-spacing');

    const preview = last(await send({ type: 'standards-fix-preview', mode: 'selected', issueIds: [spacing.id] }), 'standards-fix-preview');
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.operations[0]).toMatchObject({ issueId: spacing.id, kind: 'REQUIRES_CONFIRMATION' });

    let out = await send({ type: 'standards-apply-fixes', mode: 'selected', issueIds: [spacing.id] });
    expect(last(out, 'standards-fix-result')).toMatchObject({ refused: true, applied: [] });
    expect(last(out, 'standards-toast').level).toBe('error');
    expect(last(out, 'standards-result')).toBeUndefined();
    expect(fake.nodes.get('5:1').paddingTop).toBe(23);

    // confirmed:true alone is not enough: the confirmation must name the previewed operations.
    out = await send({ type: 'standards-apply-fixes', mode: 'selected', issueIds: [spacing.id], confirmed: true });
    expect(last(out, 'standards-fix-result')).toMatchObject({ refused: true, applied: [] });
    expect(fake.nodes.get('5:1').paddingTop).toBe(23);

    fake.figma.commitUndo = vi.fn();
    const expectedOperations = preview.operations.map((o: any) => o.key);
    out = await send({ type: 'standards-apply-fixes', mode: 'selected', issueIds: [spacing.id], confirmed: true, expectedOperations });
    expect(last(out, 'standards-fix-result').applied).toHaveLength(1);
    expect(fake.nodes.get('5:1').paddingTop).toBe(24);
    expect(last(out, 'standards-result').result.issues.find((i: any) => i.code === 'off-scale-spacing')).toBeUndefined();
    // The fix is committed as its own undo step (before and after applying).
    expect(fake.figma.commitUndo.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a confirmation whose previewed operations no longer match (value changed + re-run)', async () => {
    const fake = fixable();
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const spacing = res.result.issues.find((i: any) => i.code === 'off-scale-spacing');
    const preview = last(await send({ type: 'standards-fix-preview', mode: 'selected', issueIds: [spacing.id] }), 'standards-fix-preview');
    const expectedOperations = preview.operations.map((o: any) => o.key);

    // Designer changes the value; the re-run keeps the same issue id with a different fix.
    fake.nodes.get('5:1').paddingTop = 31;
    const rerun = last(await send({ type: 'standards-run' }), 'standards-result');
    const again = rerun.result.issues.find((i: any) => i.code === 'off-scale-spacing');
    expect(again.id).toBe(spacing.id);

    const out = await send({ type: 'standards-apply-fixes', mode: 'selected', issueIds: [spacing.id], confirmed: true, expectedOperations });
    expect(last(out, 'standards-fix-result')).toMatchObject({ refused: true, applied: [] });
    expect(last(out, 'standards-toast').message).toMatch(/changed since you previewed/);
    expect(fake.nodes.get('5:1').paddingTop).toBe(31);
  });
});

describe('standards-export', () => {
  it('produces a HandoffReport whose contentHash verifies', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [homeWithRogue()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const out = await send({ type: 'standards-export' }); // no prior run → runs first
    expect(last(out, 'standards-result')).toBeDefined();
    const ex = last(out, 'standards-export');
    expect(ex.filename).toBe('figmakit-standards-report-2026-10-13.json');
    const report: HandoffReport = JSON.parse(ex.json);
    expect(Object.keys(report).sort()).toEqual([
      'approvedExceptions', 'blockingViolations', 'configHash', 'contentHash', 'diagnostics', 'file', 'issues',
      'readiness', 'registry', 'ruleResults', 'rulesetVersion', 'schemaVersion', 'scope', 'tool', 'totals',
      'validatedAt', 'validatedBy',
    ]);
    expect(report.schemaVersion).toBe('1.0.0');
    expect(report.tool).toEqual({ name: 'FigmaKit Prep', component: 'standards', version: '1.0.0' });
    expect(report.file).toEqual({ name: 'Marketing Site', fileKey: null });
    expect(report.validatedBy).toEqual({ id: 'u-1', name: 'Dana Designer' });
    expect(report.validatedAt).toBe(NOW);
    expect(report.registry).toEqual({ version: '1.0.0', designSystem: 'Divi 5 (test)', status: 'approved' });
    expect(report.readiness.status).toBe('NOT_READY');
    expect(report.blockingViolations.length).toBeGreaterThan(0);
    expect(verifyContentHash(report)).toBe(true);
    expect(report.contentHash).toBe(ex.contentHash);
    // tampering breaks the hash
    expect(verifyContentHash({ ...report, readiness: { ...report.readiness, ready: true } })).toBe(false);
  });

  it('reuses the last run by default, but re-validates when the UI passes rerun:true', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    await send({ type: 'standards-run' });
    const reused = await send({ type: 'standards-export' });
    expect(reused.filter((m: any) => m.type === 'standards-result')).toHaveLength(0);
    const fresh = await send({ type: 'standards-export', rerun: true });
    expect(fresh.filter((m: any) => m.type === 'standards-result')).toHaveLength(1);
    expect(last(fresh, 'standards-export')).toBeDefined();
  });

  it('validatedBy is null when there is no current user', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    fake.figma.currentUser = null;
    const { send } = harness(fake);
    const report = JSON.parse(last(await send({ type: 'standards-export' }), 'standards-export').json);
    expect(report.validatedBy).toEqual({ id: null, name: null });
  });
});

describe('exceptions', () => {
  it('scenario H: excepting the blocking issue yields READY_WITH_EXCEPTIONS; removing restores NOT_READY', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [homeWithRogue()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    expect(res.readiness.status).toBe('NOT_READY');
    const blocking = res.readiness.blockingIssues;
    expect(blocking.length).toBeGreaterThan(0);

    let out: any[] = [];
    for (const issue of blocking) {
      out = await send({ type: 'standards-add-exception', issueId: issue.id, reason: 'Approved one-off card for launch', expiresAt: '2026-12-31' });
      expect(out.filter((m) => m.type === 'standards-toast' && m.level === 'error')).toEqual([]);
    }
    const fresh = last(out, 'standards-result');
    expect(fresh.readiness.status).toBe('READY_WITH_EXCEPTIONS');
    expect(fresh.readiness.ready).toBe(true);
    const stored = JSON.parse(doc(fake, 'exceptions'));
    expect(stored).toHaveLength(blocking.length);
    expect(stored[0]).toMatchObject({
      ruleId: blocking[0].ruleId,
      nodeId: blocking[0].nodeId,
      code: blocking[0].code,
      reason: 'Approved one-off card for launch',
      approvedBy: { id: 'u-1', name: 'Dana Designer' },
      createdAt: NOW,
      expiresAt: '2026-12-31T23:59:59.999Z',
    });
    expect(last(out, 'standards-state').exceptions).toHaveLength(blocking.length);

    const mr = last(await send({ type: 'standards-mark-ready' }), 'standards-mark-ready-result');
    expect(mr.ok).toBe(true);
    expect(mr.status).toBe('READY_WITH_EXCEPTIONS');
    expect(JSON.parse(doc(fake, 'readiness')).issueCountSummary.excepted).toBe(blocking.length);

    out = await send({ type: 'standards-remove-exception', exceptionId: stored[0].id });
    expect(last(out, 'standards-result').readiness.status).toBe('NOT_READY');
    expect(JSON.parse(doc(fake, 'exceptions'))).toHaveLength(blocking.length - 1);
  });

  it('an exception covers only the excepted issue, not other issues of the same rule/code on the layer', async () => {
    const card = mockFrameNode({
      id: '5:1', name: 'Card', layoutMode: 'VERTICAL', paddingLeft: 23, itemSpacing: 37, width: 400, height: 300,
      children: [text('5:2', 'Copy', 'Hi')],
    });
    const fake = makeFigma([page('0:1', 'Page 1', [card])]);
    const { send } = harness(fake);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const spacing = res.result.issues.filter((i: any) => i.code === 'off-scale-spacing' && i.nodeId === '5:1');
    expect(spacing.map((i: any) => i.discriminator).sort()).toEqual(['itemSpacing', 'paddingLeft']);
    const padding = spacing.find((i: any) => i.discriminator === 'paddingLeft');
    const out = await send({ type: 'standards-add-exception', issueId: padding.id, reason: 'Approved' });
    expect(out.filter((m) => m.type === 'standards-toast' && m.level === 'error')).toEqual([]);
    expect(JSON.parse(doc(fake, 'exceptions'))[0].discriminator).toBe('paddingLeft');
    const fresh = last(out, 'standards-result');
    const after = fresh.result.issues.filter((i: any) => i.code === 'off-scale-spacing' && i.nodeId === '5:1');
    expect(after.map((i: any) => `${i.discriminator}:${!!i.exception}`).sort()).toEqual(['itemSpacing:false', 'paddingLeft:true']);
  });

  it('enforces allowedApprovers', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [homeWithRogue()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    await send({
      type: 'standards-save-config',
      configJson: JSON.stringify({ extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', exceptions: { allowedApprovers: ['u-lead'] } }),
    });
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const issue = res.readiness.blockingIssues[0];
    const out = await send({ type: 'standards-add-exception', issueId: issue.id, reason: 'please' });
    expect(last(out, 'standards-toast')).toMatchObject({ level: 'error', message: expect.stringMatching(/approver/) });
    expect(doc(fake, 'exceptions')).toBe('');

    fake.figma.currentUser = { id: 'u-lead', name: 'Lead' };
    const ok = await send({ type: 'standards-add-exception', issueId: issue.id, reason: 'please' });
    expect(ok.filter((m) => m.type === 'standards-toast' && m.level === 'error')).toEqual([]);
    expect(JSON.parse(doc(fake, 'exceptions'))[0].approvedBy).toEqual({ id: 'u-lead', name: 'Lead' });
  });

  it('rejects missing reason, unknown issues, past expiry and non-exempt rules', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [homeWithRogue()])]);
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const issue = res.readiness.blockingIssues[0];
    const toastOf = async (m: any) => last(await send(m), 'standards-toast');
    expect((await toastOf({ type: 'standards-add-exception', issueId: issue.id, reason: '  ' })).message).toMatch(/reason/i);
    expect((await toastOf({ type: 'standards-add-exception', issueId: 'fk-nope', reason: 'x' })).message).toMatch(/not found/i);
    expect((await toastOf({ type: 'standards-add-exception', issueId: issue.id, reason: 'x', expiresAt: '2020-01-01' })).message).toMatch(/future/i);
    await send({
      type: 'standards-save-config',
      configJson: JSON.stringify({ extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', exceptions: { nonExemptRules: [issue.ruleId] } }),
    });
    await send({ type: 'standards-run' });
    expect((await toastOf({ type: 'standards-add-exception', issueId: issue.id, reason: 'x' })).message).toMatch(/cannot be excepted/);
    expect(doc(fake, 'exceptions')).toBe('');
  });

  it('internal errors cannot be excepted', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    snapshotControl.fail = true;
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const internal = res.result.internalErrors[0];
    const t = last(await send({ type: 'standards-add-exception', issueId: internal.id, reason: 'x' }), 'standards-toast');
    expect(t.message).toMatch(/Internal errors/);
  });
});

describe('config management', () => {
  it('get-config returns pretty effective documents and sources', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    const cfg = last(await send({ type: 'standards-get-config' }), 'standards-config');
    expect(cfg.configSource).toBe('bundled');
    expect(cfg.registrySource).toBe('bundled');
    expect(JSON.parse(cfg.configJson).extends).toEqual(['figmakit:recommended']);
    expect(JSON.parse(cfg.registryJson).designSystem).toBe('Divi 5');
    expect(cfg.registryJson).toContain('\n  ');
  });

  it('save-config rejects invalid JSON without writing', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    const out = await send({ type: 'standards-save-config', configJson: '{ bad', registryJson: '[' });
    const saved = last(out, 'standards-config-saved');
    expect(saved.ok).toBe(false);
    expect(saved.diagnostics.filter((d: any) => d.code === 'invalid-json')).toHaveLength(2);
    expect(fake.figma.root.setSharedPluginData).not.toHaveBeenCalled();
    expect(last(out, 'standards-state')).toBeUndefined();
  });

  it('save-config rejects registry / config with error diagnostics', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    const reg: any = testRegistry();
    reg.components.push({ ...reg.components[0] }); // duplicate id + duplicate key
    let saved = last(await send({ type: 'standards-save-config', registryJson: JSON.stringify(reg) }), 'standards-config-saved');
    expect(saved.ok).toBe(false);
    expect(saved.diagnostics.map((d: any) => d.code)).toContain('duplicate-id');

    saved = last(await send({ type: 'standards-save-config', configJson: JSON.stringify({ rules: { 'divi/nope': 'error' } }) }), 'standards-config-saved');
    expect(saved.ok).toBe(false);
    expect(saved.diagnostics.map((d: any) => d.code)).toContain('unknown-rule');

    // incompatible registry version vs config range
    const old: any = testRegistry();
    old.version = '3.0.0';
    saved = last(await send({ type: 'standards-save-config', registryJson: JSON.stringify(old) }), 'standards-config-saved');
    expect(saved.ok).toBe(false);
    expect(saved.diagnostics.map((d: any) => d.code)).toContain('incompatible-registry');
    expect(fake.figma.root.setSharedPluginData).not.toHaveBeenCalled();
  });

  it('save-config persists valid docs, re-sends state; reset restores bundled', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake);
    const out = await send({ type: 'standards-save-config', registryJson: JSON.stringify(testRegistry()) });
    expect(last(out, 'standards-config-saved').ok).toBe(true);
    const state = last(out, 'standards-state');
    expect(state.registrySource).toBe('document');
    expect(state.registryStatus).toBe('approved');
    expect(JSON.parse(doc(fake, 'registry')).designSystem).toBe('Divi 5 (test)');

    const reset = last(await send({ type: 'standards-reset-config', target: 'registry' }), 'standards-state');
    expect(reset.registrySource).toBe('bundled');
    expect(doc(fake, 'registry')).toBe('');
  });
});

describe('registry tools', () => {
  it('registry-helper collects components, sets and instance mains from the selection', async () => {
    const setNode: any = { id: '7:1', type: 'COMPONENT_SET', name: 'Primary Button', key: 'set-abc', remote: false, children: [] };
    const variant: any = { id: '7:2', type: 'COMPONENT', name: 'State=Default', key: 'k-var', parent: setNode, remote: false };
    setNode.children.push(variant);
    const card: any = { id: '7:3', type: 'COMPONENT', name: 'Card / Feature', key: 'k-card', remote: false };
    const libSet: any = { type: 'COMPONENT_SET', key: 'set-hero', name: 'Hero Banner', children: [] };
    const libMain: any = { id: '7:9', type: 'COMPONENT', name: 'Size=Large', key: 'k-hero-lg', parent: libSet, remote: true };
    const libSmall: any = { id: '7:10', type: 'COMPONENT', name: 'Size=Small', key: 'k-hero-sm', parent: libSet, remote: true };
    libSet.children.push(libMain, libSmall);
    const inst = mockInstanceNode({ id: '7:4', name: 'Hero', getMainComponentAsync: async () => libMain });
    const wrapper = mockFrameNode({ id: '7:5', name: 'Library', children: [card] });
    const p = page('0:1', 'Page 1', [setNode, wrapper, inst]);
    const fake = makeFigma([p]);
    p.selection = [setNode, wrapper, inst];
    const { send } = harness(fake);
    const msg = last(await send({ type: 'standards-registry-helper' }), 'standards-registry-helper');
    expect(msg.entries).toEqual([
      { suggestedId: 'primary-button', name: 'Primary Button', key: 'set-abc', componentSetKey: 'set-abc', remote: false, variantKeys: ['k-var'] },
      { suggestedId: 'card-feature', name: 'Card / Feature', key: 'k-card', componentSetKey: null, remote: false, variantKeys: [] },
      { suggestedId: 'hero-banner', name: 'Hero Banner', key: 'k-hero-lg', componentSetKey: 'set-hero', remote: true, variantKeys: ['k-hero-lg', 'k-hero-sm'] },
    ]);
    const skeletons = JSON.parse(msg.json);
    expect(skeletons.map((s: any) => [s.id, s.figmaComponentKeys])).toEqual([
      // set key first (matches every variant instance), then variant keys (detached library copies)
      ['primary-button', ['set-abc', 'k-var']],
      ['card-feature', ['k-card']],
      ['hero-banner', ['set-hero', 'k-hero-lg', 'k-hero-sm']],
    ]);
    expect(skeletons[0]).toMatchObject({ name: 'Primary Button', diviType: null });
  });

  it('registry-helper with empty selection replies empty and informs', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [])]);
    const { send } = harness(fake);
    const out = await send({ type: 'standards-registry-helper' });
    expect(last(out, 'standards-registry-helper')).toEqual({ type: 'standards-registry-helper', entries: [], json: '[]' });
    expect(last(out, 'standards-toast').level).toBe('info');
  });

  it('slugifyComponentId produces registry-valid ids', () => {
    expect(slugifyComponentId('Divi Button / Primary')).toBe('divi-button-primary');
    expect(slugifyComponentId('***')).toBe('component');
  });

  it('verify-registry imports keys (component, then component set) and reports unresolved', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [])]);
    fake.figma.importComponentByKeyAsync = vi.fn(async (key: string) => {
      if (key === 'set-button' || key === 'key-image') throw new Error('not a component: ' + key);
      return { name: 'C ' + key };
    });
    fake.figma.importComponentSetByKeyAsync = vi.fn(async (key: string) => {
      if (key === 'set-button') return { name: 'Divi Button' };
      throw new Error('missing ' + key);
    });
    const { send } = harness(fake);
    await saveApprovedRegistry(send);
    const msg = last(await send({ type: 'standards-verify-registry' }), 'standards-verify-registry');
    expect(msg.unresolved).toEqual([{ componentId: 'divi-image', key: 'key-image', error: 'missing key-image' }]);
    expect(msg.resolved.find((r: any) => r.key === 'set-button')).toEqual({ componentId: 'divi-button', key: 'set-button', kind: 'componentSet', name: 'Divi Button' });
    expect(msg.resolved).toHaveLength(7); // 8 keys, key-image unresolved
    expect(msg.placeholders).toEqual([]);
    expect(msg.ok).toBe(false);
  });

  it('verify-registry skips placeholder keys of the bundled draft', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [])]);
    const { send } = harness(fake);
    const msg = last(await send({ type: 'standards-verify-registry' }), 'standards-verify-registry');
    expect(fake.figma.importComponentByKeyAsync).not.toHaveBeenCalled();
    expect(msg.placeholders.length).toBeGreaterThan(0);
    expect(msg.ok).toBe(false);
  });
});

describe('dispatch robustness', () => {
  it('unknown standards message → toast', async () => {
    const { send } = harness(makeFigma([page('0:1', 'Page 1', [])]));
    expect(await send({ type: 'standards-wat' })).toEqual([
      { type: 'standards-toast', level: 'error', message: 'Unknown standards message: standards-wat' },
    ]);
  });

  it('handler errors become toasts', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    fake.figma.getNodeByIdAsync = vi.fn(async () => {
      throw new Error('kaput');
    });
    const { send } = harness(fake);
    const out = await send({ type: 'standards-select', nodeId: '1:1' });
    expect(out).toEqual([{ type: 'standards-toast', level: 'error', message: 'Layer no longer exists' }]);
    fake.figma.root.getSharedPluginData = () => {
      throw new Error('no');
    };
    fake.figma.root.setSharedPluginData = () => {
      throw new Error('read-only');
    };
    const out2 = await send({ type: 'standards-save-config', configJson: '{}' });
    expect(last(out2, 'standards-toast')).toMatchObject({ level: 'error', message: 'read-only' });
  });

  it('main.ts routes standards-* messages to the controller', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const prev = (globalThis as any).figma;
    (globalThis as any).figma = fake.figma;
    try {
      const { handleMessage } = await import('../src/main');
      await handleMessage({ type: 'standards-init' });
      const calls = fake.figma.ui.postMessage.mock.calls.map((c: any[]) => c[0]);
      expect(calls.find((m: any) => m.type === 'standards-state')).toBeDefined();
      expect(calls.find((m: any) => m.type === 'error')).toBeUndefined();
    } finally {
      (globalThis as any).figma = prev;
    }
  });
});

describe('locked designer build (adminTools: false)', () => {
  it('the bundled config ships locked', () => {
    expect(BUNDLED_CONFIG_LOCKED.adminTools).toBe(false);
  });

  it('hides admin tools and refuses every settings / registry message', async () => {
    const fake = makeFigma([page('0:1', 'Page 1', [cleanHome()])]);
    const { send } = harness(fake, false);
    const state = last(await send({ type: 'standards-init' }), 'standards-state');
    expect(state.adminTools).toBe(false);
    expect(state.canAddExceptions).toBe(false);
    for (const type of ['standards-get-config', 'standards-save-config', 'standards-reset-config', 'standards-registry-helper', 'standards-verify-registry']) {
      const out = await send({ type, configJson: JSON.stringify({ rules: { 'divi/valid-nesting': 'off' } }) });
      expect(last(out, 'standards-toast')).toMatchObject({ level: 'error' });
      expect(out.filter((m) => m.type === 'standards-config-saved' || m.type === 'standards-config')).toEqual([]);
    }
    expect(doc(fake, 'config')).toBe('');
  });

  it('ignores standards stored in the document (a designer cannot switch rules off from a file)', async () => {
    const card = mockFrameNode({
      id: '5:1', name: 'Card', layoutMode: 'VERTICAL', paddingLeft: 23, width: 400, height: 300,
      children: [text('5:2', 'Copy', 'Hi')],
    });
    const fake = makeFigma([page('0:1', 'Page 1', [card])]);
    fake.store.set(STANDARDS_SHARED_NAMESPACE + '/config', JSON.stringify({ extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', rules: { 'divi/approved-tokens': 'off' } }));
    const locked = harness(fake, false);
    const res = last(await locked.send({ type: 'standards-run' }), 'standards-result');
    expect(res.result.issues.some((i: any) => i.code === 'off-scale-spacing')).toBe(true);
    // The same document in an admin build does honor the override.
    const admin = harness(fake, true);
    const res2 = last(await admin.send({ type: 'standards-run' }), 'standards-result');
    expect(res2.result.issues.some((i: any) => i.code === 'off-scale-spacing')).toBe(false);
  });

  it('refuses self-granted exceptions when no approvers are configured', async () => {
    const card = mockFrameNode({
      id: '5:1', name: 'Card', layoutMode: 'VERTICAL', paddingLeft: 23, width: 400, height: 300,
      children: [text('5:2', 'Copy', 'Hi')],
    });
    const fake = makeFigma([page('0:1', 'Page 1', [card])]);
    const { send } = harness(fake, false);
    const res = last(await send({ type: 'standards-run' }), 'standards-result');
    const issue = res.result.issues.find((i: any) => i.code === 'off-scale-spacing');
    const out = await send({ type: 'standards-add-exception', issueId: issue.id, reason: 'trust me' });
    expect(last(out, 'standards-toast')).toMatchObject({ level: 'error' });
    expect(doc(fake, 'exceptions')).toBe('');
  });
});
