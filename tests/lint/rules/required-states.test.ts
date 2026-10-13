import { describe, it, expect } from 'vitest';
import type { ComponentRegistry, DesignNode, LintConfig } from '../../../src/lint/types';
import { rule } from '../../../src/lint/rules/required-states';
import { node, instanceOf, lint, testRegistry } from '../helpers';

const ID = 'divi/required-states';

function run(roots: DesignNode[], registry?: ComponentRegistry) {
  const config: LintConfig = { extends: ['figmakit:recommended'], rulesetVersion: '1.0.0' };
  const out = lint(roots, { rules: [rule], config, registry });
  return { ...out, issues: out.result.issues.filter((i) => i.ruleId === ID) };
}

describe('divi/required-states', () => {
  it('meta', () => {
    expect(rule.meta.id).toBe(ID);
    expect(rule.meta.defaultSeverity).toBe('error');
    expect(rule.meta.validateOptions!({})).toEqual([]);
    expect(rule.meta.docs).toMatch(/optionalStates/);
  });

  it('passes when the required variant property has an allowed value', () => {
    const out = run([instanceOf('key-button', { name: 'Button' }, { variantProperties: { Type: 'Secondary' } })]);
    expect(out.issues).toEqual([]);
    expect(out.result.ruleSummaries.find((s) => s.ruleId === ID)!.passedChecks).toBe(1);
  });

  it('matches via the component-set key and reads componentProperties too', () => {
    const out = run([instanceOf('other-variant-key', { name: 'Button' }, { setKey: 'set-button', componentProperties: { Type: 'Primary' } })]);
    expect(out.issues).toEqual([]);
  });

  it('flags a missing required property', () => {
    const out = run([instanceOf('key-button', { name: 'Button' }, { variantProperties: { Size: 'L' } })]);
    expect(out.issues).toHaveLength(1);
    const i = out.issues[0];
    expect(i.code).toBe('missing-property');
    expect(i.severity).toBe('error');
    expect(i.blocking).toBe(true);
    expect(i.expected).toBe('Primary, Secondary');
    expect(i.fix!.kind).toBe('UNSUPPORTED');
  });

  it('flags a disallowed value', () => {
    const out = run([instanceOf('key-button', { name: 'Button' }, { variantProperties: { Type: 'Ghost' } })]);
    expect(out.issues.map((i) => [i.code, i.actual, i.expected])).toEqual([['invalid-property-value', 'Ghost', 'Primary, Secondary']]);
  });

  it('compares boolean properties as strings and treats empty allowedValues as unconstrained', () => {
    const reg = testRegistry();
    const button = reg.components.find((c) => c.id === 'divi-button')!;
    button.requiredProperties = [
      { name: 'Type', allowedValues: ['Primary'] },
      { name: 'Show icon', allowedValues: ['false'] },
      { name: 'Label', allowedValues: [] },
      { name: 'Size' },
    ];
    const ok = run([instanceOf('key-button', { name: 'B' }, { variantProperties: { Type: 'Primary', Size: 'M' }, componentProperties: { 'Show icon': false, Label: 'Go' } })], reg);
    expect(ok.issues).toEqual([]);
    const bad = run([instanceOf('key-button', { name: 'B' }, { variantProperties: { Type: 'Primary' }, componentProperties: { 'Show icon': true } })], reg);
    expect(bad.issues.map((i) => [i.code, i.data!.property]).sort()).toEqual([
      ['invalid-property-value', 'Show icon'],
      ['missing-property', 'Label'],
      ['missing-property', 'Size'],
    ]);
    expect(new Set(bad.issues.map((i) => i.id)).size).toBe(3);
  });

  it('does not apply to components without requirements, detached copies, metadata, unknown instances, or (when disabled) nested instances', () => {
    const inner = instanceOf('key-button', { name: 'Inner Button' }, { variantProperties: { Type: 'Ghost' } });
    const blurb = instanceOf('key-blurb', { name: 'Blurb', children: [inner] });
    const roots = [
      node({
        name: 'Page',
        children: [
          instanceOf('key-text', { name: 'Text' }),
          instanceOf('unknown', { name: 'Thing' }, { variantProperties: { Type: 'Ghost' } }),
          instanceOf(null, { name: 'Missing' }),
          node({ name: 'Detached', detachedInfo: { type: 'library', componentKey: 'key-button' } }),
          blurb,
        ],
      }),
    ];
    const config: LintConfig = {
      extends: ['figmakit:recommended'],
      rulesetVersion: '1.0.0',
      rules: { [ID]: ['error', { checkNestedInstances: false }] },
    };
    const out = lint(roots, { rules: [rule], config });
    expect(out.result.issues).toEqual([]);
    expect(out.result.ruleSummaries.find((s) => s.ruleId === ID)!.checks).toBe(0);
    // By default the nested (swapped) Inner Button is checked and its Ghost variant reported.
    expect(run(roots).issues.map((i) => i.nodeName)).toEqual(['Inner Button']);
  });
});
