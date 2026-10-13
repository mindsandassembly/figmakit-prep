/**
 * divi/semantic-mapping — semantic boundaries (explicitly labelled or confidently
 * classified sections, rows, cards, ...) must map to an approved registry component.
 */

import type { DesignNode, FixDescriptor, LintContext, LintRule, NodeStandardsMeta, RegistryComponent, RuleReport } from '../types';
import { NODE_ROLES } from '../../shared/types';
import type { NodeRole } from '../../shared/types';
import { STANDARDS_PLUGIN_DATA_KEYS } from '../types';
import { detachedOptionsFromContext, getRecreationCandidates, isDetachedRuleTarget } from './detached-component';

export const RULE_ID = 'divi/semantic-mapping';

const DEFAULT_BOUNDARY_ROLES: NodeRole[] = [
  'section', 'row', 'column', 'hero', 'card', 'cta', 'feature', 'testimonial', 'accordion', 'tabs', 'gallery', 'modal',
];

interface Options {
  boundaryRoles: string[];
  minConfidence: number;
  stampApprovedInstances: boolean;
}

function readOptions(raw: Record<string, unknown>): Options {
  const o = raw || {};
  return {
    boundaryRoles: Array.isArray(o.boundaryRoles)
      ? (o.boundaryRoles as unknown[]).filter((r): r is string => typeof r === 'string')
      : DEFAULT_BOUNDARY_ROLES.slice(),
    minConfidence: typeof o.minConfidence === 'number' && isFinite(o.minConfidence) ? o.minConfidence : 80,
    stampApprovedInstances: o.stampApprovedInstances === true,
  };
}

function validateOptions(options: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const o = options || {};
  if (o.boundaryRoles !== undefined) {
    if (!Array.isArray(o.boundaryRoles) || o.boundaryRoles.some((r) => typeof r !== 'string')) {
      errs.push('"boundaryRoles" must be an array of role names');
    } else {
      for (const r of o.boundaryRoles as string[]) {
        if (NODE_ROLES.indexOf(r as NodeRole) === -1) errs.push(`"boundaryRoles" contains unknown role "${r}"`);
      }
    }
  }
  if (o.minConfidence !== undefined) {
    const v = o.minConfidence;
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100) errs.push('"minConfidence" must be a number from 0 to 100');
  }
  if (o.stampApprovedInstances !== undefined && typeof o.stampApprovedInstances !== 'boolean') {
    errs.push('"stampApprovedInstances" must be a boolean');
  }
  return errs;
}

const DEFINITION_TYPES = ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'];

/** 'label' for explicit boundaries, 'structure' for confident classifier boundaries, else null. */
function boundaryKind(node: DesignNode, opts: Options): 'label' | 'structure' | null {
  if (node.fkLabel && opts.boundaryRoles.indexOf(node.fkLabel) !== -1) return 'label';
  const a = node.analysis;
  if (a && opts.boundaryRoles.indexOf(a.role) !== -1 && a.confidence >= opts.minConfidence && a.source !== 'name') {
    return 'structure';
  }
  return null;
}

function isStampTarget(node: DesignNode, context: LintContext): boolean {
  if (node.type !== 'INSTANCE') return false;
  const m = context.getRegistryMatch(node);
  return !!m && m.source === 'instance';
}

/** "A", "A or B", "A, B or C". */
function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
}

function mappingFix(node: DesignNode, candidates: RegistryComponent[]): { fix?: FixDescriptor; suggestion: string } {
  if (candidates.length === 0) {
    return {
      suggestion:
        'No approved component maps to this role. Build it from approved components, add a component to the registry, or record an exception.',
    };
  }
  if (candidates.length > 1) {
    const names = joinOr(candidates.map((c) => c.name));
    return {
      suggestion: `Ambiguous: ${names}. Replace with the right approved component.`,
      fix: { kind: 'UNSUPPORTED', description: `Ambiguous: ${names}.`, operations: [] },
    };
  }
  const c = candidates[0];
  if (c.allowMetadataMapping === true) {
    const meta: NodeStandardsMeta = node.standardsMeta || { componentId: null };
    return {
      suggestion: `Declare this layer as ${c.name}, or replace it with an instance of ${c.name}.`,
      fix: {
        kind: 'REQUIRES_CONFIRMATION',
        description: `Declare as ${c.name} (set ${STANDARDS_PLUGIN_DATA_KEYS.component} = "${c.id}")`,
        operations: [
          {
            op: 'setPluginData',
            nodeId: node.id,
            key: STANDARDS_PLUGIN_DATA_KEYS.component,
            from: meta.componentId ?? '',
            to: c.id,
          },
        ],
      },
    };
  }
  return {
    suggestion: `Replace with an instance of ${c.name}.`,
    fix: { kind: 'UNSUPPORTED', description: `Replace with an instance of ${c.name}.`, operations: [] },
  };
}

