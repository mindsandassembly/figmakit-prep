import { describe, it, expect } from 'vitest';
import type { LintRule, LintConfig, RuleReport, LintIssue } from '../../src/lint/types';
import { INTERNAL_ERROR_RULE_ID } from '../../src/lint/types';
import { isBlocking, evaluateReadiness } from '../../src/lint/readiness';
import { DEFAULT_READINESS, resolveConfig } from '../../src/lint/config';
import { createException } from '../../src/lint/exceptions';
import bundledRegistry from '../../src/standards/registry.json';
import { node, finalize, lint, byName, testRegistry, TEST_NOW } from './helpers';

function rule(id: string, validate: (name: string) => RuleReport[], severity: 'error' | 'warning' = 'error'): LintRule {
  return {
    meta: { id, description: id, category: 'structure', defaultSeverity: severity, defaultOptions: {}, fixable: false },
    appliesTo: () => true,
    validate: (n) => validate(n.name),
  };
}
const errOnBad = rule('test/err', (n) => (n === 'Bad' ? [{ code: 'bad', message: 'bad layer' }] : []));
const warnOnMeh = rule('test/warn', (n) => (n === 'Meh' ? [{ code: 'meh', message: 'meh layer' }] : []), 'warning');
const cfg = (c: LintConfig = {}): LintConfig => ({ rulesetVersion: '1.0.0', ...c });
const tree = (...names: string[]) => finalize([node({ name: 'Root', children: names.map((name) => node({ name })) })]);
const exFor = (ruleId: string, nodeId: string, extra: Partial<Parameters<typeof createException>[0]> = {}) =>
  createException({ ruleId, nodeId, reason: 'Approved by lead', approvedBy: { id: 'u1', name: 'Lead' }, createdAt: TEST_NOW, ...extra });

describe('isBlocking', () => {
  it('severity in blockingSeverities', () => {
    expect(isBlocking({ ruleId: 'r', severity: 'error' }, DEFAULT_READINESS)).toBe(true);
    expect(isBlocking({ ruleId: 'r', severity: 'warning' }, DEFAULT_READINESS)).toBe(false);
  });
  it('blockingRules block non-info severities', () => {
    const p = { ...DEFAULT_READINESS, blockingRules: ['r'] };
    expect(isBlocking({ ruleId: 'r', severity: 'warning' }, p)).toBe(true);
    expect(isBlocking({ ruleId: 'r', severity: 'info' }, p)).toBe(false);
    expect(isBlocking({ ruleId: 'r', severity: 'info' }, { ...p, blockingSeverities: ['info'] })).toBe(true);
  });
  it('internal errors always block', () => {
    expect(isBlocking({ ruleId: INTERNAL_ERROR_RULE_ID, severity: 'info' }, { ...DEFAULT_READINESS, blockingSeverities: [] })).toBe(true);
  });
});

