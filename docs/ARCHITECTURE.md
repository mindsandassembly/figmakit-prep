# FigmaKit Standards — Architecture

This document describes how the **Standards** feature (the design-standards linter) is built inside the
existing FigmaKit Prep plugin, how its data is configured and stored, and how to extend it. It describes
what the code in `src/lint/**` and `src/standards/**` does today. Where the original design spec and the
code differ, this document follows the code.

Related documents:

- [RULES.md](./RULES.md): reference for every rule
- [HANDOFF_VALIDATION.md](./HANDOFF_VALIDATION.md): readiness, exceptions, the report, and what local validation cannot guarantee
- [LOCAL_DEVELOPMENT.md](./LOCAL_DEVELOPMENT.md): build, test, and reload loop
- [FIGMA_INSTALLATION.md](./FIGMA_INSTALLATION.md): installing in Figma, populating the registry, and a sample test document

---

## 1. Goals and non-goals

**Goals**

- Check a Figma selection or page against an organization's **approved component registry** (Divi 5 by
  default) and token set, and report issues with an explicit evidence level (`certainty`).
- Produce a **binary readiness verdict** that can be explained. The verdict never uses a percentage score.
- Offer **autofixes** only for a short whitelist of non-structural operations, and only with preview and
  confirmation where the change is visual.
- Produce **deterministic** results: the same snapshot, config and registry always give the same issues,
  ids and order.

**Non-goals**

- The linter does not invent Divi nesting rules. All nesting, required states and naming constraints
  come from the registry. With an unconstrained registry, those rules produce no issues.
