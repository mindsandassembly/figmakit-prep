/**
 * divi/valid-nesting — registered components must respect the registry's
 * allowedChildren / allowedParents constraints.
 *
 * Nothing here encodes Divi nesting knowledge: with an unconstrained registry this rule never reports.
 */

import type { Certainty, DesignNode, LintContext, LintRule, RegistryComponent, RuleReport } from '../types';
import { checksNestedInstance, nestedCertainty } from './nested';

export const RULE_ID = 'divi/valid-nesting';

const ROOT = '$root';

function validateOptions(options: Record<string, unknown>): string[] {
  if (options !== undefined && options !== null && typeof options !== 'object') return ['options must be an object'];
  const v = options ? options.checkNestedInstances : undefined;
  if (v !== undefined && typeof v !== 'boolean') return ['"checkNestedInstances" must be a boolean'];
  return [];
}

function nameOf(id: string, context: LintContext): string {
  if (id === ROOT) return 'the top level (no registered parent)';
  const c = context.registry.getById(id);
  return c ? c.name : id;
}

/** "A", "A or B", "A, B or C". */
function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
}

const DOCS = `
Checks registry nesting constraints between **registered** components (instances of approved components, confirmed
detached copies, and layers declared via standards metadata where the component allows it).

**Evidence used**
- The node's registry identity and its *nearest registered ancestor* (unregistered wrapper frames in between are
  ignored, so auto-layout wrappers never cause violations).
- \`allowedChildren\` on the ancestor's component and \`allowedParents\` on the node's component. \`"$root"\` in
  \`allowedParents\` means "no registered ancestor in the validated scope". When a partial selection is validated (scope root not directly on the page) and no
  registered ancestor is in scope, the \`"$root"\` placement is unknown and is not reported.
- Registered instances nested inside other instances (swaps / slots) are checked (\`checkNestedInstances\`, default true).
  Sub-instances that are part of the library component itself (same main component as in the master) are never
  checked; when the origin of a nested instance cannot be resolved, findings are \`requires-review\`.

**Codes**
- \`invalid-child\`: the parent component's \`allowedChildren\` does not list this component.
- \`invalid-parent\`: this component's \`allowedParents\` does not list the parent (or \`$root\`).
  Both are reported when both constraints are violated.

**Certainty**: confirmed when both identities come from component keys (instance / detached); likely when either
identity comes from standards metadata (a designer declaration).

**Limitations**
- Constraints come only from the registry; the bundled draft registry has none, so this rule is silent until
  nesting is confirmed and added.
- Layers inside component instances are not visible unless \`settings.checkInstanceInternals\` — content placed in
  instance slots of a Section/Row component is not checked by default.
- \`$root\` is relative to the validated scope: validating only a Row selection reports it as having no parent.
  Validate whole top-level frames or the page for parent checks.

**Autofix:** none (re-parenting is a structural change).
`.trim();

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Registered components must follow the registry nesting constraints.',
    docs: DOCS,
    category: 'structure',
    defaultSeverity: 'error',
    defaultOptions: { checkNestedInstances: true },
    fixable: false,
    validateOptions,
  },

  appliesTo(node: DesignNode, context: LintContext): boolean {
    // Nested INSTANCE nodes inside instances are swap points / slots, so they are checked too —
    // except sub-instances proven to be part of the library component itself.
    const internal = context.isInstanceInternal(node) && !(node.type === 'INSTANCE' && checksNestedInstance(node, context));
    return !internal && context.getRegistryMatch(node) !== null;
  },

  validate(node: DesignNode, context: LintContext): RuleReport[] {
    const match = context.getRegistryMatch(node);
    if (!match) return [];
    const comp = match.component;

    const parentNode = context.getNearestRegisteredAncestor(node);
    const parentMatch = parentNode ? context.getRegistryMatch(parentNode) : null;
    const parentComp: RegistryComponent | null = parentMatch ? parentMatch.component : null;
    const parentId = parentComp ? parentComp.id : ROOT;

    const metadataInvolved = match.source === 'metadata' || (parentMatch !== null && parentMatch.source === 'metadata');
    const certainty: Certainty = nestedCertainty(node, context, metadataInvolved ? 'likely' : 'confirmed');
    const reports: RuleReport[] = [];

    if (parentComp && Array.isArray(parentComp.allowedChildren) && parentComp.allowedChildren.indexOf(comp.id) === -1) {
      const allowed = parentComp.allowedChildren.map((id) => nameOf(id, context));
      reports.push({
        code: 'invalid-child',
        certainty,
        message: `${comp.name} is not allowed inside ${parentComp.name}.`,
        suggestion: allowed.length
          ? `${parentComp.name} may only contain ${joinOr(allowed)}.`
          : `${parentComp.name} may not contain registered components.`,
        expected: allowed.length ? allowed.join(', ') : '(none)',
        actual: comp.name,
        data: {
          componentId: comp.id,
          parentComponentId: parentComp.id,
          parentNodeId: parentNode ? parentNode.id : null,
          allowedChildren: parentComp.allowedChildren.slice(),
        },
      });
    }

    // With no registered ancestor inside a partial selection we cannot see what is above the
    // scope root, so the "$root" placement cannot be judged.
    const scopeRoot = context.getAncestors(node).pop() || node;
    const placementUnknown = !parentComp && scopeRoot.scopeRootIsTopLevel === false;

    if (!placementUnknown && Array.isArray(comp.allowedParents) && comp.allowedParents.indexOf(parentId) === -1) {
      const allowed = comp.allowedParents.map((id) => nameOf(id, context));
      const where = parentComp ? `inside ${parentComp.name}` : 'without a registered parent in the validated scope';
      reports.push({
        code: 'invalid-parent',
        certainty,
        message: `${comp.name} cannot be placed ${where}.`,
        suggestion: allowed.length
          ? `Place ${comp.name} inside ${joinOr(allowed)}.` +
            (parentComp ? '' : ' If you validated a partial selection, validate the whole top-level frame.')
          : `${comp.name} has no allowed parents in the registry.`,
        expected: allowed.length ? allowed.join(', ') : '(none)',
        actual: parentComp ? parentComp.name : ROOT,
        data: {
          componentId: comp.id,
          parentComponentId: parentId,
          parentNodeId: parentNode ? parentNode.id : null,
          allowedParents: comp.allowedParents.slice(),
        },
      });
    }

    return reports;
  },
};
