import { describe, it, expect } from 'vitest';
import type { DesignNode, LintRule, RuleReport, LintConfig, Severity } from '../../src/lint/types';
import { INTERNAL_ERROR_RULE_ID } from '../../src/lint/types';
import { runLint, MAX_RULE_CRASHES } from '../../src/lint/engine';
import { resolveConfig } from '../../src/lint/config';
import { createRegistryIndex } from '../../src/lint/registry';
import { createException } from '../../src/lint/exceptions';
import { issueId } from '../../src/lint/hash';
import { node, finalize, lint, testRegistry, byName, TEST_NOW } from './helpers';

type Impl = {
  severity?: Severity;
  options?: Record<string, unknown>;
  validateOptions?: (o: Record<string, unknown>) => string[];
  appliesTo?: (n: DesignNode) => boolean;
  validate: (n: DesignNode, ctx: Parameters<LintRule['validate']>[1]) => RuleReport[];
};
function rule(id: string, impl: Impl): LintRule {
  return {
    meta: {
      id,
      description: 'fake ' + id,
      category: 'structure',
      defaultSeverity: impl.severity ?? 'error',
      defaultOptions: impl.options ?? {},
      fixable: true,
      validateOptions: impl.validateOptions,
    },
    appliesTo: impl.appliesTo ?? (() => true),
    validate: impl.validate,
  };
}

/** Flags every node whose name starts with "Bad". */
const badName = rule('test/bad-name', {
  validate: (n) => (n.name.startsWith('Bad') ? [{ code: 'bad', message: `${n.name} is bad` }] : []),
});

function sample(): DesignNode[] {
  return finalize([
    node({
      name: 'Root',
      children: [
        node({ name: 'Bad A', children: [node({ name: 'Good' }), node({ name: 'Bad B' })] }),
        node({ name: 'Bad C' }),
      ],
    }),
  ]);
}

const cfg = (c: LintConfig = {}): LintConfig => ({ rulesetVersion: '1.0.0', ...c });

