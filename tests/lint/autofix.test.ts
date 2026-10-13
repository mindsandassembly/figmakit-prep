import { describe, it, expect, vi } from 'vitest';
import {
  planFixes,
  applyFixes,
  validateOperation,
  describeOperation,
  normalizeHex,
  type FixTargetAdapter,
} from '../../src/lint/autofix';
import type { FixDescriptor, FixKind, FixOperation, LintIssue } from '../../src/lint/types';
import { mockFrameNode, mockInstanceNode, mockSolidPaint, mockTextNode } from '../helpers/figma-mock';

function issue(id: string, kind: FixKind | null, ops: FixOperation[] = [], extra: Partial<LintIssue> = {}): LintIssue {
  const fix: FixDescriptor | undefined = kind ? { kind, description: 'fix ' + id, operations: kind === 'UNSUPPORTED' ? [] : ops } : undefined;
  return {
    id,
    ruleId: 'divi/test',
    code: 'c',
    nodeId: ops[0] ? ops[0].nodeId : 'n',
    nodeName: 'n',
    nodePath: 'n',
    severity: 'warning',
    certainty: 'confirmed',
    message: 'm',
    fix,
    fixable: !!kind && kind !== 'UNSUPPORTED',
    blocking: false,
    ...extra,
  };
}

const rename = (nodeId: string, from: string, to: string): FixOperation => ({ op: 'rename', nodeId, from, to });

function withRemoveSpy<T extends Record<string, any>>(node: T): T & { remove: ReturnType<typeof vi.fn> } {
  (node as any).remove = vi.fn();
  (node as any).detachInstance = vi.fn();
  (node as any).swapComponent = vi.fn();
  return node as any;
}

function withPluginData(node: any, data: Record<string, string> = {}): any {
  node.getPluginData = vi.fn((k: string) => data[k] ?? '');
  node.setPluginData = vi.fn((k: string, v: string) => { data[k] = v; });
  return node;
}

function adapterFor(...roots: any[]): FixTargetAdapter {
  const map = new Map<string, any>();
  const walk = (n: any) => { map.set(n.id, n); (n.children || []).forEach(walk); };
  roots.forEach(walk);
  return { getNode: async (id) => map.get(id) ?? null };
}

describe('validateOperation (whitelist)', () => {
  it('accepts well-formed operations', () => {
    expect(validateOperation(rename('1', 'a', 'b'))).toBeNull();
    expect(validateOperation({ op: 'setPluginData', nodeId: '1', key: 'fk-standards-component', from: '', to: 'divi-blurb' })).toBeNull();
    expect(validateOperation({ op: 'setNumber', nodeId: '1', property: 'itemSpacing', from: 23, to: 24 })).toBeNull();
    expect(validateOperation({ op: 'setSolidPaintColor', nodeId: '1', target: 'fills', index: 0, from: '#FFF', to: '#4f46e5' })).toBeNull();
  });

  it('rejects unknown ops and destructive ops', () => {
    for (const op of ['remove', 'detach', 'swap', 'reparent', 'delete', 'setProperty']) {
      expect(validateOperation({ op, nodeId: '1' } as any)).toMatch(/not allowed/);
    }
    expect(validateOperation(null as any)).toBeTruthy();
    expect(validateOperation({ op: 'rename', nodeId: '', from: 'a', to: 'b' })).toMatch(/node id/);
  });

  it('enforces property and pluginData key whitelists', () => {
    expect(validateOperation({ op: 'setNumber', nodeId: '1', property: 'x' as any, from: 0, to: 1 })).toMatch(/not allowed/);
    expect(validateOperation({ op: 'setNumber', nodeId: '1', property: 'opacity' as any, from: 0, to: 1 })).toMatch(/not allowed/);
    expect(validateOperation({ op: 'setPluginData', nodeId: '1', key: 'evil' as any, from: '', to: 'x' })).toMatch(/not allowed/);
  });

  it('enforces name, number and hex constraints', () => {
    expect(validateOperation(rename('1', 'a', ''))).toMatch(/non-empty/);
    expect(validateOperation(rename('1', 'a', '   '))).toMatch(/non-empty/);
    expect(validateOperation(rename('1', 'a', 'x'.repeat(256)))).toMatch(/255/);
    expect(validateOperation(rename('1', 'a', 'x'.repeat(255)))).toBeNull();
    expect(validateOperation({ op: 'setNumber', nodeId: '1', property: 'paddingTop', from: 1, to: -1 })).toBeTruthy();
    expect(validateOperation({ op: 'setNumber', nodeId: '1', property: 'paddingTop', from: 1, to: Infinity })).toBeTruthy();
    expect(validateOperation({ op: 'setNumber', nodeId: '1', property: 'paddingTop', from: 1, to: NaN })).toBeTruthy();
    expect(validateOperation({ op: 'setNumber', nodeId: '1', property: 'paddingTop', from: NaN, to: 1 })).toBeTruthy();
    expect(validateOperation({ op: 'setSolidPaintColor', nodeId: '1', target: 'fills', index: 0, from: '#fff', to: 'red' })).toMatch(/hex/);
    expect(validateOperation({ op: 'setSolidPaintColor', nodeId: '1', target: 'fills', index: 0, from: '#ggg', to: '#fff' })).toMatch(/hex/);
    expect(validateOperation({ op: 'setSolidPaintColor', nodeId: '1', target: 'effects' as any, index: 0, from: '#fff', to: '#000' })).toBeTruthy();
    expect(validateOperation({ op: 'setSolidPaintColor', nodeId: '1', target: 'fills', index: 1.5, from: '#fff', to: '#000' })).toBeTruthy();
    expect(validateOperation({ op: 'setSolidPaintColor', nodeId: '1', target: 'fills', index: -1, from: '#fff', to: '#000' })).toBeTruthy();
  });

  it('normalizeHex', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('#AaBbCc')).toBe('#aabbcc');
    expect(normalizeHex('abc')).toBeNull();
    expect(normalizeHex(3)).toBeNull();
  });
});

