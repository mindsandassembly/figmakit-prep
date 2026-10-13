/**
 * divi/approved-tokens — spacing, colors and typography must come from the approved token set.
 */

import type {
  DesignNode,
  FixDescriptor,
  FixNumberProperty,
  LintContext,
  LintRule,
  PaintSnapshot,
  RuleReport,
  TokenSet,
} from '../types';
import { SPACING_SCALE } from '../../shared/constants';
import { snapSpacing } from '../../features/token-preview';
import { colorDistance, parseColorToRGB } from '../../features/color-checker';

const RULE_ID = 'divi/approved-tokens';

const DEFAULT_OPTIONS = {
  checkSpacing: true,
  checkColors: true,
  checkTypography: true,
  snapTolerance: 2,
  colorSnapDistance: 12,
  acceptStylesAndVariables: true,
  useFigmaKitSpacingScale: true,
  checkInstances: false,
  ignoreNamePatterns: [] as string[],
};

type Options = typeof DEFAULT_OPTIONS;

const BOOLEAN_OPTIONS = [
  'checkSpacing',
  'checkColors',
  'checkTypography',
  'acceptStylesAndVariables',
  'useFigmaKitSpacingScale',
  'checkInstances',
] as const;

const SKIPPED_ROLES = ['background-shape', 'invisible'];

const SPACING_PROPS: Array<{ property: FixNumberProperty; label: string; read: (n: DesignNode) => number }> = [
  { property: 'paddingTop', label: 'Padding top', read: (n) => n.padding && n.padding.top },
  { property: 'paddingRight', label: 'Padding right', read: (n) => n.padding && n.padding.right },
  { property: 'paddingBottom', label: 'Padding bottom', read: (n) => n.padding && n.padding.bottom },
  { property: 'paddingLeft', label: 'Padding left', read: (n) => n.padding && n.padding.left },
  { property: 'itemSpacing', label: 'Item spacing', read: (n) => n.itemSpacing },
];

function opts(context: LintContext): Options {
  return { ...DEFAULT_OPTIONS, ...(context.options as Partial<Options>) };
}

function compilePatterns(patterns: unknown): RegExp[] {
  const out: RegExp[] = [];
  if (!Array.isArray(patterns)) return out;
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    try {
      out.push(new RegExp(p, 'i'));
    } catch (e) {
      // invalid patterns are rejected by validateOptions; ignore defensively
    }
  }
  return out;
}

function isIgnored(node: DesignNode, o: Options): boolean {
  if (node.fkLabel && SKIPPED_ROLES.indexOf(node.fkLabel) !== -1) return true;
  if (node.analysis && SKIPPED_ROLES.indexOf(node.analysis.role) !== -1) return true;
  const patterns = compilePatterns(o.ignoreNamePatterns);
  for (const re of patterns) {
    if (re.test(node.baseName) || re.test(node.name)) return true;
  }
  return false;
}