describe('runLint basics', () => {
  it('produces issues with engine-filled fields and summaries', () => {
    const { result } = lint(sample(), { rules: [badName], config: cfg() });
    expect(result.nodeCount).toBe(5);
    expect(result.issues.map((i) => i.nodeName)).toEqual(['Bad A', 'Bad B', 'Bad C']);
    const i = result.issues[0];
    expect(i).toMatchObject({
      ruleId: 'test/bad-name',
      code: 'bad',
      nodePath: 'Root / Bad A',
      severity: 'error',
      certainty: 'confirmed',
      fixable: false,
      blocking: true,
    });
    expect(i.id).toBe(issueId('test/bad-name', 'bad', i.nodeId));
    expect(result.ruleSummaries).toEqual([
      {
        ruleId: 'test/bad-name', description: 'fake test/bad-name', enabled: true, severity: 'error',
        checks: 5, passedChecks: 2, issueCount: 3, truncatedCount: 0, status: 'failed', errorCount: 0,
      },
    ]);
    expect(result.totals).toEqual({ checks: 5, passedChecks: 2, errors: 3, warnings: 0, infos: 0, fixable: 0, safeFixable: 0, requiresReview: 0 });
    expect(result.rulesetVersion).toBe('1.0.0');
    expect(result.registryVersion).toBe('1.0.0');
    expect(result.designSystem).toBe('Divi 5 (test)');
    expect(result.internalErrors).toEqual([]);
  });

  it('passes diagnostics through', () => {
    const roots = sample();
    const { config } = resolveConfig(cfg(), [badName]);
    const r = runLint({
      roots, rules: [badName], config, registry: createRegistryIndex(testRegistry()),
      configDiagnostics: [{ level: 'warning', code: 'c', message: 'm' }],
      registryDiagnostics: [{ level: 'info', code: 'r', message: 'm' }],
    });
    expect(r.configDiagnostics.map((d) => d.code)).toEqual(['c']);
    expect(r.registryDiagnostics.map((d) => d.code)).toEqual(['r']);
  });

  it('severity overrides via config', () => {
    const { result } = lint(sample(), { rules: [badName], config: cfg({ rules: { 'test/bad-name': 'warn' } }) });
    expect(result.issues.every((i) => i.severity === 'warning' && !i.blocking)).toBe(true);
    expect(result.ruleSummaries[0].severity).toBe('warning');
    expect(result.totals.warnings).toBe(3);
  });

  it("disabled rules ('off') do not run and report status off", () => {
    let calls = 0;
    const counting = rule('test/count', { validate: () => { calls++; return []; } });
    const { result } = lint(sample(), { rules: [counting, badName], config: cfg({ rules: { 'test/count': 'off', 'test/bad-name': 0 } }) });
    expect(calls).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.ruleSummaries.map((s) => [s.ruleId, s.status, s.enabled, s.severity])).toEqual([
      ['test/bad-name', 'off', false, 'off'],
      ['test/count', 'off', false, 'off'],
    ]);
  });

  it('rules missing from config.rules are skipped with status off', () => {
    const { config } = resolveConfig(cfg(), []);
    const r = runLint({ roots: sample(), rules: [badName], config, registry: createRegistryIndex(testRegistry()) });
    expect(r.issues).toEqual([]);
    expect(r.ruleSummaries[0].status).toBe('off');
  });

  it('per-rule options merge (defaults + config) reach the rule via context.options', () => {
    const seen: Record<string, unknown>[] = [];
    const opt = rule('test/opts', {
      options: { a: 1, b: 2 },
      appliesTo: (n) => n.depth === 0,
      validate: (_n, ctx) => { seen.push({ ...ctx.options, sev: ctx.severity, id: ctx.ruleId }); return []; },
    });
    lint(sample(), { rules: [opt], config: cfg({ rules: { 'test/opts': ['warning', { b: 3, c: 4 }] } }) });
    expect(seen).toEqual([{ a: 1, b: 3, c: 4, sev: 'warning', id: 'test/opts' }]);
  });

  it('context options/ruleId switch between rules', () => {
    const seen: string[] = [];
    const r1 = rule('a/one', { options: { tag: 'one' }, appliesTo: (n) => n.depth === 0, validate: (_n, c) => { seen.push(`${c.ruleId}:${c.options.tag}`); return []; } });
    const r2 = rule('a/two', { options: { tag: 'two' }, appliesTo: (n) => n.depth === 0, validate: (_n, c) => { seen.push(`${c.ruleId}:${c.options.tag}`); return []; } });
    lint(sample(), { rules: [r2, r1], config: cfg() });
    expect(seen).toEqual(['a/one:one', 'a/two:two']);
  });
});

describe('determinism', () => {
  const multi = rule('test/multi', {
    validate: (n) =>
      n.name.startsWith('Bad')
        ? [
            { code: 'z-code', message: 'z' },
            { code: 'a-code', message: 'a', discriminator: 'x' },
            { code: 'a-code', message: 'a2', discriminator: 'y' },
          ]
        : [],
  });
  it('same input twice → deep-equal output; stable ids', () => {
    const a = lint(sample(), { rules: [multi, badName], config: cfg() });
    const b = lint(sample(), { rules: [badName, multi], config: cfg() });
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
    expect(a.readiness).toEqual(b.readiness);
  });
  it('orders issues by (node.order, ruleId, code, id)', () => {
    const { result } = lint(sample(), { rules: [multi, badName], config: cfg() });
    const keys = result.issues.map((i) => `${i.nodeName}|${i.ruleId}|${i.code}`);
    expect(keys.slice(0, 5)).toEqual([
      'Bad A|test/bad-name|bad',
      'Bad A|test/multi|a-code',
      'Bad A|test/multi|a-code',
      'Bad A|test/multi|z-code',
      'Bad B|test/bad-name|bad',
    ]);
    const twoA = result.issues.slice(1, 3).map((i) => i.id);
    expect(twoA.slice().sort()).toEqual(twoA);
  });
  it('respects node.order over array position', () => {
    const roots = sample();
    // Swap orders of "Bad B" and "Bad C" (as if snapshot assigned them that way).
    const bB = byName(roots, 'Bad B');
    const bC = byName(roots, 'Bad C');
    const { config } = resolveConfig(cfg(), [badName]);
    [bB.order, bC.order] = [bC.order, bB.order];
    const r = runLint({ roots, rules: [badName], config, registry: createRegistryIndex(testRegistry()) });
    expect(r.issues.map((i) => i.nodeName)).toEqual(['Bad A', 'Bad C', 'Bad B']);
  });
});