describe('planFixes', () => {
  const issues = [
    issue('safe1', 'SAFE', [rename('a', 'Frame 1', 'Divi Button')]),
    issue('conf1', 'REQUIRES_CONFIRMATION', [{ op: 'setNumber', nodeId: 'b', property: 'itemSpacing', from: 23, to: 24 }]),
    issue('unsup', 'UNSUPPORTED'),
    issue('nofix', null),
    issue('exc', 'SAFE', [rename('c', 'x', 'y')], {
      exception: { id: 'ex', ruleId: 'divi/test', nodeId: 'c', reason: 'r', approvedBy: { id: null, name: 'A' }, createdAt: '2026-01-01T00:00:00Z' },
    }),
  ];

  it('safe mode: only SAFE fixes; confirmation/unsupported/excepted skipped with reasons', () => {
    const plan = planFixes(issues, 'safe');
    expect(plan.operations.map((o) => o.issueId)).toEqual(['safe1']);
    expect(plan.operations[0].kind).toBe('SAFE');
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.issueId, s.reason]));
    expect(Object.keys(reasons).sort()).toEqual(['conf1', 'exc', 'unsup']);
    expect(reasons.conf1).toMatch(/confirmation/);
    expect(reasons.unsup).toMatch(/not supported/);
    expect(reasons.exc).toMatch(/exception/);
  });

  it('safe mode ignores selection and never includes REQUIRES_CONFIRMATION even if selected', () => {
    const plan = planFixes(issues, 'safe', ['conf1']);
    expect(plan.operations.map((o) => o.issueId)).toEqual(['safe1']);
  });

  it('selected mode: SAFE + REQUIRES_CONFIRMATION of selected ids only', () => {
    const plan = planFixes(issues, 'selected', ['conf1', 'unsup', 'exc', 'nofix']);
    expect(plan.operations.map((o) => o.issueId)).toEqual(['conf1']);
    expect(plan.operations[0].kind).toBe('REQUIRES_CONFIRMATION');
    expect(plan.skipped.map((s) => s.issueId).sort()).toEqual(['exc', 'nofix', 'unsup']);
    expect(planFixes(issues, 'selected', ['safe1']).operations.map((o) => o.issueId)).toEqual(['safe1']);
    expect(planFixes(issues, 'selected').operations).toEqual([]);
  });

  it('conflicts on the same node/property: first issue wins, later skipped atomically', () => {
    const plan = planFixes(
      [
        issue('first', 'SAFE', [rename('a', 'X', 'One')]),
        issue('second', 'SAFE', [{ op: 'setPluginData', nodeId: 'a', key: 'fk-type', from: '', to: 'button' }, rename('a', 'X', 'Two')]),
        issue('third', 'SAFE', [rename('b', 'X', 'Three')]),
        issue('paint1', 'SAFE', [{ op: 'setSolidPaintColor', nodeId: 'a', target: 'fills', index: 0, from: '#000', to: '#111' }]),
        issue('paint2', 'SAFE', [{ op: 'setSolidPaintColor', nodeId: 'a', target: 'fills', index: 1, from: '#000', to: '#111' }]),
        issue('paint3', 'SAFE', [{ op: 'setSolidPaintColor', nodeId: 'a', target: 'fills', index: 0, from: '#000', to: '#222' }]),
      ],
      'safe',
    );
    expect(plan.operations.map((o) => o.issueId)).toEqual(['first', 'third', 'paint1', 'paint2']);
    expect(plan.skipped.map((s) => s.issueId)).toEqual(['second', 'paint3']);
    expect(plan.skipped[0].reason).toMatch(/Conflicts with fix for issue first/);
  });

  it('skips issues carrying invalid (non-whitelisted) operations', () => {
    const bad = issue('bad', 'SAFE', [{ op: 'remove', nodeId: 'a' } as any]);
    const plan = planFixes([bad], 'safe');
    expect(plan.operations).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/Invalid operation/);
  });

  it('dedupes repeated issue ids', () => {
    const i = issue('dup', 'SAFE', [rename('a', 'x', 'y')]);
    expect(planFixes([i, i], 'safe').operations).toHaveLength(1);
  });
});

