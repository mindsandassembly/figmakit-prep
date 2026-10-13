import bundledStandardsConfig from './standards/figmakit.config.json';

/** Locked designer build: Standards only, no admin tools (see src/standards/figmakit.config.json adminTools). */
export var LOCKED_BUILD = (bundledStandardsConfig as any).adminTools !== true;

/** Test hook: switch between the locked designer build and the admin build. */
export function setLockedBuildForTests(locked: boolean): void {
  LOCKED_BUILD = locked;
}

/**
 * FigmaKit Standards — UI tab logic (runs in the plugin iframe).
 *
 * The rendering helpers in the first half of this file are PURE string builders
 * (no DOM access) so they can be unit tested in node. DOM wiring lives in
 * `initStandardsUI()` and the message handler, which are only called from ui.ts.
 *
 * Message protocol: see INTEGRATION.md (standards-* messages). The UI never
 * decides readiness itself — "Mark Ready" always asks the main thread, which
 * re-runs validation before writing anything.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Escape text for both HTML text content and double/single-quoted attributes. */
export function esc(value: unknown): string {
  var s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const INTERNAL_RULE_ID = 'internal/rule-error';

export interface StdFilters {
  error: boolean;
  warning: boolean;
  info: boolean;
  groupByRule: boolean;
  fixableOnly: boolean;
  needsReviewOnly: boolean;
}

export const DEFAULT_FILTERS: StdFilters = {
  error: true,
  warning: true,
  info: true,
  groupByRule: false,
  fixableOnly: false,
  needsReviewOnly: false,
};

export interface StatusInfo {
  label: string;
  cls: string;
}

/** Display label + CSS class for a readiness status. Unknown/missing → NOT READY (never optimistic). */
export function statusInfo(status: string | null | undefined): StatusInfo {
  if (status === 'READY') return { label: 'READY FOR DEVELOPMENT', cls: 'std-status-ready' };
  if (status === 'READY_WITH_EXCEPTIONS') return { label: 'READY WITH EXCEPTIONS', cls: 'std-status-exceptions' };
  return { label: 'NOT READY FOR DEVELOPMENT', cls: 'std-status-not-ready' };
}

export function severityBadge(severity: string): string {
  var sev = severity === 'error' || severity === 'warning' || severity === 'info' ? severity : 'info';
  return '<span class="std-badge std-sev-' + sev + '">' + esc(sev.toUpperCase()) + '</span>';
}

export function certaintyBadge(certainty: string | undefined): string {
  if (certainty === 'likely') return '<span class="std-badge std-cert">LIKELY</span>';
  if (certainty === 'requires-review') return '<span class="std-badge std-cert">NEEDS REVIEW</span>';
  return '';
}

/** Fix kind of an issue: 'SAFE' | 'REQUIRES_CONFIRMATION' | 'MANUAL'. */
export function fixKindOf(issue: any): 'SAFE' | 'REQUIRES_CONFIRMATION' | 'MANUAL' {
  var kind = issue && issue.fix ? issue.fix.kind : null;
  if (issue && issue.fixable && kind === 'SAFE') return 'SAFE';
  if (issue && issue.fixable && kind === 'REQUIRES_CONFIRMATION') return 'REQUIRES_CONFIRMATION';
  return 'MANUAL';
}

export function fixBadge(issue: any): string {
  var k = fixKindOf(issue);
  if (k === 'SAFE') return '<span class="std-badge std-fix-safe">SAFE FIX</span>';
  if (k === 'REQUIRES_CONFIRMATION') return '<span class="std-badge std-fix-confirm">FIX NEEDS CONFIRMATION</span>';
  return '<span class="std-badge std-fix-manual">MANUAL</span>';
}

export function exceptionBadge(issue: any): string {
  var ex = issue && issue.exception;
  if (!ex) return '';
  var by = ex.approvedBy && ex.approvedBy.name ? ex.approvedBy.name : 'unknown';
  var text = 'EXCEPTION: ' + (ex.reason || '(no reason)') + ' — by ' + by;
  if (ex.expiresAt) text += ' (expires ' + String(ex.expiresAt).slice(0, 10) + ')';
  return '<span class="std-badge std-exc">' + esc(text) + '</span>';
}

export function isInternalIssue(issue: any): boolean {
  return !!issue && issue.ruleId === INTERNAL_RULE_ID;
}

/** Issue is actionable by a per-item Fix button (has a fix and is not covered by an exception). */
export function canFixIssue(issue: any): boolean {
  return fixKindOf(issue) !== 'MANUAL' && !issue.exception;
}

/** Number of issues "Fix Safe Issues" could act on. */
export function countSafeFixes(issues: any[] | null | undefined): number {
  if (!issues) return 0;
  var n = 0;
  for (var i = 0; i < issues.length; i++) {
    if (fixKindOf(issues[i]) === 'SAFE' && !issues[i].exception) n++;
  }
  return n;
}

export function filterIssues(issues: any[], f: StdFilters): any[] {
  var out: any[] = [];
  for (var i = 0; i < issues.length; i++) {
    var it = issues[i];
    var sev = it.severity === 'error' || it.severity === 'warning' ? it.severity : 'info';
    // Internal errors are always shown: they invalidate the run.
    if (!isInternalIssue(it)) {
      if (!(f as any)[sev]) continue;
      if (f.fixableOnly && !canFixIssue(it)) continue;
      if (f.needsReviewOnly && (!it.certainty || it.certainty === 'confirmed')) continue;
    }
    out.push(it);
  }
  return out;
}

export interface IssueGroup {
  ruleId: string;
  title: string;
  issues: any[];
}

/** Group issues by rule, preserving the first-seen order of rules (issues are pre-sorted by the engine). */
export function groupIssuesByRule(issues: any[], ruleTitles?: Record<string, string>): IssueGroup[] {
  var groups: IssueGroup[] = [];
  var byId: Record<string, IssueGroup> = {};
  for (var i = 0; i < issues.length; i++) {
    var rid = String(issues[i].ruleId || 'unknown');
    var g = byId[rid];
    if (!g) {
      g = { ruleId: rid, title: (ruleTitles && ruleTitles[rid]) || rid, issues: [] };
      byId[rid] = g;
      groups.push(g);
    }
    g.issues.push(issues[i]);
  }
  return groups;
}

export interface DiagnosticLike {
  level: string;
  code: string;
  message: string;
  path?: string;
  source?: string;
}

/**
 * Normalize diagnostics from a standards-result / standards-state message. Accepts an array, an
 * object `{ config, registry, exceptions }`, and the result's own configDiagnostics /
 * registryDiagnostics. Duplicates are removed.
 */
export function collectDiagnostics(msg: any): DiagnosticLike[] {
  var out: DiagnosticLike[] = [];
  var seen: Record<string, boolean> = {};
  function add(list: any, source: string) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!d) continue;
      var key = [d.level, d.code, d.message, d.path || ''].join('|');
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ level: String(d.level || 'info'), code: String(d.code || ''), message: String(d.message || ''), path: d.path, source: d.source || source });
    }
  }
  var diag = msg ? msg.diagnostics : null;
  if (Array.isArray(diag)) add(diag, '');
  else if (diag && typeof diag === 'object') {
    add(diag.config, 'config');
    add(diag.registry, 'registry');
    add(diag.exceptions, 'exceptions');
  }
  var res = msg ? msg.result : null;
  if (res) {
    add(res.configDiagnostics, 'config');
    add(res.registryDiagnostics, 'registry');
  }
  return out;
}

