/**
 * Raw Figma node builders for scenario fixtures.
 *
 * Everything here produces RAW mock Figma nodes (tests/helpers/figma-mock.ts factories),
 * never DesignNode objects, so fixtures go through the real snapshot adapter
 * (`buildDesignTree`). Real-API behaviors are reproduced per node:
 *  - INSTANCE nodes resolve their main component only via `getMainComponentAsync()`
 *    (as required under `documentAccess: "dynamic-page"`); the main component is a mock
 *    COMPONENT node whose `parent` is a COMPONENT_SET when it is a variant.
 *  - Detached frames carry `detachedInfo` exactly as Figma exposes it.
 *  - Plugin data is read through a per-node `getPluginData(key)` function.
 *
 * All ids are explicit and Figma-like, so runs are deterministic.
 */

import {
  mockComponentNode,
  mockFrameNode,
  mockImagePaint,
  mockInstanceNode,
  mockRectangleNode,
  mockSolidPaint,
  mockTextNode,
} from '../../helpers/figma-mock';
import { KEYS } from './registry';

// ---------------------------------------------------------------------------
// Paints & text
// ---------------------------------------------------------------------------

/** Approved palette (see fixture registry tokens). */
export const HEX = {
  brand: '#4f46e5',
  ink: '#111111',
  white: '#ffffff',
  surface: '#f5f5f7',
} as const;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

export function solid(hex: string): any {
  return mockSolidPaint({ color: hexToRgb(hex) });
}

export function photo(hash = 'img-hero-0001'): any {
  return mockImagePaint({ imageHash: hash });
}

export interface TextOpts {
  fontSize?: number;
  fontWeight?: number;
  family?: string;
  color?: string;
  width?: number;
  height?: number;
  visible?: boolean;
}

/** TEXT layer using approved typography by default (Inter 16/400, ink). */
export function text(id: string, name: string, characters: string, o: TextOpts = {}): any {
  const fontSize = o.fontSize ?? 16;
  const fontWeight = o.fontWeight ?? 400;
  return mockTextNode({
    id,
    name,
    characters,
    fontSize,
    fontWeight,
    fontName: { family: o.family ?? 'Inter', style: fontWeight >= 700 ? 'Bold' : 'Regular' },
    lineHeight: { value: Math.round(fontSize * 1.5), unit: 'PIXELS' },
    fills: [solid(o.color ?? HEX.ink)],
    width: o.width ?? 480,
    height: o.height ?? Math.round(fontSize * 1.5),
    visible: o.visible ?? true,
  });
}

// ---------------------------------------------------------------------------
// Plugin data / detachedInfo
// ---------------------------------------------------------------------------

/** Attach a `getPluginData(key)` implementation backed by `data` (missing keys → ''). */
export function withPluginData<T extends Record<string, any>>(node: T, data: Record<string, string>): T {
  (node as any).getPluginData = (key: string): string =>
    Object.prototype.hasOwnProperty.call(data, key) ? data[key] : '';
  return node;
}

/** Figma's FrameNode.detachedInfo for a frame detached from a library component. */
export function detachedFromLibrary(componentKey: string): { type: 'library'; componentKey: string } {
  return { type: 'library', componentKey };
}

/** Figma's FrameNode.detachedInfo for a frame detached from a component in this file. */
export function detachedFromLocal(componentId: string): { type: 'local'; componentId: string } {
  return { type: 'local', componentId };
}

// ---------------------------------------------------------------------------
// Main components (library)
// ---------------------------------------------------------------------------

export interface MainSpec {
  key: string;
  name: string;
  /** Present for variants: the parent COMPONENT_SET. */
  set?: { key: string; name: string };
}

/** Mock library COMPONENT node (optionally a variant inside a COMPONENT_SET). */
export function mainComponent(spec: MainSpec): any {
  const parent = spec.set
    ? { id: 'set:' + spec.set.key.slice(0, 8), type: 'COMPONENT_SET', key: spec.set.key, name: spec.set.name }
    : { id: 'page:library', type: 'PAGE', name: 'Library' };
  return mockComponentNode({
    id: 'main:' + spec.key.slice(0, 8),
    key: spec.key,
    name: spec.name,
    remote: true,
    parent,
  });
}