describe('crash isolation (Scenario I)', () => {
  const thrower = rule('test/thrower', {
    validate: (n) => {
      if (n.name === 'Bad B') throw new Error('kaboom');
      return [];
    },
  });
  it('validate() throwing → blocking internal error issue, rule crashed, NOT ready', () => {
    const { result, readiness } = lint(sample(), { rules: [thrower, badName], config: cfg({ rules: { 'test/bad-name': 'info' } }) });
    expect(result.internalErrors.length).toBe(1);
    const ie = result.internalErrors[0];
    expect(ie).toMatchObject({
      ruleId: INTERNAL_ERROR_RULE_ID,
      code: 'rule-crashed',
      nodeName: 'Bad B',
      severity: 'error',
      certainty: 'confirmed',
      blocking: true,
      data: { failedRule: 'test/thrower' },
    });
    expect(ie.message).toBe('Rule "test/thrower" crashed on this layer: kaboom');
    expect(ie.id).toBe(issueId(INTERNAL_ERROR_RULE_ID, 'rule-crashed', ie.nodeId, 'test/thrower'));
    expect(result.issues).toContain(ie);
    const s = result.ruleSummaries.find((x) => x.ruleId === 'test/thrower')!;
    expect(s.status).toBe('crashed');
    expect(s.errorCount).toBe(1);
    expect(s.firstError).toContain('kaboom');
    expect(s.checks).toBe(5);
    expect(s.passedChecks).toBe(4);
    // Other rules still ran.
    expect(result.issues.filter((i) => i.ruleId === 'test/bad-name').length).toBe(3);
    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe('NOT_READY');
    expect(readiness.blockingIssues).toContain(ie);
    expect(readiness.reasons.some((r) => r.includes('crashed'))).toBe(true);
  });
  it('internal errors cannot be excepted', () => {
    const roots = sample();
    const bB = byName(roots, 'Bad B');
    const ex = createException({ ruleId: INTERNAL_ERROR_RULE_ID, nodeId: bB.id, reason: 'x', approvedBy: { id: null, name: 'n' }, createdAt: TEST_NOW });
    const { result, readiness } = lint(roots, { rules: [thrower], config: cfg(), exceptions: [ex] });
    expect(result.internalErrors[0].exception).toBeUndefined();
    expect(readiness.ready).toBe(false);
  });
  it('appliesTo throwing → internal error, rule crashed', () => {
    const r = rule('test/applies-throws', {
      appliesTo: (n) => { if (n.name === 'Good') throw 'string thrown'; return true; },
      validate: () => [],
    });
    const { result } = lint(sample(), { rules: [r], config: cfg() });
    expect(result.internalErrors.length).toBe(1);
    expect(result.internalErrors[0].message).toContain('string thrown');
    const s = result.ruleSummaries[0];
    expect(s.status).toBe('crashed');
    expect(s.checks).toBe(4);
  });
  it(`stops invoking a rule after ${MAX_RULE_CRASHES} crashes`, () => {
    let calls = 0;
    const always = rule('test/always', { validate: () => { calls++; throw new Error('x'); } });
    const roots = finalize([node({ name: 'R', children: Array.from({ length: 40 }, (_, i) => node({ name: 'c' + i })) })]);
    const { result } = lint(roots, { rules: [always], config: cfg() });
    expect(calls).toBe(MAX_RULE_CRASHES);
    expect(result.ruleSummaries[0].errorCount).toBe(MAX_RULE_CRASHES);
    expect(result.internalErrors.length).toBe(MAX_RULE_CRASHES);
  });
});

