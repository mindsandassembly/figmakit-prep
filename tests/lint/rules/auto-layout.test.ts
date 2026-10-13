import { describe, it, expect } from 'vitest';
import type { DesignNode, LintConfig } from '../../../src/lint/types';
import { rule } from '../../../src/lint/rules/auto-layout';
import { node, instanceOf, lint } from '../helpers';

const ID = 'divi/auto-layout';

function run(roots: DesignNode[], options?: Record<string, unknown>) {
  const config: LintConfig = { extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', rules: options ? { [ID]: ['warning', options] } : {} };
  const out = lint(roots, { rules: [rule], config });
  return { ...out, issues: out.result.issues.filter((i) => i.ruleId === ID) };
}

const btn = (layoutMode: DesignNode['layoutMode'], name = 'Button') =>
  instanceOf('key-button', { name, layoutMode }, { variantProperties: { Type: 'Primary' } });

describe('divi/auto-layout', () => {
  it('meta', () => {
    expect(rule.meta.id).toBe(ID);
    expect(rule.meta.category).toBe('layout');
    expect(rule.meta.fixable).toBe(false);
    expect(rule.meta.validateOptions!({ requireFor: [] })).toEqual([]);
    expect(rule.meta.validateOptions!({ requireFor: 'divi-row' })).toHaveLength(1);
    expect(rule.meta.validateOptions!({ requireFor: [1] })).toHaveLength(1);
  });

  it('passes a component with the required direction', () => {
    const out = run([btn('HORIZONTAL')]);
    expect(out.issues).toEqual([]);
    expect(out.result.ruleSummaries.find((s) => s.ruleId === ID)!.checks).toBe(1);
  });

  it('flags missing auto layout', () => {
    const out = run([btn('NONE')]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].code).toBe('missing-auto-layout');
    expect(out.issues[0].message).toBe('Divi Button requires horizontal Auto Layout.');
    expect(out.issues[0].severity).toBe('warning');
    expect(out.issues[0].fix!.kind).toBe('UNSUPPORTED');
    expect(out.issues[0].fixable).toBe(false);
  });

  it('treats GRID as missing when a direction is required', () => {
    expect(run([btn('GRID')]).issues.map((i) => i.code)).toEqual(['missing-auto-layout']);
  });

  it('flags wrong direction', () => {
    const out = run([btn('VERTICAL')]);
    expect(out.issues.map((i) => i.code)).toEqual(['wrong-direction']);
    expect(out.issues[0].expected).toBe('horizontal');
    expect(out.issues[0].actual).toBe('vertical');
  });

  it('applies to detached copies of a component that requires auto layout', () => {
    const det = node({ name: 'Button', layoutMode: 'NONE', detachedInfo: { type: 'library', componentKey: 'key-button' } });
    expect(run([det]).issues.map((i) => i.code)).toEqual(['missing-auto-layout']);
  });

  it('never requires auto layout on arbitrary or unrequired frames', () => {
    const roots = [
      node({
        name: 'Page',
        children: [
          node({ name: 'Free frame' }),
          node({ name: 'Button' }), // looks like a button but has no registry identity
          instanceOf('key-text', { name: 'Text' }),
          instanceOf('unknown-key', { name: 'Widget' }),
        ],
      }),
    ];
    const out = run(roots);
    expect(out.issues).toEqual([]);
    expect(out.result.ruleSummaries.find((s) => s.ruleId === ID)!.checks).toBe(0);
  });

  it('requireFor adds components without a direction constraint', () => {
    const roots = [
      node({
        name: 'Page',
        children: [instanceOf('key-row', { name: 'Row', layoutMode: 'NONE' }), instanceOf('key-column', { name: 'Col', layoutMode: 'VERTICAL' })],
      }),
    ];
    const out = run(roots, { requireFor: ['divi-row', 'divi-column'] });
    expect(out.issues.map((i) => [i.nodeName, i.code, i.message])).toEqual([['Row', 'missing-auto-layout', 'Divi Row requires Auto Layout.']]);
    // GRID satisfies a direction-less requirement
    const grid = run([instanceOf('key-row', { name: 'Row', layoutMode: 'GRID' })], { requireFor: ['divi-row'] });
    expect(grid.issues).toEqual([]);
  });

  it('skips registered instances nested inside other instances', () => {
    const outer = instanceOf('key-blurb', { name: 'Blurb' });
    outer.children = [btn('NONE', 'Inner Button')];
    expect(run([outer]).issues).toEqual([]);
  });
});
