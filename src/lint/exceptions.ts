/**
 * Approved exceptions: a recorded, reasoned decision that a specific issue on a specific
 * node is acceptable. Exceptions are LOCAL trust only (anyone with edit access can write
 * document plugin data); the handoff report records them for downstream review.
 */

import type { Diagnostic, ExceptionPolicy, IssueException, LintIssue } from './types';
import { INTERNAL_ERROR_RULE_ID } from './types';
import { fnv1a } from './hash';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIso(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '' && !isNaN(Date.parse(v));
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/** Validate an untrusted exception record. Codes: invalid-exception. */
export function validateException(input: unknown, path = ''): Diagnostic[] {
  const out: Diagnostic[] = [];
  const p = (k: string): string => (path ? `${path}.${k}` : k);
  const err = (message: string, at?: string): void => {
    const d: Diagnostic = { level: 'error', code: 'invalid-exception', message };
    const loc = at ?? (path || undefined);
    if (loc !== undefined) d.path = loc;
    out.push(d);
  };
  if (!isObj(input)) {
    err('Exception must be an object.');
    return out;
  }
  if (!nonEmpty(input.id)) err('Exception "id" must be a non-empty string.', p('id'));
  if (!nonEmpty(input.ruleId)) err('Exception "ruleId" must be a non-empty string.', p('ruleId'));
  if (!nonEmpty(input.nodeId)) err('Exception "nodeId" must be a non-empty string.', p('nodeId'));
  if (input.code !== undefined && !nonEmpty(input.code)) err('Exception "code" must be a non-empty string when set.', p('code'));
  if (input.discriminator !== undefined && typeof input.discriminator !== 'string') {
    err('Exception "discriminator" must be a string when set.', p('discriminator'));
  }
  if (typeof input.reason !== 'string') err('Exception "reason" must be a string.', p('reason'));
  const ab = input.approvedBy;
  if (!isObj(ab) || !(ab.id === null || typeof ab.id === 'string') || typeof ab.name !== 'string') {
    err('Exception "approvedBy" must be { id: string | null, name: string }.', p('approvedBy'));
  }
  if (!isIso(input.createdAt)) err('Exception "createdAt" must be an ISO timestamp.', p('createdAt'));
  if (input.expiresAt !== undefined && !isIso(input.expiresAt)) err('Exception "expiresAt" must be an ISO timestamp.', p('expiresAt'));
  if (input.ruleId === INTERNAL_ERROR_RULE_ID) err('Internal rule errors cannot be excepted.', p('ruleId'));
  return out;
}

/**
 * Create an exception record. id = 'ex-' + fnv1a(ruleId|nodeId|code|createdAt), with
 * '|' + discriminator appended when a discriminator is given.
 */
export function createException(args: {
  ruleId: string;
  nodeId: string;
  code?: string;
  discriminator?: string;
  reason: string;
  approvedBy: { id: string | null; name: string };
  createdAt: string;
  expiresAt?: string;
}): IssueException {
  const ex: IssueException = {
    id:
      'ex-' +
      fnv1a(
        [args.ruleId, args.nodeId, args.code ?? '', args.createdAt]
          .concat(args.discriminator !== undefined ? [args.discriminator] : [])
          .join('|'),
      ),
    ruleId: args.ruleId,
    nodeId: args.nodeId,
    reason: args.reason,
    approvedBy: { id: args.approvedBy.id, name: args.approvedBy.name },
    createdAt: args.createdAt,
  };
  if (args.code !== undefined) ex.code = args.code;
  if (args.discriminator !== undefined) ex.discriminator = args.discriminator;
  if (args.expiresAt !== undefined) ex.expiresAt = args.expiresAt;
  return ex;
}

/**
 * True unless the exception has expired at `now`. An exception with `expiresAt` is treated
 * as INACTIVE when `now` or `expiresAt` cannot be parsed (fail closed).
 */
export function isExceptionActive(ex: IssueException, now: string): boolean {
  if (ex.expiresAt === undefined || ex.expiresAt === null) return true;
  const exp = Date.parse(ex.expiresAt);
  const cur = Date.parse(now);
  if (isNaN(exp) || isNaN(cur)) return false;
  return exp > cur;
}

/** allowedApprovers empty ⇒ anyone may approve; otherwise the user id must be listed. */
export function canApprove(policy: ExceptionPolicy, user: { id: string | null }): boolean {
  if (!policy.allowedApprovers || policy.allowedApprovers.length === 0) return true;
  return user.id !== null && policy.allowedApprovers.indexOf(user.id) !== -1;
}

/** True when the policy permits excepting issues of this rule at all. */
export function isRuleExemptible(ruleId: string, policy: ExceptionPolicy): boolean {
  if (!policy.enabled) return false;
  if (ruleId === INTERNAL_ERROR_RULE_ID) return false;
  return (policy.nonExemptRules || []).indexOf(ruleId) === -1;
}

/**
 * First active exception (in list order) covering `issue`, honoring the policy:
 * enabled, rule exemptible, approver allowed, reason present when required, not expired.
 */
export function findActiveException(
  issue: Pick<LintIssue, 'ruleId' | 'nodeId' | 'code'> & { discriminator?: string },
  exceptions: IssueException[],
  policy: ExceptionPolicy,
  now: string,
): IssueException | null {
  if (!exceptions || exceptions.length === 0) return null;
  if (!isRuleExemptible(issue.ruleId, policy)) return null;
  for (const ex of exceptions) {
    if (!ex || ex.ruleId !== issue.ruleId || ex.nodeId !== issue.nodeId) continue;
    if (ex.code !== undefined && ex.code !== null && ex.code !== issue.code) continue;
    // Discriminator-scoped exceptions cover exactly one issue (e.g. one property / one paint).
    if (typeof ex.discriminator === 'string' && ex.discriminator !== (issue.discriminator ?? '')) continue;
    if (policy.requireReason && !nonEmpty(ex.reason)) continue;
    if (!canApprove(policy, { id: ex.approvedBy ? ex.approvedBy.id : null })) continue;
    if (!isExceptionActive(ex, now)) continue;
    return ex;
  }
  return null;
}

/**
 * Parse stored exceptions JSON (an array, or { exceptions: [...] }). Invalid entries are
 * dropped with diagnostics; duplicate ids keep the first (warning duplicate-exception).
 */
export function parseExceptions(json: string): { exceptions: IssueException[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const exceptions: IssueException[] = [];
  if (typeof json !== 'string' || json.trim() === '') return { exceptions, diagnostics };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    diagnostics.push({ level: 'error', code: 'invalid-json', message: 'Exceptions data is not valid JSON.' });
    return { exceptions, diagnostics };
  }
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.exceptions) ? data.exceptions : null;
  if (!list) {
    diagnostics.push({ level: 'error', code: 'invalid-exceptions', message: 'Exceptions data must be an array.' });
    return { exceptions, diagnostics };
  }
  const seen = new Set<string>();
  list.forEach((item: unknown, i: number) => {
    const d = validateException(item, `[${i}]`);
    if (d.length) {
      diagnostics.push(...d);
      return;
    }
    const ex = item as IssueException;
    if (seen.has(ex.id)) {
      diagnostics.push({ level: 'warning', code: 'duplicate-exception', message: `Duplicate exception id "${ex.id}" ignored.`, path: `[${i}].id` });
      return;
    }
    seen.add(ex.id);
    exceptions.push(ex);
  });
  return { exceptions, diagnostics };
}
