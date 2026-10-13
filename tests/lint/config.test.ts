import { ALL_RULES as ALL_RULES_FOR_BUNDLE } from '../../src/lint/rules/index';
import { describe, it, expect } from 'vitest';
import type { LintRule } from '../../src/lint/types';
import {
  PRESETS,
  DEFAULT_SETTINGS,
  DEFAULT_READINESS,
  DEFAULT_EXCEPTIONS,
  BUNDLED_CONFIG,
  normalizeSeverity,
  resolveConfig,
  checkRegistryCompatibility,
} from '../../src/lint/config';

function fakeRule(id: string, extra: Partial<LintRule['meta']> = {}): LintRule {
  return {
    meta: { id, description: id, category: 'components', defaultSeverity: 'warning', defaultOptions: {}, fixable: false, ...extra },
    appliesTo: () => false,
    validate: () => [],
  };
}

const RULES = [
  fakeRule('divi/detached-component', { defaultOptions: { minStructuralConfidence: 80, reportStructureOnly: false } }),
  fakeRule('divi/approved-component', {
    defaultSeverity: 'error',
    defaultOptions: { scope: 'governed' },
    validateOptions: (o) => (o.scope === 'governed' || o.scope === 'everywhere' ? [] : ['scope must be governed|everywhere']),
  }),
  fakeRule('custom/z'),
];
const codes = (d: { code: string }[]) => d.map((x) => x.code);

describe('normalizeSeverity', () => {
  it('maps aliases', () => {
    expect(normalizeSeverity('off')).toBe('off');
    expect(normalizeSeverity(0)).toBe('off');
    expect(normalizeSeverity('warn')).toBe('warning');
    expect(normalizeSeverity(1)).toBe('warning');
    expect(normalizeSeverity('warning')).toBe('warning');
    expect(normalizeSeverity(2)).toBe('error');
    expect(normalizeSeverity('error')).toBe('error');
    expect(normalizeSeverity('info')).toBe('info');
    expect(normalizeSeverity('loud' as never)).toBeNull();
    expect(normalizeSeverity(3 as never)).toBeNull();
  });
});

