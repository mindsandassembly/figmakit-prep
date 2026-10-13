import { describe, it, expect } from 'vitest';
import type { ComponentRegistry, DesignNode, LintConfig, PaintSnapshot, TokenSet } from '../../../src/lint/types';
import { rule } from '../../../src/lint/rules/approved-tokens';
import { node, instanceOf, textNode, lint, testRegistry, byName } from '../helpers';

const ID = 'divi/approved-tokens';

function solid(hex: string, extra: Partial<PaintSnapshot> = {}): PaintSnapshot {
  return { type: 'SOLID', visible: true, hex, opacity: 1, boundVariableId: null, ...extra };
}

function registryWith(tokens: TokenSet | undefined): ComponentRegistry {
  const r = testRegistry();
  r.tokens = tokens;
  return r;
}

function run(roots: DesignNode[], opts: { options?: Record<string, unknown>; registry?: ComponentRegistry; config?: LintConfig } = {}) {
  const config: LintConfig =
    opts.config ?? { extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', rules: opts.options ? { [ID]: ['warning', opts.options] } : {} };
  const out = lint(roots, { rules: [rule], registry: opts.registry, config });
  return { ...out, issues: out.result.issues.filter((i) => i.ruleId === ID) };
}

function autoFrame(name: string, partial: Partial<DesignNode> = {}): DesignNode {
  return node({ name, layoutMode: 'VERTICAL', ...partial });
}

describe('divi/approved-tokens — meta', () => {
  it('has id, category, docs and option validation', () => {
    expect(rule.meta.id).toBe(ID);
    expect(rule.meta.category).toBe('tokens');
    expect(rule.meta.docs).toMatch(/Limitations/);
    expect(rule.meta.validateOptions!(rule.meta.defaultOptions)).toEqual([]);
    expect(rule.meta.validateOptions!({ snapTolerance: -1 })).toHaveLength(1);
    expect(rule.meta.validateOptions!({ checkSpacing: 'yes' })).toHaveLength(1);
    expect(rule.meta.validateOptions!({ ignoreNamePatterns: ['('] })).toHaveLength(1);
    expect(rule.meta.validateOptions!({ ignoreNamePatterns: 'x' })).toHaveLength(1);
  });

  it('invalid options surface as a config diagnostic', () => {
    const out = run([autoFrame('A')], { options: { colorSnapDistance: 'far' } });
    expect(out.configDiagnostics.some((d) => d.code === 'invalid-options')).toBe(true);
  });
});

describe('divi/approved-tokens — spacing', () => {
  it('treats variable-bound padding / item spacing as approved (acceptStylesAndVariables)', () => {
    const out = run([
      autoFrame('Card', {
        padding: { top: 18, right: 24, bottom: 24, left: 24 },
        itemSpacing: 13,
        boundVariables: { paddingTop: ['VariableID:1'], itemSpacing: ['VariableID:2'] },
      }),
    ]);
    expect(out.issues).toEqual([]);
  });

  it('with acceptStylesAndVariables off, bound spacing is reported but never gets a snap fix', () => {
    const out = run(
      [autoFrame('Card', { padding: { top: 23, right: 24, bottom: 24, left: 24 }, boundVariables: { paddingTop: ['VariableID:1'] } })],
      { options: { acceptStylesAndVariables: false } },
    );
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].fix!.kind).toBe('UNSUPPORTED');
    expect(out.issues[0].fix!.operations).toEqual([]);
    expect(out.issues[0].fixable).toBe(false);
  });

  it('ignores itemSpacing on SPACE_BETWEEN ("Auto" gap) and GRID layouts', () => {
    const out = run([
      autoFrame('Between', { layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'SPACE_BETWEEN', itemSpacing: 37 }),
      autoFrame('Grid', { layoutMode: 'GRID', itemSpacing: 37 }),
    ]);
    expect(out.issues).toEqual([]);
    const packed = run([autoFrame('Packed', { layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'MIN', itemSpacing: 37 })]);
    expect(packed.issues.map((i) => i.code)).toEqual(['off-scale-spacing']);
  });

  it('flags off-scale padding with nearest token and a confirm-to-apply snap fix', () => {
    const out = run([autoFrame('Card', { padding: { top: 23, right: 24, bottom: 24, left: 24 } })]);
    expect(out.issues).toHaveLength(1);
    const i = out.issues[0];
    expect(i.code).toBe('off-scale-spacing');
    expect(i.severity).toBe('warning');
    expect(i.certainty).toBe('confirmed');
    expect(i.expected).toBe('md (24px)');
    expect(i.actual).toBe('23px');
    expect(i.fix!.kind).toBe('REQUIRES_CONFIRMATION');
    expect(i.fix!.operations).toEqual([{ op: 'setNumber', nodeId: i.nodeId, property: 'paddingTop', from: 23, to: 24 }]);
    expect(i.fixable).toBe(true);
  });

  it('far-off values get an UNSUPPORTED fix; ties resolve to the smaller token', () => {
    const out = run([autoFrame('Card', { itemSpacing: 40 })]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].expected).toBe('lg (32px)');
    expect(out.issues[0].fix!.kind).toBe('UNSUPPORTED');
    expect(out.issues[0].fixable).toBe(false);
  });

  it('reports one issue per property with distinct stable ids', () => {
    const out = run([autoFrame('Card', { padding: { top: 5, right: 7, bottom: 9, left: 11 }, itemSpacing: 13 })]);
    // The engine orders same-node issues by (ruleId, code, id), so compare as a set.
    expect(out.issues.map((i) => i.data!.property).sort()).toEqual(['itemSpacing', 'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingTop']);
    expect(new Set(out.issues.map((i) => i.id)).size).toBe(5);
    const again = run([autoFrame('Card', { padding: { top: 5, right: 7, bottom: 9, left: 11 }, itemSpacing: 13 })]);
    expect(again.issues.map((i) => i.id)).toEqual(out.issues.map((i) => i.id));
  });

  it('allows 0 and on-scale values', () => {
    const out = run([autoFrame('Card', { padding: { top: 0, right: 16, bottom: 96, left: 4 }, itemSpacing: 0 })]);
    expect(out.issues).toEqual([]);
  });

  it('ignores spacing on non-auto-layout frames (no false positives)', () => {
    const out = run([node({ name: 'Free frame', padding: { top: 13, right: 13, bottom: 13, left: 13 }, itemSpacing: 7 })]);
    expect(out.issues).toEqual([]);
    expect(out.result.ruleSummaries.find((s) => s.ruleId === ID)!.checks).toBe(0);
  });

  it('uses registry spacing tokens when present', () => {
    const reg = registryWith({ spacing: [{ name: 'gap', value: 10 }, { name: 'wide', value: 30 }] });
    const out = run([autoFrame('Card', { itemSpacing: 24, padding: { top: 10, right: 30, bottom: 0, left: 11 } })], { registry: reg });
    const byProp = (p: string) => out.issues.find((i) => i.data!.property === p)!;
    expect(out.issues).toHaveLength(2);
    expect(byProp('paddingLeft').expected).toBe('gap (10px)');
    expect(byProp('paddingLeft').fix!.kind).toBe('REQUIRES_CONFIRMATION');
    expect(byProp('itemSpacing').expected).toBe('wide (30px)');
    expect(byProp('itemSpacing').fix!.kind).toBe('UNSUPPORTED');
  });

  it('falls back to the FigmaKit scale only when enabled', () => {
    const roots = () => [autoFrame('Card', { itemSpacing: 23 })];
    expect(run(roots(), { registry: registryWith({}) }).issues).toHaveLength(1);
    expect(run(roots(), { registry: registryWith({}), options: { useFigmaKitSpacingScale: false } }).issues).toEqual([]);
  });

  it('respects snapTolerance', () => {
    const out = run([autoFrame('Card', { itemSpacing: 21 })], { options: { snapTolerance: 0 } });
    expect(out.issues[0].fix!.kind).toBe('UNSUPPORTED');
  });

  it('skips instance internals and INSTANCE layers unless checkInstances', () => {
    const roots = () => [
      instanceOf('key-button', { name: 'Button', layoutMode: 'HORIZONTAL', itemSpacing: 7, fills: [solid('#ff0000')] }, {
        variantProperties: { Type: 'Primary' },
      }),
    ];
    const withChild = roots();
    withChild[0].children = [autoFrame('Inner', { itemSpacing: 7, fills: [solid('#ff0000')] })];
    expect(run(withChild).issues).toEqual([]);
    const checked = run(roots(), { options: { checkInstances: true } });
    expect(checked.issues.map((i) => i.code).sort()).toEqual(['off-scale-spacing', 'unapproved-color']);
  });

  it('checks instance internals when settings.checkInstanceInternals is on', () => {
    const inst = instanceOf('key-button', { name: 'Button' });
    inst.children = [autoFrame('Inner', { itemSpacing: 7 })];
    const out = run([inst], {
      config: { extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', settings: { checkInstanceInternals: true } },
    });
    expect(out.issues.map((i) => i.nodeName)).toEqual(['Inner']);
  });

  it('skips ignored names and background-shape / invisible layers', () => {
    const roots = [
      node({
        name: 'Page',
        children: [
          autoFrame('Decor blob', { itemSpacing: 7 }),
          autoFrame('Shape', { itemSpacing: 7, analysis: { role: 'background-shape', confidence: 90, source: 'structure' } }),
          autoFrame('[fk:invisible] Spacer', { itemSpacing: 7, fkLabel: 'invisible' }),
          autoFrame('Real', { itemSpacing: 7 }),
        ],
      }),
    ];
    const out = run(roots, { options: { ignoreNamePatterns: ['^decor'] } });
    expect(out.issues.map((i) => i.nodeName)).toEqual(['Real']);
  });
});

