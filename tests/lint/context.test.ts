import { describe, it, expect } from 'vitest';
import { severityForCertainty, createLintContext } from '../../src/lint/context';
import { createRegistryIndex } from '../../src/lint/registry';
import { resolveConfig } from '../../src/lint/config';
import type { LintConfig } from '../../src/lint/types';
import { node, instanceOf, finalize, testRegistry, byName, makeContext } from './helpers';

describe('severityForCertainty', () => {
  it('default map: confirmed inherits, likely → warning, requires-review → info', () => {
    expect(severityForCertainty('error', 'confirmed')).toBe('error');
    expect(severityForCertainty('error', 'likely')).toBe('warning');
    expect(severityForCertainty('error', 'requires-review')).toBe('info');
  });
  it('never more severe than configured', () => {
    expect(severityForCertainty('info', 'likely')).toBe('info');
    expect(severityForCertainty('warning', 'likely', { likely: 'error' })).toBe('warning');
    expect(severityForCertainty('warning', 'requires-review', { 'requires-review': 'error' })).toBe('warning');
  });
  it('custom map', () => {
    expect(severityForCertainty('error', 'likely', { likely: 'error' })).toBe('error');
    expect(severityForCertainty('error', 'requires-review', { 'requires-review': 'warning' })).toBe('warning');
    expect(severityForCertainty('error', 'likely', { likely: 'inherit' })).toBe('error');
    expect(severityForCertainty('error', 'confirmed', { confirmed: 'info' })).toBe('info');
  });
  it('invalid map entries fall back to defaults', () => {
    expect(severityForCertainty('error', 'likely', { likely: 'bogus' as never })).toBe('warning');
  });
});

function tree() {
  return finalize([
    node({
      name: 'Page',
      children: [
        node({
          name: 'Section',
          detachedInfo: { type: 'library', componentKey: 'key-section' },
          children: [
            node({
              name: 'Wrapper',
              children: [
                instanceOf('key-row', { name: 'Row', children: [node({ name: 'Row Inner' })] }),
                instanceOf('variant-xyz', { name: 'Primary' }, { setKey: 'set-button' }),
                instanceOf('unregistered', { name: 'Random', children: [instanceOf('key-text', { name: 'Nested Text' })] }),
              ],
            }),
          ],
        }),
        node({ name: 'Detached Lib', detachedInfo: { type: 'library', componentKey: 'key-image' } }),
        node({
          name: 'Detached Local',
          detachedInfo: { type: 'local', componentId: '1:1', resolvedKey: 'zzz', resolvedComponentSetKey: 'set-button' },
        }),
        node({ name: 'Declared Blurb', standardsMeta: { componentId: 'divi-blurb' } }),
        node({ name: 'Declared Row', standardsMeta: { componentId: 'divi-row' } }),
        node({ name: 'Loose' }),
      ],
    }),
  ]);
}

function ctxFor(roots: ReturnType<typeof tree>, cfg: LintConfig = {}) {
  return createLintContext({ roots, registry: createRegistryIndex(testRegistry()), config: resolveConfig(cfg, []).config });
}

