import { describe, it, expect } from 'vitest';
import {
  esc,
  statusInfo,
  fixKindOf,
  fixBadge,
  certaintyBadge,
  exceptionBadge,
  canFixIssue,
  countSafeFixes,
  filterIssues,
  groupIssuesByRule,
  collectDiagnostics,
  renderDiagnostics,
  renderHeader,
  renderRegistryNotice,
  renderSummary,
  renderStatus,
  renderIssueItem,
  renderIssueList,
  renderSafeFixPreview,
  renderRules,
  renderVerifyResult,
  renderFixResult,
  renderMarkReadyResult,
  canMarkReady,
  expiryToIso,
  DEFAULT_FILTERS,
  MAX_RENDERED_ISSUES,
  INTERNAL_RULE_ID,
} from '../src/ui-standards';

function issue(over: Record<string, any> = {}): any {
  return {
    id: 'i1',
    ruleId: 'divi/approved-component',
    code: 'unapproved-instance',
    nodeId: '1:2',
    nodeName: 'Button',
    nodePath: 'Hero / CTA / Button',
    severity: 'error',
    certainty: 'confirmed',
    message: 'Instance is not approved',
    fixable: false,
    blocking: true,
    ...over,
  };
}

const safeFix = { kind: 'SAFE', description: 'Rename "a" → "b"', operations: [{ op: 'rename', nodeId: '1:2', from: 'a', to: 'b' }] };
const confirmFix = { kind: 'REQUIRES_CONFIRMATION', description: 'Set paddingTop 23px → 24px', operations: [{ op: 'setNumber' }] };

