# Tiny Space Program

Browser-based, KSP-inspired rocket sandbox. Plain ES modules + three.js r170 (import map → node_modules), no build step.

- **ARCHITECTURE.md is the binding contract** between modules (frames, units, APIs, events, file ownership). Read it before changing code.
- Only edit files your area owns (see the ownership table). Core files (`src/core/*`, `src/data/bodies.js`, `src/game/input.js`, `src/ui/dom.js`, `src/ui/toast.js`, `src/ui/base.css`) are shared — change them only when explicitly asked.
- Physics/data/game-logic modules must stay node-importable (no `window`/`document` at import time).
- Custom ShaderMaterials must include three's logdepthbuf chunks (the renderer uses `logarithmicDepthBuffer`).
- Verify: `node tools/run-tests.mjs [filter]` (node tests in `tests/*.test.mjs`), `node --check <file>`,
  `node tools/snap.mjs <page> --out shots/<name>.png --wait 6000 [--eval "<js>"] [--script <file>]` (headless Chrome, SwiftShader WebGL; prints console errors) — then view the PNG.
- Run the game: `node tools/serve.mjs` → http://localhost:8765/ (`?scene=vab`, `?scene=flight&craft=orbiter_1`, `&debug=1`).
- Each area documents itself in `notes/<area>.md`.
- Don't git commit unless asked.