describe('createLintContext', () => {
  it('node / parent / ancestor queries', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    const row = byName(roots, 'Row');
    expect(ctx.getNode(row.id)).toBe(row);
    expect(ctx.getNode('missing')).toBeNull();
    expect(ctx.getParent(row)!.name).toBe('Wrapper');
    expect(ctx.getParent(roots[0])).toBeNull();
    expect(ctx.getAncestors(row).map((n) => n.name)).toEqual(['Wrapper', 'Section', 'Page']);
    expect(ctx.formatPath(row)).toBe('Page / Section / Wrapper / Row');
    expect(ctx.roots).toBe(roots);
  });
  it('setRule swaps ruleId / severity / options', () => {
    const ctx = ctxFor(tree());
    ctx.setRule('a/b', 'warning', { x: 1 });
    expect(ctx.ruleId).toBe('a/b');
    expect(ctx.severity).toBe('warning');
    expect(ctx.options).toEqual({ x: 1 });
  });
  it('getRegistryMatch: instance variant key, then component-set key', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    expect(ctx.getRegistryMatch(byName(roots, 'Row'))).toMatchObject({ source: 'instance', matchedKey: 'key-row' });
    expect(ctx.getRegistryMatch(byName(roots, 'Section'))).toMatchObject({ source: 'detached', matchedKey: 'key-section' });
    const btn = ctx.getRegistryMatch(byName(roots, 'Primary'))!;
    expect(btn.component.id).toBe('divi-button');
    expect(btn).toMatchObject({ source: 'instance', matchedKey: 'set-button' });
    expect(ctx.getRegistryMatch(byName(roots, 'Random'))).toBeNull();
  });
  it('getRegistryMatch: detached library and local', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    expect(ctx.getRegistryMatch(byName(roots, 'Detached Lib'))).toMatchObject({ source: 'detached', matchedKey: 'key-image' });
    const loc = ctx.getRegistryMatch(byName(roots, 'Detached Local'))!;
    expect(loc.component.id).toBe('divi-button');
    expect(loc).toMatchObject({ source: 'detached', matchedKey: 'set-button' });
  });
  it('getRegistryMatch: metadata only when allowMetadataMapping', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    expect(ctx.getRegistryMatch(byName(roots, 'Declared Blurb'))).toMatchObject({ source: 'metadata', matchedKey: null });
    expect(ctx.getRegistryMatch(byName(roots, 'Declared Row'))).toBeNull();
    expect(ctx.getRegistryMatch(byName(roots, 'Loose'))).toBeNull();
  });
  it('getRegistryMatch is memoized', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    const s = byName(roots, 'Section');
    expect(ctx.getRegistryMatch(s)).toBe(ctx.getRegistryMatch(s));
  });
  it('unresolved main component → no match', () => {
    const roots = finalize([instanceOf(null, { name: 'Ghost' })]);
    expect(ctxFor(roots).getRegistryMatch(roots[0])).toBeNull();
  });
  it('getNearestRegisteredAncestor', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    expect(ctx.getNearestRegisteredAncestor(byName(roots, 'Row'))!.name).toBe('Section');
    expect(ctx.getNearestRegisteredAncestor(byName(roots, 'Row Inner'))!.name).toBe('Row');
    expect(ctx.getNearestRegisteredAncestor(byName(roots, 'Section'))).toBeNull();
  });
  it('getNearestRegisteredDescendants stops at matches and does not cross into instance internals', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    expect(ctx.getNearestRegisteredDescendants(roots[0]).map((n) => n.name)).toEqual([
      'Section', 'Detached Lib', 'Detached Local', 'Declared Blurb',
    ]);
    // Nested Text is inside unregistered instance "Random" → internal, not found.
    expect(ctx.getNearestRegisteredDescendants(byName(roots, 'Section')).map((n) => n.name)).toEqual(['Row', 'Primary']);
    const ctx2 = ctxFor(roots, { settings: { checkInstanceInternals: true } });
    expect(ctx2.getNearestRegisteredDescendants(byName(roots, 'Section')).map((n) => n.name)).toEqual(['Row', 'Primary', 'Nested Text']);
  });
  it('isInGovernedContext', () => {
    const roots = tree();
    const ctx = ctxFor(roots);
    expect(ctx.isInGovernedContext(byName(roots, 'Random'))).toBe(true); // under governed Section
    expect(ctx.isInGovernedContext(byName(roots, 'Loose'))).toBe(false);
    expect(ctxFor(roots, { settings: { governTopLevel: true } }).isInGovernedContext(byName(roots, 'Loose'))).toBe(true);
    // Under a non-governing registered ancestor (button) → false even with governTopLevel.
    const r2 = finalize([instanceOf('key-button', { name: 'Btn', children: [node({ name: 'Label' })] })]);
    const c2 = ctxFor(r2, { settings: { governTopLevel: true, checkInstanceInternals: true } });
    expect(c2.isInGovernedContext(byName(r2, 'Label'))).toBe(false);
  });
  it('isInstanceInternal', () => {
    const roots = tree();
    expect(ctxFor(roots).isInstanceInternal(byName(roots, 'Row Inner'))).toBe(true);
    expect(ctxFor(roots).isInstanceInternal(byName(roots, 'Section'))).toBe(false);
    expect(ctxFor(roots, { settings: { checkInstanceInternals: true } }).isInstanceInternal(byName(roots, 'Row Inner'))).toBe(false);
  });
  it('tokens default to {} and expose registry tokens', () => {
    const roots = tree();
    expect(ctxFor(roots).tokens.fontFamilies).toEqual(['Inter']);
    const c = createLintContext({
      roots,
      registry: createRegistryIndex({ version: '1.0.0', designSystem: 'x', status: 'approved', components: [] }),
      config: resolveConfig({}, []).config,
    });
    expect(c.tokens).toEqual({});
  });
  it('makeContext helper applies options/severity', () => {
    const roots = [node({ name: 'A' })];
    const c = makeContext(roots, { ruleId: 'x/y', options: { a: 1 }, severity: 'info', rules: [] });
    expect(c.ruleId).toBe('x/y');
    expect(c.options).toEqual({ a: 1 });
    expect(c.severity).toBe('info');
    expect(roots[0].id).toBe('n1');
  });
});
