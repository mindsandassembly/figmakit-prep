import { describe, it, expect } from 'vitest';
import { rule } from '../../../src/lint/rules/approved-component';
import { node, instanceOf, lint, testRegistry, makeContext, byName } from '../helpers';
import type { DesignNode, LintConfig } from '../../../src/lint/types';
import bundled from '../../../src/standards/registry.json';

const RULES = [rule];

/** A governed column (confirmed detached copy of the approved column). */
function column(children: DesignNode[]): DesignNode {
  return node({
    name: 'Column',
    detachedInfo: { type: 'library', componentKey: 'key-column' },
    children,
  });
}

function run(roots: DesignNode[], config?: LintConfig, registry?: unknown) {
  return lint(roots, { rules: RULES, config, registry }).result.issues;
}

describe('divi/approved-component', () => {
  it('passes approved instances (component key and component-set key)', () => {
    const roots = [
      column([
        instanceOf('key-button', { name: 'Button' }),
        instanceOf('variant-123', { name: 'Button Variant' }, { setKey: 'set-button' }),
      ]),
    ];
    const out = lint(roots, { rules: RULES });
    expect(out.result.issues).toEqual([]);
    expect(out.result.ruleSummaries[0].checks).toBe(2);
    expect(out.result.ruleSummaries[0].passedChecks).toBe(2);
  });

  it('flags unapproved instances in a governed context with a name-based suggestion', () => {
    const issues = run([column([instanceOf('foreign-key', { name: 'My Button' }, { componentName: 'Button' })])]);
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i.code).toBe('unapproved-instance');
    expect(i.severity).toBe('error');
    expect(i.certainty).toBe('confirmed');
    expect(i.message).toBe('"Button" is not an approved component.');
    expect(i.suggestion).toBe('Use approved Divi Button component.');
    expect(i.fixable).toBe(false);
    expect(i.data).toMatchObject({ componentKey: 'foreign-key', suggestedComponentId: 'divi-button' });
  });

  it('prefers the component-set name for messages and suggestions', () => {
    const issues = run([
      column([
        instanceOf('v1', { name: 'X' }, { componentName: 'Size=Large', setKey: 'foreign-set', setName: 'Btn' }),
      ]),
    ]);
    expect(issues[0].message).toContain('"Btn"');
    expect(issues[0].suggestion).toBe('Use approved Divi Button component.');
  });

  it('falls back to role-based suggestions, then a generic suggestion', () => {
    const byRole = run([
      column([
        instanceOf('foreign', { name: 'Thing', structural: { role: 'image', confidence: 90, source: 'type' } }, { componentName: 'Thing' }),
      ]),
    ]);
    expect(byRole[0].suggestion).toBe('Use approved Divi Image component.');
    const none = run([column([instanceOf('foreign', { name: 'Widget' }, { componentName: 'Widget' })])]);
    expect(none[0].suggestion).toMatch(/add this component to the registry/);
  });

  it('does not flag unapproved instances outside a governed context by default', () => {
    expect(run([instanceOf('foreign', { name: 'Logo' })])).toEqual([]);
    expect(run([node({ name: 'Custom frame', children: [instanceOf('foreign', { name: 'Logo' })] })])).toEqual([]);
  });

  it('governTopLevel and scope "everywhere" widen coverage', () => {
    const top = () => [node({ name: 'Page', children: [instanceOf('foreign', { name: 'Logo' })] })];
    expect(run(top(), { extends: ['figmakit:recommended'], settings: { governTopLevel: true } })).toHaveLength(1);
    expect(run(top(), { extends: ['figmakit:strict'] })).toHaveLength(1);
    expect(
      run(top(), { extends: ['figmakit:recommended'], rules: { 'divi/approved-component': ['error', { scope: 'everywhere' }] } }),
    ).toHaveLength(1);
  });

  it('does not govern below a registered ancestor that does not govern children', () => {
    // divi-blurb has no governsChildren; declared via metadata on a frame.
    const roots = [
      node({
        name: 'Feature',
        standardsMeta: { componentId: 'divi-blurb' },
        children: [instanceOf('foreign', { name: 'Icon' })],
      }),
    ];
    expect(run(roots, { extends: ['figmakit:strict'] })).toEqual([]);
  });

  it('checks nested instances inside instances, but only flags them in governed contexts', () => {
    const roots = () => [
      column([instanceOf('key-blurb', { name: 'Blurb', children: [instanceOf('foreign-icon', { name: 'Icon' })] })]),
    ];
    const out = lint(roots(), { rules: RULES });
    // Blurb does not govern its children, so the nested icon instance is checked but not flagged.
    expect(out.result.issues).toEqual([]);
    expect(out.result.ruleSummaries[0].checks).toBe(2);
    const deep = run(roots(), { extends: ['figmakit:recommended'], settings: { checkInstanceInternals: true } });
    // Blurb does not govern children, so even when internals are visible nothing is flagged.
    expect(deep).toEqual([]);
  });

  it('honors allowedComponentKeys (component and set keys) and ignoreComponentNamePatterns', () => {
    const roots = () => [
      column([
        instanceOf('icon-1', { name: 'Icon A' }, { componentName: 'Icon/Arrow' }),
        instanceOf('v', { name: 'Logo' }, { componentName: 'Logo', setKey: 'logo-set' }),
        instanceOf('other', { name: 'Other' }, { componentName: 'Other' }),
      ]),
    ];
    const issues = run(roots(), {
      extends: ['figmakit:recommended'],
      rules: {
        'divi/approved-component': ['error', { allowedComponentKeys: ['logo-set'], ignoreComponentNamePatterns: ['^icon/'] }],
      },
    });
    expect(issues.map((i) => i.nodeName)).toEqual(['Other']);
  });

  it('reports unresolved main components as requires-review (info by default)', () => {
    const issues = run([instanceOf(null, { name: 'Ghost' })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('unresolved-main-component');
    expect(issues[0].certainty).toBe('requires-review');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].blocking).toBe(false);
  });

  it('reports deprecated components with the replacement', () => {
    const reg = testRegistry();
    reg.components.push({
      id: 'divi-old-button',
      name: 'Old Button',
      diviType: null,
      figmaComponentKeys: ['key-old-button'],
      deprecated: { replacedBy: 'divi-button', message: 'Use the new button.' },
    });
    const issues = run([column([instanceOf('key-old-button', { name: 'Old' })])], undefined, reg);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('deprecated-component');
    expect(issues[0].message).toBe('Old Button is deprecated. Use the new button.');
    expect(issues[0].suggestion).toBe('Use approved Divi Button component.');
    expect(issues[0].severity).toBe('error');
  });

  it('standards metadata never approves an instance', () => {
    const roots = [
      column([instanceOf('foreign', { name: 'Fake blurb', standardsMeta: { componentId: 'divi-blurb' } })]),
    ];
    const issues = run(roots);
    expect(issues.map((i) => i.code)).toEqual(['unapproved-instance']);
  });

  it('ignores non-instance nodes', () => {
    const roots = [column([node({ name: 'Button' }), node({ name: 'Frame 12' })])];
    const out = lint(roots, { rules: RULES });
    expect(out.result.issues).toEqual([]);
    expect(out.result.ruleSummaries[0].checks).toBe(0);
  });

  it('is silent against the bundled draft registry when nothing is governed', () => {
    expect(run([node({ name: 'Page', children: [instanceOf('k', { name: 'Button' })] })], undefined, bundled)).toEqual([]);
  });

  it('is deterministic', () => {
    const build = () => [column([instanceOf('a', { name: 'A' }), instanceOf('b', { name: 'B' })])];
    expect(JSON.stringify(run(build()))).toBe(JSON.stringify(run(build())));
  });

  it('validates options', () => {
    const v = rule.meta.validateOptions!;
    expect(v(rule.meta.defaultOptions)).toEqual([]);
    expect(v({ scope: 'nowhere' })).toHaveLength(1);
    expect(v({ allowedComponentKeys: 'x' })).toHaveLength(1);
    expect(v({ ignoreComponentNamePatterns: ['('] })).toHaveLength(1);
    const out = lint([node({ name: 'x' })], {
      rules: RULES,
      config: { rules: { 'divi/approved-component': ['error', { scope: 'bad' }] } },
    });
    expect(out.configDiagnostics.some((d) => d.code === 'invalid-options')).toBe(true);
  });

  it('works directly against a context', () => {
    const roots = [column([instanceOf('foreign', { name: 'Thing' })])];
    const ctx = makeContext(roots, { rules: RULES, ruleId: 'divi/approved-component' });
    const n = byName(roots, 'Thing');
    expect(rule.appliesTo(n, ctx)).toBe(true);
    expect(rule.validate(n, ctx)[0].code).toBe('unapproved-instance');
  });
});
