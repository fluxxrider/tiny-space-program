# Playtest: "robust" (try to break it, measure it)

Tester: robustness playtest agent · Scripts: `tests/playtest/pt_robust_*.mjs` · Shots: `shots/pt_robust_*.png`
Host note: 18-core Mac, but shared with 6-8 other headless playtests (load average 50-200). Every perf number below
is SwiftShader + heavy contention, so read absolute ms as upper bounds. Draw calls, triangles and growth figures are
not affected by the load.

## TL;DR
The normal abuse paths hold up well. None of these produced a console error or `TSP.app.errors` entry: Space spam on
the pad (one press per frame stages all 5 stages in 4 frames), rails warp on the pad, 4× physics warp in the atmosphere
(with the denial toast), F5 then F9 ×6 / ×4 (including while a scene was loading), F9 mid-explosion, `]`/`[` spam,
M mid-explosion, SOI exit at 10000× with the map open, leaving mid-wreck, flying a debris piece from the tracking
station, revert after quickload, reloading mid-orbit and resuming, window resizes (800×600 up to 1920×1080), 5 full
scene round trips with no resource growth, and audio (mute/unmute, pause, scene switches, tab hidden).

Found:
* The crew roster leaks. Tinynauts stay "ON MISSION" forever when their vessel is removed without a part being
  destroyed: pad cleared by a new rollout, Terminate, or a vessel lost unattended in the atmosphere. After 4 rollouts
  the roster shows *5 Tinynauts · 0 ready to fly* and a recruit gets auto-hired.
