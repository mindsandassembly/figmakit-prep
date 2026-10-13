import type { SafetyAssessment } from '../shared/types';
import { BACKGROUND_SHAPE_THRESHOLD } from '../shared/constants';
import { safeGetFills, safeGetStrokes, safeGetEffects, safeGetChildren, safeGetNumber, safeGetString, safeGetBoolean } from '../shared/figma-helpers';

function hasAnyVisibleFill(node: any): boolean {
  var fills = safeGetFills(node);
  for (var i = 0; i < fills.length; i++) {
    if (fills[i].visible !== false) return true;
  }
  return false;
}

function hasAnyVisibleStroke(node: any): boolean {
  var strokes = safeGetStrokes(node);
  for (var i = 0; i < strokes.length; i++) {
    if (strokes[i].visible !== false) return true;
  }
  return false;
}

function hasAnyVisibleEffect(node: any): boolean {
  var effects = safeGetEffects(node);
  for (var i = 0; i < effects.length; i++) {
    if (effects[i].visible !== false) return true;
  }
  return false;
}

function hasPadding(node: any): boolean {
  return (
    safeGetNumber(node, 'paddingTop', 0) > 0 ||
    safeGetNumber(node, 'paddingRight', 0) > 0 ||
    safeGetNumber(node, 'paddingBottom', 0) > 0 ||
    safeGetNumber(node, 'paddingLeft', 0) > 0
  );
}

function getChildCount(node: any): number {
  return safeGetChildren(node).length;
}

var COMPONENT_DEFINITION_TYPES = ['COMPONENT', 'COMPONENT_SET'];
var COMPONENT_BOUNDARY_TYPES = ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

/**
 * True when the node is a layer inside a component instance. Figma does not allow removing or
 * reparenting instance sublayers, and they belong to the component definition anyway.
 */
function isInsideInstance(node: any): boolean {
  var p: any = null;
  try { p = node ? node.parent : null; } catch (e) { p = null; }
  var guard = 0;
  while (p && guard++ < 1000) {
    if (safeGetString(p, 'type', '') === 'INSTANCE') return true;
    try { p = p.parent; } catch (e) { p = null; }
  }
  return false;
}

/**
 * Component guard shared by every destructive check: never remove a main component or component set
 * (that orphans its instances), never flatten/unwrap any component boundary, and never touch
 * layers that live inside an instance.
 */
function componentGuard(node: any, forFlatten: boolean): SafetyAssessment | null {
  var type = safeGetString(node, 'type', '');
  if ((forFlatten ? COMPONENT_BOUNDARY_TYPES : COMPONENT_DEFINITION_TYPES).indexOf(type) >= 0) {
    return { safe: false, reason: 'component-boundary' };
  }
  if (isInsideInstance(node)) return { safe: false, reason: 'inside-instance' };
  return null;
}

export function canRemove(node: any): SafetyAssessment {
  var guarded = componentGuard(node, false);
  if (guarded) return guarded;

  if (safeGetBoolean(node, 'visible', true) === false) {
    return { safe: true, reason: 'hidden' };
  }

  if (safeGetNumber(node, 'opacity', 1) === 0) {
    return { safe: true, reason: 'zero-opacity' };
  }

  if (safeGetBoolean(node, 'isMask', false) === true) {
    var parent = node.parent;
    if (parent && safeGetBoolean(parent, 'clipsContent', false) === true && safeGetNumber(parent, 'cornerRadius', 0) > 0) {
      return { safe: true, reason: 'redundant-mask' };
    }
  }

  var blendMode = safeGetString(node, 'blendMode', 'PASS_THROUGH');
  if (blendMode !== 'PASS_THROUGH' && blendMode !== 'NORMAL') {
    return { safe: false, reason: 'has-blend-mode' };
  }

  if (safeGetString(node, 'type', '') === 'TEXT') {
    return { safe: false, reason: 'has-visual-contribution' };
  }

  var hasFill = hasAnyVisibleFill(node);
  var hasStroke = hasAnyVisibleStroke(node);
  var hasEffects = hasAnyVisibleEffect(node);

  if (hasFill) return { safe: false, reason: 'has-fill' };
  if (hasStroke) return { safe: false, reason: 'has-stroke' };
  if (hasEffects) return { safe: false, reason: 'has-effects' };

  var opacity = safeGetNumber(node, 'opacity', 1);
  if (opacity > 0 && opacity < 1 && getChildCount(node) > 0) {
    return { safe: false, reason: 'has-visual-contribution' };
  }

  if (getChildCount(node) === 0) {
    if (hasPadding(node)) return { safe: false, reason: 'has-padding' };
    if (safeGetNumber(node, 'itemSpacing', 0) > 0) return { safe: false, reason: 'has-gap' };
    if (safeGetNumber(node, 'cornerRadius', 0) > 0) return { safe: false, reason: 'has-corner-radius' };
    return { safe: true, reason: 'empty-container' };
  }

  return { safe: false, reason: 'has-visual-contribution' };
}

