/**
 * FigmaKit Standards — shared type contract.
 *
 * The lint pipeline is split into two halves:
 *
 *   1. An async, Figma-specific SNAPSHOT step (src/lint/snapshot.ts) that walks
 *      real Figma nodes, resolves main components (required under
 *      `documentAccess: "dynamic-page"`), runs the existing FigmaKit analyzer,
 *      and produces a plain, serializable `DesignNode` tree.
 *
 *   2. A pure, synchronous, deterministic LINT step (engine + rules) that only
 *      ever sees `DesignNode` objects. Rules never touch the Figma API.
 *
 * Everything in this file must stay free of runtime code except constants.
 */

import type { NodeRole, Fingerprint } from '../shared/types';

// ---------------------------------------------------------------------------
// Severity, certainty
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info';

/** Severity setting as written in config. 'warn' and numbers are ESLint-style aliases. */
export type SeveritySetting = 'off' | 'info' | 'warning' | 'warn' | 'error' | 0 | 1 | 2;

/**
 * How strong the evidence behind an issue is.
 *  - confirmed:        provable from Figma data (e.g. instance key not in registry, detachedInfo present).
 *  - likely:           two or more independent heuristic signals agree.
 *  - requires-review:  a single weak signal; a human must decide.
 */
export type Certainty = 'confirmed' | 'likely' | 'requires-review';

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

// ---------------------------------------------------------------------------
// Design snapshot (input to rules)
// ---------------------------------------------------------------------------

export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';

export interface PaintSnapshot {
  /** Figma paint type: SOLID, IMAGE, GRADIENT_LINEAR, ... */
  type: string;
  visible: boolean;
  /** Lower-case #rrggbb for SOLID paints, otherwise null. */
  hex: string | null;
  /** Paint opacity (0..1). */
  opacity: number;
  /** Variable id bound to this paint's color (paint.boundVariables.color.id), if any. */
  boundVariableId: string | null;
}

export interface TextSnapshot {
  /** null when the text node has mixed values for the property. */
  fontFamily: string | null;
  fontStyle: string | null;
  fontSize: number | null;
  fontWeight: number | null;
  /** Line height in px, or null for AUTO / percent / mixed. */
  lineHeightPx: number | null;
  textCase: string | null;
  characters: string;
}

export interface MainComponentInfo {
  /** Node id of the main component (local or remote copy). */
  id: string;
  /** Stable publish key of the main component (variant). Empty string if unavailable. */
  key: string;
  name: string;
  /** True when the main component lives in a library rather than this file. */
  remote: boolean;
  /** Key of the parent COMPONENT_SET if the main component is a variant, else null. */
  componentSetKey: string | null;
  componentSetName: string | null;
}

export interface InstanceInfo {
  /** null when the main component could not be resolved (deleted / missing library). */
  mainComponent: MainComponentInfo | null;
  /** instance.variantProperties (null when not a variant). */
  variantProperties: Record<string, string> | null;
  /**
   * instance.componentProperties flattened to { propertyName: value }.
   * Property names keep Figma's "#id" suffix stripped (e.g. "Label#12:0" -> "Label").
   */
  componentProperties: Record<string, string | boolean>;
}

export type DetachedInfoSnapshot =
  | { type: 'local'; componentId: string; resolvedKey: string | null; resolvedComponentSetKey: string | null }
  | {
      type: 'library';
      componentKey: string;
      /**
       * Optional (additive): key of the COMPONENT_SET the detached library variant belongs to,
       * resolved via figma.importComponentByKeyAsync. null/absent when unknown or not a variant.
       */
      resolvedComponentSetKey?: string | null;
    };

/** Persisted FigmaKit Standards metadata on a node (pluginData key STANDARDS_PLUGIN_DATA_KEYS.component). */
export interface NodeStandardsMeta {
  /** Registry component id the designer declared this node to be (only honored if the component allows metadata mapping). */
  componentId: string | null;
  /** Divi module slug previously stamped on the node (pluginData 'fk-divi-type'), if any. */
  diviType?: string | null;
}