/** Short human labels for diagnostic codes that tend to repeat. */
var DIAG_GROUP_LABELS: Record<string, string> = {
  'unresolved-key': 'component key is still a placeholder',
  'no-keys': 'component has no Figma keys',
  'unknown-role': 'unknown classifier role in match.roles',
  'unknown-key': 'unrecognized field',
};

function diagIcon(level: string): string {
  return level === 'error' ? '&#x2715; ' : level === 'warning' ? '&#x26A0; ' : '&#x2139; ';
}

function renderDiagItem(d: DiagnosticLike): string {
  var html = '<div class="std-diag-item">' + diagIcon(d.level);
  if (d.source) html += esc(d.source) + ': ';
  html += esc(d.message);
  if (d.code) html += ' <span class="std-diag-code">[' + esc(d.code) + ']</span>';
  if (d.path) html += ' <span class="std-diag-code">' + esc(d.path) + '</span>';
  html += '</div>';
  return html;
}

/**
 * Diagnostics block. Diagnostics are grouped by level + code so repeated warnings (e.g. eight placeholder
 * keys in the draft registry) collapse into one expandable line. Errors are listed first and expanded.
 */
export function renderDiagnostics(diags: DiagnosticLike[]): string {
  if (!diags || diags.length === 0) return '';
  var order = ['error', 'warning', 'info'];
  var groups: Array<{ level: string; code: string; items: DiagnosticLike[] }> = [];
  var index: Record<string, number> = {};
  for (var i = 0; i < diags.length; i++) {
    var d = diags[i];
    var key = d.level + '|' + (d.code || '');
    if (index[key] === undefined) {
      index[key] = groups.length;
      groups.push({ level: d.level, code: d.code || '', items: [] });
    }
    groups[index[key]].items.push(d);
  }
  groups.sort(function (a, b) { return order.indexOf(a.level) - order.indexOf(b.level); });
  var hasError = groups.length > 0 && groups[0].level === 'error';
  var html = '<div class="std-notice ' + (hasError ? 'std-notice-error' : 'std-notice-amber') + ' std-diag">';
  html += '<strong>' + (hasError ? 'Configuration / registry problems' : 'Configuration / registry warnings') + '</strong>';
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    if (grp.items.length === 1) {
      html += renderDiagItem(grp.items[0]);
      continue;
    }
    var label = DIAG_GROUP_LABELS[grp.code] || grp.code || 'diagnostics';
    html += '<details class="std-diag-group"' + (grp.level === 'error' ? ' open' : '') + '><summary>' +
      diagIcon(grp.level) + grp.items.length + ' \u00d7 ' + esc(label) +
      (grp.code ? ' <span class="std-diag-code">[' + esc(grp.code) + ']</span>' : '') + '</summary>';
    for (var k = 0; k < grp.items.length; k++) html += renderDiagItem(grp.items[k]);
    html += '</details>';
  }
  html += '</div>';
  return html;
}

export interface HeaderInfo {
  designSystem?: string | null;
  rulesetVersion?: string | null;
  registryVersion?: string | null;
  registryStatus?: string | null;
  registrySource?: string | null;
  configSource?: string | null;
  /** What the latest results cover, e.g. "Page “Home” (whole page)" or "2 selected layers". */
  scopeLabel?: string | null;
}

/** Human-readable label for a run's ReportScope. */
export function scopeLabel(scope: any): string | null {
  if (!scope || typeof scope !== 'object') return null;
  var page = scope.pageName ? 'page \u201c' + scope.pageName + '\u201d' : 'current page';
  if (scope.type === 'page') return 'Whole ' + page;
  var names: string[] = Array.isArray(scope.rootNodeNames) ? scope.rootNodeNames : [];
  var n = Array.isArray(scope.rootNodeIds) ? scope.rootNodeIds.length : names.length;
  if (n === 1 && names[0]) return 'Selected layer \u201c' + names[0] + '\u201d on ' + page;
  return n + ' selected layer' + (n === 1 ? '' : 's') + ' on ' + page;
}

export function renderHeader(h: HeaderInfo | null): string {
  var html = '<div class="std-header-title">FIGMAKIT STANDARDS</div>';
  if (!h) return html + '<div class="std-muted">Loading standards&hellip;</div>';
  html += '<div>Design System: <strong>' + esc(h.designSystem || 'Unknown') + '</strong></div>';
  html += '<div>Ruleset: <strong>' + esc(h.rulesetVersion || '—') + '</strong>';
  if (h.configSource) html += ' <span class="std-muted">(config: ' + esc(h.configSource) + ')</span>';
  html += '</div>';
  if (h.scopeLabel) html += '<div>Validated: <strong>' + esc(h.scopeLabel) + '</strong></div>';
  var parts: string[] = [];
  if (h.registryStatus) parts.push(String(h.registryStatus));
  if (h.registrySource) parts.push(String(h.registrySource));
  html += '<div>Registry: <strong>' + esc(h.registryVersion || '—') + '</strong>' +
    (parts.length ? ' (' + esc(parts.join(', ')) + ')' : '') + '</div>';
  return html;
}

export function renderRegistryNotice(registryStatus: string | null | undefined, locked?: boolean): string {
  if (locked && (registryStatus === 'draft' || registryStatus === 'missing' || registryStatus === 'invalid' || registryStatus === 'error')) {
    return '<div class="std-notice std-notice-amber">Design standards have not been set up for this plugin yet. Contact your design-system admin.</div>';
  }
  if (registryStatus === 'draft') {
    return '<div class="std-notice std-notice-amber">Registry is a DRAFT with placeholder keys — readiness cannot be certified until it is populated.</div>';
  }
  if (registryStatus === 'missing' || registryStatus === 'invalid' || registryStatus === 'error') {
    return '<div class="std-notice std-notice-error">Component registry could not be loaded — readiness cannot be certified.</div>';
  }
  return '';
}

export function renderSummary(totals: any): string {
  if (!totals) return '';
  function n(v: any) { return typeof v === 'number' ? v : 0; }
  return '<div class="std-summary">' +
    '<span class="std-sum-pass">&#x2713; <strong>' + n(totals.passedChecks) + '</strong> checks passed</span>' +
    '<span class="std-sum-error">&#x2715; <strong>' + n(totals.errors) + '</strong> errors</span>' +
    '<span class="std-sum-warning">&#x26A0; <strong>' + n(totals.warnings) + '</strong> warnings</span>' +
    '<span class="std-sum-info">&#x2139; <strong>' + n(totals.infos) + '</strong> info</span>' +
    '</div>';
}