/** Expand #rgb → #rrggbb and lowercase. Returns null for invalid hex. */
function normalizeHex(value: string): string | null {
  if (typeof value !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return '#' + h;
}

interface SpacingToken {
  name: string;
  value: number;
}

/** Allowed spacing tokens, or null when spacing is unconstrained. */
function allowedSpacing(tokens: TokenSet, o: Options): { list: SpacingToken[]; figmaKitScale: boolean } | null {
  if (tokens.spacing && tokens.spacing.length > 0) {
    const list = tokens.spacing
      .filter((t) => t && typeof t.value === 'number' && isFinite(t.value))
      .map((t) => ({ name: t.name, value: t.value }));
    return list.length ? { list, figmaKitScale: false } : null;
  }
  if (o.useFigmaKitSpacingScale) {
    return {
      list: Object.keys(SPACING_SCALE).map((name) => ({ name, value: SPACING_SCALE[name] })),
      figmaKitScale: true,
    };
  }
  return null;
}

/** Nearest token by absolute distance; ties go to the smaller value, then to the earlier token. */
function nearestSpacing(value: number, allowed: { list: SpacingToken[]; figmaKitScale: boolean }): SpacingToken | null {
  if (allowed.figmaKitScale && value > 0) {
    const name = snapSpacing(value);
    if (name && Object.prototype.hasOwnProperty.call(SPACING_SCALE, name)) {
      return { name, value: SPACING_SCALE[name] };
    }
  }
  let best: SpacingToken | null = null;
  let bestDiff = Infinity;
  for (const t of allowed.list) {
    const diff = Math.abs(value - t.value);
    if (diff < bestDiff || (diff === bestDiff && best !== null && t.value < best.value)) {
      best = t;
      bestDiff = diff;
    }
  }
  return best;
}

function fmtPx(n: number): string {
  return String(Math.round(n * 100) / 100) + 'px';
}

function spacingApplies(node: DesignNode, context: LintContext, o: Options): boolean {
  if (!o.checkSpacing) return false;
  if (node.type === 'INSTANCE' && !o.checkInstances) return false;
  if (!node.layoutMode || node.layoutMode === 'NONE') return false;
  return allowedSpacing(context.tokens, o) !== null;
}

function palette(tokens: TokenSet): Array<{ name: string; hex: string; rgb: { r: number; g: number; b: number } }> {
  const out: Array<{ name: string; hex: string; rgb: { r: number; g: number; b: number } }> = [];
  for (const c of tokens.colors || []) {
    const hex = c && normalizeHex(c.value);
    if (!hex) continue;
    const rgb = parseColorToRGB(hex);
    if (rgb) out.push({ name: c.name, hex, rgb });
  }
  return out;
}

function colorsApply(node: DesignNode, context: LintContext, o: Options): boolean {
  if (!o.checkColors) return false;
  if (node.type === 'INSTANCE' && !o.checkInstances) return false;
  if (palette(context.tokens).length === 0) return false;
  return (node.fills && node.fills.length > 0) || (node.strokes && node.strokes.length > 0);
}

function typographyApplies(node: DesignNode, context: LintContext, o: Options): boolean {
  if (!o.checkTypography) return false;
  if (node.type !== 'TEXT' || !node.text) return false;
  const t = context.tokens;
  return !!((t.typography && t.typography.length) || (t.fontFamilies && t.fontFamilies.length));
}

function isVariableBound(node: DesignNode, property: string): boolean {
  const bv = node.boundVariables;
  if (!bv || typeof bv !== 'object') return false;
  const ids = bv[property];
  return Array.isArray(ids) && ids.length > 0;
}

function checkSpacing(node: DesignNode, context: LintContext, o: Options): RuleReport[] {
  const allowed = allowedSpacing(context.tokens, o);
  if (!allowed) return [];
  const values: Record<number, true> = {};
  for (const t of allowed.list) values[t.value] = true;
  const tolerance = typeof o.snapTolerance === 'number' ? o.snapTolerance : DEFAULT_OPTIONS.snapTolerance;
  const out: RuleReport[] = [];
  for (const p of SPACING_PROPS) {
    // itemSpacing has no visual effect when the gap is "Auto" (SPACE_BETWEEN) or on GRID layouts
    // (which use row/column gaps instead).
    if (p.property === 'itemSpacing' && (node.layoutMode === 'GRID' || node.primaryAxisAlignItems === 'SPACE_BETWEEN')) continue;
    const v = p.read(node);
    if (typeof v !== 'number' || !isFinite(v)) continue; // mixed / unavailable
    if (v === 0 || values[v]) continue;
    const bound = isVariableBound(node, p.property);
    // A bound spacing variable counts as approved.
    if (bound && o.acceptStylesAndVariables) continue;
    const nearest = nearestSpacing(v, allowed);
    if (!nearest) continue;
    const delta = Math.abs(v - nearest.value);
    const expected = `${nearest.name} (${fmtPx(nearest.value)})`;
    let fix: FixDescriptor;
    if (bound) {
      // Writing a raw number would replace the variable binding; never offer that.
      fix = {
        kind: 'UNSUPPORTED',
        description: 'Bound to a variable; bind an approved spacing variable instead.',
        operations: [],
      };
    } else if (delta <= tolerance && nearest.value >= 0) {
      fix = {
        kind: 'REQUIRES_CONFIRMATION',
        description: `Set ${p.label.toLowerCase()} ${fmtPx(v)} → ${fmtPx(nearest.value)} (${nearest.name})`,
        operations: [{ op: 'setNumber', nodeId: node.id, property: p.property, from: v, to: nearest.value }],
      };
    } else {
      fix = {
        kind: 'UNSUPPORTED',
        description: `Off by ${fmtPx(delta)}; too far from a token to snap automatically.`,
        operations: [],
      };
    }
    out.push({
      code: 'off-scale-spacing',
      message: `${p.label} ${fmtPx(v)} is not on the spacing scale.`,
      suggestion: `Use spacing token ${expected}.`,
      expected,
      actual: fmtPx(v),
      discriminator: p.property,
      fix,
      data: { property: p.property, value: v, nearestToken: nearest.name, nearestValue: nearest.value },
    });
  }
  return out;
}

function checkPaints(
  node: DesignNode,
  target: 'fills' | 'strokes',
  paints: PaintSnapshot[],
  styleId: string,
  context: LintContext,
  o: Options,
): RuleReport[] {
  if (!paints || paints.length === 0) return [];
  // A paint style (or mixed styles) on the layer counts as approved.
  if (o.acceptStylesAndVariables && styleId) return [];
  const pal = palette(context.tokens);
  if (pal.length === 0) return [];
  const maxDist = typeof o.colorSnapDistance === 'number' ? o.colorSnapDistance : DEFAULT_OPTIONS.colorSnapDistance;
  const out: RuleReport[] = [];
  const label = target === 'fills' ? 'Fill' : 'Stroke';
  for (let i = 0; i < paints.length; i++) {
    const p = paints[i];
    if (!p || p.type !== 'SOLID' || p.visible === false || !p.hex) continue;
    if (typeof p.opacity === 'number' && p.opacity <= 0) continue;
    if (o.acceptStylesAndVariables && p.boundVariableId) continue;
    const hex = normalizeHex(p.hex);
    if (!hex) continue;
    if (pal.some((c) => c.hex === hex)) continue;
    const rgb = parseColorToRGB(hex);
    let nearest: { name: string; hex: string } | null = null;
    let nearestDist = Infinity;
    if (rgb) {
      for (const c of pal) {
        const d = colorDistance(rgb, c.rgb);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = c;
        }
      }
    }
    const expected = nearest ? `${nearest.name} (${nearest.hex})` : undefined;
    let fix: FixDescriptor;
    if (styleId || p.boundVariableId) {
      // Assigning a raw color would detach the paint style / variable binding; never offer that.
      fix = {
        kind: 'UNSUPPORTED',
        description: styleId
          ? 'Layer uses a paint style; apply an approved color style instead.'
          : 'Color is bound to a variable; bind an approved color variable instead.',
        operations: [],
      };
    } else if (nearest && nearestDist <= maxDist) {
      fix = {
        kind: 'REQUIRES_CONFIRMATION',
        description: `Set ${label.toLowerCase()} ${hex} → ${nearest.hex} (${nearest.name})`,
        operations: [{ op: 'setSolidPaintColor', nodeId: node.id, target, index: i, from: hex, to: nearest.hex }],
      };
    } else {
      fix = {
        kind: 'UNSUPPORTED',
        description: 'No approved color is close enough to snap automatically; pick a color style or variable.',
        operations: [],
      };
    }
    out.push({
      code: 'unapproved-color',
      message: `${label} color ${hex} is not in the approved palette.`,
      suggestion: nearest
        ? `Use approved color ${nearest.name} (${nearest.hex}) or a color style/variable.`
        : 'Use an approved color style or variable.',
      expected,
      actual: hex,
      discriminator: `${target}:${i}`,
      fix,
      data: {
        target,
        index: i,
        hex,
        nearestToken: nearest ? nearest.name : null,
        distance: nearest ? Math.round(nearestDist * 100) / 100 : null,
      },
    });
  }
  return out;
}