export interface DesignNode {
  id: string;
  name: string;
  /** Figma node type (FRAME, INSTANCE, TEXT, ...). */
  type: string;
  visible: boolean;
  /** Breadcrumb from the scope root to this node, inclusive, e.g. ["Hero", "CTA", "Button"]. */
  path: string[];
  parentId: string | null;
  /** Depth from scope root (root = 0). */
  depth: number;
  /**
   * Only meaningful on scope roots: true when the root's real Figma parent is the page (or a Figma
   * SECTION / the document), i.e. nothing registered can exist above it. false for partial selections
   * nested inside other layers. undefined is treated as true.
   */
  scopeRootIsTopLevel?: boolean;
  /** Pre-order DFS index within the whole lint run; used for deterministic ordering. */
  order: number;
  children: DesignNode[];

  // --- geometry & layout ---
  width: number;
  height: number;
  layoutMode: LayoutMode;
  padding: { top: number; right: number; bottom: number; left: number };
  itemSpacing: number;
  /**
   * Auto-layout primary-axis alignment (FrameNode.primaryAxisAlignItems), e.g. 'MIN' | 'CENTER' |
   * 'MAX' | 'SPACE_BETWEEN'. Optional (additive): absent/null when unknown or not applicable.
   * With 'SPACE_BETWEEN' the gap is "Auto" and itemSpacing has no visual effect.
   */
  primaryAxisAlignItems?: string | null;
  /** null when not applicable or mixed. */
  cornerRadius: number | null;

  // --- component provenance ---
  /** Present only for INSTANCE nodes. */
  instance: InstanceInfo | null;
  /** FrameNode.detachedInfo, normalized. null when the node is not a detached instance (or API unavailable). */
  detachedInfo: DetachedInfoSnapshot | null;
  /** True when this node is a descendant of an INSTANCE (i.e. owned by a component definition). */
  insideInstance: boolean;
  /**
   * Optional (additive). Only for INSTANCE nodes that live inside another instance:
   * - 'library': the layer comes from the enclosing instance's main component and still uses the same
   *   main component as there (a sub-instance baked into the library component; not designer-placed);
   * - 'override': designer-placed (swapped / variant changed / slot content not in the master);
   * - 'unknown': inside an instance but the origin could not be resolved.
   * Absent/null when not applicable or not computed (treated as designer-placed).
   */
  nestedInstanceOrigin?: 'library' | 'override' | 'unknown' | null;
  /** Id of the nearest INSTANCE ancestor, if any. */
  instanceAncestorId: string | null;

  // --- existing FigmaKit semantics (reused) ---
  /** Explicit semantic label: pluginData 'fk-type' or "[fk:role]" name prefix. */
  fkLabel: NodeRole | null;
  /** Layer name with any "[fk:role] " prefix stripped. */
  baseName: string;
  /** Final classification from the existing analyzer (core/analyzer.ts). May be name-influenced. */
  analysis: { role: NodeRole; confidence: number; source: string };
  /**
   * Name-blind classification: classifier + fingerprinter run with the layer name blanked,
   * so it can be used as an independent structural signal. null for non-container leaves where meaningless.
   */
  structural: { role: NodeRole; confidence: number; source: string } | null;
  fingerprint: Fingerprint | null;
  standardsMeta: NodeStandardsMeta;

