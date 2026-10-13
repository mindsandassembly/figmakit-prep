/**
 * Reporting helpers: grouping / filtering issues and building the handoff report.
 * The handoff report's contentHash is an integrity checksum, NOT a signature.
 */

import type {
  Certainty,
  HandoffReport,
  IssueException,
  LintIssue,
  LintRunResult,
  ReadinessResult,
  RegistryIndex,
  ReportScope,
  ResolvedConfig,
  Severity,
} from './types';
import { fnv1a, stableStringify } from './hash';

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Group issues by rule id (groups sorted by rule id; issue order preserved within a group). */
export function groupIssuesByRule(issues: LintIssue[]): Array<{ ruleId: string; issues: LintIssue[] }> {
  const map = new Map<string, LintIssue[]>();
  for (const i of issues) {
    const list = map.get(i.ruleId);
    if (list) list.push(i);
    else map.set(i.ruleId, [i]);
  }
  return Array.from(map.keys())
    .sort(cmp)
    .map((ruleId) => ({ ruleId, issues: map.get(ruleId)! }));
}

export interface IssueFilter {
  severities?: Severity[];
  ruleIds?: string[];
  certainty?: Certainty | Certainty[];
  fixableOnly?: boolean;
}

/** Filter issues; omitted criteria match everything. */
export function filterIssues(issues: LintIssue[], filter: IssueFilter = {}): LintIssue[] {
  const certs = filter.certainty === undefined ? null : Array.isArray(filter.certainty) ? filter.certainty : [filter.certainty];
  return issues.filter((i) => {
    if (filter.severities && filter.severities.indexOf(i.severity) === -1) return false;
    if (filter.ruleIds && filter.ruleIds.indexOf(i.ruleId) === -1) return false;
    if (certs && certs.indexOf(i.certainty) === -1) return false;
    if (filter.fixableOnly && !i.fixable) return false;
    return true;
  });
}

/** Headline counts: passed = totals.passedChecks. */
export function summarize(result: LintRunResult): { passed: number; errors: number; warnings: number; infos: number } {
  return {
    passed: result.totals.passedChecks,
    errors: result.totals.errors,
    warnings: result.totals.warnings,
    infos: result.totals.infos,
  };
}

/**
 * Build the machine-readable handoff report.
 * configHash = fnv1a(stableStringify(config)); contentHash = fnv1a(stableStringify(report without contentHash)).
 * `exceptions` (all stored exceptions) is accepted for API symmetry; only exceptions actually
 * attached to issues are reported as approvedExceptions.
 */
export function buildHandoffReport(args: {
  result: LintRunResult;
  readiness: ReadinessResult;
  registry: RegistryIndex | null;
  config: ResolvedConfig;
  exceptions: IssueException[];
  file: { name: string; fileKey: string | null };
  scope: ReportScope;
  validatedAt: string;
  validatedBy: { id: string | null; name: string | null };
  toolVersion: string;
}): HandoffReport {
  const { result, readiness, registry, config } = args;
  const approvedExceptions: Array<IssueException & { issueId: string }> = [];
  for (const i of result.issues) {
    if (i.exception) approvedExceptions.push({ ...i.exception, issueId: i.id });
  }
  const body: Omit<HandoffReport, 'contentHash'> = {
    schemaVersion: '1.0.0',
    tool: { name: 'FigmaKit Prep', component: 'standards', version: args.toolVersion },
    file: { name: args.file.name, fileKey: args.file.fileKey },
    scope: args.scope,
    validatedAt: args.validatedAt,
    validatedBy: { id: args.validatedBy.id, name: args.validatedBy.name },
    rulesetVersion: result.rulesetVersion,
    registry: registry
      ? { version: registry.version, designSystem: registry.designSystem, status: registry.status }
      : { version: result.registryVersion, designSystem: result.designSystem, status: 'draft' },
    configHash: fnv1a(stableStringify(config)),
    totals: result.totals,
    ruleResults: result.ruleSummaries,
    issues: result.issues,
    blockingViolations: readiness.blockingIssues,
    approvedExceptions,
    readiness: { ready: readiness.ready, status: readiness.status, reasons: readiness.reasons },
    diagnostics: { config: result.configDiagnostics, registry: result.registryDiagnostics },
  };
  return { ...body, contentHash: fnv1a(stableStringify(body)) };
}

/** Recompute a report's contentHash and compare (integrity only — not authenticity). */
export function verifyContentHash(report: HandoffReport): boolean {
  const { contentHash, ...rest } = report;
  return fnv1a(stableStringify(rest)) === contentHash;
}

/** Single-line log representation. */
export function formatIssueText(issue: LintIssue): string {
  let s = `[${issue.severity.toUpperCase()}] ${issue.ruleId} (${issue.code}) ${issue.nodePath || issue.nodeName}: ${issue.message}`;
  if (issue.certainty !== 'confirmed') s += ` {${issue.certainty}}`;
  if (issue.blocking) s += ' [blocking]';
  if (issue.exception) s += ` [excepted: ${issue.exception.reason}]`;
  return s.replace(/[\r\n]+/g, ' ');
}
