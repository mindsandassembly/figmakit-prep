/**
 * FigmaKit Standards — Figma main-thread controller.
 *
 * Glue between the Standards UI tab (messages prefixed `standards-`) and the pure lint
 * core in src/lint/**. Responsibilities:
 *  - load the effective registry / config / exceptions (document shared plugin data,
 *    falling back to the bundled JSON only when the document has NO override),
 *  - snapshot the scope (selection, else current page) and run the engine,
 *  - plan / apply whitelisted fixes and re-validate,
 *  - manage approved exceptions, the handoff report and the local readiness record.
 *
 * Readiness is never reported as true when anything goes wrong: every failure path either
 * produces a NOT_READY result with a synthetic internal error, or no readiness at all.
 *
 * All Figma access goes through injected `deps.figma` so the controller is unit-testable.
 * Only async node APIs are used (manifest `documentAccess: "dynamic-page"`).
 */

import type {
  ComponentRegistry,
  Diagnostic,
  DesignNode,
  HandoffReport,
  IssueException,
  LintConfig,
  LintIssue,
  LintRunResult,
  ReadinessResult,
  RegistryIndex,
  ReportScope,
  ResolvedConfig,
} from './lint/types';
import { INTERNAL_ERROR_RULE_ID, STANDARDS_DOC_KEYS, STANDARDS_SHARED_NAMESPACE } from './lint/types';
import { ALL_RULES } from './lint/rules/index';
import { BUNDLED_CONFIG, checkRegistryCompatibility, resolveConfig } from './lint/config';
import { createRegistryIndex, emptyRegistry, isPlaceholderKey, loadRegistry, validateRegistry } from './lint/registry';
import { buildDesignTree, createFigmaResolver } from './lint/snapshot';
import { runLint } from './lint/engine';
import { evaluateReadiness } from './lint/readiness';
import { buildHandoffReport } from './lint/reporter';
import { applyFixes, describeOperation, planFixes } from './lint/autofix';
import { canApprove, createException, isRuleExemptible, parseExceptions } from './lint/exceptions';
import { issueId } from './lint/hash';
import bundledRegistryJson from './standards/registry.json';

/** Version reported in handoff reports (matches package.json). */
export const STANDARDS_TOOL_VERSION = '1.0.0';

export const MARK_READY_NOTICE = 'Marked ready (local record). This is not an organization-wide approval.';

export interface ControllerDeps {
  figma: any;
  now(): string;
  postMessage(msg: any): void;
  /**
   * Admin tools (settings, document overrides, registry helper). Defaults to the bundled config's
   * `adminTools` flag; false = locked designer build.
   */
  adminTools: boolean;
}

export type StandardsSource = 'document' | 'bundled';

/** Effective standards documents for one run. */
export interface LoadedStandards {
  registry: RegistryIndex | null;
  registryDiagnostics: Diagnostic[];
  registrySource: StandardsSource;
  /** Raw registry text as stored (document) or pretty-printed bundled JSON. */
  registryText: string;
  config: ResolvedConfig;
  configDiagnostics: Diagnostic[];
  configSource: StandardsSource;
  configText: string;
  exceptions: IssueException[];
  exceptionDiagnostics: Diagnostic[];
}

export interface StandardsRun {
  result: LintRunResult;
  readiness: ReadinessResult;
  roots: DesignNode[];
  scope: ReportScope;
  config: ResolvedConfig;
  registry: RegistryIndex | null;
  exceptions: IssueException[];
  validatedAt: string;
  standards: LoadedStandards;
}

/** Module-scope state: the last completed validation run. */
var lastRun: StandardsRun | null = null;

/** Test hook: clear module state between tests. */
export function resetStandardsState(): void {
  lastRun = null;
}

/** Test/diagnostic hook: the last completed run (read-only use). */
export function getLastStandardsRun(): StandardsRun | null {
  return lastRun;
}

/** True for messages handled by this controller (type starts with "standards-"). */
export function isStandardsMessage(msg: any): boolean {
  return !!msg && typeof msg.type === 'string' && msg.type.indexOf('standards-') === 0;
}

function resolveDeps(partial?: Partial<ControllerDeps>): ControllerDeps {
  var f: any = partial && partial.figma !== undefined ? partial.figma : typeof figma !== 'undefined' ? figma : null;
  return {
    figma: f,
    now: partial && partial.now ? partial.now : function () { return new Date().toISOString(); },
    postMessage: partial && partial.postMessage
      ? partial.postMessage
      : function (m: any) { if (f && f.ui) f.ui.postMessage(m); },
    adminTools: partial && typeof partial.adminTools === 'boolean' ? partial.adminTools : BUNDLED_CONFIG.adminTools === true,
  };
}

function errorMessage(e: any): string {
  if (e && typeof e.message === 'string' && e.message) return e.message;
  return String(e);
}

function toast(deps: ControllerDeps, level: 'error' | 'warning' | 'info' | 'success', message: string): void {
  deps.postMessage({ type: 'standards-toast', level: level, message: message });
}

// ---------------------------------------------------------------------------
// Persistence (document-level shared plugin data)
// ---------------------------------------------------------------------------

function readDoc(f: any, key: string): string {
  try {
    var v = f.root.getSharedPluginData(STANDARDS_SHARED_NAMESPACE, key);
    return typeof v === 'string' ? v : '';
  } catch (e) {
    return '';
  }
}

function writeDoc(f: any, key: string, value: string): void {
  f.root.setSharedPluginData(STANDARDS_SHARED_NAMESPACE, key, value);
  // Each standards write is its own undo step (never merged with fixes or other edits).
  commitUndo(f);
}

/**
 * Close the current undo batch. Plugin edits are not committed to undo history until
 * figma.commitUndo() is called, so without this one Cmd/Ctrl+Z could revert several actions.
 */
function commitUndo(f: any): void {
  try {
    if (f && typeof f.commitUndo === 'function') f.commitUndo();
  } catch (e) {
    // commitUndo is best-effort
  }
}

function getCurrentUser(f: any): { id: string | null; name: string } | null {
  try {
    var u = f.currentUser;
    if (!u) return null;
    return { id: typeof u.id === 'string' ? u.id : null, name: typeof u.name === 'string' ? u.name : 'Unknown user' };
  } catch (e) {
    // figma.currentUser throws without the "currentuser" permission
    return null;
  }
}

