# Installing and Configuring FigmaKit Prep (Standards) in Figma

## 1. Requirements

- **Figma Desktop** (macOS or Windows). Development plugins imported from a local manifest only run in
  the desktop app.
- Edit access to the file you validate. Fixes, exceptions, "Mark Ready" and saving settings all write to
  the document.
- To populate the registry: access to the team library file that contains your approved components, or a
  file that uses them.

## 2. Build and import

```bash
npm install
npm run build          # produces dist/main.js and dist/ui.html
```

In Figma Desktop:

1. Open any design file.
2. **Plugins → Development → Import plugin from manifest…**
3. Select `manifest.json` in the repository root.
4. Run it from **Plugins → Development → FigmaKit Prep**. Open the **Standards** tab (8th tab, after
   Tokens).

To pick up a new build, close the plugin and re-run it. Figma does not reload it automatically unless hot
reload is on (see [LOCAL_DEVELOPMENT.md §4](./LOCAL_DEVELOPMENT.md#4-edit--rebuild--reload-loop)).

## 3. Manifest fields that matter

```json
{
  "name": "FigmaKit Prep",
  "id": "1620233172828880582",
  "api": "1.0.0",
  "main": "dist/main.js",
  "ui": "dist/ui.html",
  "editorType": ["figma"],
  "documentAccess": "dynamic-page",
  "networkAccess": { "allowedDomains": ["none"] },
  "permissions": ["currentuser"]
}
```

| Field | Value | Consequence |
|---|---|---|
| `main` | `dist/main.js` | Sandbox code (`src/main.ts` bundle, including the lint engine and bundled standards). |
| `ui` | `dist/ui.html` | UI iframe, with the UI script inlined. |
| `documentAccess` | `dynamic-page` | Pages load on demand. The plugin must use async APIs: `getMainComponentAsync`, `getNodeByIdAsync`, `setCurrentPageAsync`. The sync `instance.mainComponent` throws. Validation covers the **selection or current page only**, never the whole document. |
| `networkAccess` | `allowedDomains: ["none"]` | The plugin cannot make network requests. Reports are exported as files, and no attestation server can be reached (see HANDOFF_VALIDATION §8). |
| `permissions` | `["currentuser"]` | Needed for `figma.currentUser` (id and name). It is recorded as the approver of exceptions and as `validatedBy` in reports and readiness records. Without it the user is recorded as `null`. |
| `id` | `1620233172828880582` | Scopes **private** node plugin data (`fk-type`, `fk-standards-component`, `fk-divi-type`). Changing the id makes previously written node data invisible to the plugin. |

`figma.fileKey` is **not** available to development or public plugins. It requires a private
(organization) plugin with `"enablePrivatePluginApi": true` in the manifest (§6). Until then, reports
contain `"fileKey": null`.

## 4. Populating the component registry

The bundled registry (`src/standards/registry.json`) is a **draft** with placeholder keys. While it is
in use, readiness is always NOT_READY ("…is a draft; an approved registry is required" and
"…placeholder component keys"). To make readiness possible, give the plugin real component keys.

### 4.1 Generate entries from the library

1. Open the **library file** that defines your approved components (Section, Row, Column, Button, …).
2. Select the components. You can select **COMPONENT_SET** nodes, individual **COMPONENT**s, **INSTANCE**s
   (their main component is resolved asynchronously), or frames that contain any of these (the helper
   walks into children, up to 5000 nodes).
3. Run the plugin → **Standards → Settings → "Generate registry entries from selection"**.
4. The output has two parts:
   - `json`: an array of `RegistryComponent` skeletons
     `{id (slugified name), name, diviType: null, figmaComponentKeys: [<set key, then variant keys> | <component key>], description}`.
     For variants, the **component-set key** comes first, followed by the key of every variant the
     helper can read in that set. Entries are de-duplicated per set.
   - `entries`: `{suggestedId, name, key, componentSetKey, remote, variantKeys}` for each skeleton. `key`
     is the key of the first component encountered for that set.
5. **Why variant keys are included.** Instances match by set key alone. Figma's `detachedInfo` for a
   **library** detach contains only the **variant** key, so the variant keys are what let detached library
   copies be recognized as `detached-approved` (instead of `detached-unregistered`, info). If the helper
   could not read a set's variants (for example, an instance whose remote set's children are not
   accessible), only the set key is written; add the variant keys by hand, either by running the helper
   with **one variant selected at a time** and copying `entries[].key`, or with the REST API
   `GET /v1/files/:library_file_key/components` (published variants appear with their `key`). Running the
   helper in the **library file** on the COMPONENT_SET itself is the most reliable way to get every
   variant key.

### 4.2 Build the registry JSON

1. **Standards → Settings → Registry JSON**. This shows the effective registry (document override, or
   the bundled draft).
2. Replace `components` with your entries. Merge the generated keys into the bundled Divi entries if
   you want to keep their `diviType` and `match` hints. **Remove every component you cannot key.** Any
   leftover placeholder key prevents readiness.
3. Add constraints **only if they are confirmed** for your Divi 5 build: `allowedChildren`,
   `allowedParents`, `governsChildren`, `requiredProperties`, `requiresAutoLayout`, `namingPattern`.
   See [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-registry-format) for the field reference.
4. Set `"version"` (e.g. `"1.0.0"`; it must satisfy the config's `registryVersion`, bundled range
   `>=0.1.0 <2.0.0`) and `"status": "approved"`.
5. **Save**. The JSON is validated first. Error diagnostics (duplicate ids or keys, unknown references,
   invalid regexes, invalid tokens) block the save and are listed. Warnings (e.g. `unknown-role`) are
   shown but do not block.

The saved registry is stored in the document's shared plugin data
(`figmakit_standards` / `registry`). It applies **to this file only**. To apply it to every file, bundle
it (§6).

### 4.3 Verify keys

**Standards → Settings → "Verify registry keys"** tries `figma.importComponentByKeyAsync(key)` and then
`importComponentSetByKeyAsync(key)` for every non-placeholder key. It lists resolved keys, unresolved keys
with the error, and remaining placeholder keys. The check passes only when there are no unresolved or
placeholder keys.

- Import only works for components **published** to a library that this file can access. Keys of
  unpublished local components, or of libraries not enabled for the file, are reported as unresolved
  even if they are correct.
- Verification does not change the lint result. It is a sanity check for typos and stale keys.

## 5. Building a sample test document

This walk-through exercises the main rules. The expected results below were checked against the engine
with an equivalent snapshot (recommended preset, registry below).

### 5.1 Library components

In a library file (publish it to your team library, or use one file with local components for a quick
test):

| Component | Build |
|---|---|
| **Button** | Component set with variant property `Type = Primary \| Secondary`. Horizontal auto layout, padding 12/24/12/24, a fill, one text layer. |
| **Column** | Vertical auto layout containing one Button instance (`Type = Primary`). |
| **Row** | Horizontal auto layout containing two Column instances. |
| **Section** | Vertical auto layout, 1440 wide, containing one Row instance. |

Generate entries (§4.1) and save this registry (keys replaced with yours):

```json
{
  "version": "1.0.0", "designSystem": "Divi 5", "status": "approved",
  "components": [
    { "id": "divi-section", "name": "Divi Section", "diviType": "et_pb_section",
      "figmaComponentKeys": ["<Section key>"], "allowedChildren": ["divi-row"], "allowedParents": ["$root"],
      "governsChildren": true, "match": { "namePatterns": ["^(divi[-_ ]?)?section$"], "roles": ["section"] } },
    { "id": "divi-row", "name": "Divi Row", "diviType": "et_pb_row",
      "figmaComponentKeys": ["<Row key>"], "allowedChildren": ["divi-column"], "allowedParents": ["divi-section"],
      "governsChildren": true, "match": { "namePatterns": ["^(divi[-_ ]?)?row$"], "roles": ["row"] } },
    { "id": "divi-column", "name": "Divi Column", "diviType": "et_pb_column",
      "figmaComponentKeys": ["<Column key>"], "allowedChildren": ["divi-button"], "allowedParents": ["divi-row"],
      "governsChildren": true, "match": { "namePatterns": ["^(divi[-_ ]?)?(column|col)$"], "roles": ["column"] } },
    { "id": "divi-button", "name": "Divi Button", "diviType": "et_pb_button",
      "figmaComponentKeys": ["<Button set key>", "<Type=Primary key>", "<Type=Secondary key>"],
      "requiresAutoLayout": { "direction": "HORIZONTAL" },
      "requiredProperties": [{ "name": "Type", "allowedValues": ["Primary", "Secondary"] }],
      "match": { "namePatterns": ["^(divi[-_ ]?)?(button|btn)$"], "roles": ["button"] } }
  ],
  "tokens": { "spacing": [
    { "name": "4xs", "value": 4 }, { "name": "3xs", "value": 8 }, { "name": "2xs", "value": 12 },
    { "name": "xs", "value": 16 }, { "name": "sm", "value": 20 }, { "name": "md", "value": 24 },
    { "name": "lg", "value": 32 }, { "name": "xl", "value": 48 }, { "name": "2xl", "value": 80 },
    { "name": "3xl", "value": 96 } ] }
}
```

### 5.2 Test page

Create a page "Standards test" and add these top-level layers directly on the canvas:

| # | How to build it | Expected issues (recommended preset) |
|---|---|---|
| A | Insert a **Section** instance. Rename it "A – Correct". | **None.** The nested Row, Column and Button instances are checked as nested instances and are all valid. |
| B | Insert a **Button** instance (`Type = Primary`), then **Detach instance** (`Cmd/Ctrl + Option/Alt + B`). | `divi/detached-component` **`detached-approved`**: error, confirmed, "Detached from approved component Divi Button." If the registry lists only the set key (no variant keys), you get `detached-unregistered` (info) instead (§4.1). |
| C | Draw a new frame named **"Button"**: horizontal auto layout, padding 12/24, a fill, one text layer "Click me". | `divi/detached-component` **`recreated-component`**: **warning**, *likely* (evidence: name, structure). If the frame does not look like a button to the classifier (no fill, no auto layout), only the name signal fires: requires-review, **info**. |
| D | Insert a **Section** instance, rename it "D – Wrong nesting". Double-click into it, select the second **Column** instance inside the Row, and use the instance-swap menu to swap it for **Button**. | `divi/valid-nesting` **`invalid-child`** on "D – Wrong nesting / Row / Button": error, "Divi Button is not allowed inside Divi Row." |
| D2 | Insert a **Row** instance directly on the canvas. | `divi/valid-nesting` **`invalid-parent`**: error. The Row has no registered parent and `$root` is not in its `allowedParents`. |
| E | Draw a frame "E – Off-scale padding", **narrower than 900 px**, vertical auto layout, padding top 40 / left 23 / right 24 / bottom 24, item spacing 16, one text layer. | `divi/approved-tokens` **`off-scale-spacing`** twice (warning): padding left 23 px → expected `md (24px)` with a fix that **needs confirmation**. Padding top 40 px → expected `lg (32px)`, with **no autofix** (off by 8 > `snapTolerance` 2). |

With **nothing selected**, click **Run Validation** (scope = all top-level layers on the page).

Expected outcome:

- **NOT READY FOR DEVELOPMENT**, with reasons such as "3 blocking issues must be fixed or excepted." (B,
  D, D2). The warnings from C and E do not block.
- **Fix Safe Issues** is disabled, because none of these issues has a SAFE fix. Use **Fix** on the E
  issue (23 → 24) to see the confirmation preview. Validation re-runs afterwards. Undo with `Cmd/Ctrl + Z`.
- Clicking an issue selects the layer and zooms to it.
- Delete B, D and D2 (or add exceptions with a reason) and re-run. The result is **READY** (or **READY
  WITH EXCEPTIONS**), and **Mark Ready for Development** becomes enabled.

Caveats seen in practice:

- Frames ≥ 900 px wide are classified as sections by the FigmaKit analyzer. A wide frame with no
  registered content gets `divi/semantic-mapping` `unmapped-structure` (info). Under strict it also gets
  `divi/detached-component` `recreated-component` (requires-review, which strict maps to warning).
- If your library components contain other sub-component instances (icons, dividers) directly inside a
  governing component (Section/Row/Column), these are reported as `unapproved-instance`. Register them, or
  use `allowedComponentKeys` / `ignoreComponentNamePatterns` (see RULES.md).
- Selecting only a layer that is nested inside another frame changes `$root` semantics. `invalid-parent`
  is not reported when the placement above the selection is unknown.

## 6. Distributing to an organization

Development plugins exist only on the machine that imported them. To roll out to a team:

1. **Bundle the approved standards into the build.** Copy your approved registry into
   `src/standards/registry.json` and your config into `src/standards/figmakit.config.json`. Bump
   `version` / `rulesetVersion` and run `npm test && npm run build`. Every file opened with this build
   then uses these standards, unless a file carries a document override (shown as `source: document` in
   the header).
2. **Publish as a private organization plugin** (Figma Organization or Enterprise plan). From the
   development plugin, use **Publish** and choose your organization as the audience. Your organization's
   admins may need to approve it. The manifest `id` must belong to a plugin record your account can
   publish. If you create a new plugin record to get your own id, update `manifest.json`. Remember that
   node-level plugin data is scoped to the id.
3. **Enable `figma.fileKey`** (optional, private plugins only). Add `"enablePrivatePluginApi": true` to
   the manifest. Reports and the readiness record then include the real file key, which a server-side
   validator needs (HANDOFF_VALIDATION §8).
4. Decide on a **document override policy**. Anyone with edit access can save a per-file config or
   registry. The exported report does **not** record whether the standards came from the
   document or from the bundle. If overrides are not acceptable, compare the report's `configHash`,
   `rulesetVersion` and `registry.version` against your canonical values (or re-validate server-side).
5. If you later add an attestation server, list its domain in `networkAccess.allowedDomains`.
