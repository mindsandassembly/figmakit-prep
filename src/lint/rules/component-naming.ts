/**
 * divi/component-naming — semantic components must have meaningful, convention-following layer names.
 */

import type { DesignNode, FixDescriptor, LintContext, LintRule, RegistryComponent, RuleReport } from '../types';
import { AUTO_NAME_PATTERN } from '../../shared/constants';

const RULE_ID = 'divi/component-naming';
const FK_PREFIX = /^\[fk:[^\]]+\]\s*/i;
const MAX_NAME = 255;

function safeRegExp(source: unknown, flags?: string): RegExp | null {
  if (typeof source !== 'string' || source === '') return null;
  try {
    return new RegExp(source, flags);
  } catch (e) {
    return null;
  }
}

/** Current "[fk:role] " prefix of the layer name (empty string if none). */
function labelPrefix(node: DesignNode): string {
  const m = FK_PREFIX.exec(node.name);
  return m ? m[0] : '';
}

/** Patterns (component + global) a name must satisfy. */
function requiredPatterns(component: RegistryComponent | null, context: LintContext): Array<{ re: RegExp; source: string; scope: 'component' | 'global' }> {
  const out: Array<{ re: RegExp; source: string; scope: 'component' | 'global' }> = [];
  if (component && component.namingPattern) {
    const re = safeRegExp(component.namingPattern);
    if (re) out.push({ re, source: component.namingPattern, scope: 'component' });
  }
  const g = context.options.pattern;
  if (typeof g === 'string' && g) {
    const re = safeRegExp(g);
    if (re) out.push({ re, source: g, scope: 'global' });
  }
  return out;
}

/** True when the name is legitimately the component's own name (e.g. a Divi Section frame named "Section"). */
function isComponentName(baseName: string, component: RegistryComponent | null): boolean {
  if (!component) return false;
  if (baseName.trim().toLowerCase() === component.name.trim().toLowerCase()) return true;
  const hints = (component.match && component.match.namePatterns) || [];
  for (const p of hints) {
    const re = safeRegExp(p, 'i');
    if (re && re.test(baseName)) return true;
  }
  const own = safeRegExp(component.namingPattern);
  return !!(own && own.test(baseName));
}

/**
 * Rename fix to the component's canonical name (keeping any "[fk:role] " prefix).
 * Returns null if not possible (no component, empty name, unchanged, too long).
 */
function renameTo(node: DesignNode, component: RegistryComponent | null): { to: string } | null {
  if (!component || !component.name || !component.name.trim()) return null;
  const to = labelPrefix(node) + component.name;
  if (to === node.name || to.length > MAX_NAME) return null;
  return { to };
}

function renameFix(node: DesignNode, to: string, kind: 'SAFE' | 'REQUIRES_CONFIRMATION'): FixDescriptor {
  return {
    kind,
    description: `Rename "${node.name}" → "${to}"`,
    operations: [{ op: 'rename', nodeId: node.id, from: node.name, to }],
  };
}

function unsupported(description: string): FixDescriptor {
  return { kind: 'UNSUPPORTED', description, operations: [] };
}

function componentFor(node: DesignNode, context: LintContext): RegistryComponent | null {
  const m = context.getRegistryMatch(node);
  return m ? m.component : null;
}

function validateOptions(options: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const k of ['disallowAutoNames', 'includeUnmappedBoundaries']) {
    if (options[k] !== undefined && typeof options[k] !== 'boolean') errs.push(`"${k}" must be a boolean.`);
  }
  const p = options.pattern;
  if (p !== undefined && p !== null) {
    if (typeof p !== 'string') errs.push('"pattern" must be a regex string or null.');
    else if (!safeRegExp(p)) errs.push('"pattern" is not a valid regex.');
  }
  return errs;
}

