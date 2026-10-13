/**
 * FigmaKit Standards — Figma adapter (snapshot step).
 *
 * Walks raw Figma nodes (or plain test mocks), resolves main components
 * asynchronously (required under `documentAccess: "dynamic-page"`, where the
 * synchronous `instance.mainComponent` getter throws), reuses the existing
 * FigmaKit analyzer, and produces a plain, serializable `DesignNode` tree that
 * the pure lint engine consumes.
 *
 * Nothing in here mutates the document.
 */

import type { AnalysisResult, Classification, Fingerprint, NodeRole } from '../shared/types';
import { NODE_ROLES } from '../shared/types';
import { analyzeNode } from '../core/analyzer';
import { classifyNode } from '../core/classifier';
import { fingerprintChildren, matchFingerprint } from '../core/fingerprinter';
import { safeGetArray, safeGetChildren, safeGetNumber, safeGetString } from '../shared/figma-helpers';
import type {
  DesignNode,
  DetachedInfoSnapshot,
  InstanceInfo,
  LayoutMode,
  MainComponentInfo,
  PaintSnapshot,
  TextSnapshot,
} from './types';
import { STANDARDS_PLUGIN_DATA_KEYS } from './types';

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Async lookups the snapshot needs from the Figma API (injectable for tests). */
export interface SnapshotResolver {
  /** Main component of an INSTANCE, or null when it cannot be resolved (deleted / missing library). */
  getMainComponent(instance: any): Promise<MainComponentInfo | null>;
  /** Resolve a local component id (from detachedInfo) to its publish key and component-set key. */
  resolveLocalComponent(componentId: string): Promise<{ key: string; componentSetKey: string | null } | null>;
  /**
   * Resolve a library component key (from detachedInfo) to its parent component-set key.
   * Optional; null when unknown, unpublished, offline, or not a variant.
   */
  resolveLibraryComponent?(componentKey: string): Promise<{ componentSetKey: string | null } | null>;
  /**
   * Origin of an INSTANCE nested inside `ancestor` (its nearest INSTANCE ancestor): 'library' when it is
   * the master's own sub-instance with an unchanged main component, 'override' when designer-placed or
   * swapped, 'unknown' when it cannot be resolved. Optional; absent = not computed.
   */
  resolveNestedInstanceOrigin?(nested: any, ancestor: any): Promise<'library' | 'override' | 'unknown'>;
}

/**
 * Shared implementation of resolveNestedInstanceOrigin. Figma ids of layers inside an instance are
 * "I<instanceId>;<idInMainComponent>"; the counterpart in the main component tells whether the nested
 * instance is still the library's own sub-instance (same main component) or was swapped / changed.
 */
async function computeNestedOrigin(
  nested: any,
  ancestor: any,
  getNodeById: (id: string) => Promise<any>,
  getMainKey: (instance: any) => Promise<string | null>,
): Promise<'library' | 'override' | 'unknown'> {
  try {
    var nid = safeGetString(nested, 'id', '');
    var aid = safeGetString(ancestor, 'id', '');
    if (!nid || !aid) return 'unknown';
    // Not an instance sublayer id: the layer does not come from the main component (designer-placed).
    if (nid.charAt(0) !== 'I') return 'override';
    var prefix = 'I' + (aid.charAt(0) === 'I' ? aid.substring(1) : aid) + ';';
    if (nid.indexOf(prefix) !== 0) return 'unknown';
    var rest = nid.substring(prefix.length);
    if (!rest || rest.indexOf(';') !== -1) return 'unknown';
    var counterpart = await getNodeById(rest);
    if (!counterpart || safeGetString(counterpart, 'type', '') !== 'INSTANCE') return 'unknown';
    var masterKey = await getMainKey(counterpart);
    var ownKey = await getMainKey(nested);
    if (!masterKey || !ownKey) return 'unknown';
    return masterKey === ownKey ? 'library' : 'override';
  } catch (e) {
    return 'unknown';
  }
}

function safeRead(obj: any, prop: string): any {
  try {
    return obj ? obj[prop] : undefined;
  } catch (e) {
    return undefined;
  }
}

