/**
 * Component registry: validation, normalization and indexed lookup.
 *
 * The registry is the ONLY source of truth for approved components, nesting
 * constraints and tokens. Nothing here invents Divi rules: an empty / unconstrained
 * registry simply yields no constraints.
 */

import type {
  ComponentRegistry,
  RegistryComponent,
  RegistryIndex,
  Diagnostic,
  DiagnosticLevel,
} from './types';
import { NODE_ROLES } from '../shared/types';
import type { NodeRole } from '../shared/types';
import { parseVersion } from './semver';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PLACEHOLDER_RE = /^(REPLACE|TODO|FIGMA_COMPONENT_KEY|PLACEHOLDER|XXX)/i;

const KNOWN_TOP_KEYS = ['$schema', 'version', 'designSystem', 'status', 'description', 'components', 'tokens'];
const KNOWN_COMPONENT_KEYS = [
  'id', 'name', 'diviType', 'figmaComponentKeys', 'allowedChildren', 'allowedParents', 'governsChildren',
  'requiredProperties', 'optionalStates', 'requiresAutoLayout', 'namingPattern', 'allowMetadataMapping',
  'match', 'deprecated', 'description',
];
const KNOWN_TOKEN_KEYS = ['colors', 'spacing', 'typography', 'fontFamilies'];

