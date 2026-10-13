/**
 * Readiness: a binary, explainable verdict. Percent scores are never used.
 */

import type {
  LintIssue,
  LintRunResult,
  ReadinessPolicy,
  ReadinessResult,
  RegistryIndex,
  ResolvedConfig,
} from './types';
import { INTERNAL_ERROR_RULE_ID } from './types';
import { isRuleExemptible } from './exceptions';

/** severity ∈ blockingSeverities OR (ruleId ∈ blockingRules AND severity !== 'info'). */
export function isBlocking(issue: Pick<LintIssue, 'ruleId' | 'severity'>, policy: ReadinessPolicy): boolean {
  if (issue.ruleId === INTERNAL_ERROR_RULE_ID) return true;
  if ((policy.blockingSeverities || []).indexOf(issue.severity) !== -1) return true;
  return (policy.blockingRules || []).indexOf(issue.ruleId) !== -1 && issue.severity !== 'info';
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? one + 's'}`;
}

/**
 * Evaluate readiness. Not ready when ANY of: zero nodes validated; config errors; registry
 * missing / registry errors; draft or placeholder-keyed registry while requireApprovedRegistry;
 * crashed rules; internal errors; blocking issues not covered by a policy-permitted exception.
 * Exceptions are re-checked against the policy here (attached exceptions are ignored when the
 * policy is disabled or the rule is non-exempt).
 */
export function evaluateReadiness(args: {
  result: LintRunResult;
  config: ResolvedConfig;
  registry: RegistryIndex | null;
}): ReadinessResult {
  const { result, config, registry } = args;
  const policy = config.readiness;
  const reasons: string[] = [];

  const blockingIssues: LintIssue[] = [];
  const exceptedIssues: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  for (const issue of result.issues) {
    const internal = issue.ruleId === INTERNAL_ERROR_RULE_ID;
    const blocking = internal || issue.blocking === true || isBlocking(issue, policy);
    if (!blocking) {
      if (issue.severity === 'warning') warnings.push(issue);
      continue;
    }
    if (!internal && issue.exception && isRuleExemptible(issue.ruleId, config.exceptions)) {
      exceptedIssues.push(issue);
    } else {
      blockingIssues.push(issue);
    }
  }

  if (result.nodeCount === 0) reasons.push('Nothing was validated (no layers in scope).');

  const configErrors = (result.configDiagnostics || []).filter((d) => d.level === 'error');
  if (configErrors.length) {
    reasons.push(`Configuration has ${plural(configErrors.length, 'error')}: ${configErrors.map((d) => d.code).join(', ')}.`);
  }

  if (!registry) {
    reasons.push('Component registry could not be loaded.');
  }
  const registryErrors = (result.registryDiagnostics || []).filter((d) => d.level === 'error');
  if (registryErrors.length) {
    reasons.push(`Component registry has ${plural(registryErrors.length, 'error')}: ${registryErrors.map((d) => d.code).join(', ')}.`);
  }

  if (policy.requireApprovedRegistry && registry) {
    if (registry.status !== 'approved') {
      reasons.push(`Component registry ${registry.designSystem} v${registry.version} is a draft; an approved registry is required.`);
    }
    const placeholderKeys = new Set<string>();
    for (const c of registry.all()) {
      for (const k of c.figmaComponentKeys || []) if (registry.isPlaceholderKey(k)) placeholderKeys.add(c.id + '|' + k);
    }
    const unresolvedDiag = (result.registryDiagnostics || []).filter((d) => d.code === 'unresolved-key').length;
    const n = Math.max(placeholderKeys.size, unresolvedDiag);
    if (n > 0) reasons.push(`Component registry has ${plural(n, 'placeholder component key')}.`);
  }

  const crashed = result.ruleSummaries.filter((s) => s.status === 'crashed').map((s) => s.ruleId).sort();
  if (crashed.length) reasons.push(`${plural(crashed.length, 'rule')} crashed: ${crashed.join(', ')}.`);

  const internalCount = result.issues.filter((i) => i.ruleId === INTERNAL_ERROR_RULE_ID).length;
  if (internalCount) reasons.push(`${plural(internalCount, 'internal rule error')} — the result cannot be trusted.`);

  const ruleBlocking = blockingIssues.filter((i) => i.ruleId !== INTERNAL_ERROR_RULE_ID).length;
  if (ruleBlocking) reasons.push(`${plural(ruleBlocking, 'blocking issue')} must be fixed or excepted.`);

  const ready = reasons.length === 0 && blockingIssues.length === 0;
  return {
    ready,
    status: ready ? (exceptedIssues.length > 0 ? 'READY_WITH_EXCEPTIONS' : 'READY') : 'NOT_READY',
    blockingIssues,
    exceptedIssues,
    warnings,
    reasons,
    rulesetVersion: result.rulesetVersion,
    registryVersion: result.registryVersion,
  };
}
