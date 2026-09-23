# Shell (part 1): space center, KSC models, camera, menus, missions, crew, persistence

Owner files: `src/scenes/spaceCenter.js`, `src/render/kscModels.js`, `src/game/cameraController.js`, `src/game/missions.js`,
`src/game/crew.js`, `src/game/persistence.js`, `src/ui/menus.js`, `src/ui/shell.css`, `tests/shell.test.mjs`,
`tests/shell_camera.html`, `tests/shell_menus.html`, `tests/shell_scenario.mjs`, `tests/shell_camera_scenario.mjs`,
`tests/shell_hint_leak_scenario.mjs`, `tests/shell_crew_lifecycle_scenario.mjs`, `tests/shell_damaged_save_scenario.mjs`,
`tests/shell_dialogs_scenario.mjs`.
Not written (integration engineer): `src/scenes/flightScene.js`, `src/scenes/tracking.js`. `src/main.js` / `index.html` untouched.

## What was built

* **Space Center scene** (`index.html?scene=spacecenter`) — cinematic, slowly drifting elevated camera around a stylized KSC,
  attached to the real `PlanetSystem` (terrain, ocean, sky, day/night) through `bodyFixedGroup('verda')`, or a self-contained
  fallback sky/ground/ocean/mountains when the PlanetSystem is missing (force it with `&kscFallback=1`).
  Animated title card on the first entry per session, floating building labels (de-overlapped, hover → description),
  hover glow on buildings, bottom dock (Resume Flight when a flight exists · VAB · Launch Pad · Tracking · Mission Control ·
  Astronaut Complex · Settings · Help), top bar (UT clock, day/dusk/night, launches, milestones, crew, vessels in flight).
  Hotkeys: V VAB, L Launch Pad, T Tracking, M Mission Control, A Astronaut Complex, R Resume Flight.
  UT runs at 1× (vessels on rails keep moving: calls `FlightSim._railsUpdate(dt)` — see integration notes).
  Night: window lights, street-lamp light pools, beacons, pad/VAB flood lights; optional bloom (settings.bloom, not on low).
  Vessels resting on the pad/near the KSC (`vessel.landedAt`) are drawn with the parts3d `VesselRenderer`.
  Restores the persistent universe on the first entry of a session (`loadUniverse(FlightSim)`), saves it on exit/page-hide.
* **Launch Pad dialog** — stock crafts (`stockCrafts.js`) + saved crafts (`craft.js`) + the craft currently in the VAB;
  stats (parts, mass, stages, Δv vac, launch TWR, height via `craftStats`/`computeStageStats`), crew preview →
  `app.goto('flight', { craft })` or `app.goto('vab', { craft })`.
* **Mission Control** — milestone board by category, program stats. **Astronaut Complex** — roster cards (SVG Tinynaut
  portraits, courage/stupidity bars, badass badge, flights, time in space), hire recruits, memorial wall.
* **KSC models** (`kscModels.js`) — launch pad (octagonal deck + apron, flame trench, grate & scorch, red lattice service
  tower with umbilical arms & hammerhead crane, 3 lightning masts with catenary wires, water tower, propellant spheres,
  floodlight towers, blast bunker, perimeter fence, sign), VAB (80×100×76 m, huge doors — one open showing a rocket inside —
  stripes, logo roundels, "VEHICLE ASSEMBLY" signage, office annex, crawler transporter on the apron), tracking station
  (3 animated dishes, lattice mast), mission control (glass atrium, rooftop mast & dish, rotating Verda globe sculpture,
  flags), astronaut complex (helmet-dome rotunda with gold visor, wings, spinning centrifuge, rocket monument), 1 km runway
  with markings/numbers/edge lights, hangar + control tower, road network, crawlerway, parking lots with cars, street lamps,
  ~950 instanced trees, mowed-lawn stripes (multiplicative overlay, works over any terrain shader). ~85 draw calls,
  ~200k triangles. Everything is bent onto the planet's curvature so buildings 1 km out sit on the spherical flat zone.