// ---------------------------------------------------------------------------
// Loading standards
// ---------------------------------------------------------------------------

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/**
 * Load registry, config and exceptions for a run. A corrupt document override is NEVER
 * replaced by the bundled default: the corresponding document is reported with an error
 * diagnostic so readiness is denied.
 */
export function loadStandards(f: any, adminTools?: boolean): LoadedStandards {
  // Locked designer build: document overrides are ignored, so nobody can weaken the standards from a file.
  var useDocument = adminTools !== false;
  // --- registry ---
  var registry: RegistryIndex | null = null;
  var registryDiagnostics: Diagnostic[] = [];
  var registrySource: StandardsSource = 'bundled';
  var registryText = useDocument ? readDoc(f, STANDARDS_DOC_KEYS.registry) : '';
  if (registryText.trim() !== '') {
    registrySource = 'document';
    var parsedRegistry: unknown = undefined;
    var registryParsed = true;
    try {
      parsedRegistry = JSON.parse(registryText);
    } catch (e) {
      registryParsed = false;
      registryDiagnostics.push({
        level: 'error',
        code: 'invalid-json',
        message: 'The registry stored in this document is not valid JSON: ' + errorMessage(e),
      });
    }
    if (registryParsed) {
      var loadedDoc = loadRegistry(parsedRegistry);
      registry = loadedDoc.index;
      registryDiagnostics = loadedDoc.diagnostics;
    }
  } else {
    var loadedBundled = loadRegistry(bundledRegistryJson);
    registry = loadedBundled.index;
    registryDiagnostics = loadedBundled.diagnostics;
    registryText = pretty(bundledRegistryJson);
  }

  // --- config ---
  var configSource: StandardsSource = 'bundled';
  var configText = useDocument ? readDoc(f, STANDARDS_DOC_KEYS.config) : '';
  var configInput: LintConfig = BUNDLED_CONFIG;
  var configDiagnostics: Diagnostic[] = [];
  if (configText.trim() !== '') {
    configSource = 'document';
    try {
      configInput = JSON.parse(configText) as LintConfig;
    } catch (e) {
      // Run with the bundled rules so the designer still sees issues, but the error
      // diagnostic below guarantees readiness is denied.
      configInput = BUNDLED_CONFIG;
      configDiagnostics.push({
        level: 'error',
        code: 'invalid-json',
        message: 'The configuration stored in this document is not valid JSON: ' + errorMessage(e),
      });
    }
  } else {
    configText = pretty(BUNDLED_CONFIG);
  }
  var resolved = resolveConfig(configInput, ALL_RULES);
  configDiagnostics = configDiagnostics.concat(resolved.diagnostics);
  if (registry) configDiagnostics = configDiagnostics.concat(checkRegistryCompatibility(resolved.config, registry.version));

  // --- exceptions ---
  var parsedEx = parseExceptions(readDoc(f, STANDARDS_DOC_KEYS.exceptions));

  return {
    registry: registry,
    registryDiagnostics: registryDiagnostics,
    registrySource: registrySource,
    registryText: registryText,
    config: resolved.config,
    configDiagnostics: configDiagnostics,
    configSource: configSource,
    configText: configText,
    exceptions: parsedEx.exceptions,
    exceptionDiagnostics: parsedEx.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

type ScopeTarget = { nodes: any[]; scope: ReportScope };

function describeScope(nodes: any[], type: 'selection' | 'page', page: any): ScopeTarget {
  var ids: string[] = [];
  var names: string[] = [];
  for (var k = 0; k < nodes.length; k++) {
    var id = '';
    var name = '';
    try { id = String(nodes[k].id); } catch (e) { id = ''; }
    try { name = String(nodes[k].name); } catch (e) { name = ''; }
    ids.push(id);
    names.push(name);
  }
  var pageId = '';
  var pageName = '';
  try { pageId = page ? String(page.id || '') : ''; } catch (e) { pageId = ''; }
  try { pageName = page ? String(page.name || '') : ''; } catch (e) { pageName = ''; }
  return {
    nodes: nodes,
    scope: { type: type, pageId: pageId, pageName: pageName, rootNodeIds: ids, rootNodeNames: names },
  };
}

/**
 * Re-resolve the scope of an earlier run (sent back by the UI) so Mark Ready / Export validate the
 * same roots the user saw, not whatever is selected now (e.g. after click-to-select). Returns null
 * when the request is malformed or any root no longer exists.
 */
async function resolveRequestedScope(f: any, req: any): Promise<ScopeTarget | null> {
  if (!req || typeof req !== 'object') return null;
  var pageId = typeof req.pageId === 'string' ? req.pageId : '';
  try {
    if (req.type === 'page') {
      var current: any = f.currentPage;
      var page: any = current && current.id === pageId ? current : pageId ? await f.getNodeByIdAsync(pageId) : null;
      if (!page || page.type !== 'PAGE' || page.removed === true) return null;
      if (page !== current && typeof page.loadAsync === 'function') await page.loadAsync();
      var kids: any[] = [];
      var list = page.children || [];
      for (var i = 0; i < list.length; i++) kids.push(list[i]);
      return describeScope(kids, 'page', page);
    }
    if (req.type === 'selection') {
      var ids = Array.isArray(req.rootNodeIds) ? req.rootNodeIds : [];
      if (ids.length === 0) return null;
      var nodes: any[] = [];
      for (var j = 0; j < ids.length; j++) {
        if (typeof ids[j] !== 'string' || !ids[j]) return null;
        var n: any = await f.getNodeByIdAsync(ids[j]);
        if (!n || n.removed === true) return null;
        nodes.push(n);
      }
      return describeScope(nodes, 'selection', findPage(nodes[0]));
    }
  } catch (e) {
    return null;
  }
  return null;
}

/** Selection if non-empty, else the current page's children (same semantics as main.ts). */
function getScope(f: any): ScopeTarget {
  var page: any = null;
  try { page = f.currentPage; } catch (e) { page = null; }
  var nodes: any[] = [];
  var type: 'selection' | 'page' = 'page';
  try {
    var sel = page ? page.selection : null;
    if (sel && sel.length > 0) {
      type = 'selection';
      for (var i = 0; i < sel.length; i++) nodes.push(sel[i]);
    } else {
      var kids = page ? page.children : null;
      if (kids) for (var j = 0; j < kids.length; j++) nodes.push(kids[j]);
    }
  } catch (e) {
    nodes = [];
  }
  return describeScope(nodes, type, page);
}

// ---------------------------------------------------------------------------
// Validation run
// ---------------------------------------------------------------------------

function syntheticInternalError(code: string, message: string): LintIssue {
  return {
    id: issueId(INTERNAL_ERROR_RULE_ID, code, 'scope'),
    ruleId: INTERNAL_ERROR_RULE_ID,
    code: code,
    nodeId: '',
    nodeName: '',
    nodePath: '',
    severity: 'error',
    certainty: 'confirmed',
    message: message,
    fixable: false,
    blocking: true,
  };
}

function emptyTotals(): LintRunResult['totals'] {
  return { checks: 0, passedChecks: 0, errors: 0, warnings: 0, infos: 0, fixable: 0, safeFixable: 0, requiresReview: 0 };
}

/** A result that can never be "ready": carries one internal error describing the failure. */
function failedResult(std: LoadedStandards, code: string, message: string): { result: LintRunResult; readiness: ReadinessResult } {
  var internal = syntheticInternalError(code, message);
  var totals = emptyTotals();
  totals.errors = 1;
  var result: LintRunResult = {
    issues: [internal],
    internalErrors: [internal],
    ruleSummaries: [],
    configDiagnostics: std.configDiagnostics,
    registryDiagnostics: std.registryDiagnostics,
    nodeCount: 0,
    totals: totals,
    rulesetVersion: std.config.rulesetVersion,
    registryVersion: std.registry ? std.registry.version : '0.0.0',
    designSystem: std.registry ? std.registry.designSystem : 'Unknown',
  };
  var readiness: ReadinessResult;
  try {
    readiness = evaluateReadiness({ result: result, config: std.config, registry: std.registry });
  } catch (e) {
    readiness = {
      ready: false, status: 'NOT_READY', blockingIssues: [internal], exceptedIssues: [], warnings: [],
      reasons: [message], rulesetVersion: result.rulesetVersion, registryVersion: result.registryVersion,
    };
  }
  // Belt and braces: a failed run is never ready.
  if (readiness.ready) {
    readiness = Object.assign({}, readiness, { ready: false, status: 'NOT_READY' as const });
  }
  if (readiness.reasons.indexOf(message) === -1) readiness.reasons = [message].concat(readiness.reasons);
  return { result: result, readiness: readiness };
}

/**
 * Load standards, snapshot the scope, lint, evaluate readiness, store `lastRun` and post
 * `standards-result`. Never throws; failures produce a NOT_READY result.
 */
export async function runValidation(deps: ControllerDeps, scopeTarget?: ScopeTarget): Promise<StandardsRun> {
  var f = deps.figma;
  deps.postMessage({ type: 'standards-progress', stage: 'loading' });
  var std: LoadedStandards;
  try {
    std = loadStandards(f, deps.adminTools);
  } catch (e) {
    // Should not happen (loadStandards is defensive) — fall back to a minimal, never-ready state.
    var rc = resolveConfig(BUNDLED_CONFIG, ALL_RULES).config;
    std = {
      registry: null,
      registryDiagnostics: [{ level: 'error', code: 'load-failed', message: 'Could not load standards: ' + errorMessage(e) }],
      registrySource: 'document', registryText: '', config: rc, configDiagnostics: [], configSource: 'bundled',
      configText: '', exceptions: [], exceptionDiagnostics: [],
    };
  }
  var target = scopeTarget || getScope(f);
  var validatedAt = deps.now();
  var roots: DesignNode[] = [];
  var outcome: { result: LintRunResult; readiness: ReadinessResult };

  try {
    deps.postMessage({ type: 'standards-progress', stage: 'snapshot', count: target.nodes.length });
    var snap = await buildDesignTree(target.nodes, createFigmaResolver(f), { includeHidden: std.config.settings.includeHidden });
    roots = snap.roots;
    try {
      deps.postMessage({ type: 'standards-progress', stage: 'lint', count: snap.nodeCount });
      var registryForLint = std.registry || createRegistryIndex(emptyRegistry());
      var result = runLint({
        roots: roots,
        rules: ALL_RULES,
        config: std.config,
        registry: registryForLint,
        configDiagnostics: std.configDiagnostics,
        registryDiagnostics: std.registryDiagnostics,
        exceptions: std.exceptions,
        now: validatedAt,
      });
      var readiness = evaluateReadiness({ result: result, config: std.config, registry: std.registry });
      outcome = { result: result, readiness: readiness };
    } catch (e) {
      outcome = failedResult(std, 'lint-failed', 'Validation failed unexpectedly: ' + errorMessage(e));
    }
  } catch (e) {
    outcome = failedResult(std, 'snapshot-failed', 'Could not read the design for validation: ' + errorMessage(e));
  }

  var run: StandardsRun = {
    result: outcome.result,
    readiness: outcome.readiness,
    roots: roots,
    scope: target.scope,
    config: std.config,
    registry: std.registry,
    exceptions: std.exceptions,
    validatedAt: validatedAt,
    standards: std,
  };
  lastRun = run;
  deps.postMessage({ type: 'standards-progress', stage: 'done' });
  deps.postMessage(buildResultMessage(run));
  return run;
}

/** Issues without their (potentially large) `data` payload. */
function slimIssue(i: LintIssue): LintIssue {
  var out: any = {};
  for (var k in i) {
    if (k !== 'data' && Object.prototype.hasOwnProperty.call(i, k)) out[k] = (i as any)[k];
  }
  return out as LintIssue;
}

function slimIssues(list: LintIssue[]): LintIssue[] {
  return (list || []).map(slimIssue);
}

function registryMeta(std: LoadedStandards): { version: string; designSystem: string; status: string; source: StandardsSource } {
  if (std.registry) {
    return { version: std.registry.version, designSystem: std.registry.designSystem, status: std.registry.status, source: std.registrySource };
  }
  return { version: 'unknown', designSystem: 'Unknown', status: 'invalid', source: std.registrySource };
}

function buildResultMessage(run: StandardsRun): any {
  var r = run.result;
  return {
    type: 'standards-result',
    result: {
      issues: slimIssues(r.issues),
      internalErrors: slimIssues(r.internalErrors),
      ruleSummaries: r.ruleSummaries,
      configDiagnostics: r.configDiagnostics,
      registryDiagnostics: r.registryDiagnostics,
      nodeCount: r.nodeCount,
      totals: r.totals,
      rulesetVersion: r.rulesetVersion,
      registryVersion: r.registryVersion,
      designSystem: r.designSystem,
    },
    readiness: {
      ready: run.readiness.ready,
      status: run.readiness.status,
      blockingIssues: slimIssues(run.readiness.blockingIssues),
      exceptedIssues: slimIssues(run.readiness.exceptedIssues),
      warnings: slimIssues(run.readiness.warnings),
      reasons: run.readiness.reasons,
      rulesetVersion: run.readiness.rulesetVersion,
      registryVersion: run.readiness.registryVersion,
    },
    scope: run.scope,
    validatedAt: run.validatedAt,
    registry: registryMeta(run.standards),
    rulesetVersion: run.config.rulesetVersion,
    configSource: run.standards.configSource,
    diagnostics: {
      config: run.standards.configDiagnostics,
      registry: run.standards.registryDiagnostics,
      exceptions: run.standards.exceptionDiagnostics,
    },
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function readReadinessRecord(f: any): any {
  var raw = readDoc(f, STANDARDS_DOC_KEYS.readiness);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function canUserAddExceptions(std: LoadedStandards, f: any, deps: ControllerDeps): boolean {
  var policy = std.config.exceptions;
  if (!policy.enabled) return false;
  if (!deps.adminTools && policy.allowedApprovers.length === 0) return false;
  var user = getCurrentUser(f);
  return canApprove(policy, { id: user ? user.id : null });
}

function buildStateMessage(deps: ControllerDeps): any {
  var f = deps.figma;
  var std = loadStandards(f, deps.adminTools);
  var rules = ALL_RULES.map(function (r) {
    var rc = std.config.rules[r.meta.id];
    return {
      id: r.meta.id,
      description: r.meta.description,
      severity: rc && rc.enabled ? rc.severity : 'off',
      fixable: r.meta.fixable,
      category: r.meta.category,
      docs: r.meta.docs || '',
    };
  });
  var meta = registryMeta(std);
  return {
    type: 'standards-state',
    designSystem: meta.designSystem,
    registryVersion: meta.version,
    registryStatus: meta.status,
    rulesetVersion: std.config.rulesetVersion,
    registrySource: std.registrySource,
    configSource: std.configSource,
    rules: rules,
    exceptions: std.exceptions,
    lastReadiness: readReadinessRecord(f),
    currentUser: getCurrentUser(f),
    adminTools: deps.adminTools,
    canAddExceptions: canUserAddExceptions(std, f, deps),
    diagnostics: {
      config: std.configDiagnostics,
      registry: std.registryDiagnostics,
      exceptions: std.exceptionDiagnostics,
    },
  };
}

function findPage(node: any): any {
  var p: any = node;
  var guard = 0;
  while (p && guard++ < 10000) {
    var t: any = null;
    try { t = p.type; } catch (e) { t = null; }
    if (t === 'PAGE') return p;
    try { p = p.parent; } catch (e) { p = null; }
  }
  return null;
}

async function handleSelect(msg: any, deps: ControllerDeps): Promise<void> {
  var f = deps.figma;
  var nodeId = msg && typeof msg.nodeId === 'string' ? msg.nodeId : '';
  var node: any = null;
  if (nodeId) {
    try { node = await f.getNodeByIdAsync(nodeId); } catch (e) { node = null; }
  }
  if (!node || node.removed === true) {
    toast(deps, 'error', 'Layer no longer exists');
    return;
  }
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
    toast(deps, 'error', 'This item cannot be selected on the canvas');
    return;
  }
  var page = findPage(node);
  var current: any = f.currentPage;
  if (page && (!current || page.id !== current.id)) {
    await f.setCurrentPageAsync(page);
  }
  f.currentPage.selection = [node];
  f.viewport.scrollAndZoomIntoView([node]);
}

function requireRun(deps: ControllerDeps): StandardsRun | null {
  if (!lastRun) {
    toast(deps, 'error', 'Run validation first.');
    return null;
  }
  return lastRun;
}

function normalizeMode(mode: any): 'safe' | 'selected' | null {
  return mode === 'safe' || mode === 'selected' ? mode : null;
}

function selectedIds(msg: any): string[] {
  var ids = msg && Array.isArray(msg.issueIds) ? msg.issueIds : [];
  return ids.filter(function (x: any) { return typeof x === 'string'; });
}

async function handleFixPreview(msg: any, deps: ControllerDeps): Promise<void> {
  var run = requireRun(deps);
  if (!run) return;
  var mode = normalizeMode(msg && msg.mode);
  if (!mode) {
    toast(deps, 'error', 'Unknown fix mode.');
    return;
  }
  var plan = planFixes(run.result.issues, mode, mode === 'selected' ? selectedIds(msg) : undefined);
  var requiresConfirmation = false;
  var operations = plan.operations.map(function (p) {
    if (p.kind === 'REQUIRES_CONFIRMATION') requiresConfirmation = true;
    return { issueId: p.issueId, kind: p.kind, description: describeOperation(p.op), key: operationKey(p) };
  });
  deps.postMessage({
    type: 'standards-fix-preview',
    mode: mode,
    operations: operations,
    skipped: plan.skipped,
    requiresConfirmation: requiresConfirmation,
  });
}

/** Preview line for a planned operation ("<issueId>|<description>"); also sent to the UI with previews. */
function operationKey(p: { issueId: string; op: any }): string {
  return p.issueId + '|' + describeOperation(p.op);
}

function sameOperations(planned: Array<{ issueId: string; op: any }>, expected: any): boolean {
  if (!Array.isArray(expected) || expected.length !== planned.length) return false;
  for (var i = 0; i < planned.length; i++) {
    if (expected[i] !== operationKey(planned[i])) return false;
  }
  return true;
}

async function handleApplyFixes(msg: any, deps: ControllerDeps): Promise<void> {
  var run = requireRun(deps);
  if (!run) return;
  var f = deps.figma;
  var mode = normalizeMode(msg && msg.mode);
  if (!mode) {
    toast(deps, 'error', 'Unknown fix mode.');
    return;
  }
  var plan = planFixes(run.result.issues, mode, mode === 'selected' ? selectedIds(msg) : undefined);
  var needsConfirmation = plan.operations.some(function (p) { return p.kind === 'REQUIRES_CONFIRMATION'; });
  if (needsConfirmation && (mode !== 'selected' || !msg || msg.confirmed !== true)) {
    var refusal = 'These fixes change the design and need your confirmation. Review the preview and confirm to apply.';
    deps.postMessage({ type: 'standards-fix-result', refused: true, reason: refusal, applied: [], failed: [] });
    toast(deps, 'error', refusal);
    return;
  }
  // Confirmation is bound to content: the operations planned now must be exactly the ones the
  // user previewed (a re-run can keep the issue id while the values change).
  if (needsConfirmation && !sameOperations(plan.operations, msg.expectedOperations)) {
    var changed = 'This fix changed since you previewed it. Review the new preview and confirm again.';
    deps.postMessage({ type: 'standards-fix-result', refused: true, reason: changed, applied: [], failed: [] });
    toast(deps, 'error', changed);
    return;
  }
  if (plan.operations.length === 0) {
    deps.postMessage({ type: 'standards-fix-result', applied: [], failed: [], skipped: plan.skipped });
    toast(deps, 'info', 'No applicable fixes.');
    return;
  }
  // Fixes form exactly one undo step: close earlier work first, then the fix batch itself.
  commitUndo(f);
  var outcome = await applyFixes(plan, {
    getNode: function (id: string) { return f.getNodeByIdAsync(id); },
  });
  commitUndo(f);
  deps.postMessage({
    type: 'standards-fix-result',
    applied: outcome.applied.map(function (a) { return { issueId: a.issueId, description: describeOperation(a.op) }; }),
    failed: outcome.failed.map(function (x) { return { issueId: x.issueId, description: describeOperation(x.op), reason: x.reason }; }),
    skipped: plan.skipped,
  });
  await runValidation(deps);
}

function reportFilename(validatedAt: string): string {
  var day = /^\d{4}-\d{2}-\d{2}/.test(validatedAt) ? validatedAt.slice(0, 10) : 'undated';
  return 'figmakit-standards-report-' + day + '.json';
}

function buildReport(run: StandardsRun, deps: ControllerDeps): HandoffReport {
  var f = deps.figma;
  var user = getCurrentUser(f);
  var fileName = '';
  try { fileName = String(f.root.name || ''); } catch (e) { fileName = ''; }
  var fileKey: string | null = null;
  try { fileKey = typeof f.fileKey === 'string' ? f.fileKey : null; } catch (e) { fileKey = null; }
  return buildHandoffReport({
    result: run.result,
    readiness: run.readiness,
    registry: run.registry,
    config: run.config,
    exceptions: run.exceptions,
    file: { name: fileName, fileKey: fileKey },
    scope: run.scope,
    validatedAt: run.validatedAt,
    validatedBy: { id: user ? user.id : null, name: user ? user.name : null },
    toolVersion: STANDARDS_TOOL_VERSION,
  });
}

/**
 * Export the handoff report for the last run. The UI passes `rerun: true` when it knows the
 * results are out of date (selection/document changed), so the report reflects the design as
 * it is now; with no previous run, validation always runs first.
 */
async function handleExport(msg: any, deps: ControllerDeps): Promise<void> {
  var rerun = !!msg && msg.rerun === true;
  var run: StandardsRun;
  if (!rerun && lastRun) {
    run = lastRun;
  } else {
    // Re-validate the scope the user validated (if the UI sent it), not the live selection.
    var pinned = msg && msg.scope ? await resolveRequestedScope(deps.figma, msg.scope) : null;
    run = await runValidation(deps, pinned || undefined);
  }
  var report = buildReport(run, deps);
  deps.postMessage({
    type: 'standards-export',
    filename: reportFilename(run.validatedAt),
    json: JSON.stringify(report, null, 2),
    contentHash: report.contentHash,
  });
}

async function handleMarkReady(msg: any, deps: ControllerDeps): Promise<void> {
  try {
    // Re-validate exactly the scope the user validated (sent by the UI), never a selection that
    // changed in between (e.g. via click-to-select on an issue).
    var pinned: ScopeTarget | undefined = undefined;
    if (msg && msg.scope !== undefined && msg.scope !== null) {
      var resolved = await resolveRequestedScope(deps.figma, msg.scope);
      if (!resolved) {
        deps.postMessage({
          type: 'standards-mark-ready-result',
          ok: false,
          status: 'NOT_READY',
          reasons: ['The validated layers changed or no longer exist. Run validation again.'],
        });
        return;
      }
      pinned = resolved;
    }
    // Never trust UI state: always re-validate first.
    var run = await runValidation(deps, pinned);
    var r = run.readiness;
    var hardFail = !r.ready || r.status === 'NOT_READY' || run.result.internalErrors.length > 0 || r.blockingIssues.length > 0;
    if (hardFail) {
      deps.postMessage({
        type: 'standards-mark-ready-result',
        ok: false,
        status: 'NOT_READY',
        reasons: r.reasons.length ? r.reasons : ['Readiness requirements are not met.'],
      });
      return;
    }
    var f = deps.figma;
    var report = buildReport(run, deps);
    var record = {
      status: r.status,
      validatedAt: run.validatedAt,
      validatedBy: report.validatedBy,
      rulesetVersion: report.rulesetVersion,
      registryVersion: report.registry.version,
      scope: run.scope,
      contentHash: report.contentHash,
      issueCountSummary: {
        errors: run.result.totals.errors,
        warnings: run.result.totals.warnings,
        infos: run.result.totals.infos,
        blocking: r.blockingIssues.length,
        excepted: r.exceptedIssues.length,
      },
    };
    writeDoc(f, STANDARDS_DOC_KEYS.readiness, JSON.stringify(record));
    var devStatusSet = 0;
    if (run.config.readiness.setDevStatus) {
      for (var i = 0; i < run.scope.rootNodeIds.length; i++) {
        try {
          var root: any = await f.getNodeByIdAsync(run.scope.rootNodeIds[i]);
          if (root && 'devStatus' in root) {
            root.devStatus = { type: 'READY_FOR_DEV' };
            devStatusSet++;
          }
        } catch (e) {
          // devStatus is only settable on some top-level nodes / plans; ignore.
        }
      }
      commitUndo(f);
    }
    deps.postMessage({
      type: 'standards-mark-ready-result',
      ok: true,
      status: r.status,
      contentHash: report.contentHash,
      record: record,
      devStatusSet: devStatusSet,
      message: MARK_READY_NOTICE,
    });
  } catch (e) {
    deps.postMessage({ type: 'standards-mark-ready-result', ok: false, status: 'NOT_READY', reasons: ['Internal error: ' + errorMessage(e)] });
    toast(deps, 'error', 'Could not mark ready: ' + errorMessage(e));
  }
}

/** Accepts 'yyyy-mm-dd' (end of that day, UTC) or a full ISO timestamp. */
function normalizeExpiry(v: any): string | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return null;
  var s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = s + 'T23:59:59.999Z';
  var t = Date.parse(s);
  if (isNaN(t)) return null;
  return new Date(t).toISOString();
}

function persistExceptions(f: any, list: IssueException[]): void {
  writeDoc(f, STANDARDS_DOC_KEYS.exceptions, JSON.stringify(list));
}

async function handleAddException(msg: any, deps: ControllerDeps): Promise<void> {
  var run = requireRun(deps);
  if (!run) return;
  var f = deps.figma;
  var std = loadStandards(f, deps.adminTools);
  var policy = std.config.exceptions;
  if (!policy.enabled) {
    toast(deps, 'error', 'Exceptions are disabled by the standards configuration.');
    return;
  }
  var user = getCurrentUser(f);
  if (!deps.adminTools && policy.allowedApprovers.length === 0) {
    toast(deps, 'error', 'Exceptions can only be granted by your design-system admin.');
    return;
  }
  if (!canApprove(policy, { id: user ? user.id : null })) {
    toast(deps, 'error', 'You are not an allowed exception approver for this file.');
    return;
  }
  var reason = msg && typeof msg.reason === 'string' ? msg.reason.trim() : '';
  if (!reason && policy.requireReason) {
    toast(deps, 'error', 'A reason is required to add an exception.');
    return;
  }
  var id = msg && typeof msg.issueId === 'string' ? msg.issueId : '';
  var issue: LintIssue | null = null;
  for (var i = 0; i < run.result.issues.length; i++) {
    if (run.result.issues[i].id === id) { issue = run.result.issues[i]; break; }
  }
  if (!issue) {
    toast(deps, 'error', 'Issue not found in the latest results — re-run validation.');
    return;
  }
  if (issue.ruleId === INTERNAL_ERROR_RULE_ID) {
    toast(deps, 'error', 'Internal errors cannot be excepted.');
    return;
  }
  if (!isRuleExemptible(issue.ruleId, policy)) {
    toast(deps, 'error', 'Issues from rule "' + issue.ruleId + '" cannot be excepted.');
    return;
  }
  var now = deps.now();
  var expiresAt = normalizeExpiry(msg && msg.expiresAt);
  if (expiresAt === null) {
    toast(deps, 'error', 'Invalid expiry date.');
    return;
  }
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now)) {
    toast(deps, 'error', 'Expiry date must be in the future.');
    return;
  }
  var ex = createException({
    ruleId: issue.ruleId,
    nodeId: issue.nodeId,
    code: issue.code,
    // Scope the exception to this exact issue (not every issue of the rule/code on the layer).
    discriminator: issue.discriminator !== undefined ? issue.discriminator : '',
    reason: reason,
    approvedBy: { id: user ? user.id : null, name: user ? user.name : 'Unknown user' },
    createdAt: now,
    expiresAt: expiresAt,
  });
  // Replace any earlier exception for the same issue (rule/node/code/discriminator; legacy
  // exceptions without a discriminator are replaced too).
  var next = std.exceptions.filter(function (e) {
    return !(
      e.ruleId === ex.ruleId &&
      e.nodeId === ex.nodeId &&
      (e.code === undefined || e.code === ex.code) &&
      (typeof e.discriminator !== 'string' || e.discriminator === ex.discriminator)
    );
  });
  next.push(ex);
  persistExceptions(f, next);
  toast(deps, 'success', 'Exception recorded.');
  await runValidation(deps);
  deps.postMessage(buildStateMessage(deps));
}

async function handleRemoveException(msg: any, deps: ControllerDeps): Promise<void> {
  var f = deps.figma;
  var id = msg && typeof msg.exceptionId === 'string' ? msg.exceptionId : '';
  var current = parseExceptions(readDoc(f, STANDARDS_DOC_KEYS.exceptions)).exceptions;
  var next = current.filter(function (e) { return e.id !== id; });
  if (next.length === current.length) {
    toast(deps, 'error', 'Exception not found.');
    return;
  }
  persistExceptions(f, next);
  toast(deps, 'success', 'Exception removed.');
  await runValidation(deps);
  deps.postMessage(buildStateMessage(deps));
}

function prettyText(text: string): string {
  try {
    return pretty(JSON.parse(text));
  } catch (e) {
    return text; // corrupt document JSON: return as-is so it can be repaired
  }
}

function handleGetConfig(deps: ControllerDeps): void {
  var std = loadStandards(deps.figma, deps.adminTools);
  deps.postMessage({
    type: 'standards-config',
    configJson: prettyText(std.configText),
    registryJson: prettyText(std.registryText),
    configSource: std.configSource,
    registrySource: std.registrySource,
  });
}

function parseJsonDoc(text: string, label: string, diagnostics: Diagnostic[]): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    diagnostics.push({ level: 'error', code: 'invalid-json', message: label + ' is not valid JSON: ' + errorMessage(e), path: label.toLowerCase() });
    return { ok: false, value: undefined };
  }
}