describe('malformed rule output', () => {
  it('non-array → internal error invalid-report', () => {
    const r = rule('test/nonarray', { appliesTo: (n) => n.depth === 0, validate: () => ({ code: 'x' }) as unknown as RuleReport[] });
    const { result, readiness } = lint(sample(), { rules: [r], config: cfg() });
    expect(result.internalErrors.map((i) => i.code)).toEqual(['invalid-report']);
    expect(result.ruleSummaries[0].status).toBe('crashed');
    expect(readiness.ready).toBe(false);
  });
  it('malformed entries are flagged; valid siblings kept', () => {
    const r = rule('test/mixed', {
      appliesTo: (n) => n.depth === 0,
      validate: () => [
        { code: 'ok', message: 'fine' },
        { code: '', message: 'no code' },
        { code: 'c', message: 'm', certainty: 'maybe' as never },
        { code: 'c', message: 'm', nodeId: 'ghost' },
        { code: 'c', message: 'm', fix: { kind: 'MAGIC' } as never },
        null as never,
      ],
    });
    const { result } = lint(sample(), { rules: [r], config: cfg() });
    expect(result.issues.filter((i) => i.ruleId === 'test/mixed').map((i) => i.code)).toEqual(['ok']);
    // Several malformed entries on the same node collapse into one internal error issue (same id)…
    expect(result.internalErrors.length).toBe(1);
    // …but every one is counted.
    expect(result.ruleSummaries[0].errorCount).toBe(5);
  });
});