/** Readiness status block. Reasons beyond `maxVisible` are collapsed into a <details>. */
export function renderStatus(readiness: any, maxVisible?: number): string {
  if (!readiness) return '';
  var info = statusInfo(readiness.status);
  var limit = typeof maxVisible === 'number' ? maxVisible : 3;
  var html = '<div class="std-status ' + info.cls + '"><div class="std-status-title">' + esc(info.label) + '</div>';
  var reasons: string[] = readiness.reasons || [];
  if (reasons.length) {
    html += '<ul>';
    for (var i = 0; i < Math.min(limit, reasons.length); i++) html += '<li>' + esc(reasons[i]) + '</li>';
    html += '</ul>';
    if (reasons.length > limit) {
      html += '<details><summary>Show ' + (reasons.length - limit) + ' more</summary><ul>';
      for (var j = limit; j < reasons.length; j++) html += '<li>' + esc(reasons[j]) + '</li>';
      html += '</ul></details>';
    }
  }
  var excepted = readiness.exceptedIssues ? readiness.exceptedIssues.length : 0;
  if (readiness.status === 'READY_WITH_EXCEPTIONS' && excepted) {
    html += '<div>' + excepted + ' blocking issue' + (excepted === 1 ? '' : 's') + ' covered by approved exceptions.</div>';
  }
  html += '</div>';
  return html;
}

export interface IssueRenderOptions {
  /** Issue id whose inline panel is open, and which panel. */
  openIssueId?: string | null;
  openMode?: 'exception' | 'preview' | null;
  /** Fix preview reply for the open issue (null while loading). */
  issuePreview?: { operations: any[]; skipped: any[] } | null;
  exceptionDraft?: { reason: string; expires: string };
  ruleTitles?: Record<string, string>;
  /** Show "Add exception" buttons (false for designers in a locked build). Default true. */
  canAddExceptions?: boolean;
}

export function renderOperationList(operations: any[], skipped: any[]): string {
  var html = '';
  if (operations && operations.length) {
    html += '<ul class="std-op-list">';
    for (var i = 0; i < operations.length; i++) {
      var op = operations[i];
      var kind = op.kind === 'REQUIRES_CONFIRMATION' ? ' <span class="std-badge std-fix-confirm">CONFIRM</span>' : '';
      html += '<li>' + esc(op.description || op.kind || 'Operation') + kind + '</li>';
    }
    html += '</ul>';
  } else {
    html += '<div class="std-muted">No operations to apply.</div>';
  }
  if (skipped && skipped.length) {
    html += '<div class="std-muted" style="margin-top:4px">Skipped ' + skipped.length + ':</div><ul class="std-op-list std-muted">';
    for (var j = 0; j < skipped.length; j++) html += '<li>' + esc(skipped[j].reason || skipped[j].issueId || '') + '</li>';
    html += '</ul>';
  }
  return html;
}