function handleSaveConfig(msg: any, deps: ControllerDeps): void {
  var f = deps.figma;
  var hasConfig = msg && typeof msg.configJson === 'string';
  var hasRegistry = msg && typeof msg.registryJson === 'string';
  if (!hasConfig && !hasRegistry) {
    deps.postMessage({ type: 'standards-config-saved', ok: false, diagnostics: [{ level: 'error', code: 'nothing-to-save', message: 'Nothing to save.' }] });
    return;
  }
  var diagnostics: Diagnostic[] = [];
  var current = loadStandards(f, deps.adminTools);

  var configValue: unknown = undefined;
  var resolvedConfig: ResolvedConfig | null = current.config;
  if (hasConfig) {
    var pc = parseJsonDoc(msg.configJson, 'Config', diagnostics);
    if (pc.ok) {
      configValue = pc.value;
      var rc = resolveConfig(pc.value as LintConfig, ALL_RULES);
      diagnostics = diagnostics.concat(rc.diagnostics.map(function (d) { return prefixPath(d, 'config'); }));
      resolvedConfig = rc.config;
    } else {
      resolvedConfig = null;
    }
  }

  var registryValue: unknown = undefined;
  var registryVersion: string | null = current.registry ? current.registry.version : null;
  if (hasRegistry) {
    var pr = parseJsonDoc(msg.registryJson, 'Registry', diagnostics);
    if (pr.ok) {
      registryValue = pr.value;
      var rd = validateRegistry(pr.value);
      diagnostics = diagnostics.concat(rd.map(function (d) { return prefixPath(d, 'registry'); }));
      registryVersion = rd.some(function (d) { return d.level === 'error'; }) ? null : (pr.value as ComponentRegistry).version;
    } else {
      registryVersion = null;
    }
  }

  if (resolvedConfig && registryVersion) {
    diagnostics = diagnostics.concat(checkRegistryCompatibility(resolvedConfig, registryVersion));
  }

  if (diagnostics.some(function (d) { return d.level === 'error'; })) {
    deps.postMessage({ type: 'standards-config-saved', ok: false, diagnostics: diagnostics });
    return;
  }
  if (hasConfig) writeDoc(f, STANDARDS_DOC_KEYS.config, pretty(configValue));
  if (hasRegistry) writeDoc(f, STANDARDS_DOC_KEYS.registry, pretty(registryValue));
  lastRun = null; // previous results were produced under different standards
  deps.postMessage({ type: 'standards-config-saved', ok: true, diagnostics: diagnostics });
  deps.postMessage(buildStateMessage(deps));
}

