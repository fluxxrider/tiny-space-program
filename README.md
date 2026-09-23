# 🚀 Tiny Space Program

**▶ Play in your browser: https://fluxxrider.github.io/tiny-space-program/** · 🎬 [Watch the trailer](https://github.com/fluxxrider/tiny-space-program/releases/latest)

**Build rockets. Reach orbit. Try not to explode.**

Tiny Space Program is a rocket-building and orbital-flight sandbox that runs in your browser, inspired by
*Kerbal Space Program*. You bolt parts together in the Vehicle Assembly Building, roll the rocket out to the pad and
fly it with real Newtonian physics and patched-conic orbits. From there you can plan burns in the map view, visit the
moons and planets of the Sola system, and come home through a fiery reentry under a parachute. Or you can make a
very expensive crater. Your crew are the **Tinynauts**. Home is the blue-green planet **Verda**.

Everything is original: the planets, parts, crew, sounds and art. It is built with plain JavaScript and three.js,
and every mesh, texture and sound is made in code.

---

## ▶ Play

| How | What to do |
|---|---|
| **Just play (no install)** | Double-click **`dist/tiny-space-program.html`**. It is one self-contained file, needs no server, and works offline (only the fonts come from the web). If it's missing, run `npm run build`. |
| **macOS launcher** | Double-click **`start.command`**. It starts a local server and opens your browser. The first time, macOS may ask: right-click → **Open**. |
| **From a terminal** | `npm install && npm start`, then open <http://localhost:8765/> |
| **Host it** | Upload **`dist/web/`** to any static host (GitHub Pages, Netlify, S3…). |

Handy URL parameters: `?scene=vab` opens the VAB, `?scene=flight&craft=orbiter_1` launches Orbiter I straight away,
`?scene=tracking` opens the tracking station, and `&debug=1` adds an FPS meter and an error overlay.
You need a WebGL2 browser: current Chrome, Edge, Firefox or Safari 16+.

---

## 🎮 Controls cheat sheet

**Flight**

| Keys | Action | Keys | Action |
|---|---|---|---|
| `W` `S` | pitch | `T` | SAS (hold attitude) |
| `A` `D` | yaw | `R` | RCS |
| `Q` `E` | roll | `H` `N` `J` `L` `I` `K` | RCS translate |
| `Shift` / `Ctrl` | throttle up / down | `CapsLock` | precision controls |
| `Z` / `X` | full throttle / cut | `G` `B` `U` | gear · brakes · lights |
| `Space` | **stage** (one per press) | `M` | map view |
| `.` / `,` | time warp faster / slower | `/` | stop warp |
| `F5` / `F9` | quicksave / quickload | `V` | camera mode |
| `[` / `]` | switch vessel | `Esc` | pause menu |
| `F2` | hide UI | `F1` | screenshot (PNG) |
| right-drag | orbit camera | wheel | zoom |

**Space Center:** `V` VAB · `L` Launch Pad · `T` Tracking Station · `M` Mission Control · `A` Astronaut Complex ·
`R` Resume Flight. You can also click the buildings.

**VAB:** click a part card, then click to attach it (it snaps to nodes and surfaces) · `X` / `Shift+X` symmetry ·
`C` angle snap · `W A S D Q E` rotate the held part (`Shift` = 15°) · `Alt`+click duplicate · `Delete` scrap ·
`Ctrl+Z` / `Ctrl+Y` undo / redo · `Ctrl+S` save · `F` frame the craft · right-click a part for its options ·
right-drag orbit · wheel zoom · `Shift`+wheel pan.

**Map:** drag to orbit · wheel to zoom · `Tab` cycle focus · double-click to focus · click your orbit → **+ Add maneuver** ·
drag the node handles · right-click a node (or `Delete`) to remove it · right-click a body or vessel → **Set target**.

---

## 🛰 Your first flight: Orbiter I

1. **Roll out.** At the Space Center press `L` (Launch Pad), pick **Orbiter I** and hit **Launch**.
   (Or open the VAB → **Load** → Orbiter I if you want to look it over first.)
2. **Liftoff.** Press `T` to turn SAS on, `Z` for full throttle, then `Space`: the core engine and both Hammer boosters light.
   When the boosters burn out, press `Space` again to drop them.
3. **Gravity turn.** Once you pass about 1 km, pitch down gently with `W` — on the pad your rocket’s belly faces east, so the nose tips toward **90°** on the navball.
   Aim for about 45° by 10 km, then keep the nose close to the yellow **prograde** marker so gravity bends
   your path over.
