# Handoff Validation

This document explains how FigmaKit Standards decides whether a design is **ready for development**, how
exceptions work, what the exported report contains, what "Mark Ready" does, and what a plugin running on
a designer's machine **cannot** guarantee. It ends with the design for a future trusted, server-side
handoff service.

---

## 1. Readiness algorithm

Implemented in `src/lint/readiness.ts#evaluateReadiness`. The verdict is binary. No percentage score is
computed or used.

```
input: LintRunResult (issues, ruleSummaries, diagnostics, nodeCount), ResolvedConfig, RegistryIndex | null

for each issue:
  blocking := issue.ruleId == "internal/rule-error"
              OR issue.blocking (computed by the engine)
              OR isBlocking(issue, config.readiness)
  if not blocking:            → warnings[] (when severity == warning); info is listed nowhere
  elif has exception AND rule is exemptible under config.exceptions (and not internal)
                              → exceptedIssues[]
  else                        → blockingIssues[]

reasons (in this order):
  1. nodeCount == 0                                  "Nothing was validated (no layers in scope)."
  2. config diagnostics with level error             "Configuration has N errors: <codes>."
  3. registry == null                                "Component registry could not be loaded."
  4. registry diagnostics with level error           "Component registry has N errors: <codes>."
  5. requireApprovedRegistry AND status != approved  "…is a draft; an approved registry is required."
  6. requireApprovedRegistry AND placeholder keys    "Component registry has N placeholder component keys."
  7. any rule summary status == crashed              "N rules crashed: <ids>."
  8. any internal/rule-error issue                   "N internal rule errors — the result cannot be trusted."
  9. blocking (non-internal) issues not excepted     "N blocking issues must be fixed or excepted."

ready  := reasons is empty AND blockingIssues is empty
status := ready ? (exceptedIssues non-empty ? READY_WITH_EXCEPTIONS : READY) : NOT_READY
```

Notes:

- With the **bundled draft registry**, reasons 5 and 6 always apply, so the result is never READY.
- A config error includes `incompatible-registry` (registry version outside `registryVersion`) when the
  controller adds `checkRegistryCompatibility()` output to the config diagnostics. It also includes
  `invalid-options`, `unknown-rule`, `unknown-preset`, and `invalid-json` for a corrupt document
  override.
- **Warnings and info never block** under the default policy, even when there are many of them.
- An issue covered by an exception still has `blocking: true` on the issue. It is moved to
  `exceptedIssues` by the readiness step. Totals (`errors`, `warnings`, …) still count excepted issues.

## 2. Blocking policy

`config.readiness` (defaults in `src/lint/config.ts#DEFAULT_READINESS`):

| Key | Default | Meaning |
|---|---|---|
| `blockingSeverities` | `["error"]` | Effective severities that block. `["error","warning"]` makes warnings block too. |
| `blockingRules` | `[]` | Rules whose issues block at any severity except `info`. |
| `requireApprovedRegistry` | `true` | A draft registry or placeholder keys deny readiness. Turning this off is only sensible for experiments. Reports still record `registry.status`. |
| `setDevStatus` | `false` | "Mark Ready" also sets Figma's `devStatus` (see §5). |

`isBlocking(issue, policy)` = `ruleId == internal/rule-error` **or** `severity ∈ blockingSeverities`
**or** (`ruleId ∈ blockingRules` **and** `severity ≠ info`).

Because effective severity depends on **certainty** (likely → warning, requires-review → info by
default), heuristic findings do not block unless you remap them. The strict preset maps
`divi/detached-component` likely → error and requires-review → warning. See
[RULES.md](./RULES.md).

## 3. Exceptions

An exception is a recorded, reasoned decision that one issue on one layer is acceptable.

```json
{
  "id": "ex-b71fbee5",
  "ruleId": "divi/valid-nesting",
  "nodeId": "12:9",
  "code": "invalid-parent",
  "reason": "Row is a standalone promo strip approved by design lead",
  "approvedBy": { "id": "1234567890", "name": "Dana Designer" },
  "createdAt": "2026-10-13T09:00:00.000Z",
  "expiresAt": "2026-12-31T00:00:00.000Z"
}
```

### 3.1 Workflow (Standards tab)

1. Run validation. On an issue, choose **Add exception**, enter a reason, and optionally an expiry date.
2. The controller checks the policy:
   - `exceptions.enabled` must be true;
   - `canApprove(policy, figma.currentUser)`: when `allowedApprovers` is non-empty, the current user's
     Figma id must be listed;
   - a reason is required when `requireReason` is true;
   - the issue must exist in the last run, must not be `internal/rule-error`, and its rule must not be in
     `nonExemptRules`.
