/**
 * Lint configuration: presets, defaults and resolution of an (untrusted) LintConfig
 * into a fully-populated ResolvedConfig. Never throws; problems become Diagnostics.
 */

import type {
  LintConfig,
  LintRule,
  LintSettings,
  ReadinessPolicy,
  ExceptionPolicy,
  ResolvedConfig,
  ResolvedRuleConfig,
  Diagnostic,
  DiagnosticLevel,
  Severity,
  SeveritySetting,
  RuleSetting,
} from './types';
import { isValidRange, satisfies } from './semver';
import bundledConfig from '../standards/figmakit.config.json';

/** Rule ids referenced by the presets (rules not supplied to resolveConfig are ignored). */
const PRESET_RULE_IDS = [
  'divi/approved-component',
  'divi/valid-nesting',
  'divi/detached-component',
  'divi/semantic-mapping',
  'divi/approved-tokens',
  'divi/auto-layout',
  'divi/component-naming',
  'divi/required-states',
];

function allError(): Record<string, RuleSetting> {
  const out: Record<string, RuleSetting> = {};
  for (const id of PRESET_RULE_IDS) out[id] = 'error';
  return out;
}

/** Built-in presets. */
export const PRESETS: Record<string, LintConfig> = {
  'figmakit:recommended': {
    rulesetVersion: '1.0.0',
    rules: {
      'divi/approved-component': 'error',
      'divi/valid-nesting': 'error',
      'divi/detached-component': 'error',
      'divi/semantic-mapping': 'warning',
      'divi/approved-tokens': 'warning',
      'divi/auto-layout': 'warning',
      'divi/component-naming': 'warning',
      'divi/required-states': 'error',
    },
  },
  'figmakit:strict': {
    rulesetVersion: '1.0.0',
    rules: {
      ...allError(),
      'divi/detached-component': [
        'error',
        { certaintySeverity: { likely: 'error', 'requires-review': 'warning' }, reportStructureOnly: true },
      ],
      'divi/semantic-mapping': ['error', { minConfidence: 70 }],
    },
    settings: { governTopLevel: true },
  },
};

export const DEFAULT_SETTINGS: LintSettings = {
  includeHidden: false,
  checkInstanceInternals: false,
  governTopLevel: false,
  maxIssuesPerRule: 500,
};

export const DEFAULT_READINESS: ReadinessPolicy = {
  blockingSeverities: ['error'],
  blockingRules: [],
  requireApprovedRegistry: true,
  setDevStatus: false,
};

export const DEFAULT_EXCEPTIONS: ExceptionPolicy = {
  enabled: true,
  nonExemptRules: [],
  allowedApprovers: [],
  requireReason: true,
};

/** The organization config bundled with the plugin (src/standards/figmakit.config.json). */
export const BUNDLED_CONFIG: LintConfig = bundledConfig as unknown as LintConfig; // JSON widens tuples; resolveConfig validates it at runtime

/** Map a config severity to an effective severity. 'off' disables; null = invalid. */
export function normalizeSeverity(s: SeveritySetting): Severity | 'off' | null {
  switch (s) {
    case 'off':
    case 0:
      return 'off';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
    case 1:
      return 'warning';
    case 'error':
    case 2:
      return 'error';
    default:
      return null;
  }
}