function prefixPath(d: Diagnostic, prefix: string): Diagnostic {
  var out: Diagnostic = { level: d.level, code: d.code, message: d.message };
  out.path = d.path ? prefix + '.' + d.path : prefix;
  return out;
}

function handleResetConfig(msg: any, deps: ControllerDeps): void {
  var f = deps.figma;
  var target = msg && msg.target;
  if (target !== 'config' && target !== 'registry' && target !== 'all') {
    toast(deps, 'error', 'Unknown reset target.');
    return;
  }
  if (target === 'config' || target === 'all') writeDoc(f, STANDARDS_DOC_KEYS.config, '');
  if (target === 'registry' || target === 'all') writeDoc(f, STANDARDS_DOC_KEYS.registry, '');
  lastRun = null;
  deps.postMessage(buildStateMessage(deps));
}

/** Registry-friendly id: lowercase [a-z0-9-], starting with a letter/digit. */
export function slugifyComponentId(name: string): string {
  var s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'component';
}

interface HelperEntry {
  suggestedId: string;
  name: string;
  key: string;
  componentSetKey: string | null;
  remote: boolean;
  /**
   * Keys of the individual variants of the set (when readable). Instances match by set key,
   * but Figma's `detachedInfo` for a detached LIBRARY copy only carries the variant key, so
   * listing variant keys lets those detaches be recognized as `detached-approved`.
   */
  variantKeys: string[];
}