4. **Watch the apoapsis.** Press `M`. When **Ap** reaches about **80 km**, cut the engine with `X`. When the core stage
   runs dry, `Space` drops it and the upper stage takes over. Press `M` to go back and coast up.
   Use `.` to warp time (only a little while you're in the atmosphere) and `/` to stop.
5. **Circularize.** A little before apoapsis, click the **prograde** SAS button next to the navball, go to full throttle
   and burn until the **Pe** climbs above 70 km, where Verda's atmosphere ends. 🎉 **You're in orbit!**
6. **Maneuver nodes.** In the map, hover your orbit, click it and choose **+ Add maneuver**. Drag the handles: yellow is
   prograde/retrograde, purple is normal, cyan is radial. The dashed line shows your new path, and the panel shows the
   Δv and burn time. Warp to the node, point at the blue maneuver marker (SAS has a maneuver mode) and start the burn
   about half the burn time early.
7. **Come home.** Point **retrograde** and burn until Pe is about 30 km. `Space` drops the upper stage so the
   **heat shield** leads the way. Hold retrograde through the reentry glow, then stage the **parachute**. It waits until
   the air is thick and you're slow enough, then opens by itself. After touchdown (or splashdown), click
   **Recover vessel** for the mission report.

Next steps: land on **Lune** with the *Lune Lander*, send the *Pip Pathfinder* probe to tiny **Pip**, or launch
*Big Bertha* just because you can.

---

## ✨ Features

- **Vehicle Assembly Building:** 30+ parts, node and surface attach, symmetry up to 8×, drag-and-drop staging,
  per-stage Δv/TWR, an Engineer's Report, undo/redo, saved crafts, and six stock rockets.
- **Flight:** rigid multi-part vessels with thrust, drag, lift, heating, staging, decouplers, parachutes, landing legs,
  SAS and RCS. Physics and on-rails time warp. Crashes are spectacular.
- **Real orbits:** patched conics across a star system of planets and moons, SOI changes, encounters, closest
  approach, and Ap/Pe/AN/DN markers.
- **Map view and maneuver nodes:** a 6-handle Δv gizmo, chained nodes and a burn timer. The tracking station lets you
  manage every vessel.
- **Worlds:** procedural planets with streamed LOD terrain built in Web Workers, oceans, atmospheres with scattering,
  a day/night cycle and a starry sky.
- **Juice:** smoke, plumes, shock diamonds, reentry fire, explosions, camera shake and fully synthesized audio.
- **Space Center:** a living KSC with buildings to visit, the Astronaut Complex (hire and track your Tinynauts),
  Mission Control milestones, and autosave and quicksave.
- **The Sola system:** Cinder (scorched), Vesper (purple, crushing air), **Verda** (home) with its moons **Lune** and
  **Pip**, and dusty Rusta with its moon Nib.

---

## 🗂 Project structure

```
index.html                 import map → three.js, canvas + UI roots, loading screen
src/main.js                app shell: renderer, lazy scene loader, main loop
src/core/                  constants, event bus, game state & storage
src/data/                  bodies (planets/moons), parts catalogue
src/physics/               orbits, universe, vessel dynamics, atmosphere, SAS …
src/world/                 procedural terrain (+ terrainWorker.js)
src/render/                planets, terrain LOD, sky, water, part meshes, effects, KSC models
src/game/                  crafts, Δv, maneuvers, missions, crew, persistence, input, camera
src/scenes/                spaceCenter.js, vab.js (+ vab/), flightScene.js (+ flight/), tracking.js
src/ui/                    HUD, navball, map view, menus, toasts, stylesheets
src/audio/                 synthesized music & sound effects
tests/                     node tests (*.test.mjs), visual test pages, headless scenarios
tools/                     serve, run-tests, snap (headless screenshots), build, check-dist
dist/                      build output: tiny-space-program.html (single file) + web/ (static site)
notes/                     per-area design notes (notes/build.md covers the build)
ARCHITECTURE.md            module contracts: frames, units, APIs, events, file ownership
```

---

## 🛠 Development

No build step during development: edit a file and reload. The only dependencies are three.js, plus esbuild and
puppeteer-core for tooling.

```bash
npm install
npm start                                   # http://localhost:8765/  (node tools/serve.mjs [port])
npm test                                    # all node tests            (node tools/run-tests.mjs [filter])
node tools/snap.mjs "index.html?scene=vab" --out shots/vab.png --wait 6000   # headless screenshot + console errors
npm run build                               # → dist/tiny-space-program.html + dist/web/
node tools/check-dist.mjs                   # open the single file from file:// in headless Chrome, screenshot each scene
node tools/check-dist.mjs --web             # same for dist/web/ over http
```

`snap.mjs` and `check-dist.mjs` use your installed Google Chrome. Set `CHROME_PATH` if it's somewhere unusual.
Read **ARCHITECTURE.md** before changing code, and see `notes/build.md` for how the single-file build works.

---

## 🙏 Credits

- **[three.js](https://threejs.org)** r170, © three.js authors, MIT License. It is bundled into `dist/`, and its license
  header is kept in the output.
- **[esbuild](https://esbuild.github.io)** (MIT) builds the bundles, and **[Puppeteer](https://pptr.dev)** (Apache-2.0)
  runs the headless tests.
- Fonts: **Rajdhani** and **JetBrains Mono** (SIL Open Font License), loaded from Google Fonts when you're online.
- All other art, audio, models and names are original and procedurally generated.
- Lovingly inspired by *Kerbal Space Program*. Not affiliated with or endorsed by its makers.