export const MAINS = {
  section: (): MainSpec => ({ key: KEYS.section, name: 'Divi Section' }),
  row: (): MainSpec => ({ key: KEYS.row, name: 'Divi Row' }),
  column: (): MainSpec => ({ key: KEYS.column, name: 'Divi Column' }),
  button: (type: 'Primary' | 'Secondary'): MainSpec => ({
    key: type === 'Primary' ? KEYS.buttonPrimary : KEYS.buttonSecondary,
    name: 'Type=' + type,
    set: { key: KEYS.buttonSet, name: 'Divi Button' },
  }),
  text: (): MainSpec => ({ key: KEYS.text, name: 'Divi Text' }),
  image: (): MainSpec => ({ key: KEYS.image, name: 'Divi Image' }),
  blurb: (): MainSpec => ({ key: KEYS.blurb, name: 'Divi Blurb' }),
  rogueCard: (): MainSpec => ({ key: KEYS.rogueCard, name: 'Promo Card' }),
};

/**
 * Raw INSTANCE. The main component is only reachable through `getMainComponentAsync()`;
 * the sync `mainComponent` getter throws, as it does under dynamic-page document access.
 * `spec = null` simulates a missing library / deleted main component.
 */
export function instance(id: string, name: string, spec: MainSpec | null, overrides: Record<string, unknown> = {}): any {
  const main = spec ? mainComponent(spec) : null;
  const node = mockInstanceNode({
    id,
    name,
    getMainComponentAsync: async () => main,
    getPluginData: () => '',
    ...overrides,
  });
  Object.defineProperty(node, 'mainComponent', {
    enumerable: false,
    get() {
      throw new Error('in dynamic-page mode, use getMainComponentAsync');
    },
  });
  return node;
}

// ---------------------------------------------------------------------------
// Approved library instances
// ---------------------------------------------------------------------------

/** Divi Section instance (auto layout, slot content as children). */
export function section(id: string, name: string, children: any[], o: Record<string, unknown> = {}): any {
  return instance(id, name, MAINS.section(), {
    width: 1440,
    height: 720,
    layoutMode: 'VERTICAL',
    paddingTop: 96,
    paddingBottom: 96,
    paddingLeft: 80,
    paddingRight: 80,
    itemSpacing: 48,
    fills: [solid(HEX.white)],
    children,
    ...o,
  });
}

export function row(id: string, name: string, children: any[], o: Record<string, unknown> = {}): any {
  return instance(id, name, MAINS.row(), {
    width: 1280,
    height: 480,
    layoutMode: 'HORIZONTAL',
    itemSpacing: 32,
    children,
    ...o,
  });
}

export function column(id: string, name: string, children: any[], o: Record<string, unknown> = {}): any {
  return instance(id, name, MAINS.column(), {
    width: 624,
    height: 480,
    layoutMode: 'VERTICAL',
    itemSpacing: 24,
    children,
    ...o,
  });
}

/** Divi Button instance with its internal label (and optional internal icon). */
export function button(id: string, label: string, type: 'Primary' | 'Secondary' = 'Primary', o: Record<string, unknown> = {}): any {
  return instance(id, 'Button', MAINS.button(type), {
    width: 160,
    height: 48,
    layoutMode: 'HORIZONTAL',
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 24,
    paddingRight: 24,
    itemSpacing: 8,
    cornerRadius: 8,
    fills: [solid(type === 'Primary' ? HEX.brand : HEX.white)],
    variantProperties: { Type: type, State: 'Default' },
    componentProperties: {
      'Type': { type: 'VARIANT', value: type },
      'State': { type: 'VARIANT', value: 'Default' },
      'Label#104:0': { type: 'TEXT', value: label },
      'Show icon#104:1': { type: 'BOOLEAN', value: false },
    },
    // Library internals: the label TEXT is owned by the component (default black fill, never checked).
    children: [
      mockTextNode({ id: id + ';label', name: 'Label', characters: label, fontSize: 15, fontWeight: 600 }),
    ],
    ...o,
  });
}