export function renderIssueItem(issue: any, opts?: IssueRenderOptions): string {
  var o = opts || {};
  var sev = issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : 'info';
  var id = esc(issue.id);
  var html = '<div class="std-issue sev-' + sev + (issue.exception ? ' excepted' : '') + '" data-issue-id="' + id + '">';
  html += '<div class="std-issue-body" data-std-action="select" title="Select layer in canvas">';
  html += '<div class="std-issue-top">' + severityBadge(sev) + certaintyBadge(issue.certainty) +
    '<span class="std-issue-msg">' + esc(issue.message) + '</span></div>';
  var path = issue.nodePath || issue.nodeName || '';
  if (path) html += '<div class="std-issue-path">' + esc(path) + '</div>';
  var ruleTitle = o.ruleTitles && o.ruleTitles[issue.ruleId];
  html += '<div class="std-issue-rule">' + esc(issue.ruleId) + (ruleTitle ? ' — ' + esc(ruleTitle) : '') + '</div>';
  if (issue.suggestion) html += '<div class="std-issue-detail">Suggested: ' + esc(issue.suggestion) + '</div>';
  if (issue.expected || issue.actual) {
    var ea = '';
    if (issue.expected) ea += 'Expected: ' + esc(issue.expected);
    if (issue.actual) ea += (ea ? ' &middot; ' : '') + 'Actual: ' + esc(issue.actual);
    html += '<div class="std-issue-detail">' + ea + '</div>';
  }
  if (issue.fix && issue.fix.description) html += '<div class="std-issue-detail std-muted">Fix: ' + esc(issue.fix.description) + '</div>';
  html += '<div class="std-issue-badges">' + fixBadge(issue) + exceptionBadge(issue) + '</div>';
  html += '</div>';

  // Actions
  var actions = '';
  if (canFixIssue(issue)) actions += '<button class="btn btn-secondary btn-sm" data-std-action="fix">Fix</button>';
  if (issue.exception) {
    actions += '<button class="btn btn-secondary btn-sm" data-std-action="remove-exception">Remove exception</button>';
  } else if (!isInternalIssue(issue) && !(opts && opts.canAddExceptions === false)) {
    actions += '<button class="btn btn-secondary btn-sm" data-std-action="open-exception">Add exception</button>';
  }
  if (actions) html += '<div class="std-issue-actions">' + actions + '</div>';

  // Inline panels
  if (o.openIssueId === issue.id && o.openMode === 'exception') {
    var d = o.exceptionDraft || { reason: '', expires: '' };
    html += '<div class="std-inline">' +
      '<textarea rows="2" data-std-field="exception-reason" placeholder="Reason for the exception (required by policy)">' + esc(d.reason) + '</textarea>' +
      '<div class="std-inline-row">Expires (optional) <input type="date" data-std-field="exception-expires" value="' + esc(d.expires) + '"></div>' +
      '<div class="std-inline-row">' +
      '<button class="btn btn-primary btn-sm" data-std-action="submit-exception">Add exception</button>' +
      '<button class="btn btn-secondary btn-sm" data-std-action="cancel-inline">Cancel</button></div></div>';
  } else if (o.openIssueId === issue.id && o.openMode === 'preview') {
    html += '<div class="std-inline"><strong>Fix preview</strong>';
    if (!o.issuePreview) {
      html += '<div class="std-muted">Loading preview&hellip;</div>';
      html += '<div class="std-inline-row"><button class="btn btn-secondary btn-sm" data-std-action="cancel-inline">Cancel</button></div>';
    } else {
      html += renderOperationList(o.issuePreview.operations, o.issuePreview.skipped);
      html += '<div class="std-muted" style="margin-top:4px">This fix changes the design and needs your confirmation. Use Cmd/Ctrl+Z to undo.</div>';
      html += '<div class="std-inline-row">';
      if (o.issuePreview.operations && o.issuePreview.operations.length) {
        html += '<button class="btn btn-primary btn-sm" data-std-action="confirm-fix">Confirm &amp; apply</button>';
      }
      html += '<button class="btn btn-secondary btn-sm" data-std-action="cancel-inline">Cancel</button></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

export const MAX_RENDERED_ISSUES = 500;

export function renderIssueList(
  issues: any[] | null,
  filters: StdFilters,
  opts?: IssueRenderOptions & { collapsedGroups?: Record<string, boolean> }
): string {
  if (!issues) {
    return '<div class="results-empty">Select frames (or nothing, to check the whole page) and click Run Validation</div>';
  }
  if (issues.length === 0) return '<div class="results-empty">No issues found &#x2713;</div>';
  var shown = filterIssues(issues, filters);
  if (shown.length === 0) return '<div class="results-empty">No issues match the current filters (' + issues.length + ' hidden)</div>';
  var o = opts || {};
  var truncated = shown.length > MAX_RENDERED_ISSUES ? shown.length - MAX_RENDERED_ISSUES : 0;
  if (truncated) shown = shown.slice(0, MAX_RENDERED_ISSUES);
  var html = '';
  if (filters.groupByRule) {
    var groups = groupIssuesByRule(shown, o.ruleTitles);
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var collapsed = !!(o.collapsedGroups && o.collapsedGroups[grp.ruleId]);
      html += '<div class="std-group">';
      html += '<div class="std-group-header" data-std-action="toggle-group" data-rule-id="' + esc(grp.ruleId) + '">' +
        '<span class="std-group-caret">' + (collapsed ? '&#x25B8;' : '&#x25BE;') + '</span>' +
        '<span class="std-group-title">' + esc(grp.title) + ' <span class="std-muted">' + esc(grp.ruleId) + '</span></span>' +
        '<span class="token-section-count">' + grp.issues.length + '</span></div>';
      if (!collapsed) {
        for (var k = 0; k < grp.issues.length; k++) html += renderIssueItem(grp.issues[k], o);
      }
      html += '</div>';
    }
  } else {
    for (var i = 0; i < shown.length; i++) html += renderIssueItem(shown[i], o);
  }
  if (truncated) {
    html += '<div class="results-empty">' + truncated + ' more issue' + (truncated === 1 ? '' : 's') + ' not shown — narrow the filters or export the report.</div>';
  }
  return html;
}

export function renderSafeFixPreview(preview: { operations: any[]; skipped: any[] } | null, loading: boolean): string {
  if (!preview && !loading) return '';
  var html = '<div class="std-notice std-notice-info"><strong>Fix Safe Issues — preview</strong>';
  if (!preview) {
    html += '<div>Loading preview&hellip;</div>';
  } else {
    html += renderOperationList(preview.operations, preview.skipped);
    html += '<div style="margin-top:4px">Fixes are applied in a single pass and validation re-runs automatically. Use Cmd/Ctrl+Z to undo.</div>';
  }
  html += '<div class="std-inline-row">';
  if (preview && preview.operations && preview.operations.length) {
    html += '<button class="btn btn-primary btn-sm" data-std-action="apply-safe">Apply ' + preview.operations.length + ' fix' + (preview.operations.length === 1 ? '' : 'es') + '</button>';
  }
  html += '<button class="btn btn-secondary btn-sm" data-std-action="cancel-safe">Cancel</button></div></div>';
  return html;
}

export function renderRules(rules: any[] | null | undefined): string {
  if (!rules || rules.length === 0) return '<div class="std-muted">No rules loaded.</div>';
  var html = '';
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    var sev = r.severity === 'off' ? 'off' : String(r.severity || 'off');
    var badge = sev === 'off'
      ? '<span class="std-badge std-fix-manual">OFF</span>'
      : severityBadge(sev);
    html += '<div class="std-rule"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' + badge +
      '<span class="std-rule-id">' + esc(r.id) + '</span>' +
      (r.fixable ? '<span class="std-badge std-fix-safe">FIXABLE</span>' : '') +
      (r.category ? '<span class="std-muted">' + esc(r.category) + '</span>' : '') + '</div>';
    if (r.description) html += '<div>' + esc(r.description) + '</div>';
    if (r.docs) html += '<details><summary>Docs</summary><div class="std-rule-docs">' + esc(r.docs) + '</div></details>';
    html += '</div>';
  }
  return html;
}

export function renderVerifyResult(msg: any): string {
  var resolved = (msg && msg.resolved) || [];
  var unresolved = (msg && msg.unresolved) || [];
  var placeholders = (msg && msg.placeholders) || [];
  var diagnostics = (msg && msg.diagnostics) || [];
  // The controller sets ok:false when the registry is invalid or still has placeholder keys.
  var ok = msg && typeof msg.ok === 'boolean' ? msg.ok : unresolved.length === 0 && placeholders.length === 0;
  var invalid = !!msg && msg.ok === false && resolved.length === 0 && unresolved.length === 0 &&
    placeholders.length === 0 && diagnostics.length > 0;
  if (invalid) {
    return renderDiagnostics(collectDiagnostics({ diagnostics: { registry: diagnostics } }));
  }
  var html = '<div class="std-notice ' + (ok ? 'std-notice-success' : 'std-notice-amber') + '">';
  html += '<strong>' + resolved.length + ' key' + (resolved.length === 1 ? '' : 's') + ' resolved, ' +
    unresolved.length + ' unresolved' +
    (placeholders.length ? ', ' + placeholders.length + ' placeholder' + (placeholders.length === 1 ? '' : 's') : '') +
    '</strong>';
  if (placeholders.length) {
    html += '<div>Placeholder keys must be replaced with real component keys (use the registry helper):</div>';
    html += '<ul class="std-op-list">';
    for (var p = 0; p < placeholders.length; p++) {
      html += '<li>' + esc(placeholders[p].componentId) + ': <span class="std-diag-code">' + esc(placeholders[p].key) + '</span></li>';
    }
    html += '</ul>';
  }
  if (unresolved.length) {
    html += '<ul class="std-op-list">';
    for (var i = 0; i < unresolved.length; i++) {
      var u = unresolved[i];
      html += '<li>' + esc(u.componentId) + ': <span class="std-diag-code">' + esc(u.key) + '</span>' +
        (u.error ? ' — ' + esc(u.error) : '') + '</li>';
    }
    html += '</ul>';
  }
  if (msg && msg.note) html += '<div class="std-muted">' + esc(msg.note) + '</div>';
  html += '</div>';
  return html;
}

export function renderFixResult(msg: any): string {
  if (msg && msg.refused) {
    return '<div class="std-notice std-notice-error">' + esc(msg.reason || 'Fixes were not applied.') + '</div>';
  }
  function count(v: any): number {
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return v.length;
    return 0;
  }
  var applied = count(msg && msg.applied);
  var failedList = msg && Array.isArray(msg.failed) ? msg.failed : [];
  var failed = count(msg && msg.failed);
  var html = '<div class="std-notice ' + (failed ? 'std-notice-amber' : 'std-notice-success') + '">';
  html += 'Applied ' + applied + ' fix' + (applied === 1 ? '' : 'es') + (failed ? ', ' + failed + ' failed' : '') +
    '. Use Cmd/Ctrl+Z to undo.';
  if (failedList.length) {
    html += '<ul class="std-op-list">';
    for (var i = 0; i < failedList.length; i++) {
      var f = failedList[i];
      var text = typeof f === 'string' ? f : (f.reason || f.error || f.message || f.issueId || 'Failed');
      html += '<li>' + esc(text) + '</li>';
    }
    html += '</ul>';
  }
  html += '</div>';
  return html;
}

export function renderMarkReadyResult(msg: any): string {
  if (!msg) return '';
  if (msg.ok) {
    return '<div class="std-notice std-notice-success"><strong>Marked ready (local record). This is not an organization-wide approval.</strong>' +
      (msg.contentHash ? '<div class="std-diag-code">Report hash: ' + esc(msg.contentHash) + '</div>' : '') + '</div>';
  }
  var reasons: string[] = msg.reasons || [];
  var html = '<div class="std-notice std-notice-error"><strong>Not marked ready.</strong>';
  if (reasons.length) {
    html += '<ul class="std-op-list">';
    for (var i = 0; i < reasons.length; i++) html += '<li>' + esc(reasons[i]) + '</li>';
    html += '</ul>';
  }
  html += '</div>';
  return html;
}

export function renderMessage(level: string, text: string): string {
  var cls = level === 'error' ? 'std-notice-error' : level === 'success' ? 'std-notice-success' :
    level === 'warning' ? 'std-notice-amber' : 'std-notice-info';
  return '<div class="std-notice ' + cls + '">' + esc(text) + '</div>';
}

/** Mark Ready is only offered for a fresh, ready result. The main thread re-validates regardless. */
export function canMarkReady(readiness: any, stale: boolean, busy: boolean): boolean {
  return !!readiness && readiness.ready === true && !stale && !busy;
}

/** Convert a yyyy-mm-dd date input value into an ISO timestamp at the end of that UTC day. */
export function expiryToIso(dateValue: string): string | undefined {
  if (!dateValue || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return undefined;
  return dateValue + 'T23:59:59.999Z';
}

// ---------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------

interface UiApi {
  post(msg: any): void;
  setStatus(text: string): void;
}

interface StdState {
  meta: any | null;
  result: any | null;
  readiness: any | null;
  diagnostics: DiagnosticLike[];
  issuesById: Record<string, any>;
  stale: boolean;
  busy: string | null;
  filters: StdFilters;
  collapsedGroups: Record<string, boolean>;
  openIssueId: string | null;
  openMode: 'exception' | 'preview' | null;
  issuePreview: { operations: any[]; skipped: any[] } | null;
  safePreview: { operations: any[]; skipped: any[] } | null;
  safePreviewLoading: boolean;
  pendingPreview: { kind: 'safe' } | { kind: 'issue'; issueId: string } | null;
  exceptionDraft: { reason: string; expires: string };
  configLoaded: { configJson: string; registryJson: string } | null;
  reloadConfigOnState: boolean;
  ignoreSelectionUntil: number;
  initialized: boolean;
  /** Registry meta and ruleset version from the latest standards-result (shown in the header). */
  lastRegistryMeta: any | null;
  lastRulesetVersion: string | null;
  /** Scope of the latest standards-result (re-sent with Mark Ready / Export so they validate the same roots). */
  lastScope: any | null;
}

var api: UiApi | null = null;
var st: StdState = {
  meta: null,
  result: null,
  readiness: null,
  diagnostics: [],
  issuesById: {},
  stale: false,
  busy: null,
  filters: {
    error: DEFAULT_FILTERS.error, warning: DEFAULT_FILTERS.warning, info: DEFAULT_FILTERS.info,
    groupByRule: DEFAULT_FILTERS.groupByRule, fixableOnly: DEFAULT_FILTERS.fixableOnly,
    needsReviewOnly: DEFAULT_FILTERS.needsReviewOnly,
  },
  collapsedGroups: {},
  openIssueId: null,
  openMode: null,
  issuePreview: null,
  safePreview: null,
  safePreviewLoading: false,
  pendingPreview: null,
  exceptionDraft: { reason: '', expires: '' },
  configLoaded: null,
  reloadConfigOnState: false,
  ignoreSelectionUntil: 0,
  initialized: false,
  lastRegistryMeta: null,
  lastRulesetVersion: null,
  lastScope: null,
};

function el(id: string): HTMLElement | null { return document.getElementById(id); }
function setHtml(id: string, html: string) { var e = el(id); if (e) e.innerHTML = html; }
function send(msg: any) { if (api) api.post(msg); }
function status(text: string) { if (api) api.setStatus(text); }

function ruleTitles(): Record<string, string> {
  var map: Record<string, string> = {};
  var rules = st.meta && st.meta.rules ? st.meta.rules : [];
  for (var i = 0; i < rules.length; i++) map[rules[i].id] = rules[i].description || rules[i].id;
  var sums = st.result && st.result.ruleSummaries ? st.result.ruleSummaries : [];
  for (var j = 0; j < sums.length; j++) if (!map[sums[j].ruleId]) map[sums[j].ruleId] = sums[j].description || sums[j].ruleId;
  return map;
}

function showMessage(level: string, text: string) {
  setHtml('std-message', text ? renderMessage(level, text) : '');
}

function headerInfo(): HeaderInfo | null {
  if (!st.meta && !st.result) return null;
  var m = st.meta || {};
  // After the stored standards changed (lastRegistryMeta cleared by standards-state), the previous
  // run's registry/ruleset must not be shown: use the current standards metadata.
  var useRun = !!st.lastRegistryMeta;
  var r = useRun ? st.result || {} : {};
  var reg = st.lastRegistryMeta || {};
  return {
    designSystem: reg.designSystem || r.designSystem || m.designSystem,
    rulesetVersion: st.lastRulesetVersion || r.rulesetVersion || m.rulesetVersion,
    registryVersion: reg.version || r.registryVersion || m.registryVersion,
    registryStatus: reg.status || m.registryStatus,
    registrySource: reg.source || m.registrySource,
    configSource: m.configSource,
    scopeLabel: st.result ? scopeLabel(st.lastScope) : null,
  };
}

function renderAll() {
  var h = headerInfo();
  setHtml('std-header', renderHeader(h));
  setHtml('std-registry-notice', renderRegistryNotice(h ? h.registryStatus : null, LOCKED_BUILD));
  setHtml('std-stale', st.stale && st.result
    ? '<div class="std-stale">Results may be out of date — re-run</div>' : '');
  setHtml('std-summary', st.result ? renderSummary(st.result.totals) : '');
  setHtml('std-status', renderStatus(st.readiness));
  // Designers can't act on configuration diagnostics; they only appear in the admin build.
  setHtml('std-diagnostics', LOCKED_BUILD ? '' : renderDiagnostics(st.diagnostics));
  setHtml('std-fix-preview', renderSafeFixPreview(st.safePreview, st.safePreviewLoading));
  renderIssues();
  renderFilters();
  refreshStandardsControls();
}

function renderIssues() {
  setHtml('std-issues', renderIssueList(st.result ? st.result.issues || [] : null, st.filters, {
    openIssueId: st.openIssueId,
    openMode: st.openMode,
    issuePreview: st.issuePreview,
    exceptionDraft: st.exceptionDraft,
    ruleTitles: ruleTitles(),
    collapsedGroups: st.collapsedGroups,
    canAddExceptions: !st.meta || st.meta.canAddExceptions !== false,
  }));
}

function renderFilters() {
  var chips = document.querySelectorAll('#std-toolbar [data-std-filter]');
  for (var i = 0; i < chips.length; i++) {
    var c = chips[i] as HTMLElement;
    var key = c.getAttribute('data-std-filter') as keyof StdFilters;
    if (st.filters[key]) c.classList.add('active'); else c.classList.remove('active');
  }
}

/** Re-apply enabled/disabled state of Standards action buttons (also called after other tabs re-enable .btn-primary). */
export function refreshStandardsControls() {
  if (typeof document === 'undefined') return;
  var busy = !!st.busy;
  var run = el('std-run') as HTMLButtonElement | null;
  if (run) run.disabled = busy;
  var fixSafe = el('std-fix-safe') as HTMLButtonElement | null;
  if (fixSafe) fixSafe.disabled = busy || !st.result || countSafeFixes(st.result.issues) === 0;
  var exp = el('std-export') as HTMLButtonElement | null;
  if (exp) exp.disabled = busy;
  var mark = el('std-mark-ready') as HTMLButtonElement | null;
  if (mark) {
    mark.disabled = !canMarkReady(st.readiness, st.stale, busy);
    mark.title = mark.disabled
      ? (st.stale ? 'Re-run validation first' : 'Available when the latest validation is ready')
      : 'Re-validates, then records readiness in this file';
  }
}

function setBusy(what: string | null) {
  st.busy = what;
  refreshStandardsControls();
}

function closeInline() {
  st.openIssueId = null;
  st.openMode = null;
  st.issuePreview = null;
  if (st.pendingPreview && st.pendingPreview.kind === 'issue') st.pendingPreview = null;
}

function markStale() {
  if (st.result && !st.stale) {
    st.stale = true;
    renderAll();
  }
}

function runValidation() {
  setBusy('run');
  showMessage('', '');
  setHtml('std-mark-ready-result', '');
  status('Running standards validation...');
  send({ type: 'standards-run' });
}

function onPanelClick(e: Event) {
  var target = e.target as HTMLElement | null;
  if (!target || !target.closest) return;

  var filterBtn = target.closest('[data-std-filter]') as HTMLElement | null;
  if (filterBtn) {
    var key = filterBtn.getAttribute('data-std-filter') as keyof StdFilters;
    st.filters[key] = !st.filters[key];
    renderFilters();
    renderIssues();
    return;
  }

  var resetBtn = target.closest('[data-std-reset]') as HTMLButtonElement | null;
  if (resetBtn) {
    onResetClick(resetBtn);
    return;
  }

  var actionEl = target.closest('[data-std-action]') as HTMLElement | null;
  if (!actionEl) return;
  var action = actionEl.getAttribute('data-std-action');

  if (action === 'apply-safe') {
    st.safePreview = null;
    st.safePreviewLoading = false;
    st.stale = true;
    setBusy('fix');
    status('Applying safe fixes...');
    send({ type: 'standards-apply-fixes', mode: 'safe', confirmed: false });
    renderAll();
    return;
  }
  if (action === 'cancel-safe') {
    st.safePreview = null;
    st.safePreviewLoading = false;
    if (st.pendingPreview && st.pendingPreview.kind === 'safe') st.pendingPreview = null;
    renderAll();
    return;
  }
  if (action === 'toggle-group') {
    var rid = actionEl.getAttribute('data-rule-id') || '';
    st.collapsedGroups[rid] = !st.collapsedGroups[rid];
    renderIssues();
    return;
  }

  var itemEl = actionEl.closest('[data-issue-id]') as HTMLElement | null;
  var issueId = itemEl ? itemEl.getAttribute('data-issue-id') || '' : '';
  var issue = issueId ? st.issuesById[issueId] : null;
  if (!issue) return;

  if (action === 'select') {
    if (!issue.nodeId) return;
    // Selecting a layer fires selection-change; that must not mark results stale.
    st.ignoreSelectionUntil = Date.now() + 1500;
    send({ type: 'standards-select', nodeId: issue.nodeId });
    return;
  }
  if (action === 'fix') {
    var kind = fixKindOf(issue);
    if (kind === 'SAFE') {
      closeInline();
      st.stale = true;
      setBusy('fix');
      status('Applying fix...');
      send({ type: 'standards-apply-fixes', mode: 'selected', issueIds: [issue.id], confirmed: false });
      renderAll();
    } else if (kind === 'REQUIRES_CONFIRMATION') {
      st.openIssueId = issue.id;
      st.openMode = 'preview';
      st.issuePreview = null;
      st.pendingPreview = { kind: 'issue', issueId: issue.id };
      send({ type: 'standards-fix-preview', mode: 'selected', issueIds: [issue.id] });
      renderIssues();
    }
    return;
  }
  if (action === 'confirm-fix') {
    if (st.openIssueId !== issue.id || !st.issuePreview) return;
    // Never confirm a preview built from out-of-date results.
    if (st.stale) {
      showMessage('error', 'Results are out of date. Re-run validation and review the fix again.');
      closeInline();
      renderIssues();
      return;
    }
    // Bind the confirmation to exactly the operations shown in the preview.
    var expected = (st.issuePreview.operations || []).map(function(o: any) { return o && o.key; });
    closeInline();
    st.stale = true;
    setBusy('fix');
    status('Applying confirmed fix...');
    send({ type: 'standards-apply-fixes', mode: 'selected', issueIds: [issue.id], confirmed: true, expectedOperations: expected });
    renderAll();
    return;
  }
  if (action === 'open-exception') {
    if (st.openIssueId !== issue.id || st.openMode !== 'exception') st.exceptionDraft = { reason: '', expires: '' };
    st.openIssueId = issue.id;
    st.openMode = 'exception';
    st.issuePreview = null;
    renderIssues();
    var ta = document.querySelector('#std-issues [data-std-field="exception-reason"]') as HTMLTextAreaElement | null;
    if (ta) ta.focus();
    return;
  }
  if (action === 'submit-exception') {
    var reason = st.exceptionDraft.reason.trim();
    var payload: any = { type: 'standards-add-exception', issueId: issue.id, reason: reason };
    var iso = expiryToIso(st.exceptionDraft.expires);
    if (iso) payload.expiresAt = iso;
    closeInline();
    st.stale = true;
    setBusy('exception');
    status('Recording exception...');
    send(payload);
    renderAll();
    return;
  }
  if (action === 'remove-exception') {
    if (!issue.exception || !issue.exception.id) return;
    st.stale = true;
    setBusy('exception');
    status('Removing exception...');
    send({ type: 'standards-remove-exception', exceptionId: issue.exception.id });
    renderAll();
    return;
  }
  if (action === 'cancel-inline') {
    closeInline();
    renderIssues();
    return;
  }
}

function onPanelInput(e: Event) {
  var t = e.target as HTMLElement | null;
  if (!t) return;
  var field = t.getAttribute('data-std-field');
  if (field === 'exception-reason') st.exceptionDraft.reason = (t as HTMLTextAreaElement).value;
  else if (field === 'exception-expires') st.exceptionDraft.expires = (t as HTMLInputElement).value;
}

var resetTimers: Record<string, any> = {};
function onResetClick(btn: HTMLButtonElement) {
  var target = btn.getAttribute('data-std-reset') || 'all';
  // Two-step confirm (native confirm() dialogs are unavailable in plugin iframes).
  if (btn.getAttribute('data-armed') !== '1') {
    btn.setAttribute('data-armed', '1');
    btn.setAttribute('data-label', btn.textContent || '');
    btn.textContent = 'Click again to reset';
    if (resetTimers[target]) clearTimeout(resetTimers[target]);
    resetTimers[target] = setTimeout(function() {
      btn.removeAttribute('data-armed');
      btn.textContent = btn.getAttribute('data-label') || 'Reset';
    }, 3000);
    return;
  }
  if (resetTimers[target]) clearTimeout(resetTimers[target]);
  btn.removeAttribute('data-armed');
  btn.textContent = btn.getAttribute('data-label') || 'Reset';
  st.reloadConfigOnState = true;
  setHtml('std-config-diag', '');
  status('Resetting ' + target + ' to bundled defaults...');
  send({ type: 'standards-reset-config', target: target });
}

function requestConfig() {
  send({ type: 'standards-get-config' });
}

function onSaveConfig() {
  var cfgEl = el('std-config-json') as HTMLTextAreaElement | null;
  var regEl = el('std-registry-json') as HTMLTextAreaElement | null;
  if (!cfgEl || !regEl) return;
  var payload: any = { type: 'standards-save-config' };
  var loaded = st.configLoaded || { configJson: '', registryJson: '' };
  // Only send documents that were edited, so untouched bundled defaults are not
  // silently copied into the file as document overrides.
  if (cfgEl.value !== loaded.configJson) payload.configJson = cfgEl.value;
  if (regEl.value !== loaded.registryJson) payload.registryJson = regEl.value;
  if (payload.configJson === undefined && payload.registryJson === undefined) {
    setHtml('std-config-diag', renderMessage('info', 'No changes to save.'));
    return;
  }
  setHtml('std-config-diag', '<div class="std-muted">Saving&hellip;</div>');
  send(payload);
}

function downloadJson(filename: string, json: string) {
  try {
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    status('Report downloaded: ' + filename);
  } catch (e) {
    showMessage('error', 'Could not download the report.');
  }
}

/** Wire DOM listeners. Call once from ui.ts. */
export function initStandardsUI(uiApi: UiApi) {
  api = uiApi;
  if (st.initialized) return;
  st.initialized = true;

  var panel = el('panel-standards');
  if (!panel) return;
  panel.addEventListener('click', onPanelClick);
  panel.addEventListener('input', onPanelInput);
  panel.addEventListener('change', onPanelInput);

  var run = el('std-run');
  if (run) run.addEventListener('click', runValidation);

  var fixSafe = el('std-fix-safe');
  if (fixSafe) fixSafe.addEventListener('click', function() {
    st.safePreview = null;
    st.safePreviewLoading = true;
    st.pendingPreview = { kind: 'safe' };
    send({ type: 'standards-fix-preview', mode: 'safe' });
    renderAll();
  });

  var exp = el('std-export');
  if (exp) exp.addEventListener('click', function() {
    status('Building handoff report...');
    // Out-of-date results are re-validated before the report is built.
    var expMsg: any = { type: 'standards-export', rerun: st.stale || !st.result };
    // Re-validate the roots the results cover, not whatever is selected now.
    if (st.result && st.lastScope) expMsg.scope = st.lastScope;
    send(expMsg);
  });

  var mark = el('std-mark-ready');
  if (mark) mark.addEventListener('click', function() {
    if (!canMarkReady(st.readiness, st.stale, !!st.busy)) return;
    setBusy('mark-ready');
    setHtml('std-mark-ready-result', '');
    status('Re-validating before marking ready...');
    // Re-validate exactly the validated scope (click-to-select must not narrow it).
    var mrMsg: any = { type: 'standards-mark-ready' };
    if (st.lastScope) mrMsg.scope = st.lastScope;
    send(mrMsg);
  });

  var settings = el('std-settings');
  if (settings) settings.addEventListener('toggle', function() {
    if ((settings as HTMLDetailsElement).open && !st.configLoaded) requestConfig();
  });
  var save = el('std-save-config');
  if (save) save.addEventListener('click', onSaveConfig);
  var reload = el('std-reload-config');
  if (reload) reload.addEventListener('click', requestConfig);
  var helper = el('std-registry-helper');
  if (helper) helper.addEventListener('click', function() {
    setHtml('std-helper-info', 'Collecting components from selection&hellip;');
    send({ type: 'standards-registry-helper' });
  });
  var verify = el('std-verify-registry');
  if (verify) verify.addEventListener('click', function() {
    setHtml('std-verify-out', '<div class="std-muted">Verifying registry keys&hellip;</div>');
    send({ type: 'standards-verify-registry' });
  });

  if (LOCKED_BUILD) {
    enterLockedLayout();
    send({ type: 'standards-init' });
    // Check the design as soon as the plugin opens: nothing for the designer to configure.
    runValidation();
    renderAll();
    return;
  }

  // Load standards metadata when the tab is first opened.
  var tab = document.querySelector('.tab[data-tab="standards"]');
  var requested = false;
  if (tab) tab.addEventListener('click', function() {
    if (!requested) {
      requested = true;
      send({ type: 'standards-init' });
    }
  });
  renderAll();
}

/** Designer build: show only the Standards panel (the prep tools stay in the admin build). */
function enterLockedLayout() {
  var tabs = document.querySelector('.tabs') as HTMLElement | null;
  if (tabs) tabs.style.display = 'none';
  var title = document.querySelector('.header h1');
  if (title) title.textContent = 'FigmaKit Standards';
  var panels = document.querySelectorAll('.panel');
  for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
  var panel = el('panel-standards');
  if (panel) panel.classList.add('active');
  var settings = el('std-settings');
  if (settings) settings.style.display = 'none';
}

/** Selection changed on canvas (existing 'selection-change' message). */
export function onStandardsSelectionChange() {
  if (Date.now() < st.ignoreSelectionUntil) return;
  markStale();
}

/** Another feature modified the document (existing 'apply-result' message). */
export function onStandardsDocumentChanged() {
  markStale();
  refreshStandardsControls();
}

function applyResult(msg: any) {
  st.result = msg.result || null;
  st.readiness = msg.readiness || null;
  st.diagnostics = collectDiagnostics(msg);
  st.lastRegistryMeta = msg.registry || null;
  st.lastRulesetVersion = msg.rulesetVersion || null;
  st.lastScope = msg.scope || null;
  st.issuesById = {};
  var issues = st.result && st.result.issues ? st.result.issues : [];
  for (var i = 0; i < issues.length; i++) st.issuesById[issues[i].id] = issues[i];
  // A fix preview belongs to the results it was built from: new results invalidate it (the same
  // issue id can now carry a different fix).
  if (st.openMode === 'preview') closeInline();
  if (st.openIssueId && !st.issuesById[st.openIssueId]) closeInline();
  st.safePreview = null;
  st.safePreviewLoading = false;
  st.stale = false;
  st.busy = null;
  renderAll();
}

/**
 * Handle a standards-* message from the main thread. Returns true when handled.
 */
export function handleStandardsUIMessage(msg: any): boolean {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('standards-') !== 0) return false;
  switch (msg.type) {
    case 'standards-state': {
      st.meta = msg;
      // Locked designer build: no settings, no JSON, no registry tools.
      var settingsEl = el('std-settings');
      if (settingsEl) settingsEl.style.display = msg.adminTools === false ? 'none' : '';
      setHtml('std-rules', renderRules(msg.rules));
      if (st.reloadConfigOnState || st.stale || !st.result) {
        // Standards changed (save / reset) or no current run: the stored standards are authoritative
        // for the header and diagnostics, not the previous run's registry.
        st.lastRegistryMeta = null;
        st.lastRulesetVersion = null;
        st.diagnostics = collectDiagnostics(msg);
      }
      if (st.meta && msg.lastReadiness && !st.readiness) {
        // Previously recorded readiness is informational only; it never enables Mark Ready.
        var lr = msg.lastReadiness;
        showMessage('info', 'Last recorded: ' + (lr.status || 'unknown') + (lr.validatedAt ? ' at ' + lr.validatedAt : '') +
          (lr.validatedBy && lr.validatedBy.name ? ' by ' + lr.validatedBy.name : '') + '. Run validation to check the current design.');
      }
      if (st.reloadConfigOnState) {
        st.reloadConfigOnState = false;
        requestConfig();
        markStale();
      }
      renderAll();
      status('Standards loaded');
      return true;
    }
    case 'standards-progress':
      status('Standards: ' + (msg.stage || 'working') + '...');
      return true;
    case 'standards-result':
      applyResult(msg);
      status('Standards validation complete');
      return true;
    case 'standards-toast':
      if (st.busy) {
        st.busy = null;
        // A failed fix/exception request leaves the previous results in place.
        if (st.result) st.stale = true;
      }
      st.safePreviewLoading = false;
      showMessage(msg.level || 'info', msg.message || '');
      status(msg.level === 'error' ? 'Error: ' + (msg.message || '') : String(msg.message || ''));
      renderAll();
      return true;
    case 'standards-fix-preview': {
      var preview = { operations: msg.operations || [], skipped: msg.skipped || [] };
      var pending = st.pendingPreview;
      st.pendingPreview = null;
      if (pending && pending.kind === 'issue') {
        if (st.openIssueId === pending.issueId && st.openMode === 'preview') {
          st.issuePreview = preview;
          renderIssues();
        }
      } else if (pending && pending.kind === 'safe') {
        st.safePreview = preview;
        st.safePreviewLoading = false;
        setHtml('std-fix-preview', renderSafeFixPreview(st.safePreview, false));
      }
      return true;
    }
    case 'standards-fix-result':
      showMessage('', '');
      setHtml('std-message', renderFixResult(msg));
      if (msg.refused) {
        // No re-run follows a refusal: release the controls (results stay marked stale).
        st.busy = null;
        if (st.result) st.stale = true;
        status('Fixes not applied');
        renderAll();
      } else {
        status('Fixes applied — re-validating...');
      }
      return true;
    case 'standards-export':
      if (msg.json) downloadJson(msg.filename || 'figmakit-standards-report.json', msg.json);
      return true;
    case 'standards-mark-ready-result':
      st.busy = null;
      setHtml('std-mark-ready-result', renderMarkReadyResult(msg));
      status(msg.ok ? 'Marked ready (local record)' : 'Not ready for development');
      refreshStandardsControls();
      return true;
    case 'standards-config': {
      var cfgEl = el('std-config-json') as HTMLTextAreaElement | null;
      var regEl = el('std-registry-json') as HTMLTextAreaElement | null;
      var cj = msg.configJson || '';
      var rj = msg.registryJson || '';
      if (cfgEl) cfgEl.value = cj;
      if (regEl) regEl.value = rj;
      st.configLoaded = { configJson: cj, registryJson: rj };
      var cs = el('std-config-source');
      if (cs) cs.textContent = msg.configSource ? '(' + msg.configSource + ')' : '';
      var rs = el('std-registry-source');
      if (rs) rs.textContent = msg.registrySource ? '(' + msg.registrySource + ')' : '';
      return true;
    }
    case 'standards-config-saved': {
      var diags = collectDiagnostics({ diagnostics: msg.diagnostics });
      var out = msg.ok
        ? renderMessage('success', 'Saved to this file. Re-run validation to apply.')
        : renderMessage('error', 'Not saved — fix the errors below.');
      out += renderDiagnostics(diags);
      setHtml('std-config-diag', out);
      if (msg.ok) {
        var c2 = el('std-config-json') as HTMLTextAreaElement | null;
        var r2 = el('std-registry-json') as HTMLTextAreaElement | null;
        st.configLoaded = { configJson: c2 ? c2.value : '', registryJson: r2 ? r2.value : '' };
        st.reloadConfigOnState = true;
        markStale();
      }
      return true;
    }
    case 'standards-registry-helper': {
      var entries = msg.entries || [];
      setHtml('std-helper-info', esc(entries.length + ' component' + (entries.length === 1 ? '' : 's') +
        ' found in selection.' + (entries.length ? ' Copy the JSON below into the registry components array.' : '')));
      var ho = el('std-helper-out') as HTMLTextAreaElement | null;
      if (ho) {
        ho.value = msg.json || '';
        ho.style.display = entries.length ? 'block' : 'none';
      }
      return true;
    }
    case 'standards-verify-registry':
      setHtml('std-verify-out', renderVerifyResult(msg));
      return true;
  }
  return true;
}
