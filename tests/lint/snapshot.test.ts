import { describe, it, expect, vi } from 'vitest';
import {
  buildDesignTree,
  createMockResolver,
  createFigmaResolver,
  classifyStructure,
  stripPropertyId,
} from '../../src/lint/snapshot';
import {
  mockFrameNode,
  mockTextNode,
  mockInstanceNode,
  mockSolidPaint,
  mockImagePaint,
  mockRectangleNode,
  mockComponentNode,
} from '../helpers/figma-mock';

const MIXED = Symbol('mixed');

function withPluginData(node: any, data: Record<string, string>): any {
  node.getPluginData = (key: string) => data[key] ?? '';
  return node;
}

function pill(overrides: Record<string, unknown> = {}): any {
  return mockFrameNode({
    name: '',
    width: 160,
    height: 48,
    layoutMode: 'HORIZONTAL',
    paddingLeft: 24,
    paddingRight: 24,
    fills: [mockSolidPaint({ color: { r: 0.31, g: 0.27, b: 0.9 } })],
    children: [mockTextNode({ id: 'pill-label', name: 'Label', characters: 'Go' })],
    ...overrides,
  });
}

describe('buildDesignTree — tree shape', () => {
  it('assigns path, depth, order (global pre-order), parentId', async () => {
    const a = mockFrameNode({
      id: 'a',
      name: 'Hero',
      children: [
        mockFrameNode({ id: 'a1', name: 'CTA', children: [mockTextNode({ id: 'a1t', name: 'Button' })] }),
        mockTextNode({ id: 'a2', name: 'Title' }),
      ],
    });
    const b = mockFrameNode({ id: 'b', name: 'Footer', children: [mockTextNode({ id: 'b1', name: 'Copy' })] });
    const { roots, nodeCount } = await buildDesignTree([a, b], createMockResolver());
    expect(nodeCount).toBe(6);
    expect(roots.map((r) => r.id)).toEqual(['a', 'b']);
    const a1t = roots[0].children[0].children[0];
    expect(a1t.path).toEqual(['Hero', 'CTA', 'Button']);
    expect(a1t.depth).toBe(2);
    expect(a1t.parentId).toBe('a1');
    expect(roots[0].parentId).toBeNull();
    const orders: number[] = [];
    const walk = (n: any) => { orders.push(n.order); n.children.forEach(walk); };
    roots.forEach(walk);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
    expect(roots[1].path).toEqual(['Footer']);
    expect(roots[1].depth).toBe(0);
  });

  it('skips hidden subtrees unless includeHidden', async () => {
    const tree = () =>
      mockFrameNode({
        id: 'r',
        name: 'Root',
        children: [
          mockFrameNode({ id: 'h', name: 'Hidden', visible: false, children: [mockTextNode({ id: 'h1' })] }),
          mockTextNode({ id: 'v', name: 'Visible' }),
        ],
      });
    const hidden = await buildDesignTree([tree()], createMockResolver());
    expect(hidden.nodeCount).toBe(2);
    expect(hidden.roots[0].children.map((c) => c.id)).toEqual(['v']);
    expect(hidden.roots[0].children[0].order).toBe(1);

    const all = await buildDesignTree([tree()], createMockResolver(), { includeHidden: true });
    expect(all.nodeCount).toBe(4);
    expect(all.roots[0].children[0].visible).toBe(false);
    expect(all.roots[0].children[0].children[0].id).toBe('h1');

    const hiddenRoot = await buildDesignTree([mockFrameNode({ visible: false })], createMockResolver());
    expect(hiddenRoot.roots).toEqual([]);
    expect(hiddenRoot.nodeCount).toBe(0);
  });

  it('marks insideInstance / instanceAncestorId for instance descendants', async () => {
    const inner = mockTextNode({ id: 't' });
    const inst = mockInstanceNode({ id: 'i', name: 'Button', children: [mockFrameNode({ id: 'f', children: [inner] })] });
    const root = mockFrameNode({ id: 'r', children: [inst] });
    const { roots } = await buildDesignTree([root], createMockResolver());
    const iNode = roots[0].children[0];
    expect(iNode.insideInstance).toBe(false);
    expect(iNode.instanceAncestorId).toBeNull();
    expect(iNode.children[0].insideInstance).toBe(true);
    expect(iNode.children[0].instanceAncestorId).toBe('i');
    expect(iNode.children[0].children[0].instanceAncestorId).toBe('i');
  });

  it('detects scope roots that live inside an instance via the raw parent chain', async () => {
    const child = mockFrameNode({ id: 'c' });
    mockInstanceNode({ id: 'outer', children: [child] });
    const { roots } = await buildDesignTree([child], createMockResolver());
    expect(roots[0].insideInstance).toBe(true);
    expect(roots[0].instanceAncestorId).toBe('outer');
  });

  it('produces JSON-serializable output (no raw node refs)', async () => {
    const root = mockFrameNode({ id: 'r', children: [mockTextNode({ id: 't' })] });
    const { roots } = await buildDesignTree([root], createMockResolver());
    const json = JSON.stringify(roots);
    expect(JSON.parse(json)).toEqual(roots);
  });

  it('is deterministic across runs', async () => {
    const mk = () => mockFrameNode({ id: 'r', name: 'R', children: [pill({ id: 'p' }), mockTextNode({ id: 't' })] });
    const a = await buildDesignTree([mk()], createMockResolver());
    const b = await buildDesignTree([mk()], createMockResolver());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildDesignTree — instances', () => {
  it('resolves main component key and component-set key from a COMPONENT_SET parent', async () => {
    const set: any = { id: 'set1', type: 'COMPONENT_SET', key: 'set-button', name: 'Button' };
    const main = mockComponentNode({ id: 'm1', name: 'Type=Primary', parent: set });
    main.key = 'key-button';
    main.remote = true;
    const inst = mockInstanceNode({ id: 'i1', name: 'Button' });
    inst.getMainComponentAsync = vi.fn(async () => main);
    inst.variantProperties = { Type: 'Primary' };
    const { roots } = await buildDesignTree([inst], createMockResolver());
    expect(roots[0].instance).toEqual({
      mainComponent: {
        id: 'm1',
        key: 'key-button',
        name: 'Type=Primary',
        remote: true,
        componentSetKey: 'set-button',
        componentSetName: 'Button',
      },
      variantProperties: { Type: 'Primary' },
      componentProperties: {},
    });
  });

  it('accepts a MainComponentInfo-like __mainComponent', async () => {
    const inst = mockInstanceNode({ id: 'i1' });
    inst.__mainComponent = { id: 'm', key: 'k', name: 'Card', remote: false, componentSetKey: null, componentSetName: null };
    const { roots } = await buildDesignTree([inst], createMockResolver());
    expect(roots[0].instance!.mainComponent!.key).toBe('k');
    expect(roots[0].instance!.mainComponent!.componentSetKey).toBeNull();
    expect(roots[0].instance!.variantProperties).toBeNull();
  });

  it('records an unresolved main component as null (and survives a throwing getter)', async () => {
    const a = mockInstanceNode({ id: 'a' });
    a.getMainComponentAsync = async () => null;
    const b = mockInstanceNode({ id: 'b' });
    b.getMainComponentAsync = async () => { throw new Error('missing library'); };
    const c = mockInstanceNode({ id: 'c' }); // no API at all
    const { roots } = await buildDesignTree([a, b, c], createMockResolver());
    for (const r of roots) {
      expect(r.instance).not.toBeNull();
      expect(r.instance!.mainComponent).toBeNull();
    }
  });

  it('strips "#id" suffixes from componentProperties and keeps values', async () => {
    const inst = mockInstanceNode({
      id: 'i',
      componentProperties: {
        'Label#12:0': { type: 'TEXT', value: 'Buy now' },
        'Show icon#3:1': { type: 'BOOLEAN', value: true },
        Type: { type: 'VARIANT', value: 'Primary' },
      },
    });
    const { roots } = await buildDesignTree([inst], createMockResolver());
    expect(roots[0].instance!.componentProperties).toEqual({ Label: 'Buy now', 'Show icon': true, Type: 'Primary' });
    expect(stripPropertyId('A#b#1:2')).toBe('A#b');
    expect(stripPropertyId('Plain')).toBe('Plain');
  });

  it('non-instance nodes have instance null', async () => {
    const { roots } = await buildDesignTree([mockFrameNode()], createMockResolver());
    expect(roots[0].instance).toBeNull();
  });
});

describe('buildDesignTree — detachedInfo', () => {
  it('normalizes library detachedInfo', async () => {
    const f = mockFrameNode({ id: 'f' });
    f.detachedInfo = { type: 'library', componentKey: 'key-button' };
    const { roots } = await buildDesignTree([f], createMockResolver());
    expect(roots[0].detachedInfo).toEqual({ type: 'library', componentKey: 'key-button', resolvedComponentSetKey: null });
  });

  it('resolves the component-set key of a detached library variant', async () => {
    const f = mockFrameNode({ id: 'f' });
    f.detachedInfo = { type: 'library', componentKey: 'variant-primary-key' };
    const resolver = createMockResolver({}, { 'variant-primary-key': { componentSetKey: 'set-button' } });
    const { roots } = await buildDesignTree([f], resolver);
    expect(roots[0].detachedInfo).toEqual({
      type: 'library',
      componentKey: 'variant-primary-key',
      resolvedComponentSetKey: 'set-button',
    });
  });

  it('resolves local detachedInfo via the resolver', async () => {
    const f = mockFrameNode({ id: 'f' });
    f.detachedInfo = { type: 'local', componentId: '1:23' };
    const g = mockFrameNode({ id: 'g' });
    g.detachedInfo = { type: 'local', componentId: '9:99' };
    const resolver = createMockResolver({ '1:23': { key: 'key-row', componentSetKey: 'set-row' } });
    const { roots } = await buildDesignTree([f, g], resolver);
    expect(roots[0].detachedInfo).toEqual({
      type: 'local', componentId: '1:23', resolvedKey: 'key-row', resolvedComponentSetKey: 'set-row',
    });
    expect(roots[1].detachedInfo).toEqual({
      type: 'local', componentId: '9:99', resolvedKey: null, resolvedComponentSetKey: null,
    });
  });

  it('treats a throwing or absent detachedInfo as null', async () => {
    const f = mockFrameNode({ id: 'f' });
    Object.defineProperty(f, 'detachedInfo', { get() { throw new Error('nope'); } });
    const { roots } = await buildDesignTree([f, mockFrameNode()], createMockResolver());
    expect(roots[0].detachedInfo).toBeNull();
    expect(roots[1].detachedInfo).toBeNull();
  });
});

describe('buildDesignTree — nested instance origin', () => {
  it('records library / override origin for instances nested in instances (null at top level)', async () => {
    const libDivider = mockInstanceNode({ id: 'I1:2;5:6', name: 'Divider', __mainComponent: { key: 'divider', name: 'Divider' } });
    const swapped = mockInstanceNode({ id: 'I1:2;5:7', name: 'Card', __mainComponent: { key: 'rogue-card', name: 'Card' } });
    const column = mockInstanceNode({ id: '1:2', name: 'Column', __mainComponent: { key: 'key-column', name: 'Column' }, children: [libDivider, swapped] });
    const nodesById = {
      '5:6': mockInstanceNode({ id: '5:6', __mainComponent: { key: 'divider', name: 'Divider' } }),
      '5:7': mockInstanceNode({ id: '5:7', __mainComponent: { key: 'placeholder', name: 'Placeholder' } }),
    };
    const { roots } = await buildDesignTree([column], createMockResolver({}, {}, nodesById));
    expect(roots[0].nestedInstanceOrigin).toBeNull();
    expect(roots[0].children.map((c) => `${c.name}:${c.nestedInstanceOrigin}`)).toEqual(['Divider:library', 'Card:override']);
  });
});

describe('createFigmaResolver', () => {
  it('resolves a library component key to its set key via importComponentByKeyAsync (cached, fail-safe)', async () => {
    const set = { type: 'COMPONENT_SET', key: 'SET' };
    const api = {
      importComponentByKeyAsync: vi.fn(async (key: string) => {
        if (key === 'V') return { type: 'COMPONENT', key: 'V', parent: set };
        if (key === 'PLAIN') return { type: 'COMPONENT', key: 'PLAIN', parent: { type: 'PAGE' } };
        throw new Error('not published');
      }),
    };
    const r = createFigmaResolver(api);
    expect(await r.resolveLibraryComponent!('V')).toEqual({ componentSetKey: 'SET' });
    expect(await r.resolveLibraryComponent!('V')).toEqual({ componentSetKey: 'SET' });
    expect(api.importComponentByKeyAsync).toHaveBeenCalledTimes(1);
    expect(await r.resolveLibraryComponent!('PLAIN')).toEqual({ componentSetKey: null });
    expect(await r.resolveLibraryComponent!('GONE')).toBeNull();
  });

  it('classifies nested instances as library-owned, overridden or unknown', async () => {
    const mk = (key: string) => ({ id: 'm-' + key, key, name: key, type: 'COMPONENT' });
    const inst = (id: string, key: string | null): any => ({
      id,
      type: 'INSTANCE',
      getMainComponentAsync: async () => (key ? mk(key) : null),
    });
    const counterpart = inst('5:6', 'divider');
    const api = { getNodeByIdAsync: async (id: string) => (id === '5:6' ? counterpart : null) };
    const r = createFigmaResolver(api);
    const outer = inst('1:2', 'column');
    expect(await r.resolveNestedInstanceOrigin!(inst('I1:2;5:6', 'divider'), outer)).toBe('library');
    expect(await r.resolveNestedInstanceOrigin!(inst('I1:2;5:6', 'button'), outer)).toBe('override');
    expect(await r.resolveNestedInstanceOrigin!(inst('I1:2;7:7', 'x'), outer)).toBe('unknown');
    expect(await r.resolveNestedInstanceOrigin!(inst('9:9', 'x'), outer)).toBe('override');
    // Nested outer instance id "I1:2;3:4" → children are "I1:2;3:4;<id>".
    expect(await r.resolveNestedInstanceOrigin!(inst('I1:2;3:4;5:6', 'divider'), inst('I1:2;3:4', 'row'))).toBe('library');
  });

  it('uses getMainComponentAsync (never the sync getter) and caches by id', async () => {
    const set = { type: 'COMPONENT_SET', key: 'S', name: 'Set' };
    const main = { id: 'm', key: 'K', name: 'V', remote: false, parent: set, type: 'COMPONENT' };
    const inst: any = { type: 'INSTANCE', getMainComponentAsync: vi.fn(async () => main) };
    Object.defineProperty(inst, 'mainComponent', { get() { throw new Error('sync access forbidden'); } });
    const r = createFigmaResolver({});
    const info = await r.getMainComponent(inst);
    expect(info).toEqual({ id: 'm', key: 'K', name: 'V', remote: false, componentSetKey: 'S', componentSetName: 'Set' });
    const again = await r.getMainComponent(inst);
    expect(again).toBe(info);
  });

  it('survives a throwing parent getter', async () => {
    const main: any = { id: 'm', key: 'K', name: 'V' };
    Object.defineProperty(main, 'parent', { get() { throw new Error('x'); } });
    const r = createFigmaResolver({});
    const info = await r.getMainComponent({ getMainComponentAsync: async () => main });
    expect(info!.componentSetKey).toBeNull();
  });

  it('resolves local components via getNodeByIdAsync with caching', async () => {
    const set = { type: 'COMPONENT_SET', key: 'SET' };
    const api = {
      getNodeByIdAsync: vi.fn(async (id: string) =>
        id === '1:1' ? { type: 'COMPONENT', key: 'KEY', parent: set } : id === '2:2' ? { type: 'FRAME' } : null),
    };
    const r = createFigmaResolver(api);
    expect(await r.resolveLocalComponent('1:1')).toEqual({ key: 'KEY', componentSetKey: 'SET' });
    expect(await r.resolveLocalComponent('1:1')).toEqual({ key: 'KEY', componentSetKey: 'SET' });
    expect(api.getNodeByIdAsync).toHaveBeenCalledTimes(1);
    expect(await r.resolveLocalComponent('2:2')).toBeNull();
    expect(await r.resolveLocalComponent('3:3')).toBeNull();
  });

  it('returns null when the instance has no async API or it rejects', async () => {
    const r = createFigmaResolver({});
    expect(await r.getMainComponent({})).toBeNull();
    expect(await r.getMainComponent({ getMainComponentAsync: async () => { throw new Error('x'); } })).toBeNull();
  });
});

describe('buildDesignTree — labels & metadata', () => {
  it('reads fk-type pluginData in preference to the name prefix', async () => {
    const f = withPluginData(mockFrameNode({ id: 'f', name: '[fk:card] Promo' }), { 'fk-type': 'cta' });
    const { roots } = await buildDesignTree([f], createMockResolver());
    expect(roots[0].fkLabel).toBe('cta');
    expect(roots[0].baseName).toBe('Promo');
  });

  it('falls back to the [fk:x] prefix (incl. hyphenated roles) and ignores unknown roles', async () => {
    const a = mockFrameNode({ id: 'a', name: '[fk:card] Promo' });
    const b = mockFrameNode({ id: 'b', name: '[fk:list-item] Row' });
    const c = mockFrameNode({ id: 'c', name: '[fk:banana] X' });
    const d = mockFrameNode({ id: 'd', name: 'Plain' });
    const { roots } = await buildDesignTree([a, b, c, d], createMockResolver());
    expect(roots.map((r) => r.fkLabel)).toEqual(['card', 'list-item', null, null]);
    expect(roots.map((r) => r.baseName)).toEqual(['Promo', 'Row', 'X', 'Plain']);
  });

  it('reads fk-standards-component and fk-divi-type into standardsMeta', async () => {
    const f = withPluginData(mockFrameNode({ id: 'f' }), {
      'fk-standards-component': 'divi-blurb',
      'fk-divi-type': 'et_pb_blurb',
    });
    const { roots } = await buildDesignTree([f, mockFrameNode()], createMockResolver());
    expect(roots[0].standardsMeta).toEqual({ componentId: 'divi-blurb', diviType: 'et_pb_blurb' });
    expect(roots[1].standardsMeta).toEqual({ componentId: null, diviType: null });
  });
});

describe('buildDesignTree — values', () => {
  it('normalizes paints to lowercase #rrggbb with opacity, visibility and bound variables', async () => {
    const f = mockFrameNode({
      id: 'f',
      fills: [
        mockSolidPaint({ color: { r: 1, g: 0.5, b: 0 }, opacity: 0.5 }),
        mockImagePaint({ visible: false }),
        { ...mockSolidPaint({ color: { r: 0, g: 0, b: 0 } }), boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } } },
      ],
      strokes: [mockSolidPaint({ color: { r: 0.0667, g: 0.0667, b: 0.0667 } })],
    });
    const { roots } = await buildDesignTree([f], createMockResolver());
    expect(roots[0].fills).toEqual([
      { type: 'SOLID', visible: true, hex: '#ff8000', opacity: 0.5, boundVariableId: null },
      { type: 'IMAGE', visible: false, hex: null, opacity: 1, boundVariableId: null },
      { type: 'SOLID', visible: true, hex: '#000000', opacity: 1, boundVariableId: 'VariableID:1' },
    ]);
    expect(roots[0].strokes[0].hex).toBe('#111111');
  });

  it('maps mixed values to null / MIXED / []', async () => {
    const f = mockFrameNode({ id: 'f', cornerRadius: MIXED, fills: MIXED });
    (f as any).fillStyleId = MIXED;
    (f as any).strokeStyleId = 'S:abc';
    const t = mockTextNode({ id: 't', fontSize: MIXED, fontName: MIXED, fontWeight: MIXED, lineHeight: MIXED });
    (t as any).textStyleId = MIXED;
    const { roots } = await buildDesignTree([f, t], createMockResolver());
    expect(roots[0].cornerRadius).toBeNull();
    expect(roots[0].fills).toEqual([]);
    expect(roots[0].fillStyleId).toBe('MIXED');
    expect(roots[0].strokeStyleId).toBe('S:abc');
    expect(roots[0].textStyleId).toBe('');
    expect(roots[1].text).toEqual({
      fontFamily: null, fontStyle: null, fontSize: null, fontWeight: null, lineHeightPx: null,
      textCase: 'ORIGINAL', characters: 'Sample text',
    });
    expect(roots[1].textStyleId).toBe('MIXED');
  });

  it('captures text properties and layout/geometry', async () => {
    const t = mockTextNode({ id: 't', fontSize: 48, fontWeight: 700, lineHeight: { unit: 'PERCENT', value: 120 }, characters: 'Hi' });
    const f = mockFrameNode({
      id: 'f', layoutMode: 'VERTICAL', paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4,
      itemSpacing: 5, width: 10, height: 20, cornerRadius: 6, children: [t],
    });
    const { roots } = await buildDesignTree([f], createMockResolver());
    const r = roots[0];
    expect(r.layoutMode).toBe('VERTICAL');
    expect(r.padding).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(r.itemSpacing).toBe(5);
    expect([r.width, r.height, r.cornerRadius]).toEqual([10, 20, 6]);
    expect(r.text).toBeNull();
    expect(r.children[0].text).toMatchObject({ fontFamily: 'Inter', fontStyle: 'Regular', fontSize: 48, fontWeight: 700, lineHeightPx: null, characters: 'Hi' });
    expect(r.children[0].analysis.role).toBe('heading');
  });

  it('flattens node.boundVariables to variable ids', async () => {
    const f = mockFrameNode({ id: 'f' });
    f.boundVariables = {
      paddingTop: { type: 'VARIABLE_ALIAS', id: 'V:1' },
      fills: [{ type: 'VARIABLE_ALIAS', id: 'V:2' }, { type: 'VARIABLE_ALIAS', id: 'V:3' }],
    };
    const { roots } = await buildDesignTree([f], createMockResolver());
    expect(roots[0].boundVariables).toEqual({ fills: ['V:2', 'V:3'], paddingTop: ['V:1'] });
  });

  it('robust to bare plain objects with no methods/props', async () => {
    const { roots, nodeCount } = await buildDesignTree([{ id: 'x', type: 'FRAME' }], createMockResolver());
    expect(nodeCount).toBe(1);
    expect(roots[0]).toMatchObject({ name: '', layoutMode: 'NONE', fills: [], fkLabel: null, structural: { role: 'spacer' } });
  });
});