function variantKeysOf(set: any): string[] {
  var out: string[] = [];
  try {
    var kids = set.children || [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k && k.type === 'COMPONENT' && typeof k.key === 'string' && k.key && out.indexOf(k.key) === -1) out.push(k.key);
    }
  } catch (e) {
    // children not readable (remote set / unloaded page): fall back to the set key only
  }
  return out;
}

function readSet(component: any): { key: string | null; name: string | null; variantKeys: string[] } {
  try {
    var p = component.parent;
    if (p && p.type === 'COMPONENT_SET') return { key: p.key || null, name: p.name || null, variantKeys: variantKeysOf(p) };
  } catch (e) {
    // inaccessible parent (remote)
  }
  return { key: null, name: null, variantKeys: [] };
}

function entryForComponent(component: any): HelperEntry | null {
  var key = '';
  try { key = String(component.key || ''); } catch (e) { key = ''; }
  if (!key) return null;
  var set = readSet(component);
  var name = set.name || String(component.name || '');
  return {
    suggestedId: slugifyComponentId(name),
    name: name,
    key: key,
    componentSetKey: set.key,
    remote: component.remote === true,
    variantKeys: set.key ? set.variantKeys : [],
  };
}

async function handleRegistryHelper(deps: ControllerDeps): Promise<void> {
  var f = deps.figma;
  var selection: any[] = [];
  try {
    var sel = f.currentPage.selection;
    for (var i = 0; i < sel.length; i++) selection.push(sel[i]);
  } catch (e) {
    selection = [];
  }
  var entries: HelperEntry[] = [];
  var seenKeys: Record<string, boolean> = {};
  var visited = 0;
  var add = function (e: HelperEntry | null) {
    if (!e) return;
    var dedupe = e.componentSetKey || e.key;
    if (seenKeys[dedupe]) return;
    seenKeys[dedupe] = true;
    entries.push(e);
  };

  var visit = async function (n: any): Promise<void> {
    if (!n || visited++ > 5000) return;
    var t = n.type;
    if (t === 'COMPONENT_SET') {
      var setKey = String(n.key || '');
      if (setKey) {
        add({
          suggestedId: slugifyComponentId(n.name), name: String(n.name || ''), key: setKey, componentSetKey: setKey,
          remote: n.remote === true, variantKeys: variantKeysOf(n),
        });
      }
      return;
    }
    if (t === 'COMPONENT') {
      add(entryForComponent(n));
      return;
    }
    if (t === 'INSTANCE') {
      var main: any = null;
      try { main = typeof n.getMainComponentAsync === 'function' ? await n.getMainComponentAsync() : null; } catch (e) { main = null; }
      if (main) add(entryForComponent(main));
      return;
    }
    var kids: any = null;
    try { kids = n.children; } catch (e) { kids = null; }
    if (kids) for (var k = 0; k < kids.length; k++) await visit(kids[k]);
  };
  for (var s = 0; s < selection.length; s++) await visit(selection[s]);

  // Unique suggested ids.
  var usedIds: Record<string, number> = {};
  for (var j = 0; j < entries.length; j++) {
    var base = entries[j].suggestedId;
    if (usedIds[base]) {
      usedIds[base]++;
      entries[j].suggestedId = base + '-' + usedIds[base];
    } else {
      usedIds[base] = 1;
    }
  }

  var skeletons = entries.map(function (e) {
    // The set key matches every variant instance; the variant keys are added so detached
    // library copies (whose detachedInfo only names the variant) are also recognized.
    var keys: string[] = [e.componentSetKey || e.key];
    for (var v = 0; v < e.variantKeys.length; v++) {
      if (keys.indexOf(e.variantKeys[v]) === -1) keys.push(e.variantKeys[v]);
    }
    return {
      id: e.suggestedId,
      name: e.name,
      diviType: null,
      figmaComponentKeys: keys,
      description: e.remote ? 'Imported from a library component.' : 'Local component (publish it so its key is stable).',
    };
  });
  if (entries.length === 0) {
    toast(deps, 'info', 'Select components, component sets or instances to generate registry entries.');
  }
  deps.postMessage({ type: 'standards-registry-helper', entries: entries, json: pretty(skeletons) });
}

