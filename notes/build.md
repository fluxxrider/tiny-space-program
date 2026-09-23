# Build & packaging

Owner files: `tools/build.mjs`, `tools/build-plugins/tsp.mjs`, `tools/check-dist.mjs`, `start.command`, `README.md`,
`dist/` (generated output), and this file. Sources under `src/` and `index.html` are never modified. Every rewrite
described below happens in memory, inside esbuild plugin callbacks.

## What was built

| Command | Output |
|---|---|
| `npm run build` (`node tools/build.mjs`) | `dist/tiny-space-program.html` and `dist/web/` |
| `node tools/check-dist.mjs` | opens the single file from **file://** in headless Chrome, screenshots each scene to `shots/dist_<scene>.png`, and prints a JSON report |
| `node tools/check-dist.mjs --web` | the same for `dist/web/`, served over http |
| `./start.command` (double-click) | runs `node tools/serve.mjs` on 8765 (or a free port) and opens the browser |

* **`dist/tiny-space-program.html`** is a single self-contained file (about 1.7 MB, about 540 KB gzipped). It contains:
  * `index.html` with the import map removed;
  * `base.css` inlined as `<style>`;
  * one inline `<script type="module">` holding all of `src/` plus the parts of three.js that are used. Every lazily
    imported scene and optional module is included.

  The CSS of every `src/**/*.css` file is embedded in the bundle, and the terrain worker is embedded as a string that
  is started from a Blob URL. The favicon was already a `data:` URI. The Google Fonts `<link>` is kept as it is: it is
  non-blocking (`media="print" onload`), and offline you get the fallback fonts. Double-clicking the file in Finder
  plays the game with no server. `?scene=vab` and the other URL parameters also work on file:// (`location.search` is
  kept), and check-dist verifies this.
* **`dist/web/`** is a normal static site:
  * `index.html`
  * `assets/main-<hash>.js`
  * about 50 code-split `assets/chunk-<hash>.js` files (scenes and optional modules really load lazily)
  * `assets/style-<hash>.css`
  * `assets/terrainWorker-<hash>.js`

  `dist/web/` is cleaned on every build. It needs http, because module scripts can't load from file://.
* Build time is about 0.3 s. The build bundles whatever `src/` contains at build time. There is no file list, so new
  scenes, modules and stylesheets are picked up automatically. **`dist/` is not updated automatically; rerun
  `npm run build` after changing `src/`.**

Options: `--single-only`, `--web-only`, `--no-minify` (for readable stack traces), `--strict`, `--sourcemap` (web build
only), `--quiet`, `--help`.

## Pipeline (tools/build.mjs)

1. **Parse `index.html`.** The build reads:
   * the import map JSON;
   * local `<script type="module" src>` entries (it fails if there are none or if one is missing);
   * local `<link rel="stylesheet">` tags. Remote ones (the fonts) are kept.
2. **CSS map.** Every `src/**/*.css` file, plus the stylesheets linked from index.html, goes through its own esbuild
   CSS bundle. This minifies it and inlines any `@import` and relative `url(file)` as a data URL. `url(#svgGradient)`
   references are left alone. The result is the map `{ 'src/ui/hud.css': '…' }`, exposed as the virtual module
   `tsp:css`.
3. **Bundling.** esbuild runs with `bundle`, `format: 'esm'`, `minify`, target `es2022 / chrome100 / firefox110 /
   safari16` and `legalComments: 'eof'`, so the three.js MIT header is kept at the end. It uses the `tsp` plugin (next
   section).
   * **Single-file mode:** no code splitting. esbuild converts every `import('./x.js')` into a lazily initialised module
     inside the one script (`Promise.resolve().then(() => (init_x(), x_exports))`). Module evaluation is still deferred
     until first use, as it is with native dynamic imports.
   * **Web mode:** `splitting: true` gives real chunks.
4. **HTML assembly.**
   * The import map is removed.
   * Local stylesheet links become `<style data-src="…">`.
   * The entry `<script src>` becomes the inline bundle. `</script` is escaped; esbuild already does this, and the build
     does it again as a safety measure. `<!--` is rewritten to `\x3C!--`.
   * A "generated — do not edit" comment with the build timestamp is added.

   The build uses `indexOf`/`slice` for these replacements, not `String.replace`, because the bundle contains
   `$&`-like sequences that `replace` would interpret.
5. **Report.** The build prints stylesheets, workers, non-literal `import()` rewrites, stubbed missing modules, any
   `import()` esbuild could not bundle, and sizes (raw and gzipped). It exits non-zero on any esbuild error or
   plugin error.

## In-memory rewrites (tools/build-plugins/tsp.mjs)