const DOCS = `
Checks that **semantic boundaries** map to an approved registry component, so every meaningful block in the design
has a known Divi equivalent.

**What is a semantic boundary** (non-instance layers outside instances; component definitions are skipped)
- *Explicit*: a FigmaKit label (\`[fk:role]\` prefix or \`fk-type\` plugin data) whose role is in \`boundaryRoles\`.
- *Classified*: the analyzer's role is in \`boundaryRoles\` with confidence ≥ \`minConfidence\` and the
  classification did not come from the layer name alone.

**Passes when** the layer has a registry identity (instance, confirmed detach, or allowed metadata); when
\`divi/detached-component\` already reports it (detachedInfo or a recreation candidate — no double reports); or
when it contains registered components (a legitimate custom composition built from approved parts).

**Codes**
- \`unmapped-label\` (confirmed): explicitly labelled but not mapped.
- \`unmapped-structure\` (requires-review): heuristic classification only; a human must decide.
- \`missing-divi-metadata\` (info, only with \`stampApprovedInstances\`): an approved instance lacks the
  \`fk-divi-type\` plugin data matching its registry \`diviType\`.

**Fixes**
- Exactly one candidate (registry \`match.roles\`) that allows metadata mapping → *requires confirmation*: write
  \`fk-standards-component\`. One instance-only candidate → unsupported ("Replace with an instance of …").
  Several → unsupported ("Ambiguous: …").
- \`missing-divi-metadata\` → *safe*: write \`fk-divi-type\` (metadata only, no visual change).

**Options**: \`boundaryRoles\`, \`minConfidence\` (80), \`stampApprovedInstances\` (false).

**Limitations**: labels outside \`boundaryRoles\` (e.g. \`[fk:text]\`, \`[fk:button]\`) are not boundaries here —
recreated leaf components are \`divi/detached-component\`'s job. Classification quality depends on the FigmaKit
analyzer.
`.trim();

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Semantic blocks must map to an approved registry component.',
    docs: DOCS,
    category: 'structure',
    defaultSeverity: 'warning',
    defaultOptions: {
      boundaryRoles: DEFAULT_BOUNDARY_ROLES.slice(),
      minConfidence: 80,
      stampApprovedInstances: false,
    },
    fixable: true,
    validateOptions,
  },

  appliesTo(node: DesignNode, context: LintContext): boolean {
    if (context.isInstanceInternal(node)) return false;
    const opts = readOptions(context.options);
    if (node.type === 'INSTANCE') return opts.stampApprovedInstances && isStampTarget(node, context);
    if (DEFINITION_TYPES.indexOf(node.type) !== -1) return false;
    return boundaryKind(node, opts) !== null;
  },

  validate(node: DesignNode, context: LintContext): RuleReport[] {
    const opts = readOptions(context.options);

    if (node.type === 'INSTANCE') {
      const m = context.getRegistryMatch(node);
      if (!opts.stampApprovedInstances || !m || m.source !== 'instance') return [];
      const diviType = m.component.diviType;
      if (!diviType) return [];
      const current = (node.standardsMeta && node.standardsMeta.diviType) || '';
      if (current === diviType) return [];
      return [
        {
          code: 'missing-divi-metadata',
          certainty: 'confirmed',
          severity: 'info',
          message: `${m.component.name} instance is missing Divi metadata (${diviType}).`,
          suggestion: `Stamp ${STANDARDS_PLUGIN_DATA_KEYS.diviType} = "${diviType}".`,
          expected: diviType,
          actual: current || '(none)',
          fix: {
            kind: 'SAFE',
            description: `Set ${STANDARDS_PLUGIN_DATA_KEYS.diviType} = "${diviType}"`,
            operations: [
              { op: 'setPluginData', nodeId: node.id, key: STANDARDS_PLUGIN_DATA_KEYS.diviType, from: current, to: diviType },
            ],
          },
          data: { componentId: m.component.id, diviType },
        },
      ];
    }

    const kind = boundaryKind(node, opts);
    if (!kind) return [];
    if (context.getRegistryMatch(node)) return [];

    // Leave anything divi/detached-component reports to that rule.
    if (node.detachedInfo) return [];
    if (isDetachedRuleTarget(node, context)) {
      if (getRecreationCandidates(node, context, detachedOptionsFromContext(context)).length > 0) return [];
    }

    // A block built from approved components is a legitimate custom composition.
    if (context.getNearestRegisteredDescendants(node).length > 0) return [];

    if (kind === 'label') {
      const role = node.fkLabel as NodeRole;
      const candidates = context.registry.candidatesForRole(role);
      const f = mappingFix(node, candidates);
      const r: RuleReport = {
        code: 'unmapped-label',
        certainty: 'confirmed',
        message: `Labelled as [fk:${role}] but no approved component mapping.`,
        suggestion: f.suggestion,
        data: { role, candidates: candidates.map((c) => c.id) },
      };
      if (f.fix) r.fix = f.fix;
      return [r];
    }

    const role = node.analysis.role;
    const candidates = context.registry.candidatesForRole(role);
    const f = mappingFix(node, candidates);
    const r: RuleReport = {
      code: 'unmapped-structure',
      certainty: 'requires-review',
      message: `Looks like a ${role} (heuristic, ${node.analysis.confidence}% confidence) but is not mapped to an approved component.`,
      suggestion: f.suggestion,
      data: { role, confidence: node.analysis.confidence, source: node.analysis.source, candidates: candidates.map((c) => c.id) },
    };
    if (f.fix) r.fix = f.fix;
    return [r];
  },
};
