import { describe, it, expect } from 'vitest';
import {
  validateRegistry,
  loadRegistry,
  createRegistryIndex,
  emptyRegistry,
  isPlaceholderKey,
} from '../../src/lint/registry';
import bundled from '../../src/standards/registry.example.json';
import { testRegistry } from './helpers';

const codes = (input: unknown) => validateRegistry(input).map((d) => `${d.level}:${d.code}`);
function withComponent(extra: Record<string, unknown>, more: unknown[] = []) {
  return {
    version: '1.0.0',
    designSystem: 'X',
    status: 'approved',
    components: [{ id: 'a', name: 'A', diviType: null, figmaComponentKeys: ['k-a'], ...extra }, ...more],
  };
}

describe('validateRegistry', () => {
  it('accepts the test registry with no diagnostics', () => {
    expect(validateRegistry(testRegistry())).toEqual([]);
  });
  it('invalid-registry for non-objects', () => {
    expect(codes(null)).toEqual(['error:invalid-registry']);
    expect(codes([])).toEqual(['error:invalid-registry']);
  });
  it('invalid-version / invalid-design-system / invalid-components', () => {
    expect(codes({ version: '1', designSystem: '', status: 'draft', components: {} })).toEqual([
      'error:invalid-version',
      'error:invalid-design-system',
      'error:invalid-components',
    ]);
  });
  it('missing-status is a warning; invalid-status is an error', () => {
    expect(codes({ version: '1.0.0', designSystem: 'X', components: [] })).toEqual(['warning:missing-status']);
    expect(codes({ version: '1.0.0', designSystem: 'X', status: 'final', components: [] })).toEqual(['error:invalid-status']);
  });
  it('unknown top-level keys are info', () => {
    expect(codes({ ...emptyRegistry(), extra: 1 })).toEqual(['info:unknown-key']);
  });
  it('invalid-component / invalid-id / duplicate-id / invalid-name / invalid-divi-type', () => {
    const reg = {
      version: '1.0.0', designSystem: 'X', status: 'approved',
      components: [
        'nope',
        { id: 'Bad Id', name: 'B', figmaComponentKeys: ['k1'] },
        { id: 'a', name: 'A', figmaComponentKeys: ['k2'] },
        { id: 'a', name: '', diviType: 5, figmaComponentKeys: ['k3'] },
      ],
    };
    expect(codes(reg)).toEqual([
      'error:invalid-component',
      'error:invalid-id',
      'error:duplicate-id',
      'error:invalid-name',
      'error:invalid-divi-type',
    ]);
  });
  it('invalid-keys / no-keys / unresolved-key / duplicate-key', () => {
    expect(codes(withComponent({ figmaComponentKeys: 'x' }))).toEqual(['error:invalid-keys']);
    expect(codes(withComponent({ figmaComponentKeys: [1] }))).toEqual(['error:invalid-keys']);
    expect(codes(withComponent({ figmaComponentKeys: [] }))).toEqual(['warning:no-keys']);
    expect(codes(withComponent({ figmaComponentKeys: ['REPLACE_ME', '', 'TODO-key', 'my-REPLACE'] }))).toEqual([
      'warning:unresolved-key', 'warning:unresolved-key', 'warning:unresolved-key', 'warning:unresolved-key',
    ]);
    expect(codes(withComponent({}, [{ id: 'b', name: 'B', figmaComponentKeys: ['k-a'] }]))).toEqual(['error:duplicate-key']);
  });
  it('identical placeholders on several components are not duplicate-key errors', () => {
    const d = validateRegistry(withComponent({ figmaComponentKeys: ['REPLACE_X'] }, [{ id: 'b', name: 'B', figmaComponentKeys: ['REPLACE_X'] }]));
    expect(d.every((x) => x.code === 'unresolved-key')).toBe(true);
  });
  it('unknown-reference for allowedChildren / allowedParents / deprecated.replacedBy', () => {
    expect(codes(withComponent({ allowedChildren: ['ghost'] }))).toEqual(['error:unknown-reference']);
    expect(codes(withComponent({ allowedParents: ['$root', 'ghost'] }))).toEqual(['error:unknown-reference']);
    expect(codes(withComponent({ allowedChildren: ['$root'] }))).toEqual(['error:unknown-reference']);
    expect(codes(withComponent({ allowedParents: ['$root', 'a'] }))).toEqual([]);
    expect(codes(withComponent({ deprecated: { replacedBy: 'ghost' } }))).toEqual(['error:unknown-reference']);
    expect(codes(withComponent({ deprecated: { replacedBy: 'a', message: 'm' } }))).toEqual([]);
  });
  it('invalid-pattern for namingPattern and match.namePatterns', () => {
    expect(codes(withComponent({ namingPattern: '([' }))).toEqual(['error:invalid-pattern']);
    expect(codes(withComponent({ match: { namePatterns: ['ok', '(['] } }))).toEqual(['error:invalid-pattern']);
  });
  it('unknown-role is a warning', () => {
    expect(codes(withComponent({ match: { roles: ['button', 'spaceship'] } }))).toEqual(['warning:unknown-role']);
  });
  it('invalid-required-properties', () => {
    expect(codes(withComponent({ requiredProperties: {} }))).toEqual(['error:invalid-required-properties']);
    expect(codes(withComponent({ requiredProperties: [{ name: '' }, { name: 'T', allowedValues: [1] }] }))).toEqual([
      'error:invalid-required-properties', 'error:invalid-required-properties',
    ]);
    expect(codes(withComponent({ requiredProperties: [{ name: 'T', allowedValues: ['a'] }] }))).toEqual([]);
  });
  it('invalid-field for shapes', () => {
    expect(codes(withComponent({ requiresAutoLayout: { direction: 'DIAGONAL' } }))).toEqual(['error:invalid-field']);
    expect(codes(withComponent({ governsChildren: 'yes' }))).toEqual(['error:invalid-field']);
    expect(codes(withComponent({ optionalStates: { Size: 'L' } }))).toEqual(['error:invalid-field']);
    expect(codes(withComponent({ allowedChildren: 'a' }))).toEqual(['error:invalid-field']);
    expect(codes(withComponent({ requiresAutoLayout: true, optionalStates: { Size: ['S', 'L'] } }))).toEqual([]);
  });
  it('unknown component keys are info', () => {
    expect(codes(withComponent({ colour: 'red' }))).toEqual(['info:unknown-key']);
  });
  it('invalid-token', () => {
    const bad = {
      ...emptyRegistry(),
      tokens: {
        colors: [{ name: 'a', value: 'red' }, { name: 'b', value: '#abc' }],
        spacing: [{ name: 's', value: -1 }, { name: 't', value: Infinity }, { name: 'u', value: 0 }],
        typography: [{ name: 'x', fontSize: 0 }, { name: 'y', fontSize: 12 }],
        fontFamilies: [1],
      },
    };
    expect(codes(bad)).toEqual(['error:invalid-token', 'error:invalid-token', 'error:invalid-token', 'error:invalid-token', 'error:invalid-token']);
    expect(codes({ ...emptyRegistry(), tokens: [] })).toEqual(['error:invalid-token']);
  });
  it('diagnostics carry paths', () => {
    const d = validateRegistry(withComponent({ allowedChildren: ['ghost'] }));
    expect(d[0].path).toBe('components[0].allowedChildren[0]');
  });
});