- A local plugin cannot prove to a third party that a file passed validation. See
  [HANDOFF_VALIDATION.md §7](./HANDOFF_VALIDATION.md#7-what-local-validation-cannot-guarantee).

---

## 2. Existing FigmaKit functionality that is reused

The Standards feature is built on the plugin's existing analysis code and does not duplicate it.

| Existing module | What Standards uses it for |
|---|---|
| `src/core/analyzer.ts` → `analyzeNode()` | Run once per scope root during the snapshot. Its `role` / `confidence` / `source` / `fingerprint` become `DesignNode.analysis` and `DesignNode.fingerprint`. This classification can be influenced by the layer name. |
| `src/core/classifier.ts` → `classifyNode()` | Run again on a plain *facade* object with `name: ''` to produce the **name-blind** `DesignNode.structural` classification. `divi/detached-component` uses it as a structural signal that is independent of the layer name. |
| `src/core/fingerprinter.ts` → `fingerprintChildren()`, `matchFingerprint()` | Run on the facade for containers with ≥2 children. It uses the same resolution order as the analyzer: a structural match overrides the type classification. |
| `src/features/labeler.ts` (`fk-type` plugin data, `[fk:role] ` name prefix) | Read by the snapshot as the explicit semantic label `DesignNode.fkLabel`. Plugin data takes precedence over the name prefix, and only valid `NodeRole`s count. `baseName` is the name with the prefix removed. A fix may write `fk-type` (it is whitelisted), but no current rule emits such a fix. |
| `src/shared/constants.ts` → `SPACING_SCALE` | The fallback spacing scale for `divi/approved-tokens` (4, 8, 12, 16, 20, 24, 32, 48, 80, 96). The bundled registry's `tokens.spacing` is generated from the same values. |
| `src/features/token-preview.ts` → `snapSpacing()` | Finds the nearest token when the FigmaKit scale is the fallback. |
| `src/features/color-checker.ts` → `parseColorToRGB()`, `colorDistance()` | RGB Euclidean distance for color snapping. These two functions were made `export` with no behavior change. |
| `src/shared/constants.ts` → `AUTO_NAME_PATTERN` | Used by `divi/component-naming` to detect Figma default names such as "Frame 12" or "Group 3". |
| `src/shared/figma-helpers.ts` (`safeGetString`, `safeGetNumber`, `safeGetArray`, `safeGetChildren`) | All raw node reads in the snapshot. They handle `figma.mixed` symbols and ReadonlyArray quirks. |
| `src/shared/types.ts` → `NodeRole`, `NODE_ROLES` | The role vocabulary for registry `match.roles`, `boundaryRoles` and labels. |

### Extension points found in the original code

- The **analyzer pipeline** returns plain `AnalysisResult` trees that keep a reference to the node. This
  is why the snapshot can match analysis results to raw children by index and identity.
- `fk-type` plugin data / `[fk:role]` prefixes were already the "explicit override" channel for the
  WordPress mapping. Standards treats them as designer-declared intent.
- `main.ts` routes UI messages by `type` in `handleMessage()`. Standards adds one branch for messages
  whose type starts with `standards-` (see §12).
- `getTargetNodes()` in `main.ts` (selection, otherwise the current page's children) defines the scope
  semantics that Standards reuses.
- `ConfidenceSource` already distinguishes `name` from `type` / `structure` sources. `divi/semantic-mapping`
  uses this to ignore classifications that came from the name only.

---

## 3. Snapshot → pure engine split, and why

```
           Figma main thread (async, impure)                    Pure, synchronous, deterministic
 ┌───────────────────────────────────────────────┐   ┌───────────────────────────────────────────────┐
 │ src/lint/snapshot.ts                          │   │ src/lint/engine.ts + src/lint/rules/*.ts      │
 │  buildDesignTree(rawRoots, resolver, opts)    │   │  runLint({roots, rules, config, registry,…})  │
 │   - getMainComponentAsync() per INSTANCE      │──▶│   - rules see only DesignNode + LintContext   │
 │   - getNodeByIdAsync() for detachedInfo.local │   │   - no Figma API, no clock, no randomness     │
 │   - analyzeNode / classifyNode / fingerprint  │   │                                               │
 │   - plain JSON-serializable DesignNode tree   │   │                                               │
 └───────────────────────────────────────────────┘   └───────────────────────────────────────────────┘
```

Reasons for the split:

1. **`documentAccess: "dynamic-page"`**. The manifest uses dynamic page loading. Under that mode the
   synchronous `instance.mainComponent` getter throws, and nodes on other pages must be fetched with
   `figma.getNodeByIdAsync`. Rules have to be synchronous and simple, so every async lookup happens once
   in the snapshot (`createFigmaResolver`, which caches by node id). Rules never await anything.
2. **Determinism**. Rules receive a frozen, plain data structure. They cannot observe document changes
   made during a run, the clock, or API ordering differences. The engine never calls `Date.now()`. The
   current time is passed in (`now`) only to evaluate exception expiry.
3. **Testability**. All rule tests build `DesignNode` trees directly with `tests/lint/helpers.ts`. No
   Figma mock is needed. The snapshot has its own tests against the raw mocks in
   `tests/helpers/figma-mock.ts`, using `createMockResolver()`.
4. **Fault isolation**. A rule that throws or returns malformed output becomes a blocking
   `internal/rule-error` issue. The run continues.

The snapshot never mutates the document. Only `autofix.ts#applyFixes` and the controller's persistence
calls write to the document.

---

## 4. Module map

```
src/
├── main.ts                     existing entry; routes standards-* messages to the controller
├── standards-controller.ts     Figma glue for the Standards tab (see "Controller" below)
├── ui.html / ui.ts             existing UI; Standards tab added (8th tab, panel #panel-standards)
├── ui-standards.ts             Standards tab rendering/state (imported by ui.ts); stale-result tracking,
│                               Mark Ready gating (canMarkReady), report download
├── standards/
│   ├── registry.json           bundled DRAFT Divi 5 registry (placeholder keys, no nesting rules)
│   └── figmakit.config.json    bundled org config: extends figmakit:recommended
└── lint/
    ├── types.ts                shared type contract + persistence key constants (no runtime code
    │                           except constants)
    ├── snapshot.ts             async Figma adapter → DesignNode tree (createFigmaResolver,
    │                           createMockResolver, buildDesignTree, classifyStructure)
    ├── registry.ts             validateRegistry, loadRegistry, createRegistryIndex, emptyRegistry,
    │                           isPlaceholderKey
    ├── config.ts               PRESETS, DEFAULT_SETTINGS/READINESS/EXCEPTIONS, BUNDLED_CONFIG,
    │                           normalizeSeverity, resolveConfig, checkRegistryCompatibility
    ├── semver.ts               parseVersion, compareVersions, satisfies, isValidRange (no deps)
    ├── context.ts              createLintContext (LintContext impl), severityForCertainty
    ├── engine.ts               runLint, MAX_RULE_CRASHES
    ├── readiness.ts            isBlocking, evaluateReadiness
    ├── exceptions.ts           validateException, createException, isExceptionActive, canApprove,
    │                           isRuleExemptible, findActiveException, parseExceptions
    ├── autofix.ts              planFixes, validateOperation, applyFixes, describeOperation
    ├── reporter.ts             groupIssuesByRule, filterIssues, summarize, buildHandoffReport,
    │                           verifyContentHash, formatIssueText
    ├── hash.ts                 fnv1a, stableStringify, issueId (sandbox-safe, NOT cryptographic)
    ├── handoff-service.ts      HandoffAttestationService interface + LocalOnlyHandoffService
    └── rules/
        ├── index.ts            ALL_RULES (sorted by id)
        ├── approved-component.ts   divi/approved-component
        ├── approved-tokens.ts      divi/approved-tokens
        ├── auto-layout.ts          divi/auto-layout
        ├── component-naming.ts     divi/component-naming
        ├── detached-component.ts   divi/detached-component (+ getRecreationCandidates,
        │                           isDetachedRuleTarget, detachedOptionsFromContext)
        ├── required-states.ts      divi/required-states
        ├── semantic-mapping.ts     divi/semantic-mapping
        └── valid-nesting.ts        divi/valid-nesting

tests/lint/**                   Vitest suites; helpers.ts = DesignNode builders, testRegistry(), lint()
```

**Controller** (`src/standards-controller.ts`). This is the Figma main-thread glue. It loads standards
from document storage or the bundled files, runs snapshot → engine → readiness, plans and applies fixes,
manages exceptions, exports the report, records "Mark Ready", and helps generate and verify registry
entries. It exports `handleStandardsMessage(msg, deps?)` and `isStandardsMessage(msg)`. Dependencies
(`figma`, `now()`, `postMessage`) are injectable for tests. The full message protocol is listed in §12.

---

## 5. Data flow

```
 UI (Standards tab)                                   main thread
 ──────────────────                                   ───────────
 [Run Validation] ── standards-run ─────────────────▶ controller.loadStandards(figma)
                                                        ├─ registry: shared plugin data "registry"  ─┐
                                                        │            else src/standards/registry.json │ loadRegistry()
                                                        ├─ config:   shared plugin data "config"      │ resolveConfig(cfg, ALL_RULES)
                                                        │            else figmakit.config.json        │ checkRegistryCompatibility()
                                                        └─ exceptions: shared plugin data "exceptions"┘ parseExceptions()
                                                      scope = selection, else currentPage.children
                    ◀── standards-progress {stage} ── buildDesignTree(scope, createFigmaResolver(figma),
                                                                       {includeHidden})
                                                        └─ DesignNode[] (plain data)
                                                      runLint({roots, rules: ALL_RULES, config, registry,
                                                               configDiagnostics, registryDiagnostics,
                                                               exceptions, now})
                                                        └─ LintRunResult (issues sorted, ids stable)
                                                      evaluateReadiness({result, config, registry})
                    ◀── standards-result ───────────── └─ ReadinessResult (READY / READY_WITH_EXCEPTIONS
                                                                            / NOT_READY + reasons)
 [Fix Safe Issues] ─ standards-fix-preview ─────────▶ planFixes(lastRun.issues, 'safe')
                    ◀── standards-fix-preview ─────── operations + skipped
 [Apply]  ───────── standards-apply-fixes ──────────▶ applyFixes(plan, {getNode: figma.getNodeByIdAsync})
                    ◀── standards-fix-result ──────── then re-run validation → standards-result
 [Export Report] ── standards-export {rerun?} ───────▶ (re-run if stale) buildHandoffReport(...) → JSON
 [Mark Ready] ───── standards-mark-ready ───────────▶ re-run validation; if ready → setSharedPluginData(
                    ◀── standards-mark-ready-result ─   "figmakit_standards","readiness", record)
                                                        (+ devStatus READY_FOR_DEV if configured)
```

---

## 6. Registry format

The registry is the only source of truth for approved components, nesting, required states and tokens.
The bundled file is `src/standards/registry.json`. A per-document override is stored in shared plugin
data (§10).

### 6.1 Top level

| Field | Type | Required | Notes |
|---|---|---|---|
| `$schema` | string | no | Ignored. |
| `version` | semver string | **yes** | Must parse as `MAJOR.MINOR.PATCH[-pre][+build]`. Error `invalid-version` otherwise. The config's `registryVersion` range is checked against it. |
| `designSystem` | non-empty string | **yes** | e.g. `"Divi 5"`. |
| `status` | `"draft"` \| `"approved"` | recommended | Missing → warning `missing-status`, treated as `draft`. With the default readiness policy, a draft registry prevents readiness. |
| `description` | string | no | |
| `components` | `RegistryComponent[]` | **yes** | |
| `tokens` | `TokenSet` | no | See 6.3. |

Unknown top-level, component or token keys produce an `info` diagnostic (`unknown-key`) and are ignored.

### 6.2 `RegistryComponent`

| Field | Type | Default | Meaning / used by |
|---|---|---|---|
| `id` | string matching `/^[a-z0-9][a-z0-9-]*$/` | required | Stable registry id. Must be unique (`duplicate-id`). |
| `name` | non-empty string | required | Display name used in messages and as the rename target (`divi/component-naming`). |
| `diviType` | string \| null | `null` | Divi module slug (e.g. `et_pb_button`). Stamped as `fk-divi-type` by `divi/semantic-mapping` when `stampApprovedInstances` is on. |
| `figmaComponentKeys` | string[] | required | Published component keys **and/or** component-set keys. An instance matches when its main-component key **or** its component-set key is listed. Placeholder keys (empty, starting with `REPLACE`/`TODO`/`FIGMA_COMPONENT_KEY`/`PLACEHOLDER`/`XXX`, or containing `REPLACE`) give warning `unresolved-key` and are **not indexed**. `[]` gives warning `no-keys`. A key listed on two components is error `duplicate-key`. |
| `allowedChildren` | string[] (registry ids) | unconstrained | Ids allowed as the *nearest registered* children. `[]` means none allowed. Used by `divi/valid-nesting` (`invalid-child`). Unknown ids → error `unknown-reference`. |
| `allowedParents` | string[] (ids or `"$root"`) | unconstrained | Ids allowed as the nearest registered parent. `"$root"` means no registered ancestor within the validated scope. Used by `divi/valid-nesting` (`invalid-parent`). |
| `governsChildren` | boolean | `false` | When true, unapproved instances anywhere below this component (up to the next registered component) are flagged by `divi/approved-component`. |
| `requiredProperties` | `{name, allowedValues?}[]` | none | Variant or component property names (without Figma's `#id` suffix). Used by `divi/required-states`. |
| `optionalStates` | `Record<string, string[]>` | none | Documentation only. Never enforced. |
| `requiresAutoLayout` | boolean \| `{direction?: "HORIZONTAL"\|"VERTICAL"}` | none | Used by `divi/auto-layout`. |
| `namingPattern` | regex string | none | Layer base name must match (case-sensitive; flags are not supported). Used by `divi/component-naming`. Must compile (`invalid-pattern`). |
| `allowMetadataMapping` | boolean | `false` | When true, a non-instance layer may declare this identity via plugin data `fk-standards-component = <id>`. That declaration is the only way metadata can give a layer a registry identity. |
| `match.namePatterns` | regex strings | none | **Heuristic hints only.** Tested case-insensitively against layer base names (also the component's exact `name`). Used for recreation detection and suggestions. Never grants approval. |
| `match.roles` | `NodeRole[]` | none | **Heuristic hints only.** FigmaKit roles likely corresponding to this component. Unknown roles → warning `unknown-role`. |
| `deprecated` | `{replacedBy?, message?}` | none | Instances are reported as `deprecated-component`. `replacedBy` must be a known id. |
| `description` | string | none | |

### 6.3 `tokens`

| Field | Shape | Notes |
|---|---|---|
| `colors` | `[{name, value: "#rgb"\|"#rrggbb"}]` | When absent or empty, **color checks are skipped entirely**. |
| `spacing` | `[{name, value: number ≥ 0}]` | When absent, `divi/approved-tokens` falls back to the FigmaKit `SPACING_SCALE` (option `useFigmaKitSpacingScale`). |
| `typography` | `[{name, fontSize > 0, fontFamily?, fontWeight?, lineHeight?}]` | `lineHeight` is validated but **not enforced** by any rule. |
| `fontFamilies` | string[] | Allowed font families (case-insensitive compare). |

### 6.4 Example (approved, populated)

```json
{
  "version": "1.0.0",
  "designSystem": "Divi 5",
  "status": "approved",
  "components": [
    {
      "id": "divi-section", "name": "Divi Section", "diviType": "et_pb_section",
      "figmaComponentKeys": ["3f1c0e9d2b7a4c55e0a1b2c3d4e5f60718293a4b"],
      "allowedChildren": ["divi-row"], "allowedParents": ["$root"], "governsChildren": true,
      "match": { "namePatterns": ["^(divi[-_ ]?)?section$"], "roles": ["section"] }
    },
    {
      "id": "divi-row", "name": "Divi Row", "diviType": "et_pb_row",
      "figmaComponentKeys": ["8a2b…"], "allowedChildren": ["divi-column"],
      "allowedParents": ["divi-section"], "governsChildren": true,
      "match": { "namePatterns": ["^(divi[-_ ]?)?row$"], "roles": ["row"] }
    },
    {
      "id": "divi-column", "name": "Divi Column", "diviType": "et_pb_column",
      "figmaComponentKeys": ["c41d…"], "allowedChildren": ["divi-button"],
      "allowedParents": ["divi-row"], "governsChildren": true,
      "match": { "namePatterns": ["^(divi[-_ ]?)?(column|col)$"], "roles": ["column"] }
    },
    {
      "id": "divi-button", "name": "Divi Button", "diviType": "et_pb_button",
      "figmaComponentKeys": ["<component-set key>", "<Primary variant key>", "<Secondary variant key>"],
      "requiresAutoLayout": { "direction": "HORIZONTAL" },
      "requiredProperties": [{ "name": "Type", "allowedValues": ["Primary", "Secondary"] }],
      "namingPattern": "^[A-Z]",
      "match": { "namePatterns": ["^(divi[-_ ]?)?(button|btn)$"], "roles": ["button"] }
    }
  ],
  "tokens": {
    "spacing": [{ "name": "md", "value": 24 }, { "name": "lg", "value": 32 }],
    "colors": [{ "name": "brand", "value": "#4f46e5" }, { "name": "ink", "value": "#111111" }],
    "typography": [{ "name": "body", "fontSize": 16, "fontWeight": 400 }],
    "fontFamilies": ["Inter"]
  }
}
```

**Why the variant keys are listed too.** For instances, the snapshot resolves both the variant key and
its component-set key, so listing only the set key is enough. For a **detached library** copy, Figma's
`detachedInfo` only gives the variant's `componentKey`. The plugin does not resolve that to a set key.
List the variant keys as well if you want detached copies of library components to be recognized as
`detached-approved`. Local detaches (`detachedInfo.type === "local"`) are resolved to both keys. The registry helper
(Settings → "Generate registry entries from selection") writes the set key followed by every variant key
it can read from the set; when a set's variants are not readable it writes only the set key, and the
variant keys must be added by hand (see [FIGMA_INSTALLATION.md §4.1](./FIGMA_INSTALLATION.md#41-generate-entries-from-the-library)).

### 6.5 The bundled registry

`src/standards/registry.json` is an **illustrative draft**: version `0.1.0`, `status: "draft"`, and
eight components (`divi-section`, `-row`, `-column`, `-button`, `-text`, `-image`, `-blurb`, `-cta`) with
real Divi slugs (`et_pb_*`). It has **placeholder keys only**, no nesting, no required properties and no
naming patterns. It has `match` hints and spacing tokens equal to `SPACING_SCALE`, and no colors or
typography. With the default readiness policy (`requireApprovedRegistry: true`), the bundled registry can
**never** produce READY. This is intentional.

---

## 7. Config format

`LintConfig` (bundled file: `src/standards/figmakit.config.json`):

```json
{
  "extends": ["figmakit:recommended"],
  "rulesetVersion": "1.0.0",
  "registryVersion": ">=0.1.0 <2.0.0",
  "rules": {
    "divi/approved-tokens": ["warning", { "snapTolerance": 1 }],
    "divi/component-naming": "off",
    "divi/approved-component": ["error", { "ignoreComponentNamePatterns": ["^Icon/"] }]
  },
  "settings":   { "includeHidden": false, "checkInstanceInternals": false, "governTopLevel": false, "maxIssuesPerRule": 500 },
  "readiness":  { "blockingSeverities": ["error"], "blockingRules": [], "requireApprovedRegistry": true, "setDevStatus": false },
  "exceptions": { "enabled": true, "nonExemptRules": [], "allowedApprovers": [], "requireReason": true }
}
```

| Field | Meaning |
|---|---|
| `extends` | Preset names applied in order. Unknown names give error `unknown-preset`. |
| `rulesetVersion` | Version of *your* organizational ruleset. Recorded in reports. Missing from config and presets gives warning `missing-ruleset-version` and the value `0.0.0`. |
| `registryVersion` | Semver range the registry `version` must satisfy. Supports exact, `^`, `~`, `>=`/`>`/`<`/`<=`, `1.x`/`*`, space-separated AND, and `||`. An invalid range is error `invalid-registry-range`. A registry outside the range gives error `incompatible-registry` from `checkRegistryCompatibility()` (the caller adds it to config diagnostics). |
| `rules` | `{ "<rule id>": setting }`. A setting is a severity, `[severity]` or `[severity, options]`. Severities: `"off"`/`0`, `"info"`, `"warn"`/`"warning"`/`1`, `"error"`/`2`. Unknown rule id gives error `unknown-rule`. An invalid severity gives error `invalid-severity` and the rule keeps its previous value. |
| `settings` | See table below. |
| `readiness` | `blockingSeverities` (`["error"]`), `blockingRules` (`[]`), `requireApprovedRegistry` (`true`), `setDevStatus` (`false`). |
| `exceptions` | `enabled` (`true`), `nonExemptRules` (`[]`), `allowedApprovers` (Figma user ids, `[]` = anyone), `requireReason` (`true`). |

`settings` (`DEFAULT_SETTINGS`):

| Setting | Default | Effect |
|---|---|---|
| `includeHidden` | `false` | Hidden layers and their subtrees are skipped by the snapshot and the engine. |
| `checkInstanceInternals` | `false` | Layers inside instances are skipped by rules (`context.isInstanceInternal`). Exception: nested **INSTANCE** nodes are still checked by `approved-component`, `valid-nesting` and `required-states` (option `checkNestedInstances`), except the library's own unchanged sub-instances (`DesignNode.nestedInstanceOrigin === 'library'`); an unresolved origin (`'unknown'`) downgrades findings to `requires-review`. |
| `governTopLevel` | `false` | When true, the scope roots act as a governed context, so unapproved instances with no registered ancestor are flagged. |
| `maxIssuesPerRule` | `500` | Integer ≥ 1 (0 or less is an `invalid-settings` config error). **Non-blocking** issues beyond the cap are counted in `RuleSummary.truncatedCount` but not materialized. Blocking issues are never truncated, so the cap can never make readiness pass. |

Each section (`settings`, `readiness`, `exceptions`) is shallow-merged key by key over the defaults,
presets first, then config. Invalid values give an `invalid-<section>` error and the key is ignored.
Unknown keys give an `info` diagnostic.

### 7.1 Presets

| Rule | `figmakit:recommended` | `figmakit:strict` |
|---|---|---|
| `divi/approved-component` | error | error |
| `divi/approved-tokens` | warning | error |
| `divi/auto-layout` | warning | error |
| `divi/component-naming` | warning | error |
| `divi/detached-component` | error | error + `{ certaintySeverity: { likely: "error", "requires-review": "warning" }, reportStructureOnly: true }` |
| `divi/required-states` | error | error |
| `divi/semantic-mapping` | warning | error + `{ minConfidence: 70 }` |
| `divi/valid-nesting` | error | error |
| settings | — | `governTopLevel: true` |
| `rulesetVersion` | `1.0.0` | `1.0.0` |

A rule that is not mentioned anywhere (for example a new rule you add) is **enabled at its
`meta.defaultSeverity`** with its `defaultOptions`.

### 7.2 Merge order (and a deviation from ESLint)

```
rule meta (defaultSeverity, defaultOptions)
  → extends[0] → extends[1] → …       (presets, in order)
  → config.rules / settings / readiness / exceptions
  → validateOptions() on the final options
```

- **Options are shallow-merged over the accumulated options at every layer.** If you set
  `"divi/semantic-mapping": ["error", { "stampApprovedInstances": true }]` on top of `figmakit:strict`,
  the result keeps the preset's `minConfidence: 70`. **This differs from ESLint**, where options given in
  a later config replace the earlier options array. Merging is shallow, so a nested object such as
  `certaintySeverity` is **replaced as a whole**, not deep-merged.
- A severity-only setting (`"warn"`) keeps the accumulated options (same as ESLint).
- If the final options fail the rule's `validateOptions`, the rule falls back to its `defaultOptions`
  (not the preset's) and an `invalid-options` **error** is emitted. Config errors prevent readiness.
- Preset rule ids that are not among the known rules are silently ignored. Unknown ids in *your*
  `rules` are errors.

### 7.3 Severity and certainty

Every issue has a `certainty`:

| Certainty | Meaning |
|---|---|
| `confirmed` | Provable from Figma data (instance key not in the registry, `detachedInfo` present, a property value). |
| `likely` | Two or more independent heuristic signals agree. |
| `requires-review` | A single weak signal. A human must decide. |

Effective severity = `report.severity` if the rule set one explicitly. Otherwise it is
`severityForCertainty(configuredSeverity, certainty, options.certaintySeverity)`:

| Certainty | Default mapping |
|---|---|
| confirmed | `inherit` (the configured severity) |
| likely | `warning` |
| requires-review | `info` |

The result is **clamped**: it is never more severe than the configured severity. For example,
`likely → error` on a rule configured as `warning` gives `warning`. Any rule may receive a
`certaintySeverity` option, which the engine reads for all rules, but only `divi/detached-component`
declares and validates it. Two codes force their severity regardless of config: `detached-unregistered`
and `missing-divi-metadata` are always `info`.

---

## 8. Issue ids and other identifiers

| Identifier | Formula | Stability |
|---|---|---|
| Issue id | `'fk-' + fnv1a(ruleId + '|' + code + '|' + nodeId + '|' + (discriminator ?? ''))` | Stable across runs while the Figma node id is unchanged. Duplicating or copy-pasting a layer gives it a new node id, so its issues get new ids. The engine dedupes on the full `(ruleId, code, nodeId, discriminator)` tuple, never on the 32-bit hash: if two distinct issues hash to the same id, the later one (in deterministic run order) gets the suffix `-2` (`-3`, …) and both are reported. |
| Exception id | `'ex-' + fnv1a(ruleId|nodeId|code|createdAt)` | Fixed at creation. |
| `configHash` | `fnv1a(stableStringify(ResolvedConfig))` | Changes whenever any resolved setting or option changes. |
| `contentHash` | `fnv1a(stableStringify(report without contentHash))` | Integrity checksum only. See HANDOFF_VALIDATION. |

`fnv1a` is 32-bit FNV-1a, written as 8 hex characters. It is **not cryptographic**. Collisions can be
constructed on purpose. `stableStringify` sorts object keys recursively, keeps array order, and omits
`undefined` values. Within one run, an issue whose id duplicates an earlier one is dropped (first wins).
Rules use `discriminator` to keep several issues on one node distinct. Examples: the spacing property
(`paddingTop`), the paint (`fills:0`), the property name, and `component` / `global`.

---

## 9. Readiness algorithm (summary)

`evaluateReadiness()` returns **NOT_READY** if **any** of the following holds. Reasons are listed in this
order:

1. `nodeCount === 0`: nothing was validated.
2. Any config diagnostic at level `error`. This includes `incompatible-registry` when the caller adds it.
3. The registry could not be loaded (`index === null`) or has `error` diagnostics.
4. `readiness.requireApprovedRegistry` and (registry `status !== "approved"` **or** any placeholder key).
5. Any rule `crashed`.
6. Any `internal/rule-error` issue.
7. Any blocking issue that is not covered by a policy-permitted exception.

An issue is *blocking* when `ruleId === "internal/rule-error"`, **or** its severity is in
`blockingSeverities`, **or** its rule is in `blockingRules` and its severity is not `info`.

When the result is ready and at least one blocking issue was excepted, the status is
**READY_WITH_EXCEPTIONS**. Otherwise it is **READY**. The details, including the exceptions workflow, are
in [HANDOFF_VALIDATION.md](./HANDOFF_VALIDATION.md).

---

## 10. Persistence keys

| Where | API | Namespace / key | Content | Who can read / write |
|---|---|---|---|---|
| Document root | `figma.root.setSharedPluginData` | `figmakit_standards` / `config` | `LintConfig` JSON (document override; empty = use bundled) | Any plugin that knows the namespace. Also the REST API with `plugin_data=shared`. |
| Document root | same | `figmakit_standards` / `registry` | `ComponentRegistry` JSON (document override) | same |
| Document root | same | `figmakit_standards` / `exceptions` | `IssueException[]` JSON | same |
| Document root | same | `figmakit_standards` / `readiness` | Last "Mark Ready" record `{status, validatedAt, validatedBy, rulesetVersion, registryVersion, scope, contentHash, issueCountSummary}` | same |
| Node | `node.setPluginData` (private to this plugin id) | `fk-type` | Existing FigmaKit label (labeler) | This plugin id only. REST API with `plugin_data=<plugin id>`. |
| Node | same | `fk-standards-component` | Declared registry component id (metadata mapping) | same |
| Node | same | `fk-divi-type` | Divi module slug stamped from the registry | same |

Constants live in `src/lint/types.ts` (`STANDARDS_SHARED_NAMESPACE`, `STANDARDS_DOC_KEYS`,
`STANDARDS_PLUGIN_DATA_KEYS`). Private `pluginData` is scoped to the manifest `id`
(`1620233172828880582`). If you publish under a different plugin id, node-level data written by the
development build is no longer visible.

If a stored override is corrupt JSON, the controller (`loadStandards`) reports an `invalid-json` error
diagnostic and readiness is denied. It never silently uses the bundled file in place of a broken override:

- **Registry:** there is no registry for the run. Rules run against an empty registry, so there are no
  identities, and the reason "Component registry could not be loaded." is shown.
- **Config:** the bundled config is used *only* so that issues can still be displayed. The `invalid-json`
  config error keeps the result NOT_READY.
- **Exceptions:** malformed entries (or a corrupt array) are dropped and reported in
  `diagnostics.exceptions`. The affected issues stay unexcepted, so this fails closed.

---

## 11. Determinism guarantees

Given the same `DesignNode[]`, `ResolvedConfig`, registry, exceptions and `now`, `runLint` returns
byte-identical issues (ids, order, messages, data):

- Rules run in id order (`ALL_RULES` is sorted; the engine re-sorts and dedupes).
- Nodes are visited in pre-order and sorted by `DesignNode.order`, a global pre-order counter assigned by
  the snapshot.
- Issues are sorted by `(node.order, ruleId, code, id)`.
- Registry lookups (`candidatesForRole`, `candidatesForName`) return results sorted by component id.
  Recreation candidates are sorted by signal count, then id.
- The snapshot reads object-keyed Figma data (`componentProperties`, `variantProperties`,
  `boundVariables`) with sorted keys.
- No rule or engine code reads the clock or random sources. `now` only affects exception expiry. When
  `now` is omitted, exceptions with an `expiresAt` are treated as **inactive** (fail closed).

Not guaranteed: the snapshot itself depends on the live document (layer order, resolved components,
library availability). Two exports of the same file also differ in `validatedAt`, and therefore in
`contentHash`.

---

## 12. Controller message protocol (UI ↔ main)

All Standards messages have `type` starting with `standards-`. Every handler catches errors and replies
`standards-toast {level:'error', message}`. No handler reports readiness as true after an error.

| UI → main | Reply | Notes |
|---|---|---|
| `standards-init` | `standards-state` | design system, versions, registry/config **source** (`document`/`bundled`), rules (id, description, severity, fixable, category, docs), exceptions, current user. |
| `standards-run` | `standards-progress`*, `standards-result` | A snapshot failure gives NOT_READY with a synthetic internal error. |
| `standards-select {nodeId}` | — / `standards-toast` | `getNodeByIdAsync`. Switches page with `setCurrentPageAsync` if needed, selects the node and scrolls to it. |
| `standards-fix-preview {mode, issueIds?}` | `standards-fix-preview {mode, operations: [{issueId, kind, description, key}], skipped, requiresConfirmation}` | `planFixes` + `describeOperation`. `key` = `issueId + '|' + description`. |
| `standards-apply-fixes {mode, issueIds?, confirmed, expectedOperations?}` | `standards-fix-result {applied, failed, skipped}`, `standards-result` | `REQUIRES_CONFIRMATION` ops require `mode: 'selected'` with `confirmed: true` **and** `expectedOperations` equal to the previewed operation `key`s; if the plan changed since the preview (e.g. a re-run changed the value under the same issue id) or either is missing, the reply is `standards-fix-result {refused: true, reason}` plus an error toast, and nothing is applied or re-run. The apply is wrapped in `figma.commitUndo()` calls so it is exactly one undo step. Validation re-runs automatically after an apply. |
| `standards-export {rerun?, scope?}` | (`standards-progress`*, `standards-result` when it re-runs), `standards-export {filename, json, contentHash}` | `figmakit-standards-report-<yyyy-mm-dd>.json`. Uses the **last run**; re-validates first when there is none or when the UI sends `rerun: true` (its results are marked out of date). A re-run validates `scope` (the last result's scope, sent by the UI) when it still resolves, otherwise the live selection / page. |
| `standards-mark-ready {scope?}` | `standards-mark-ready-result {ok, status, reasons \| contentHash, record, devStatusSet, message}` | Always re-validates first — the `scope` the UI sends (the scope of the results the user saw), so click-to-select cannot narrow it. If any root of that scope no longer exists, it is denied. Without `scope`, the live selection / page is used. |
| `standards-add-exception {issueId, reason, expiresAt?}` / `standards-remove-exception {exceptionId}` | `standards-toast`, `standards-result`, `standards-state` | Policy-checked, persisted, then re-run. |
| `standards-get-config` / `standards-save-config {configJson?, registryJson?}` / `standards-reset-config {target}` | `standards-config`, `standards-config-saved {ok, diagnostics}`, `standards-state` | Save validates with `resolveConfig` / `validateRegistry` / `checkRegistryCompatibility`. Error diagnostics block saving. Save and reset discard the last run. |
| `standards-registry-helper` | `standards-registry-helper {entries, json}` | Builds registry skeletons from selected COMPONENT / COMPONENT_SET / INSTANCE nodes (walks into frames, max 5000 nodes, not into instances or sets). For variants writes the set key, then each readable variant key (`entries[].variantKeys`). |
| `standards-verify-registry` | `standards-verify-registry {ok, resolved, unresolved, placeholders, note}` (or `{ok:false, …, diagnostics}` + error toast when the registry itself is invalid) | `importComponentByKeyAsync`, falling back to `importComponentSetByKeyAsync`. Placeholder keys are listed, not imported, and make `ok` false. |

---

## 13. Adding a new rule

1. **Create the rule file** `src/lint/rules/<name>.ts`. The rule must be pure: no Figma API, no clock,
   no mutation of its inputs.

   ```ts
   import type { DesignNode, LintContext, LintRule, RuleReport } from '../types';

   export const RULE_ID = 'divi/max-depth';

   function validateOptions(options: Record<string, unknown>): string[] {
     const v = options.maxDepth;
     return v === undefined || (typeof v === 'number' && isFinite(v) && v >= 1)
       ? []
       : ['"maxDepth" must be a number >= 1'];
   }

   export const rule: LintRule = {
     meta: {
       id: RULE_ID,
       description: 'Registered components must not be nested deeper than maxDepth.',
       docs: 'Evidence, codes, certainty, options, limitations, autofix…',  // shown in the UI; copy into RULES.md
       category: 'structure',
       defaultSeverity: 'warning',
       defaultOptions: { maxDepth: 8 },
       fixable: false,
       validateOptions,
     },

     appliesTo(node: DesignNode, context: LintContext): boolean {
       // Counted as a "check". Skip instance internals unless you have a reason not to.
       return !context.isInstanceInternal(node) && context.getRegistryMatch(node) !== null;
     },

     validate(node: DesignNode, context: LintContext): RuleReport[] {
       const max = context.options.maxDepth as number;
       if (node.depth <= max) return [];
       return [{
         code: 'too-deep',
         certainty: 'confirmed',               // default; use 'likely' / 'requires-review' for heuristics
         message: `Nested ${node.depth} levels deep (max ${max}).`,
         suggestion: 'Flatten the structure.',
         expected: `<= ${max}`,
         actual: String(node.depth),
         fix: { kind: 'UNSUPPORTED', description: 'Restructure manually.', operations: [] },
         // discriminator: '…'  // only when one node can produce several issues with this code
       }];
     },
   };
   ```

   Conventions: return `[]` when the check passes, so it counts as a passed check. Do not set `severity`
   unless the code must always be a fixed level. Express uncertainty through `certainty`. Messages must be
   short, deterministic and must not contain timestamps. A fix may only use the whitelisted
   `FixOperation`s (`rename`, `setPluginData` on `fk-type`/`fk-standards-component`/`fk-divi-type`,
   `setNumber` on padding/itemSpacing, `setSolidPaintColor`). Use `SAFE` only when the change is
   non-visual (names, metadata). Use `REQUIRES_CONFIRMATION` for any visual change.

2. **Register it** in `src/lint/rules/index.ts` (import and add to the `ALL_RULES` array).

3. **Presets (optional).** To give the rule a non-default severity in a preset, add it to the presets
   in `src/lint/config.ts`. If the strict preset should cover it, also add it to `PRESET_RULE_IDS`, which
   drives `allError()`. A rule left out of the presets runs at its `defaultSeverity`.

4. **If the rule needs new snapshot data**, add an *optional* field to `DesignNode` in `types.ts` and
   populate it in `snapshot.ts#buildNode`. Read it defensively with try/catch, `safeGet*` and async APIs
   only. Update `tests/lint/helpers.ts#node()` defaults if necessary.

5. **Test** `tests/lint/rules/<name>.test.ts`:

   ```ts
   import { describe, it, expect } from 'vitest';
   import { rule } from '../../../src/lint/rules/max-depth';
   import { node, instanceOf, lint } from '../helpers';

   const ID = 'divi/max-depth';
   const run = (roots: any[], options?: Record<string, unknown>) => {
     const out = lint(roots, {
       rules: [rule],
       config: { extends: ['figmakit:recommended'], rulesetVersion: '1.0.0',
                 rules: options ? { [ID]: ['warning', options] } : {} },
     });
     return { ...out, issues: out.result.issues.filter((i) => i.ruleId === ID) };
   };

   describe(ID, () => {
     it('validates options', () => {
       expect(rule.meta.validateOptions!({ maxDepth: 0 })).toHaveLength(1);
     });
     it('passes shallow components', () => {
       expect(run([instanceOf('key-button', { name: 'Button' })]).issues).toEqual([]);
     });
     it('flags deep components', () => {
       const deep = node({ name: 'A', children: [node({ name: 'B', children: [
         instanceOf('key-button', { name: 'Button' })] })] });
       const out = run([deep], { maxDepth: 1 });
       expect(out.issues.map((i) => i.code)).toEqual(['too-deep']);
       expect(out.issues[0].severity).toBe('warning');
     });
   });
   ```

   `lint()` uses `testRegistry()` (an approved, fully keyed registry: keys `key-section`, `key-row`,
   `key-column`, `key-button` / set `set-button`, `key-text`, `key-image`, `key-blurb`) unless you pass
   `registry`. `makeContext()` builds a `LintContext` for calling `appliesTo` / `validate` directly.

6. **Document it** with a section in [RULES.md](./RULES.md) (copy from `meta.docs`).

7. Run `npm test && npm run typecheck && npm run build`.

---

## 14. Updating organizational standards without code changes

There are two mechanisms. They have very different trust and reach properties.

| | Document override (no rebuild) | Bundled JSON (rebuild + redistribute) |
|---|---|---|
| Where | `figma.root` shared plugin data `figmakit_standards/config` and `/registry`, edited in **Standards → Settings** (Config JSON / Registry JSON → Save) | `src/standards/figmakit.config.json`, `src/standards/registry.json` |
| Reach | **That one file only** | Every file opened with that build of the plugin |
| Who can change it | Anyone with edit access to the file, including through other plugins that use the same namespace | Whoever builds and publishes the plugin |
| Validation | `validateRegistry` / `resolveConfig` on save. Error diagnostics block the save. | Same validation at run time. A broken bundled file shows up as diagnostics and NOT_READY. |
| Shown in UI as | `source: document` | `source: bundled` |
| Revert | Settings → Reset config / Reset registry / Reset all (writes an empty string, so the bundled file is used again) | Rebuild |

Recommended process for an organization:

1. Keep the canonical `registry.json` and `figmakit.config.json` under version control. Bump
   `registry.version` (semver) and `config.rulesetVersion` whenever the standards change. Keep
   `registryVersion` in the config compatible with the registry (the bundled range is
   `>=0.1.0 <2.0.0`; widen it before releasing a 2.x registry).
2. Rebuild (`npm run build`) and redistribute the plugin (private org plugin, see
   [FIGMA_INSTALLATION.md §6](./FIGMA_INSTALLATION.md#6-distributing-to-an-organization)).
3. Use document overrides for piloting a change on one file, or for project-specific exceptions. Treat
   a document override as **unverified**: the report records only the resulting versions and
   `configHash`, not where they came from. A server-side validator should use its own copy of the
   standards (see HANDOFF_VALIDATION §8).

Changes that need **no code** (registry or config only): adding or removing approved components and keys,
nesting constraints, required properties, naming patterns, tokens, rule severities and options, presets
via `extends`, readiness and exception policy. Changes that **need code**: new rules, new fix operation
types, new snapshot data, new presets.

---

## 15. Pre-existing issues fixed while integrating

`npm run typecheck` failed before this work. These were fixed with minimal, behavior-neutral edits:

| File | Problem | Fix |
|---|---|---|
| `tsconfig.json` | `typeRoots` listed `./node_modules/@figma/plugin-typings`. That is a *package*, not a directory of type packages, so the Figma globals did not resolve as intended. | `typeRoots: ["./node_modules/@figma", "./node_modules/@types"]`. Also added `resolveJsonModule: true` for the bundled standards JSON. |
| `src/features/renamer.ts` | Comparisons that TypeScript flagged as impossible after narrowing (`role === 'background-shape'`, `'container'`, TS2367), and `suggested && …` (type `string \| null \| boolean`) used as a boolean. | `(role as NodeRole)` casts and `!!(…)`. No logic change. |
| `src/ui.ts` | `var si` was reused: a numeric loop index in one block and an issue object in another (function-scoped `var`). | Renamed the second variable to `spIssue`. |
| `src/main.ts` | `parent.children.indexOf` / `parent.insertChild` on `BaseNode & ChildrenMixin` typing in the flatten path. | `(parent as any)` casts. No logic change. |
| `src/features/color-checker.ts` | `parseColorToRGB` / `colorDistance` were private. | Exported (additive). |

`npm run typecheck` only checks `src/` (tests are excluded in `tsconfig.json`). Vitest does not type-check
tests.