export function canFlatten(node: any): SafetyAssessment {
  var guarded = componentGuard(node, true);
  if (guarded) return guarded;
  var childCount = getChildCount(node);

  if (childCount === 0) return { safe: false, reason: 'no-children' };
  if (childCount > 1) return { safe: false, reason: 'multiple-children' };

  if (hasAnyVisibleFill(node)) return { safe: false, reason: 'has-fill' };
  if (hasAnyVisibleStroke(node)) return { safe: false, reason: 'has-stroke' };
  if (hasAnyVisibleEffect(node)) return { safe: false, reason: 'has-effects' };
  if (safeGetNumber(node, 'cornerRadius', 0) > 0) return { safe: false, reason: 'has-corner-radius' };

  var layoutMode = safeGetString(node, 'layoutMode', 'NONE');
  if (layoutMode !== 'NONE') return { safe: false, reason: 'has-auto-layout' };
  if (hasPadding(node)) return { safe: false, reason: 'has-padding' };

  return { safe: true, reason: 'passthrough-wrapper' };
}

export function isRedundantNesting(node: any): SafetyAssessment {
  var guarded = componentGuard(node, true);
  if (guarded) return guarded;
  var childCount = getChildCount(node);
  if (childCount !== 1) return { safe: false, reason: 'not-single-child' };

  var type = safeGetString(node, 'type', '');
  var containerTypes = ['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'SECTION'];
  if (containerTypes.indexOf(type) < 0) return { safe: false, reason: 'not-container' };

  var children = safeGetChildren(node);
  var child = children[0];
  var childType = safeGetString(child, 'type', '');
  if (containerTypes.indexOf(childType) < 0) return { safe: false, reason: 'child-not-container' };

  if (hasAnyVisibleFill(node)) return { safe: false, reason: 'has-fill' };
  if (hasAnyVisibleStroke(node)) return { safe: false, reason: 'has-stroke' };
  if (hasAnyVisibleEffect(node)) return { safe: false, reason: 'has-effects' };
  if (safeGetNumber(node, 'cornerRadius', 0) > 0) return { safe: false, reason: 'has-corner-radius' };
  if (hasPadding(node)) return { safe: false, reason: 'has-padding' };
  if (safeGetNumber(node, 'itemSpacing', 0) > 0) return { safe: false, reason: 'has-gap' };

  return { safe: true, reason: 'redundant-nesting' };
}

export function isBackgroundShape(node: any, parent: any): boolean {
  var type = safeGetString(node, 'type', '');
  if (type !== 'RECTANGLE' && type !== 'ELLIPSE') return false;

  var parentWidth = safeGetNumber(parent, 'width', 0);
  var parentHeight = safeGetNumber(parent, 'height', 0);
  if (parentWidth === 0 || parentHeight === 0) return false;

  var nodeWidth = safeGetNumber(node, 'width', 0);
  var nodeHeight = safeGetNumber(node, 'height', 0);

  return (nodeWidth / parentWidth) >= BACKGROUND_SHAPE_THRESHOLD && (nodeHeight / parentHeight) >= BACKGROUND_SHAPE_THRESHOLD;
}
