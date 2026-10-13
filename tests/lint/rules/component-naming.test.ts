import { describe, it, expect } from 'vitest';
import type { ComponentRegistry, DesignNode, LintConfig } from '../../../src/lint/types';
import { rule } from '../../../src/lint/rules/component-naming';
import { node, instanceOf, lint, testRegistry } from '../helpers';

const ID = 'divi/component-naming';

function run(roots: DesignNode[], opts: { options?: Record<string, unknown>; registry?: ComponentRegistry } = {}) {
  const config: LintConfig = {
    extends: ['figmakit:recommended'],
    rulesetVersion: '1.0.0',
    rules: opts.options ? { [ID]: ['warning', opts.options] } : {},
  };
  const out = lint(roots, { rules: [rule], config, registry: opts.registry });
  return { ...out, issues: out.result.issues.filter((i) => i.ruleId === ID) };
}

function regWithPattern(id: string, pattern: string, name?: string): ComponentRegistry {
  const r = testRegistry();
  const c = r.components.find((x) => x.id === id)!;
  c.namingPattern = pattern;
  if (name) c.name = name;
  return r;
}

describe('divi/component-naming', () => {
  it('meta', () => {
    expect(rule.meta.id).toBe(ID);
    expect(rule.meta.fixable).toBe(true);
    expect(rule.meta.category).toBe('naming');
    expect(rule.meta.validateOptions!(rule.meta.defaultOptions)).toEqual([]);
    expect(rule.meta.validateOptions!({ pattern: '(' })).toHaveLength(1);
    expect(rule.meta.validateOptions!({ pattern: 3 })).toHaveLength(1);
    expect(rule.meta.validateOptions!({ disallowAutoNames: 'no' })).toHaveLength(1);
  });

  it('flags an auto-generated name on a registered component with a SAFE rename', () => {
    const out = run([instanceOf('key-button', { name: 'Frame 12' })]);
    expect(out.issues).toHaveLength(1);
    const i = out.issues[0];
    expect(i.code).toBe('auto-generated-name');
    expect(i.fix!.kind).toBe('SAFE');
    expect(i.fix!.operations).toEqual([{ op: 'rename', nodeId: i.nodeId, from: 'Frame 12', to: 'Divi Button' }]);
    expect(i.fix!.description).toBe('Rename "Frame 12" → "Divi Button"');
  });

  it('preserves the [fk:role] prefix when renaming', () => {
    const det = node({ name: '[fk:button] Group 3', fkLabel: 'button', detachedInfo: { type: 'library', componentKey: 'key-button' } });
    const out = run([det]);
    expect(out.issues[0].fix!.operations[0]).toMatchObject({ from: '[fk:button] Group 3', to: '[fk:button] Divi Button' });
  });

  it('does not flag a component named after itself even if the name looks like a Figma default', () => {
    // "Section" matches AUTO_NAME_PATTERN, but it is the Divi Section's own name.
    const out = run([instanceOf('key-section', { name: 'Section' }), instanceOf('key-button', { name: 'Divi Button' })]);
    expect(out.issues).toEqual([]);
  });

  it('never checks ordinary or instance-internal layers', () => {
    const inst = instanceOf('key-blurb', { name: 'Blurb', children: [node({ name: 'Frame 1' }), instanceOf('key-button', { name: 'Frame 2' })] });
    const roots = [node({ name: 'Frame 99', children: [node({ name: 'Group 4' }), node({ name: 'Rectangle 2', type: 'RECTANGLE' }), inst] })];
    const out = run(roots);
    expect(out.issues).toEqual([]);
    expect(out.result.ruleSummaries.find((s) => s.ruleId === ID)!.checks).toBe(1);
  });

  it('disallowAutoNames=false turns the auto-name check off', () => {
    expect(run([instanceOf('key-button', { name: 'Frame 12' })], { options: { disallowAutoNames: false } }).issues).toEqual([]);
  });

  it('component namingPattern mismatch: confirm-to-apply rename when the component name fits', () => {
    const reg = regWithPattern('divi-button', '^(Divi )?Button', 'Divi Button');
    const out = run([instanceOf('key-button', { name: 'CTA link' })], { registry: reg });
    expect(out.issues.map((i) => i.code)).toEqual(['pattern-mismatch']);
    expect(out.issues[0].fix!.kind).toBe('REQUIRES_CONFIRMATION');
    expect(out.issues[0].fix!.operations[0]).toMatchObject({ op: 'rename', to: 'Divi Button' });
    expect(out.issues[0].expected).toBe('/^(Divi )?Button/');
    expect(run([instanceOf('key-button', { name: 'Button / Primary' })], { registry: reg }).issues).toEqual([]);
  });

  it('pattern-mismatch fix is UNSUPPORTED when the component name does not fit the pattern', () => {
    const reg = regWithPattern('divi-button', '^btn-[a-z]+$');
    const out = run([instanceOf('key-button', { name: 'Call to action' })], { registry: reg });
    expect(out.issues[0].code).toBe('pattern-mismatch');
    expect(out.issues[0].fix!.kind).toBe('UNSUPPORTED');
    // Auto-name fix is downgraded too: renaming to "Divi Button" would violate the pattern.
    const auto = run([instanceOf('key-button', { name: 'Frame 4' })], { registry: reg });
    expect(auto.issues.map((i) => [i.code, i.fix!.kind])).toEqual([['auto-generated-name', 'UNSUPPORTED']]);
  });

  it('global pattern applies to all semantic components only', () => {
    const roots = [
      node({
        name: 'page',
        children: [instanceOf('key-button', { name: 'Divi Button' }), instanceOf('key-text', { name: 'body copy' }), node({ name: 'random layer' })],
      }),
    ];
    const out = run(roots, { options: { pattern: '^[A-Z]' } });
    expect(out.issues.map((i) => [i.nodeName, i.code, i.fix!.kind])).toEqual([['body copy', 'pattern-mismatch', 'REQUIRES_CONFIRMATION']]);
    expect(out.issues[0].data).toMatchObject({ scope: 'global' });
  });

  it('includeUnmappedBoundaries checks explicitly labelled layers (no rename target)', () => {
    const labelled = node({ name: '[fk:card] Frame 7', fkLabel: 'card' });
    expect(run([labelled]).issues).toEqual([]);
    const out = run([node({ name: '[fk:card] Frame 7', fkLabel: 'card' })], { options: { includeUnmappedBoundaries: true } });
    expect(out.issues.map((i) => [i.code, i.fix!.kind])).toEqual([['auto-generated-name', 'UNSUPPORTED']]);
  });
});