/** Parent COMPONENT_SET info of a main component, if it is a variant. */
function readComponentSet(main: any): { key: string | null; name: string | null } {
  try {
    var parent = main.parent;
    if (parent && parent.type === 'COMPONENT_SET') {
      return {
        key: typeof parent.key === 'string' && parent.key !== '' ? parent.key : null,
        name: typeof parent.name === 'string' ? parent.name : null,
      };
    }
  } catch (e) {
    // parent may be inaccessible for remote components; treat as no set
  }
  return { key: null, name: null };
}

/**
 * Normalize a component node (or an already-normalized MainComponentInfo-like
 * object, used by tests) into MainComponentInfo.
 */
function toMainComponentInfo(main: any): MainComponentInfo {
  var explicitSet = main && typeof main === 'object' && 'componentSetKey' in main;
  var set = explicitSet
    ? {
        key: typeof main.componentSetKey === 'string' && main.componentSetKey !== '' ? main.componentSetKey : null,
        name: typeof main.componentSetName === 'string' ? main.componentSetName : null,
      }
    : readComponentSet(main);
  return {
    id: safeGetString(main, 'id', ''),
    key: safeGetString(main, 'key', ''),
    name: safeGetString(main, 'name', ''),
    remote: safeRead(main, 'remote') === true,
    componentSetKey: set.key,
    componentSetName: set.name,
  };
}

/**
 * Resolver backed by the real Figma plugin API. Uses `getMainComponentAsync`
 * (never the sync `mainComponent` getter) and `figma.getNodeByIdAsync`.
 * Results are cached by node id for the lifetime of the resolver.
 */
export function createFigmaResolver(figmaApi: any): SnapshotResolver {
  var mainCache: Record<string, MainComponentInfo> = {};
  var localCache: Record<string, { key: string; componentSetKey: string | null } | null> = {};
  var libraryCache: Record<string, { componentSetKey: string | null } | null> = {};

  return {
    async getMainComponent(instance: any): Promise<MainComponentInfo | null> {
      if (!instance || typeof instance.getMainComponentAsync !== 'function') return null;
      var main: any = null;
      try {
        main = await instance.getMainComponentAsync();
      } catch (e) {
        return null;
      }
      if (!main) return null;
      var id = safeGetString(main, 'id', '');
      if (id && Object.prototype.hasOwnProperty.call(mainCache, id)) return mainCache[id];
      var info = toMainComponentInfo(main);
      if (id) mainCache[id] = info;
      return info;
    },

    async resolveLocalComponent(componentId: string) {
      if (!componentId) return null;
      if (Object.prototype.hasOwnProperty.call(localCache, componentId)) return localCache[componentId];
      var resolved: { key: string; componentSetKey: string | null } | null = null;
      try {
        var node: any = figmaApi && typeof figmaApi.getNodeByIdAsync === 'function'
          ? await figmaApi.getNodeByIdAsync(componentId)
          : null;
        if (node && node.type === 'COMPONENT') {
          resolved = { key: safeGetString(node, 'key', ''), componentSetKey: readComponentSet(node).key };
        } else if (node && node.type === 'COMPONENT_SET') {
          var setKey = safeGetString(node, 'key', '');
          resolved = { key: setKey, componentSetKey: setKey || null };
        }
      } catch (e) {
        resolved = null;
      }
      localCache[componentId] = resolved;
      return resolved;
    },

    async resolveLibraryComponent(componentKey: string) {
      if (!componentKey) return null;
      if (Object.prototype.hasOwnProperty.call(libraryCache, componentKey)) return libraryCache[componentKey];
      var resolved: { componentSetKey: string | null } | null = null;
      try {
        var comp: any = figmaApi && typeof figmaApi.importComponentByKeyAsync === 'function'
          ? await figmaApi.importComponentByKeyAsync(componentKey)
          : null;
        if (comp) resolved = { componentSetKey: readComponentSet(comp).key };
      } catch (e) {
        resolved = null; // unpublished / offline / no access
      }
      libraryCache[componentKey] = resolved;
      return resolved;
    },

    async resolveNestedInstanceOrigin(nested: any, ancestor: any) {
      var self = this;
      return computeNestedOrigin(
        nested,
        ancestor,
        async function (id: string) {
          return figmaApi && typeof figmaApi.getNodeByIdAsync === 'function' ? await figmaApi.getNodeByIdAsync(id) : null;
        },
        async function (inst: any) {
          var mc = await self.getMainComponent(inst);
          return mc && mc.key ? mc.key : null;
        },
      );
    },
  };
}

