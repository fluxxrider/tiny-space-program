# films/ai-2027: the AI 2027 explainer film

A self-contained area, separate from the game. It shares no runtime code with `src/` and touches no core
files. It reuses only the repo's `tools/serve.mjs` (static server) and the `puppeteer-core` and `esbuild`
dependencies.

- Entry points: `films/ai-2027/index.html` (dev player + `?render=1` capture mode) and
  `films/ai-2027/dist/ai-2027.html` (single-file build).
- Picture: `films/ai-2027/src/`. `film.render(t)` is deterministic; scenes live in `src/scenes/`, one per section of
  `src/structure.js`.
- Sound: `films/ai-2027/audio/`, pure-JS synthesis rendered offline to WAV by `render-score.mjs`.
- Output (`films/ai-2027/out/`) is gitignored; see `films/ai-2027/README.md` for the full rebuild recipe.
