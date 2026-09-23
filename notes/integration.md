# Integration: flight scene, tracking station, end-to-end loop

Owner files: `src/scenes/flightScene.js`, `src/scenes/flight/*` (`session.js`, `vesselViews.js`, `flightInput.js`, `post.js`,
`hints.js`, `warpStep.js`, `flight.css`), `src/main.js`, `index.html`, the core files (`src/core/*`, `src/data/bodies.js`,
non-visual stats in `src/data/parts.js`, `src/game/input.js`, `src/ui/dom.js`, `toast.js`, `base.css`),
`tests/integration.test.mjs`, `tests/e2e_*.mjs`, this file. (`src/scenes/tracking.js` was built here but is now shell's.)

## What was built

### Flight scene (`src/scenes/flightScene.js`)
The Scene contract (ARCHITECTURE §7) wired to every area:

| Piece | Source | Notes |
|---|---|---|
| universe | `game.flight` (existing) → `loadUniverse(FlightSim)` → `new FlightSim(game)` | `setWarp(0)` on enter |
| world | `app.getShared('planets', …)` PlanetSystem | root added on enter, removed on exit; `shadowExtent` = 2.6 × vessel radius (≥ 60 m around the pad so the tower shadows), restored on exit; `prewarm(…, 2200 ms)` during enter |
| space center | `getSharedKSC(app)` in `planets.bodyFixedGroup('verda')` at `kscTransform()` | `setEnvMap(planets.envMap)`, `ksc.update(dt, {night})` from `kscSunDirection`; hidden beyond 160 km; detached on exit (never disposed) |
| vessels | `VesselViews` → one parts3d `VesselRenderer` per vessel within `RENDER_RANGE` | see below |
| effects / audio | `Effects(scene)`, `audio.setScene('flight'|'map')`, `audio.updateFromFlight(dt, flight, {cameraDist})`, `audio.pauseAll(game.paused)` | loaded with defensive dynamic imports (a broken optional module degrades the scene, it never breaks it) |
| HUD | `new FlightHUD(app, { flight, onMapToggle, onPause, onRecover })` | `setMapMode`, `setVisible` (F2), `showMessage` for LIFTOFF / STAGE n / SAS ON… |
| map | `new MapView(app, { flight, mode:'flight', onSelectVessel })`, created on the first M | while open: `map.update/render` replace the 3D render, physics/HUD keep running, `FlightCamera.enabled = false` (no mouse), V is ignored |
| camera | shell `FlightCamera(camera, canvas, { input: gated proxy })` | shake = `fx.cameraShake()`; size = 2 × framing radius (`boundingRadius`, grown while a parachute is out); launch framing from the south-south-east with the tower on the right; state remembered per vessel across re-entries; after `cam.update` the scene keeps the camera out of KSC buildings and ≥ 1.5 m above the terrain under the camera; wreck cam (below) |
| missions | `getMissions().update(flight)` each frame (also inside `fastForward`) | |
| crew | `crew.snapshotRoster()` + `crew.assignCrew(craft)` at launch, `crew.restoreRoster` on revert, `crew.recoverCrew` on recovery; deaths are automatic (crew.js listens to `part:destroyed`) | |
| persistence | `packAll()` + `saveUniverse()` on exit, F5 `quicksave()`, F9 `quickload(FlightSim)` | |
| post | `FlightPost`: EffectComposer → RenderPass → HDR sanitize → UnrealBloom (threshold 1, strength 0.32) → OutputPass | reacts to `settings:changed` (bloom); off = direct render |

**enter(params)**
* `{craft}` — new launch. The revert snapshot (`flight.serialize()` + `crew.snapshotRoster()` + `ut`) is taken **before**
  `flight.launch(craft, {crew})`. `game.lastLaunchCraft = clone(craft)`. Invalid craft (not an object with parts, or
  `Vessel.fromCraft` throws) → toast + back to the VAB (with the craft when it has parts); the roster is restored.
* `{resume:true}` — the active vessel, else the first non-debris vessel; none → toast + space center.
* `{vesselId}` — `flight.setActive(v)`; unknown id → toast + tracking station. Revert is dropped when it was for another vessel.
* A bail-out builds an inert scene (clears the canvas) and runs `app.goto` on its first update (enter itself runs inside
  `app.goto`, which ignores nested switches). If enter throws halfway, it cleans up after itself before rethrowing.

**Frame order** (`update(dt)` → `_frame(dt, full)`):
1. keyboard → vessel controls / scene actions (`FlightInput`, disabled while a modal is open, paused, or switching)
2. `flight.update(dt)`; `missions.update(flight)`
3. camera pivot = floating origin (`this._pivot = {bodyId, pos}`, passed to `views.place` as the anchor): the active
   vessel's CoM, + the parachute framing offset while a canopy is out; for a destroyed active vessel the wreck site
   (see "Wreck cam"). `origin = bodyPosition(pivot.bodyId, ut) + pivot.pos` (root frame). `this.anchor` stays the vessel.
4. `views.place(…)` (create/dispose/position renderers) → `fx.update(simDt, {flight, originRootPos, camera, ut})`
5. `cam.update(dt, {up, vesselRot, vesselSize, velocityDir, speed, normal, radarAltitude (of the pivot), shake})` →
   `_clampCameraToBuildings` → `_clampCameraToGround`
6. `planets.update(camera, origin, ut)` (after the final camera pose) → KSC → `views.animate(simDt, …)` (plumes, chutes…)
7. HUD, map (when open), audio, tutorial hints, crew manifest cache, destroyed-vessel timer.
`fastForward` runs 1–4 per chunk (no camera/planets/HUD/render). No per-frame allocations in this loop (all params
objects and vectors are reused).

**Flows**
* **Pause (Esc / HUD ⏸)** → `openPauseMenu`: Resume · Quicksave · Quickload (when a quicksave exists) · Revert to Launch /
  Revert to VAB (when a revert snapshot exists; VAB also with only `lastLaunchCraft`) · Recover (LANDED/SPLASHED/PRELAUNCH
  on Verda; "scrub launch" on the pad) · Space Center · Settings · Help. `game.paused` is set by the menu; audio follows.
* **Revert to Launch**: `FlightSim.deserialize(snapshot)` → `game.flight`, `game.ut`, roster **and `game.progress`**
  (milestones + stats, restored in place, `saveProgress()`, then `missions._rebuildPending()` so undone milestones can be
  earned again) → `app.goto('flight', {craft})` (exit skips `packAll` for the fresh sim). **Revert to VAB**: same restore →
  `app.goto('vab', {craft})`. Like KSP, a reverted flight leaves no trace (no "RUD", no launch count).
* **Quickload (F9)**: `quickload(FlightSim)` → `game.flight = sim` → `app.goto('flight', {resume:true})` (exact state, no pack).
* **Space Center**: if the vessel is flying in / falling back into an atmosphere a confirm dialog warns that unattended
  vessels in the air are lost (that is what `updateRails` does in the space center / tracking station).
* **Destroyed active vessel** (`vessel:destroyed` or polling `active.destroyed`): warp stops, wreck cam + slow motion,
  after 2.5 s of (real) game frames `openFlightResults(describeFlight(v, {outcome:'destroyed'}))` with Revert to Launch /
  Revert to VAB / Space Center / Keep watching. The subtitle names the cause and the first row is its number — "Flea Hopper
  lithobraked into Verda at 166 m/s" / "hit the water at …" / "burned up at 34 km doing …" / "was torn apart by the
  airflow at …" (from the first `part:destroyed` of the final break-up chain and the last telemetry before it). Crew chips
  come from a manifest cache (part:destroyed removes the dead from `vessel.crew`), status from the roster (K.I.A.).
* **Wreck cam** (`_startWreck`). A destroyed vessel's last CoM is fixed in the *inertial* frame, so the ground slid away
  under it at ω×r (≈ 175 m/s at the launch site) taking the fireball and the smoke (advected with the air) out of frame, and
  after a fast impact it was metres underground; the camera also lost its ground clamp (radarAltitude was null). Now the
  pivot freezes at the wreck site in the **body-fixed** frame, lifted to ≥ ground + 2.5 m, with a finite radar altitude
  (the FlightCamera ground clamp and pitch limit stay on). The camera switches to 'auto' (silently, keeping its view
  direction), pulls back to max(current, 8 R clamped to 32…180 m) at a raised pitch (≥ 0.32 rad) and circles the site at
  0.16 rad/s until the player drags. Physics has no building collisions and the Flea Hopper's natural landing spot is the
  VAB's east facade (x ≈ −291 m in the launch-site frame): a pivot inside a KSC building (the space center's hitboxes of
  the VAB / tracking station / mission control / astronaut complex; not the pad) is moved out through the nearest wall or
  the roof, and near a wall (< 30 m) the camera looks from the open side (pitch ≥ 0.45) and sways ±0.4 rad instead of
  circling through the building. Time runs at 0.3× for 0.45 s, easing back to 1× by 1.7 s (real time; physics, particles
  and renderer animation are scaled, camera/HUD/audio/timers are not).
