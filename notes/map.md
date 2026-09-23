# Map area: `src/ui/mapView.js`, `src/ui/mapBake.js`, `src/ui/map.css`, `src/game/maneuver.js`

This area builds the KSP-style map view and tracking station, plus the maneuver-node logic behind them. Both are
built on the real `src/physics/orbit.js` and `universe.js`, and `world/terrain.js` is imported defensively.

## What was built

### Map view (`MapView`)
* **Own scene and camera.** The map has its own `THREE.Scene` and `PerspectiveCamera` and renders with
  `app.renderer`. A starfield and Milky-Way sky is drawn first in a separate pass, then the depth buffer is cleared.
  1 scene unit = 1 km. The floating origin is the camera target (the focused object), so everything near the camera
  is float32-precise.
* **Camera.**
  * Drag (left or right button) orbits the camera, with damping.
  * The wheel zooms exponentially, smoothed in log space, from about 1.2 body radii (or the edge of the atmosphere)
    out to 1.6·10⁸ km.
  * Focus changes animate the origin and distance over 0.9 s.
  * On first entry the camera places itself about 55° off the sun direction, so the day/night terminator shows, and
    it zooms out with a short "whoosh".
* **Focus.** Tab / Shift+Tab cycles: active vessel → its body → that body's moons → parent (and siblings) → Sola.
  Double-clicking a body sphere, dot, label or vessel icon focuses it. The focus bar has ‹ › buttons and a
  "?" help card. A destroyed (or removed) focused vessel falls back **once** to the body it was at (glide 0.9 s);
  destroyed vessels are never a default / Tab / double-click focus.
* **Bodies.**
  * Each body is a sphere with an equirect albedo texture baked from `terrainSample`. A second "aux" texture holds
    slope-derived bump, a gloss/water mask for sun glints, and emissive `glow` for Cinder's lava.
  * Bakes are progressive: 128², then 512², then 1024² (the last only for the focused body or bodies large on
    screen). They run **off the main thread** in a pool of up to two module workers (`src/ui/mapBake.js`, the same
    kernel the fallback uses) and are cached for the whole session in a module-level `BAKES` map.
  * A **boot pre-bake** starts 4 s after `mapView.js` is imported (the flight scene imports it while loading): 128² and
    512² of every body plus 1024² of Verda, so the first map view is already sharp. Idle workers are released after
    20 s and respawned on demand.
  * Every finished bake bumps a module-level `bakeVersion`. Each MapView re-applies `BAKES` in `enter()` and whenever
    its `_texVersion` differs, so a new view (e.g. flight after the tracking station) shows cached bakes at once.
  * Fallbacks: no `Worker` / the worker fails to load or to import `world/terrain.js` → the same kernel runs
    time-sliced on the main thread (5 ms per frame, 7 ms in tracking mode). If `world/terrain.js` cannot be loaded at
    all, a palette-driven fBm fallback sampler is used.
  * Bodies rotate with `rotationQuat`. The launch-site pin lines up exactly with a landed vessel on the pad.
  * Lighting comes from Sola. The terminator is soft, the night side is faint, and specular highlights show on oceans.
  * Bodies with an atmosphere get limb scattering on the surface plus an analytic atmosphere shell. The shell uses
    chord length through the shell × density, with sunset tint at the terminator and forward scattering.
  * Sola is a granulated, limb-darkened disc with an additive glow/ray sprite that stays at least ~70 px wide. The
    glow is toned down when the disc is large.
  * The sphere geometry drops to a lower resolution when a body is small on screen. Sub-pixel bodies are drawn only as
    coloured HTML dots.
* **Labels and icons** are HTML. Label placement is greedy and priority-based (focused body > active vessel > …). Each
  label tries four candidate positions and avoids other labels, marker icons, open marker chips, node icons, the node
  panel and the fixed UI chrome. Distant bodies become coloured dots. Moons are hidden when their orbit collapses onto
  the parent. Vessel icons (ship / probe / debris SVGs) are drawn active-highlighted, target-magenta, or dimmed when
  occluded. Hovering bodies (small ones on the canvas after a short dwell; dots and labels immediately) and vessels
  shows a data tooltip.