describe('structural classification (name-blind)', () => {
  it('a frame named "Button" without button structure is NOT structurally a button', async () => {
    const f = mockFrameNode({
      id: 'f', name: 'Button', width: 400, height: 300,
      children: [mockRectangleNode({ name: 'a', width: 300, height: 200 }), mockRectangleNode({ name: 'b', width: 300, height: 200 })],
    });
    const { roots } = await buildDesignTree([f], createMockResolver());
    expect(roots[0].analysis.role).toBe('button'); // name-influenced analyzer
    expect(roots[0].structural).not.toBeNull();
    expect(roots[0].structural!.role).not.toBe('button');
    expect(f.name).toBe('Button'); // raw node untouched
  });

  it('an unnamed auto-layout pill with fill + text child is structurally a button', async () => {
    const p = pill({ id: 'p', name: 'Frame 12' });
    const { roots } = await buildDesignTree([p], createMockResolver());
    expect(roots[0].structural).toEqual({ role: 'button', confidence: 85, source: 'type' });
  });

  it('a decorative-named node is not treated as decorative structurally', () => {
    const f = pill({ name: 'shadow' });
    expect(classifyStructure(f)!.role).toBe('button');
  });

  it('uses structure (fingerprint) for ≥2 children', async () => {
    const f = mockFrameNode({
      id: 'f', name: 'Whatever', width: 300, height: 200, layoutMode: 'VERTICAL',
      children: [
        mockRectangleNode({ name: 'r', width: 24, height: 24, fills: [mockImagePaint()] }),
        mockTextNode({ name: 't', fontSize: 24 }),
        mockTextNode({ name: 'u' }),
      ],
    });
    const { roots } = await buildDesignTree([f], createMockResolver());
    expect(roots[0].structural!.source).toBe('structure');
    expect(roots[0].structural!.role).toBe('feature');
  });

  it('leaves are null structurally', async () => {
    const { roots } = await buildDesignTree([mockTextNode(), mockRectangleNode()], createMockResolver());
    expect(roots[0].structural).toBeNull();
    expect(roots[1].structural).toBeNull();
  });

  it('never uses Object.create over the raw node (getters on the raw node are read once via plain copy)', () => {
    const raw: any = pill({ name: 'Button' });
    const spy = vi.spyOn(Object, 'create');
    classifyStructure(raw);
    expect(spy).not.toHaveBeenCalledWith(raw);
    spy.mockRestore();
  });
});