describe('issue construction', () => {
  it('report.nodeId retargets the issue', () => {
    const r = rule('test/retarget', {
      appliesTo: (n) => n.name === 'Bad A',
      validate: (n) => [{ code: 'child', message: 'm', nodeId: n.children[1].id }],
    });
    const { result } = lint(sample(), { rules: [r], config: cfg() });
    expect(result.issues[0]).toMatchObject({ nodeName: 'Bad B', nodePath: 'Root / Bad A / Bad B' });
  });
  it('certainty → severity mapping (default and certaintySeverity option); report.severity wins', () => {
    const r = rule('test/cert', {
      appliesTo: (n) => n.depth === 0,
      validate: () => [
        { code: 'c1', message: 'm', certainty: 'confirmed' },
        { code: 'c2', message: 'm', certainty: 'likely' },
        { code: 'c3', message: 'm', certainty: 'requires-review' },
        { code: 'c4', message: 'm', certainty: 'requires-review', severity: 'error' },
      ],
    });
    const sev = (c: LintConfig) =>
      lint(sample(), { rules: [r], config: c }).result.issues.map((i) => `${i.code}:${i.severity}:${i.blocking}`);
    expect(sev(cfg())).toEqual(['c1:error:true', 'c2:warning:false', 'c3:info:false', 'c4:error:true']);
    expect(sev(cfg({ rules: { 'test/cert': ['error', { certaintySeverity: { likely: 'error', 'requires-review': 'warning' } }] } }))).toEqual([
      'c1:error:true', 'c2:error:true', 'c3:warning:false', 'c4:error:true',
    ]);
    expect(sev(cfg({ rules: { 'test/cert': 'warning' } }))).toEqual(['c1:warning:false', 'c2:warning:false', 'c3:info:false', 'c4:error:true']);
    const { result } = lint(sample(), { rules: [r], config: cfg() });
    expect(result.totals.requiresReview).toBe(3);
  });
  it('fixable / safeFixable accounting', () => {
    const r = rule('test/fix', {
      appliesTo: (n) => n.depth === 0,
      validate: (n) => [
        { code: 'safe', message: 'm', fix: { kind: 'SAFE', description: 'd', operations: [{ op: 'rename', nodeId: n.id, from: n.name, to: 'X' }] } },
        { code: 'confirm', message: 'm', fix: { kind: 'REQUIRES_CONFIRMATION', description: 'd', operations: [] } },
        { code: 'unsupported', message: 'm', fix: { kind: 'UNSUPPORTED', description: 'd', operations: [] } },
        { code: 'none', message: 'm', suggestion: 's', expected: 'e', actual: 'a', data: { k: 1 } },
      ],
    });
    const { result } = lint(sample(), { rules: [r], config: cfg() });
    expect(result.issues.map((i) => `${i.code}:${i.fixable}`)).toEqual(['confirm:true', 'none:false', 'safe:true', 'unsupported:false']);
    expect(result.totals.fixable).toBe(2);
    expect(result.totals.safeFixable).toBe(1);
    expect(result.issues[1]).toMatchObject({ suggestion: 's', expected: 'e', actual: 'a', data: { k: 1 } });
  });
  it('blockingRules make warnings blocking (not infos)', () => {
    const r = rule('test/w', {
      appliesTo: (n) => n.depth === 0,
      validate: () => [{ code: 'w', message: 'm', severity: 'warning' }, { code: 'i', message: 'm', severity: 'info' }],
    });
    const { result } = lint(sample(), { rules: [r], config: cfg({ readiness: { blockingRules: ['test/w'] } }) });
    expect(result.issues.map((i) => `${i.code}:${i.blocking}`)).toEqual(['i:false', 'w:true']);
  });
  it('duplicate ids within a run are dropped (first wins)', () => {
    const r = rule('test/dupe', {
      appliesTo: (n) => n.depth === 0,
      validate: () => [{ code: 'd', message: 'first' }, { code: 'd', message: 'second' }],
    });
    const { result } = lint(sample(), { rules: [r], config: cfg() });
    expect(result.issues.map((i) => i.message)).toEqual(['first']);
    expect(result.ruleSummaries[0].issueCount).toBe(1);
  });
  it('maxIssuesPerRule truncates and counts the remainder (non-blocking issues)', () => {
    const r = rule('test/many', { severity: 'warning', validate: (n) => [{ code: 'x', message: n.name }] });
    const { result } = lint(sample(), { rules: [r], config: cfg({ settings: { maxIssuesPerRule: 2 } }) });
    expect(result.issues.length).toBe(2);
    expect(result.ruleSummaries[0]).toMatchObject({ issueCount: 2, truncatedCount: 3, status: 'failed' });
  });
  it('maxIssuesPerRule never drops blocking issues (fail closed)', () => {
    const r = rule('test/many-errors', { validate: (n) => [{ code: 'x', message: n.name }] });
    const { result } = lint(sample(), { rules: [r], config: cfg({ settings: { maxIssuesPerRule: 1 } }) });
    expect(result.issues.length).toBe(5);
    expect(result.issues.every((i) => i.blocking)).toBe(true);
    expect(result.ruleSummaries[0]).toMatchObject({ issueCount: 5, truncatedCount: 0 });
  });
  it('a blocking issue after the cap is filled with warnings is still kept', () => {
    // Certainty-mapped severity: likely → warning, confirmed → error (the last node).
    const r = rule('test/mixed', {
      validate: (n) => [{ code: 'x', message: n.name, certainty: n.name === 'Bad C' ? 'confirmed' : 'likely' }],
    });
    const { result } = lint(sample(), { rules: [r], config: cfg({ settings: { maxIssuesPerRule: 2 } }) });
    const blocking = result.issues.filter((i) => i.blocking).map((i) => i.nodeName);
    expect(blocking).toEqual(['Bad C']);
    expect(result.ruleSummaries[0].truncatedCount).toBe(2);
  });
  it('maxIssuesPerRule: 0 is rejected and does not disable reporting', () => {
    const r = rule('test/many-errors', { validate: (n) => [{ code: 'x', message: n.name }] });
    const { result } = lint(sample(), { rules: [r], config: cfg({ settings: { maxIssuesPerRule: 0 } }) });
    expect(result.issues.length).toBe(5);
    expect(result.configDiagnostics.map((d) => d.code)).toContain('invalid-settings');
  });
  it('distinct issues whose hashed ids collide are both kept with unique ids', () => {
    // fnv1a collision found for these realistic Figma node ids (see review finding).
    expect(issueId('divi/approved-component', 'unapproved-instance', '272:299')).toBe(
      issueId('divi/approved-component', 'unapproved-instance', '325:232'),
    );
    const roots = finalize([node({ name: 'Root', id: 'root', children: [node({ name: 'A', id: '272:299' }), node({ name: 'B', id: '325:232' })] })]);
    const r = rule('divi/approved-component', {
      appliesTo: (n) => n.name !== 'Root',
      validate: () => [{ code: 'unapproved-instance', message: 'm' }],
    });
    const { result } = lint(roots, { rules: [r], config: cfg() });
    expect(result.issues.map((i) => i.nodeId)).toEqual(['272:299', '325:232']);
    const ids = result.issues.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(issueId('divi/approved-component', 'unapproved-instance', '272:299'));
    expect(ids[1]).toBe(ids[0] + '-2');
  });
  it('a hash collision cannot hide an unexcepted blocking issue behind an excepted one', () => {
    const roots = finalize([node({ name: 'Root', id: 'root', children: [node({ name: 'A', id: '272:299' }), node({ name: 'B', id: '325:232' })] })]);
    const r = rule('divi/approved-component', {
      appliesTo: (n) => n.name !== 'Root',
      validate: () => [{ code: 'unapproved-instance', message: 'm' }],
    });
    const ex = createException({ ruleId: 'divi/approved-component', nodeId: '272:299', code: 'unapproved-instance', reason: 'ok', approvedBy: { id: 'u', name: 'U' }, createdAt: TEST_NOW });
    const { result, readiness } = lint(roots, { rules: [r], config: cfg(), exceptions: [ex] });
    expect(result.issues.map((i) => `${i.nodeId}:${!!i.exception}`)).toEqual(['272:299:true', '325:232:false']);
    expect(readiness.status).toBe('NOT_READY');
    expect(readiness.blockingIssues.map((i) => i.nodeId)).toEqual(['325:232']);
  });
  it('maxIssuesPerRule: 0 with blocking errors → NOT_READY (never READY via truncation)', () => {
    const r = rule('test/many-errors', { validate: (n) => [{ code: 'x', message: n.name }] });
    const { readiness } = lint(sample(), { rules: [r], config: cfg({ settings: { maxIssuesPerRule: 0 } }) });
    expect(readiness.ready).toBe(false);
  });
  it('skips hidden subtrees unless includeHidden', () => {
    const roots = () => finalize([node({ name: 'Root', children: [node({ name: 'Bad Hidden', visible: false, children: [node({ name: 'Bad Inner' })] })] })]);
    expect(lint(roots(), { rules: [badName], config: cfg() }).result.nodeCount).toBe(1);
    const inc = lint(roots(), { rules: [badName], config: cfg({ settings: { includeHidden: true } }) }).result;
    expect(inc.nodeCount).toBe(3);
    expect(inc.issues.length).toBe(2);
  });
});