describe('loadRegistry', () => {
  it('index is null iff any error', () => {
    expect(loadRegistry({}).index).toBeNull();
    const ok = loadRegistry(withComponent({ figmaComponentKeys: [] }));
    expect(ok.index).not.toBeNull();
    expect(ok.diagnostics.map((d) => d.code)).toEqual(['no-keys']);
  });
  it('normalizes missing status to draft and missing diviType to null', () => {
    const { index } = loadRegistry({ version: '1.0.0', designSystem: 'X', components: [{ id: 'a', name: 'A', figmaComponentKeys: ['k'] }] });
    expect(index!.status).toBe('draft');
    expect(index!.getById('a')!.diviType).toBeNull();
  });
  it('does not mutate input', () => {
    const input = { version: '1.0.0', designSystem: 'X', components: [{ id: 'a', name: 'A', figmaComponentKeys: ['k'] }] };
    loadRegistry(input);
    expect('status' in input).toBe(false);
  });
  it('bundled src/standards/registry.example.json loads with zero errors and unresolved-key warnings', () => {
    const { index, diagnostics } = loadRegistry(bundled);
    expect(diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(index).not.toBeNull();
    expect(index!.status).toBe('draft');
    expect(index!.version).toBe('0.1.0');
    expect(index!.designSystem).toBe('Divi 5');
    const unresolved = diagnostics.filter((d) => d.code === 'unresolved-key');
    expect(unresolved.length).toBe(8);
    expect(unresolved.every((d) => d.level === 'warning')).toBe(true);
    // Illustrative draft: no nesting constraints, description says so.
    for (const c of index!.all()) {
      expect(c.allowedChildren).toBeUndefined();
      expect(c.allowedParents).toBeUndefined();
      expect(c.diviType).toMatch(/^et_pb_/);
    }
    expect(index!.registry.description).toMatch(/ILLUSTRATIVE/);
    expect(index!.registry.description).toMatch(/NO confirmed Divi 5 nesting rules/);
    expect(index!.all().map((c) => c.id)).toEqual([
      'divi-section', 'divi-row', 'divi-column', 'divi-button', 'divi-text', 'divi-image', 'divi-blurb', 'divi-cta',
    ]);
    expect(index!.getByKey('REPLACE_WITH_FIGMA_COMPONENT_KEY')).toBeNull();
  });
});

describe('createRegistryIndex', () => {
  const idx = createRegistryIndex(testRegistry());
  it('exposes metadata', () => {
    expect(idx.version).toBe('1.0.0');
    expect(idx.status).toBe('approved');
    expect(idx.all().length).toBe(7);
  });
  it('getById', () => {
    expect(idx.getById('divi-row')!.name).toBe('Divi Row');
    expect(idx.getById('nope')).toBeNull();
  });
  it('getByKey matches component keys AND component-set keys', () => {
    expect(idx.getByKey('key-button')!.id).toBe('divi-button');
    expect(idx.getByKey('set-button')!.id).toBe('divi-button');
    expect(idx.getByKey('unknown')).toBeNull();
    expect(idx.getByKey('')).toBeNull();
  });
  it('placeholder keys are not indexed', () => {
    const i2 = createRegistryIndex({
      ...emptyRegistry(),
      components: [{ id: 'a', name: 'A', diviType: null, figmaComponentKeys: ['REPLACE_ME', 'real'] }],
    });
    expect(i2.getByKey('REPLACE_ME')).toBeNull();
    expect(i2.getByKey('real')!.id).toBe('a');
    expect(i2.isPlaceholderKey('REPLACE_ME')).toBe(true);
    expect(i2.isPlaceholderKey('real')).toBe(false);
  });
  it('candidatesForRole is sorted by id', () => {
    const i2 = createRegistryIndex({
      ...emptyRegistry(),
      components: [
        { id: 'zeta', name: 'Z', diviType: null, figmaComponentKeys: [], match: { roles: ['card'] } },
        { id: 'alpha', name: 'A', diviType: null, figmaComponentKeys: [], match: { roles: ['card'] } },
        { id: 'mid', name: 'M', diviType: null, figmaComponentKeys: [], match: { roles: ['button'] } },
      ],
    });
    expect(i2.candidatesForRole('card').map((c) => c.id)).toEqual(['alpha', 'zeta']);
    expect(i2.candidatesForRole('hero')).toEqual([]);
  });
  it('candidatesForName: patterns case-insensitive, exact name, sorted', () => {
    expect(idx.candidatesForName('Button').map((c) => c.id)).toEqual(['divi-button']);
    expect(idx.candidatesForName('DIVI-BTN').map((c) => c.id)).toEqual(['divi-button']);
    expect(idx.candidatesForName('divi blurb').map((c) => c.id)).toEqual(['divi-blurb']);
    expect(idx.candidatesForName('Hero Banner')).toEqual([]);
    expect(idx.candidatesForName('')).toEqual([]);
    const i2 = createRegistryIndex({
      ...emptyRegistry(),
      components: [
        { id: 'z', name: 'Promo', diviType: null, figmaComponentKeys: [], match: { namePatterns: ['promo'] } },
        { id: 'a', name: 'Promo', diviType: null, figmaComponentKeys: [] },
      ],
    });
    expect(i2.candidatesForName('promo').map((c) => c.id)).toEqual(['a', 'z']);
  });
  it('isPlaceholderKey standalone', () => {
    for (const k of ['', '  ', 'REPLACE_WITH_FIGMA_COMPONENT_KEY', 'todo', 'FIGMA_COMPONENT_KEY', 'placeholder-1', 'XXX', 'abcREPLACEdef']) {
      expect(isPlaceholderKey(k)).toBe(true);
    }
    expect(isPlaceholderKey('3f2a9c0b1d')).toBe(false);
  });
});