| Source construct | Rewritten to | Why |
|---|---|---|
| `'three'`, `'three/addons/…'` | resolved through **index.html's import map** | the bundle uses exactly the files the dev build loads |
| `new Worker(new URL('<lit>.js', import.meta.url), opts)` | `<worker>.create(opts)`. The worker entry is bundled separately as an IIFE and created as a **classic** worker from a Blob URL in single-file mode, or from the emitted `assets/<name>-<hash>.js` in web mode | Chrome **refuses module-type Blob workers on file:// pages** but allows classic ones (verified). The IIFE bundle has no imports, so classic works |
| `new URL('<lit>.js', import.meta.url)` not passed directly to `new Worker` | `new URL(<worker>.url())` | same bundle. Note: if such a URL is later given `{type:'module'}`, it fails on file:// |
| `new URL('<lit>.css', import.meta.url)` | `new URL("tsp-css:src/…/x.css")` | a stable key into the embedded CSS map; `.href` is the key |
| `new URL('<other file>', import.meta.url)` | `new URL("data:<mime>;base64,…")` | small assets inlined (no current uses) |
| `export function loadCSS(href)` in `src/ui/dom.js` | renamed to `__tspLinkCSS`. A new `loadCSS` looks up the key (`tsp-css:` prefix, a `…/src/…` suffix, or a root-relative `src/…` path) in the map and injects a `<style data-src>` once. Unknown hrefs fall back to the original `<link>` | works from file://, and the style applies synchronously |
| `import(nonLiteral)`, e.g. `hud.js`'s `load(key, path) => import(path)` | `__tspDynImport(x)`: a hoisted `switch` with one `case '<lit>': return import('<lit>')` for every relative `.js` string literal in that file that exists and is not a static import. Otherwise it rejects | esbuild can only bundle literal imports. The rejection goes into the source's own `.catch` fallback |
| `import('./missing.js')` (a relative dynamic import whose file doesn't exist) | a stub module that throws `"<path> was not present when this build was made — rebuild"`. Its default export is a class whose constructor throws the same error, so a second attempt also fails clearly. `--strict` makes it a build error | scenes can be built before every scene exists. `main.js` shows a toast "Could not open flight: …" and the other scenes keep working |

Loud failures, all with exit 1 and a code frame:
* JS syntax or resolve errors;
* `new URL('<lit>', import.meta.url)` pointing at a missing file;
* a referenced CSS file that is not in the map;
* nested workers;
* `loadCSS` exported in a form other than `export function loadCSS(`;
* no module declaring `loadCSS` at all (runtime CSS would silently break);
* an import-map target missing (`npm install` not run);
* `--strict` combined with a missing lazily imported module.

Warnings (build continues):
* a stubbed missing module;
* a file that still uses `import.meta.url` after rewriting (in the single file this is the page URL);
* a file that creates `<link rel="stylesheet">` itself instead of calling `loadCSS`;
* an `import()` left unbundled in the output.

## How to test

```bash
npm run build && node tools/check-dist.mjs            # spacecenter, vab (+ flight, tracking when those files exist)
node tools/check-dist.mjs --scenes flight --script tests/e2e_flight_smoke.mjs   # full ascent on the file:// build
node tools/check-dist.mjs --web                       # dist/web over http
node tools/check-dist.mjs --scenes spacecenter --shots 1000,4000 --wait 8000     # timeline screenshots
```

check-dist fails when any of the following happens:
* a console error or page error;
* a failed request or HTTP ≥ 400 (Google Fonts failures only warn, since fonts are optional);
* **any file:// request other than the page itself**, meaning the build is not self-contained;
* `TSP.app.errors` is not empty;
* the active scene is not the one requested.

It also instruments `window.Worker` (it counts created workers, messages and errors) and lists the injected
`<style data-src>` sheets, so you can check that the workers really ran and the CSS was embedded. `--script` takes
the same interface as `snap.mjs --script`.

Results at hand-off (2026-09-22). Single file over file://:

| Scene | Result |
|---|---|
| spacecenter | 0 errors, 4 Blob workers, 120+ chunk messages |
| vab | 0 errors |
| flight (`orbiter_1`) | 0 errors, HUD, navball, crew and flight CSS all applied |
| tracking | 0 errors |

* `tests/e2e_flight_smoke.mjs` flies liftoff → 40 km → map → back on the file:// build, with the same step results
  as the unbundled dev build. That scenario's own "did not stage" check fails identically on the dev server, so it is
  not a build issue.
* `dist/web` passes over http.

## Caveats / known issues

* **Only tested in Chrome** (headless and desktop engine). Firefox (≥ 110) and Safari (≥ 16) should work: inline module
  scripts and classic Blob workers are standard there. However:
  * Safari applies stricter rules to file:// pages than Chrome does. The build doesn't depend on any of them (it makes
    no file:// fetches), but this has not been verified in Safari.
  * If workers fail anywhere, `terrainLOD.js` already falls back to building chunks on the main thread (with a console
    warning).
* **Saves on file://.** Chrome gives all file:// pages one shared localStorage. Saves made there are separate from
  saves made at `http://localhost:8765`.
* The single file has **no source maps**, and names are minified. Use `npm run build -- --no-minify` for readable
  stack traces, or `--sourcemap` for the web build.
* The rewrites are regex-based on source text. They only handle **string-literal** `new URL('…', import.meta.url)`.
  A computed path triggers the "still uses import.meta.url" warning and would resolve against the page URL.
* Non-literal `import(x)` can only reach modules named by a string literal in the same file. Anything else rejects,
  which every current call site handles with `.catch`.
* The Google Fonts `<link>` means the page contacts fonts.googleapis.com when online. Offline, the UI uses the
  fallback stack (Avenir Next Condensed, Segoe UI, system-ui, SF Mono…).
* `dist/` is generated. There is no `.gitignore` in the repo, so decide whether to commit `dist/`. Committing
  `dist/tiny-space-program.html` makes "double-click to play" work straight from a clone.

## Integration notes

* New stylesheets: put them anywhere under `src/` and load them with `loadCSS(new URL('./x.css', import.meta.url).href)`
  or `loadCSS('src/…/x.css')`. Both are embedded automatically. Don't create `<link>` tags by hand.
* New workers: use the literal pattern `new Worker(new URL('./w.js', import.meta.url), { type: 'module' })`. The worker
  may import other modules (they are bundled into it) but must not use top-level `await` or `import.meta`.
* New lazily loaded modules: a literal `import('./x.js')` is always bundled. For "optional" imports through a helper,
  keep the path as a string literal somewhere in the same file.