async function handleVerifyRegistry(deps: ControllerDeps): Promise<void> {
  var f = deps.figma;
  var std = loadStandards(f, deps.adminTools);
  if (!std.registry) {
    deps.postMessage({
      type: 'standards-verify-registry',
      ok: false,
      resolved: [],
      unresolved: [],
      placeholders: [],
      diagnostics: std.registryDiagnostics,
    });
    toast(deps, 'error', 'The registry is invalid; fix it before verifying keys.');
    return;
  }
  var resolved: Array<{ componentId: string; key: string; kind: 'component' | 'componentSet'; name: string }> = [];
  var unresolved: Array<{ componentId: string; key: string; error: string }> = [];
  var placeholders: Array<{ componentId: string; key: string }> = [];
  var components = std.registry.all();
  for (var i = 0; i < components.length; i++) {
    var c = components[i];
    var keys = c.figmaComponentKeys || [];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (isPlaceholderKey(key)) {
        placeholders.push({ componentId: c.id, key: key });
        continue;
      }
      var node: any = null;
      var lastError = '';
      try {
        node = await f.importComponentByKeyAsync(key);
        if (node) resolved.push({ componentId: c.id, key: key, kind: 'component', name: String(node.name || '') });
      } catch (e) {
        lastError = errorMessage(e);
        node = null;
      }
      if (node) continue;
      try {
        node = await f.importComponentSetByKeyAsync(key);
        if (node) resolved.push({ componentId: c.id, key: key, kind: 'componentSet', name: String(node.name || '') });
      } catch (e) {
        lastError = errorMessage(e);
        node = null;
      }
      if (!node) unresolved.push({ componentId: c.id, key: key, error: lastError || 'Not found' });
    }
  }
  deps.postMessage({
    type: 'standards-verify-registry',
    ok: unresolved.length === 0 && placeholders.length === 0,
    resolved: resolved,
    unresolved: unresolved,
    placeholders: placeholders,
    note: 'Keys can only be imported when the component is published to a library this file can access.',
  });
}