* After a crash the chase camera sits under the terrain: measured 7.9 m below ground, 29 m after a drag.
* The map is empty after the active vessel is destroyed: no planet, focus "—".
* Several kinds of corrupt `localStorage` data brick the game or leave broken UI (the space center won't open, the
  camera goes NaN, the settings dialog throws, a hint can't be dismissed, VAB Load throws). A quickload of a bad save
  silently deletes the current flight.
* Smaller issues: SAS and throttle toggle on an uncontrollable vessel, a tutorial hint stays up over the crash report,
  and the mini orbit diagram overflows its panel on high orbits.

## Bugs (verified at least twice unless noted)

### 1. MAJOR · shell (crew.js) + physics (flight.js): crew stay "assigned" when their vessel disappears
**Repro:** `tests/playtest/pt_robust_crew.mjs`, and step 4 of `pt_robust_verify.mjs`.
* **4 rollouts** (Launch Pad, then Space Center, repeated, never launching): the roster is
  `Zeb/Wendle/Bobbi/Nova: assigned@Orbiter I`, but only one vessel exists (Bobbi's).
* **Tracking station ✕ Terminate** on that vessel: all 4 are still assigned. The next launch hires *Nelra Tinyman*
  ("volunteered to fill an empty seat!").
* **Crewed Orbiter I left at ~5 km** (Esc, Space Center, "Leave"): the vessel is lost (`vessels: []`), but Zeb stays
  `assigned@Orbiter I` and the memorial is empty. On the next page load `reconcileAssignments` releases him as
  *available*, so the dead pilot comes back.

**Evidence:** `shots/pt_robust_G5_astronauts.png` shows "5 Tinynauts · 0 ready to fly", every card "Currently aboard
Orbiter I.", and IN FLIGHT 1. Also `pt_robust_V7_orbit_12000000.png`, where Nova now pilots because Zeb is still
"on mission".

**Cause:**
* `FlightSim.launch()` clears the pad with `removeVessel()` (`src/physics/flight.js` ~64-73).
* `_confirmTerminate` in `src/ui/mapView.js` (~3005) also calls `removeVessel()`.
* The unattended-loss branch of `_propagateRails` (`flight.js` ~533-541) sets `destroyed` and emits
  `vessel:destroyed`, but no crew event.
* `crew.js` only listens to `part:destroyed` (`trackCrewEvents`).

**Fix:**
* In `crew.js`, subscribe to `vessel:removed` and call `releaseCrew(v.crew)` for pad-clear and terminate. Do this
  after `recoverCrew` has run, or skip vessels flagged as recovered.
* Subscribe to `vessel:destroyed` for vessels whose crew list is still populated and call `markLost(v.crew, { cause:
  "Lost in X's atmosphere" })`.
* Or have `_propagateRails` emit `part:destroyed`-style crew payloads.

### 2. MAJOR · integration (flightScene.js): chase camera goes below the terrain after a crash
**Repro:** `pt_robust_explode.mjs` / `pt_robust_verify.mjs`: drop Orbiter I nose-first at 250 m/s near the pad.
* Measured camera altitude vs `surfaceHeight` under it: **−7.8 m and −7.9 m** (two runs). After a right-drag up it
  is **−29.4 m**.
* The anchor (last CoM) itself is 5.6 m underground.
* The view shows the terrain from below: a green "wall", a black underside with brown blotches, and the water edge seen
  from underneath. The crash results dialog sits on top of this.

**Evidence:** `pt_robust_B3_explosion.png`, `pt_robust_B5_switch_debris.png`, `pt_robust_V1_crash_cam.png`,
`pt_robust_V2_crash_cam_drag.png`, `pt_robust_B7_results.png`.

**Cause:** `_frame()` passes `cp.radarAltitude = anchor.destroyed ? null : t.radarAltitude`. `FlightCamera` skips its
ground clamp when `radarAltitude` isn't finite (`cameraController.js` ~164, and `_clampPitch` falls back to −1.53).

**Fix:** keep clamping for a destroyed anchor. For example, pass `t.altitude - t.terrainHeight` (still valid, since
the wreck doesn't move), lift `this.origin` so it sits at least 1 m above the terrain, or sample
`surfaceHeight()` under the camera each frame and push the camera up. A slow auto-orbit "wreck cam" would help too.

### 3. MAJOR · map (mapView.js): map is empty after the active vessel is destroyed
**Repro:** crash, then press M within the 2.5 s before the results dialog (`pt_robust_verify.mjs` step 2,
`pt_robust_explode.mjs`).
* `focusTarget` stays `{kind:'vessel', id:<destroyed>}`.
* `focusAnim` restarts every frame (`t` 0.111, then 0.093), `origin` is [0,0,0], and the focus bar shows "—".
* Only a grey starfield is drawn: no planet, no orbits.

**Evidence:** `pt_robust_V3_map_destroyed.png`, `pt_robust_B6_map_explosion.png`.

**Cause:** `_defaultFocus()` (~1282) returns `flight.active` even when it's destroyed. `update()` then finds the focus
invalid every frame, resets it to the same vessel, and restarts the animation.

**Fix:** `if (this.mode === 'flight' && f?.active && !f.active.destroyed)`. Otherwise focus
`f.active?.bodyId ?? HOME_BODY` as a body.

### 4. MAJOR · shell (crew.js): a corrupt roster entry soft-locks the game
**Repro:** `pt_robust_corrupt.mjs` variant `shaped`: `tsp.roster = {"crew":[null,5],"memorial":[],"nextId":1}`.
* The space center fails to open. The screen is black with the toast *"Could not open spacecenter: Cannot read
  properties of null (reading 'status')"* (`crew.js:88`, `listCrew`).
* The launch pad crew preview throws.
* `flight.launch` fails ("[flight] launch failed").
* The next reload still fails: the `pagehide` autosave wrote the bad in-memory roster into `tsp.persistent`, and
  variant `shaped2`, which didn't set a roster at all, inherited it.

**Evidence:** `pt_robust_C_shaped2_1sc.png`, `pt_robust_C_shaped2_2pad.png`.

**Fix:** `isValidRoster` should filter or validate entries (objects with string `name`/`status`) and fall back to the
default roster. Also sanitise before `setRoster` from a save.

### 5. MAJOR · shell (missions.js): non-object `progress.stats` / `milestones` blocks the space center and flight
**Repro:** `tsp.progress = {"milestones":5,"stats":7}`.
* The `Missions` constructor throws "Cannot create property 'launches' on number '7'" (`missions.js:123`).
* `getMissions()` is called from `SpaceCenterScene.enter` and `FlightScene._enter`, so both scenes fail to open.

**Evidence:** `pt_robust_C_shaped_1sc.png` (black screen and toast).

**Fix:** normalise with `isPlainObject` checks for `progress`, `milestones`, `stats`, and the numeric fields in stats.

### 6. MINOR · integration (src/core/state.js) + shell (menus.js) + cameraController.js: non-numeric settings
**Repro:** `pt_robust_corrupt2.mjs` variant `settings_bad`:
`tsp.settings = {"mouseSensitivity":"fast","masterVolume":"loud","graphics":"ultra","invertY":"no"}`.
* The first mouse drag in flight turns the camera position/quaternion into NaN (`[null,null,null,null]`) and the 3D view
  goes black (`pt_robust_C2_settings_bad_2flight.png`).
* `openSettings()` throws `v.toFixed is not a function` (`menus.js` `sliderRow` fmt), so the player can't fix it from the
  UI.

**Fix:** type-check `storage.get('settings')` against `DEFAULT_SETTINGS` when merging (state.js), and use
`Number(x) || default` in the camera and slider code.

### 7. MINOR · shell (menus.js): tutorial hint can't be dismissed when `tsp.hints` isn't an object
**Repro:** `tsp.hints = "abc"` (or a number).
* "GOT IT" throws `Cannot create property 'sc_welcome' on string 'abc'` (`menus.js:362`) and the card stays on screen.
* In flight, the hints subsystem logs `[flight] hints: TypeError`.

**Evidence:** `pt_robust_C2_hints_string_2gotit.png`. The run shows 1 hint before the click and 1 after.

**Fix:** `hintsSeen()` should return `{}` unless the stored value is a plain object.

### 8. MINOR · vab (craft.js): a bad `tsp.crafts` entry breaks VAB Load, hides saved crafts, and can lose saves
**Repro:** `tsp.crafts = {"A":null,"B":{...}}`.
* VAB **Load** throws `Cannot read properties of null (reading 'updated')` (`craft.js:623`, `listSavedCrafts`) and the
  dialog never opens.
* The space center logs "could not list saved crafts" and the Saved tab is empty.
* With `tsp.crafts = [1,2]` (an array), `saveCraft` adds a named key to the array and `JSON.stringify` drops it. The
  player sees "Saved", but nothing is stored.

**Fix:** `readAll()` should accept only plain objects. `listSavedCrafts` should skip entries without a `craft` object.

### 9. MINOR (data loss) · shell (persistence.js) + physics (FlightSim.deserialize): unrestorable saves wipe the flight
**Repro:** a quicksave with a valid header but vessels that can't be restored
(`{"format":"tsp-universe-1","ut":5,"flight":{"vessels":"x"}}`), then F9 in flight.
* The toast says **"Quickloaded"**, `game.flight` becomes a sim with 0 vessels, and the scene bails to the space center.
  The flight that was running is gone.
* Loading `tsp.persistent` drops vessels in the same way (`[vessel] unknown part in save` warnings only). A part id
  renamed in a future update would silently delete players' ships.

**Evidence:** `pt_robust_corrupt2.mjs` logs (`quicksave_garbage` and `persistent_garbage`).

**Fix:** in `read()`, compare saved and restored vessel counts. If the save had vessels but none came back, abort
(toast, keep the current universe). If some were dropped, toast "N vessels could not be restored".

### 10. MINOR · integration (flight/flightInput.js): SAS and throttle respond on an uncontrollable vessel
**Repro:** `pt_robust_flows.mjs`: fly an SRB debris from the tracking station, press T and Z.
* `controls.sas = true`, `throttle = 1`.
* The HUD shows SAS lit and THR 100%, the "SAS ON" message plays and the SAS sound plays, all next to the red
  NO CONTROL badge. Physics ignores both (`controllable = false`, throttle frozen).

**Evidence:** `pt_robust_F4_debris_keys.png`. Reproduced in 1 run, but the state values were read directly.

**Fix:** in `FlightInput.read`, when `!v.controllable`, skip throttle/SAS/RCS/toggles and show "NO CONTROL", like
`_stage()` does.

### 11. MINOR · integration (flight/hints.js): tutorial hint stays up after destruction, over the crash report
**Repro:** the gravity-turn hint is showing when the rocket crashes; it's still there next to "RAPID UNPLANNED
DISASSEMBLY".

**Evidence:** `pt_robust_V2_crash_cam_drag.png`, `pt_robust_B7_results.png`. The verify run reports
`hints: ["flight_turn"]` with the modal open.

**Cause:** `FlightHints.update` returns early for a destroyed vessel, so the retire logic never runs.

**Fix:** `if (vessel?.destroyed) { this.dismissCurrent?.(false); ... }`.

### 12. MINOR · hud (hud.js / hud.css): mini orbit diagram overflows the orbit panel on high orbits
**Repro:** `pt_robust_verify.mjs` step 5.
* At 100 km and 2,000 km the path bbox fits (46×43 px in the 72 px SVG).
* At 12,000 km it's **179×171 px (82 px overflow)** and draws across the panel border and up to the MAP button.

**Evidence:** `pt_robust_V7_orbit_12000000.png`, `pt_robust_F8_after_soi.png` (after a Lune SOI exit).

**Cause:** `_updateOrbit` clamps the planet to ≥ 4 units, then scales the orbit by `kk = Rs / R`, so `ra·kk` goes past
the 50-unit viewBox. `.hud-orbit-svg { overflow: visible }` (hud.css:226).

**Fix:** `kk = Math.min(Rs / R, 46 / maxR)` and draw the planet at its minimum size separately. Or clip the SVG, and
also clamp the hyperbola `r ≤ 200`.

### 13. POLISH · hud: TWR on high orbits reads "0.00 / 880.99"
TWR is computed against local g at 12,000 km (`pt_robust_F8_after_soi.png`). It's technically right, but the number
looks broken. Show it against surface g, or show "—" above ~10 radii.

## Performance (heavy_lifter, 40 parts, 1600×900, bloom on)

Scripts: `pt_robust_perf.mjs`, `pt_robust_perf2.mjs`. CPU ms per frame are means; render is submission only.

| situation | update | physics | HUD | planets | fx | render | draw calls | triangles |
|---|---|---|---|---|---|---|---|---|
| pad (PRELAUNCH) | 1.38 | 0.25 | 0.60 | 0.30 | 0.03 | 1.72 | 398 | 782k |
| liftoff +4 s (2964 smoke) | 1.81 | 0.31 | 0.69 | 0.33 | 0.30 | 1.74 | 440 | 876k |
| ascent 10 km | 1.71 | 0.25 | 0.74 | 0.28 | 0.31 | 1.45 | 409 | 546k |
| orbit 90 km coast | 1.57 | 0.30 | 0.66 | 0.28 | 0.28 | 1.24 | 395 | 512k |
| orbit burn 100% | 1.19 | 0.12 | 0.74 | 0.11 | 0.09 | 1.44 | 428 | 585k |
| **map open** | **6.47** | 0.17 | 0.48 | – | 0.07 | 0.22 | 11 | 32k |

* **Physics step:** 0.024 ms per 20 ms step for 40 parts, measured as `flight.update(0.1)` ×100 = 12 ms for 10 s of
  simulated time. `fastForward(20)` costs 16 ms of wall time. Physics is nowhere near a bottleneck.
* **Draw-call breakdown on the pad:** the vessel is 159 of 453 draws. `PlanetSystem/body:verda` (terrain + KSC) is 99.
  The sky is 5. The rest is the shadow pass and post-processing. The vessel accounts for most of the triangles
  (~19k per part).
* **Map:** `_stepBaking` uses its full 5 ms budget every frame (7 ms in the tracking station). It was still baking
  after 24 s (4 windows of 6 s: 5.41, 5.33, 5.55 and 5.76 ms per frame), so for the first map session the map costs
  about 6 ms per frame. It's by design, but it's the most expensive thing in the game. The coarse 128×64 bake is also
  why planets look pixelated in the tracking station at first (`pt_robust_F2_tracking.png`).

### Leaks: 5 round trips spacecenter → vab → flight (launch + 20 s + map) → tracking → spacecenter
`pt_robust_leaks.mjs`. Values at the space center after each round:

| | start | r0 | r1 | r2 | r3 | r4 |
|---|---|---|---|---|---|---|
| geometries | 101 | 309 | 271 | 414 | 414 | 414 |
| textures | 39 | 64 | 64 | 64 | 64 | 64 |
| programs | 45 | 109 | 109 | 114 | 114 | 114 |
| DOM nodes | 211 | 192 | 192 | 192 | 192 | 192 |
| JS listeners (CDP) | 77 | 97 | 111 | 113 | 99 | 104 |
| bus handlers | 25 | 25 | 25 | 25 | 25 | 25 |
| heap MB (after GC) | 7 | 17 | 17 | 19 | 20 | 20 |

Nothing grows per round. The jump at r2 is a vessel left on the pad, rendered as a parked vessel. The navball creates a
new WebGL context on every flight entry: 9 contexts created in 5 rounds. Each is released with `forceContextLoss()`,
and there were no "too many contexts" warnings.

### Audio (`pt_robust_audio.mjs`)
* `TSP.audio` appears only after the first gesture, with the context running. Master slider to 0 gives master gain 0,
  and the value is persisted.
* Pause mutes the world bus (0 → 1 on resume). Hiding the tab suspends the context, and showing it resumes.
* No exceptions across vab, flight, map, tracking and spacecenter, a crash while muted, or graphics/bloom/shadow toggles
  in flight.
* Live oscillators rise to about 110 after scene switches and drain again (81 after idling). No monotonic growth.

## Improvement ideas
1. **shell:** a save-robustness layer: schema-validate every `tsp.*` key on load, version and migrate saves, keep a
   `persistent.bak` last-good copy, and show a friendly "your save looks damaged: restore backup / reset" screen instead
   of a black screen and a toast.
2. **integration:** a real wreck cam: on destruction, frame the fireball from above the ground with a slow orbit and a
   0.3 s slow-mo at impact.
3. **map:** bake the map planet textures in the terrain worker (or at boot, cached in IndexedDB), so the map and
   tracking station never pay 5-7 ms per frame and never show blocky planets.
4. **parts3d:** batch static part meshes per vessel by material, and add distance LOD. heavy_lifter is already 159 draw
   calls, and player crafts with 150+ parts will scale linearly.
5. **shell:** make the crew lifecycle visible. When a vessel is lost, terminated or replaced on the pad, say who was
   aboard and what happened to them (toast + memorial / "back in the complex"). Let the Astronaut Complex link to the
   vessel.
6. **fx:** a one-key mute (e.g. Ctrl+M) plus a speaker toggle on the HUD and space center. Right now the only way to
   mute is a slider buried in Settings.
