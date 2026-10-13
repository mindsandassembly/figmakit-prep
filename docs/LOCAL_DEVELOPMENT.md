# Local Development

## 1. Prerequisites

- Node.js 18+ and npm (the build script is an ES module that uses top-level `await`).
- **Figma Desktop**. Development plugins loaded from a local `manifest.json` only run in the desktop
  app, not in the browser.
- No runtime npm dependencies. The dev dependencies are `esbuild`, `typescript`, `vitest` and
  `@figma/plugin-typings`.

## 2. Commands

```bash
npm install          # install dev dependencies
npm run dev          # watch mode: rebuild dist/main.js and dist/ui.html on change
npm run build        # one-off production build
npm run typecheck    # tsc --noEmit over src/ (tests are excluded by tsconfig)
npm test             # vitest run (all tests/**/*.test.ts)
npm run test:watch   # vitest in watch mode
```

Run a single file or test while you work:

```bash
npx vitest run tests/lint/rules/valid-nesting.test.ts
npx vitest run -t "flags wrong direction"
```

## 3. What the build produces

`esbuild.config.mjs` builds two bundles, both `target: es2015` and `format: iife` (Figma sandbox):

| Output | Source | Notes |
|---|---|---|
| `dist/main.js` | `src/main.ts` and everything it imports, including `src/lint/**`, `src/standards-controller.ts`, and the **bundled standards JSON** (`src/standards/*.json` is inlined at build time) | Minified in `build`, not minified in `dev`. |
| `dist/ui.html` | `src/ui.html`, with the compiled `src/ui.ts` bundle inserted as an inline `<script>` before `</body>` | The UI bundle is **never minified** (this avoids variable-name collisions in the Figma UI iframe). |

`manifest.json` points at `dist/main.js` and `dist/ui.html`. Figma loads these files and never reads
`src/`.

### What `npm run dev` does

- Starts an esbuild **watch context for `main.ts`**. Any change in its import graph (including
  `src/lint/**` and `src/standards/*.json`) rewrites `dist/main.js`.
- Starts a second watch context for `ui.ts`. It writes `dist/ui.js`, and after each rebuild an `onEnd`
  hook reads `src/ui.html`, inlines `dist/ui.js`, and writes `dist/ui.html` ("UI rebuilt." in the
  terminal). `dist/ui.js` is a by-product of watch mode and is not referenced by the manifest.
- **Caveat:** `src/ui.html` is not part of esbuild's import graph. Editing **only** `ui.html` does not
  trigger a rebuild. Save `src/ui.ts` (or any module it imports) to trigger one, or run `npm run build`.

## 4. Edit → rebuild → reload loop

Figma does **not** automatically reload a running development plugin unless you turn on hot reload (see
below). The usual loop is:

1. Keep `npm run dev` running in a terminal.
2. Edit `src/...` and save. Wait for the rebuild. Main-side changes are silent unless they fail; UI
   changes print "UI rebuilt.".
3. In Figma Desktop, **close the plugin window** if it is open. The running instance keeps the old code.
4. Re-run the plugin:
   - **Plugins → Development → FigmaKit Prep**, or
   - **Run last plugin**: `Cmd + Option + P` (macOS) / `Ctrl + Alt + P` (Windows).
5. Check the change. State held in the plugin (for example the last Standards run) is lost on reload.
   Data saved to the document (shared plugin data, exceptions, readiness record) persists.

**Hot reload.** Recent Figma Desktop versions have a **Plugins → Development → Hot reload plugin**
toggle. When it is on, Figma re-runs the development plugin when its `dist` files change. Menu labels
and availability vary between Figma versions. If you do not see the option, use the manual loop above.
Hot reload restarts the plugin, which also discards in-memory state.

Changes to `manifest.json` (e.g. permissions) can require re-importing the plugin: **Plugins →
Development → Import plugin from manifest…**.

## 5. Inspecting diagnostics

- **Figma console:** **Plugins → Development → Show/Hide console** (Figma Desktop), or open the
  developer tools with `Cmd + Option + I` (macOS) / `Ctrl + Alt + I` (Windows). `console.log` from both
  `main.ts` (sandbox) and the UI iframe appears there. Uncaught errors in handlers are converted to
  `standards-toast` / `error` messages in the UI, so check the toast as well as the console.
- **Standards UI:** config and registry diagnostics (code, level, path) are shown above the issue list.
  Readiness reasons explain every NOT_READY. Rule crashes appear as `internal/rule-error` issues with the
  failing rule id in `data.failedRule`.
- **Export Report:** **Standards → Export Report** downloads
  `figmakit-standards-report-<date>.json`. It contains every issue with `data`, rule summaries (checks,
  passed, truncated, crash counts, first error), diagnostics and readiness reasons. This is the most
  complete view of a run. Diff two exports to see what a change did. Issue ids are stable while node ids
  are unchanged.