3. The exception is created with `id = "ex-" + fnv1a(ruleId|nodeId|code|createdAt|discriminator)`, the
   issue's `code` and `discriminator` (e.g. `paddingLeft`, `fills:0`; `""` when the issue has none),
   `approvedBy` from `figma.currentUser` (`{id: null, name: "Unknown user"}` when unavailable)
   and `createdAt` = now. The expiry may be a date (`yyyy-mm-dd`, which means the end of that day in UTC)
   or an ISO timestamp, and it must be in the future. The exception **replaces** any stored exception for
   the same rule and layer whose code is the same or unset and whose discriminator is the same or unset. It is then saved to shared plugin data
   `figmakit_standards/exceptions`, and validation re-runs.
4. **Remove exception** deletes it and re-runs.

### 3.2 Matching and policy at evaluation time

`findActiveException` attaches the **first** stored exception (in list order) that:

- has the same `ruleId` and `nodeId`, and the same `code` if the exception sets one (an exception
  without `code` covers every code of that rule on that layer);
- has the same `discriminator` as the issue if the exception sets one. Exceptions created by the plugin
  always set it, so approving `paddingLeft` never pre-approves a later `itemSpacing` (or another fill)
  issue on the same layer. Legacy exceptions without a discriminator still cover every issue of that
  rule/code on the layer;
- is permitted by the **current** policy: enabled, rule exemptible, reason present if required, and
  `approvedBy.id` in `allowedApprovers` if that list is non-empty;
- is not expired at `now` (`expiresAt > now`). If `now` or `expiresAt` cannot be parsed, the exception is
  **inactive** (fail closed).

Consequences:

- Policy is re-applied on every run. Tightening `allowedApprovers` or `nonExemptRules` retroactively
  disables existing exceptions.
- Exceptions are tied to **node ids**. Duplicating a frame, copy-pasting it into another file, or
  rebuilding a layer produces new ids, and the exception no longer applies. This is intentional.
- Stored exceptions are parsed with `parseExceptions`. Malformed entries are dropped with diagnostics.
  Duplicate ids keep the first.
- Internal rule errors can never be excepted.

### 3.3 Recommended policy

- Set `allowedApprovers` to the Figma user ids of design leads. Use `nonExemptRules` for rules that must
  never be waived (e.g. `divi/approved-component`, `divi/detached-component`).
- Require `expiresAt` by convention. The plugin does not enforce an expiry.
- Review `approvedExceptions` in every exported report. See §7 for why the plugin's approver check is
  not an authentication mechanism.

## 4. Report JSON

**Export Report** produces `figmakit-standards-report-<yyyy-mm-dd>.json`. It is built by
`src/lint/reporter.ts#buildHandoffReport` (`HandoffReport` in `src/lint/types.ts`).

The export uses the **most recent run** held by the controller when that run is still current. It
re-validates first when there has been no run since the plugin opened (or since the config/registry was
saved or reset), and when the UI has marked the results "Results may be out of date — re-run" (the UI
sends `standards-export {rerun: true}` after a selection change, another feature's edit, a fix or an
exception change). A re-run validates the same `scope` as the results on screen (sent with the request)
while its roots still exist. `validatedAt` is the time of the run the report was built from, not the export time.
Saving or resetting the config or registry discards the last run.

