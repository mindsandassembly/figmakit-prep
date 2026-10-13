/**
 * LintContext implementation: read-only tree / registry queries handed to rules.
 * Built once per run; the engine switches the active rule via setRule().
 */

import type {
  Certainty,
  DesignNode,
  LintContext,
  LintSettings,
  RegistryIndex,
  RegistryMatch,
  ResolvedConfig,
  Severity,
  TokenSet,
} from './types';
import { SEVERITY_RANK } from './types';

const DEFAULT_CERTAINTY_MAP: Record<Certainty, Severity | 'inherit'> = {
  confirmed: 'inherit',
  likely: 'warning',
  'requires-review': 'info',
};

function toSeverity(v: unknown): Severity | 'inherit' | null {
  if (v === 'inherit') return 'inherit';
  if (v === 'error' || v === 2) return 'error';
  if (v === 'warning' || v === 'warn' || v === 1) return 'warning';
  if (v === 'info') return 'info';
  return null;
}

/**
 * Effective severity for an issue of the given certainty.
 * Default map: confirmed → inherit, likely → warning, requires-review → info.
 * The result is clamped so it is never MORE severe than `configured`.
 * Invalid map entries fall back to the default mapping.
 */
export function severityForCertainty(
  configured: Severity,
  certainty: Certainty,
  map?: Partial<Record<Certainty, Severity | 'inherit'>>,
): Severity {
  let mapped: Severity | 'inherit' | null = null;
  if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, certainty)) {
    mapped = toSeverity((map as Record<string, unknown>)[certainty]);
  }
  if (mapped === null) mapped = DEFAULT_CERTAINTY_MAP[certainty] ?? 'inherit';
  if (mapped === 'inherit') return configured;
  return SEVERITY_RANK[mapped] < SEVERITY_RANK[configured] ? mapped : configured;
}

/** LintContext plus the engine-only hook for switching the active rule. */
export interface LintContextImpl extends LintContext {
  setRule(ruleId: string, severity: Severity, options: Record<string, unknown>): void;
}

class Context implements LintContextImpl {
  readonly registry: RegistryIndex;
  readonly config: ResolvedConfig;
  readonly settings: LintSettings;
  readonly roots: DesignNode[];
  readonly tokens: TokenSet;

  private _options: Record<string, unknown> = {};
  private _severity: Severity = 'error';
  private _ruleId = '';

  private readonly nodes = new Map<string, DesignNode>();
  private readonly parents = new Map<string, DesignNode | null>();
  private readonly matchCache = new Map<string, RegistryMatch | null>();

  constructor(roots: DesignNode[], registry: RegistryIndex, config: ResolvedConfig) {
    this.roots = roots;
    this.registry = registry;
    this.config = config;
    this.settings = config.settings;
    this.tokens = (registry.registry && registry.registry.tokens) || {};

    const stack: Array<[DesignNode, DesignNode | null]> = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push([roots[i], null]);
    while (stack.length) {
      const [n, p] = stack.pop()!;
      if (this.nodes.has(n.id)) continue; // first occurrence wins; also guards cycles
      this.nodes.set(n.id, n);
      this.parents.set(n.id, p);
      const kids = n.children || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], n]);
    }
  }

  get options(): Record<string, unknown> {
    return this._options;
  }
  get severity(): Severity {
    return this._severity;
  }
  get ruleId(): string {
    return this._ruleId;
  }

  setRule(ruleId: string, severity: Severity, options: Record<string, unknown>): void {
    this._ruleId = ruleId;
    this._severity = severity;
    this._options = options || {};
  }

  getNode(id: string): DesignNode | null {
    return this.nodes.get(id) ?? null;
  }

  getParent(node: DesignNode): DesignNode | null {
    return this.parents.get(node.id) ?? null;
  }

  getAncestors(node: DesignNode): DesignNode[] {
    const out: DesignNode[] = [];
    const seen = new Set<string>([node.id]);
    let p = this.getParent(node);
    while (p && !seen.has(p.id)) {
      out.push(p);
      seen.add(p.id);
      p = this.getParent(p);
    }
    return out;
  }

  formatPath(node: DesignNode): string {
    return node.path && node.path.length ? node.path.join(' / ') : node.name;
  }

  getRegistryMatch(node: DesignNode): RegistryMatch | null {
    if (this.matchCache.has(node.id)) return this.matchCache.get(node.id)!;
    const m = this.computeMatch(node);
    this.matchCache.set(node.id, m);
    return m;
  }

  private computeMatch(node: DesignNode): RegistryMatch | null {
    const reg = this.registry;
    // 1. Instance of a registered component (variant key, then component-set key).
    if (node.type === 'INSTANCE' && node.instance && node.instance.mainComponent) {
      const mc = node.instance.mainComponent;
      for (const key of [mc.key, mc.componentSetKey]) {
        if (!key) continue;
        const c = reg.getByKey(key);
        if (c) return { component: c, source: 'instance', matchedKey: key };
      }
    }
    // 2. Confirmed detach of a registered component.
    const d = node.detachedInfo;
    if (d) {
      const keys = d.type === 'library' ? [d.componentKey, d.resolvedComponentSetKey] : [d.resolvedKey, d.resolvedComponentSetKey];
      for (const key of keys) {
        if (!key) continue;
        const c = reg.getByKey(key);
        if (c) return { component: c, source: 'detached', matchedKey: key };
      }
    }
    // 3. Declared metadata (only honored when the component opts in).
    const declared = node.standardsMeta && node.standardsMeta.componentId;
    if (declared) {
      const c = reg.getById(declared);
      if (c && c.allowMetadataMapping === true) return { component: c, source: 'metadata', matchedKey: null };
    }
    return null;
  }

  getNearestRegisteredAncestor(node: DesignNode): DesignNode | null {
    for (const a of this.getAncestors(node)) {
      if (this.getRegistryMatch(a)) return a;
    }
    return null;
  }

  getNearestRegisteredDescendants(node: DesignNode): DesignNode[] {
    const out: DesignNode[] = [];
    const visit = (n: DesignNode): void => {
      for (const child of n.children || []) {
        if (this.isInstanceInternal(child)) continue;
        if (this.getRegistryMatch(child)) {
          out.push(child);
          continue;
        }
        visit(child);
      }
    };
    visit(node);
    return out;
  }

  isInGovernedContext(node: DesignNode): boolean {
    const a = this.getNearestRegisteredAncestor(node);
    if (a) {
      const m = this.getRegistryMatch(a);
      return !!m && m.component.governsChildren === true;
    }
    return this.settings.governTopLevel === true;
  }

  isInstanceInternal(node: DesignNode): boolean {
    return node.insideInstance === true && !this.settings.checkInstanceInternals;
  }
}

/** Build a context for one lint run. Node / parent maps are built once; registry matches are memoized. */
export function createLintContext(args: { roots: DesignNode[]; registry: RegistryIndex; config: ResolvedConfig }): LintContextImpl {
  return new Context(args.roots, args.registry, args.config);
}
