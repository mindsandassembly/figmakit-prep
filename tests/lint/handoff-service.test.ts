import { describe, it, expect } from 'vitest';
import { LocalOnlyHandoffService, type HandoffAttestationService } from '../../src/lint/handoff-service';
import type { HandoffReport } from '../../src/lint/types';

function report(): HandoffReport {
  return {
    schemaVersion: '1.0.0',
    tool: { name: 'FigmaKit Prep', component: 'standards', version: '1.0.0' },
    file: { name: 'File', fileKey: null },
    scope: { type: 'page', pageId: '0:1', pageName: 'Page', rootNodeIds: [], rootNodeNames: [] },
    validatedAt: '2026-01-01T00:00:00.000Z',
    validatedBy: { id: null, name: null },
    rulesetVersion: '1.0.0',
    registry: { version: '0.1.0', designSystem: 'Divi 5', status: 'draft' },
    configHash: 'abc',
    totals: { checks: 0, passedChecks: 0, errors: 0, warnings: 0, infos: 0, fixable: 0, safeFixable: 0, requiresReview: 0 },
    ruleResults: [],
    issues: [],
    blockingViolations: [],
    approvedExceptions: [],
    readiness: { ready: true, status: 'READY', reasons: [] },
    diagnostics: { config: [], registry: [] },
    contentHash: 'deadbeef',
  };
}

describe('LocalOnlyHandoffService', () => {
  it('is untrusted and implements the interface', () => {
    const svc: HandoffAttestationService = new LocalOnlyHandoffService();
    expect(svc.name).toBe('local-only');
    expect(svc.trusted).toBe(false);
  });

  it('never accepts / attests, and explains why', async () => {
    const res = await new LocalOnlyHandoffService().submit(report());
    expect(res.accepted).toBe(false);
    expect(res.attestationId).toBeNull();
    expect(res.message).toMatch(/not independently verified/);
    expect(res.message).toContain('deadbeef');
  });

  it('does not mutate the report', async () => {
    const r = report();
    const before = JSON.stringify(r);
    await new LocalOnlyHandoffService().submit(r);
    expect(JSON.stringify(r)).toBe(before);
  });
});
