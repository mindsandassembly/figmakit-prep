/**
 * FigmaKit Standards — autofix planning and application.
 *
 * Fixes are serializable, whitelisted operations (see FixOperation in types.ts).
 * This module never deletes, detaches, swaps, or reparents nodes: those are not
 * expressible as FixOperations and the applier refuses anything outside the
 * whitelist. Every operation carries the expected current value (`from`); if the
 * document no longer matches, the operation is refused as stale.
 */

import type { FixKind, FixNumberProperty, FixOperation, FixPluginDataKey, LintIssue } from './types';

/** Resolves node ids to live (or mock) nodes. In the plugin: `id => figma.getNodeByIdAsync(id)`. */
export interface FixTargetAdapter {
  getNode(id: string): Promise<any | null>;
}

export interface PlannedOperation {
  issueId: string;
  kind: FixKind;
  op: FixOperation;
}

export interface FixPlan {
  operations: PlannedOperation[];
  skipped: Array<{ issueId: string; reason: string }>;
}

export interface FixApplyResult {
  applied: Array<{ issueId: string; op: FixOperation }>;
  failed: Array<{ issueId: string; op: FixOperation; reason: string }>;
}

export const FIX_OPS: ReadonlyArray<FixOperation['op']> = ['rename', 'setPluginData', 'setNumber', 'setSolidPaintColor'];
export const FIX_NUMBER_PROPERTIES: ReadonlyArray<FixNumberProperty> = [
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing',
];
export const FIX_PLUGIN_DATA_KEYS: ReadonlyArray<FixPluginDataKey> = ['fk-type', 'fk-standards-component', 'fk-divi-type'];

export const MAX_NAME_LENGTH = 255;
export const MAX_PLUGIN_DATA_LENGTH = 1024;

var HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalize #rgb / #rrggbb (any case) to lowercase #rrggbb, or null when invalid. */
export function normalizeHex(hex: unknown): string | null {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  var h = hex.toLowerCase();
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return h;
}

function channelToHex(v: number): string {
  var n = Math.round(Math.max(0, Math.min(1, v)) * 255);
  var s = n.toString(16);
  return s.length === 1 ? '0' + s : s;
}