describe('divi/approved-tokens — colors', () => {
  it('flags an off-palette fill near a token with a snap fix', () => {
    const out = run([node({ name: 'Box', fills: [solid('#4f46e6')] })]);
    expect(out.issues).toHaveLength(1);
    const i = out.issues[0];
    expect(i.code).toBe('unapproved-color');
    expect(i.actual).toBe('#4f46e6');
    expect(i.expected).toBe('brand (#4f46e5)');
    expect(i.fix!.kind).toBe('REQUIRES_CONFIRMATION');
    expect(i.fix!.operations).toEqual([
      { op: 'setSolidPaintColor', nodeId: i.nodeId, target: 'fills', index: 0, from: '#4f46e6', to: '#4f46e5' },
    ]);
  });

  it('far colors get UNSUPPORTED; strokes and indexes are discriminated', () => {
    const out = run([node({ name: 'Box', fills: [solid('#ffffff'), solid('#ff0000')], strokes: [solid('#ff0000')] })]);
    expect(out.issues.map((i) => [i.data!.target, i.data!.index, i.fix!.kind]).sort()).toEqual([
      ['fills', 1, 'UNSUPPORTED'],
      ['strokes', 0, 'UNSUPPORTED'],
    ]);
    expect(out.issues[0].id).not.toBe(out.issues[1].id);
  });

  it('accepts palette colors (#rgb tokens normalized), styles, variables, hidden and non-solid paints', () => {
    const reg = registryWith({ colors: [{ name: 'ink', value: '#111' }] });
    const roots = [
      node({
        name: 'Page',
        children: [
          node({ name: 'Ok', fills: [solid('#111111')] }),
          node({ name: 'Styled', fills: [solid('#ff0000')], fillStyleId: 'S:abc' }),
          node({ name: 'Mixed', strokes: [solid('#ff0000')], strokeStyleId: 'MIXED' }),
          node({ name: 'Var', fills: [solid('#ff0000', { boundVariableId: 'VariableID:1' })] }),
          node({ name: 'Hidden', fills: [solid('#ff0000', { visible: false })] }),
          node({ name: 'Transparent', fills: [solid('#ff0000', { opacity: 0 })] }),
          node({ name: 'Image', fills: [{ type: 'IMAGE', visible: true, hex: null, opacity: 1, boundVariableId: null }] }),
        ],
      }),
    ];
    expect(run(roots, { registry: reg }).issues).toEqual([]);
  });

  it('acceptStylesAndVariables=false checks styled / bound paints too', () => {
    const roots = [
      node({
        name: 'Page',
        children: [
          node({ name: 'Styled', fills: [solid('#ff0000')], fillStyleId: 'S:abc' }),
          node({ name: 'Var', fills: [solid('#ff0000', { boundVariableId: 'VariableID:1' })] }),
        ],
      }),
    ];
    const issues = run(roots, { options: { acceptStylesAndVariables: false } }).issues;
    expect(issues.map((i) => i.nodeName)).toEqual(['Styled', 'Var']);
    // A snap would detach the paint style / variable binding, so neither gets a fix.
    expect(issues.map((i) => i.fix!.kind)).toEqual(['UNSUPPORTED', 'UNSUPPORTED']);
  });

  it('skips colors silently when the registry has no color tokens', () => {
    const reg = registryWith({ spacing: [{ name: 'x', value: 8 }] });
    expect(run([node({ name: 'Box', fills: [solid('#ff0000')] })], { registry: reg }).issues).toEqual([]);
  });

  it('checkColors=false disables color checks', () => {
    expect(run([node({ name: 'Box', fills: [solid('#ff0000')] })], { options: { checkColors: false } }).issues).toEqual([]);
  });
});

