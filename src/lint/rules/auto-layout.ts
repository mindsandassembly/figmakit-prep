/**
 * divi/auto-layout — registered components that require Auto Layout must use it (and the right direction).
 */

import type { DesignNode, LintContext, LintRule, RegistryComponent, RuleReport } from '../types';

const RULE_ID = 'divi/auto-layout';

interface Requirement {
  component: RegistryComponent;
  direction: 'HORIZONTAL' | 'VERTICAL' | null;
}

function requireForList(context: LintContext): string[] {
  const v = context.options.requireFor;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The auto-layout requirement for this node, or null when none applies. */
function requirementFor(node: DesignNode, context: LintContext): Requirement | null {
  const match = context.getRegistryMatch(node);
  if (!match) return null;
  const c = match.component;
  const req = c.requiresAutoLayout;
  let direction: 'HORIZONTAL' | 'VERTICAL' | null = null;
  if (req && typeof req === 'object') {
    if (req.direction === 'HORIZONTAL' || req.direction === 'VERTICAL') direction = req.direction;
  }
  if (req || requireForList(context).indexOf(c.id) !== -1) return { component: c, direction };
  return null;
}

function dirLabel(mode: string): string {
  if (mode === 'HORIZONTAL') return 'horizontal';
  if (mode === 'VERTICAL') return 'vertical';
  if (mode === 'GRID') return 'grid';
  return 'none';
}

function validateOptions(options: Record<string, unknown>): string[] {
  const v = options.requireFor;
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    return ['"requireFor" must be an array of registry component ids.'];
  }
  return [];
}

const DOCS = `Checks that layers identified as a registered component whose registry entry sets
\`requiresAutoLayout\` (or whose id is listed in the \`requireFor\` option) use Auto Layout.

**Evidence used**: the layer's registry identity (instance key, confirmed detach, or allowed metadata) and its
\`layoutMode\`. Never applies to arbitrary frames — only to registered components that opt in.

**Codes**
- \`missing-auto-layout\` — no Auto Layout (or GRID when a direction is required).
- \`wrong-direction\` — \`requiresAutoLayout.direction\` is set and the layer uses the other direction.

**Certainty**: \`confirmed\`.

**Options**: \`requireFor\` (string[], default []) — extra registry component ids that require Auto Layout.

**Limitations**: for instances, layout is defined by the library component; an issue there means the library
component itself needs fixing.

**Autofix**: none (\`UNSUPPORTED\`) — adding or changing Auto Layout restructures the layer and needs a designer.`;

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Registered components that require Auto Layout must use it.',
    docs: DOCS,
    category: 'layout',
    defaultSeverity: 'warning',
    defaultOptions: { requireFor: [] },
    fixable: false,
    validateOptions,
  },

  appliesTo(node, context) {
    if (context.isInstanceInternal(node)) return false;
    return requirementFor(node, context) !== null;
  },

  validate(node, context) {
    const req = requirementFor(node, context);
    if (!req) return [];
    const name = req.component.name;
    const mode = node.layoutMode || 'NONE';
    const unsupported = {
      kind: 'UNSUPPORTED' as const,
      description: 'Changing layout structure requires a designer.',
      operations: [],
    };
    const out: RuleReport[] = [];
    if (mode === 'NONE' || (mode === 'GRID' && req.direction !== null)) {
      const expected = req.direction ? `${dirLabel(req.direction)} Auto Layout` : 'Auto Layout';
      out.push({
        code: 'missing-auto-layout',
        message: `${name} requires ${expected}.`,
        suggestion: `Add ${expected} (Shift+A) to this ${name}.`,
        expected,
        actual: mode === 'NONE' ? 'no Auto Layout' : 'grid layout',
        fix: unsupported,
        data: { componentId: req.component.id, layoutMode: mode, direction: req.direction },
      });
    } else if (req.direction !== null && mode !== req.direction) {
      out.push({
        code: 'wrong-direction',
        message: `${name} must use ${dirLabel(req.direction)} Auto Layout (currently ${dirLabel(mode)}).`,
        suggestion: `Switch Auto Layout direction to ${dirLabel(req.direction)}.`,
        expected: dirLabel(req.direction),
        actual: dirLabel(mode),
        fix: unsupported,
        data: { componentId: req.component.id, layoutMode: mode, direction: req.direction },
      });
    }
    return out;
  },
};
