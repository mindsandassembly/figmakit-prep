/**
 * Lint engine: runs pure rules over a DesignNode snapshot and produces a deterministic
 * LintRunResult. One misbehaving rule never aborts the run — crashes and malformed
 * output become blocking internal-error issues.
 */

import type {
  Certainty,
  DesignNode,
  Diagnostic,
  FixDescriptor,
  IssueException,
  LintIssue,
  LintRule,
  LintRunResult,
  RegistryIndex,
  ResolvedConfig,
  RuleReport,
  RuleSummary,
  Severity,
} from './types';
import { INTERNAL_ERROR_RULE_ID } from './types';
import { createLintContext, severityForCertainty } from './context';
import type { LintContextImpl } from './context';
import { issueId } from './hash';
import { isBlocking } from './readiness';
import { findActiveException } from './exceptions';

/** After this many crashes in one rule, the engine stops invoking it. */
export const MAX_RULE_CRASHES = 25;

const CERTAINTIES: Certainty[] = ['confirmed', 'likely', 'requires-review'];
const SEVERITIES: Severity[] = ['error', 'warning', 'info'];
const FIX_KINDS = ['SAFE', 'REQUIRES_CONFIRMATION', 'UNSUPPORTED'];

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || 'Error';
  try {
    return String(e);
  } catch (_x) {
    return 'unknown error';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns a reason string when a report is malformed, else null. */
function reportProblem(r: unknown, ctx: LintContextImpl): string | null {
  if (!isObj(r)) return 'report is not an object';
  if (typeof r.code !== 'string' || r.code === '') return 'report.code must be a non-empty string';
  if (typeof r.message !== 'string') return 'report.message must be a string';
  if (r.certainty !== undefined && CERTAINTIES.indexOf(r.certainty as Certainty) === -1) return `invalid certainty ${JSON.stringify(r.certainty)}`;
  if (r.severity !== undefined && SEVERITIES.indexOf(r.severity as Severity) === -1) return `invalid severity ${JSON.stringify(r.severity)}`;
  if (r.discriminator !== undefined && typeof r.discriminator !== 'string') return 'report.discriminator must be a string';
  if (r.nodeId !== undefined) {
    if (typeof r.nodeId !== 'string') return 'report.nodeId must be a string';
    if (!ctx.getNode(r.nodeId)) return `report.nodeId "${r.nodeId}" is not in scope`;
  }
  if (r.fix !== undefined) {
    const f = r.fix;
    if (!isObj(f) || FIX_KINDS.indexOf(f.kind as string) === -1 || !Array.isArray(f.operations) || typeof f.description !== 'string') {
      return 'report.fix is malformed';
    }
  }
  return null;
}

/**
 * Run all enabled rules over the scope. Deterministic: same snapshot + config + registry
 * ⇒ identical issues (ids, order, messages).
 *
 * `now` (ISO) is only used for exception expiry; when omitted, exceptions that carry an
 * `expiresAt` are treated as inactive (fail closed). The engine never reads the clock.
 */
export function runLint(args: {
  roots: DesignNode[];
  rules: LintRule[];
  config: ResolvedConfig;
  registry: RegistryIndex;
  configDiagnostics?: Diagnostic[];
  registryDiagnostics?: Diagnostic[];
  exceptions?: IssueException[];
  now?: string;
}): LintRunResult {
  const { roots, config, registry } = args;
  const exceptions = args.exceptions || [];
  const now = args.now ?? '';
  const settings = config.settings;
  const ctx = createLintContext({ roots, registry, config });

  // Deduplicate + sort rules by id.
  const rules: LintRule[] = [];
  const seenRule = new Set<string>();
  for (const r of args.rules.slice().sort((a, b) => cmp(a.meta.id, b.meta.id))) {
    if (seenRule.has(r.meta.id)) continue;
    seenRule.add(r.meta.id);
    rules.push(r);
  }

  // Pre-order node list (hidden subtrees skipped unless includeHidden), stable-sorted by order.
  const nodes: DesignNode[] = [];
  const seenNode = new Set<string>();
  const visit = (n: DesignNode): void => {
    if (seenNode.has(n.id)) return;
    seenNode.add(n.id);
    if (n.visible === false && !settings.includeHidden) return;
    nodes.push(n);
    for (const c of n.children || []) visit(c);
  };
  roots.forEach(visit);
  const pos = new Map<DesignNode, number>();
  nodes.forEach((n, i) => pos.set(n, i));
  nodes.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 0;
    const bo = typeof b.order === 'number' ? b.order : 0;
    return ao - bo || pos.get(a)! - pos.get(b)!;
  });

  const issues: LintIssue[] = [];
  const issueIds = new Set<string>();
  const summaries: RuleSummary[] = [];
  const maxPerRule = typeof settings.maxIssuesPerRule === 'number' && settings.maxIssuesPerRule >= 1 ? settings.maxIssuesPerRule : 500;

  // Dedupe on the full identity tuple, never on the 32-bit hash: distinct issues whose hashes
  // collide must both survive (the later one gets a deterministic suffix).
  const tupleKeys = new Set<string>();
  const allocateId = (ruleId: string, code: string, nodeId: string, discriminator?: string): string | null => {
    const tuple = JSON.stringify([ruleId, code, nodeId, discriminator ?? '']);
    if (tupleKeys.has(tuple)) return null; // true duplicate: first wins
    let id = issueId(ruleId, code, nodeId, discriminator);
    if (issueIds.has(id)) {
      const base = id;
      let n = 2;
      while (issueIds.has(base + '-' + n)) n++;
      id = base + '-' + n;
    }
    return id;
  };
  const claimId = (id: string, ruleId: string, code: string, nodeId: string, discriminator?: string): void => {
    tupleKeys.add(JSON.stringify([ruleId, code, nodeId, discriminator ?? '']));
    issueIds.add(id);
  };

  const pushInternal = (node: DesignNode, failedRule: string, code: string, message: string): void => {
    const id = allocateId(INTERNAL_ERROR_RULE_ID, code, node.id, failedRule);
    if (id === null) return;
    claimId(id, INTERNAL_ERROR_RULE_ID, code, node.id, failedRule);
    issues.push({
      id,
      ruleId: INTERNAL_ERROR_RULE_ID,
      code,
      nodeId: node.id,
      nodeName: node.name,
      nodePath: ctx.formatPath(node),
      severity: 'error',
      certainty: 'confirmed',
      message,
      fixable: false,
      blocking: true,
      data: { failedRule },
    });
  };

  for (const rule of rules) {
    const id = rule.meta.id;
    const rc = config.rules[id];
    const summary: RuleSummary = {
      ruleId: id,
      description: rule.meta.description,
      enabled: !!rc && rc.enabled,
      severity: rc && rc.enabled ? rc.severity : 'off',
      checks: 0,
      passedChecks: 0,
      issueCount: 0,
      truncatedCount: 0,
      status: 'off',
      errorCount: 0,
    };
    summaries.push(summary);
    if (!rc || !rc.enabled) continue;

    const options = rc.options || {};
    const certaintyMap = isObj(options.certaintySeverity)
      ? (options.certaintySeverity as Partial<Record<Certainty, Severity | 'inherit'>>)
      : undefined;
    ctx.setRule(id, rc.severity, options);

    const recordError = (node: DesignNode, code: string, msg: string): void => {
      summary.errorCount++;
      if (summary.firstError === undefined) summary.firstError = msg;
      pushInternal(node, id, code, msg);
    };

    for (const node of nodes) {
      if (summary.errorCount >= MAX_RULE_CRASHES) break;

      let applies = false;
      try {
        applies = !!rule.appliesTo(node, ctx);
      } catch (e) {
        recordError(node, 'rule-crashed', `Rule "${id}" crashed on this layer: ${errMessage(e)}`);
        continue;
      }
      if (!applies) continue;
      summary.checks++;

      let reports: unknown;
      try {
        reports = rule.validate(node, ctx);
      } catch (e) {
        recordError(node, 'rule-crashed', `Rule "${id}" crashed on this layer: ${errMessage(e)}`);
        continue;
      }
      if (!Array.isArray(reports)) {
        recordError(node, 'invalid-report', `Rule "${id}" returned malformed output on this layer: expected an array of reports.`);
        continue;
      }
      if (reports.length === 0) {
        summary.passedChecks++;
        continue;
      }

      for (const raw of reports) {
        const problem = reportProblem(raw, ctx);
        if (problem) {
          recordError(node, 'invalid-report', `Rule "${id}" returned malformed output on this layer: ${problem}.`);
          continue;
        }
        const r = raw as RuleReport;
        const target = r.nodeId ? ctx.getNode(r.nodeId)! : node;
        const iid = allocateId(id, r.code, target.id, r.discriminator);
        if (iid === null) continue; // duplicate: first wins
        const certainty: Certainty = r.certainty ?? 'confirmed';
        const severity: Severity = r.severity ?? severityForCertainty(rc.severity, certainty, certaintyMap);
        // The cap only ever drops NON-blocking issues: a blocking issue is always materialized so
        // readiness can never pass because of truncation (fail closed).
        if (summary.issueCount >= maxPerRule && !isBlocking({ ruleId: id, severity }, config.readiness)) {
          summary.truncatedCount++;
          continue;
        }
        claimId(iid, id, r.code, target.id, r.discriminator);
        const issue: LintIssue = {
          id: iid,
          ruleId: id,
          code: r.code,
          nodeId: target.id,
          nodeName: target.name,
          nodePath: ctx.formatPath(target),
          severity,
          certainty,
          message: r.message,
          fixable: !!r.fix && r.fix.kind !== 'UNSUPPORTED',
          blocking: false,
        };
        if (r.suggestion !== undefined) issue.suggestion = r.suggestion;
        if (r.expected !== undefined) issue.expected = r.expected;
        if (r.actual !== undefined) issue.actual = r.actual;
        if (r.fix !== undefined) issue.fix = r.fix as FixDescriptor;
        if (r.discriminator !== undefined) issue.discriminator = r.discriminator;
        if (r.data !== undefined) issue.data = r.data;
        issue.blocking = isBlocking(issue, config.readiness);
        const ex = findActiveException(issue, exceptions, config.exceptions, now);
        if (ex) issue.exception = ex;
        issues.push(issue);
        summary.issueCount++;
      }
    }

    summary.status = summary.errorCount > 0 ? 'crashed' : summary.issueCount + summary.truncatedCount > 0 ? 'failed' : 'passed';
  }

  // Deterministic ordering: (node.order, ruleId, code, id).
  const orderOf = (nodeId: string): number => {
    const n = ctx.getNode(nodeId);
    return n && typeof n.order === 'number' ? n.order : Number.MAX_SAFE_INTEGER;
  };
  issues.sort((a, b) => orderOf(a.nodeId) - orderOf(b.nodeId) || cmp(a.ruleId, b.ruleId) || cmp(a.code, b.code) || cmp(a.id, b.id));

  const totals = {
    checks: 0,
    passedChecks: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
    fixable: 0,
    safeFixable: 0,
    requiresReview: 0,
  };
  for (const s of summaries) {
    totals.checks += s.checks;
    totals.passedChecks += s.passedChecks;
  }
  for (const i of issues) {
    if (i.severity === 'error') totals.errors++;
    else if (i.severity === 'warning') totals.warnings++;
    else totals.infos++;
    if (i.fixable) totals.fixable++;
    if (i.fix && i.fix.kind === 'SAFE') totals.safeFixable++;
    if (i.certainty !== 'confirmed') totals.requiresReview++;
  }

  return {
    issues,
    internalErrors: issues.filter((i) => i.ruleId === INTERNAL_ERROR_RULE_ID),
    ruleSummaries: summaries,
    configDiagnostics: args.configDiagnostics || [],
    registryDiagnostics: args.registryDiagnostics || [],
    nodeCount: nodes.length,
    totals,
    rulesetVersion: config.rulesetVersion,
    registryVersion: registry.version,
    designSystem: registry.designSystem,
  };
}