function sameFamily(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function describeTypeToken(t: { name: string; fontFamily?: string; fontSize: number; fontWeight?: number }): string {
  const parts = [fmtPx(t.fontSize)];
  if (typeof t.fontWeight === 'number') parts.push(String(t.fontWeight));
  if (t.fontFamily) parts.unshift(t.fontFamily);
  return `${t.name} (${parts.join(' / ')})`;
}

function checkTypography(node: DesignNode, context: LintContext, o: Options): RuleReport[] {
  const text = node.text;
  if (!text) return [];
  if (o.acceptStylesAndVariables && node.textStyleId) return [];
  const out: RuleReport[] = [];
  const families = context.tokens.fontFamilies || [];
  const unsupported: FixDescriptor = {
    kind: 'UNSUPPORTED',
    description: 'Apply an approved text style manually.',
    operations: [],
  };

  if (families.length > 0 && text.fontFamily !== null && typeof text.fontFamily === 'string') {
    if (!families.some((f) => typeof f === 'string' && sameFamily(f, text.fontFamily as string))) {
      out.push({
        code: 'unapproved-font-family',
        message: `Font family "${text.fontFamily}" is not approved.`,
        suggestion: `Use ${families.join(' or ')}.`,
        expected: families.join(', '),
        actual: text.fontFamily,
        fix: unsupported,
      });
    }
  }

  const styles = (context.tokens.typography || []).filter((t) => t && typeof t.fontSize === 'number');
  if (styles.length > 0 && typeof text.fontSize === 'number' && typeof text.fontWeight === 'number') {
    const size = text.fontSize;
    const weight = text.fontWeight;
    const family = text.fontFamily;
    let familyUnknown = false;
    const matches = styles.some((t) => {
      if (t.fontSize !== size) return false;
      if (typeof t.fontWeight === 'number' && t.fontWeight !== weight) return false;
      if (t.fontFamily) {
        if (family === null) {
          familyUnknown = true;
          return false;
        }
        if (!sameFamily(t.fontFamily, family)) return false;
      }
      return true;
    });
    // When the only reason for a mismatch could be a mixed family, skip (cannot decide).
    if (!matches && !familyUnknown) {
      let best = styles[0];
      let bestScore = Infinity;
      for (const t of styles) {
        const w = typeof t.fontWeight === 'number' ? Math.abs(t.fontWeight - weight) / 100 : 0;
        const score = Math.abs(t.fontSize - size) * 10 + w;
        if (score < bestScore) {
          bestScore = score;
          best = t;
        }
      }
      const expected = describeTypeToken(best);
      out.push({
        code: 'unapproved-text-style',
        message: `Text ${fmtPx(size)} / ${weight} does not match any approved text style.`,
        suggestion: `Use text style ${expected}.`,
        expected,
        actual: `${fmtPx(size)} / ${weight}`,
        fix: unsupported,
        data: { fontSize: size, fontWeight: weight, nearestToken: best.name },
      });
    }
  }
  return out;
}

function validateOptions(options: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const k of BOOLEAN_OPTIONS) {
    if (options[k] !== undefined && typeof options[k] !== 'boolean') errs.push(`"${k}" must be a boolean.`);
  }
  for (const k of ['snapTolerance', 'colorSnapDistance']) {
    const v = options[k];
    if (v !== undefined && (typeof v !== 'number' || !isFinite(v) || v < 0)) {
      errs.push(`"${k}" must be a finite number >= 0.`);
    }
  }
  const pats = options.ignoreNamePatterns;
  if (pats !== undefined) {
    if (!Array.isArray(pats)) {
      errs.push('"ignoreNamePatterns" must be an array of regex strings.');
    } else {
      pats.forEach((p, i) => {
        if (typeof p !== 'string') {
          errs.push(`"ignoreNamePatterns[${i}]" must be a string.`);
          return;
        }
        try {
          new RegExp(p, 'i');
        } catch (e) {
          errs.push(`"ignoreNamePatterns[${i}]" is not a valid regex.`);
        }
      });
    }
  }
  return errs;
}