* **Orbit lines** use a custom screen-space ribbon (`OrbitLine`):
  * Width is in pixels and edges are anti-aliased. The shader includes the log-depth chunks and handles the near
    plane, so lines passing behind the camera don't flip.
  * Per-vertex attributes: parameter, time and arc length. These drive the fade (a cyclic fade anchored at the
    object, so the line is bright ahead of the object and fades behind it), dashes (with animated crawl and
    perspective-aware spacing), clipping of the already-flown part of open arcs, and dimming of the current path
    after the first node.
  * Geometry is updated in place; buffers are never reallocated.
  * Every body orbit is drawn in its `mapColor`. Every vessel orbit is drawn too: grey, debris dim, target magenta.
  * Lines that are tiny on screen fade out, and so do lines that are absurdly large for the view (for example the
    home planet's heliocentric orbit seen from low orbit).
* **Trajectory of the active vessel** (the selected vessel in tracking mode):
  * The un-maneuvered path is drawn with `predictTrajectory`, one colour per patch, with a glow underlay.
  * The planned path from `nodeTrajectory` is drawn dashed in orange, with a different colour for each later patch.
  * Child-SOI patches are drawn around the child's **current** position, KSP-style. In addition, a ghost ring and
    dot show where the moon will be at the encounter, and a faint SOI ring surrounds the encountered or target body.
  * Trajectories are recomputed at 10 Hz, or immediately on `maneuver:changed`, `soi:change` or vessel events.
  * Measured cost: about 0.3 ms per rebuild and about 0.3 ms median for the whole `update()`, excluding baking.
* **Markers** are HTML. Hovering shows details; clicking pins them.
  * Ap and Pe show altitude and T−, and are hidden on perfectly circular orbits.
  * AN/DN are measured relative to the target's plane when a target in the same SOI exists, otherwise relative to
    the equator when inc > 0.1°. The relative inclination is shown.
  * "Lune encounter · Pe 50.3 km", "Leaving Lune SOI" and "Escape Verda → Sola" markers are always expanded.
  * **Clicking a marker pins it and shows actions** (flight mode, active vessel): **⏩ Warp to** (Ap/Pe/AN/DN/closest
    approach: `flight.warpTo(ut − 50)` = stops 60 s before; encounter / SOI exit: `ut + 30`, the sim stops at the SOI
    change) and **◯ Circularize** (Ap/Pe: `planCircularizeAt`). While warping the marker spins a ring and the button
    becomes **■ Stop warp** (`cancelWarpTo`). Right-click pins too. Hovering says "Click to warp here or circularize".
  * An impact marker is shown, blinking.
  * For a target, a closest-approach pair is shown: our position ("CA", with distance) and the target's position at
    that moment. The search uses 240 samples followed by golden-section refinement. Not shown (nor the target's SOI
    ring) for a target body we are inside or whose SOI the path we will fly (the plan if there are nodes) enters.
  * Trajectory markers and nodes are hidden when their body's SOI is under 60 px, which keeps the system view clean.
* **Maneuver editing** (flight mode, active vessel):
  * Hovering the active trajectory shows a ghost point with its T−. Clicking it opens a "+ Add maneuver" pill.
    Points on the current path before the first node and on the dashed planned path are both valid, so sequential
    nodes can be added.
  * Clicking a node selects it and shows the gizmo. The six SVG handles (prograde/retrograde yellow,
    normal/antinormal purple, radial out/in cyan) sit along the burn-frame axes projected to the screen. Their distance
    from the node shrinks when an axis points at the camera, and they are scaled and dimmed when the axis faces away.
  * Dragging a handle outward adds Δv at a continuous rate: `1.6·(px/20)^2.5` m/s per second, with 3 px dead zone,
    Shift ×0.1. Dragging back past the rest position reverses it.
  * The mouse wheel **always zooms**, also over a handle. **Alt + wheel** over a handle gives ±1 m/s (Shift 0.1,
    Ctrl 10) and floats "+1 m/s · Normal 1.0" next to it; resting on a handle for 350 ms shows a dashed ring and an
    "Alt + wheel ±1 m/s" hint.
  * Dragging the node icon moves it along its own path segment (it stays between its neighbours).
  * Right-clicking a node deletes it, as does the Delete (or Backspace) key.
  * The editor panel is docked at the screen edge away from the node, with a dashed leader line to the node. It shows:
    * Δv total (never wraps: `1,309.0 m/s`, `12.35 km/s` from 10 km/s), burn time (`estimateBurnTime`), and "node in"
      (with burn start and UT in the tooltip);
    * **⏩ Warp** in the header (when the burn starts > 40 s ahead): `flight.warpTo(node.ut − burn/2 − 15)`, like the
      HUD's "Warp to burn"; the node icon spins a ring meanwhile and the button becomes **■ Stop**;
    * numeric prograde / normal / radial inputs with auto-repeating −/+ buttons;
    * a step selector for 0.1 / 1 / 10 / 100 m/s, paired with time steps of 1 s / 10 s / 1 m / 10 m;
    * time ◀ ▶ and ⏮/⏭ one-orbit buttons;
    * delete;
    * an "after the burn" summary: Ap/Pe, "→ Lune encounter · Pe …", "→ Verda · Pe …" when it leaves a moon,
      escape or impact.
  * The panel sits above marker chips (z-index 20).
* **Maneuver planner dock** (flight mode, top-left; collapsible, remembered in `tsp.mapPlannerCollapsed`). Contextual
  one-click plans on the path **after the last node**, so they chain; each creates an ordinary node (selected, so the
  editor opens for fine-tuning):
  * **Circularize at Ap / at Pe** (Δv and T−; amber when the result is inside the atmosphere). At an encounter it
    becomes **Capture at Lune Pe**.
  * **Target card** when the target is a moon of the body the plan orbits: phase angle now / ideal, window T−,
    Hohmann Δv, **Match planes · 6.0°** when tilted > 0.5° (cheaper of AN/DN), and **Plan transfer to Lune** with a
    Pe box (default 30 km on Lune, 10 km on Pip; air bodies: atmosphere + 10 km). The view zooms out to show it.
    A vessel target in the same SOI gets **Match planes** only.
  * **Return to Verda** from a moon orbit, with a Pe box (default 30 km: an aerobraking re-entry).
  * A status line: "✓ Lune encounter · Pe 30.0 km", "✓ Heading for Verda · Pe 30 km", "✕ Impact course…", or a tip
    ("Right-click Lune or Pip → Set as target to plan a transfer").
  * Refresh ≈ 5 Hz costs ≈ 0.03 ms (analytic only); transfer/return searches run on click (≈ 15-60 ms in node).
  * It folds to its header while the node panel is docked on the left.
* **Targeting.** Right-clicking a body or vessel (sphere, dot, label or icon) opens a context menu: Focus view,
  Set/Clear target (this writes `vessel.target = {type, id}` and shows a toast; the body being orbited is disabled),
  and "Switch to" for other vessels in flight mode.
* **Tracking mode** (`mode: 'tracking'`):
  * Left sidebar lists vessels grouped by body (coloured group dots, counts) with situation icons (orbit, arc,
    escape, landed flag, splash, flying, pad) and a situation line (Ap × Pe, "Landed · Lune", …).
  * Ship / Probe / Debris filter chips; debris is hidden by default.
  * Clicking a row selects and focuses that vessel and draws its full trajectory and markers. Double-clicking flies.
  * The selected row shows **▶ Fly** (`onSelectVessel(v)`) and **✕ Terminate**, which asks for confirmation in a modal
    and then calls `flight.removeVessel(v)`.
  * An empty state is shown when no vessels are in flight.
  * Top time bar: UT clock plus 8 warp segments, ■ stop, and the rate. The keys `.`, `,` and `/` work.
  * Optional "⌂ Space Center" button (`onExit`).
  * The view centre is shifted into the free area to the right of the list (camera `filmOffset`).

### `src/game/maneuver.js` (node-importable)
A node is `{ id, ut, dv:{prograde,normal,radial}, targetVel: Vector3|null, bodyId }`. Nodes are kept **sorted by ut**
in `vessel.maneuverNodes`, so `maneuverNodes[0]` is always the next node, which the HUD relies on. Every mutation
emits `maneuver:changed {vessel}`.

**targetVel semantics.** Editing a node computes the pre-burn state at `node.ut` on the trajectory the vessel is
currently on, including earlier nodes. It then stores the planned **post-burn** velocity, relative to `node.bodyId`.
`burnVector` = `targetVel − (velocity at node.ut on the vessel's CURRENT orbit)`. It shrinks to 0 as the burn is flown
(this is tested), however the burn is flown, early or late. Flying never re-plans the node; only editing the node or
an earlier node does.
* `nodeTrajectory` feeds the first node as its **remaining** burn, so the dashed plan stays put while the burn is being
  flown. Later nodes use their burn-frame `dv`. A first node whose time has already passed (burn in progress) is
  represented by starting on its target orbit.
* Removing or retiming a node re-plans every later node from its burn-frame `dv` on the new trajectory.
* The first node's pre-state normally comes from `vessel.orbit`. If the node lies beyond an SOI change, it comes from
  a cached un-maneuvered trajectory. That cache is refreshed when the orbit changes, at most every 100 ms, so SAS and
  the HUD can call `burnVector` every frame cheaply.

## Public API

```js
// src/ui/mapView.js
new MapView(app, { flight, mode: 'flight'|'tracking', onSelectVessel?, onExit?, bakeBudget? })
map.enter(); map.exit(); map.update(dt); map.render(); map.onResize(w, h); map.dispose();
map.focus(bodyIdOrVesselId, { instant = false } = {})   // → bool
map.cycleFocus(dir = 1)                                  // Tab behaviour
map.selectedNodeId, map.selectedVesselId                 // (readable state)

// src/game/maneuver.js
createNode(vessel, ut, dv?, opts?) → node
setNodeDv(vessel, node, dv, opts?)          // recompute targetVel (and later nodes) from the CURRENT trajectory
removeNode(vessel, node, opts?) → bool
burnVector(vessel, node, out?, opts?) → Vector3   // remaining Δv (inertial, node.bodyId frame)
estimateBurnTime(vessel, dv) → s            // dv: number | Vector3 | {prograde,normal,radial}; Infinity if no engine
nodeTrajectory(vessel, opts?) → predictTrajectory patches incl. maneuvers
// extras
setNodeUT(vessel, node, ut, opts?)  clearNodes(vessel)  sortNodes(vessel)  getNextNode(vessel)
nodeState(vessel, node, outPos?, outVel?, opts?) → { bodyId, pos, vel } | null   // pre-burn state at the node
engineStats(vessel) → { thrust (N), mdot (kg/s) }   patchIndexAt(patches, ut)
// opts: { ut } overrides game.ut (tests/tools); nodeTrajectory also takes { maxPatches }.

// planning assistants — never mutate; return a proposal { kind, ut, dv, bodyId, … } or { error }
planningPath(vessel, opts?) → { traj, from, k, ut }        // path after the last node; opts.patches = precomputed
planCircularize(vessel, 'ap'|'pe', opts?)                  // + capture at the next encounter's Pe; { altitude, capture, warning }
planCircularizeAt(vessel, bodyId, orbit, ut)               // circular at a given point of a patch
transferInfo(vessel, targetBodyId, opts?) → { phase, idealPhase, timeToWindow, windowUT, dv, transferTime, relInc, synodic }
planTransfer(vessel, targetBodyId, { desiredPe, ut, patches }?)   // { encounter:{pe,ut,retrograde,impact} } | { error, needsPlanes? }
planMatchPlanes(vessel, targetBodyId | { normal, frame }, opts?)  // { relInc, at:'AN'|'DN' }
planReturn(vessel, { desiredPe, ut, patches }?)             // from a moon: { targetId, arrival:{pe,ut} }
applyPlan(vessel, plan, opts?) → node | null                // createNode(vessel, plan.ut, plan.dv)
defaultArrivalPe(bodyId), defaultReturnPe(bodyId) → m

// src/ui/mapBake.js (map-internal): LEVELS, BakeJob(bodyId, level).step(deadline, sampleFn) → result; module-worker entry
map.bakeStats() → { worker, workers, inFlight, cached, shown, version }   // debug
```

### Deviations from ARCHITECTURE.md
All of these are additive; the contract signatures are unchanged.
* `MapView` accepts two extra constructor options:
  * `onExit`: shows a "⌂ Space Center" button in tracking mode.
  * `bakeBudget`: milliseconds per frame for texture baking.
* `focus()` takes an optional second argument, `{ instant }`.
* The maneuver functions take optional trailing `dv` / `opts` arguments.
* There are extra exports, listed above (including the planning assistants and the new file `src/ui/mapBake.js`,
  which is map-internal and also loaded as a module worker).
* `estimateBurnTime`:
  * accepts vectors and dv objects as well as numbers;
  * returns `Infinity` when there is no usable engine;
  * continues into later stages via `vessel.getStages()` when `telemetry.stageDeltaV` is exceeded.
  * Engines used are the active ones that have not flamed out; if none are active, the next stage's engines
    (`part.stage === currentStage − 1`). Isp is taken at the current `telemetry.staticPressure`.
* `node.targetVel` is a `THREE.Vector3`. After JSON round-trips a plain `{x,y,z}` still works, and it is upgraded
  again on the next edit. Nodes carry no hidden fields.

## How to test

* `node tools/run-tests.mjs maneuver` runs `tests/maneuver.test.mjs`, 17 tests. They cover:
  * creation and sorting, and the `maneuver:changed` event;
  * burn-frame components;
  * **instant burn → remaining ≈ 0**, partial burn → the rest remains, and an early burn converges;
  * retime keeps dv; second-node planning and re-planning;
  * a Lune encounter found from a 100 km orbit;
  * the rocket equation, multi-engine and next-stage cases, and multi-stage continuation;
  * the planners: circularize a sub-orbital ascent exactly (e < 1e-6), error cases, transfer info (110.7°, 842 m/s),
    the whole Lune trip (transfer Pe 30 ± 2 km → capture → return Pe 30 km for < 320 m/s), plane matching to Pip
    then a Pip encounter, circularize at an arbitrary point.
* `node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/maneuver_e2e_map.mjs --out shots/map_e2e_end.png`
  (≈ 6 min in SwiftShader): real game, lune playtest saves. Tracking bakes → Fly → M shows them at once; Ap marker →
  Circularize; Pe marker → Warp to / Stop; planner transfer (real click) → Pe ≈ 30 km → capture; plain wheel on a
  handle zooms, Alt + wheel edits with feedback; node panel warp / stop; Lune orbit + Lune target: no closest
  approach, readable DN, Return to Verda → Pe 30 km. Prints PASS/FAIL per check (`shots/map_e2e_*.png`).
* `node tools/snap.mjs "tests/map.html?select=1" --out shots/map_x.png --wait 9000` runs the standalone page with the
  real orbit/universe/terrain modules and a mock FlightSim. The scene has: Tiny Explorer in a 100 km Verda orbit with
  an auto-searched Lune-encounter node (Pe ≈ 50 km), a relay probe, debris, a Pip probe, a Rusta probe and a Lune
  base. URL parameters:
  * `mode=tracking`;
  * `focus=`, `dist=`, `yaw=`, `pitch=`;
  * `select=1` opens the gizmo and panel;
  * `nonode=1`;
  * `target=<body|vessel name>`;
  * `scenario=suborbital|escape|lune|pad`;
  * `empty=1`;
  * `ut=`, `warp=`, `freeze=1`.

  Globals: `window.map`, `window.flight`, `window.__testReady` (set after setup and baking). The page logs a
  console error if the camera or origin ever becomes NaN.
* Screenshots are in `shots/map_*.png`:
  * `hero`, `hero_1080`, `mid`, `system`, `lune`, `sola`, `target`, `tracking`, `tracking_empty`;
  * `sc_*` (the scenarios);
  * `i1…i8` (hover → pill → node → handle drag → plan → pinned marker → context menu → Tab focus);
  * `n1/n2` (retime by drag, a second node on the plan);
  * `t1…t3` (tracking select, warp, terminate confirmation).

## Known issues / limits
* Dashes use arc length along the whole patch, scaled by the mean camera distance. On strongly foreshortened patches
  the far end looks dotted rather than dashed.
* Heliocentric orbits are sampled with 360 points. When zoomed right in, they are faded out rather than resampled
  adaptively.
* Handles can overlap when a burn axis points straight at the camera, as in KSP; rotating the view separates them.
  Their minimum radius is 30 px.
* Bakes are per session (not persisted, e.g. in IndexedDB): the workers need ≈ 1.5 s for everything after a page load,
  and the boot pre-bake hides that. A cache across page loads would need a terrain-version key to stay correct.
* The planners only handle moons of the body the plan orbits (Verda → Lune / Pip, Rusta → Nib) and the way back.
  Interplanetary transfers (ejection angles) are still planned by hand; the target card then stays hidden.
* The tracking station has no "Warp to" on markers (its facade has no `warpTo`); only flight mode does.
* `tracking.js` is listed as map-owned by the playtest task, but ARCHITECTURE.md gives it to shell and
  `notes/integration.md` to integration, so it was not touched this round (to avoid concurrent edits).
* The first time the interaction script ran, the headless test run once rendered a black frame with NaN projections.
  It could not be reproduced afterwards (more than 10 runs). `update()` now guards against non-finite camera, origin
  and dt values, and the test page reports any recurrence.

## Integration notes (for the flight scene / shell)
* **Flight scene:**
  * Create the map once: `this.map = new MapView(app, { flight, mode: 'flight', onSelectVessel: (v) => flight.setActive(v) })`.
    `onSelectVessel` backs "Switch to"; without it the map calls `flight.setActive` itself.
  * On **M**: `map.enter()` together with `hud.setMapMode(true)`, or `map.exit()` together with `hud.setMapMode(false)`.
  * While the map is active, keep calling `flight.update(dt)` and `hud.update(dt)`, then `map.update(dt)` and
    `map.render()` **instead of** the flight render.
  * Forward `onResize(w, h)`. Call `map.dispose()` in the scene's `exit()`.
  * `enter()` is idempotent. In flight mode the overlay is inserted as the *first* child of `app.uiRoot`, so the HUD
    stays on top.
* The map listens on `app.canvas` for pointer events, dblclick, wheel and contextmenu. **Disable the flight camera
  controller's mouse input while the map is active**, otherwise right-drag and wheel also move the flight camera
  behind the map.
* The map consumes only **Tab** and **Delete/Backspace** (plus `.` `,` `/` in tracking mode). All other flight keys
  keep working. Keys typed in the panel's number inputs are ignored by `input.js`.
* **Tracking scene:**
  * `new MapView(app, { flight: game.flight, mode: 'tracking', onSelectVessel: (v) => app.goto('flight', { vesselId: v.id }), onExit: () => app.goto('spacecenter') })`.
  * The scene must call `flight.update(dt)` itself so warp and time advance; the map only calls `flight.setWarp(i)`
    and shows `flight.warp`.
* Vessel positions use `vessel.pos`, or `landedAt.fixedPos` rotated by `rotationQuat` for
  LANDED/SPLASHED/PRELAUNCH vessels. Orbits come from `vessel.orbit`; in-place mutation, as with
  `setFromStateVectors`, is fine because the map compares element snapshots.
* SAS maneuver mode and the HUD should use `burnVector(vessel, vessel.maneuverNodes[0], out)` and
  `estimateBurnTime(vessel, remaining)`. Both are cheap enough to call every frame.
* A HUD "Circularize" button (e.g. in the orbit panel when sub-orbital with Ap above the atmosphere) can do
  `const p = planCircularize(v, 'ap'); if (!p.error) applyPlan(v, p);` (≈ 0.2-1 ms) — the map shows the node.
* The map drives `flight.warpTo(ut)` / `flight.cancelWarpTo()` / `flight.warpTarget` for its warp buttons.
* The debug hook `window.TSP.map` is set while the map is entered.

## Changelog — playtest round 2
* **Major · bakes after a second MapView:** the flight map after the tracking station left every body on its flat 1×1
  colour. Cause: cached bakes were only applied when a *new* bake finished. Now `enter()` and every frame
  (`_texVersion !== bakeVersion`) apply them. Verified with `pt_lune_14_mapbake.mjs` (flight texLevels = tracking's).
* **Major · empty map after the active vessel is destroyed:** `_defaultFocus` returned the destroyed vessel, so the
  focus glide restarted every frame at the root origin. Now the fallback is the wreck's body, applied once.
* **Minor · wheel edited the maneuver:** the wheel over a gizmo handle now always zooms; Alt + wheel edits, with a
  hover hint and a floating "+1 m/s" readout. (A hover-dwell rule was tried first, but a scripted 200 ms pause
  was already 880 ms of page time under SwiftShader, so any dwell threshold is guesswork.) `pt_lune_15` now zooms
  2760 → 10257 km with Δv unchanged.
* **Minor · DN label invisible:** `.mk-dn .mk-icon` now uses `color: var(--c)`.
* **Minor · closest approach inside the target's SOI:** suppressed (and the target SOI ring) while inside or when
  the flown path enters it.
* **Polish · "m/s" wrapped at ≥ 1,000 m/s:** wider first column, no-wrap values, smaller unit, km/s from 10 km/s.
* Also: marker chips no longer draw over the node panel; the after-burn line names the body a moon exit leads to.
* **Improvements:** worker bakes + boot pre-bake (0 ms of main-thread baking); maneuver planner dock
  (circularize / capture, transfer window + plan transfer, match planes, return home); marker actions (warp to,
  circularize); node-panel warp to burn.