describe('esc', () => {
  it('escapes HTML and attribute metacharacters', () => {
    expect(esc('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  });
  it('handles null/undefined/numbers', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(3)).toBe('3');
  });
});

describe('statusInfo', () => {
  it('maps statuses to labels and colors', () => {
    expect(statusInfo('READY')).toEqual({ label: 'READY FOR DEVELOPMENT', cls: 'std-status-ready' });
    expect(statusInfo('READY_WITH_EXCEPTIONS').cls).toBe('std-status-exceptions');
    expect(statusInfo('NOT_READY').label).toBe('NOT READY FOR DEVELOPMENT');
  });
  it('is never optimistic for unknown status', () => {
    expect(statusInfo(undefined).cls).toBe('std-status-not-ready');
    expect(statusInfo('weird').cls).toBe('std-status-not-ready');
  });
});

describe('badges', () => {
  it('fix kind / badge', () => {
    expect(fixKindOf(issue({ fixable: true, fix: safeFix }))).toBe('SAFE');
    expect(fixKindOf(issue({ fixable: true, fix: confirmFix }))).toBe('REQUIRES_CONFIRMATION');
    expect(fixKindOf(issue({ fixable: false, fix: { kind: 'UNSUPPORTED', description: '', operations: [] } }))).toBe('MANUAL');
    expect(fixKindOf(issue())).toBe('MANUAL');
    expect(fixBadge(issue({ fixable: true, fix: safeFix }))).toContain('SAFE FIX');
    expect(fixBadge(issue({ fixable: true, fix: confirmFix }))).toContain('FIX NEEDS CONFIRMATION');
    expect(fixBadge(issue())).toContain('MANUAL');
  });
  it('certainty badge only for non-confirmed', () => {
    expect(certaintyBadge('confirmed')).toBe('');
    expect(certaintyBadge('likely')).toContain('LIKELY');
    expect(certaintyBadge('requires-review')).toContain('NEEDS REVIEW');
  });
  it('exception badge escapes reason and name', () => {
    const html = exceptionBadge(issue({ exception: { id: 'e1', reason: '<b>legacy</b>', approvedBy: { id: '1', name: 'Ann <x>' } } }));
    expect(html).toContain('EXCEPTION: &lt;b&gt;legacy&lt;/b&gt; — by Ann &lt;x&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('fix accounting', () => {
  it('excepted issues are not fixable from the UI', () => {
    expect(canFixIssue(issue({ fixable: true, fix: safeFix }))).toBe(true);
    expect(canFixIssue(issue({ fixable: true, fix: safeFix, exception: { id: 'e' } }))).toBe(false);
  });
  it('countSafeFixes counts only SAFE, non-excepted', () => {
    const list = [
      issue({ id: 'a', fixable: true, fix: safeFix }),
      issue({ id: 'b', fixable: true, fix: confirmFix }),
      issue({ id: 'c', fixable: true, fix: safeFix, exception: { id: 'e' } }),
      issue({ id: 'd' }),
    ];
    expect(countSafeFixes(list)).toBe(1);
    expect(countSafeFixes(null)).toBe(0);
  });
});

describe('filterIssues', () => {
  const list = [
    issue({ id: 'e', severity: 'error' }),
    issue({ id: 'w', severity: 'warning', certainty: 'likely', fixable: true, fix: safeFix }),
    issue({ id: 'n', severity: 'info', certainty: 'requires-review' }),
    issue({ id: 'x', severity: 'error', ruleId: INTERNAL_RULE_ID }),
  ];
  it('severity toggles', () => {
    const ids = filterIssues(list, { ...DEFAULT_FILTERS, error: false }).map((i) => i.id);
    expect(ids).toEqual(['w', 'n', 'x']); // internal errors always shown
  });
  it('fixable only', () => {
    expect(filterIssues(list, { ...DEFAULT_FILTERS, fixableOnly: true }).map((i) => i.id)).toEqual(['w', 'x']);
  });
  it('needs review only', () => {
    expect(filterIssues(list, { ...DEFAULT_FILTERS, needsReviewOnly: true }).map((i) => i.id)).toEqual(['w', 'n', 'x']);
  });
});

describe('groupIssuesByRule', () => {
  it('groups in first-seen order with titles', () => {
    const groups = groupIssuesByRule(
      [issue({ id: '1', ruleId: 'b' }), issue({ id: '2', ruleId: 'a' }), issue({ id: '3', ruleId: 'b' })],
      { b: 'Rule B' }
    );
    expect(groups.map((g) => [g.ruleId, g.title, g.issues.length])).toEqual([['b', 'Rule B', 2], ['a', 'a', 1]]);
  });
});

describe('diagnostics', () => {
  it('collects from object/array/result and dedupes', () => {
    const d = { level: 'error', code: 'invalid-json', message: 'Bad JSON' };
    const out = collectDiagnostics({
      diagnostics: { config: [d], registry: [] },
      result: { configDiagnostics: [d], registryDiagnostics: [{ level: 'warning', code: 'w', message: 'm' }] },
    });
    expect(out.length).toBe(2);
    expect(out[0].source).toBe('config');
    expect(collectDiagnostics({ diagnostics: [d] }).length).toBe(1);
    expect(collectDiagnostics(null)).toEqual([]);
  });
  it('includes exception diagnostics', () => {
    const out = collectDiagnostics({ diagnostics: { config: [], registry: [], exceptions: [{ level: 'error', code: 'invalid-exception', message: 'bad' }] } });
    expect(out).toEqual([{ level: 'error', code: 'invalid-exception', message: 'bad', path: undefined, source: 'exceptions' }]);
  });
  it('renders escaped and empty when none', () => {
    expect(renderDiagnostics([])).toBe('');
    const html = renderDiagnostics([{ level: 'error', code: 'c', message: '<script>' }]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('std-notice-error');
  });
  it('collapses repeated diagnostics of the same code into one expandable line, errors first', () => {
    const warn = (n: number) => ({ level: 'warning' as const, code: 'unresolved-key', message: 'placeholder ' + n });
    const html = renderDiagnostics([warn(1), warn(2), warn(3), { level: 'error', code: 'bad', message: 'broken' }]);
    expect(html).toContain('3 \u00d7 component key is still a placeholder');
    expect(html).toContain('<details class="std-diag-group">');
    expect(html.indexOf('broken')).toBeLessThan(html.indexOf('placeholder 1'));
    expect(html).toContain('std-notice-error');
  });
});

describe('header / summary / status', () => {
  it('header shows registry version, status and source', () => {
    const html = renderHeader({ designSystem: 'Divi 5', rulesetVersion: '1.0.0', registryVersion: '0.1.0', registryStatus: 'draft', registrySource: 'bundled' });
    expect(html).toContain('FIGMAKIT STANDARDS');
    expect(html).toContain('Design System: <strong>Divi 5</strong>');
    expect(html).toContain('Ruleset: <strong>1.0.0</strong>');
    expect(html).toContain('Registry: <strong>0.1.0</strong> (draft, bundled)');
  });
  it('draft notice', () => {
    expect(renderRegistryNotice('draft')).toContain('Registry is a DRAFT with placeholder keys');
    expect(renderRegistryNotice('approved')).toBe('');
  });
  it('summary', () => {
    const html = renderSummary({ passedChecks: 12, errors: 2, warnings: 1, infos: 0 });
    expect(html).toContain('<strong>12</strong> checks passed');
    expect(html).toContain('<strong>2</strong> errors');
    expect(html).toContain('<strong>1</strong> warnings');
    expect(html).toContain('<strong>0</strong> info');
  });
  it('status with collapsed reasons', () => {
    const html = renderStatus({ ready: false, status: 'NOT_READY', reasons: ['a', 'b', 'c', 'd<', 'e'] }, 3);
    expect(html).toContain('NOT READY FOR DEVELOPMENT');
    expect(html).toContain('Show 2 more');
    expect(html).toContain('d&lt;');
    expect(renderStatus({ ready: true, status: 'READY', reasons: [] })).toContain('std-status-ready');
    expect(renderStatus(null)).toBe('');
  });
});

describe('renderIssueItem', () => {
  it('escapes node names, paths and ids', () => {
    const html = renderIssueItem(issue({ id: 'a"b', nodePath: '<img onerror=1>', message: 'm & m', suggestion: 'Use <Button>', expected: '24px', actual: '23px' }));
    expect(html).toContain('data-issue-id="a&quot;b"');
    expect(html).toContain('&lt;img onerror=1&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('Suggested: Use &lt;Button&gt;');
    expect(html).toContain('Expected: 24px &middot; Actual: 23px');
    expect(html).toContain('ERROR');
    expect(html).toContain('data-std-action="select"');
  });
  it('actions: fix only when fixable, exception hidden for internal errors', () => {
    expect(renderIssueItem(issue({ fixable: true, fix: safeFix }))).toContain('data-std-action="fix"');
    expect(renderIssueItem(issue())).not.toContain('data-std-action="fix"');
    expect(renderIssueItem(issue())).toContain('data-std-action="open-exception"');
    expect(renderIssueItem(issue({ ruleId: INTERNAL_RULE_ID }))).not.toContain('open-exception');
    const exc = renderIssueItem(issue({ exception: { id: 'e1', reason: 'r', approvedBy: { id: null, name: 'N' } } }));
    expect(exc).toContain('remove-exception');
    expect(exc).not.toContain('open-exception');
  });
  it('confirmation preview requires explicit confirm button', () => {
    const it1 = issue({ fixable: true, fix: confirmFix });
    const loading = renderIssueItem(it1, { openIssueId: 'i1', openMode: 'preview', issuePreview: null });
    expect(loading).toContain('Loading preview');
    expect(loading).not.toContain('confirm-fix');
    const ready = renderIssueItem(it1, {
      openIssueId: 'i1', openMode: 'preview',
      issuePreview: { operations: [{ issueId: 'i1', kind: 'REQUIRES_CONFIRMATION', description: 'Set <x>' }], skipped: [] },
    });
    expect(ready).toContain('Set &lt;x&gt;');
    expect(ready).toContain('data-std-action="confirm-fix"');
  });
  it('exception form', () => {
    const html = renderIssueItem(issue(), { openIssueId: 'i1', openMode: 'exception', exceptionDraft: { reason: '</textarea>', expires: '' } });
    expect(html).toContain('data-std-field="exception-reason"');
    expect(html).toContain('&lt;/textarea&gt;');
    expect(html).toContain('submit-exception');
  });
});

describe('renderIssueList', () => {
  it('empty states', () => {
    expect(renderIssueList(null, DEFAULT_FILTERS)).toContain('Run Validation');
    expect(renderIssueList([], DEFAULT_FILTERS)).toContain('No issues found');
    expect(renderIssueList([issue({ severity: 'info' })], { ...DEFAULT_FILTERS, info: false })).toContain('No issues match');
  });
  it('group by rule with counts and collapse', () => {
    const list = [issue({ id: '1', ruleId: 'r1' }), issue({ id: '2', ruleId: 'r1' }), issue({ id: '3', ruleId: 'r2' })];
    const html = renderIssueList(list, { ...DEFAULT_FILTERS, groupByRule: true }, { collapsedGroups: { r2: true } });
    expect(html).toContain('data-rule-id="r1"');
    expect(html).toContain('<span class="token-section-count">2</span>');
    expect(html).not.toContain('data-issue-id="3"');
    expect(html).toContain('data-issue-id="1"');
  });
  it('caps rendered issues', () => {
    const list: any[] = [];
    for (let i = 0; i < MAX_RENDERED_ISSUES + 5; i++) list.push(issue({ id: 'i' + i }));
    const html = renderIssueList(list, DEFAULT_FILTERS);
    expect(html).toContain('5 more issues not shown');
  });
});

describe('previews and results', () => {
  it('safe fix preview with apply/cancel', () => {
    expect(renderSafeFixPreview(null, false)).toBe('');
    expect(renderSafeFixPreview(null, true)).toContain('Loading preview');
    const html = renderSafeFixPreview({ operations: [{ issueId: 'a', kind: 'SAFE', description: 'Rename' }], skipped: [{ issueId: 'b', reason: 'excepted' }] }, false);
    expect(html).toContain('Apply 1 fix');
    expect(html).toContain('cancel-safe');
    expect(html).toContain('Skipped 1');
    expect(renderSafeFixPreview({ operations: [], skipped: [] }, false)).not.toContain('apply-safe');
  });
  it('fix result accepts arrays or numbers', () => {
    expect(renderFixResult({ applied: 2, failed: [] })).toContain('Applied 2 fixes');
    const html = renderFixResult({ applied: [1], failed: [{ reason: 'stale <node>' }] });
    expect(html).toContain('Applied 1 fix, 1 failed');
    expect(html).toContain('stale &lt;node&gt;');
    expect(html).toContain('Cmd/Ctrl+Z');
  });
  it('mark ready wording', () => {
    expect(renderMarkReadyResult({ ok: true, contentHash: 'abc' })).toContain('Marked ready (local record). This is not an organization-wide approval.');
    expect(renderMarkReadyResult({ ok: false, reasons: ['x'] })).toContain('Not marked ready');
  });
  it('verify result', () => {
    const html = renderVerifyResult({ resolved: ['k1'], unresolved: [{ componentId: 'btn', key: 'k2', error: 'not found' }] });
    expect(html).toContain('1 key resolved, 1 unresolved');
    expect(html).toContain('btn');
  });
  it('verify result reports placeholder keys and is not green for a draft registry', () => {
    const html = renderVerifyResult({ ok: false, resolved: [], unresolved: [], placeholders: [{ componentId: 'divi-button', key: 'PLACEHOLDER_BUTTON' }] });
    expect(html).toContain('1 placeholder');
    expect(html).toContain('divi-button');
    expect(html).toContain('std-notice-amber');
    expect(html).not.toContain('std-notice-success');
  });
  it('verify result shows registry diagnostics when the registry is invalid', () => {
    const html = renderVerifyResult({ ok: false, resolved: [], unresolved: [], placeholders: [], diagnostics: [{ level: 'error', code: 'invalid-json', message: 'bad <json>' }] });
    expect(html).toContain('bad &lt;json&gt;');
    expect(html).toContain('std-notice-error');
  });
  it('collapses repeated diagnostics of the same code into one expandable line, errors first', () => {
    const warn = (n: number) => ({ level: 'warning' as const, code: 'unresolved-key', message: 'placeholder ' + n });
    const html = renderDiagnostics([warn(1), warn(2), warn(3), { level: 'error', code: 'bad', message: 'broken' }]);
    expect(html).toContain('3 \u00d7 component key is still a placeholder');
    expect(html).toContain('<details class="std-diag-group">');
    expect(html.indexOf('broken')).toBeLessThan(html.indexOf('placeholder 1'));
    expect(html).toContain('std-notice-error');
  });
  it('refused fix result shows the reason, not "Applied 0 fixes"', () => {
    const html = renderFixResult({ refused: true, reason: 'Needs confirmation', applied: [], failed: [] });
    expect(html).toContain('Needs confirmation');
    expect(html).not.toContain('Applied');
  });
  it('rules list', () => {
    const html = renderRules([{ id: 'r1', description: 'Desc', severity: 'off', fixable: true, category: 'naming', docs: '<docs>' }]);
    expect(html).toContain('OFF');
    expect(html).toContain('FIXABLE');
    expect(html).toContain('&lt;docs&gt;');
  });
});

describe('canMarkReady / expiryToIso', () => {
  it('requires ready, fresh, not busy', () => {
    expect(canMarkReady({ ready: true }, false, false)).toBe(true);
    expect(canMarkReady({ ready: true }, true, false)).toBe(false);
    expect(canMarkReady({ ready: true }, false, true)).toBe(false);
    expect(canMarkReady({ ready: false }, false, false)).toBe(false);
    expect(canMarkReady(null, false, false)).toBe(false);
  });
  it('date to ISO', () => {
    expect(expiryToIso('2026-12-31')).toBe('2026-12-31T23:59:59.999Z');
    expect(expiryToIso('')).toBeUndefined();
    expect(expiryToIso('nope')).toBeUndefined();
  });
});