describe('applyFixes', () => {
  it('applies rename and setPluginData, never removes', async () => {
    const node = withRemoveSpy(withPluginData(mockFrameNode({ id: 'a', name: 'Frame 1' })));
    const plan = planFixes(
      [
        issue('r', 'SAFE', [rename('a', 'Frame 1', 'Divi Button')]),
        issue('p', 'SAFE', [{ op: 'setPluginData', nodeId: 'a', key: 'fk-divi-type', from: '', to: 'et_pb_button' }]),
      ],
      'safe',
    );
    const res = await applyFixes(plan, adapterFor(node));
    expect(res.failed).toEqual([]);
    expect(res.applied.map((a) => a.issueId)).toEqual(['r', 'p']);
    expect(node.name).toBe('Divi Button');
    expect(node.setPluginData).toHaveBeenCalledWith('fk-divi-type', 'et_pb_button');
    expect(node.remove).not.toHaveBeenCalled();
    expect(node.detachInstance).not.toHaveBeenCalled();
    expect(node.swapComponent).not.toHaveBeenCalled();
  });

  it('refuses stale `from` values', async () => {
    const node = withRemoveSpy(withPluginData(mockFrameNode({ id: 'a', name: 'Renamed by designer', layoutMode: 'HORIZONTAL', itemSpacing: 20 }), { 'fk-type': 'card' }));
    const res = await applyFixes(
      [
        { issueId: '1', kind: 'SAFE', op: rename('a', 'Frame 1', 'X') },
        { issueId: '2', kind: 'SAFE', op: { op: 'setPluginData', nodeId: 'a', key: 'fk-type', from: '', to: 'button' } },
        { issueId: '3', kind: 'SAFE', op: { op: 'setNumber', nodeId: 'a', property: 'itemSpacing', from: 23, to: 24 } },
      ],
      adapterFor(node),
    );
    expect(res.applied).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual([
      expect.stringMatching(/^stale/), expect.stringMatching(/^stale/), expect.stringMatching(/^stale/),
    ]);
    expect(node.name).toBe('Renamed by designer');
    expect(node.setPluginData).not.toHaveBeenCalled();
    expect(node.itemSpacing).toBe(20);
  });

  it('refuses nodes inside an instance (but allows the instance itself)', async () => {
    const inner = withRemoveSpy(mockTextNode({ id: 't', name: 'Label' }));
    const deep = mockFrameNode({ id: 'f', name: 'Wrap', children: [inner] });
    const inst = withRemoveSpy(mockInstanceNode({ id: 'i', name: 'Frame 9', children: [deep] }));
    const res = await applyFixes(
      [
        { issueId: '1', kind: 'SAFE', op: rename('t', 'Label', 'X') },
        { issueId: '2', kind: 'SAFE', op: rename('i', 'Frame 9', 'Divi Button') },
      ],
      adapterFor(inst),
    );
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].issueId).toBe('1');
    expect(res.failed[0].reason).toMatch(/inside a component instance/);
    expect(inner.name).toBe('Label');
    expect(inst.name).toBe('Divi Button');
  });

  it('setNumber requires auto layout', async () => {
    const none = mockFrameNode({ id: 'n', layoutMode: 'NONE', paddingTop: 23 });
    const auto = mockFrameNode({ id: 'h', layoutMode: 'HORIZONTAL', paddingTop: 23 });
    const res = await applyFixes(
      [
        { issueId: '1', kind: 'REQUIRES_CONFIRMATION', op: { op: 'setNumber', nodeId: 'n', property: 'paddingTop', from: 23, to: 24 } },
        { issueId: '2', kind: 'REQUIRES_CONFIRMATION', op: { op: 'setNumber', nodeId: 'h', property: 'paddingTop', from: 23, to: 24 } },
      ],
      adapterFor(none, auto),
    );
    expect(res.failed.map((f) => f.issueId)).toEqual(['1']);
    expect(res.failed[0].reason).toMatch(/auto layout/);
    expect(none.paddingTop).toBe(23);
    expect(auto.paddingTop).toBe(24);
  });

  it('setNumber refuses a variable-bound property (would replace the binding)', async () => {
    const node = mockFrameNode({ id: 'b', layoutMode: 'VERTICAL', paddingLeft: 13 });
    node.boundVariables = { paddingLeft: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } };
    const res = await applyFixes(
      [{ issueId: '1', kind: 'REQUIRES_CONFIRMATION', op: { op: 'setNumber', nodeId: 'b', property: 'paddingLeft', from: 13, to: 12 } }],
      adapterFor(node),
    );
    expect(res.applied).toEqual([]);
    expect(res.failed[0].reason).toMatch(/bound to a variable/);
    expect(node.paddingLeft).toBe(13);
  });

  it('paint fix refuses layers that use a fill / stroke style (would detach the style)', async () => {
    const styled = mockFrameNode({ id: 's', fills: [mockSolidPaint({ color: { r: 0, g: 0, b: 0 } })], strokes: [mockSolidPaint({ color: { r: 0, g: 0, b: 0 } })] });
    styled.fillStyleId = 'S:brand-primary';
    styled.strokeStyleId = Symbol('mixed');
    const before = styled.fills;
    const op = (target: 'fills' | 'strokes') =>
      ({ issueId: target, kind: 'REQUIRES_CONFIRMATION' as const, op: { op: 'setSolidPaintColor' as const, nodeId: 's', target, index: 0, from: '#000000', to: '#ffffff' } });
    const res = await applyFixes([op('fills'), op('strokes')], adapterFor(styled));
    expect(res.applied).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual([expect.stringMatching(/style/), expect.stringMatching(/style/)]);
    expect(styled.fills).toBe(before);
  });

  it('paint color replacement preserves opacity and the other paints, assigns a new array', async () => {
    const p0 = mockSolidPaint({ color: { r: 1, g: 1, b: 1 }, opacity: 0.4 });
    const p1 = mockSolidPaint({ color: { r: 0, g: 0, b: 0 }, opacity: 1 });
    const fills = Object.freeze([Object.freeze(p0), Object.freeze(p1)]);
    const node = mockFrameNode({ id: 'a', fills });
    const res = await applyFixes(
      [{ issueId: '1', kind: 'REQUIRES_CONFIRMATION', op: { op: 'setSolidPaintColor', nodeId: 'a', target: 'fills', index: 0, from: '#FFFFFF', to: '#4f46e5' } }],
      adapterFor(node),
    );
    expect(res.failed).toEqual([]);
    expect(node.fills).not.toBe(fills);
    expect(node.fills).toHaveLength(2);
    expect(node.fills[0].opacity).toBe(0.4);
    expect(node.fills[0].type).toBe('SOLID');
    expect(node.fills[0].blendMode).toBe('NORMAL');
    expect(node.fills[0].color.r).toBeCloseTo(0x4f / 255);
    expect(node.fills[0].color.g).toBeCloseTo(0x46 / 255);
    expect(node.fills[0].color.b).toBeCloseTo(0xe5 / 255);
    expect(node.fills[1]).toBe(p1);
    expect(p0.color).toEqual({ r: 1, g: 1, b: 1 }); // original untouched
  });

  it('paint fix refuses stale color, non-solid, missing index, mixed and variable-bound paints', async () => {
    const node = mockFrameNode({
      id: 'a',
      fills: [mockSolidPaint({ color: { r: 0, g: 0, b: 0 } }), { type: 'IMAGE', visible: true }],
      strokes: [{ ...mockSolidPaint({ color: { r: 0, g: 0, b: 0 } }), boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V' } } }],
    });
    const mixed = mockTextNode({ id: 't', fills: Symbol('mixed') });
    const op = (nodeId: string, target: 'fills' | 'strokes', index: number, from: string) =>
      ({ issueId: nodeId + target + index, kind: 'SAFE' as const, op: { op: 'setSolidPaintColor' as const, nodeId, target, index, from, to: '#ffffff' } });
    const res = await applyFixes(
      [op('a', 'fills', 0, '#111111'), op('a', 'fills', 1, '#000000'), op('a', 'fills', 5, '#000000'), op('a', 'strokes', 0, '#000000'), op('t', 'fills', 0, '#000000')],
      adapterFor(node, mixed),
    );
    expect(res.applied).toEqual([]);
    expect(res.failed).toHaveLength(5);
    expect(res.failed[3].reason).toMatch(/variable/);
    expect(res.failed[4].reason).toMatch(/mixed/);
  });

  it('fails missing / removed nodes and re-validates operations', async () => {
    const removed = mockFrameNode({ id: 'r', name: 'X', removed: true });
    const res = await applyFixes(
      [
        { issueId: '1', kind: 'SAFE', op: rename('missing', 'X', 'Y') },
        { issueId: '2', kind: 'SAFE', op: rename('r', 'X', 'Y') },
        { issueId: '3', kind: 'SAFE', op: { op: 'remove', nodeId: 'r' } as any },
      ],
      adapterFor(removed),
    );
    expect(res.failed.map((f) => f.reason)).toEqual([
      'Layer not found', 'Layer was removed', expect.stringMatching(/not allowed/),
    ]);
    expect(removed.name).toBe('X');
  });

  it('reports Figma exceptions as failures and continues', async () => {
    const bad: any = withPluginData(mockFrameNode({ id: 'a' }));
    bad.setPluginData = () => { throw new Error('read-only'); };
    const good = mockFrameNode({ id: 'b', name: 'B' });
    const res = await applyFixes(
      [
        { issueId: '1', kind: 'SAFE', op: { op: 'setPluginData', nodeId: 'a', key: 'fk-type', from: '', to: 'card' } },
        { issueId: '2', kind: 'SAFE', op: rename('b', 'B', 'C') },
      ],
      adapterFor(bad, good),
    );
    expect(res.failed[0].reason).toMatch(/read-only/);
    expect(res.applied.map((a) => a.issueId)).toEqual(['2']);
  });

  it('refuses setPluginData on nodes without plugin data API', async () => {
    const node = mockFrameNode({ id: 'a' });
    const res = await applyFixes(
      [{ issueId: '1', kind: 'SAFE', op: { op: 'setPluginData', nodeId: 'a', key: 'fk-type', from: '', to: 'card' } }],
      adapterFor(node),
    );
    expect(res.failed[0].reason).toMatch(/plugin data/);
  });
});

describe('describeOperation', () => {
  it('describes each op', () => {
    expect(describeOperation(rename('1', 'Frame 12', 'Divi Button'))).toBe('Rename "Frame 12" → "Divi Button"');
    expect(describeOperation({ op: 'setPluginData', nodeId: '1', key: 'fk-standards-component', from: '', to: 'divi-blurb' }))
      .toBe('Set fk-standards-component to "divi-blurb"');
    expect(describeOperation({ op: 'setNumber', nodeId: '1', property: 'itemSpacing', from: 23, to: 24 })).toBe('Set itemSpacing 23px → 24px');
    expect(describeOperation({ op: 'setSolidPaintColor', nodeId: '1', target: 'strokes', index: 0, from: '#FFF', to: '#000000' }))
      .toBe('Change stroke 1 color #ffffff → #000000');
  });
});