  // --- styling ---
  fills: PaintSnapshot[];
  strokes: PaintSnapshot[];
  /** '' when none, 'MIXED' when mixed. */
  fillStyleId: string;
  strokeStyleId: string;
  textStyleId: string;
  /** node.boundVariables flattened: property -> variable ids. */
  boundVariables: Record<string, string[]>;
  text: TextSnapshot | null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryRequiredProperty {
  /** Variant or component property name (without Figma "#id" suffix). */
  name: string;
  /** If given, the instance's value must be one of these. */
  allowedValues?: string[];
}

export interface RegistryComponent {
  /** Stable registry identifier, e.g. "divi-button". Lowercase, [a-z0-9-]. */
  id: string;
  /** Human-readable name, e.g. "Divi Button". */
  name: string;
  /** Mapped Divi module slug, e.g. "et_pb_button". null when not yet confirmed. */
  diviType: string | null;
  /**
   * Stable Figma keys. May contain component keys and/or component-set keys.
   * An instance matches when its main component key OR its component-set key is listed.
   */
  figmaComponentKeys: string[];
  /** Registry ids allowed as nearest registered children. undefined = unconstrained. [] = none allowed. */
  allowedChildren?: string[];
  /** Registry ids allowed as nearest registered parent. Use "$root" for "no registered ancestor". undefined = unconstrained. */
  allowedParents?: string[];
  /**
   * If true, nearest semantic-boundary descendants of this component must be registered
   * (enables approved-component checks for unapproved instances inside it).
   */
  governsChildren?: boolean;
  /** Required instance properties / variant states. */
  requiredProperties?: RegistryRequiredProperty[];
  /** Optional, documented states (variant values). Informational; never enforced. */
  optionalStates?: Record<string, string[]>;
  /** If true, the component's instances must use auto layout. Direction optional. */
  requiresAutoLayout?: boolean | { direction?: 'HORIZONTAL' | 'VERTICAL' };
  /** Regex (string) the layer name of a semantic node mapped to this component must match. */
  namingPattern?: string;
  /** If true, a non-instance node may declare this identity via standards metadata. Default false. */
  allowMetadataMapping?: boolean;
  /** Heuristic hints used ONLY for detection of recreated/detached copies and suggestions. Never grants approval. */
  match?: {
    /** Regex strings tested (case-insensitive) against the layer base name. */
    namePatterns?: string[];
    /** Existing FigmaKit classifier roles that likely correspond to this component. */
    roles?: NodeRole[];
  };
  deprecated?: { replacedBy?: string; message?: string };
  description?: string;
}

export interface TokenSet {
  colors?: Array<{ name: string; value: string }>;
  spacing?: Array<{ name: string; value: number }>;
  typography?: Array<{
    name: string;
    fontFamily?: string;
    fontSize: number;
    fontWeight?: number;
    lineHeight?: number;
  }>;
  fontFamilies?: string[];
}

export interface ComponentRegistry {
  $schema?: string;
  /** Semver of this registry document. */
  version: string;
  /** e.g. "Divi 5". */
  designSystem: string;
  /** 'draft' registries contain placeholders and cannot certify readiness (by default). */
  status: 'draft' | 'approved';
  description?: string;
  components: RegistryComponent[];
  tokens?: TokenSet;
}

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Machine code, e.g. "duplicate-id", "unresolved-key", "unknown-rule". */
  code: string;
  message: string;
  /** JSON-pointer-ish location, e.g. "components[3].figmaComponentKeys[0]". */
  path?: string;
}

export interface RegistryMatch {
  component: RegistryComponent;
  /** How identity was established. */
  source: 'instance' | 'detached' | 'metadata';
  /** Which key matched (instance/detached only). */
  matchedKey: string | null;
}

