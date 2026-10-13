import { describe, it, expect } from 'vitest';
import { rule } from '../../../src/lint/rules/semantic-mapping';
import { rule as detachedRule } from '../../../src/lint/rules/detached-component';
import { node, instanceOf, textNode, lint, testRegistry } from '../helpers';
import type { DesignNode, LintConfig } from '../../../src/lint/types';

const RULES = [rule];
const A = (role: string, confidence = 85, source = 'structure') => ({ role: role as any, confidence, source });

function run(roots: DesignNode[], opts: { config?: LintConfig; registry?: unknown; rules?: any[] } = {}) {
  return lint(roots, { rules: opts.rules ?? RULES, config: opts.config, registry: opts.registry }).result.issues;
}

describe('divi/semantic-mapping — boundaries', () => {
  it('reports an explicit boundary label with no registry mapping (confirmed, warning)', () => {
    const issues = run([node({ name: '[fk:card] Promo', fkLabel: 'card' })]);
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i.code).toBe('unmapped-label');
    expect(i.certainty).toBe('confirmed');
    expect(i.severity).toBe('warning');
    expect(i.message).toBe('Labelled as [fk:card] but no approved component mapping.');
    expect(i.fix).toBeUndefined();
    expect(i.suggestion).toMatch(/No approved component maps/);
  });

  it('reports a confident structural boundary as requires-review (info)', () => {
    const issues = run([node({ name: 'Promo', analysis: A('card', 85) })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('unmapped-structure');
    expect(issues[0].certainty).toBe('requires-review');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].message).toContain('heuristic');
  });

  it('ignores name-only, low-confidence, and non-boundary classifications', () => {
    const out = lint(
      [
        node({ name: 'Card', analysis: A('card', 90, 'name') }),
        node({ name: 'Promo', analysis: A('card', 79) }),
        node({ name: 'Frame 1', analysis: A('container', 95) }),
        textNode({ name: 'Heading', fkLabel: 'heading' }),
        textNode({ name: '[fk:text] Body', fkLabel: 'text' }),
        node({ name: '[fk:button] CTA', fkLabel: 'button' }),
      ],
      { rules: RULES },
    );
    expect(out.result.issues).toEqual([]);
    expect(out.result.ruleSummaries[0].checks).toBe(0);
  });

  it('minConfidence and boundaryRoles are configurable', () => {
    const roots = () => [node({ name: 'Promo', analysis: A('card', 72) }), node({ name: 'List', analysis: A('list', 90) })];
    expect(run(roots())).toEqual([]);
    expect(run(roots(), { config: { extends: ['figmakit:strict'] } }).map((i) => i.nodeName)).toEqual(['Promo']);
    const custom = run(roots(), {
      config: { rules: { 'divi/semantic-mapping': ['warning', { boundaryRoles: ['list'] }] } },
    });
    expect(custom.map((i) => i.nodeName)).toEqual(['List']);
  });
});

describe('divi/semantic-mapping — passes', () => {
  it('passes registered nodes (instance, detached, allowed metadata)', () => {
    const roots = [
      instanceOf('key-section', { name: 'Section', analysis: A('section', 95) }),
      node({ name: 'S2', fkLabel: 'section', detachedInfo: { type: 'library', componentKey: 'key-section' } }),
      node({ name: 'Feature', fkLabel: 'feature', standardsMeta: { componentId: 'divi-blurb' } }),
    ];
    expect(run(roots)).toEqual([]);
  });

  it('leaves recreation candidates and detaches to divi/detached-component (no double reports)', () => {
    const roots = () => [
      node({ name: 'Row', analysis: A('row', 90) }), // name candidate
      node({ name: 'Frame 5', fkLabel: 'section' }), // label candidate
      node({ name: 'Frame 6', analysis: A('card', 90), detachedInfo: { type: 'library', componentKey: 'zzz' } }),
    ];
    expect(run(roots())).toEqual([]);
    const both = run(roots(), { rules: [rule, detachedRule] });
    expect(both.map((i) => [i.nodeName, i.ruleId])).toEqual([
      ['Row', 'divi/detached-component'],
      ['Frame 5', 'divi/detached-component'],
      ['Frame 6', 'divi/detached-component'],
    ]);
  });

  it('passes legitimate custom compositions built from approved components', () => {
    const roots = [
      node({
        name: 'Pricing Card',
        fkLabel: 'card',
        children: [node({ name: 'Inner', children: [instanceOf('key-button', { name: 'Button' })] }), instanceOf('key-text', { name: 'Copy' })],
      }),
      node({ name: 'Promo', analysis: A('card', 90), children: [instanceOf('key-image', { name: 'Img' })] }),
    ];
    expect(run(roots)).toEqual([]);
  });

  it('skips layers inside instances and component definitions', () => {
    const roots = [
      instanceOf('foreign', { name: 'Card instance', children: [node({ name: 'Inner', fkLabel: 'card' })] }),
      node({ name: 'Card', type: 'COMPONENT', fkLabel: 'card' }),
      instanceOf('foreign', { name: 'Unapproved card', fkLabel: 'card' }),
    ];
    const out = lint(roots, { rules: RULES });
    expect(out.result.issues).toEqual([]);
    expect(out.result.ruleSummaries[0].checks).toBe(0);
  });
});