### 4.1 Field reference

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `"1.0.0"` | Report schema version. |
| `tool` | `{name: "FigmaKit Prep", component: "standards", version}` | Plugin build version. |
| `file` | `{name, fileKey}` | `fileKey` is `null` unless the plugin is a private plugin with `enablePrivatePluginApi`. |
| `scope` | `{type: "selection"\|"page", pageId, pageName, rootNodeIds[], rootNodeNames[]}` | What was validated. Selection, otherwise the current page's top-level layers. |
| `validatedAt` | ISO string | Time of the validation run (controller clock). |
| `validatedBy` | `{id, name}` | `figma.currentUser`. May be `null`s. |
| `rulesetVersion` | string | From the resolved config. |
| `registry` | `{version, designSystem, status}` | If the registry failed to load: the version reported by the run and `status: "draft"`. |
| `configHash` | 8-hex string | `fnv1a(stableStringify(ResolvedConfig))`. Identifies the effective config, including options and policies. |
| `totals` | `{checks, passedChecks, errors, warnings, infos, fixable, safeFixable, requiresReview}` | Counts over **all** issues, excepted ones included. `checks` = node × rule evaluations where the rule applied. `requiresReview` = issues with certainty ≠ confirmed. |
| `ruleResults` | `RuleSummary[]` | Per rule: `enabled`, `severity` or `"off"`, `checks`, `passedChecks`, `issueCount`, `truncatedCount`, `status` (`passed`/`failed`/`crashed`/`off`), `errorCount`, `firstError?`. |
| `issues` | `LintIssue[]` | Every issue, sorted deterministically. Each has `id`, `ruleId`, `code`, `nodeId`, `nodeName`, `nodePath`, `severity`, `certainty`, `message`, `suggestion?`, `expected?`, `actual?`, `fix?`, `fixable`, `blocking`, `exception?`, `data?`. |
| `blockingViolations` | `LintIssue[]` | Blocking issues **not** covered by an exception (`ReadinessResult.blockingIssues`). |
| `approvedExceptions` | `(IssueException & {issueId})[]` | Exceptions that actually covered an issue in this run. Stored but unused exceptions are not listed. |
| `readiness` | `{ready, status, reasons[]}` | The verdict from §1. |
| `diagnostics` | `{config: Diagnostic[], registry: Diagnostic[]}` | `{level, code, message, path?}`. |
| `contentHash` | 8-hex string | `fnv1a(stableStringify(report without contentHash))`. **Integrity checksum, not a signature** (§7). `verifyContentHash(report)` recomputes it. |

The report does not record whether the config or registry came from the document or from the plugin
bundle. Compare `configHash`, `rulesetVersion` and `registry.version` with your canonical values.

### 4.2 Example (trimmed)

```json
{
  "schemaVersion": "1.0.0",
  "tool": { "name": "FigmaKit Prep", "component": "standards", "version": "1.0.0" },
  "file": { "name": "Acme Website", "fileKey": null },
  "scope": { "type": "page", "pageId": "0:1", "pageName": "Standards test",
             "rootNodeIds": ["12:4", "12:9"], "rootNodeNames": ["E – Off-scale padding", "Row"] },
  "validatedAt": "2026-10-13T10:00:00.000Z",
  "validatedBy": { "id": "1234567890", "name": "Dana Designer" },
  "rulesetVersion": "1.0.0",
  "registry": { "version": "1.0.0", "designSystem": "Divi 5", "status": "approved" },
  "configHash": "ef7186fc",
  "totals": { "checks": 5, "passedChecks": 3, "errors": 1, "warnings": 2, "infos": 0,
              "fixable": 1, "safeFixable": 0, "requiresReview": 0 },
  "ruleResults": [
    { "ruleId": "divi/valid-nesting", "description": "Registered components must follow the registry nesting constraints.",
      "enabled": true, "severity": "error", "checks": 1, "passedChecks": 0, "issueCount": 1,
      "truncatedCount": 0, "status": "failed", "errorCount": 0 }
  ],
  "issues": [
    { "id": "fk-fa5c343b", "ruleId": "divi/approved-tokens", "code": "off-scale-spacing",
      "nodeId": "12:4", "nodeName": "E – Off-scale padding", "nodePath": "E – Off-scale padding",
      "severity": "warning", "certainty": "confirmed",
      "message": "Padding left 23px is not on the spacing scale.",
      "suggestion": "Use spacing token md (24px).", "expected": "md (24px)", "actual": "23px",
      "fixable": true, "blocking": false,
      "fix": { "kind": "REQUIRES_CONFIRMATION", "description": "Set padding left 23px → 24px (md)",
               "operations": [{ "op": "setNumber", "nodeId": "12:4", "property": "paddingLeft", "from": 23, "to": 24 }] },
      "data": { "property": "paddingLeft", "value": 23, "nearestToken": "md", "nearestValue": 24 } },
    { "id": "fk-154883db", "ruleId": "divi/valid-nesting", "code": "invalid-parent",
      "nodeId": "12:9", "nodeName": "Row", "nodePath": "Row", "severity": "error", "certainty": "confirmed",
      "message": "Divi Row cannot be placed without a registered parent in the validated scope.",
      "expected": "Divi Section", "actual": "$root", "fixable": false, "blocking": true,
      "exception": { "id": "ex-b71fbee5", "ruleId": "divi/valid-nesting", "nodeId": "12:9", "code": "invalid-parent",
                     "reason": "Row is a standalone promo strip approved by design lead",
                     "approvedBy": { "id": "1234567890", "name": "Dana Designer" },
                     "createdAt": "2026-10-13T09:00:00.000Z", "expiresAt": "2026-12-31T00:00:00.000Z" } }
  ],
  "blockingViolations": [],
  "approvedExceptions": [ { "id": "ex-b71fbee5", "issueId": "fk-154883db", "…": "same fields as above" } ],
  "readiness": { "ready": true, "status": "READY_WITH_EXCEPTIONS", "reasons": [] },
  "diagnostics": { "config": [], "registry": [] },
  "contentHash": "44d4377d"
}
```

