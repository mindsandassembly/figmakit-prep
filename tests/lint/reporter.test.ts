import { describe, it, expect } from 'vitest';
import type { LintRule, RuleReport, ReportScope } from '../../src/lint/types';
import {
  groupIssuesByRule,
  filterIssues,
  summarize,
  buildHandoffReport,
  verifyContentHash,
  formatIssueText,
} from '../../src/lint/reporter';
import { fnv1a, stableStringify } from '../../src/lint/hash';
import { createException } from '../../src/lint/exceptions';
import { node, finalize, lint, byName, TEST_NOW } from './helpers';

function rule(id: string, reports: (name: string) => RuleReport[]): LintRule {
  return {
    meta: { id, description: id, category: 'structure', defaultSeverity: 'error', defaultOptions: {}, fixable: true },
    appliesTo: () => true,
    validate: (n) => reports(n.name),
  };
}
const rA = rule('b/rule', (n) => (n === 'X' ? [{ code: 'x', message: 'X is wrong', fix: { kind: 'SAFE', description: 'd', operations: [] } }] : []));
const rB = rule('a/rule', (n) => (n === 'Y' ? [{ code: 'y', message: 'Y\nis odd', certainty: 'likely' }] : []));
const roots = () => finalize([node({ name: 'Root', children: [node({ name: 'X' }), node({ name: 'Y' })] })]);
const scope: ReportScope = { type: 'selection', pageId: '0:1', pageName: 'Page 1', rootNodeIds: ['n1'], rootNodeNames: ['Root'] };

function run() {
  const r = roots();
  const ex = createException({ ruleId: 'b/rule', nodeId: byName(r, 'X').id, reason: 'ok', approvedBy: { id: 'u', name: 'U' }, createdAt: TEST_NOW });
  const out = lint(r, { rules: [rA, rB], config: { rulesetVersion: '2.1.0' }, exceptions: [ex] });
  return { ...out, ex };
}

describe('reporter helpers', () => {
  it('groupIssuesByRule sorts groups by rule id', () => {
    const { result } = run();
    expect(groupIssuesByRule(result.issues).map((g) => [g.ruleId, g.issues.length])).toEqual([['a/rule', 1], ['b/rule', 1]]);
    expect(groupIssuesByRule([])).toEqual([]);
  });
  it('filterIssues', () => {
    const { result } = run();
    expect(filterIssues(result.issues).length).toBe(2);
    expect(filterIssues(result.issues, { severities: ['warning'] }).map((i) => i.code)).toEqual(['y']);
    expect(filterIssues(result.issues, { ruleIds: ['b/rule'] }).map((i) => i.code)).toEqual(['x']);
    expect(filterIssues(result.issues, { certainty: 'likely' }).map((i) => i.code)).toEqual(['y']);
    expect(filterIssues(result.issues, { certainty: ['confirmed', 'likely'] }).length).toBe(2);
    expect(filterIssues(result.issues, { fixableOnly: true }).map((i) => i.code)).toEqual(['x']);
  });
  it('summarize', () => {
    const { result } = run();
    expect(summarize(result)).toEqual({ passed: 4, errors: 1, warnings: 1, infos: 0 });
  });
  it('formatIssueText is a single line', () => {
    const { result } = run();
    const lines = result.issues.map(formatIssueText);
    expect(lines[0]).toBe('[ERROR] b/rule (x) Root / X: X is wrong [blocking] [excepted: ok]');
    expect(lines[1]).toBe('[WARNING] a/rule (y) Root / Y: Y is odd {likely}');
  });
});

describe('buildHandoffReport', () => {
  const build = () => {
    const { result, readiness, registry, config, ex } = run();
    return {
      ex,
      config,
      report: buildHandoffReport({
        result, readiness, registry, config, exceptions: [ex],
        file: { name: 'Site.fig', fileKey: null }, scope,
        validatedAt: '2026-03-01T10:00:00.000Z', validatedBy: { id: 'u', name: 'U' }, toolVersion: '1.2.3',
      }),
    };
  };
  it('has the expected shape', () => {
    const { report, ex, config } = build();
    expect(report.schemaVersion).toBe('1.0.0');
    expect(report.tool).toEqual({ name: 'FigmaKit Prep', component: 'standards', version: '1.2.3' });
    expect(report.rulesetVersion).toBe('2.1.0');
    expect(report.registry).toEqual({ version: '1.0.0', designSystem: 'Divi 5 (test)', status: 'approved' });
    expect(report.configHash).toBe(fnv1a(stableStringify(config)));
    expect(report.issues.length).toBe(2);
    expect(report.blockingViolations).toEqual([]);
    expect(report.approvedExceptions).toEqual([{ ...ex, issueId: report.issues.find((i) => i.code === 'x')!.id }]);
    expect(report.readiness).toEqual({ ready: true, status: 'READY_WITH_EXCEPTIONS', reasons: [] });
    expect(report.diagnostics).toEqual({ config: [], registry: [] });
    expect(report.scope).toEqual(scope);
  });
  it('contentHash covers the body and is deterministic', () => {
    const a = build().report;
    const b = build().report;
    expect(a.contentHash).toBe(b.contentHash);
    const { contentHash, ...rest } = a;
    expect(contentHash).toBe(fnv1a(stableStringify(rest)));
    expect(verifyContentHash(a)).toBe(true);
    expect(verifyContentHash({ ...a, validatedAt: '2030-01-01T00:00:00Z' })).toBe(false);
  });
  it('null registry falls back to result metadata with draft status', () => {
    const { result, readiness, config } = run();
    const rep = buildHandoffReport({
      result, readiness, registry: null, config, exceptions: [],
      file: { name: 'f', fileKey: 'k' }, scope, validatedAt: 'now', validatedBy: { id: null, name: null }, toolVersion: '0',
    });
    expect(rep.registry).toEqual({ version: '1.0.0', designSystem: 'Divi 5 (test)', status: 'draft' });
  });
});