describe('presets & defaults', () => {
  it('defaults match the spec', () => {
    expect(DEFAULT_SETTINGS).toEqual({ includeHidden: false, checkInstanceInternals: false, governTopLevel: false, maxIssuesPerRule: 500 });
    expect(DEFAULT_READINESS).toEqual({ blockingSeverities: ['error'], blockingRules: [], requireApprovedRegistry: true, setDevStatus: false });
    expect(DEFAULT_EXCEPTIONS).toEqual({ enabled: true, nonExemptRules: [], allowedApprovers: [], requireReason: true });
  });
  it('recommended preset severities', () => {
    expect(PRESETS['figmakit:recommended'].rulesetVersion).toBe('1.0.0');
    expect(PRESETS['figmakit:recommended'].rules).toEqual({
      'divi/approved-component': 'error',
      'divi/valid-nesting': 'error',
      'divi/detached-component': 'error',
      'divi/semantic-mapping': 'warning',
      'divi/approved-tokens': 'warning',
      'divi/auto-layout': 'warning',
      'divi/component-naming': 'warning',
      'divi/required-states': 'error',
    });
  });
  it('strict preset', () => {
    const s = PRESETS['figmakit:strict'];
    expect(s.settings).toEqual({ governTopLevel: true });
    const rules = s.rules!;
    expect(Object.keys(rules).length).toBe(8);
    expect(rules['divi/semantic-mapping']).toEqual(['error', { minConfidence: 70 }]);
    expect(rules['divi/detached-component']).toEqual([
      'error',
      { certaintySeverity: { likely: 'error', 'requires-review': 'warning' }, reportStructureOnly: true },
    ]);
    expect(rules['divi/auto-layout']).toBe('error');
  });
  it('BUNDLED_CONFIG comes from figmakit.config.json (locked build, recreated components are errors)', () => {
    expect(BUNDLED_CONFIG).toMatchObject({ adminTools: false, extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', registryVersion: '>=0.1.0 <2.0.0' });
    const { config, diagnostics } = resolveConfig(BUNDLED_CONFIG, ALL_RULES_FOR_BUNDLE);
    expect(diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(config.rules['divi/detached-component'].options.certaintySeverity).toEqual({ confirmed: 'inherit', likely: 'error', 'requires-review': 'info' });
  });
});

describe('resolveConfig', () => {
  it('starts from rule defaults, sorted by id, with missing-ruleset-version warning', () => {
    const { config, diagnostics } = resolveConfig({}, RULES);
    expect(Object.keys(config.rules)).toEqual(['custom/z', 'divi/approved-component', 'divi/detached-component']);
    expect(config.rules['custom/z']).toEqual({ ruleId: 'custom/z', enabled: true, severity: 'warning', options: {} });
    expect(config.rulesetVersion).toBe('0.0.0');
    expect(codes(diagnostics)).toEqual(['missing-ruleset-version']);
    expect(config.settings).toEqual(DEFAULT_SETTINGS);
    expect(config.readiness).toEqual(DEFAULT_READINESS);
    expect(config.exceptions).toEqual(DEFAULT_EXCEPTIONS);
    expect(config.registryVersionRange).toBeNull();
    expect(config.extends).toEqual([]);
  });
  it('applies presets in order then user rules; preset ids not in rules ignored silently', () => {
    const { config, diagnostics } = resolveConfig({ extends: ['figmakit:recommended', 'figmakit:strict'] }, RULES);
    expect(diagnostics).toEqual([]);
    expect(config.extends).toEqual(['figmakit:recommended', 'figmakit:strict']);
    expect(config.rulesetVersion).toBe('1.0.0');
    expect(config.settings.governTopLevel).toBe(true);
    expect(config.rules['divi/detached-component'].options).toEqual({
      minStructuralConfidence: 80,
      reportStructureOnly: true,
      certaintySeverity: { likely: 'error', 'requires-review': 'warning' },
    });
    expect(config.rules['custom/z'].severity).toBe('warning');
  });
  it('user rules override presets; options shallow-merge over accumulated options', () => {
    const { config } = resolveConfig(
      {
        extends: ['figmakit:strict'],
        rules: { 'divi/detached-component': ['warn', { minStructuralConfidence: 90 }], 'custom/z': 'off' },
      },
      RULES,
    );
    const d = config.rules['divi/detached-component'];
    expect(d.severity).toBe('warning');
    expect(d.options).toEqual({
      minStructuralConfidence: 90,
      reportStructureOnly: true,
      certaintySeverity: { likely: 'error', 'requires-review': 'warning' },
    });
    expect(config.rules['custom/z'].enabled).toBe(false);
  });
  it('[severity] tuple form and numeric severities', () => {
    const { config } = resolveConfig({ rules: { 'custom/z': [2], 'divi/approved-component': 1 } }, RULES);
    expect(config.rules['custom/z'].severity).toBe('error');
    expect(config.rules['divi/approved-component'].severity).toBe('warning');
  });
  it('unknown-preset, unknown-rule, invalid-severity (keeps previous)', () => {
    const { config, diagnostics } = resolveConfig(
      { rulesetVersion: '2.0.0', extends: ['nope'], rules: { 'ghost/rule': 'error', 'custom/z': 'loud' as never } },
      RULES,
    );
    expect(codes(diagnostics)).toEqual(['unknown-preset', 'invalid-severity', 'unknown-rule']);
    expect(diagnostics.every((d) => d.level === 'error')).toBe(true);
    expect(config.rules['custom/z'].severity).toBe('warning');
    expect(config.rules['custom/z'].enabled).toBe(true);
    expect(config.rules['ghost/rule']).toBeUndefined();
  });
  it('invalid-options from validateOptions → error and options reset to defaults', () => {
    const { config, diagnostics } = resolveConfig({ rulesetVersion: '1', rules: { 'divi/approved-component': ['error', { scope: 'galaxy' }] } }, RULES);
    expect(codes(diagnostics)).toEqual(['invalid-options']);
    expect(config.rules['divi/approved-component'].options).toEqual({ scope: 'governed' });
  });
  it('validateOptions that throws is reported, not propagated', () => {
    const r = fakeRule('x/throws', { validateOptions: () => { throw new Error('boom'); } });
    const { diagnostics } = resolveConfig({ rulesetVersion: '1' }, [r]);
    expect(codes(diagnostics)).toEqual(['invalid-options']);
  });
  it('non-object options → invalid-options', () => {
    const { diagnostics } = resolveConfig({ rulesetVersion: '1', rules: { 'custom/z': ['error', 'x' as never] } }, RULES);
    expect(codes(diagnostics)).toEqual(['invalid-options']);
  });
  it('merges settings/readiness/exceptions over defaults and validates values', () => {
    const { config, diagnostics } = resolveConfig(
      {
        rulesetVersion: '1.0.0',
        settings: { maxIssuesPerRule: 10, includeHidden: 'yes' as never },
        readiness: { blockingSeverities: ['error', 'warning'], requireApprovedRegistry: false },
        exceptions: { nonExemptRules: ['divi/valid-nesting'], enabled: false },
      },
      RULES,
    );
    expect(config.settings).toEqual({ ...DEFAULT_SETTINGS, maxIssuesPerRule: 10 });
    expect(config.readiness).toEqual({ ...DEFAULT_READINESS, blockingSeverities: ['error', 'warning'], requireApprovedRegistry: false });
    expect(config.exceptions).toEqual({ ...DEFAULT_EXCEPTIONS, nonExemptRules: ['divi/valid-nesting'], enabled: false });
    expect(codes(diagnostics)).toEqual(['invalid-settings']);
  });
  it('registryVersion: valid range kept; invalid → error', () => {
    expect(resolveConfig({ rulesetVersion: '1', registryVersion: '^1.0.0' }, RULES).config.registryVersionRange).toBe('^1.0.0');
    const bad = resolveConfig({ rulesetVersion: '1', registryVersion: 'banana' }, RULES);
    expect(bad.config.registryVersionRange).toBeNull();
    expect(codes(bad.diagnostics)).toEqual(['invalid-registry-range']);
  });
  it('non-object config → invalid-config, defaults used', () => {
    const { config, diagnostics } = resolveConfig(null as never, RULES);
    expect(codes(diagnostics)).toContain('invalid-config');
    expect(config.settings).toEqual(DEFAULT_SETTINGS);
  });
  it('unknown top-level keys → info', () => {
    const { diagnostics } = resolveConfig({ rulesetVersion: '1', foo: 1 } as never, RULES);
    expect(diagnostics).toEqual([{ level: 'info', code: 'unknown-key', message: expect.any(String), path: 'foo' }]);
  });
  it('does not mutate presets or input', () => {
    const before = JSON.stringify(PRESETS);
    const input = { extends: ['figmakit:strict'], rules: { 'divi/detached-component': ['error', { a: 1 }] } } as never;
    const snapshot = JSON.stringify(input);
    resolveConfig(input, RULES);
    expect(JSON.stringify(PRESETS)).toBe(before);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it('bundled config resolves cleanly', () => {
    const { config, diagnostics } = resolveConfig(BUNDLED_CONFIG, RULES);
    expect(diagnostics).toEqual([]);
    expect(config.registryVersionRange).toBe('>=0.1.0 <2.0.0');
  });
});

describe('checkRegistryCompatibility', () => {
  it('no range → no diagnostics', () => {
    expect(checkRegistryCompatibility(resolveConfig({}, []).config, '9.9.9')).toEqual([]);
  });
  it('incompatible-registry when range not satisfied', () => {
    const { config } = resolveConfig(BUNDLED_CONFIG, []);
    expect(checkRegistryCompatibility(config, '0.1.0')).toEqual([]);
    const d = checkRegistryCompatibility(config, '2.0.0');
    expect(d.map((x) => `${x.level}:${x.code}`)).toEqual(['error:incompatible-registry']);
  });
});
