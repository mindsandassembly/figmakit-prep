import { describe, it, expect } from 'vitest';
import {
  validateException,
  createException,
  isExceptionActive,
  findActiveException,
  canApprove,
  parseExceptions,
} from '../../src/lint/exceptions';
import { DEFAULT_EXCEPTIONS } from '../../src/lint/config';
import { fnv1a } from '../../src/lint/hash';
import { INTERNAL_ERROR_RULE_ID } from '../../src/lint/types';

const base = {
  ruleId: 'divi/valid-nesting',
  nodeId: '1:2',
  reason: 'Approved by design lead',
  approvedBy: { id: 'u1', name: 'Dana' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('createException', () => {
  it('derives a stable id', () => {
    const ex = createException({ ...base, code: 'invalid-child' });
    expect(ex.id).toBe('ex-' + fnv1a('divi/valid-nesting|1:2|invalid-child|2026-01-01T00:00:00.000Z'));
    expect(ex.code).toBe('invalid-child');
    expect(createException(base).code).toBeUndefined();
    expect(createException(base).expiresAt).toBeUndefined();
    expect(validateException(ex)).toEqual([]);
  });
});

describe('validateException', () => {
  it('flags every bad field', () => {
    const d = validateException({ id: '', ruleId: 1, nodeId: '', code: '', reason: 5, approvedBy: { id: 3 }, createdAt: 'yesterday', expiresAt: 'never' });
    expect(d.length).toBe(8);
    expect(d.every((x) => x.code === 'invalid-exception' && x.level === 'error')).toBe(true);
  });
  it('rejects non-objects and internal error rule', () => {
    expect(validateException(null).length).toBe(1);
    expect(validateException(createException({ ...base, ruleId: INTERNAL_ERROR_RULE_ID })).length).toBe(1);
  });
});

describe('isExceptionActive', () => {
  it('no expiry → active', () => {
    expect(isExceptionActive(createException(base), '2030-01-01T00:00:00Z')).toBe(true);
    expect(isExceptionActive(createException(base), '')).toBe(true);
  });
  it('expiry compared with now; unparsable fails closed', () => {
    const ex = createException({ ...base, expiresAt: '2026-06-01T00:00:00.000Z' });
    expect(isExceptionActive(ex, '2026-05-31T23:59:59.000Z')).toBe(true);
    expect(isExceptionActive(ex, '2026-06-01T00:00:00.000Z')).toBe(false);
    expect(isExceptionActive(ex, '')).toBe(false);
  });
});

describe('canApprove', () => {
  it('empty allowlist allows anyone', () => {
    expect(canApprove(DEFAULT_EXCEPTIONS, { id: null })).toBe(true);
  });
  it('allowlist enforced', () => {
    const p = { ...DEFAULT_EXCEPTIONS, allowedApprovers: ['u1'] };
    expect(canApprove(p, { id: 'u1' })).toBe(true);
    expect(canApprove(p, { id: 'u2' })).toBe(false);
    expect(canApprove(p, { id: null })).toBe(false);
  });
});

describe('findActiveException', () => {
  const issue = { ruleId: 'divi/valid-nesting', nodeId: '1:2', code: 'invalid-child' };
  const now = '2026-02-01T00:00:00.000Z';
  it('matches on ruleId + nodeId (+ code if set)', () => {
    const any = createException(base);
    const coded = createException({ ...base, code: 'invalid-parent', createdAt: '2026-01-02T00:00:00.000Z' });
    expect(findActiveException(issue, [coded], DEFAULT_EXCEPTIONS, now)).toBeNull();
    expect(findActiveException(issue, [coded, any], DEFAULT_EXCEPTIONS, now)).toBe(any);
    expect(findActiveException({ ...issue, nodeId: 'other' }, [any], DEFAULT_EXCEPTIONS, now)).toBeNull();
    expect(findActiveException({ ...issue, ruleId: 'x' }, [any], DEFAULT_EXCEPTIONS, now)).toBeNull();
  });
  it('a discriminator-scoped exception covers only that one issue (legacy ones cover all)', () => {
    const tok = { ruleId: 'divi/approved-tokens', nodeId: '1:2', code: 'off-scale-spacing' };
    const ex = createException({ ...base, ruleId: tok.ruleId, code: tok.code, discriminator: 'paddingLeft' });
    expect(ex.discriminator).toBe('paddingLeft');
    expect(validateException(ex)).toEqual([]);
    expect(validateException({ ...ex, discriminator: 5 }).map((d) => d.path)).toEqual(['discriminator']);
    expect(findActiveException({ ...tok, discriminator: 'paddingLeft' }, [ex], DEFAULT_EXCEPTIONS, now)).toBe(ex);
    expect(findActiveException({ ...tok, discriminator: 'itemSpacing' }, [ex], DEFAULT_EXCEPTIONS, now)).toBeNull();
    expect(findActiveException(tok, [ex], DEFAULT_EXCEPTIONS, now)).toBeNull();
    const noDisc = createException({ ...base, ruleId: tok.ruleId, code: tok.code, discriminator: '' });
    expect(findActiveException(tok, [noDisc], DEFAULT_EXCEPTIONS, now)).toBe(noDisc);
    const legacy = createException({ ...base, ruleId: tok.ruleId, code: tok.code });
    expect(findActiveException({ ...tok, discriminator: 'itemSpacing' }, [legacy], DEFAULT_EXCEPTIONS, now)).toBe(legacy);
  });
  it('honors policy: enabled, nonExemptRules, internal errors, approvers, reason, expiry', () => {
    const ex = createException(base);
    expect(findActiveException(issue, [ex], { ...DEFAULT_EXCEPTIONS, enabled: false }, now)).toBeNull();
    expect(findActiveException(issue, [ex], { ...DEFAULT_EXCEPTIONS, nonExemptRules: ['divi/valid-nesting'] }, now)).toBeNull();
    const internal = createException({ ...base, ruleId: INTERNAL_ERROR_RULE_ID });
    expect(findActiveException({ ...issue, ruleId: INTERNAL_ERROR_RULE_ID }, [internal], DEFAULT_EXCEPTIONS, now)).toBeNull();
    expect(findActiveException(issue, [ex], { ...DEFAULT_EXCEPTIONS, allowedApprovers: ['someone-else'] }, now)).toBeNull();
    const noReason = createException({ ...base, reason: '  ' });
    expect(findActiveException(issue, [noReason], DEFAULT_EXCEPTIONS, now)).toBeNull();
    expect(findActiveException(issue, [noReason], { ...DEFAULT_EXCEPTIONS, requireReason: false }, now)).toBe(noReason);
    const expired = createException({ ...base, expiresAt: '2026-01-15T00:00:00.000Z' });
    expect(findActiveException(issue, [expired], DEFAULT_EXCEPTIONS, now)).toBeNull();
  });
});

describe('parseExceptions', () => {
  it('parses array and {exceptions} forms', () => {
    const ex = createException(base);
    expect(parseExceptions(JSON.stringify([ex])).exceptions).toEqual([ex]);
    expect(parseExceptions(JSON.stringify({ exceptions: [ex] })).exceptions).toEqual([ex]);
    expect(parseExceptions('')).toEqual({ exceptions: [], diagnostics: [] });
  });
  it('reports invalid json / shape / entries / duplicates', () => {
    expect(parseExceptions('{').diagnostics.map((d) => d.code)).toEqual(['invalid-json']);
    expect(parseExceptions('42').diagnostics.map((d) => d.code)).toEqual(['invalid-exceptions']);
    const ex = createException(base);
    const r = parseExceptions(JSON.stringify([ex, { id: 'bad' }, ex]));
    expect(r.exceptions).toEqual([ex]);
    expect(r.diagnostics.some((d) => d.code === 'invalid-exception' && d.path!.startsWith('[1]'))).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'duplicate-exception')).toBe(true);
  });
});