describe('evaluateReadiness', () => {
  it('clean run → READY', () => {
    const { readiness } = lint(tree('Fine'), { rules: [errOnBad], config: cfg() });
    expect(readiness).toMatchObject({ ready: true, status: 'READY', reasons: [], blockingIssues: [], exceptedIssues: [], rulesetVersion: '1.0.0', registryVersion: '1.0.0' });
  });
  it('Scenario G: blocking errors deny readiness', () => {
    const { readiness } = lint(tree('Bad', 'Fine'), { rules: [errOnBad], config: cfg() });
    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe('NOT_READY');
    expect(readiness.blockingIssues.map((i) => i.code)).toEqual(['bad']);
    expect(readiness.reasons).toEqual(['1 blocking issue must be fixed or excepted.']);
  });
  it('Scenario H: exception covering the only blocking issue → READY_WITH_EXCEPTIONS', () => {
    const roots = tree('Bad', 'Fine');
    const { readiness } = lint(roots, { rules: [errOnBad], config: cfg(), exceptions: [exFor('test/err', byName(roots, 'Bad').id)] });
    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe('READY_WITH_EXCEPTIONS');
    expect(readiness.exceptedIssues.map((i) => i.code)).toEqual(['bad']);
    expect(readiness.blockingIssues).toEqual([]);
  });
  it('exception for a non-exempt rule is ignored', () => {
    const roots = tree('Bad');
    const { readiness } = lint(roots, {
      rules: [errOnBad],
      config: cfg({ exceptions: { nonExemptRules: ['test/err'] } }),
      exceptions: [exFor('test/err', byName(roots, 'Bad').id)],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.exceptedIssues).toEqual([]);
  });
  it('policy.enabled=false ignores exceptions (even if attached)', () => {
    const roots = tree('Bad');
    const { result, readiness } = lint(roots, {
      rules: [errOnBad],
      config: cfg({ exceptions: { enabled: false } }),
      exceptions: [exFor('test/err', byName(roots, 'Bad').id)],
    });
    expect(readiness.ready).toBe(false);
    // Force-attach to prove readiness re-checks the policy.
    const forced = { ...result, issues: result.issues.map((i) => ({ ...i, exception: exFor('test/err', i.nodeId) })) };
    const { config } = resolveConfig(cfg({ exceptions: { enabled: false } }), [errOnBad]);
    const r2 = evaluateReadiness({ result: forced, config, registry: null });
    expect(r2.exceptedIssues).toEqual([]);
    expect(r2.blockingIssues.length).toBe(1);
  });
  it('expired exceptions are ignored', () => {
    const roots = tree('Bad');
    const { readiness } = lint(roots, {
      rules: [errOnBad],
      config: cfg(),
      exceptions: [exFor('test/err', byName(roots, 'Bad').id, { createdAt: '2025-01-01T00:00:00Z', expiresAt: '2025-12-31T00:00:00Z' })],
    });
    expect(readiness.ready).toBe(false);
  });
  it('draft registry blocks when requireApprovedRegistry; allowed when disabled', () => {
    const draft = { ...testRegistry(), status: 'draft' as const };
    const a = lint(tree('Fine'), { rules: [errOnBad], config: cfg(), registry: draft });
    expect(a.readiness.ready).toBe(false);
    expect(a.readiness.reasons[0]).toMatch(/draft/);
    const b = lint(tree('Fine'), { rules: [errOnBad], config: cfg({ readiness: { requireApprovedRegistry: false } }), registry: draft });
    expect(b.readiness.ready).toBe(true);
  });
  it('bundled draft registry with placeholder keys blocks', () => {
    const { readiness } = lint(tree('Fine'), { rules: [errOnBad], config: cfg(), registry: bundledRegistry });
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      'Component registry Divi 5 v0.1.0 is a draft; an approved registry is required.',
      'Component registry has 8 placeholder component keys.',
    ]);
  });
  it('approved registry that still has placeholder keys blocks', () => {
    const reg = testRegistry();
    reg.components[0].figmaComponentKeys.push('REPLACE_ME');
    const { readiness } = lint(tree('Fine'), { rules: [errOnBad], config: cfg(), registry: reg });
    expect(readiness.reasons).toEqual(['Component registry has 1 placeholder component key.']);
  });
  it('config errors block', () => {
    const { readiness } = lint(tree('Fine'), { rules: [errOnBad], config: cfg({ extends: ['nope'] }) });
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons[0]).toMatch(/Configuration has 1 error: unknown-preset/);
  });
  it('incompatible registry version blocks (via config diagnostics)', () => {
    const { readiness } = lint(tree('Fine'), { rules: [errOnBad], config: cfg({ registryVersion: '^2.0.0' }) });
    expect(readiness.reasons[0]).toMatch(/incompatible-registry/);
  });
  it('invalid registry (null index) blocks', () => {
    const { readiness, registry } = lint(tree('Fine'), { rules: [errOnBad], config: cfg(), registry: { nope: true } });
    expect(registry).toBeNull();
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain('Component registry could not be loaded.');
  });
  it('zero nodes blocks', () => {
    const { readiness } = lint([], { rules: [errOnBad], config: cfg() });
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual(['Nothing was validated (no layers in scope).']);
  });
  it('warnings never block by default', () => {
    const { readiness } = lint(tree('Meh', 'Meh'), { rules: [warnOnMeh], config: cfg() });
    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe('READY');
    expect(readiness.warnings.length).toBe(2);
  });
  it('warnings block when severity listed in blockingSeverities', () => {
    const { readiness } = lint(tree('Meh'), { rules: [warnOnMeh], config: cfg({ readiness: { blockingSeverities: ['error', 'warning'] } }) });
    expect(readiness.ready).toBe(false);
    expect(readiness.warnings).toEqual([]);
  });
  it('reasons are deterministic and ordered', () => {
    const run = () => lint([], { rules: [errOnBad], config: cfg({ extends: ['nope'] }), registry: { ...testRegistry(), status: 'draft' } }).readiness.reasons;
    expect(run()).toEqual(run());
    expect(run().length).toBe(3);
  });
  it('a crashed rule blocks even with zero internal error issues materialized', () => {
    const { result, config } = lint(tree('Fine'), { rules: [errOnBad], config: cfg() });
    const crashed = { ...result, ruleSummaries: result.ruleSummaries.map((s) => ({ ...s, status: 'crashed' as const })) };
    const r = evaluateReadiness({ result: crashed, config, registry: null });
    expect(r.ready).toBe(false);
    expect(r.reasons.some((x) => x.includes('crashed: test/err'))).toBe(true);
  });
  it('internal error with an exception attached still blocks', () => {
    const { result, config } = lint(tree('Fine'), { rules: [errOnBad], config: cfg() });
    const fake: LintIssue = {
      id: 'fk-x', ruleId: INTERNAL_ERROR_RULE_ID, code: 'rule-crashed', nodeId: 'n1', nodeName: 'Root', nodePath: 'Root',
      severity: 'error', certainty: 'confirmed', message: 'm', fixable: false, blocking: true,
      exception: exFor(INTERNAL_ERROR_RULE_ID, 'n1'),
    };
    const r = evaluateReadiness({ result: { ...result, issues: [fake], internalErrors: [fake] }, config, registry: null });
    expect(r.blockingIssues).toEqual([fake]);
    expect(r.ready).toBe(false);
  });
});