const SEVERITIES: Severity[] = ['error', 'warning', 'info'];
const KNOWN_CONFIG_KEYS = ['adminTools', 'extends', 'rulesetVersion', 'rules', 'registryVersion', 'readiness', 'exceptions', 'settings'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

type Validator = (v: unknown) => boolean;
const isBool: Validator = (v) => typeof v === 'boolean';

const SETTINGS_SCHEMA: Record<keyof LintSettings, Validator> = {
  includeHidden: isBool,
  checkInstanceInternals: isBool,
  governTopLevel: isBool,
  maxIssuesPerRule: (v) => typeof v === 'number' && isFinite(v) && v >= 1 && Math.floor(v) === v,
};
const READINESS_SCHEMA: Record<keyof ReadinessPolicy, Validator> = {
  blockingSeverities: (v) => Array.isArray(v) && v.every((x) => SEVERITIES.indexOf(x as Severity) !== -1),
  blockingRules: isStringArray,
  requireApprovedRegistry: isBool,
  setDevStatus: isBool,
};
const EXCEPTIONS_SCHEMA: Record<keyof ExceptionPolicy, Validator> = {
  enabled: isBool,
  nonExemptRules: isStringArray,
  allowedApprovers: isStringArray,
  requireReason: isBool,
};

/**
 * Resolve a config against the known rules.
 *
 * Layering: rule meta defaults → each preset in `extends` (in order) → `config.rules`.
 * Options are shallow-merged over the accumulated options at each layer (so a user
 * override of one option keeps the preset's other options). Preset rule ids that are
 * not among `rules` are silently ignored; unknown ids in the user's `rules` are errors.
 * Rules whose final options fail `validateOptions` fall back to their defaultOptions
 * (and an `invalid-options` error is reported).
 */
export function resolveConfig(config: LintConfig, rules: LintRule[]): { config: ResolvedConfig; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const add = (level: DiagnosticLevel, code: string, message: string, path?: string): void => {
    const d: Diagnostic = { level, code, message };
    if (path !== undefined) d.path = path;
    diagnostics.push(d);
  };

  let cfg: LintConfig = config as LintConfig;
  if (!isObj(cfg)) {
    add('error', 'invalid-config', 'Configuration must be a JSON object.');
    cfg = {};
  } else {
    for (const k of Object.keys(cfg).sort()) {
      if (KNOWN_CONFIG_KEYS.indexOf(k) === -1) add('info', 'unknown-key', `Unknown configuration property "${k}" is ignored.`, k);
    }
  }

  // Known rules, sorted by id (first definition wins on duplicates).
  const ruleMap = new Map<string, LintRule>();
  for (const r of rules.slice().sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0))) {
    if (!ruleMap.has(r.meta.id)) ruleMap.set(r.meta.id, r);
  }
  const ruleIds = Array.from(ruleMap.keys());

  const state: Record<string, ResolvedRuleConfig> = {};
  for (const id of ruleIds) {
    const meta = ruleMap.get(id)!.meta;
    state[id] = {
      ruleId: id,
      enabled: true,
      severity: SEVERITIES.indexOf(meta.defaultSeverity) !== -1 ? meta.defaultSeverity : 'error',
      options: { ...(meta.defaultOptions || {}) },
    };
  }

  let settings: LintSettings = { ...DEFAULT_SETTINGS };
  let readiness: ReadinessPolicy = { ...DEFAULT_READINESS };
  let exceptions: ExceptionPolicy = { ...DEFAULT_EXCEPTIONS };
  let rulesetVersion: string | null = null;

  function mergeSection<T extends object>(current: T, input: unknown, schema: Record<string, Validator>, section: string): T {
    if (input === undefined) return current;
    if (!isObj(input)) {
      add('error', `invalid-${section}`, `"${section}" must be an object.`, section);
      return current;
    }
    const next = { ...current } as Record<string, unknown>;
    for (const k of Object.keys(input).sort()) {
      const validate = schema[k];
      if (!validate) {
        add('info', 'unknown-key', `Unknown ${section} property "${k}" is ignored.`, `${section}.${k}`);
        continue;
      }
      if (!validate(input[k])) {
        add('error', `invalid-${section}`, `Invalid value for ${section}.${k}.`, `${section}.${k}`);
        continue;
      }
      next[k] = Array.isArray(input[k]) ? (input[k] as unknown[]).slice() : input[k];
    }
    return next as T;
  }

  function applyRules(input: unknown, fromPreset: boolean, pathPrefix: string): void {
    if (input === undefined) return;
    if (!isObj(input)) {
      add('error', 'invalid-rules', '"rules" must be an object.', pathPrefix);
      return;
    }
    for (const id of Object.keys(input).sort()) {
      const path = `${pathPrefix}.${id}`;
      const current = state[id];
      if (!current) {
        if (!fromPreset) add('error', 'unknown-rule', `Unknown rule "${id}".`, path);
        continue;
      }
      const setting = input[id] as unknown;
      let sev: unknown;
      let opts: unknown;
      if (Array.isArray(setting)) {
        sev = setting[0];
        opts = setting[1];
        if (setting.length > 2) add('error', 'invalid-severity', `Rule "${id}" setting must be [severity] or [severity, options].`, path);
      } else {
        sev = setting;
      }
      const norm = normalizeSeverity(sev as SeveritySetting);
      if (norm === null) {
        add('error', 'invalid-severity', `Rule "${id}" has invalid severity ${JSON.stringify(sev)}.`, path);
      } else if (norm === 'off') {
        current.enabled = false;
      } else {
        current.enabled = true;
        current.severity = norm;
      }
      if (opts !== undefined) {
        if (!isObj(opts)) {
          add('error', 'invalid-options', `Rule "${id}" options must be an object.`, path);
        } else {
          current.options = { ...current.options, ...opts };
        }
      }
    }
  }

  function applyLayer(layer: LintConfig, fromPreset: boolean, prefix: string): void {
    if (layer.rulesetVersion !== undefined) {
      if (typeof layer.rulesetVersion === 'string' && layer.rulesetVersion.trim() !== '') rulesetVersion = layer.rulesetVersion;
      else add('error', 'invalid-ruleset-version', '"rulesetVersion" must be a non-empty string.', prefix + 'rulesetVersion');
    }
    applyRules(layer.rules, fromPreset, prefix + 'rules');
    settings = mergeSection(settings, layer.settings, SETTINGS_SCHEMA, 'settings');
    readiness = mergeSection(readiness, layer.readiness, READINESS_SCHEMA, 'readiness');
    exceptions = mergeSection(exceptions, layer.exceptions, EXCEPTIONS_SCHEMA, 'exceptions');
  }

  // Presets
  const applied: string[] = [];
  if (cfg.extends !== undefined) {
    if (!isStringArray(cfg.extends)) {
      add('error', 'invalid-extends', '"extends" must be an array of preset names.', 'extends');
    } else {
      cfg.extends.forEach((name, i) => {
        const preset = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : undefined;
        if (!preset) {
          add('error', 'unknown-preset', `Unknown preset "${name}".`, `extends[${i}]`);
          return;
        }
        applied.push(name);
        applyLayer(preset, true, '');
      });
    }
  }

  // User config
  applyLayer(cfg, false, '');

  // Options validation on final state.
  for (const id of ruleIds) {
    const meta = ruleMap.get(id)!.meta;
    if (!meta.validateOptions) continue;
    let errs: string[];
    try {
      errs = meta.validateOptions(state[id].options) || [];
    } catch (e) {
      errs = ['validateOptions threw: ' + (e instanceof Error ? e.message : String(e))];
    }
    if (errs.length > 0) {
      add('error', 'invalid-options', `Rule "${id}" has invalid options: ${errs.join('; ')}`, `rules.${id}`);
      state[id].options = { ...(meta.defaultOptions || {}) };
    }
  }

  if (rulesetVersion === null) {
    add('warning', 'missing-ruleset-version', 'No "rulesetVersion" set; reports will show 0.0.0.', 'rulesetVersion');
  }

  let registryVersionRange: string | null = null;
  if (cfg.registryVersion !== undefined) {
    if (typeof cfg.registryVersion === 'string' && isValidRange(cfg.registryVersion)) {
      registryVersionRange = cfg.registryVersion;
    } else {
      add('error', 'invalid-registry-range', `"registryVersion" ${JSON.stringify(cfg.registryVersion)} is not a valid semver range.`, 'registryVersion');
    }
  }

  const sortedRules: Record<string, ResolvedRuleConfig> = {};
  for (const id of ruleIds) sortedRules[id] = state[id];

  return {
    config: {
      rulesetVersion: rulesetVersion ?? '0.0.0',
      extends: applied,
      rules: sortedRules,
      registryVersionRange,
      readiness,
      exceptions,
      settings,
    },
    diagnostics,
  };
}

/** Error `incompatible-registry` when the config pins a registry range the registry does not satisfy. */
export function checkRegistryCompatibility(config: ResolvedConfig, registryVersion: string): Diagnostic[] {
  const range = config.registryVersionRange;
  if (!range) return [];
  if (satisfies(registryVersion, range)) return [];
  return [
    {
      level: 'error',
      code: 'incompatible-registry',
      message: `Registry version ${registryVersion} does not satisfy the required range "${range}".`,
      path: 'registryVersion',
    },
  ];
}