/**
 * Dispatch one `standards-*` message. Every handler is wrapped: unexpected errors become a
 * `standards-toast` (and never a positive readiness).
 */
export async function handleStandardsMessage(msg: any, partialDeps?: Partial<ControllerDeps>): Promise<void> {
  var deps = resolveDeps(partialDeps);
  var type = msg && msg.type;
  try {
    switch (type) {
      case 'standards-init':
        deps.postMessage(buildStateMessage(deps));
        return;
      case 'standards-run':
        await runValidation(deps);
        return;
      case 'standards-select':
        await handleSelect(msg, deps);
        return;
      case 'standards-fix-preview':
        await handleFixPreview(msg, deps);
        return;
      case 'standards-apply-fixes':
        await handleApplyFixes(msg, deps);
        return;
      case 'standards-export':
        await handleExport(msg, deps);
        return;
      case 'standards-mark-ready':
        await handleMarkReady(msg, deps);
        return;
      case 'standards-add-exception':
        await handleAddException(msg, deps);
        return;
      case 'standards-remove-exception':
        await handleRemoveException(msg, deps);
        return;
      case 'standards-get-config':
      case 'standards-save-config':
      case 'standards-reset-config':
      case 'standards-registry-helper':
      case 'standards-verify-registry':
        if (!deps.adminTools) {
          toast(deps, 'error', 'Standards are managed by your design-system admin and cannot be changed here.');
          return;
        }
        break;
    }
    switch (msg.type) {
      case 'standards-get-config':
        handleGetConfig(deps);
        return;
      case 'standards-save-config':
        handleSaveConfig(msg, deps);
        return;
      case 'standards-reset-config':
        handleResetConfig(msg, deps);
        return;
      case 'standards-registry-helper':
        await handleRegistryHelper(deps);
        return;
      case 'standards-verify-registry':
        await handleVerifyRegistry(deps);
        return;
      default:
        toast(deps, 'error', 'Unknown standards message: ' + String(type));
    }
  } catch (e) {
    try {
      toast(deps, 'error', errorMessage(e));
    } catch (e2) {
      // nothing else we can do
    }
  }
}