- **Where the standards came from:** the Standards header shows `source: document | bundled` for the
  config and registry. If behavior does not match `src/standards/*.json`, a document override is
  probably active. Use Settings → Reset config / Reset registry to drop it.

## 6. Testing autofixes safely

Autofixes write to the document. Before using them on real work:

1. **Duplicate the page** (right-click the page in the Pages list → Duplicate) and validate the copy. You
   can also use a scratch file.
2. Use **Fix Safe Issues → preview** first. The preview lists every operation
   (`Rename "Frame 12" → "Divi Button"`, `Set paddingLeft 23px → 24px`, …) and every skipped issue with
   its reason.
3. After applying, validation re-runs automatically. Undo with **`Cmd + Z` / `Ctrl + Z`**. The plugin
   calls `figma.commitUndo()` before and after each fix batch, so one undo reverts exactly that batch.
   Every Standards write to the file (exceptions, config / registry saves, readiness records) is also
   committed as its own undo step, so undoing a fix never rolls back an exception or readiness record.
4. A confirm-to-apply fix is bound to the preview you saw: the confirmation carries the previewed
   operations, and the controller refuses it if a re-run changed them (for example, the padding was
   edited in between). A new validation result also closes any open preview.
5. What fixes can never do: delete, detach, swap, re-parent, or edit layers inside instances. Each
   operation carries the expected current value (`from`) and is refused as `stale` if the layer changed
   since the run. Spacing fixes are refused on non-auto-layout frames and on padding / item spacing bound
   to a variable (writing a number would replace the binding). Color fixes are refused on paints bound to
   variables and on layers that use a fill / stroke style (writing a color would detach the style).

## 7. Writing tests and fixtures

- Tests live in `tests/**` and run in Node with Vitest (`vitest.config.ts`, `globals: true`). Nothing
  under `tests/` is type-checked by `npm run typecheck`.
- **Rule tests** (`tests/lint/rules/*.test.ts`) build plain `DesignNode` trees. They need no Figma mock:

  ```ts
  import { node, instanceOf, textNode, lint, makeContext, testRegistry, byName } from '../helpers';

  const roots = [
    instanceOf('key-section', { name: 'Section' }, { componentName: 'Section' }),
    node({ name: 'Button', layoutMode: 'HORIZONTAL',
           structural: { role: 'button', confidence: 85, source: 'type' } }),
  ];
  const { result, readiness } = lint(roots);       // testRegistry() + figmakit:recommended + ALL_RULES
  ```

  - `node(partial)` provides defaults for every `DesignNode` field (FRAME, visible, layout NONE, analysis
    `container/30/default`, structural `null`, …).
  - `instanceOf(key, partial, {setKey, componentName, variantProperties, componentProperties, remote})`
    builds an INSTANCE. Pass `key = null` to simulate an unresolvable main component.
  - `finalize(roots)` assigns ids (`n1`, `n2`, … in pre-order), parent ids, depth, path, `order`,
    `insideInstance`. `lint()` and `makeContext()` call it for you.
  - `testRegistry()` is an approved registry with keys `key-section`, `key-row`, `key-column`,
    `key-button` (set `set-button`), `key-text`, `key-image`, `key-blurb`, nesting
    Section → Row → Column → leaves, Button requiring horizontal auto layout and `Type ∈ {Primary,
    Secondary}`, and tokens (FigmaKit spacing, three colors, two text styles, `Inter`).
  - `lint(roots, {config, registry, rules, exceptions, now})`. The default `now` is `TEST_NOW`
    (`2026-01-01T00:00:00.000Z`).
- **Snapshot / autofix tests** use raw mocks from `tests/helpers/figma-mock.ts` with
  `createMockResolver()`. Put the main component on a mock instance as `__mainComponent` (a
  `MainComponentInfo`-like object or a mock COMPONENT; `null` means unresolved).
- **Determinism:** do not use `Date.now()` in tests that compare output. Pass `now` explicitly. Assert
  on `code`, `certainty`, `severity` and `fix.kind` rather than whole message strings unless the message
  wording is what you are testing.
- **Fixtures:** keep registries inline in the test (or derive from `testRegistry()`) so each test shows
  the constraints it depends on. Do not edit `src/standards/registry.json` to make a test pass. That file
  is shipped to users.

## 8. Before you hand off a change

```bash
npm test && npm run typecheck && npm run build
```

Then reload the plugin in Figma and run Standards once on a test page (see
[FIGMA_INSTALLATION.md §5](./FIGMA_INSTALLATION.md#5-building-a-sample-test-document)).