const DOCS = `Checks that layer styling uses the approved token set from the registry (\`tokens\`).

**Evidence used**
- *Spacing*: padding (top/right/bottom/left) and item spacing of **auto-layout** layers only. \`0\` is always allowed.
  Item spacing is skipped on GRID layouts and when the gap is "Auto" (\`SPACE_BETWEEN\`), where it has no effect.
  Padding / item spacing bound to a variable counts as approved when \`acceptStylesAndVariables\` is on.
  Allowed values are \`tokens.spacing\`; if the registry has no spacing tokens and \`useFigmaKitSpacingScale\` is on,
  the FigmaKit spacing scale (4, 8, 12, 16, 20, 24, 32, 48, 80, 96) is used.
- *Colors*: visible SOLID fills/strokes compared exactly (hex) with \`tokens.colors\`. Skipped entirely when the
  registry defines no colors. Paints bound to a variable and layers using a paint style count as approved when
  \`acceptStylesAndVariables\` is on.
- *Typography*: TEXT layers without a text style. Font family must be in \`tokens.fontFamilies\`; size/weight
  (and family, if the token sets one) must match a \`tokens.typography\` entry. Mixed values are skipped.

**Certainty**: always \`confirmed\` (values are read directly from the layer).

**Codes**: \`off-scale-spacing\`, \`unapproved-color\`, \`unapproved-font-family\`, \`unapproved-text-style\`.

**Options**
- \`checkSpacing\`, \`checkColors\`, \`checkTypography\` (default true).
- \`snapTolerance\` (2): spacing within this many px of a token gets a confirm-to-apply fix.
- \`colorSnapDistance\` (12): RGB Euclidean distance under which a color gets a confirm-to-apply fix.
- \`acceptStylesAndVariables\` (true): treat styles / bound variables as approved.
- \`useFigmaKitSpacingScale\` (true): fallback spacing scale when the registry has none.
- \`checkInstances\` (false): also check spacing/colors on INSTANCE layers (normally owned by the library).
- \`ignoreNamePatterns\` ([]): regexes (case-insensitive) for intentionally custom layers.

**Skipped**: layers inside instances, layers labelled/classified as \`background-shape\` or \`invisible\`.

**Limitations**: the plugin cannot cheaply verify that a style or variable comes from the approved library, so
any style/variable is accepted. Gradients and image fills are not checked. Opacity is ignored.

**Autofix**: spacing and color snaps are \`REQUIRES_CONFIRMATION\` (visual change); typography has no autofix.
Values bound to a variable or paints on a styled layer never get a snap (it would detach the binding / style).`;

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Spacing, colors and typography must use approved design tokens.',
    docs: DOCS,
    category: 'tokens',
    defaultSeverity: 'warning',
    defaultOptions: { ...DEFAULT_OPTIONS, ignoreNamePatterns: [] },
    fixable: true,
    validateOptions,
  },

  appliesTo(node, context) {
    if (context.isInstanceInternal(node)) return false;
    const o = opts(context);
    if (isIgnored(node, o)) return false;
    return spacingApplies(node, context, o) || colorsApply(node, context, o) || typographyApplies(node, context, o);
  },

  validate(node, context) {
    const o = opts(context);
    const out: RuleReport[] = [];
    if (spacingApplies(node, context, o)) out.push(...checkSpacing(node, context, o));
    if (colorsApply(node, context, o)) {
      out.push(...checkPaints(node, 'fills', node.fills, node.fillStyleId, context, o));
      out.push(...checkPaints(node, 'strokes', node.strokes, node.strokeStyleId, context, o));
    }
    if (typographyApplies(node, context, o)) out.push(...checkTypography(node, context, o));
    return out;
  },
};
