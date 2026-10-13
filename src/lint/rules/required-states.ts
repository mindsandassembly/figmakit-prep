/**
 * divi/required-states — instances of approved components must set their required properties / variant states.
 */

import type { DesignNode, LintContext, LintRule, RegistryComponent, RuleReport } from '../types';
import { checksNestedInstance, nestedCertainty } from './nested';

const RULE_ID = 'divi/required-states';

/** Registered component (instance identity only) with required properties, or null. */
function componentFor(node: DesignNode, context: LintContext): RegistryComponent | null {
  if (node.type !== 'INSTANCE' || !node.instance) return null;
  const m = context.getRegistryMatch(node);
  if (!m || m.source !== 'instance') return null;
  const req = m.component.requiredProperties;
  return Array.isArray(req) && req.length > 0 ? m.component : null;
}

/** Look up a property value: variant properties first, then component properties. undefined = missing. */
function readProperty(node: DesignNode, name: string): string | boolean | undefined {
  const inst = node.instance;
  if (!inst) return undefined;
  const vp = inst.variantProperties;
  if (vp && Object.prototype.hasOwnProperty.call(vp, name)) return vp[name];
  const cp = inst.componentProperties;
  if (cp && Object.prototype.hasOwnProperty.call(cp, name)) return cp[name];
  return undefined;
}

function validateOptions(options: Record<string, unknown>): string[] {
  const v = options ? options.checkNestedInstances : undefined;
  if (v !== undefined && typeof v !== 'boolean') return ['"checkNestedInstances" must be a boolean'];
  return [];
}

const DOCS = `Checks that every **instance** of an approved component sets the properties listed in the registry's
\`requiredProperties\`, with an allowed value.

**Evidence used**: the instance's \`variantProperties\` and \`componentProperties\` (Figma "#id" suffixes stripped)
compared with \`requiredProperties[].name\` / \`allowedValues\`. Only instances whose identity comes from the
instance's main component key are checked (detached copies and metadata-mapped frames have no properties).

**Codes**
- \`missing-property\` — the required property does not exist on the instance (e.g. an outdated variant).
- \`invalid-property-value\` — the value is not one of \`allowedValues\`. Boolean properties compare as
  \`"true"\` / \`"false"\`. An empty or absent \`allowedValues\` accepts any value.

\`optionalStates\` are documentation only and never enforced.

**Certainty**: \`confirmed\`.

**Options**: \`checkNestedInstances\` (default \`true\`) — also check approved instances nested inside other
instances (swaps / slots), since their variant values are set by the designer. Sub-instances proven to be part of
the library component itself (same main component as in the master) are skipped; when the origin cannot be
resolved, findings are \`requires-review\`.

**Autofix**: none (\`UNSUPPORTED\`) — changing a property changes visuals; the designer chooses the state.`;

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Approved component instances must set required properties to allowed values.',
    docs: DOCS,
    category: 'components',
    defaultSeverity: 'error',
    defaultOptions: { checkNestedInstances: true },
    fixable: false,
    validateOptions,
  },

  appliesTo(node, context) {
    if (context.isInstanceInternal(node) && (node.type !== 'INSTANCE' || !checksNestedInstance(node, context))) return false;
    return componentFor(node, context) !== null;
  },

  validate(node, context) {
    const component = componentFor(node, context);
    if (!component) return [];
    const out: RuleReport[] = [];
    // Unproven nested origin: values may come from the library component itself.
    const certainty = nestedCertainty(node, context, 'confirmed');
    for (const req of component.requiredProperties || []) {
      if (!req || typeof req.name !== 'string' || !req.name) continue;
      const allowed = Array.isArray(req.allowedValues) ? req.allowedValues : [];
      const value = readProperty(node, req.name);
      const expected = allowed.length ? allowed.join(', ') : undefined;
      if (value === undefined) {
        out.push({
          code: 'missing-property',
          certainty,
          message: `${component.name} is missing required property "${req.name}".`,
          suggestion: `Swap to a current ${component.name} variant that has "${req.name}".`,
          expected,
          discriminator: req.name,
          fix: { kind: 'UNSUPPORTED', description: 'Choose the variant manually in the properties panel.', operations: [] },
          data: { componentId: component.id, property: req.name },
        });
        continue;
      }
      const str = String(value);
      if (allowed.length && allowed.indexOf(str) === -1) {
        out.push({
          code: 'invalid-property-value',
          certainty,
          message: `${component.name} "${req.name}" is "${str}"; allowed: ${allowed.join(', ')}.`,
          suggestion: `Set "${req.name}" to ${allowed.join(' or ')}.`,
          expected,
          actual: str,
          discriminator: req.name,
          fix: { kind: 'UNSUPPORTED', description: 'Choose the value manually in the properties panel.', operations: [] },
          data: { componentId: component.id, property: req.name, value: str },
        });
      }
    }
    return out;
  },
};