describe('divi/approved-tokens — typography', () => {
  it('accepts text matching a typography token and approved family', () => {
    const out = run([textNode({ name: 'Body' }), textNode({ name: 'Title', text: { fontFamily: 'inter', fontStyle: 'Bold', fontSize: 48, fontWeight: 700, lineHeightPx: null, textCase: null, characters: 'x' } })]);
    expect(out.issues).toEqual([]);
  });

  it('flags unapproved font family and off-token size with nearest suggestion', () => {
    const out = run([
      textNode({
        name: 'Odd',
        text: { fontFamily: 'Comic Sans MS', fontStyle: 'Regular', fontSize: 18, fontWeight: 400, lineHeightPx: null, textCase: null, characters: 'x' },
      }),
    ]);
    expect(out.issues.map((i) => i.code)).toEqual(['unapproved-font-family', 'unapproved-text-style']);
    expect(out.issues[0].expected).toBe('Inter');
    expect(out.issues[1].expected).toBe('body (16px / 400)');
    expect(out.issues[1].actual).toBe('18px / 400');
    expect(out.issues.every((i) => i.fix!.kind === 'UNSUPPORTED')).toBe(true);
  });

  it('flags weight mismatch on a size that exists', () => {
    const out = run([
      textNode({ name: 'Bold body', text: { fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 16, fontWeight: 700, lineHeightPx: null, textCase: null, characters: 'x' } }),
    ]);
    expect(out.issues.map((i) => i.code)).toEqual(['unapproved-text-style']);
  });

  it('skips text with a text style, mixed values, and when no typography tokens exist', () => {
    const mixed = textNode({ name: 'Mixed', text: { fontFamily: null, fontStyle: null, fontSize: null, fontWeight: null, lineHeightPx: null, textCase: null, characters: 'x' } });
    const styled = textNode({ name: 'Styled', textStyleId: 'S:t', text: { fontFamily: 'Papyrus', fontStyle: 'Regular', fontSize: 99, fontWeight: 400, lineHeightPx: null, textCase: null, characters: 'x' } });
    expect(run([mixed, styled]).issues).toEqual([]);
    const noTypo = registryWith({ colors: [{ name: 'ink', value: '#111111' }] });
    const odd = textNode({ name: 'Odd', text: { fontFamily: 'Papyrus', fontStyle: 'Regular', fontSize: 99, fontWeight: 400, lineHeightPx: null, textCase: null, characters: 'x' } });
    expect(run([odd], { registry: noTypo }).issues).toEqual([]);
  });

  it('honors family-specific typography tokens', () => {
    const reg = registryWith({ typography: [{ name: 'serif-body', fontFamily: 'Lora', fontSize: 16 }] });
    const out = run([textNode({ name: 'Body' })], { registry: reg });
    expect(out.issues.map((i) => i.code)).toEqual(['unapproved-text-style']);
    expect(out.issues[0].expected).toBe('serif-body (Lora / 16px)');
  });
});

describe('divi/approved-tokens — integration', () => {
  it('ordinary well-tokened layout produces no issues and counts passed checks', () => {
    const roots = [
      node({
        name: 'Hero',
        layoutMode: 'VERTICAL',
        padding: { top: 80, right: 48, bottom: 80, left: 48 },
        itemSpacing: 24,
        fills: [solid('#ffffff')],
        children: [
          textNode({ name: 'Headline', text: { fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 48, fontWeight: 700, lineHeightPx: null, textCase: null, characters: 'Hi' } }),
          textNode({ name: 'Copy' }),
          node({ name: 'Rectangle 1', fills: [solid('#111111')] }),
        ],
      }),
    ];
    const out = run(roots);
    expect(out.issues).toEqual([]);
    const s = out.result.ruleSummaries.find((x) => x.ruleId === ID)!;
    expect(s.checks).toBe(4);
    expect(s.passedChecks).toBe(4);
    expect(byName(roots, 'Hero').id).toBeTruthy();
  });
});
