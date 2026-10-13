# FigmaKit Standards — Rule Reference

This reference was generated from the rule metadata in `src/lint/rules/*.ts` (`meta`, `defaultOptions`)
and the resolved presets in `src/lint/config.ts`, then checked against each rule's `appliesTo` /
`validate` code. The UI shows the same `meta.docs` text in Standards → Settings.

**Conventions used below**

- *Severity* is the configured severity. The effective severity of an issue is then derived from its
  **certainty** (default mapping: confirmed → configured, likely → warning, requires-review → info), and
  is never more severe than the configured severity. See [ARCHITECTURE.md §7.3](./ARCHITECTURE.md#73-severity-and-certainty).
- *Blocking* (default policy) means effective severity `error`.
- *Registered* means the layer has a registry identity. The lookup order (`context.getRegistryMatch`) is:
  1. an **INSTANCE** whose main-component key or component-set key is in `figmaComponentKeys`
     (source `instance`);
  2. a frame whose Figma `detachedInfo` resolves to a registered key (source `detached`);
  3. a layer with plugin data `fk-standards-component = <id>` where that component has
     `allowMetadataMapping: true` (source `metadata`).
- *Instance internals*: layers inside a component instance. They are skipped by every rule unless
  `settings.checkInstanceInternals` is true, with one exception: nested **INSTANCE** nodes (swaps and
  slots) are still checked by `divi/approved-component`, `divi/valid-nesting` and `divi/required-states`
  while `checkNestedInstances` is true (the default). The snapshot records each nested instance's origin
  (`DesignNode.nestedInstanceOrigin`) by comparing it with its counterpart in the enclosing instance's
  main component (Figma ids `I<instance>;<id in main component>`): `library` (the library's own
  sub-instance, unchanged) is **never** reported, `override` (swapped / variant changed / slot content) is
  checked normally, and `unknown` (could not be resolved) is reported as `requires-review` (non-blocking
  by default).
- Hidden layers are skipped unless `settings.includeHidden`.

| Rule | Category | recommended | strict | Autofix |
|---|---|---|---|---|
| [`divi/approved-component`](#diviapproved-component) | components | error | error | none |
| [`divi/approved-tokens`](#diviapproved-tokens) | tokens | warning | error | confirm (spacing, color) |
| [`divi/auto-layout`](#diviauto-layout) | layout | warning | error | none |
| [`divi/component-naming`](#divicomponent-naming) | naming | warning | error | safe / confirm (rename) |
| [`divi/detached-component`](#dividetached-component) | components | error | error (+ options) | none |
| [`divi/required-states`](#direquired-states) | components | error | error | none |
| [`divi/semantic-mapping`](#divisemantic-mapping) | structure | warning | error (+ `minConfidence: 70`) | confirm (metadata) / safe (Divi stamp) |
| [`divi/valid-nesting`](#divivalid-nesting) | structure | error | error | none |
| [`internal/rule-error`](#internalrule-error) | — | always error, blocking | same | none |

The strict preset also sets `settings.governTopLevel: true`. This affects `divi/approved-component`.

---

## `divi/approved-component`

**Checks:** Component instances must come from the approved component registry.

| | |
|---|---|
| Default severity | `error` (recommended `error`, strict `error`) |
| Applies to | `INSTANCE` nodes. Includes instances nested inside other instances unless `checkNestedInstances: false`. |
| Fixable | No |

**Evidence and codes**

| Code | Certainty | Effective severity (recommended) | When |
|---|---|---|---|
| `unapproved-instance` | confirmed | error | Main component key and component-set key are both missing from the registry, the instance is in a **governed context** (or `scope: "everywhere"`), and it is not allowed by `allowedComponentKeys` or `ignoreComponentNamePatterns`. |
| `deprecated-component` | confirmed | error | The instance matches a registry component that has `deprecated`. Reported in any context. Suggests `replacedBy`. |
| `unresolved-main-component` | requires-review | **info** (not blocking) | `getMainComponentAsync()` returned nothing (deleted component, library not available). Reported in any context. |

A **governed context** exists when the nearest registered ancestor has `governsChildren: true`. If there
is no registered ancestor, the context is governed only when `settings.governTopLevel` is true (strict
preset).

Only the component key can approve an instance. An instance that declares an identity through
`fk-standards-component` metadata is still checked as unapproved.

**Options**

| Option | Default | Meaning |
|---|---|---|
| `scope` | `"governed"` | `"everywhere"` checks every instance regardless of governance. |
| `allowedComponentKeys` | `[]` | Extra component or component-set keys accepted without a registry entry (e.g. an icon library). |
| `ignoreComponentNamePatterns` | `[]` | Regexes (case-insensitive) tested against the main-component name and the component-set name. |
| `checkNestedInstances` | `true` | Also check instances nested inside other instances (except the library's own unchanged sub-instances). |

**Examples**

Assume Section/Row/Column have `governsChildren: true`.

- ✕ A "Card" instance from a personal library placed inside a **Divi Column** instance's slot →
  `unapproved-instance` ("\"Card\" is not an approved component."). The suggestion comes from registry
  `match` hints, for example "Use approved Divi Blurb component." when the role matches.
- ✕ An instance of `divi-button-legacy` (`deprecated: { replacedBy: "divi-button" }`) →
  `deprecated-component`.
- ✓ A Divi Button instance whose set key is listed in the registry.
- ✓ An unregistered "Logo" instance directly on a top-level frame with the recommended preset: there is
  no registered ancestor and `governTopLevel` is false. With **strict** it is reported.
- ✓ An unregistered icon instance *inside* a Divi Button instance: Button does not govern children.

**Limitations**

- Sub-components that your **library** built into a governing component (for example a Divider
  instance inside the Section component) are not reported as long as they still use the main component
  they have in the library. If their origin cannot be resolved (`nestedInstanceOrigin: "unknown"`) they
  are reported as `requires-review` (info, non-blocking). To silence those, register them, add their keys
  to `allowedComponentKeys`, match them with `ignoreComponentNamePatterns`, or set
  `checkNestedInstances: false`.
- Ordinary (non-instance) layers inside instances are never checked unless `checkInstanceInternals`.
- An `unresolved-main-component` issue does not block with the default mapping. If missing libraries
  must block, configure
  `"divi/approved-component": ["error", { "certaintySeverity": { "requires-review": "error" } }]`.
  The engine honors `certaintySeverity` for every rule. This rule does not validate that option, but it
  does not reject it either.

---

## `divi/valid-nesting`

**Checks:** Registered components must follow the registry nesting constraints.

| | |
|---|---|
| Default severity | `error` (recommended `error`, strict `error`) |
| Applies to | Registered layers. Nested INSTANCE nodes inside instances are included while `checkNestedInstances` is true. |
| Fixable | No |

**Evidence:** the layer's registry identity and its **nearest registered ancestor**. Unregistered wrapper
frames between them are ignored, so auto-layout wrappers never cause violations. The rule only reads
`allowedChildren` (on the parent) and `allowedParents` (on the child). `"$root"` in `allowedParents`
means "no registered ancestor within the validated scope".

| Code | Certainty | When |
|---|---|---|
| `invalid-child` | confirmed (likely if either identity comes from metadata) | The parent's `allowedChildren` is defined and does not list this component. |
| `invalid-parent` | same | This component's `allowedParents` is defined and does not list the parent's id (or `$root`). |

If both constraints are violated, both issues are reported. With `likely` certainty, the effective
severity drops to `warning` under the default mapping.

**Partial selections:** when no registered ancestor is in scope and the scope root is *not* directly on the
page (or inside a Figma SECTION), what lies above it is unknown. `invalid-parent` is then **not**
reported. The snapshot sets `DesignNode.scopeRootIsTopLevel` for this case.

**Options:** `checkNestedInstances` (default `true`). Library-owned, unchanged sub-instances are never
checked; nested instances with an unresolved origin are reported as `requires-review`.

**Examples** (Section → [Row], Row → [Column], Column → [Button]; Row.allowedParents = [Section];
Section.allowedParents = [`$root`])

- ✕ A Button instance swapped into a Row in place of its Column → `invalid-child` ("Divi Button is not
  allowed inside Divi Row.", expected "Divi Column"). If Button also has `allowedParents: ["divi-column"]`,
  `invalid-parent` is reported as well.
- ✕ A Row instance placed directly on a top-level frame, with the page validated → `invalid-parent`
  (actual `$root`).
- ✓ Section › (plain auto-layout wrapper) › Row: the wrapper is ignored.
- ✓ Any nesting of components that have no `allowedChildren` / `allowedParents`. The bundled draft
  registry defines none, so this rule is silent with it.
- ✓ Validating only a selected Row that sits inside an unregistered frame: placement is unknown, so
  nothing is reported.

**Limitations:** constraints come only from the registry. Content in instance slots is visible only as
nested **instances**. Plain frames inside an instance are not checked unless `checkInstanceInternals`.

---

## `divi/detached-component`

**Checks:** Approved components must be used as instances, not detached or recreated by hand.

| | |
|---|---|
| Default severity | `error` (recommended `error`, strict `error` with options below) |
| Applies to | Layers that are not instance internals and are not `INSTANCE` / `COMPONENT` / `COMPONENT_SET`: any layer with `detachedInfo`, plus `FRAME` and `GROUP` layers for the heuristics. |
| Fixable | No (fix descriptors are `UNSUPPORTED`) |

**Evidence**

- **Confirmed:** Figma's `FrameNode.detachedInfo`. `library` gives the variant `componentKey`; the
  snapshot resolves its component-set key with `figma.importComponentByKeyAsync` (cached per key; `null`
  when unpublished / offline). `local` gives the local `componentId`, which the snapshot resolves to the
  key and component-set key via `getNodeByIdAsync`. Both the variant key and the set key are matched
  against the registry.
- **Heuristic** (no `detachedInfo`), per registry component:
  - *name*: the layer base name matches `match.namePatterns` or equals the component `name`
    (case-insensitive);
  - *structure*: the **name-blind** classifier role is in `match.roles` with confidence ≥
    `minStructuralConfidence`;
  - *label*: the explicit FigmaKit label (`[fk:role]` / `fk-type`) is in `match.roles`.

| Code | Certainty | Effective severity (recommended / strict) | When |
|---|---|---|---|
| `detached-approved` | confirmed | error / error | `detachedInfo` resolves to a registry component. |
| `detached-unregistered` | confirmed | **info always** | `detachedInfo` present but not in the registry (only if `reportUnregisteredDetached`). |
| `recreated-component` | likely | warning / error | Two or more signals. |
| `recreated-component` | requires-review | info / warning | Exactly one *name* or *label* signal. A structure-only match is reported only with `reportStructureOnly` (strict). |

Messages for heuristic findings say so: "Looks like a manually recreated Divi Button (heuristic;
evidence: name, structure)." `data.evidence` lists the signals and `data.alternatives` lists other
candidates.

**False-positive guards**

- A layer that contains registered components is treated as a composition. It is skipped unless the
  *name* signal fires.
- A layer that legitimately declares that component via allowed metadata is skipped.

**Options**

| Option | Default | Strict |
|---|---|---|
| `minStructuralConfidence` | `80` | `80` |
| `reportStructureOnly` | `false` | `true` |
| `reportUnregisteredDetached` | `true` | `true` |
| `certaintySeverity` | `{confirmed: "inherit", likely: "warning", "requires-review": "info"}` | `{likely: "error", "requires-review": "warning"}` (replaces the object; `confirmed` falls back to inherit) |

**Examples**

- ✕ A frame detached from a library Divi Button whose variant key is in the registry →
  `detached-approved` (error).
- ✕ A frame named "Button" with horizontal auto layout, a fill and a single text child →
  `recreated-component` (likely: name and structure, because the classifier sees button at 85).
- ✕ (info only) A frame named "Button" with no auto layout or fill → requires-review (name only).
- ✓ A frame named "CTA wrapper" that contains a Divi Button instance: no name signal, and it is a
  composition.
- ✓ A frame structurally classified as a section (≥900 px wide) with no name or label signal, under
  recommended: structure-only is not reported. Under **strict** it is reported as requires-review →
  warning, which can be noisy on wide top-level frames.

**Limitations**

- `detachedInfo` exists only for detaches that Figma recorded. Older detaches, copies pasted from other
  files, or detaches whose source component was deleted may have none. Those layers fall back to the
  heuristics.
- For library detaches, the set key is only known when `importComponentByKeyAsync` succeeds (the
  library is published and reachable). If it fails, only the **variant** key is matched; listing variant
  keys in `figmaComponentKeys` too keeps detached copies from becoming `detached-unregistered`.
- The heuristics only inspect FRAME/GROUP, so a recreated text or image *leaf* is not detected.
- The heuristic quality depends on registry `match` hints and the FigmaKit classifier.

---

## `divi/semantic-mapping`

**Checks:** Semantic blocks must map to an approved registry component.

| | |
|---|---|
| Default severity | `warning` (recommended `warning`, strict `error` with `minConfidence: 70`) |
| Applies to | Non-instance layers outside instances (component definitions skipped) that are **semantic boundaries**. Approved instances also apply when `stampApprovedInstances` is on. |
| Fixable | Yes |

A **semantic boundary** is either:

- *explicit*: `fkLabel` (from `[fk:role]` or `fk-type`) is in `boundaryRoles`; or
- *classified*: `analysis.role` is in `boundaryRoles`, `analysis.confidence ≥ minConfidence`, and
  `analysis.source !== "name"`. Name-only guesses are not boundaries.

The rule **passes** when the layer is registered, when `divi/detached-component` would report it (it has
`detachedInfo`, or a recreation candidate exists), or when it contains registered components (a
legitimate composition built from approved parts).

| Code | Certainty | Effective severity (recommended / strict) | When |
|---|---|---|---|
| `unmapped-label` | confirmed | warning / error | Explicit label and no mapping. |
| `unmapped-structure` | requires-review | info / info | Classified boundary and no mapping. |
| `missing-divi-metadata` | confirmed | **info always** | Only with `stampApprovedInstances`: an approved instance's `fk-divi-type` plugin data differs from the registry `diviType`. |

**Fixes**

- Exactly one candidate (registry `match.roles` contains the role) with `allowMetadataMapping: true` →
  `REQUIRES_CONFIRMATION`: `setPluginData fk-standards-component = <id>`. After this, the layer is
  registered via metadata.
- One candidate without metadata mapping → `UNSUPPORTED` ("Replace with an instance of …").
- Several candidates → `UNSUPPORTED` ("Ambiguous: Divi Blurb or Divi CTA").
- `missing-divi-metadata` → `SAFE`: `setPluginData fk-divi-type`. This is metadata only and makes no
  visual change.

**Options**

| Option | Default |
|---|---|
| `boundaryRoles` | `section, row, column, hero, card, cta, feature, testimonial, accordion, tabs, gallery, modal` |
| `minConfidence` | `80` (strict `70`) |
| `stampApprovedInstances` | `false` |

**Examples**

- ✕ A frame named `[fk:card] Promo` with no registered descendants → `unmapped-label`. If only
  `divi-blurb` lists `card` in `match.roles` and allows metadata mapping, the fix offered is "Declare as
  Divi Blurb".
- ✕ (info) A frame the analyzer classifies as `hero` (structure, 80) → `unmapped-structure`.
- ✓ `[fk:section] Hero` containing a Divi Row instance: a composition.
- ✓ `[fk:button] CTA`: `button` is not in `boundaryRoles`. Recreated buttons are handled by
  `divi/detached-component`.

**Limitations:** classification quality depends on the FigmaKit analyzer. Labels outside
`boundaryRoles` are ignored here.

---

## `divi/approved-tokens`

**Checks:** Spacing, colors and typography must use approved design tokens.

| | |
|---|---|
| Default severity | `warning` (recommended `warning`, strict `error`) |
| Applies to | Layers outside instances that are not labelled or classified `background-shape` / `invisible` and do not match `ignoreNamePatterns`. `INSTANCE` layers are checked for spacing and colors only with `checkInstances`. |
| Certainty | Always `confirmed`. Values are read directly from the layer. |
| Fixable | Yes (confirmation required) |

**Spacing** (`checkSpacing`): only **auto-layout** layers (`layoutMode` ≠ NONE, GRID included). Checks
`paddingTop/Right/Bottom/Left` and `itemSpacing`. `itemSpacing` is skipped on GRID layouts and when
`primaryAxisAlignItems` is `SPACE_BETWEEN` (gap "Auto"), where it has no visual effect. With
`acceptStylesAndVariables`, a padding / item spacing bound to a variable counts as approved; with it off,
such values are reported but never get a snap fix (writing a number would replace the binding).
`0` is always allowed. The allowed values are
`tokens.spacing`. If the registry has none and `useFigmaKitSpacingScale` is on, the FigmaKit scale is
used (4, 8, 12, 16, 20, 24, 32, 48, 80, 96). One issue is reported per property (discriminator =
property).

**Colors** (`checkColors`): **skipped entirely when `tokens.colors` is empty.** The bundled registry has
no colors. Visible SOLID fills and strokes with opacity > 0 are compared by exact hex against the palette.
With `acceptStylesAndVariables`, a paint bound to a variable, or a layer that uses a fill/stroke style
(including mixed styles), counts as approved. With `acceptStylesAndVariables` off, styled or
variable-bound paints are reported but their fix is `UNSUPPORTED` (a snap would detach the style /
binding).

**Typography** (`checkTypography`): TEXT layers with no text style (or any layer when
`acceptStylesAndVariables` is false). This check is skipped unless the registry defines `typography` or
`fontFamilies`. The family must be in `fontFamilies`. Size and weight (and family, if the token sets
one) must match a `typography` token. Mixed values are skipped.

| Code | Fix |
|---|---|
| `off-scale-spacing` | `REQUIRES_CONFIRMATION` `setNumber` to the nearest token when within `snapTolerance` px, otherwise `UNSUPPORTED`. |
| `unapproved-color` | `REQUIRES_CONFIRMATION` `setSolidPaintColor` to the nearest palette color when the RGB Euclidean distance (0–255 channels) ≤ `colorSnapDistance`, otherwise `UNSUPPORTED`. |
| `unapproved-font-family` | `UNSUPPORTED` |
| `unapproved-text-style` | `UNSUPPORTED` (suggests the nearest token) |

**Options**

| Option | Default | Meaning |
|---|---|---|
| `checkSpacing` / `checkColors` / `checkTypography` | `true` | Enable each check. |
| `snapTolerance` | `2` | px distance for a spacing snap fix. |
| `colorSnapDistance` | `12` | RGB distance for a color snap fix. |
| `acceptStylesAndVariables` | `true` | Styles and bound variables count as approved. |
| `useFigmaKitSpacingScale` | `true` | Fallback scale when the registry has no spacing tokens. |
| `checkInstances` | `false` | Also check spacing and colors on INSTANCE layers. |
| `ignoreNamePatterns` | `[]` | Regexes (case-insensitive) against the name or base name. |

**Examples** (spacing tokens = FigmaKit scale)

- ✕ Auto-layout frame with `paddingLeft: 23` → expected `md (24px)`. Fix (confirm): 23 → 24.
- ✕ `itemSpacing: 40` → nearest `lg (32px)`. Ties go to the smaller value. Off by 8, so no autofix.
- ✕ Fill `#4f46e6` with palette `brand #4f46e5` → fix (confirm) to `#4f46e5`.
- ✓ `padding: 0`, `itemSpacing: 24`. Non-auto-layout frames (spacing is not checked). A fill bound to a
  color variable. A text layer that uses any text style.

**Limitations:** the plugin cannot cheaply verify that a style or variable comes from the *approved*
library, so any style or variable is accepted. Gradients, image fills, opacity, line height, letter
spacing and corner radius are not checked. GRID row / column gaps and wrap spacing (`counterAxisSpacing`)
are not checked yet.

---

## `divi/auto-layout`

**Checks:** Registered components that require Auto Layout must use it.

| | |
|---|---|
| Default severity | `warning` (recommended `warning`, strict `error`) |
| Applies to | Registered layers (outside instances) whose component sets `requiresAutoLayout`, or whose id is in `requireFor`. Never arbitrary frames. |
| Certainty | `confirmed` |
| Fixable | No (`UNSUPPORTED`) |

| Code | When |
|---|---|
| `missing-auto-layout` | `layoutMode` is NONE, or GRID when a direction is required. |
| `wrong-direction` | `requiresAutoLayout.direction` is set and the layer uses the other direction. |

**Options:** `requireFor` (`[]`): extra registry component ids that require Auto Layout.

**Examples** (Button: `requiresAutoLayout: { direction: "HORIZONTAL" }`)

- ✕ A detached Divi Button whose auto layout was removed → `missing-auto-layout` ("Divi Button requires
  horizontal Auto Layout.").
- ✕ A Button instance with vertical layout → `wrong-direction`. For instances, layout comes from the
  library, so the library component needs fixing.
- ✓ A horizontal Button. Any unregistered frame without auto layout.

---

## `divi/component-naming`

**Checks:** Semantic components must have meaningful names that follow the naming convention.

| | |
|---|---|
| Default severity | `warning` (recommended `warning`, strict `error`) |
| Applies to | Registered layers outside instances, plus explicitly labelled layers when `includeUnmappedBoundaries`. Never ordinary internal layers. |
| Certainty | `confirmed` |
| Fixable | Yes |

| Code | When | Fix |
|---|---|---|
| `auto-generated-name` | Base name matches `AUTO_NAME_PATTERN` ("Frame 12", "Group 3", "Rectangle", "Instance 4"…), unless the name is the component's own name or matches its hints or pattern (e.g. a Divi Section named "Section"). | `SAFE` rename to the component `name` (the `[fk:role] ` prefix is kept) when that name satisfies every applicable pattern. Otherwise `UNSUPPORTED`. |
| `pattern-mismatch` | Base name fails the component's `namingPattern` (discriminator `component`) or the global `pattern` (discriminator `global`). Not reported when `auto-generated-name` already fired on the layer. | `REQUIRES_CONFIRMATION` rename to the component name when it satisfies the patterns. Otherwise `UNSUPPORTED`. |

`namingPattern` and `pattern` are compiled **without flags** (case-sensitive).

**Options:** `disallowAutoNames` (`true`), `pattern` (`null`), `includeUnmappedBoundaries` (`false`).

**Examples**

- ✕ A detached Divi Button layer named "Frame 12" → `auto-generated-name`, SAFE fix: rename to "Divi
  Button".
- ✕ `namingPattern: "^Btn / "` and layer "Primary" → `pattern-mismatch`, `UNSUPPORTED` (the component
  name "Divi Button" does not match the pattern either).
- ✓ "Section" on a Divi Section. "Sign-up button" on a Divi Button with no pattern.

**Limitations:** instance layers keep the main component's name by default, so `auto-generated-name`
mostly fires on detached or metadata-mapped frames.

---

## `divi/required-states`

**Checks:** Approved component instances must set required properties to allowed values.

| | |
|---|---|
| Default severity | `error` (recommended `error`, strict `error`) |
| Applies to | `INSTANCE` layers registered **by component key** (not detached, not metadata) whose component has `requiredProperties`, including nested (swapped / slotted) instances while `checkNestedInstances` is true. |
| Certainty | `confirmed` |
| Fixable | No (`UNSUPPORTED`) |

**Evidence:** `variantProperties` first, then `componentProperties` (Figma's `#id` suffixes stripped).
Booleans compare as `"true"` / `"false"`.

| Code | When |
|---|---|
| `missing-property` | The property does not exist on the instance (e.g. an outdated variant). |
| `invalid-property-value` | The value is not in `allowedValues`. Empty or absent `allowedValues` accepts any value. |

`optionalStates` are never enforced.

**Options:** none.

**Examples** (`requiredProperties: [{ name: "Type", allowedValues: ["Primary", "Secondary"] }]`)

- ✕ Button with `Type = Tertiary` → `invalid-property-value`.
- ✕ An old Button variant without a `Type` property → `missing-property`.
- ✓ `Type = Primary`.

**Options:** `checkNestedInstances` (default `true`): also check approved instances nested inside other
instances (swaps / slots). Library-owned, unchanged sub-instances are skipped; nested instances with an
unresolved origin are reported as `requires-review`.

---

## `internal/rule-error`

This is not a configurable rule. The engine emits it when a rule misbehaves, so that a broken rule can
never produce a false "ready".

| Code | When |
|---|---|
| `rule-crashed` | `appliesTo()` or `validate()` threw on a layer. Message: `Rule "<id>" crashed on this layer: <error>`. |
| `invalid-report` | `validate()` returned a non-array, or a report with a bad `code`, `certainty`, `severity`, `discriminator`, `nodeId` (not in scope) or `fix` shape. |

Properties: severity `error`, certainty `confirmed`, **always blocking**, **never exceptable** (not even
if listed in an exception), `data.failedRule` = the failing rule id. After 25 errors in one rule
(`MAX_RULE_CRASHES`), the engine stops invoking that rule for the rest of the run and its summary
status is `crashed`. Either condition makes readiness NOT_READY.