/** True when a Figma key is a placeholder that has not been populated yet. */
export function isPlaceholderKey(key: string): boolean {
  if (typeof key !== 'string') return true;
  const k = key.trim();
  if (k === '') return true;
  return PLACEHOLDER_RE.test(k) || k.toUpperCase().indexOf('REPLACE') !== -1;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function compiles(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Validate an untrusted registry document. Never throws.
 *
 * Diagnostic codes: invalid-registry, invalid-version, invalid-design-system, missing-status (warning),
 * invalid-status, invalid-components, invalid-component, invalid-id, duplicate-id, invalid-name,
 * invalid-divi-type, invalid-keys, no-keys (warning), unresolved-key (warning), duplicate-key,
 * unknown-reference, invalid-pattern, unknown-role (warning), invalid-required-properties,
 * invalid-field, invalid-token, unknown-key (info).
 */
export function validateRegistry(input: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (level: DiagnosticLevel, code: string, message: string, path?: string): void => {
    const d: Diagnostic = { level, code, message };
    if (path !== undefined) d.path = path;
    out.push(d);
  };

  if (!isObj(input)) {
    add('error', 'invalid-registry', 'Registry must be a JSON object.');
    return out;
  }
  const reg = input;

  for (const k of Object.keys(reg).sort()) {
    if (KNOWN_TOP_KEYS.indexOf(k) === -1) add('info', 'unknown-key', `Unknown registry property "${k}" is ignored.`, k);
  }

  if (typeof reg.version !== 'string' || !parseVersion(reg.version)) {
    add('error', 'invalid-version', 'Registry "version" must be a semantic version like "1.0.0".', 'version');
  }
  if (typeof reg.designSystem !== 'string' || reg.designSystem.trim() === '') {
    add('error', 'invalid-design-system', 'Registry "designSystem" must be a non-empty string.', 'designSystem');
  }
  if (reg.status === undefined) {
    add('warning', 'missing-status', 'Registry "status" is missing; treating it as "draft".', 'status');
  } else if (reg.status !== 'draft' && reg.status !== 'approved') {
    add('error', 'invalid-status', 'Registry "status" must be "draft" or "approved".', 'status');
  }
  if (reg.description !== undefined && typeof reg.description !== 'string') {
    add('error', 'invalid-field', 'Registry "description" must be a string.', 'description');
  }

  const components: unknown[] = Array.isArray(reg.components) ? reg.components : [];
  if (!Array.isArray(reg.components)) {
    add('error', 'invalid-components', 'Registry "components" must be an array.', 'components');
  }

  // Pass 1: collect ids.
  const ids = new Set<string>();
  const seenIds = new Set<string>();
  for (const c of components) {
    if (isObj(c) && typeof c.id === 'string') ids.add(c.id);
  }

  const keyOwner = new Map<string, string>();

  components.forEach((c, i) => {
    const p = `components[${i}]`;
    if (!isObj(c)) {
      add('error', 'invalid-component', 'Component entry must be an object.', p);
      return;
    }
    for (const k of Object.keys(c).sort()) {
      if (KNOWN_COMPONENT_KEYS.indexOf(k) === -1) add('info', 'unknown-key', `Unknown component property "${k}" is ignored.`, `${p}.${k}`);
    }
    const id = typeof c.id === 'string' ? c.id : '';
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) {
      add('error', 'invalid-id', `Component id ${JSON.stringify(c.id)} must match /^[a-z0-9][a-z0-9-]*$/.`, `${p}.id`);
    } else if (seenIds.has(c.id)) {
      add('error', 'duplicate-id', `Duplicate component id "${c.id}".`, `${p}.id`);
    }
    if (id) seenIds.add(id);
    const label = id || `#${i}`;

    if (typeof c.name !== 'string' || c.name.trim() === '') {
      add('error', 'invalid-name', `Component "${label}" must have a non-empty "name".`, `${p}.name`);
    }
    if (c.diviType !== undefined && c.diviType !== null && typeof c.diviType !== 'string') {
      add('error', 'invalid-divi-type', `Component "${label}" "diviType" must be a string or null.`, `${p}.diviType`);
    }

    // Keys
    if (!Array.isArray(c.figmaComponentKeys)) {
      add('error', 'invalid-keys', `Component "${label}" "figmaComponentKeys" must be an array of strings.`, `${p}.figmaComponentKeys`);
    } else {
      if (c.figmaComponentKeys.length === 0) {
        add('warning', 'no-keys', `Component "${label}" has no Figma component keys; no instance can match it.`, `${p}.figmaComponentKeys`);
      }
      c.figmaComponentKeys.forEach((k: unknown, j: number) => {
        const kp = `${p}.figmaComponentKeys[${j}]`;
        if (typeof k !== 'string') {
          add('error', 'invalid-keys', `Component "${label}" key must be a string.`, kp);
          return;
        }
        if (isPlaceholderKey(k)) {
          add('warning', 'unresolved-key', `Component "${label}" key "${k}" is a placeholder; replace it with the real Figma component key.`, kp);
          return;
        }
        const owner = keyOwner.get(k);
        if (owner !== undefined && owner !== label) {
          add('error', 'duplicate-key', `Figma key "${k}" is used by both "${owner}" and "${label}".`, kp);
        } else if (owner === undefined) {
          keyOwner.set(k, label);
        }
      });
    }

    // References
    const checkRefs = (field: 'allowedChildren' | 'allowedParents'): void => {
      const v = c[field];
      if (v === undefined) return;
      if (!isStringArray(v)) {
        add('error', 'invalid-field', `Component "${label}" "${field}" must be an array of component ids.`, `${p}.${field}`);
        return;
      }
      v.forEach((ref, j) => {
        if (field === 'allowedParents' && ref === '$root') return;
        if (!ids.has(ref)) {
          add('error', 'unknown-reference', `Component "${label}" ${field} references unknown component "${ref}".`, `${p}.${field}[${j}]`);
        }
      });
    };
    checkRefs('allowedChildren');
    checkRefs('allowedParents');

    for (const f of ['governsChildren', 'allowMetadataMapping'] as const) {
      if (c[f] !== undefined && typeof c[f] !== 'boolean') {
        add('error', 'invalid-field', `Component "${label}" "${f}" must be a boolean.`, `${p}.${f}`);
      }
    }
    if (c.description !== undefined && typeof c.description !== 'string') {
      add('error', 'invalid-field', `Component "${label}" "description" must be a string.`, `${p}.description`);
    }

    // requiresAutoLayout
    const ral = c.requiresAutoLayout;
    if (ral !== undefined && typeof ral !== 'boolean') {
      const ok = isObj(ral) && (ral.direction === undefined || ral.direction === 'HORIZONTAL' || ral.direction === 'VERTICAL');
      if (!ok) add('error', 'invalid-field', `Component "${label}" "requiresAutoLayout" must be a boolean or { direction?: "HORIZONTAL" | "VERTICAL" }.`, `${p}.requiresAutoLayout`);
    }

    // requiredProperties
    if (c.requiredProperties !== undefined) {
      const rp = c.requiredProperties;
      if (!Array.isArray(rp)) {
        add('error', 'invalid-required-properties', `Component "${label}" "requiredProperties" must be an array.`, `${p}.requiredProperties`);
      } else {
        rp.forEach((r: unknown, j: number) => {
          const ok =
            isObj(r) &&
            typeof r.name === 'string' &&
            r.name.trim() !== '' &&
            (r.allowedValues === undefined || isStringArray(r.allowedValues));
          if (!ok) {
            add('error', 'invalid-required-properties', `Component "${label}" requiredProperties entry must be { name: string, allowedValues?: string[] }.`, `${p}.requiredProperties[${j}]`);
          }
        });
      }
    }

    // optionalStates
    if (c.optionalStates !== undefined) {
      const os = c.optionalStates;
      const ok = isObj(os) && Object.keys(os).every((k) => isStringArray(os[k]));
      if (!ok) add('error', 'invalid-field', `Component "${label}" "optionalStates" must map names to string arrays.`, `${p}.optionalStates`);
    }

    // Patterns
    if (c.namingPattern !== undefined && !compiles(c.namingPattern)) {
      add('error', 'invalid-pattern', `Component "${label}" "namingPattern" is not a valid regular expression.`, `${p}.namingPattern`);
    }
    if (c.match !== undefined) {
      if (!isObj(c.match)) {
        add('error', 'invalid-field', `Component "${label}" "match" must be an object.`, `${p}.match`);
      } else {
        const m = c.match;
        if (m.namePatterns !== undefined) {
          if (!Array.isArray(m.namePatterns)) {
            add('error', 'invalid-field', `Component "${label}" "match.namePatterns" must be an array.`, `${p}.match.namePatterns`);
          } else {
            m.namePatterns.forEach((pat: unknown, j: number) => {
              if (!compiles(pat)) {
                add('error', 'invalid-pattern', `Component "${label}" match.namePatterns[${j}] is not a valid regular expression.`, `${p}.match.namePatterns[${j}]`);
              }
            });
          }
        }
        if (m.roles !== undefined) {
          if (!Array.isArray(m.roles)) {
            add('error', 'invalid-field', `Component "${label}" "match.roles" must be an array.`, `${p}.match.roles`);
          } else {
            m.roles.forEach((role: unknown, j: number) => {
              if (typeof role !== 'string' || (NODE_ROLES as string[]).indexOf(role) === -1) {
                add('warning', 'unknown-role', `Component "${label}" match.roles contains unknown role ${JSON.stringify(role)}.`, `${p}.match.roles[${j}]`);
              }
            });
          }
        }
      }
    }

    // deprecated
    if (c.deprecated !== undefined) {
      const d = c.deprecated;
      if (!isObj(d)) {
        add('error', 'invalid-field', `Component "${label}" "deprecated" must be an object.`, `${p}.deprecated`);
      } else {
        if (d.replacedBy !== undefined && (typeof d.replacedBy !== 'string' || !ids.has(d.replacedBy))) {
          add('error', 'unknown-reference', `Component "${label}" deprecated.replacedBy references unknown component ${JSON.stringify(d.replacedBy)}.`, `${p}.deprecated.replacedBy`);
        }
        if (d.message !== undefined && typeof d.message !== 'string') {
          add('error', 'invalid-field', `Component "${label}" deprecated.message must be a string.`, `${p}.deprecated.message`);
        }
      }
    }
  });

  // Tokens
  if (reg.tokens !== undefined) {
    const t = reg.tokens;
    if (!isObj(t)) {
      add('error', 'invalid-token', 'Registry "tokens" must be an object.', 'tokens');
    } else {
      for (const k of Object.keys(t).sort()) {
        if (KNOWN_TOKEN_KEYS.indexOf(k) === -1) add('info', 'unknown-key', `Unknown token group "${k}" is ignored.`, `tokens.${k}`);
      }
      const arr = (k: string): unknown[] | null => {
        if (t[k] === undefined) return null;
        if (!Array.isArray(t[k])) {
          add('error', 'invalid-token', `tokens.${k} must be an array.`, `tokens.${k}`);
          return null;
        }
        return t[k] as unknown[];
      };
      (arr('colors') || []).forEach((x, j) => {
        if (!isObj(x) || typeof x.name !== 'string' || typeof x.value !== 'string' || !HEX_RE.test(x.value)) {
          add('error', 'invalid-token', 'Color tokens must be { name, value: "#rgb" | "#rrggbb" }.', `tokens.colors[${j}]`);
        }
      });
      (arr('spacing') || []).forEach((x, j) => {
        if (!isObj(x) || typeof x.name !== 'string' || typeof x.value !== 'number' || !isFinite(x.value) || x.value < 0) {
          add('error', 'invalid-token', 'Spacing tokens must be { name, value: finite number >= 0 }.', `tokens.spacing[${j}]`);
        }
      });
      (arr('typography') || []).forEach((x, j) => {
        const ok =
          isObj(x) &&
          typeof x.name === 'string' &&
          typeof x.fontSize === 'number' &&
          isFinite(x.fontSize) &&
          x.fontSize > 0 &&
          (x.fontFamily === undefined || typeof x.fontFamily === 'string') &&
          (x.fontWeight === undefined || (typeof x.fontWeight === 'number' && isFinite(x.fontWeight))) &&
          (x.lineHeight === undefined || (typeof x.lineHeight === 'number' && isFinite(x.lineHeight)));
        if (!ok) add('error', 'invalid-token', 'Typography tokens must be { name, fontSize > 0, fontFamily?, fontWeight?, lineHeight? }.', `tokens.typography[${j}]`);
      });
      if (t.fontFamilies !== undefined && !isStringArray(t.fontFamilies)) {
        add('error', 'invalid-token', 'tokens.fontFamilies must be an array of strings.', 'tokens.fontFamilies');
      }
    }
  }

  return out;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Validate and index a registry document. `index` is null iff any error-level diagnostic.
 * Normalizes: missing status → 'draft', missing diviType → null.
 */
export function loadRegistry(input: unknown): { index: RegistryIndex | null; diagnostics: Diagnostic[] } {
  const diagnostics = validateRegistry(input);
  if (diagnostics.some((d) => d.level === 'error')) return { index: null, diagnostics };
  const reg = cloneJson(input) as ComponentRegistry;
  if (reg.status !== 'approved' && reg.status !== 'draft') reg.status = 'draft';
  reg.components = (reg.components || []).map((c) => {
    const n = c as RegistryComponent;
    if (n.diviType === undefined) n.diviType = null;
    if (!n.figmaComponentKeys) n.figmaComponentKeys = [];
    return n;
  });
  return { index: createRegistryIndex(reg), diagnostics };
}

/** Empty, unconstrained draft registry. */
export function emptyRegistry(): ComponentRegistry {
  return { version: '0.0.0', designSystem: 'None', status: 'draft', components: [] };
}

function byId(a: RegistryComponent, b: RegistryComponent): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Build an indexed view over a registry (assumed valid; invalid regexes are skipped defensively). */
export function createRegistryIndex(registry: ComponentRegistry): RegistryIndex {
  const components = (registry.components || []).slice();
  const idMap = new Map<string, RegistryComponent>();
  const keyMap = new Map<string, RegistryComponent>();
  const patterns = new Map<string, RegExp[]>();

  for (const c of components) {
    if (!idMap.has(c.id)) idMap.set(c.id, c);
    for (const k of c.figmaComponentKeys || []) {
      if (typeof k !== 'string' || isPlaceholderKey(k)) continue;
      if (!keyMap.has(k)) keyMap.set(k, c);
    }
    const res: RegExp[] = [];
    for (const p of (c.match && c.match.namePatterns) || []) {
      try {
        res.push(new RegExp(p, 'i'));
      } catch (_e) {
        /* skip invalid */
      }
    }
    patterns.set(c.id, res);
  }
  const sorted = components.slice().sort(byId);
  const status: 'draft' | 'approved' = registry.status === 'approved' ? 'approved' : 'draft';

  return {
    registry,
    version: registry.version,
    designSystem: registry.designSystem,
    status,
    getById(id: string): RegistryComponent | null {
      return idMap.get(id) ?? null;
    },
    getByKey(key: string): RegistryComponent | null {
      if (typeof key !== 'string' || key === '') return null;
      return keyMap.get(key) ?? null;
    },
    all(): RegistryComponent[] {
      return components.slice();
    },
    candidatesForRole(role: NodeRole): RegistryComponent[] {
      if (!role) return [];
      return sorted.filter((c) => !!c.match && Array.isArray(c.match.roles) && c.match.roles.indexOf(role) !== -1);
    },
    candidatesForName(name: string): RegistryComponent[] {
      if (typeof name !== 'string') return [];
      const n = name.trim();
      if (n === '') return [];
      const lower = n.toLowerCase();
      return sorted.filter((c) => {
        if (typeof c.name === 'string' && c.name.toLowerCase() === lower) return true;
        const res = patterns.get(c.id) || [];
        for (const re of res) {
          re.lastIndex = 0;
          if (re.test(n)) return true;
        }
        return false;
      });
    },
    isPlaceholderKey,
  };
}