const DOCS = `Checks layer names of **semantic components**: layers with a registry identity (instance of an approved
component, confirmed detach, or allowed metadata) and — when \`includeUnmappedBoundaries\` is on — layers with an
explicit FigmaKit label (\`[fk:role]\` / pluginData). Ordinary internal layers are never checked.

**Evidence used**: the layer's base name (\`[fk:role] \` prefix stripped), the registry component's \`name\`,
\`namingPattern\` and \`match.namePatterns\`.

**Codes**
- \`auto-generated-name\` — the name is a Figma default such as "Frame 12" or "Group 3". A name that matches the
  component itself (e.g. a Divi Section named "Section") is not treated as auto-generated.
- \`pattern-mismatch\` — the name does not match the component's \`namingPattern\` (discriminator \`component\`) or
  the global \`pattern\` option (discriminator \`global\`). Not reported when \`auto-generated-name\` already
  fired on the same layer (one rename resolves both).

**Certainty**: \`confirmed\`.

**Options**
- \`disallowAutoNames\` (true)
- \`pattern\` (null): regex string applied to every semantic component.
- \`includeUnmappedBoundaries\` (false): also check explicitly labelled layers with no registry identity.

**Autofix**
- \`auto-generated-name\`: \`SAFE\` rename to the component name (prefix kept) when that name satisfies every
  applicable pattern; otherwise \`UNSUPPORTED\`.
- \`pattern-mismatch\`: \`REQUIRES_CONFIRMATION\` rename to the component name when it satisfies the patterns,
  otherwise \`UNSUPPORTED\`.`;

export const rule: LintRule = {
  meta: {
    id: RULE_ID,
    description: 'Semantic components must have meaningful names that follow the naming convention.',
    docs: DOCS,
    category: 'naming',
    defaultSeverity: 'warning',
    defaultOptions: { disallowAutoNames: true, pattern: null, includeUnmappedBoundaries: false },
    fixable: true,
    validateOptions,
  },

  appliesTo(node, context) {
    if (context.isInstanceInternal(node)) return false;
    if (context.getRegistryMatch(node)) return true;
    return context.options.includeUnmappedBoundaries === true && !!node.fkLabel;
  },

  validate(node, context) {
    const component = componentFor(node, context);
    const baseName = node.baseName;
    const patterns = requiredPatterns(component, context);
    const rename = renameTo(node, component);
    const targetOk = !!rename && patterns.every((p) => p.re.test(component!.name));
    const out: RuleReport[] = [];

    const disallowAuto = context.options.disallowAutoNames !== false;
    if (disallowAuto && AUTO_NAME_PATTERN.test(baseName.trim()) && !isComponentName(baseName, component)) {
      out.push({
        code: 'auto-generated-name',
        message: `"${baseName}" is an auto-generated layer name.`,
        suggestion: component ? `Rename to "${component.name}".` : 'Give this layer a descriptive name.',
        expected: component ? component.name : 'a descriptive name',
        actual: baseName,
        fix:
          rename && targetOk
            ? renameFix(node, rename.to, 'SAFE')
            : unsupported('Choose a descriptive name manually.'),
        data: { componentId: component ? component.id : null },
      });
      return out;
    }

    for (const p of patterns) {
      if (p.re.test(baseName)) continue;
      const who = component ? component.name : 'This layer';
      out.push({
        code: 'pattern-mismatch',
        message:
          p.scope === 'component'
            ? `${who} name "${baseName}" doesn't match the required pattern /${p.source}/.`
            : `"${baseName}" doesn't match the naming convention /${p.source}/.`,
        suggestion: rename && targetOk ? `Rename to "${component!.name}".` : `Rename to match /${p.source}/.`,
        expected: `/${p.source}/`,
        actual: baseName,
        discriminator: p.scope,
        fix:
          rename && targetOk
            ? renameFix(node, rename.to, 'REQUIRES_CONFIRMATION')
            : unsupported(`Rename manually to match /${p.source}/.`),
        data: { componentId: component ? component.id : null, pattern: p.source, scope: p.scope },
      });
    }
    return out;
  },
};