* **Parachute framing** (`_updateChuteFraming`). The canopy (lines 1.65 R + dome 0.62 R ≈ 16 m for the Mk16, reefed
  streamer 0.72 of that) is renderer-only, not in `boundingRadius`, so the default camera framed the 1 m capsule and only
  the risers were visible. While a chute is semi/deployed the pivot slides 30 % of the way toward the canopy (along the
  airflow, smoothed at 2.2/s) and the framing radius grows to 0.8 × the stack's extent (smoothed at 3/s), so FlightCamera's
  minDistance pulls the camera back by itself; after the chute is cut both relax back. HUD messages: CHUTE SEMI-DEPLOYED /
  CHUTE DEPLOYED / CHUTE RIPPED — TOO FAST!
* **Warp keys** (`flight/warpStep.js`, `stepWarp(flight, ±1)`): one ladder physics 1×–4× → rails 5×, 10×…. FlightSim's
  `warp.index` is per mode, so `setWarp(index ± 1)` jumped from 4× physics to 10× (',') / 50× ('.') rails above 70 km.
  Physics mode: ',' → previous physics level, '.' → rails 5× where rails warp is legal (`railsWarpAllowed` mirrors
  `FlightSim.setWarp`'s rules; `flight.canRailsWarp()` is used if physics ever adds it) else the next physics level, and at
  4× `setWarp(4)` so FlightSim explains the refusal. Rails / 1×: unchanged (`setWarp(index ± 1)`).
* **No control**: `FlightInput` ignores throttle / SAS / RCS / gear / brakes / lights / axes on a vessel with
  `controllable === false` (debris, dead probe) and the scene shows NO CONTROL when such a key is pressed.
* **Recovery** (HUD button or pause menu): `flight.recover(v)` → `crew.recoverCrew(v, r)` → results ("Welcome Home!",
  recovered value) → Space Center / Build another.
* Feedback: `LIFTOFF!`, `STAGE n`, `NO MORE STAGES`, `NO CONTROL`, SAS/RCS/gear/brakes/lights on/off, precision control,
  chute states via `hud.showMessage`; SOI changes are announced by the HUD only (the scene's extra toast was dropped: it was
  the third announcement and covered the HUD message); first-flight tutorial hints (launch → SAS → gravity turn → map →
  warp → chute → recover), one at a time, the most advanced relevant one wins, each shown once (menus remembers them).

### Helper modules (`src/scenes/flight/`)
* `vesselViews.js` — `VesselViews.place(flight, ut, anchor)` / `.animate(dt, flight, camera, ut)`. Positions are differenced
  in the body frame first (`v.pos − anchor.pos`, plus the body offset only across SOIs), then
  `group.position = rel − rot·comLocal`, `group.quaternion = rot` (contract §5). Create within `RENDER_RANGE`, dispose
  beyond 1.1 × (hysteresis) or when the vessel leaves `flight.vessels`; `sync()` when `topologyVersion` changes. Only the
  active vessel gets `{ lights: true }` (budgeted engine light); switching rebuilds the two affected renderers. Pressure for
  non-active renderers comes from `pressureAt(alt)` (their telemetry is stale).
* `flightInput.js` — allocation-free equivalent of physics' `applyFlightInput` (same `FLIGHT_KEYS`, `THROTTLE_RATE`), plus
  Esc/F1/F2 scene actions. Axes are only written when they change. CapsLock precision follows the real lock state
  (`getModifierState`) because macOS sends keydown only when the lock turns on. Uncontrollable vessel → no commands,
  `actions.noControl`.
* `warpStep.js` — `stepWarp(flight, dir)`, `railsWarpAllowed(flight)` (node-importable; see "Warp keys").
* `post.js` — composer + **HDR sanitize pass**: zeroes NaN/Inf and clamps to 10 before the bloom. UnrealBloomPass truncates
  its Gaussians at 1σ, so single very bright pixels (sub-pixel sea glints, sparks) bloomed into visible squares and a
  non-finite pixel into a solid white square; after ACES everything above ~8 is white anyway. MSAA 4× (2× above 1.5 DPR).
  NaN/Inf are detected from the exponent bits (`floatBitsToUint(c) & 0x7f800000u == 0x7f800000u`): `isnan()`/`isinf()`
  reported compiled away (fast-math drivers) and `clamp(NaN)` is undefined. `tests/e2e_nan_bloom.mjs` pushes a float
  texture with NaN / ±Inf / 1e30 texels through the pass and renders a NaN quad through the composer: on the local
  SwiftShader build both the old and the new test remove them, and the Pip night side no longer renders any NaN (worlds
  fixed the source), so the playtest's white stars could not be reproduced any more — the bit test is the portable
  version. `SanitizeShader` is exported for that test.
* `hints.js` — the first-flight tutorial (`HINTS`, `pickHint`, `hintHTML`, `hintPlainText` are exported for tests):
  - context: ascent tips (SAS, gravity turn, map) only for a vessel seen on the pad during this visit and still climbing
    out of the home atmosphere (not in orbit, not coming home under a chute); the warp tip has an ascent-coast and an
    in-orbit wording and is not shown while a maneuver node is planned (resumed / Tracking-Station vessels in orbit used to
    get "cut the engine at 80 km" and "burn until your periapsis leaves the atmosphere");
  - retirement: immediately when the tip was acted on (`done`: launched, SAS on, Ap ≥ 80 km with the engine off, warped,
    chute staged), after 6 s when it no longer applies, and at once when the vessel is destroyed / recovered or a results
    dialog opens (a crash's tip is not remembered, so it can help next flight);
  - keys are written `{Key}` and rendered as `<kbd class="tsp-kbd">` chips in the card (plain-text fallback
    ". (period)"); the delay is handled here (not by menus) so the card exists when it is decorated;
  - space-center / tracking / VAB tip cards whose delayed timers fire after the switch into flight are removed;
  - `layout()` measures the HUD's `.hud-top-left` bottom and `.hud-bottom-left` top every 0.5 s into
    `--fl-hints-top` / `--fl-hints-max` on `#ui-root`, and toggles `#ui-root.fl-map` while the map is open.
* `session.js` — module-level state that survives re-entries (revert snapshot incl. progress, per-vessel camera state).
* `flight.css` — overlay (screenshot flash), F2 hides hints/toasts too. Tutorial hints: 3D view → LEFT column between the
  HUD's resources panel and staging stack (the right column holds the orbit + maneuver panels; the cards used to cover
  "Warp to burn"); map view → bottom-right corner (the map's planner, focus bar and node editor take the other sides, the
  HUD hides the crew portraits). Key chips styled. Toasts at `calc(32.5vh + 10px)`: below the HUD's big centred message
  (top 26 %) so both can be read.

### Tracking station (`src/scenes/tracking.js`)
`MapView` in `'tracking'` mode over a tiny facade (`vessels`, `warp`, `setWarp → FlightSim.setRailsWarp`, `removeVessel`,
`active = null`), so rails warp never depends on an "active" vessel. Every frame `flight.updateRails(dt)`; `packAll()` +
warp reset on enter, warp reset + `saveUniverse()` on exit. Fly → `app.goto('flight', {vesselId})`, ⌂ → space center.
Zero vessels: the map's empty state + a tutorial hint; time and warp still work. `audio.setScene('tracking')`.
Debug: `window.TSP.tracking = { scene, map, fly(id), vessels(), warp(i) }`.

### App shell / core (`src/main.js`, `src/core/state.js`, `src/data/parts.js`)
* `main.js`: graphics quality is app-wide — a `settings:changed` 'graphics' listener and a sync before every scene's
  `enter` call `PlanetSystem.setQuality(settings.graphics)` on the shared planets (a no-op when unchanged). The space
  center used to rebuild only its bloom, so Low never reached the terrain (the flight scene also syncs before prewarm).
  Main-loop `dt` is clamped to ≥ 0 (a rAF timestamp can precede the constructor's `performance.now()`; `app.time` went
  negative). An unknown `?craft=` id is a warning + toast, not an app error.
* `state.js`: `sanitizeSettings(stored)` merges stored settings key by key, keeping only values of the default's type
  (numbers finite and clamped to the dialog's ranges, `graphics` from its list). `mouseSensitivity: "fast"` made the camera
  NaN (black view) and broke the settings dialog. (Shell's `persistence.validateStoredData` checks the same afterwards.)
* `parts.js`: `chute_mk16.fullArea` 350 → 425 m² — the stock Orbiter I capsule (pod + heat shield, 1.28 t) now lands at
  ≈ 6.9–7.0 m/s (was 7.6–7.8); a bare 0.98 t pod lands at 6.10 m/s (flight.test's 6–7.2 window). Reefing unchanged.

## Debug / test hooks — `window.TSP.flightScene`
`{ scene, flight, vessel(), hud, map, camera (FlightCamera), threeCamera, fx, views, fastForward(simSeconds, { step = 0.1,
onStep(vessel, scene), until(vessel) }), summary(), toggleMap(on?), stage(), pause(), recover(), screenshot(), renderInfo() }`.
`fastForward` steps physics in `step`-second chunks (big chunks on rails warp), keeps origin/renderers/particles in sync,
runs missions, returns `summary()` (altitude, Ap/Pe, speeds, pitch/heading, stage, parts, vessels, renderers, smoke count…).

## Cross-area edits
| File | What | Why |
|---|---|---|
| `src/physics/flight.js` | added public `FlightSim.updateRails(realDt)` and `FlightSim.setRailsWarp(index)` (no other change) | the space center called the private `_railsUpdate` (it now picks up `updateRails` automatically through its existing lookup, no edit to spaceCenter.js); the tracking station needs rails warp without an active vessel. `updateRails` packs anything still loaded, clears `warpTo`, and runs the rails step with `active = null` so every vessel follows the unattended rules (SOI hand-off on rails, lost when it dives into an atmosphere / hits an airless body) and nothing clamps the warp; the active reference is restored afterwards (unless that vessel was lost). This also fixes a stall: with a sub-orbital active vessel the private step stopped at the atmosphere crossing every frame. Tested in `tests/integration.test.mjs`. |

No other area's file was modified (this round: none).

## How to test
```
node tools/run-tests.mjs integration          # updateRails / setRailsWarp, session helpers, warp ladder, settings sanitizing,
                                              # hint context + retirement, no-control input (12 tests)
node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --script tests/e2e_crash_cam.mjs --out shots/int_crashcam_end.png
    # 250 m/s nose-down crash: camera height above the terrain under it (min ≈ 6 m), pivot 2.5 m above ground, wreck cam
    # pull-back / circling / slow-mo, hints gone, crash report cause → shots/int_crashcam_*.png
node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --script tests/e2e_chute_cam.mjs --out shots/int_chute_end.png
    # capsule dropped at sea, Mk16: canopy on screen with the default camera (semi + full), touchdown ≈ 6.9 m/s
node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --script tests/e2e_hint_layout.mjs --out shots/int_hints_end.png
    # in-orbit warp tip (kbd chips) in the left column, "Warp to burn" uncovered + clickable, map view → bottom-right
node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --script tests/e2e_nan_bloom.mjs --out shots/int_nan_end.png
    # sanitize pass on NaN / ±Inf texels (non-finite outputs must be 0) + a NaN quad through the composer
node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 12000 --out shots/int_pad.png
node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 9000 --script tests/e2e_flight_smoke.mjs --out shots/e2e_flight_end.png
    # Z + Space, SAS (T) + scripted gravity turn (sasMode 'direction'), liftoff (plume + trail + pad clouds, F2), T+20 s,
    # booster separation (debris rendered), ] / [ switching, V camera modes, F1, 40 km, M map → shots/e2e_*.png
node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 4000 --script tests/e2e_shell_flow.mjs --out shots/e2e_flow_end.png
    # space center → Launch Pad dialog → Orbiter I → flight → F5 / F9 (state restored) → orbit → Esc → Space Center →
    # Tracking lists it → Fly (ORBITING) → Esc → Revert to VAB (universe empty again, craft in the VAB) → VAB Launch →
    # crash (fast-forwarded fall) → results → Revert to Launch (pad, crew deaths undone) → shots/e2e_flow_*.png
node tools/snap.mjs "index.html?scene=flight&craft=flea_hopper&debug=1" --wait 8000 --script tests/e2e_recover.mjs --out shots/e2e_recover_end.png
    # hop to 9 km, decouple, chute, touchdown, HUD "Recover vessel" → "Welcome Home!" → space center
node tools/snap.mjs "index.html?scene=tracking&debug=1" --wait 9000 --out shots/int_tracking_empty.png
```
All of the above run with zero console errors (each e2e step also checks `TSP.app.errors`).

Screenshots (latest): `shots/int_pad.png` (pad, tower, KSC, HUD), `shots/int_pad_1080_lander.png`, `shots/e2e_liftoff.png`
(plume + trail + pad clouds), `e2e_climb.png`, `e2e_boosters.png`, `e2e_switch.png` (debris), `e2e_40km.png`, `e2e_map.png`,
`e2e_flow_1…9_*.png` (pad dialog → flight → orbit → pause → tracking → fly → VAB → crash report → reverted),
`e2e_recover_1_landed.png` / `_2_report.png`, `int_night_pad.png` / `int_night_liftoff.png`, `int_orbit_*.png` (rails warp,
chase camera), `int_tracking_empty.png`, `int_sc_with_vessel.png`.

## Known issues / notes for other areas
* Headless SwiftShader renders the flight scene at 1–12 fps (right after an explosion or a teleport it can drop to ~1 fps
  while shaders/terrain chunks are built). The results dialog waits 2.5 s of *game frames* (dt ≤ 0.1), so in headless runs it can
  take much longer in wall-clock time. CPU cost per frame measured in Chrome: update ≈ 2 ms (physics 0.4, HUD 0.9, fx 0.1,
  planets 0.3 ms), render submission ≈ 2 ms.
* Night launches: once the rocket climbs away from the pad floodlights its upper stages are nearly black (lit only by the
  engine light, the night env map and the planets' hemisphere light). Physically plausible; a faint fill could be added.
* The shell's toasts stack downward from 32.5vh during flight: four milestones at once (e.g. after the debug `orbit()`
  teleport) cover the middle of the screen for a few seconds.
* Wreck cam next to scenery that is not a building hitbox (the crawler parked at the VAB door, trees) can still sit between
  the camera and the fireball for a moment; only the KSC hitboxes and the terrain are collision-checked.
* The fireball / smoke / shards of an explosion inherit the vessel velocity (fx), so after a 250 m/s impact the fireball
  streaks away from the (now fixed) wreck site; requested from fx (see the playtest round's cross-area requests).
* After the debug `TSP.physics.orbit()` teleport with the Hammer SRBs still burning, dashed particle streaks trail the plumes at
  orbital speed (fx particles spawned along the path; not seen in normal flight). The space center's bloom composer
  (`spaceCenter.js`) has no HDR sanitize pass, so the square bloom artifacts described above can appear there too.
* A scripted pitch program that starts abruptly at max Q (≈ 6 km, 75 kPa) can make Orbiter I lose attitude; starting the
  gravity turn at liftoff (as the e2e test now does) is stable. Physics behaviour, noted for the physics area.
* The revert snapshot and `game.lastLaunchCraft` live in memory only (like KSP's revert): after a page reload both revert
  buttons are disabled for a resumed flight.
