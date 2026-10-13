/**
 * divi/approved-component — component instances must come from the approved registry.
 *
 * Pure rule: reads only the DesignNode snapshot and the LintContext.
 */

import type { DesignNode, LintContext, LintRule, RegistryComponent, RuleReport } from '../types';
import { checksNestedInstance, nestedCertainty } from './nested';

import { componentRef } from './where';
export const RULE_ID = 'divi/approved-component';

type Scope = 'governed' | 'everywhere';

interface Options {
  scope: Scope;
  allowedComponentKeys: string[];
  ignoreComponentNamePatterns: string[];
}

const DEFAULT_OPTIONS: Options = {
  scope: 'governed',
  allowedComponentKeys: [],
  ignoreComponentNamePatterns: [],
};

function readOptions(raw: Record<string, unknown>): Options {
  const o = raw || {};
  return {
    scope: o.scope === 'everywhere' ? 'everywhere' : 'governed',
    allowedComponentKeys: Array.isArray(o.allowedComponentKeys)
      ? (o.allowedComponentKeys as unknown[]).filter((k): k is string => typeof k === 'string')
      : [],
    ignoreComponentNamePatterns: Array.isArray(o.ignoreComponentNamePatterns)
      ? (o.ignoreComponentNamePatterns as unknown[]).filter((k): k is string => typeof k === 'string')
      : [],
  };
}

function compile(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch (_e) {
      // invalid patterns are rejected by validateOptions; ignore defensively here
    }
  }
  return out;
}

function validateOptions(options: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const o = options || {};
  if (o.scope !== undefined && o.scope !== 'governed' && o.scope !== 'everywhere') {
    errs.push('"scope" must be "governed" or "everywhere"');
  }
  for (const key of ['allowedComponentKeys', 'ignoreComponentNamePatterns']) {
    const v = o[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      errs.push(`"${key}" must be an array of strings`);
    }
  }
  if (Array.isArray(o.ignoreComponentNamePatterns)) {
    for (const p of o.ignoreComponentNamePatterns as unknown[]) {
      if (typeof p !== 'string') continue;
      try {
        new RegExp(p, 'i');
      } catch (_e) {
        errs.push(`"ignoreComponentNamePatterns" entry ${JSON.stringify(p)} is not a valid regular expression`);
      }
    }
  }
  if (o.checkNestedInstances !== undefined && typeof o.checkNestedInstances !== 'boolean') {
    errs.push('"checkNestedInstances" must be a boolean');
  }
  return errs;
}

/** First registry candidate that could replace an unapproved instance (suggestion only — never approval). */
function suggestReplacement(node: DesignNode, context: LintContext): RegistryComponent | null {
  const mc = node.instance && node.instance.mainComponent;
  const names: string[] = [];
  if (mc) {
    if (mc.componentSetName) names.push(mc.componentSetName);
    if (mc.name) names.push(mc.name);
  }
  for (const n of names) {
    const c = context.registry.candidatesForName(n);
    if (c.length) return c[0];
  }
  const role = node.structural ? node.structural.role : node.analysis ? node.analysis.role : null;
  if (role) {
    const c = context.registry.candidatesForRole(role);
    if (c.length) return c[0];
  }
  return null;
}