describe('exception attachment', () => {
  it('attaches an active exception for matching rule/node/code', () => {
    const roots = sample();
    const target = byName(roots, 'Bad B');
    const ex = createException({ ruleId: 'test/bad-name', nodeId: target.id, code: 'bad', reason: 'ok', approvedBy: { id: 'u', name: 'U' }, createdAt: TEST_NOW });
    const { result } = lint(roots, { rules: [badName], config: cfg(), exceptions: [ex] });
    const excepted = result.issues.filter((i) => i.exception);
    expect(excepted.map((i) => i.nodeName)).toEqual(['Bad B']);
    expect(excepted[0].exception).toEqual(ex);
    expect(excepted[0].blocking).toBe(true); // blocking is computed before exceptions
  });
  it('ignores expired exceptions and non-exempt rules', () => {
    const roots = sample();
    const target = byName(roots, 'Bad B');
    const expired = createException({ ruleId: 'test/bad-name', nodeId: target.id, reason: 'ok', approvedBy: { id: 'u', name: 'U' }, createdAt: '2025-01-01T00:00:00Z', expiresAt: '2025-06-01T00:00:00Z' });
    expect(lint(roots, { rules: [badName], config: cfg(), exceptions: [expired] }).result.issues.some((i) => i.exception)).toBe(false);
    const ex = createException({ ruleId: 'test/bad-name', nodeId: target.id, reason: 'ok', approvedBy: { id: 'u', name: 'U' }, createdAt: TEST_NOW });
    const r = lint(sample(), { rules: [badName], config: cfg({ exceptions: { nonExemptRules: ['test/bad-name'] } }), exceptions: [ex] });
    expect(r.result.issues.some((i) => i.exception)).toBe(false);
  });
  it('without `now`, exceptions with expiry are treated as inactive (engine never reads the clock)', () => {
    const roots = sample();
    const target = byName(roots, 'Bad B');
    const ex = createException({ ruleId: 'test/bad-name', nodeId: target.id, reason: 'ok', approvedBy: { id: 'u', name: 'U' }, createdAt: TEST_NOW, expiresAt: '2999-01-01T00:00:00Z' });
    const { config } = resolveConfig(cfg(), [badName]);
    const r = runLint({ roots, rules: [badName], config, registry: createRegistryIndex(testRegistry()), exceptions: [ex] });
    expect(r.issues.some((i) => i.exception)).toBe(false);
  });
});
