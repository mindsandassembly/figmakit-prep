/**
 * Shared handling of INSTANCE nodes nested inside other instances.
 *
 * A nested instance is either part of the library component's own structure (baked into the
 * main component — the designer cannot change it) or designer-placed (an instance swap /
 * variant change on a sub-instance, or slot content). The snapshot records the evidence in
 * `DesignNode.nestedInstanceOrigin`; rules must never report library-baked sub-instances and
 * must not claim `confirmed` when the origin could not be determined.
 */

import type { Certainty, DesignNode, LintContext } from '../types';

export type NestedStatus =
  /** Not an instance-internal INSTANCE node (ordinary top-level instance, or not an instance). */
  | 'not-nested'
  /** Proven to be the library component's own sub-instance (same main component as in the master). */
  | 'library'
  /** Placed / swapped by the designer (or no evidence that it comes from the master). */
  | 'designer'
  /** Inside an instance but the origin could not be resolved. */
  | 'unproven';

export function nestedInstanceStatus(node: DesignNode, _context?: LintContext): NestedStatus {
  if (node.type !== 'INSTANCE' || node.insideInstance !== true) return 'not-nested';
  switch (node.nestedInstanceOrigin) {
    case 'library':
      return 'library';
    case 'unknown':
      return 'unproven';
    default:
      return 'designer';
  }
}

/** Whether a rule with `checkNestedInstances` should look at an instance-internal INSTANCE node. */
export function checksNestedInstance(node: DesignNode, context: LintContext): boolean {
  if (context.options.checkNestedInstances === false) return false;
  return nestedInstanceStatus(node, context) !== 'library';
}

/** Certainty for a finding on `node`: downgraded to requires-review when the nested origin is unproven. */
export function nestedCertainty(node: DesignNode, context: LintContext, base: Certainty): Certainty {
  return nestedInstanceStatus(node, context) === 'unproven' ? 'requires-review' : base;
}