/** Divi Text instance; `characters` lives in an internal TEXT layer. */
export function textModule(id: string, name: string, characters: string, size: 'body' | 'h1' | 'h2' = 'body'): any {
  const fontSize = size === 'h1' ? 56 : size === 'h2' ? 36 : 18; // library-defined (off-token on purpose: internals are not ours)
  return instance(id, name, MAINS.text(), {
    width: 560,
    height: fontSize * 2,
    layoutMode: 'VERTICAL',
    children: [
      mockTextNode({ id: id + ';copy', name: 'Copy', characters, fontSize, fontWeight: size === 'body' ? 400 : 800 }),
    ],
  });
}

/** Divi Image instance (image fill on an internal rectangle). */
export function imageModule(id: string, name: string, w = 560, h = 400): any {
  return instance(id, name, MAINS.image(), {
    width: w,
    height: h,
    children: [
      mockRectangleNode({ id: id + ';media', name: 'Media', width: w, height: h, fills: [photo('img-' + id)] }),
    ],
  });
}

/** Divi Blurb instance: icon + heading + body, all internal. */
export function blurb(id: string, title: string, body: string): any {
  return instance(id, 'Feature Blurb', MAINS.blurb(), {
    width: 384,
    height: 240,
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    children: [
      mockRectangleNode({ id: id + ';icon', name: 'Icon', width: 48, height: 48, fills: [solid('#e0e7ff')] }),
      mockTextNode({ id: id + ';title', name: 'Title', characters: title, fontSize: 22, fontWeight: 700 }),
      mockTextNode({ id: id + ';body', name: 'Body', characters: body }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Plain (non-component) layers
// ---------------------------------------------------------------------------

/** Plain auto-layout frame (on-scale spacing by default, no fill). */
export function autoFrame(id: string, name: string, children: any[], o: Record<string, unknown> = {}): any {
  return mockFrameNode({
    id,
    name,
    layoutMode: 'VERTICAL',
    itemSpacing: 24,
    width: 640,
    height: 400,
    children,
    getPluginData: () => '',
    ...o,
  });
}

/** Large decorative rectangle (Figma default name → background-shape). */
export function decorativeRect(id: string, name = 'Rectangle 7', o: Record<string, unknown> = {}): any {
  return mockRectangleNode({ id, name, width: 1440, height: 720, fills: [solid('#c7d2fe')], ...o });
}

/**
 * A manually built button: frame + horizontal auto layout + solid fill + text child.
 * Exactly what a designer draws when they do not use the library Button.
 */
export function handmadeButton(id: string, name: string, label: string, o: Record<string, unknown> = {}): any {
  return autoFrame(id, name, [text(id + '/label', 'Label', label, { color: HEX.white, width: 92, height: 24 })], {
    layoutMode: 'HORIZONTAL',
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 24,
    paddingRight: 24,
    itemSpacing: 8,
    cornerRadius: 8,
    width: 140,
    height: 48,
    fills: [solid(HEX.brand)],
    ...o,
  });
}

/** Small pill (tag / badge) — structurally a button, but with an auto-generated name. */
export function handmadePill(id: string, name: string, label: string, o: Record<string, unknown> = {}): any {
  return autoFrame(id, name, [text(id + '/label', 'Label', label, { color: HEX.white, width: 40, height: 24 })], {
    layoutMode: 'HORIZONTAL',
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 12,
    paddingRight: 12,
    itemSpacing: 4,
    cornerRadius: 12,
    width: 72,
    height: 32,
    fills: [solid(HEX.brand)],
    ...o,
  });
}

/** Top-level page frame ("Home — Desktop"). */
export function pageFrame(id: string, name: string, children: any[], o: Record<string, unknown> = {}): any {
  const frame = mockFrameNode({
    id,
    name,
    width: 1440,
    height: 4200,
    layoutMode: 'VERTICAL',
    itemSpacing: 0,
    fills: [solid(HEX.white)],
    children,
    getPluginData: () => '',
    ...o,
  });
  // Real top-level frames sit directly on a page.
  frame.parent = { id: '0:1', type: 'PAGE', name: 'Marketing site' };
  return frame;
}