* **FlightCamera** (`cameraController.js`) — `auto | free | orbital | chase | locked`, smooth log-space zoom, mode switches
  never jump, ground clamp, V cycles modes (toast).
* **Menus** (`menus.js`) — modal stack (Esc/backdrop/✕, Enter = primary), confirm, settings, pause, flight results, help,
  tutorial hints, crew avatar SVG.
* **Missions** (42 milestones: firsts, records, destinations per body, fun extras), **crew** roster, **persistence**.

## Playtest round 2 (fixes + improvements)

**Crew lifecycle (major).** crew.js now keeps the roster in step with the universe on its own (installed on import):
`vessel:removed` (pad cleared by a new rollout, Tracking Station Terminate, recovery) releases the crew still aboard;
`vessel:destroyed` with crew still aboard (an unattended vessel lost on rails — no part events) marks them lost with
"Lost in X's atmosphere" / "Crashed on X" and a Memorial Wall toast. Released crew get a deferred toast ("… is back at the
Astronaut Complex"); crew recovered in the same tick (FlightSim.recover removes the vessel, recoverCrew runs right after)
are skipped, so recoveries still count the flight. Assignments carry a **mission token** (`member.mission`, copied into the
vessel crew entry): a vessel only releases / kills members whose current token is its own. That lets a re-rolled rocket take
the crew straight out of the rocket still sitting on the pad (`padCrew()` joins `pickAvailable` after the truly available
ones) instead of hiring volunteers every re-roll. The Astronaut Complex reconciles on open (crew whose vessel no longer
exists walk back in, with a toast) and shows "Aboard <vessel> · <situation> · <body>" with a **▶ Fly** button for crew in flight.

**Save-data robustness (major + improvement).**
* `crew.sanitizeRoster()` repairs every roster that enters the game (storage, `setRoster`, `restoreRoster`, quickload, a
  direct `game.roster = …`): non-object / nameless entries dropped, duplicate names/ids fixed, every field type-checked,
  nothing usable → the founding four. `getRoster()` validates each new roster object once (WeakSet), so the pagehide
  autosave can no longer write a broken in-memory roster into `tsp.persistent`.
* `missions.sanitizeProgress(game)` (Missions constructor): plain-object progress / milestones / stats, finite counters,
  `visited` = known body ids. `{"milestones":5,"stats":7}` no longer blocks both scenes.
* `persistence.sanitizeSettings()` / `validateStoredData()` (runs on import): wrong-typed or out-of-range settings fall back
  to `DEFAULT_SETTINGS` (and the slider rows / cameraController / space-center drag coerce numbers too), a non-object
  `tsp.hints` is dropped; `menus.hintsSeen()` only accepts a plain object and `dismiss()` always removes the card.
* `read()` deserializes FIRST and compares vessels in the file vs restored. **Quickload** of a save whose vessels all fail
  (or that throws) is rejected: toast "The quicksave is damaged — nothing was loaded", game.ut / roster / the running flight
  untouched (the debug `TSP.physics` hook is restored too). Partial restores say "N vessels could not be restored".
* Backups: the first persistent save of a session copies the save found on disk to `tsp.persistent.bak` (last known good);
  if that save was found damaged it is parked in `tsp.persistent.damaged` instead and the older backup is kept.
  `lastLoadReport()`, `hasBackup()`, `restoreBackup(FlightSim)`.
* Space center: a damaged persistent save opens **"Your save needs attention"** after the title card: what was lost, the
  backup's date / vessels, **Restore backup** (rebuilds the scene around it) or keep what was recovered.

**Missions.** Crashes are counted when the pod dies first (the wreck is re-ranked as debris by vessel.js): Missions keeps a
sticky `_ships` WeakSet (flight:launched, vessel:created/switched, the active vessel in update, part:destroyed while still
a ship) and `wasShip(v)`; `vessel:destroyed` counts once per vessel. `part:destroyed` of debris that never was a ship (a spent
stage burning up / hitting the ground) no longer awards *Rapid Unplanned Disassembly* / *Too Hot to Handle* / lithobraking.

**Mission report (improvement).** Missions records a per-vessel flight log (liftoff, staging, left the atmosphere, orbit,
left orbit, SOI changes, reentry plasma, chute, touchdown / splashdown, max Q, peak g, peak heat — heatFraction, i.e. from
room temperature — vessel lost / recovered) plus the milestones earned while that vessel was the active one.
`describeFlight()` returns `timeline` + `badges` (and "Hottest part", "From the pad" stats) and `openFlightResults` renders
them: a T+ timeline column and milestone badges; the modal widens to 880 px when a timeline exists. flightScene spreads
`describeFlight` into the results, so this needed no flight-scene change.

**Results footer (polish).** `openModal` buttons accept `{ link: true }` (quiet text link at the left of the footer). With 4+
buttons, a trailing ghost button ("Keep watching") is turned into such a link, so the real choices stay on one row.

**Tutorial hints.** `showTutorialHint` binds a delayed hint to the hint host of the scene that scheduled it: main.js empties
`#ui-root` on every switch, so a timer firing after the switch finds its host disconnected and drops the card (Tracking
Station → Fly / ⌂ within 0.9 s used to pop the Tracking tip over the next scene). Root-cause fix; flight/hints.js also purges
foreign tips.

**Help.** The Flight Manual has tabs — Flight · Vehicle Assembly · Space Center (`openHelp({ tab })`, remembers the last
tab). The VAB tab mirrors vab.js: click / Alt+click copy / right-click menu / Del / Esc / X, Shift+X symmetry / C snap /
WASDQE rotation (+Shift 15°) / right-drag / wheel / Shift+wheel / F / Ctrl+Z, Ctrl+Y / Ctrl+S, plus first-rocket tips.
Flight tab in balanced columns so the whole page fits at 1280×720 without scrolling.

**Space center framing (polish).** The idle camera no longer circles: it sways ±0.42 rad (160 s period) around az 1.2
(east-south-east, pad in front, VAB behind) — every building is fully visible for az ≈ −0.4…2.5 (checked against the
hitboxes; the old default az −0.78 hid the Astronaut Complex behind the VAB and the full circle parked the Tracking Station
under the dock). `_fitOverview()` projects all hitbox corners + label anchors (with pill room) every frame and fits the
distance (`fitDist`, ~88 % of the free area) and a principal-point offset (`camera.setViewOffset`) so the complex is centred
in the free area between the top bar and the dock — at any resolution / aspect (1080p no longer shows a small cluster). The
free area also avoids a tutorial card in the top-right corner (reserved from the start of the visit when a tip is due, so
the view does not re-frame under the cursor when the card pops in; released when it is dismissed). Wheel zoom is relative (`cam.zoom` × fitted distance); a drag
re-centres the sway where the player left it. Labels: act on **pointerdown** (a gliding label can't swallow the click),
the whole view **holds still while the pointer rests on a label**, pills are clamped above the dock and kept clear of the
centre of any building behind them, the hover description hangs below the pill out of layout (the pill never moves under
the cursor; others dim to 38 %). Title-card dismissal speeds up the intro swoop. Bloom gets the same HDR sanitize pass as
the flight scene (no square sun bloom). `planets.setQuality(settings.graphics)` on enter and on change.

**Launch Pad / Astronaut Complex (polish).** Pad dialog 900 px wide, stat values `nowrap`, top-anchored backdrop
(`:has(> .sc-pad-modal)`) + min-height so switching crafts never makes the header jump. `crew.describeMembers(list)` gives
every card a distinct flavour line (several lines per trait bucket, deterministic by name).

## Public API

### `src/render/kscModels.js`
```js
buildKSC({ renderer?, quality? }) → THREE.Group ksc     // launch-site LOCAL frame: origin = pad centre on the surface,
                                                         // +Y up, +X east, −Z north. Pad deck top at y = 0.035 (see below).
  ksc.buildings  [{ id:'vab'|'pad'|'tracking'|'mission'|'astronaut', name, description, icon, object3D (Group),
                    labelAnchor (Object3D, KSC-local position), hitboxes: Mesh[] (invisible boxes, KSC-local),
                    focus: Vector3 (KSC-local), viewDistance (m), shells }]
  ksc.hitboxes   all hitbox meshes
  ksc.update(dt, { night })      // animations (dishes, centrifuge, globe, beacons) + night lighting; night ∈ [0,1]
  ksc.setHighlight(id | null)    // hover glow
  ksc.setEnvMap(texture | null)  // reflections: pass planets.envMap; null restores the built-in env map
  ksc.dispose()
getSharedKSC(app) → app.getShared('ksc', …)             // build once, reuse in every scene; never dispose it in exit()
kscTransform(body = BODIES.verda) → { position (body-fixed, |p| = R + 70), quaternion (local → body-fixed), up, east, north }
kscSunDirection(ut, out?) → Vector3                      // sun direction in the launch-site local frame (matches universe.js)
nightFactor(sunLocalY) → 0 (day) … 1 (night)
surfaceDrop(x, z) → m below the tangent plane;  KSC_BEND_RADIUS
buildFallbackEnvironment({ quality }) → { group, sun, hemi, fog, sky, update(camera, sunLocal, night), dispose() }
KSC_BUILDINGS                                            // static metadata list
```
### `src/game/cameraController.js`
```js
new FlightCamera(camera, domElement, { mode='auto', distance=30, yaw=0.6, pitch=0.18, input (app.input — polled for V),
                 maxDistance=200000, leftDrag=true, canStartDrag(ev) → bool, toast=true })
  .update(dt, { up, vesselRot, vesselSize, velocityDir, shake, speed?, normal?, radarAltitude? })
  .setMode(mode, { silent }) · .cycleMode(dir) · .reset({distance, yaw, pitch}) · .getState() / .setState(s)
  .getViewDirection(out) · .dragging (bool) · .enabled · .mode · .distance · .dispose()
CAMERA_MODES, CAMERA_MODE_LABELS; emits bus 'camera:mode' { mode } (+ toast) on changes.
```
### `src/ui/menus.js` (browser only; loads `shell.css` relative to the module)
```js
openModal({ title, subtitle?, icon?, content, buttons:[{label, kind, onClick(close) → false keeps open, disabled, hotkey}],
            onClose(reason), className?, dismissible=true, enter? }) → close()
confirmDialog(text, { title, confirmLabel, cancelLabel, danger, icon }) → Promise<bool>
openSettings(app) → close        // writes game.settings, saveSettings(), bus 'settings:changed' {key, value, settings},
                                  // audio.setVolumes, toggles renderer.shadowMap + material recompiles, hides FPS meter
openPauseMenu(app, { onResume, onRevertLaunch, onRevertVAB, onSpaceCenter, onSettings?, onQuicksave, onQuickload,
                     onRecover?, recoverLabel?, onHelp? }) → close   // sets game.paused while open; Esc = resume
openFlightResults(app, { title, subtitle, stats:[[label, value]], crew:[{name, status, color?}], buttons, tone:'good'|'bad'|'neutral', icon })
openFlightResults(…, { timeline?: [{ t (s after liftoff), icon, text }], badges?: [{ id, icon, title }] })   // optional extras
buttons: [{ …, link: true }] → text link at the left of the footer (openFlightResults: automatic for a 4th ghost button)
openHelp({ tab: 'flight'|'vab'|'spacecenter' }) · HELP_TABS · HELP_SECTIONS (flat)
showTutorialHint(key, text, { title, delay, icon }) → dismiss | null (a delayed hint is dropped if its scene is gone) ·
resetTutorialHints() · hintSeen(key)
isModalOpen() · closeAllModals() · crewAvatarSVG(member, size) · getAudio() → Promise<audio|null> · sfx(name, opts)
```
### `src/game/missions.js`
```js
new Missions(game = core game, bus = core bus, { toast = true, listen = true })
  .update(flight, dt?)  .list() → [{ id, title, description, category, icon, done, ut, date }]  .count() → {done, total}
  .complete(id) → bool  .isDone(id)  .recordsFor(vessel) → { maxG, maxMach, maxHeat }  .dispose()
getMissions() → the shared always-listening instance (USE THIS — two listening instances would double-count launches)
describeFlight(vessel, { ut, missions, outcome:'recovered'|'destroyed'|'ended', crewStatus }) → { title, subtitle, tone,
                icon, stats, crew, timeline, badges }   // feed straight into openFlightResults()
  .flightLog(vessel, { ut, outcome }) → { timeline, badges } · .wasShip(vessel) (sticky: ever a ship/probe)
  .recordsFor(v) → { maxG, maxMach, maxHeat, maxHeatF (heatFraction), maxQ (kPa), …UT }
sanitizeProgress(game) → bool (repairs game.progress in place; the constructor calls it)
MILESTONES, MILESTONE_BY_ID, MILESTONE_CATEGORIES
```
Listens to: `flight:launched` (launch count, firsts, heavy, frequent flyer), `part:destroyed`, `vessel:destroyed` (crash
count), `soi:change`, `situation:change`, `chute:deploy`, `vessel:recovered` (recovery count), `crew:returned`.
### `src/game/crew.js`
```js
getRoster() · setRoster(r) · saveRoster() · resetRoster() · listCrew(status|pred) · getMember(nameOrId) · crewSeats(craft)
previewCrew(craft) → { crew, seats, missing }        // exactly who assignCrew() will pick
assignCrew(craft, { names? }) → vessel crew [{ id, name, role, courage, stupidity, badass, color }]  // marks 'assigned'
markLost(names, { cause, vesselName, ut, bodyId }) · markReturned(names, { missionTime }) · releaseCrew(names)
reconcileAssignments(activeNames) · hireRecruit() · dismissCrew(name) · memorial() · describeMember(m)
snapshotRoster() / restoreRoster(snap)                 // take at launch, restore on revert
recoverCrew(vessel, recoverResult) → members           // markReturned + bus 'vessel:recovered' {vessel, crew, funds}
trackCrewEvents()   // installed on import: part:destroyed.crew → markLost; vessel:removed → release the crew aboard;
                    // vessel:destroyed with crew aboard (unattended loss) → markLost + toast
sanitizeRoster(r, report?) → clean copy | null · describeMembers(list) → Map(member → unique flavour line)
Vessel crew entries carry `mission` (assignment token); crew in a PRELAUNCH vessel are re-used by the next rollout.
```
Bus events emitted (shell-defined): `crew:assigned {names}`, `crew:lost {names, cause, vesselName}`, `crew:returned {names}`,
`crew:released {names, vesselName}` (vessel removed with crew aboard),
`crew:hired {name}`, `vessel:recovered {vessel, crew, funds}`, `camera:mode {mode}`, `settings:changed {key, value, settings}`.
### `src/game/persistence.js`
```js
saveUniverse() → bool                  // storage "persistent" (tsp.persistent): { format:'tsp-universe-1', ut, savedAt, flight, roster, meta }
loadUniverse(FlightSimClass) → FlightSim | null   // sets game.ut first; caller assigns game.flight
quicksave() → bool · quickload(FlightSimClass) → FlightSim | null (restores ut + roster; caller swaps game.flight)
hasQuicksave() · hasPersistentSave() · peekSave(key) · snapshotUniverse() · clearUniverse() · installAutosave()
lastLoadReport() → { key, ok, saved, restored, lost, rejected, error } · hasBackup() → peek | null · restoreBackup(FlightSim)
BACKUP_KEY 'persistent.bak' · DAMAGED_KEY 'persistent.damaged' · sanitizeSettings(settings) · validateStoredData()
quickload() returns null (nothing applied) for a quicksave whose vessels cannot be restored.
```

## Deviations from ARCHITECTURE.md
* `buildKSC` returns a Group carrying extra members (`buildings`, `update`, `setHighlight`, `setEnvMap`, `dispose`); the
  building list is `ksc.buildings`. `labelAnchor` is an `Object3D` child (its `.position` is KSC-local).
* The pad **deck top is at y = 0.035 m** (apron 0.025, grate 0.05) so it never z-fights the terrain at exactly 70 m; a
  vessel resting at y = 0 sinks 3.5 cm into the deck — invisible.
* `FlightCamera.update` accepts optional extras `speed` (chase ignores noisy velocity below 1.5 m/s), `normal` (orbital),
  `radarAltitude` (ground clamp). Constructor takes `(camera, domElement, opts)`.
* Missions: use `getMissions()` (shared instance). `update(flight, dt?)` — dt defaults to Δ game.ut.

## Integration notes (flight scene / tracking scene)
1. **KSC in flight**: `const ksc = getSharedKSC(app); const t = kscTransform(); planets.bodyFixedGroup('verda').add(ksc);
   ksc.position.copy(t.position); ksc.quaternion.copy(t.quaternion); ksc.setEnvMap(planets.envMap);` each frame
   `ksc.update(dt, { night: nightFactor(kscSunDirection(game.ut, v).y) })`; on exit `ksc.setEnvMap(null); ksc.removeFromParent()`.
   It contains two PointLights (pad/VAB, 0 by day) — at night the pad is lit during launches.
2. **Launch**: `const snap = crew.snapshotRoster(); const c = crew.assignCrew(craft); flight.launch(craft, { crew: c });`
   `game.lastLaunchCraft = craft`. On *revert*: `crew.restoreRoster(snap)` (or `crew.releaseCrew(names)`).
3. **Crew deaths are automatic** (FlightSim's `part:destroyed` carries `crew`). On **recovery**:
   `const r = flight.recover(v); if (r) { crew.recoverCrew(v, r); openFlightResults(app, { ...describeFlight(v, { outcome: 'recovered' }), buttons }) }`.
4. **Missions**: `const missions = getMissions();` then `missions.update(game.flight)` every frame (cheap).
5. **Persistence**: on flight-scene exit call `game.flight.packAll(); saveUniverse();`. F5 → `quicksave()`,
   F9 → `const sim = quickload(FlightSim); if (sim) { dispose renderers; game.flight = sim; rebuild }`.
   `resume:true` → just use `game.flight` (the space center restores it from storage after a page reload).
6. **Camera**: `new FlightCamera(camera, app.canvas, { input: app.input, canStartDrag: (e) => !pickPart(e) })`; each frame
   `cam.update(dt, { up: t.up, vesselRot: v.rot, vesselSize: stats.height, velocityDir: t.surfaceSpeed < 100 ? t.surfacePrograde : t.prograde,
   speed: t.surfaceSpeed, normal: t.normal, radarAltitude: t.radarAltitude, shake: effects.cameraShake() })`.
7. **Pause**: `openPauseMenu(app, {...})` sets `game.paused` (FlightSim.update already honours it); Esc resumes.
8. **Please expose `FlightSim.updateRails(dt)`** (public rails-only step). Until then the space center calls the internal
   `_railsUpdate(dt)` (wrapped in try/catch; falls back to `game.ut += dt`).
9. The space center calls `game.flight.packAll()` defensively on enter.

## How to test (playtest round 2 regressions)
* `node tools/run-tests.mjs shell` — 48 tests; the new ones: corrupt roster / progress / settings, describeMembers, crew
  released on vessel:removed (+ recovery keeps the flight), unattended loss → memorial, real FlightSim re-rolls (no phantom
  crew, no volunteers for a full-crew re-roll), crash counted when the pod dies first (real Vessel), debris never earns
  rud/too hot, flight log/timeline/badges, damaged quicksave rejected, partial restore + backup rotation + restoreBackup.
* `node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/shell_hint_leak_scenario.mjs` —
  Tracking → Fly / ⌂ right away: no Tracking tip in the next scene (reproduces the leak with the old menus.js).
* `… --script tests/shell_crew_lifecycle_scenario.mjs` — 2 rollouts (1 assigned), unattended loss at 5 km → memorial.
* `… --script tests/shell_damaged_save_scenario.mjs` — renamed part ids in tsp.persistent → dialog → Restore backup.
* `… --script tests/shell_dialogs_scenario.mjs [--size 1920x1080]` — label hover holds still, pad dialog header fixed and
  tiles on one line, unique flavour lines.
* `tests/shell_menus.html?show=resultsTimeline|helpVab` — results with timeline/badges/footer link; VAB help tab.
* Playtests re-run: `pt_vab_2_sc_ui.mjs` (all 5 buildings hover-pick themselves at 720p), `pt_vab_8_sc_labels.mjs` at
  1080p (all 4 label clicks open their dialog), `e2e_shell_flow.mjs` (ok), `pt_robust_crew.mjs` (after 4
  rollouts only the pad crew is assigned; Terminate releases), `pt_robust_corrupt.mjs` shaped/shaped2/strings (every scene
  opens), `pt_robust_corrupt2.mjs`, `pt_return_flea_crash.mjs` (report with timeline; crash counted; memorial).
* Debug hook: `TSP.shell.overview({ swayT })` snaps to the settled idle overview.

## How to test
* `node tools/run-tests.mjs shell` — 36 tests: crew, missions, persistence (incl. a real FlightSim round-trip), helpers,
  kscTransform/sun vs universe.js, FlightCamera modes/zoom/ground clamp.
* Space center: `node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/shell_scenario.mjs --out shots/shell_end.png`
  (overview, hover the VAB label, click the Launch Pad label → dialog, Mission Control, Astronaut Complex, close-ups, night,
  dusk; `SHELL_SHOTS=overview,pad` limits the set). Add `&kscFallback=1` for the fallback environment.
  Debug hooks: `TSP.shell.view({az, el, dist, focus:[x,y,z]})`, `.timeOfDay(hours)`, `.open(id)`, `.hover(id)`, `.setUT(ut)`.
* Camera + KSC + dummy rocket on the pad: `node tools/snap.mjs tests/shell_camera.html --wait 2000 --script tests/shell_camera_scenario.mjs`
  (`?mode=chase&hour=21&dist=80`).
* Dialogs: `tests/shell_menus.html?show=settings|pause|results|resultsBad|help|confirm|hint|modal`.
* Verified manually with scripts: space center → VAB (dock button, swoop) → space center round trip (KSC attached once,
  UI rebuilt, no errors); a real `FlightSim.launch(lune_lander)` shows the rocket on the pad + "Resume Flight", UT advances
  through `_railsUpdate` without errors. Screenshots: `shots/shell_*.png`.

## Known issues
* The overview fit uses the building hitboxes + label anchors; decorative pieces outside them (the pad's fence ring, the
  runway) may extend under the dock at some sway angles.
* flightScene assigns crew before FlightSim.launch() clears the pad; the pad-crew re-use in crew.js covers that ordering
  (a flightScene change is not required).
* Headless SwiftShader renders the space center at ~10 fps; real GPUs are far faster (~85 draw calls).
* The PlanetSystem's night terrain is very dark; buildings get a bluish moon fill from a small hemisphere light.
* `partMeshes` currently logs "failed to build chute_mk16" (parts3d area) when a parked vessel with that chute is drawn.
* Emoji icons in milestone tiles depend on the OS emoji font.