/** Read-only, indexed view over a validated registry. Implemented in registry.ts. */
export interface RegistryIndex {
  readonly registry: ComponentRegistry;
  readonly version: string;
  readonly designSystem: string;
  readonly status: 'draft' | 'approved';
  getById(id: string): RegistryComponent | null;
  /** Look up by component key or component-set key. */
  getByKey(key: string): RegistryComponent | null;
  all(): RegistryComponent[];
  /** Components whose match.roles include `role`, sorted by id. */
  candidatesForRole(role: NodeRole): RegistryComponent[];
  /** Components whose match.namePatterns (or exact name) match `name`, sorted by id. */
  candidatesForName(name: string): RegistryComponent[];
  /** True when the key looks like a placeholder (e.g. "REPLACE_ME", "FIGMA_COMPONENT_KEY"). */
  isPlaceholderKey(key: string): boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type RuleSetting = SeveritySetting | [SeveritySetting] | [SeveritySetting, Record<string, unknown>];

export interface ExceptionPolicy {
  /** Master switch. If false, exceptions are recorded but never affect readiness. */
  enabled: boolean;
  /** Rules that can never be excepted (internal errors are always non-exemptible). */
  nonExemptRules: string[];
  /** If non-empty, only these Figma user ids (figma.currentUser.id) may approve. Local trust only. */
  allowedApprovers: string[];
  requireReason: boolean;
}

export interface ReadinessPolicy {
  /** Issues with these effective severities block readiness. Default ["error"]. */
  blockingSeverities: Severity[];
  /** Rules whose issues block regardless of severity (except 'info' unless listed in blockingSeverities). */
  blockingRules: string[];
  /** If true, a registry with status 'draft' or placeholder keys prevents readiness. */
  requireApprovedRegistry: boolean;
  /** If true, "Mark Ready" also sets Figma devStatus READY_FOR_DEV on validated top-level frames. */
  setDevStatus: boolean;
}

export interface LintSettings {
  /** Lint hidden layers (visible === false) and their subtrees. Default false. */
  includeHidden: boolean;
  /** Lint layers inside component instances (normally owned by the library). Default false. */
  checkInstanceInternals: boolean;
  /** Treat the validated scope roots as a governed context (unapproved instances are flagged there). */
  governTopLevel: boolean;
  /** Cap on issues per rule per run (protects the UI on huge files). Excess is counted, not dropped silently. */
  maxIssuesPerRule: number;
}

export interface LintConfig {
  /**
   * Admin build switch (bundled config only). false (default) = locked designer build: standards come
   * only from the plugin build, settings are hidden, and only listed approvers can add exceptions.
   */
  adminTools?: boolean;
  /** Presets: "figmakit:recommended", "figmakit:strict". */
  extends?: string[];
  /** Version of the organizational ruleset (bumped when standards change). */
  rulesetVersion?: string;
  rules?: Record<string, RuleSetting>;
  /** Semver range the registry version must satisfy, e.g. "^1.0.0". */
  registryVersion?: string;
  readiness?: Partial<ReadinessPolicy>;
  exceptions?: Partial<ExceptionPolicy>;
  settings?: Partial<LintSettings>;
}

export interface ResolvedRuleConfig {
  ruleId: string;
  enabled: boolean;
  /** Configured severity (meaningless when !enabled). */
  severity: Severity;
  /** Rule defaultOptions merged with configured options. */
  options: Record<string, unknown>;
}

export interface ResolvedConfig {
  rulesetVersion: string;
  /** Preset names applied, in order. */
  extends: string[];
  /** One entry per KNOWN rule, sorted by rule id. */
  rules: Record<string, ResolvedRuleConfig>;
  registryVersionRange: string | null;
  readiness: ReadinessPolicy;
  exceptions: ExceptionPolicy;
  settings: LintSettings;
}

// ---------------------------------------------------------------------------
// Rules, issues, fixes
// ---------------------------------------------------------------------------

export type FixKind = 'SAFE' | 'REQUIRES_CONFIRMATION' | 'UNSUPPORTED';

/** Whitelisted numeric properties a fix may set. */
export type FixNumberProperty = 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft' | 'itemSpacing';

/** Whitelisted pluginData keys a fix may write (see STANDARDS_PLUGIN_DATA_KEYS + existing 'fk-type'). */
export type FixPluginDataKey = 'fk-type' | 'fk-standards-component' | 'fk-divi-type';

/**
 * Serializable fix operations. Deliberately excludes delete / detach / swap / reparent:
 * structural changes are never expressible as autofixes.
 * Each op carries the expected current value (`from`) so stale fixes are refused.
 */
export type FixOperation =
  | { op: 'rename'; nodeId: string; from: string; to: string }
  | { op: 'setPluginData'; nodeId: string; key: FixPluginDataKey; from: string; to: string }
  | { op: 'setNumber'; nodeId: string; property: FixNumberProperty; from: number; to: number }
  | { op: 'setSolidPaintColor'; nodeId: string; target: 'fills' | 'strokes'; index: number; from: string; to: string };

export interface FixDescriptor {
  kind: FixKind;
  /** Human-readable preview, e.g. 'Rename "Frame 12" → "Divi Button"'. */
  description: string;
  /** Empty for UNSUPPORTED. */
  operations: FixOperation[];
}

export interface IssueException {
  id: string;
  ruleId: string;
  nodeId: string;
  /** If set, only issues with this code are excepted. */
  code?: string;
  /**
   * Optional (additive). If set, only the issue with this discriminator (see RuleReport.discriminator;
   * '' = an issue without one) is excepted — e.g. paddingLeft but not itemSpacing on the same layer.
   * Legacy exceptions without it cover every issue of the rule/node/code.
   */
  discriminator?: string;
  reason: string;
  approvedBy: { id: string | null; name: string };
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp; expired exceptions are ignored. */
  expiresAt?: string;
}

export interface LintIssue {
  /** Stable identifier: hash(ruleId | code | nodeId | discriminator). Same input → same id across runs. */
  id: string;
  ruleId: string;
  /** Rule-specific sub-code, e.g. "unapproved-instance". */
  code: string;
  nodeId: string;
  nodeName: string;
  /** "Hero / CTA / Button". */
  nodePath: string;
  /** Effective severity after config + certainty mapping. */
  severity: Severity;
  certainty: Certainty;
  message: string;
  suggestion?: string;
  expected?: string;
  actual?: string;
  fix?: FixDescriptor;
  /** True when a fix exists and is not UNSUPPORTED. */
  fixable: boolean;
  /** Computed by the engine from readiness policy (before exceptions). */
  blocking: boolean;
  /** Set by the engine when an active exception covers this issue. */
  exception?: IssueException;
  /** Optional (additive): the rule's discriminator for this issue, when it reported one. */
  discriminator?: string;
  data?: Record<string, unknown>;
}

/** What a rule returns; the engine fills in id, nodeName, nodePath, severity, fixable, blocking. */
export interface RuleReport {
  code: string;
  message: string;
  certainty?: Certainty; // default 'confirmed'
  /** Override severity for this report (rare; normally use certainty mapping). */
  severity?: Severity;
  suggestion?: string;
  expected?: string;
  actual?: string;
  fix?: FixDescriptor;
  /** Extra string making the stable id unique when one node yields several issues with the same code. */
  discriminator?: string;
  /** Report on a different node than the one being validated (defaults to the current node). */
  nodeId?: string;
  data?: Record<string, unknown>;
}

export interface RuleMeta {
  id: string;
  description: string;
  /** Longer markdown docs shown in RULES.md / UI. */
  docs?: string;
  category: 'components' | 'structure' | 'tokens' | 'naming' | 'layout';
  defaultSeverity: Severity;
  defaultOptions: Record<string, unknown>;
  /** True if the rule can ever produce a non-UNSUPPORTED fix. */
  fixable: boolean;
  /** Returns human-readable errors for invalid options ([] = valid). */
  validateOptions?: (options: Record<string, unknown>) => string[];
}

export interface LintRule {
  meta: RuleMeta;
  /** Whether this rule evaluates `node` at all. Used for "checks passed" accounting. */
  appliesTo(node: DesignNode, context: LintContext): boolean;
  /** Validate one node. Only called when appliesTo() returned true. Must be pure and deterministic. */
  validate(node: DesignNode, context: LintContext): RuleReport[];
}

/** Read-only context handed to rules. Implemented in context.ts. */
export interface LintContext {
  readonly registry: RegistryIndex;
  readonly config: ResolvedConfig;
  readonly settings: LintSettings;
  /** Options for the rule currently executing (engine swaps per rule). */
  readonly options: Record<string, unknown>;
  /** Severity configured for the rule currently executing. */
  readonly severity: Severity;
  readonly ruleId: string;
  /** Scope roots of this run. */
  readonly roots: DesignNode[];