describe('divi/semantic-mapping — fixes', () => {
  it('single metadata-mappable candidate → REQUIRES_CONFIRMATION setPluginData', () => {
    // Structure-only for detached-component (not reported by default) → semantic-mapping reports with a fix.
    const roots = [node({ name: 'Frame 7', analysis: A('feature', 88), structural: A('feature', 88) })];
    const issues = run(roots);
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i.code).toBe('unmapped-structure');
    expect(i.fix!.kind).toBe('REQUIRES_CONFIRMATION');
    expect(i.fixable).toBe(true);
    expect(i.fix!.operations).toEqual([
      { op: 'setPluginData', nodeId: i.nodeId, key: 'fk-standards-component', from: '', to: 'divi-blurb' },
    ]);
    // With strict (reportStructureOnly) detached-component owns it instead.
    const strict = run(roots, { config: { extends: ['figmakit:strict'] }, rules: [rule, detachedRule] });
    expect(strict.map((x) => [x.ruleId, x.code])).toEqual([['divi/detached-component', 'recreated-component']]);
  });

  it('carries the current declared id as the stale-check "from" value', () => {
    const roots = [node({ name: 'Frame 7', analysis: A('feature', 88), standardsMeta: { componentId: 'divi-button' } })];
    const issues = run(roots);
    expect(issues[0].fix!.operations[0]).toMatchObject({ from: 'divi-button', to: 'divi-blurb' });
  });

  it('single instance-only candidate → UNSUPPORTED replace suggestion', () => {
    const issues = run([node({ name: 'Frame 8', analysis: A('row', 90) })]);
    expect(issues[0].fix!.kind).toBe('UNSUPPORTED');
    expect(issues[0].suggestion).toBe('Replace with an instance of Divi Row.');
    expect(issues[0].fixable).toBe(false);
  });

  it('multiple candidates → UNSUPPORTED ambiguous', () => {
    const reg = testRegistry();
    reg.components.push({
      id: 'divi-cta',
      name: 'Divi CTA',
      diviType: 'et_pb_cta',
      figmaComponentKeys: ['key-cta'],
      allowMetadataMapping: true,
      match: { roles: ['feature'] },
    });
    const issues = run([node({ name: 'Frame 9', analysis: A('feature', 90) })], { registry: reg });
    expect(issues[0].fix!.kind).toBe('UNSUPPORTED');
    expect(issues[0].suggestion).toBe('Ambiguous: Divi Blurb or Divi CTA. Replace with the right approved component.');
  });
});

describe('divi/semantic-mapping — stampApprovedInstances', () => {
  const cfg: LintConfig = { rules: { 'divi/semantic-mapping': ['warning', { stampApprovedInstances: true }] } };

  it('is off by default', () => {
    const out = lint([instanceOf('key-button', { name: 'Button' })], { rules: RULES });
    expect(out.result.ruleSummaries[0].checks).toBe(0);
  });

  it('reports approved instances missing fk-divi-type with a SAFE fix', () => {
    const roots = [
      instanceOf('key-button', { name: 'Button' }),
      instanceOf('key-text', { name: 'Text', standardsMeta: { componentId: null, diviType: 'et_pb_text' } }),
      instanceOf('key-image', { name: 'Img', standardsMeta: { componentId: null, diviType: 'wrong' } }),
      instanceOf('foreign', { name: 'Other' }),
    ];
    const issues = run(roots, { config: cfg });
    expect(issues.map((i) => [i.nodeName, i.code, i.severity])).toEqual([
      ['Button', 'missing-divi-metadata', 'info'],
      ['Img', 'missing-divi-metadata', 'info'],
    ]);
    expect(issues[0].fix).toEqual({
      kind: 'SAFE',
      description: 'Set fk-divi-type = "et_pb_button"',
      operations: [{ op: 'setPluginData', nodeId: issues[0].nodeId, key: 'fk-divi-type', from: '', to: 'et_pb_button' }],
    });
    expect(issues[1].fix!.operations[0]).toMatchObject({ from: 'wrong', to: 'et_pb_image' });
  });

  it('skips components without a diviType', () => {
    const reg = testRegistry();
    reg.components.find((c) => c.id === 'divi-button')!.diviType = null;
    expect(run([instanceOf('key-button', { name: 'Button' })], { config: cfg, registry: reg })).toEqual([]);
  });
});

describe('divi/semantic-mapping — options', () => {
  it('validates options', () => {
    const v = rule.meta.validateOptions!;
    expect(v(rule.meta.defaultOptions)).toEqual([]);
    expect(v({ boundaryRoles: ['nope'] })).toHaveLength(1);
    expect(v({ boundaryRoles: 'card' })).toHaveLength(1);
    expect(v({ minConfidence: -1 })).toHaveLength(1);
    expect(v({ stampApprovedInstances: 1 })).toHaveLength(1);
  });

  it('is deterministic', () => {
    const build = () => [node({ name: 'A', fkLabel: 'card' }), node({ name: 'B', analysis: A('hero', 90) })];
    expect(JSON.stringify(run(build()))).toBe(JSON.stringify(run(build())));
  });
});
