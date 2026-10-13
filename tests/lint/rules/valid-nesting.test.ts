import { describe, it, expect } from 'vitest';
import { rule } from '../../../src/lint/rules/valid-nesting';
import { node, instanceOf, lint, testRegistry, type NodeInput } from '../helpers';
import type { ComponentRegistry, DesignNode, LintConfig } from '../../../src/lint/types';
import bundled from '../../../src/standards/registry.example.json';

const RULES = [rule];

/** Confirmed detached copy of a registered container, so its children are visible to the linter. */
function reg(key: string, name: string, children: DesignNode[] = [], extra: Partial<NodeInput> = {}): DesignNode {
  return node({ name, detachedInfo: { type: 'library', componentKey: key }, children, ...extra });
}

function run(roots: DesignNode[], opts: { config?: LintConfig; registry?: unknown } = {}) {
  return lint(roots, { rules: RULES, ...opts }).result.issues;
}

describe('divi/valid-nesting', () => {
  it('passes a valid Section > Row > Column > Button tree, ignoring unregistered wrappers', () => {
    const roots = [
      reg('key-section', 'Section', [
        node({
          name: 'Wrapper',
          layoutMode: 'VERTICAL',
          children: [
            reg('key-row', 'Row', [
              reg('key-column', 'Column', [
                node({ name: 'Frame 3', children: [instanceOf('key-button', { name: 'Button' })] }),
                instanceOf('key-text', { name: 'Text' }),
              ]),
            ]),
          ],
        }),
      ]),
    ];
    const out = lint(roots, { rules: RULES });
    expect(out.result.issues).toEqual([]);
    // Section, Row, Column, Button, Text are registered; wrappers are not checked.
    expect(out.result.ruleSummaries[0].checks).toBe(5);
  });

  it('reports invalid-child when the parent does not allow the child', () => {
    const issues = run([reg('key-section', 'Section', [instanceOf('key-button', { name: 'Button' })])]);
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i.code).toBe('invalid-child');
    expect(i.message).toBe('Divi Button is not allowed inside Divi Section.');
    expect(i.expected).toBe('Divi Row');
    expect(i.actual).toBe('Divi Button');
    expect(i.certainty).toBe('confirmed');
    expect(i.severity).toBe('error');
    expect(i.nodeName).toBe('Button');
  });

  it('reports both invalid-child and invalid-parent when both constraints fail', () => {
    const issues = run([
      reg('key-section', 'Section', [reg('key-row', 'Row', [reg('key-column', 'Column', [reg('key-row', 'Inner Row')])])]),
    ]);
    expect(issues.map((i) => i.code).sort()).toEqual(['invalid-child', 'invalid-parent']);
    const parent = issues.find((i) => i.code === 'invalid-parent')!;
    expect(parent.message).toBe('Divi Row cannot be placed inside Divi Column.');
    expect(parent.expected).toBe('Divi Section');
    expect(issues[0].id).not.toBe(issues[1].id);
  });

  it('uses $root for nodes without a registered ancestor', () => {
    const rowAtTop = run([node({ name: 'Page', children: [reg('key-row', 'Row')] })]);
    expect(rowAtTop).toHaveLength(1);
    expect(rowAtTop[0].code).toBe('invalid-parent');
    expect(rowAtTop[0].actual).toBe('$root');
    expect(rowAtTop[0].message).toContain('without a registered parent');
    expect(rowAtTop[0].suggestion).toContain('Place Divi Row inside Divi Section');

    // Section allows $root.
    expect(run([node({ name: 'Page', children: [reg('key-section', 'Section')] })])).toEqual([]);
  });

  it('reports a Section nested in a Row (child and parent violations)', () => {
    const issues = run([reg('key-section', 'S', [reg('key-row', 'R', [reg('key-section', 'Nested Section')])])]);
    const nested = issues.filter((i) => i.nodeName === 'Nested Section').map((i) => i.code).sort();
    expect(nested).toEqual(['invalid-child', 'invalid-parent']);
    const p = issues.find((i) => i.code === 'invalid-parent')!;
    expect(p.expected).toBe('the top level (no registered parent)');
  });

  it('is "likely" (warning) when either identity comes from metadata', () => {
    const issues = run([
      reg('key-section', 'Section', [node({ name: 'Feature', standardsMeta: { componentId: 'divi-blurb' } })]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('invalid-child');
    expect(issues[0].certainty).toBe('likely');
    expect(issues[0].severity).toBe('warning');
  });

  it('ignores metadata for components that do not allow metadata mapping', () => {
    const issues = run([reg('key-section', 'Section', [node({ name: 'Btn', standardsMeta: { componentId: 'divi-button' } })])]);
    expect(issues).toEqual([]);
  });

  it('works with instances via component-set keys', () => {
    const issues = run([reg('key-section', 'Section', [instanceOf('v-1', { name: 'B' }, { setKey: 'set-button' })])]);
    expect(issues.map((i) => i.code)).toEqual(['invalid-child']);
  });

  it('checks registered instances nested inside instances (swaps / slots)', () => {
    const roots = () => [
      instanceOf('key-section', { name: 'Section', children: [instanceOf('key-button', { name: 'Button' })] }),
    ];
    const out = lint(roots(), { rules: RULES });
    expect(out.result.issues.map((i) => i.code)).toEqual(['invalid-child']);
    expect(out.result.ruleSummaries[0].checks).toBe(2);
    const deep = run(roots(), { config: { extends: ['figmakit:recommended'], settings: { checkInstanceInternals: true } } });
    expect(deep.map((i) => i.code)).toEqual(['invalid-child']);
  });

  it('never reports when the registry has no nesting constraints', () => {
    const r: ComponentRegistry = testRegistry();
    for (const c of r.components) {
      delete c.allowedChildren;
      delete c.allowedParents;
    }
    const roots = [reg('key-button', 'B', [reg('key-section', 'S', [reg('key-row', 'R')])])];
    expect(run(roots, { registry: r })).toEqual([]);
  });

  it('is silent with the bundled draft registry (placeholder keys, no constraints)', () => {
    const roots = [node({ name: 'Page', children: [instanceOf('anything', { name: 'Row' }), node({ name: 'Section' })] })];
    expect(run(roots, { registry: bundled })).toEqual([]);
  });

  it('empty allowedChildren means no registered children allowed', () => {
    const r = testRegistry();
    r.components.find((c) => c.id === 'divi-text')!.allowedChildren = [];
    const issues = run([reg('key-text', 'T', [instanceOf('key-image', { name: 'Img' })])], { registry: r });
    expect(issues).toHaveLength(1);
    expect(issues[0].expected).toBe('(none)');
    expect(issues[0].suggestion).toBe('Divi Text may not contain registered components.');
  });

  it('does not apply to unregistered layers', () => {
    const out = lint([node({ name: 'Section' }), node({ name: 'Frame 1', children: [node({ name: 'Row' })] })], { rules: RULES });
    expect(out.result.ruleSummaries[0].checks).toBe(0);
  });

  it('validates options (none accepted beyond an object)', () => {
    expect(rule.meta.validateOptions!({})).toEqual([]);
  });
});