(The real export lists all eight rules in `ruleResults` and every issue. The `"…"` entry above stands in
for repeated fields.)

## 5. What "Mark Ready for Development" does

1. **Re-runs validation** from the live document. The UI state is never trusted. The button is also
   disabled in the UI unless the latest run is ready and not stale. The re-run covers the **same scope**
   as the results on screen (the UI sends that run's `scope`; the header shows it as "Validated: …"), so
   selecting a layer by clicking an issue cannot narrow it. If a root of that scope no longer exists,
   Mark Ready is denied.
2. If the fresh result is not ready, it replies with the reasons and writes nothing.
3. If ready, it writes **one document-level record** to shared plugin data
   `figmakit_standards/readiness`:
   ```json
   {
     "status": "READY_WITH_EXCEPTIONS",
     "validatedAt": "2026-10-13T10:00:00.000Z",
     "validatedBy": { "id": "1234567890", "name": "Dana Designer" },
     "rulesetVersion": "1.0.0",
     "registryVersion": "1.0.0",
     "scope": { "type": "page", "pageId": "0:1", "pageName": "Standards test", "rootNodeIds": ["12:4", "12:9"], "rootNodeNames": ["…"] },
     "contentHash": "44d4377d",
     "issueCountSummary": { "errors": 1, "warnings": 2, "infos": 0, "blocking": 0, "excepted": 1 }
   }
   ```
   `contentHash` is the hash of the report that *would* be exported for this run. Each "Mark Ready"
   **overwrites** the previous record, so the record describes the most recent scope only. It is not a
   per-frame history. The Standards header shows it as informational `lastReadiness`. It never enables
   the button.
4. If `readiness.setDevStatus` is true, it sets `devStatus = { type: "READY_FOR_DEV" }` on each scope
   root that exposes a `devStatus` property (fetched with `getNodeByIdAsync`). Failures (unsupported node,
   plan without Dev Mode, permissions) are ignored silently. The reply reports how many roots were set
   (`devStatusSet`).
5. The UI wording is "Marked ready (local record). This is not an organization-wide approval."

Nothing stops the file from being edited afterwards, and the record is not invalidated automatically
(§7).

## 6. Security and permissions

| Aspect | Behavior |
|---|---|
| Permissions | `currentuser` only (for `figma.currentUser`). No `teamlibrary`, no `fileusers`. |
| Network | `networkAccess.allowedDomains: ["none"]`. The plugin cannot send data anywhere. Export is a local file download from the UI iframe. |
| Document writes | Only: whitelisted fix operations (`rename`, `setPluginData` on three keys, `setNumber` on padding/itemSpacing, `setSolidPaintColor`), shared plugin data under `figmakit_standards`, and optionally `devStatus`. Fixes never delete, detach, swap or re-parent, and refuse layers inside instances and stale values. |
| Untrusted input | Document overrides (config, registry, exceptions) are parsed with `JSON.parse` and validated. Invalid data produces diagnostics. Corrupt overrides deny readiness instead of falling back silently. |
| UI rendering | Layer names, messages, diagnostics and JSON are HTML-escaped (`esc()` in `src/ui-standards.ts`) before being inserted. |
| Regex patterns | `namingPattern`, `match.namePatterns`, `ignore*Patterns` and `pattern` are compiled from config/registry text and run against layer names. A hostile override can contain a pathologically slow regex, which would only slow down the user's own plugin run. Review overrides like code. |
| Plugin data visibility | Shared plugin data can be read and written by **any** plugin that uses the namespace `figmakit_standards`, and read by anyone with REST API access to the file (`plugin_data=shared`). Node plugin data is private to this plugin id. Do not store secrets in either. |

## 7. What local validation cannot guarantee

Be explicit about these limits when you use the report or the readiness record in a process:

1. **No protection against edits after validation.** The plugin cannot lock a file or detect later
   changes. A READY record or report describes the document at `validatedAt` only. Anyone with edit
   access can change the design a second later. Nothing invalidates the record automatically.
2. **No user authentication beyond `figma.currentUser`.** `allowedApprovers` compares Figma user ids
   reported to the plugin by the client. It decides what *this plugin* will do. It is not an access
   control on the data: anyone can edit the stored exceptions JSON (see 4). If the `currentuser`
   permission is unavailable, the user is recorded as `null`.
3. **The report hash is integrity, not a signature.** `contentHash` is 32-bit FNV-1a over the report
   body. It detects accidental corruption. Anyone can edit a report and recompute the hash
   (`verifyContentHash` would then pass), and collisions are easy to construct. The plugin holds no secret
   key and cannot sign anything that a third party could trust.
4. **Shared plugin data is writable by other plugins.** The config, registry, exceptions and readiness
   records in `figmakit_standards` can be written by any plugin (or script) that uses the same
   namespace, by any editor of the file. A READY record can be forged without running FigmaKit at all.
5. **Document overrides change the standards.** A file can carry its own registry and config. The report
   records their versions and `configHash`, but not their origin.
6. **`fileKey` requires a private plugin.** Development and public plugins see `figma.fileKey ===
   undefined`. Their reports cannot be tied to a specific file without `enablePrivatePluginApi`. Even
   then, a report is not tied to a file *version*.
7. **Scope is what was selected.** A report on a selection says nothing about the rest of the page or
   other pages (`dynamic-page` loads only what is needed). Check `scope.rootNodeIds`.
8. **Heuristics are heuristics.** `likely` and `requires-review` findings, and the *absence* of
   them, are not proof either way (see §9).

The only way to make "ready" mean something to a third party is to re-validate independently, outside
the designer's control (§8).

## 8. Future trusted handoff service (design)

Not implemented. `src/lint/handoff-service.ts` defines the integration seam:

```ts
export interface HandoffSubmissionResult {
  accepted: boolean;
  attestationId: string | null;   // server-issued; null when not attested
  message: string;
}

export interface HandoffAttestationService {
  readonly name: string;
  readonly trusted: boolean;      // true only for services that independently re-validate
  submit(report: HandoffReport): Promise<HandoffSubmissionResult>;
}

export class LocalOnlyHandoffService implements HandoffAttestationService {
  // trusted = false; submit() resolves { accepted: false, attestationId: null, message: "No attestation service…" }
}
```

A trusted implementation would `POST` the `HandoffReport` as JSON to an organization endpoint. This needs
the domain in `networkAccess.allowedDomains` and a private plugin, so that `fileKey` is present.

### 8.1 Server-side flow

```
plugin ──POST report──▶ attestation service
                          1. authenticate the caller (org SSO / service token), not the report
                          2. GET /v1/files/:key/versions            → pick the current version id V
                          3. GET /v1/files/:key?version=V&ids=<scope.rootNodeIds>
                                 &plugin_data=shared,<plugin id>
                               (or /v1/files/:key/nodes?ids=…&version=V&plugin_data=…)
                               → node tree + sharedPluginData (figmakit_standards/*)
                                 + private node data (fk-standards-component, fk-divi-type)
                          4. resolve instance keys: the file JSON's `components` / `componentSets`
                             maps (componentId → key, componentSetId); library keys from
                             GET /v1/files/:library_key/components and /component_sets
                             (or /v1/teams/:team_id/components)
                          5. build DesignNode[] with a REST adapter (new code) and run the SAME
                             engine (src/lint/**) with the SERVER's canonical registry + config,
                             pinned by rulesetVersion / registry version. Ignore document overrides
                             unless policy allows them
                          6. evaluate exceptions from the server's own store, or only accept
                             document exceptions whose approvers the server can authenticate
                          7. compare with the submitted report (configHash, totals,
                             blockingViolations, approvedExceptions) and record any differences
                          8. if READY: sign an attestation
                                { fileKey, versionId: V, rootNodeIds, rulesetVersion,
                                  registryVersion, configHash, resultHash, issuedAt }
                             with a server-held key (e.g. Ed25519 / JWS) → attestationId
◀── { accepted, attestationId, message } ──
```

### 8.2 Version pinning and invalidation

- An attestation covers **one file version** (`versionId`). Any later version is unattested by
  definition.
- Subscribe to Figma **Webhooks (v2)** for the file or team:
  - `FILE_VERSION_UPDATE` (a named version was created) and `FILE_UPDATE` (the file was edited; Figma
    debounces this event) mark existing attestations for that `fileKey` as **stale**, and optionally
    trigger re-validation of the last attested scope.
  - Store `webhook_id` and verify the webhook `passcode` on receipt.
- Consumers check "attestation exists **and** its `versionId` equals the file's current version **and**
  the signature verifies".

### 8.3 CI gate integration

- The development pipeline (e.g. the step that imports the design into WordPress/Divi, or a PR check)
  calls the service: `GET /attestations?fileKey=…&nodeIds=…`.
- The gate **fails** when there is no attestation, the signature is invalid, the version is not current,
  the ruleset or registry version is older than the pipeline's minimum, or the attestation lists
  exceptions that the pipeline's policy does not accept.
- The gate never trusts the plugin's exported report or the `figmakit_standards/readiness` record on
  their own.

### 8.4 Gaps a server must handle

- **REST and Plugin API data differ.** The REST API returns a JSON document tree, not plugin nodes. The
  snapshot (`snapshot.ts`) would need a REST counterpart, and some fields (for example `detachedInfo`) may
  not be exposed over REST. Detach detection server-side may therefore be limited to the heuristics.
  Verify against the current REST documentation before relying on it.
- Library access: the server's token must be able to read the library files whose keys it resolves.
- Rate limits and large files: fetch only `scope.rootNodeIds`.

## 9. Figma Plugin API limitations that affect results

| Limitation | Effect |
|---|---|
| **`detachedInfo` only exists for detaches Figma recorded.** | Older detaches, detaches whose source component was deleted, and some copy/paste paths have no `detachedInfo`. Such layers can only be caught by heuristics (`recreated-component`). For library detaches only the variant `componentKey` is given, so list variant keys in the registry. |
| **Library origin of variables and styles is not verified.** | `divi/approved-tokens` treats any bound variable or any style as approved (`acceptStylesAndVariables`). A style from a non-approved library passes. Verifying origin would need extra async lookups (`getVariableByIdAsync`, `getStyleByIdAsync`, library keys) that are not implemented. |
| **Instance internals.** | Layers inside instances belong to the library component and are skipped by default. Only nested *instances* are checked (approved-component, valid-nesting). Overrides inside instances (text, fills) are not linted. `checkInstanceInternals: true` lints them, but fixes inside instances are always refused. |
| **Hidden nodes.** | Skipped with their subtrees unless `includeHidden`. Hidden variants or layers toggled by component properties are therefore not validated by default. |
| **Unresolvable main components.** | Missing libraries or deleted components give `unresolved-main-component` (requires-review → info). The instance cannot be proven approved or unapproved. |
| **Performance on huge pages.** | The snapshot walks every visible layer, including instance internals, and makes one `getMainComponentAsync` call per instance (only the normalized result is cached per main component), plus classifier/fingerprint work per container. Very large pages (tens of thousands of layers) can take long and keep the plugin busy. Validate selections (sections or frames) instead of whole pages. `maxIssuesPerRule` (500) caps materialized **non-blocking** issues per rule. Excess non-blocking issues are counted in `truncatedCount`; blocking issues are always kept, so truncation can never make a design READY. |
| **`dynamic-page`.** | Only the current page or the selection is validated. Moving to an issue on another page uses `setCurrentPageAsync`. |
| **`figma.fileKey`.** | Private plugins only (`enablePrivatePluginApi`). |
| **`devStatus`.** | Only some node types and plans support it. Failures are ignored. |
| **Key verification.** | `importComponentByKeyAsync` only resolves components published to a library available to the file. Valid unpublished keys are reported as unresolved. |

## 10. Plugin validation vs. external validation

| | In-plugin (today) | External / server (§8, future) |
|---|---|---|
| Runs where | Designer's Figma client | Organization server |
| Who controls inputs | Anyone with edit access (document overrides, exceptions) | The organization (canonical registry, config, exception store) |
| Data source | Plugin API (`detachedInfo`, async main components, private plugin data) | REST API (file JSON, `plugin_data=shared,<id>`, components endpoints). Some plugin-only fields may be unavailable. |
| Version binding | None (a point in time) | Pinned to a file `versionId` |
| Integrity of the result | `contentHash` (checksum, forgeable) | Signature with a server-held key |
| Identity of approver | `figma.currentUser` as reported to the plugin | Authenticated (SSO / tokens) |
| Invalidation after edits | None | Webhooks (`FILE_UPDATE`, `FILE_VERSION_UPDATE`) |
| Autofix | Yes (whitelisted, confirmed) | No (read-only) |
| Best use | Fast feedback while designing; a human-readable handoff record | Enforceable gate for development / CI |