function colorToHex(c: any): string | null {
  if (!c || typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') return null;
  return '#' + channelToHex(c.r) + channelToHex(c.g) + channelToHex(c.b);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  var h = normalizeHex(hex) as string;
  return {
    r: parseInt(h.substring(1, 3), 16) / 255,
    g: parseInt(h.substring(3, 5), 16) / 255,
    b: parseInt(h.substring(5, 7), 16) / 255,
  };
}

function isNonNegativeFinite(n: unknown): boolean {
  return typeof n === 'number' && isFinite(n) && n >= 0;
}

/**
 * Whitelist enforcement. Returns a human-readable error, or null when the
 * operation is well-formed and allowed.
 */
export function validateOperation(op: FixOperation): string | null {
  var o: any = op;
  if (!o || typeof o !== 'object') return 'Operation must be an object';
  if (FIX_OPS.indexOf(o.op) < 0) return 'Operation "' + String(o.op) + '" is not allowed';
  if (typeof o.nodeId !== 'string' || o.nodeId === '') return 'Operation is missing a node id';

  switch (o.op) {
    case 'rename':
      if (typeof o.from !== 'string') return 'rename: "from" must be a string';
      if (typeof o.to !== 'string' || o.to.trim() === '') return 'rename: new name must be non-empty';
      if (o.to.length > MAX_NAME_LENGTH) return 'rename: new name exceeds ' + MAX_NAME_LENGTH + ' characters';
      return null;
    case 'setPluginData':
      if (FIX_PLUGIN_DATA_KEYS.indexOf(o.key) < 0) return 'setPluginData: key "' + String(o.key) + '" is not allowed';
      if (typeof o.from !== 'string') return 'setPluginData: "from" must be a string';
      if (typeof o.to !== 'string') return 'setPluginData: "to" must be a string';
      if (o.to.length > MAX_PLUGIN_DATA_LENGTH) return 'setPluginData: value too long';
      return null;
    case 'setNumber':
      if (FIX_NUMBER_PROPERTIES.indexOf(o.property) < 0) return 'setNumber: property "' + String(o.property) + '" is not allowed';
      if (typeof o.from !== 'number' || !isFinite(o.from)) return 'setNumber: "from" must be a finite number';
      if (!isNonNegativeFinite(o.to)) return 'setNumber: "to" must be a finite number ≥ 0';
      return null;
    case 'setSolidPaintColor':
      if (o.target !== 'fills' && o.target !== 'strokes') return 'setSolidPaintColor: target must be fills or strokes';
      if (typeof o.index !== 'number' || !isFinite(o.index) || o.index < 0 || Math.floor(o.index) !== o.index) {
        return 'setSolidPaintColor: index must be a non-negative integer';
      }
      if (!normalizeHex(o.from)) return 'setSolidPaintColor: "from" is not a valid hex color';
      if (!normalizeHex(o.to)) return 'setSolidPaintColor: "to" is not a valid hex color';
      return null;
  }
  return 'Unknown operation';
}

/** Identity of the property an operation writes, used for conflict detection. */
function targetKey(op: FixOperation): string {
  switch (op.op) {
    case 'rename': return op.nodeId + '|name';
    case 'setPluginData': return op.nodeId + '|pluginData|' + op.key;
    case 'setNumber': return op.nodeId + '|number|' + op.property;
    case 'setSolidPaintColor': return op.nodeId + '|paint|' + op.target + '|' + op.index;
  }
}

/**
 * Choose which fix operations to run.
 *  - 'safe': SAFE fixes of all issues. REQUIRES_CONFIRMATION is never included.
 *  - 'selected': SAFE and REQUIRES_CONFIRMATION fixes of the selected issue ids only
 *    (the caller is responsible for having obtained user confirmation).
 * UNSUPPORTED fixes, excepted issues and invalid operations are skipped with a reason.
 * When two issues write the same node property, the first (by issue order) wins and
 * the later issue is skipped entirely (an issue's operations are all-or-nothing).
 */
export function planFixes(
  issues: LintIssue[],
  mode: 'safe' | 'selected',
  selectedIssueIds?: string[],
): FixPlan {
  var operations: PlannedOperation[] = [];
  var skipped: Array<{ issueId: string; reason: string }> = [];
  var claimed: Record<string, string> = {};
  var seenIssues: Record<string, boolean> = {};
  var selected: Record<string, boolean> = {};
  if (selectedIssueIds) {
    for (var s = 0; s < selectedIssueIds.length; s++) selected[selectedIssueIds[s]] = true;
  }

  for (var i = 0; i < issues.length; i++) {
    var issue = issues[i];
    if (!issue || seenIssues[issue.id]) continue;
    seenIssues[issue.id] = true;

    var isSelected = selected[issue.id] === true;
    if (mode === 'selected' && !isSelected) continue;

    var fix = issue.fix;
    if (!fix) {
      if (mode === 'selected') skipped.push({ issueId: issue.id, reason: 'No fix available for this issue' });
      continue;
    }
    if (issue.exception) {
      skipped.push({ issueId: issue.id, reason: 'Issue has an approved exception' });
      continue;
    }
    if (fix.kind === 'UNSUPPORTED') {
      skipped.push({ issueId: issue.id, reason: 'Fix is not supported automatically: ' + fix.description });
      continue;
    }
    if (fix.kind === 'REQUIRES_CONFIRMATION' && mode === 'safe') {
      skipped.push({ issueId: issue.id, reason: 'Fix requires confirmation; select it explicitly' });
      continue;
    }
    if (fix.kind !== 'SAFE' && fix.kind !== 'REQUIRES_CONFIRMATION') {
      skipped.push({ issueId: issue.id, reason: 'Unknown fix kind' });
      continue;
    }
    var ops = fix.operations || [];
    if (ops.length === 0) {
      skipped.push({ issueId: issue.id, reason: 'Fix has no operations' });
      continue;
    }

    var problem: string | null = null;
    var keys: string[] = [];
    for (var j = 0; j < ops.length && !problem; j++) {
      var err = validateOperation(ops[j]);
      if (err) {
        problem = 'Invalid operation: ' + err;
        break;
      }
      var key = targetKey(ops[j]);
      if (claimed[key] || keys.indexOf(key) >= 0) {
        problem = 'Conflicts with fix for issue ' + (claimed[key] || issue.id) + ' on the same property';
      }
      keys.push(key);
    }
    if (problem) {
      skipped.push({ issueId: issue.id, reason: problem });
      continue;
    }
    for (var k = 0; k < ops.length; k++) {
      claimed[keys[k]] = issue.id;
      operations.push({ issueId: issue.id, kind: fix.kind, op: ops[k] });
    }
  }
  return { operations: operations, skipped: skipped };
}

function isInsideInstance(node: any): boolean {
  var p: any = null;
  try { p = node.parent; } catch (e) { p = null; }
  var guard = 0;
  while (p && guard++ < 1000) {
    var t: any = null;
    try { t = p.type; } catch (e) { t = null; }
    if (t === 'INSTANCE') return true;
    try { p = p.parent; } catch (e) { p = null; }
  }
  return false;
}

/** True when `node.boundVariables[property]` holds a variable alias (or any non-empty binding). */
function isBoundToVariable(node: any, property: string): boolean {
  var bv: any = null;
  try { bv = node.boundVariables; } catch (e) { bv = null; }
  if (!bv || typeof bv !== 'object') return false;
  var b: any = bv[property];
  if (!b) return false;
  if (Array.isArray(b)) return b.length > 0;
  return true;
}

/** Returns a refusal reason, or null if the op may be applied to `node` now. */
function checkPreconditions(node: any, op: FixOperation): string | null {
  switch (op.op) {
    case 'rename': {
      var name: any = node.name;
      return name === op.from ? null : 'stale: name is now "' + String(name) + '"';
    }
    case 'setPluginData': {
      if (typeof node.getPluginData !== 'function' || typeof node.setPluginData !== 'function') {
        return 'Node does not support plugin data';
      }
      var current = node.getPluginData(op.key);
      return current === op.from ? null : 'stale: plugin data "' + op.key + '" changed';
    }
    case 'setNumber': {
      var mode = node.layoutMode;
      if (typeof mode !== 'string' || mode === 'NONE') return 'Node does not use auto layout';
      // Writing a raw number to a variable-bound field would silently replace the binding.
      if (isBoundToVariable(node, op.property)) return op.property + ' is bound to a variable';
      var v = node[op.property];
      if (typeof v !== 'number') return 'stale: ' + op.property + ' is not a number';
      return v === op.from ? null : 'stale: ' + op.property + ' is now ' + v;
    }
    case 'setSolidPaintColor': {
      var paints = node[op.target];
      if (typeof paints === 'symbol') return 'Paints are mixed';
      if (!paints || typeof paints.length !== 'number') return 'Node has no ' + op.target;
      var paint = paints[op.index];
      if (!paint || paint.type !== 'SOLID') return 'stale: paint ' + op.index + ' is not a solid paint';
      if (paint.boundVariables && paint.boundVariables.color) return 'Paint color is bound to a variable';
      // Assigning fills/strokes directly would detach the layer's paint style.
      var styleId: any = node[op.target === 'fills' ? 'fillStyleId' : 'strokeStyleId'];
      if (typeof styleId === 'symbol' || (typeof styleId === 'string' && styleId !== '')) {
        return 'Layer uses a ' + (op.target === 'fills' ? 'fill' : 'stroke') + ' style; changing the color would detach it';
      }
      var hex = colorToHex(paint.color);
      return hex === normalizeHex(op.from) ? null : 'stale: paint color is now ' + hex;
    }
  }
  return 'Unknown operation';
}

function applyOne(node: any, op: FixOperation): void {
  switch (op.op) {
    case 'rename':
      node.name = op.to;
      return;
    case 'setPluginData':
      node.setPluginData(op.key, op.to);
      return;
    case 'setNumber':
      node[op.property] = op.to;
      return;
    case 'setSolidPaintColor': {
      var src = node[op.target];
      var next: any[] = [];
      for (var i = 0; i < src.length; i++) next.push(src[i]);
      var old = next[op.index];
      var replaced: any = {};
      for (var k in old) {
        if (Object.prototype.hasOwnProperty.call(old, k)) replaced[k] = old[k];
      }
      // Figma paints are immutable: copy, keep opacity/visibility/blend mode, change color only.
      replaced.color = hexToRgb(op.to);
      next[op.index] = replaced;
      node[op.target] = next;
      return;
    }
  }
}

/**
 * Apply planned operations sequentially. Each op is validated against the
 * whitelist, the target must exist, not be removed and not live inside an
 * instance, and its `from` value must still match the document.
 */
export async function applyFixes(
  planned: FixPlan | PlannedOperation[],
  adapter: FixTargetAdapter,
): Promise<FixApplyResult> {
  var list: PlannedOperation[] = Array.isArray(planned) ? planned : (planned && planned.operations) || [];
  var applied: FixApplyResult['applied'] = [];
  var failed: FixApplyResult['failed'] = [];

  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    var op = entry.op;
    var err = validateOperation(op);
    if (err) {
      failed.push({ issueId: entry.issueId, op: op, reason: err });
      continue;
    }
    var node: any = null;
    try {
      node = await adapter.getNode(op.nodeId);
    } catch (e) {
      node = null;
    }
    if (!node) {
      failed.push({ issueId: entry.issueId, op: op, reason: 'Layer not found' });
      continue;
    }
    if (node.removed === true) {
      failed.push({ issueId: entry.issueId, op: op, reason: 'Layer was removed' });
      continue;
    }
    if (isInsideInstance(node)) {
      failed.push({ issueId: entry.issueId, op: op, reason: 'Layer is inside a component instance; edit the main component instead' });
      continue;
    }
    try {
      var refusal = checkPreconditions(node, op);
      if (refusal) {
        failed.push({ issueId: entry.issueId, op: op, reason: refusal });
        continue;
      }
      applyOne(node, op);
      applied.push({ issueId: entry.issueId, op: op });
    } catch (e: any) {
      failed.push({ issueId: entry.issueId, op: op, reason: 'Figma rejected the change: ' + (e && e.message ? e.message : String(e)) });
    }
  }
  return { applied: applied, failed: failed };
}

/** Human-readable preview of an operation. */
export function describeOperation(op: FixOperation): string {
  switch (op.op) {
    case 'rename':
      return 'Rename "' + op.from + '" → "' + op.to + '"';
    case 'setPluginData':
      return 'Set ' + op.key + ' to "' + op.to + '"' + (op.from ? ' (was "' + op.from + '")' : '');
    case 'setNumber':
      return 'Set ' + op.property + ' ' + op.from + 'px → ' + op.to + 'px';
    case 'setSolidPaintColor':
      return 'Change ' + (op.target === 'fills' ? 'fill' : 'stroke') + ' ' + (op.index + 1) + ' color ' +
        (normalizeHex(op.from) || op.from) + ' → ' + (normalizeHex(op.to) || op.to);
  }
  return 'Unknown operation';
}