  getNode(id: string): DesignNode | null;
  getParent(node: DesignNode): DesignNode | null;
  /** Ancestors nearest-first (excluding node). */
  getAncestors(node: DesignNode): DesignNode[];
  /** "A / B / C" built from node.path. */
  formatPath(node: DesignNode): string;

  /** Registry identity of a node (instance key, confirmed detach, or allowed metadata). Memoized. */
  getRegistryMatch(node: DesignNode): RegistryMatch | null;
  /** Nearest ancestor that has a registry identity, or null. */
  getNearestRegisteredAncestor(node: DesignNode): DesignNode | null;
  /**
   * Nearest registered descendants: walk children, stop descending at each node with an identity.
   * Does not descend into instance internals unless settings.checkInstanceInternals.
   */
  getNearestRegisteredDescendants(node: DesignNode): DesignNode[];
  /** True when the nearest registered ancestor governsChildren, or (no ancestor and settings.governTopLevel). */
  isInGovernedContext(node: DesignNode): boolean;
  /**
   * Whether a node should be skipped by structural rules because it is owned by an instance
   * (insideInstance && !settings.checkInstanceInternals).
   */
  isInstanceInternal(node: DesignNode): boolean;
  /** Approved token set (registry.tokens) — empty object when absent. */
  readonly tokens: TokenSet;
}

// ---------------------------------------------------------------------------
// Engine output, readiness, report
// ---------------------------------------------------------------------------

export type RuleRunStatus = 'passed' | 'failed' | 'crashed' | 'off';

export interface RuleSummary {
  ruleId: string;
  description: string;
  enabled: boolean;
  severity: Severity | 'off';
  /** Number of (node) evaluations where appliesTo() was true. */
  checks: number;
  /** Checks that produced zero reports. */
  passedChecks: number;
  issueCount: number;
  /** Issues beyond maxIssuesPerRule that were counted but not materialized. */
  truncatedCount: number;
  status: RuleRunStatus;
  /** Count of validate()/appliesTo() invocations that threw. */
  errorCount: number;
  firstError?: string;
}

export const INTERNAL_ERROR_RULE_ID = 'internal/rule-error';

export interface LintRunResult {
  issues: LintIssue[];
  /** Subset of issues with ruleId === INTERNAL_ERROR_RULE_ID (also included in `issues`). */
  internalErrors: LintIssue[];
  ruleSummaries: RuleSummary[];
  configDiagnostics: Diagnostic[];
  registryDiagnostics: Diagnostic[];
  nodeCount: number;
  totals: {
    checks: number;
    passedChecks: number;
    errors: number;
    warnings: number;
    infos: number;
    fixable: number;
    safeFixable: number;
    requiresReview: number;
  };
  rulesetVersion: string;
  registryVersion: string;
  designSystem: string;
}

export type ReadinessStatus = 'READY' | 'READY_WITH_EXCEPTIONS' | 'NOT_READY';

export interface ReadinessResult {
  ready: boolean;
  status: ReadinessStatus;
  /** Blocking issues NOT covered by an active exception (includes internal errors). */
  blockingIssues: LintIssue[];
  /** Blocking issues covered by an active, policy-permitted exception. */
  exceptedIssues: LintIssue[];
  /** Non-blocking warnings. */
  warnings: LintIssue[];
  /** Human-readable reasons readiness was denied (empty when ready). */
  reasons: string[];
  rulesetVersion: string;
  registryVersion: string;
}

export interface ReportScope {
  type: 'selection' | 'page';
  pageId: string;
  pageName: string;
  rootNodeIds: string[];
  rootNodeNames: string[];
}

export interface HandoffReport {
  schemaVersion: '1.0.0';
  tool: { name: 'FigmaKit Prep'; component: 'standards'; version: string };
  file: { name: string; fileKey: string | null };
  scope: ReportScope;
  /** ISO timestamp. */
  validatedAt: string;
  validatedBy: { id: string | null; name: string | null };
  rulesetVersion: string;
  registry: { version: string; designSystem: string; status: 'draft' | 'approved' };
  configHash: string;
  totals: LintRunResult['totals'];
  ruleResults: RuleSummary[];
  issues: LintIssue[];
  blockingViolations: LintIssue[];
  approvedExceptions: Array<IssueException & { issueId: string }>;
  readiness: { ready: boolean; status: ReadinessStatus; reasons: string[] };
  diagnostics: { config: Diagnostic[]; registry: Diagnostic[] };
  /**
   * Hash over the canonical report body (all fields except this one).
   * Integrity only — NOT a signature; a local plugin cannot attest authenticity.
   */
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Persistence keys (document-level shared plugin data, readable by REST API)
// ---------------------------------------------------------------------------

export const STANDARDS_SHARED_NAMESPACE = 'figmakit_standards';

export const STANDARDS_DOC_KEYS = {
  config: 'config',
  registry: 'registry',
  exceptions: 'exceptions',
  readiness: 'readiness',
} as const;

export const STANDARDS_PLUGIN_DATA_KEYS = {
  /** Node-level: declared registry component id (metadata mapping). */
  component: 'fk-standards-component',
  /** Node-level: Divi module slug stamped from the registry. */
  diviType: 'fk-divi-type',
  /** Existing FigmaKit label key (features/labeler.ts). */
  fkType: 'fk-type',
} as const;
