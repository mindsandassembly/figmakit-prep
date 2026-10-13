import { describe, it, expect } from 'vitest';
import { rule, getRecreationCandidates } from '../../../src/lint/rules/detached-component';
import { node, instanceOf, textNode, lint, makeContext, byName } from '../helpers';
import type { DesignNode, LintConfig } from '../../../src/lint/types';

const RULES = [rule];
const STRUCT = (role: string, confidence = 90) => ({ role: role as any, confidence, source: 'structure' });

function run(roots: DesignNode[], config?: LintConfig) {
  return lint(roots, { rules: RULES, config }).result.issues;
}

describe('divi/detached-component — confirmed detaches', () => {
  it('reports a library detach of an approved component', () => {
    const issues = run([node({ name: 'Button', detachedInfo: { type: 'library', componentKey: 'key-button' } })]);
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i.code).toBe('detached-approved');
    expect(i.certainty).toBe('confirmed');
    expect(i.severity).toBe('error');
    expect(i.message).toBe('Detached from approved component Divi Button.');
    expect(i.suggestion).toBe('Replace with an instance of Divi Button (re-insert from the library).');
    expect(i.fix!.kind).toBe('UNSUPPORTED');
    expect(i.fix!.operations).toEqual([]);
    expect(i.fixable).toBe(false);
    expect(i.blocking).toBe(true);
  });

  it('matches a library variant detach against a registry keyed by component-set key', () => {
    // detachedInfo.componentKey is the VARIANT key; the registry lists only the set key.
    const issues = run([
      node({ name: 'Button', detachedInfo: { type: 'library', componentKey: 'variant-primary-key', resolvedComponentSetKey: 'key-button' } }),
    ]);
    expect(issues.map((i) => `${i.code}:${i.certainty}:${i.severity}`)).toEqual(['detached-approved:confirmed:error']);
    expect(issues[0].blocking).toBe(true);
  });

  it('resolves local detaches by variant key or component-set key', () => {
    const issues = run([
      node({ name: 'A', detachedInfo: { type: 'local', componentId: '1:1', resolvedKey: 'key-row', resolvedComponentSetKey: null } }),
      node({ name: 'B', detachedInfo: { type: 'local', componentId: '1:2', resolvedKey: 'v9', resolvedComponentSetKey: 'set-button' } }),
    ]);
    expect(issues.map((i) => [i.nodeName, i.code, i.data!.componentId])).toEqual([
      ['A', 'detached-approved', 'divi-row'],
      ['B', 'detached-approved', 'divi-button'],
    ]);
  });

  it('reports unregistered detaches as info, or not at all when disabled', () => {
    const roots = () => [
      node({ name: 'Card', detachedInfo: { type: 'local', componentId: '9:9', resolvedKey: null, resolvedComponentSetKey: null } }),
    ];
    const issues = run(roots());
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('detached-unregistered');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].blocking).toBe(false);
    const off = run(roots(), {
      extends: ['figmakit:recommended'],
      rules: { 'divi/detached-component': ['error', { reportUnregisteredDetached: false }] },
    });
    expect(off).toEqual([]);
  });

  it('detachedInfo wins over heuristics', () => {
    const issues = run([
      node({ name: 'Button', fkLabel: 'button', structural: STRUCT('button'), detachedInfo: { type: 'library', componentKey: 'nope' } }),
    ]);
    expect(issues.map((i) => i.code)).toEqual(['detached-unregistered']);
  });
});