const DOCS = `
Checks that every component **instance** in a governed context is an instance of a component listed in the
approved registry (\`figmaComponentKeys\` contains its main-component key or its component-set key).

**Evidence used**
- The instance's resolved main component key and component-set key (confirmed Figma data).
- Governance: an instance is checked when its nearest registered ancestor has \`governsChildren: true\`, or when it
  has no registered ancestor and \`settings.governTopLevel\` is on — or everywhere with \`scope: "everywhere"\`.
- Suggestions come from registry \`match\` hints (component name, then structural role). Hints never grant approval.

**Codes**
- \`unapproved-instance\` (confirmed): instance of a component not in the registry.
- \`deprecated-component\` (confirmed): instance of a registry component marked \`deprecated\`.
- \`unresolved-main-component\` (requires-review): the main component could not be resolved (deleted component or
  missing library), so approval cannot be proven.

**Options**
- \`scope\`: \`"governed"\` (default) or \`"everywhere"\`.
- \`allowedComponentKeys\`: extra component / component-set keys accepted without a registry entry (e.g. icon libraries).
- \`ignoreComponentNamePatterns\`: regexes (case-insensitive) tested against the main component and component-set name.

**Limitations**
- Layers inside instances are owned by the library and are not checked unless \`settings.checkInstanceInternals\`.
  Content placed in instance slots is therefore invisible to this rule by default.
- Standards metadata cannot approve an instance; only its component key can.

- Instances nested inside other instances (instance swaps / slots) are checked too unless
  \`checkNestedInstances: false\`; ordinary layers inside instances are never checked.
  Sub-instances that are part of the library component itself (same main component as in the master) are never
  checked; when the origin of a nested instance cannot be resolved, findings are \`requires-review\`.

**Autofix:** none (swapping components changes the design; a designer must do it).
`.trim();

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Component instances must come from the approved component registry.',
    docs: DOCS,
    category: 'components',
    defaultSeverity: 'error',
    defaultOptions: {
      scope: DEFAULT_OPTIONS.scope,
      allowedComponentKeys: [],
      ignoreComponentNamePatterns: [],
      checkNestedInstances: true,
    },
    fixable: false,
    validateOptions,
  },

  appliesTo(node: DesignNode, context: LintContext): boolean {
    if (node.type !== 'INSTANCE') return false;
    // Nested instances inside other instances are swap points / slots: checked by default, except
    // sub-instances proven to be part of the library component itself.
    return !context.isInstanceInternal(node) || checksNestedInstance(node, context);
  },

  validate(node: DesignNode, context: LintContext): RuleReport[] {
    const opts = readOptions(context.options);
    const match = context.getRegistryMatch(node);

    // Only the component key can approve an instance (not metadata).
    if (match && match.source === 'instance') {
      const comp = match.component;
      if (!comp.deprecated) return [];
      const replacement = comp.deprecated.replacedBy ? context.registry.getById(comp.deprecated.replacedBy) : null;
      const extra = comp.deprecated.message ? ' ' + comp.deprecated.message : '';
      return [
        {
          code: 'deprecated-component',
          certainty: 'confirmed',
          message: `${comp.name} is deprecated.${extra}`,
          suggestion: replacement
            ? `Use approved ${componentRef(replacement)} component.`
            : 'Replace with a supported component from the registry.',
          actual: comp.name,
          expected: replacement ? replacement.name : undefined,
          data: { componentId: comp.id, replacedBy: comp.deprecated.replacedBy ?? null },
        },
      ];
    }

    const mc = node.instance ? node.instance.mainComponent : null;
    if (!mc) {
      return [
        {
          code: 'unresolved-main-component',
          certainty: 'requires-review',
          message: 'Main component unavailable (missing library or deleted); approval cannot be verified.',
          suggestion: 'Re-link the library or replace with an approved component.',
        },
      ];
    }

    if (opts.scope !== 'everywhere' && !context.isInGovernedContext(node)) return [];

    if (
      opts.allowedComponentKeys.indexOf(mc.key) !== -1 ||
      (mc.componentSetKey && opts.allowedComponentKeys.indexOf(mc.componentSetKey) !== -1)
    ) {
      return [];
    }
    const ignore = compile(opts.ignoreComponentNamePatterns);
    const names = [mc.name, mc.componentSetName].filter((n): n is string => typeof n === 'string' && n !== '');
    for (const re of ignore) {
      for (const n of names) {
        re.lastIndex = 0;
        if (re.test(n)) return [];
      }
    }

    const displayName = mc.componentSetName || mc.name || node.name;
    const replacement = suggestReplacement(node, context);
    return [
      {
        code: 'unapproved-instance',
        // Unproven nested origin: it may be baked into the library component (not designer-fixable).
        certainty: nestedCertainty(node, context, 'confirmed'),
        message: `"${displayName}" is not an approved component.`,
        suggestion: replacement
          ? `Use approved ${componentRef(replacement)} component.`
          : 'Use an approved component from the registry, or add this component to the registry.',
        actual: displayName,
        data: {
          componentKey: mc.key,
          componentSetKey: mc.componentSetKey,
          componentName: mc.name,
          remote: mc.remote,
          suggestedComponentId: replacement ? replacement.id : null,
        },
      },
    ];
  },
};