/**
 * Test resolver. Reads `instance.__mainComponent` (test-only convention: either a
 * MainComponentInfo-like object or a mock COMPONENT node with optional COMPONENT_SET
 * parent; `null` = unresolved) or falls back to `instance.getMainComponentAsync()`.
 * `localComponents` maps local component ids to their resolution for detachedInfo.
 */
export function createMockResolver(
  localComponents?: Record<string, { key: string; componentSetKey: string | null } | null>,
  libraryComponents?: Record<string, { componentSetKey: string | null } | null>,
  nodesById?: Record<string, any>,
): SnapshotResolver {
  return {
    async getMainComponent(instance: any): Promise<MainComponentInfo | null> {
      if (!instance) return null;
      var main: any = null;
      try {
        if ('__mainComponent' in instance) {
          main = instance.__mainComponent;
        } else if (typeof instance.getMainComponentAsync === 'function') {
          main = await instance.getMainComponentAsync();
        }
      } catch (e) {
        return null;
      }
      return main ? toMainComponentInfo(main) : null;
    },
    async resolveLocalComponent(componentId: string) {
      if (localComponents && Object.prototype.hasOwnProperty.call(localComponents, componentId)) {
        return localComponents[componentId];
      }
      return null;
    },
    async resolveLibraryComponent(componentKey: string) {
      if (libraryComponents && Object.prototype.hasOwnProperty.call(libraryComponents, componentKey)) {
        return libraryComponents[componentKey];
      }
      return null;
    },
    async resolveNestedInstanceOrigin(nested: any, ancestor: any) {
      var self = this;
      return computeNestedOrigin(
        nested,
        ancestor,
        async function (id: string) {
          return nodesById && Object.prototype.hasOwnProperty.call(nodesById, id) ? nodesById[id] : null;
        },
        async function (inst: any) {
          var mc = await self.getMainComponent(inst);
          return mc && mc.key ? mc.key : null;
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

var FK_PREFIX_RE = /^\[fk:([a-z][a-z-]*)\]\s*/i;
var STRUCTURAL_CONTAINER_TYPES = ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'];

function isNodeRole(value: string): value is NodeRole {
  return NODE_ROLES.indexOf(value as NodeRole) >= 0;
}

function channelToHex(v: number): string {
  var n = Math.round(Math.max(0, Math.min(1, typeof v === 'number' && isFinite(v) ? v : 0)) * 255);
  var s = n.toString(16);
  return s.length === 1 ? '0' + s : s;
}

/** Figma RGB (0..1 channels) → lowercase #rrggbb. */
export function rgbToHex(color: { r: number; g: number; b: number }): string {
  return '#' + channelToHex(color.r) + channelToHex(color.g) + channelToHex(color.b);
}

function normalizePaint(paint: any): PaintSnapshot {
  var type = safeGetString(paint, 'type', 'UNKNOWN');
  var color = safeRead(paint, 'color');
  var hex = type === 'SOLID' && color && typeof color === 'object' ? rgbToHex(color) : null;
  var opacity = safeGetNumber(paint, 'opacity', 1);
  var bound: string | null = null;
  try {
    var bv = paint.boundVariables;
    if (bv && bv.color && typeof bv.color.id === 'string') bound = bv.color.id;
  } catch (e) {
    bound = null;
  }
  return {
    type: type,
    visible: safeRead(paint, 'visible') !== false,
    hex: hex,
    opacity: opacity,
    boundVariableId: bound,
  };
}

function normalizePaints(node: any, prop: string): PaintSnapshot[] {
  var raw = safeRead(node, prop);
  if (typeof raw === 'symbol' || !raw) return [];
  var arr = safeGetArray(node, prop);
  var out: PaintSnapshot[] = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] && typeof arr[i] === 'object') out.push(normalizePaint(arr[i]));
  }
  return out;
}

/** '' when absent, 'MIXED' when figma.mixed, otherwise the style id. */
function readStyleId(node: any, prop: string): string {
  var v = safeRead(node, prop);
  if (typeof v === 'symbol') return 'MIXED';
  return typeof v === 'string' ? v : '';
}

function numberOrNull(node: any, prop: string): number | null {
  var v = safeRead(node, prop);
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function readOptionalString(node: any, prop: string): string | null {
  var v = safeRead(node, prop);
  return typeof v === 'string' && v !== '' ? v : null;
}

function readLayoutMode(node: any): LayoutMode {
  var v = safeGetString(node, 'layoutMode', 'NONE');
  return v === 'HORIZONTAL' || v === 'VERTICAL' || v === 'GRID' ? v : 'NONE';
}

function readPluginData(node: any, key: string): string {
  try {
    if (node && typeof node.getPluginData === 'function') {
      var v = node.getPluginData(key);
      return typeof v === 'string' ? v : '';
    }
  } catch (e) {
    // getPluginData can throw on removed nodes
  }
  return '';
}

function collectAliasIds(value: any, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) collectAliasIds(value[i], out);
    return;
  }
  if (value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string') {
    out.push(value.id);
    return;
  }
  var keys = Object.keys(value).sort();
  for (var k = 0; k < keys.length; k++) collectAliasIds(value[keys[k]], out);
}

function readBoundVariables(node: any): Record<string, string[]> {
  var result: Record<string, string[]> = {};
  var bv = safeRead(node, 'boundVariables');
  if (!bv || typeof bv !== 'object') return result;
  var keys: string[] = [];
  try {
    keys = Object.keys(bv).sort();
  } catch (e) {
    return result;
  }
  for (var i = 0; i < keys.length; i++) {
    var ids: string[] = [];
    try {
      collectAliasIds(bv[keys[i]], ids);
    } catch (e) {
      ids = [];
    }
    if (ids.length > 0) result[keys[i]] = ids;
  }
  return result;
}

function readText(node: any): TextSnapshot {
  var fontName = safeRead(node, 'fontName');
  var hasFont = fontName && typeof fontName === 'object';
  var lh = safeRead(node, 'lineHeight');
  var lineHeightPx: number | null = null;
  if (lh && typeof lh === 'object' && lh.unit === 'PIXELS' && typeof lh.value === 'number') lineHeightPx = lh.value;
  var textCase = safeRead(node, 'textCase');
  return {
    fontFamily: hasFont && typeof fontName.family === 'string' ? fontName.family : null,
    fontStyle: hasFont && typeof fontName.style === 'string' ? fontName.style : null,
    fontSize: numberOrNull(node, 'fontSize'),
    fontWeight: numberOrNull(node, 'fontWeight'),
    lineHeightPx: lineHeightPx,
    textCase: typeof textCase === 'string' ? textCase : null,
    characters: safeGetString(node, 'characters', ''),
  };
}

/** Strip Figma's "#id" suffix from a component property name ("Label#12:0" → "Label"). */
export function stripPropertyId(name: string): string {
  var idx = name.lastIndexOf('#');
  return idx > 0 ? name.substring(0, idx) : name;
}

function readComponentProperties(node: any): Record<string, string | boolean> {
  var out: Record<string, string | boolean> = {};
  var props = safeRead(node, 'componentProperties');
  if (!props || typeof props !== 'object') return out;
  var keys: string[] = [];
  try {
    keys = Object.keys(props).sort();
  } catch (e) {
    return out;
  }
  for (var i = 0; i < keys.length; i++) {
    var p = props[keys[i]];
    var v = p && typeof p === 'object' ? p.value : undefined;
    if (typeof v === 'string' || typeof v === 'boolean') out[stripPropertyId(keys[i])] = v;
  }
  return out;
}

function readVariantProperties(node: any): Record<string, string> | null {
  var vp = safeRead(node, 'variantProperties');
  if (!vp || typeof vp !== 'object') return null;
  var out: Record<string, string> = {};
  var keys = Object.keys(vp).sort();
  for (var i = 0; i < keys.length; i++) {
    if (typeof vp[keys[i]] === 'string') out[keys[i]] = vp[keys[i]];
  }
  return out;
}

async function readDetachedInfo(node: any, resolver: SnapshotResolver): Promise<DetachedInfoSnapshot | null> {
  var info: any = null;
  try {
    info = node.detachedInfo;
  } catch (e) {
    return null;
  }
  if (!info || typeof info !== 'object') return null;
  if (info.type === 'library' && typeof info.componentKey === 'string') {
    // detachedInfo.componentKey is the variant COMPONENT key; resolve its set key so registries
    // keyed by component-set key still match the detach.
    var lib: { componentSetKey: string | null } | null = null;
    try {
      lib = typeof resolver.resolveLibraryComponent === 'function'
        ? await resolver.resolveLibraryComponent(info.componentKey)
        : null;
    } catch (e) {
      lib = null;
    }
    return {
      type: 'library',
      componentKey: info.componentKey,
      resolvedComponentSetKey: lib && lib.componentSetKey ? lib.componentSetKey : null,
    };
  }
  if (info.type === 'local' && typeof info.componentId === 'string') {
    var resolved: { key: string; componentSetKey: string | null } | null = null;
    try {
      resolved = await resolver.resolveLocalComponent(info.componentId);
    } catch (e) {
      resolved = null;
    }
    return {
      type: 'local',
      componentId: info.componentId,
      resolvedKey: resolved && resolved.key ? resolved.key : null,
      resolvedComponentSetKey: resolved ? resolved.componentSetKey : null,
    };
  }
  return null;
}

/**
 * Name-blind structural classification. Builds a plain facade (never
 * Object.create over a Figma node — Figma getters live on the prototype and
 * would throw / misbehave) with the layer name blanked, then runs the same
 * classifier + fingerprint resolution as the analyzer.
 */
export function classifyStructure(raw: any): Classification | null {
  var type = safeGetString(raw, 'type', '');
  if (STRUCTURAL_CONTAINER_TYPES.indexOf(type) < 0) return null;
  var children = safeGetChildren(raw);
  var facade: any = {
    type: type,
    name: '',
    width: safeGetNumber(raw, 'width', 0),
    height: safeGetNumber(raw, 'height', 0),
    layoutMode: safeGetString(raw, 'layoutMode', 'NONE'),
    fills: safeGetArray(raw, 'fills'),
    strokes: safeGetArray(raw, 'strokes'),
    effects: safeGetArray(raw, 'effects'),
    cornerRadius: safeGetNumber(raw, 'cornerRadius', 0),
    paddingTop: safeGetNumber(raw, 'paddingTop', 0),
    paddingRight: safeGetNumber(raw, 'paddingRight', 0),
    paddingBottom: safeGetNumber(raw, 'paddingBottom', 0),
    paddingLeft: safeGetNumber(raw, 'paddingLeft', 0),
    itemSpacing: safeGetNumber(raw, 'itemSpacing', 0),
    children: children,
  };
  try {
    var best: Classification = classifyNode(facade);
    if (children.length >= 2) {
      var fp = fingerprintChildren(children);
      if (fp) {
        fp.parentWidth = facade.width;
        fp.parentHeight = facade.height;
        var hasImage = false;
        for (var i = 0; i < facade.fills.length; i++) {
          var f = facade.fills[i];
          if (f && f.type === 'IMAGE' && f.visible !== false) hasImage = true;
        }
        fp.hasImageFill = hasImage;
        var structure = matchFingerprint(facade, fp, children);
        // Same resolution as analyzer: structure wins over type for ≥2 children.
        if (structure) best = structure;
      }
    }
    return { role: best.role, confidence: best.confidence, source: best.source };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

interface WalkState {
  order: number;
  count: number;
  includeHidden: boolean;
  resolver: SnapshotResolver;
}

interface ParentInfo {
  id: string | null;
  depth: number;
  path: string[];
  insideInstance: boolean;
  instanceAncestorId: string | null;
  /** Raw nearest INSTANCE ancestor (for nested-instance origin resolution). */
  instanceAncestorRaw: any;
}

function fallbackAnalysis(raw: any): { role: NodeRole; confidence: number; source: string } {
  try {
    var c = classifyNode(raw);
    return { role: c.role, confidence: c.confidence, source: c.source };
  } catch (e) {
    return { role: 'unknown', confidence: 0, source: 'default' };
  }
}

async function buildNode(
  raw: any,
  analysis: AnalysisResult | null,
  parent: ParentInfo,
  state: WalkState,
): Promise<DesignNode | null> {
  var visible = safeRead(raw, 'visible') !== false;
  if (!visible && !state.includeHidden) return null;

  var id = safeGetString(raw, 'id', '');
  var name = safeGetString(raw, 'name', '');
  var type = safeGetString(raw, 'type', '');
  var order = state.order++;
  state.count++;

  // Explicit label: pluginData wins over the name prefix.
  var prefixMatch = FK_PREFIX_RE.exec(name);
  var baseName = prefixMatch ? name.substring(prefixMatch[0].length) : name;
  var fkLabel: NodeRole | null = null;
  var pdLabel = readPluginData(raw, STANDARDS_PLUGIN_DATA_KEYS.fkType).trim().toLowerCase();
  if (pdLabel && isNodeRole(pdLabel)) fkLabel = pdLabel;
  else if (prefixMatch && isNodeRole(prefixMatch[1].toLowerCase())) fkLabel = prefixMatch[1].toLowerCase() as NodeRole;

  var componentId = readPluginData(raw, STANDARDS_PLUGIN_DATA_KEYS.component);
  var diviType = readPluginData(raw, STANDARDS_PLUGIN_DATA_KEYS.diviType);

  var instance: InstanceInfo | null = null;
  if (type === 'INSTANCE') {
    var main: MainComponentInfo | null = null;
    try {
      main = await state.resolver.getMainComponent(raw);
    } catch (e) {
      main = null;
    }
    instance = {
      mainComponent: main,
      variantProperties: readVariantProperties(raw),
      componentProperties: readComponentProperties(raw),
    };
  }

  var nestedOrigin: 'library' | 'override' | 'unknown' | null = null;
  if (type === 'INSTANCE' && parent.insideInstance) {
    if (parent.instanceAncestorRaw && typeof state.resolver.resolveNestedInstanceOrigin === 'function') {
      try {
        nestedOrigin = await state.resolver.resolveNestedInstanceOrigin(raw, parent.instanceAncestorRaw);
      } catch (e) {
        nestedOrigin = 'unknown';
      }
    } else if (parent.instanceAncestorRaw) {
      nestedOrigin = null; // resolver cannot tell: not computed
    } else {
      nestedOrigin = 'unknown';
    }
  }

  var path = parent.path.concat([name]);
  var cornerRadiusRaw = safeRead(raw, 'cornerRadius');

  var node: DesignNode = {
    id: id,
    name: name,
    type: type,
    visible: visible,
    path: path,
    parentId: parent.id,
    depth: parent.depth,
    order: order,
    children: [],

    width: safeGetNumber(raw, 'width', 0),
    height: safeGetNumber(raw, 'height', 0),
    layoutMode: readLayoutMode(raw),
    padding: {
      top: safeGetNumber(raw, 'paddingTop', 0),
      right: safeGetNumber(raw, 'paddingRight', 0),
      bottom: safeGetNumber(raw, 'paddingBottom', 0),
      left: safeGetNumber(raw, 'paddingLeft', 0),
    },
    itemSpacing: safeGetNumber(raw, 'itemSpacing', 0),
    primaryAxisAlignItems: readOptionalString(raw, 'primaryAxisAlignItems'),
    cornerRadius: typeof cornerRadiusRaw === 'number' && isFinite(cornerRadiusRaw) ? cornerRadiusRaw : null,

    instance: instance,
    detachedInfo: await readDetachedInfo(raw, state.resolver),
    insideInstance: parent.insideInstance,
    instanceAncestorId: parent.instanceAncestorId,
    nestedInstanceOrigin: nestedOrigin,

    fkLabel: fkLabel,
    baseName: baseName,
    analysis: analysis
      ? { role: analysis.role, confidence: analysis.confidence, source: analysis.source }
      : fallbackAnalysis(raw),
    structural: classifyStructure(raw),
    fingerprint: analysis && analysis.fingerprint ? copyFingerprint(analysis.fingerprint) : null,
    standardsMeta: { componentId: componentId || null, diviType: diviType || null },

    fills: normalizePaints(raw, 'fills'),
    strokes: normalizePaints(raw, 'strokes'),
    fillStyleId: readStyleId(raw, 'fillStyleId'),
    strokeStyleId: readStyleId(raw, 'strokeStyleId'),
    textStyleId: type === 'TEXT' ? readStyleId(raw, 'textStyleId') : '',
    boundVariables: readBoundVariables(raw),
    text: type === 'TEXT' ? readText(raw) : null,
  };

  var childParent: ParentInfo = {
    id: id,
    depth: parent.depth + 1,
    path: path,
    insideInstance: parent.insideInstance || type === 'INSTANCE',
    instanceAncestorId: type === 'INSTANCE' ? id : parent.instanceAncestorId,
    instanceAncestorRaw: type === 'INSTANCE' ? raw : parent.instanceAncestorRaw,
  };
  var rawChildren = safeGetChildren(raw);
  var analysisChildren = analysis ? analysis.children : [];
  for (var i = 0; i < rawChildren.length; i++) {
    // Zip by index; verify identity in case the tree changed between calls.
    var a: AnalysisResult | null = analysisChildren[i] && analysisChildren[i].node === rawChildren[i]
      ? analysisChildren[i]
      : null;
    var child = await buildNode(rawChildren[i], a, childParent, state);
    if (child) node.children.push(child);
  }
  return node;
}

function copyFingerprint(fp: Fingerprint): Fingerprint {
  return {
    images: fp.images,
    texts: fp.texts,
    headings: fp.headings,
    buttons: fp.buttons,
    icons: fp.icons,
    containers: fp.containers,
    total: fp.total,
    hasImageFill: fp.hasImageFill,
    allSameType: fp.allSameType,
    parentWidth: fp.parentWidth,
    parentHeight: fp.parentHeight,
  };
}

/**
 * A scope root may itself live inside an instance (e.g. the user selected a
 * layer within an instance). Walk the raw parent chain to find out.
 */
function nearestInstanceAncestor(raw: any): any {
  var p = safeRead(raw, 'parent');
  var guard = 0;
  while (p && guard++ < 1000) {
    if (safeGetString(p, 'type', '') === 'INSTANCE') return p;
    p = safeRead(p, 'parent');
  }
  return null;
}

/**
 * True when nothing above `raw` can be a component boundary: its parent is the page, the document,
 * a Figma SECTION (canvas organisation only), or it has no parent (detached mock / test node).
 */
function isTopLevelRoot(raw: any): boolean {
  var p = safeRead(raw, 'parent');
  if (!p) return true;
  var t = safeGetString(p, 'type', '');
  return t === 'PAGE' || t === 'DOCUMENT' || t === 'SECTION';
}

/**
 * Build the serializable DesignNode tree for the given scope roots.
 * Hidden layers (and their subtrees) are skipped unless `includeHidden`.
 * `order` is a global pre-order counter across all roots; `path`/`depth` are
 * relative to each scope root.
 */
export async function buildDesignTree(
  rawRoots: any[],
  resolver: SnapshotResolver,
  opts?: { includeHidden?: boolean },
): Promise<{ roots: DesignNode[]; nodeCount: number }> {
  var state: WalkState = {
    order: 0,
    count: 0,
    includeHidden: !!(opts && opts.includeHidden),
    resolver: resolver,
  };
  var roots: DesignNode[] = [];
  var list = rawRoots || [];
  for (var i = 0; i < list.length; i++) {
    var raw = list[i];
    if (!raw) continue;
    if (safeRead(raw, 'visible') === false && !state.includeHidden) continue;
    var analysis: AnalysisResult | null = null;
    try {
      analysis = analyzeNode(raw, 0);
    } catch (e) {
      analysis = null; // fall back to per-node classification
    }
    var instAncestorRaw = nearestInstanceAncestor(raw);
    var instAncestor: string | null = instAncestorRaw ? safeGetString(instAncestorRaw, 'id', '') || null : null;
    var root = await buildNode(
      raw,
      analysis,
      {
        id: null,
        depth: 0,
        path: [],
        insideInstance: instAncestorRaw !== null,
        instanceAncestorId: instAncestor,
        instanceAncestorRaw: instAncestorRaw,
      },
      state,
    );
    if (root) {
      root.scopeRootIsTopLevel = isTopLevelRoot(raw);
      roots.push(root);
    }
  }
  return { roots: roots, nodeCount: state.count };
}