describe('divi/detached-component — heuristic recreation', () => {
  it('name + structure → likely (warning by default)', () => {
    const issues = run([node({ name: 'Button', layoutMode: 'HORIZONTAL', structural: STRUCT('button') })]);
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i.code).toBe('recreated-component');
    expect(i.certainty).toBe('likely');
    expect(i.severity).toBe('warning');
    expect(i.message).toBe('Looks like a manually recreated Divi Button (heuristic; evidence: name, structure).');
    expect(i.data!.evidence).toEqual(['name', 'structure']);
    expect(i.fix!.kind).toBe('UNSUPPORTED');
  });

  it('a single name or label signal → requires-review (info by default)', () => {
    const issues = run([node({ name: 'btn' }), node({ name: 'Frame 9', fkLabel: 'button' })]);
    expect(issues.map((i) => [i.nodeName, i.certainty, i.severity, i.data!.evidence])).toEqual([
      ['btn', 'requires-review', 'info', ['name']],
      ['Frame 9', 'requires-review', 'info', ['label']],
    ]);
    expect(issues.every((i) => i.message.includes('heuristic'))).toBe(true);
  });

  it('structure-only is reported only with reportStructureOnly', () => {
    const roots = () => [node({ name: 'Frame 4', structural: STRUCT('button') })];
    expect(run(roots())).toEqual([]);
    const strict = run(roots(), { extends: ['figmakit:strict'] });
    expect(strict).toHaveLength(1);
    expect(strict[0].certainty).toBe('requires-review');
    expect(strict[0].severity).toBe('warning'); // strict maps requires-review → warning
  });

  it('strict preset makes likely recreations errors', () => {
    const issues = run([node({ name: 'Button', structural: STRUCT('button') })], { extends: ['figmakit:strict'] });
    expect(issues[0].severity).toBe('error');
  });

  it('structural confidence below the threshold is not a signal', () => {
    const issues = run([node({ name: 'Button', structural: STRUCT('button', 70) })]);
    expect(issues[0].certainty).toBe('requires-review');
    expect(issues[0].data!.evidence).toEqual(['name']);
    const lowered = run([node({ name: 'Button', structural: STRUCT('button', 70) })], {
      extends: ['figmakit:recommended'],
      rules: { 'divi/detached-component': ['error', { minStructuralConfidence: 60 }] },
    });
    expect(lowered[0].certainty).toBe('likely');
  });

  it('orders candidates by signal count, then id', () => {
    const roots = [node({ name: 'Button', fkLabel: 'button', structural: STRUCT('image') })];
    const ctx = makeContext(roots, { rules: RULES, ruleId: 'divi/detached-component' });
    const c = getRecreationCandidates(byName(roots, 'Button'), ctx, {});
    expect(c.map((x) => [x.component.id, x.signals, x.certainty])).toEqual([
      ['divi-button', ['name', 'label'], 'likely'],
      // structure-only image candidate excluded (reportStructureOnly false)
    ]);
    const c2 = getRecreationCandidates(byName(roots, 'Button'), ctx, { reportStructureOnly: true });
    expect(c2.map((x) => x.component.id)).toEqual(['divi-button', 'divi-image']);
  });

  it('skips a layer that legitimately declares the component via metadata', () => {
    const issues = run([node({ name: 'Blurb', fkLabel: 'feature', standardsMeta: { componentId: 'divi-blurb' } })]);
    expect(issues).toEqual([]);
  });

  it('skips compositions containing registered components unless the name matches', () => {
    // Custom feature card built from approved parts: label + structure only → composition, not a recreation.
    const comp = run([
      node({
        name: 'Feature Card',
        fkLabel: 'feature',
        structural: STRUCT('feature'),
        children: [instanceOf('key-image', { name: 'Img' }), instanceOf('key-text', { name: 'Copy' })],
      }),
    ]);
    expect(comp).toEqual([]);
    // A frame *named* Section that contains approved rows is still flagged (name signal).
    const named = run([node({ name: 'Section', children: [instanceOf('key-row', { name: 'Row' })] })]);
    expect(named.map((i) => i.code)).toEqual(['recreated-component']);
  });

  it('reports the strongest candidate with alternatives', () => {
    const issues = run([node({ name: 'Image', fkLabel: 'button' })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].data).toMatchObject({ componentId: 'divi-button', alternatives: ['divi-image'] });
  });
});

describe('divi/detached-component — no false positives', () => {
  it('ignores ordinary internal / wrapper layers', () => {
    const roots = [
      node({
        name: 'Hero',
        layoutMode: 'VERTICAL',
        structural: STRUCT('hero'),
        children: [
          node({ name: 'Frame 12', layoutMode: 'HORIZONTAL', structural: STRUCT('container') }),
          node({ name: 'Content', structural: STRUCT('flex-col') }),
          node({ name: 'Wrapper' }),
          node({ name: 'Background', type: 'RECTANGLE' }),
          textNode({ name: 'Text' }),
          node({ name: 'Image', type: 'RECTANGLE' }),
          node({ name: 'Group 3', type: 'GROUP' }),
        ],
      }),
    ];
    expect(run(roots)).toEqual([]);
  });

  it('never inspects instances, component definitions, or layers inside instances', () => {
    const roots = [
      instanceOf('foreign', { name: 'Button', structural: STRUCT('button') }),
      node({ name: 'Button', type: 'COMPONENT', structural: STRUCT('button') }),
      node({ name: 'Buttons', type: 'COMPONENT_SET', children: [node({ name: 'Button', type: 'COMPONENT' })] }),
      instanceOf('key-blurb', {
        name: 'Blurb',
        children: [node({ name: 'Button', structural: STRUCT('button'), detachedInfo: { type: 'library', componentKey: 'key-button' } })],
      }),
    ];
    const out = lint(roots, { rules: RULES });
    expect(out.result.issues).toEqual([]);
    expect(out.result.ruleSummaries[0].checks).toBe(0);
  });

  it('checks layers inside instances when checkInstanceInternals is on', () => {
    const roots = [instanceOf('key-blurb', { name: 'Blurb', children: [node({ name: 'Button' })] })];
    const issues = run(roots, { extends: ['figmakit:recommended'], settings: { checkInstanceInternals: true } });
    expect(issues.map((i) => i.code)).toEqual(['recreated-component']);
  });

  it('is silent when the registry has no match hints', () => {
    const roots = [node({ name: 'Button', fkLabel: 'button', structural: STRUCT('button') })];
    const out = lint(roots, {
      rules: RULES,
      registry: { version: '1.0.0', designSystem: 'X', status: 'approved', components: [{ id: 'a', name: 'A', diviType: null, figmaComponentKeys: ['k'] }] },
    });
    expect(out.result.issues).toEqual([]);
  });
});

describe('divi/detached-component — options', () => {
  it('validates options', () => {
    const v = rule.meta.validateOptions!;
    expect(v(rule.meta.defaultOptions)).toEqual([]);
    expect(v({ minStructuralConfidence: 200 })).toHaveLength(1);
    expect(v({ reportStructureOnly: 'yes' })).toHaveLength(1);
    expect(v({ certaintySeverity: { maybe: 'error' } })).toHaveLength(1);
    expect(v({ certaintySeverity: { likely: 'fatal' } })).toHaveLength(1);
    expect(v({ certaintySeverity: 'x' })).toHaveLength(1);
  });

  it('is deterministic', () => {
    const build = () => [node({ name: 'Button', structural: STRUCT('button') }), node({ name: 'Row' })];
    expect(JSON.stringify(run(build()))).toBe(JSON.stringify(run(build())));
  });
});
