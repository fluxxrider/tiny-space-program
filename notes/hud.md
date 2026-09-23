# HUD area — flight HUD, navball, Tinynaut crew portraits

Files: `src/ui/hud.js`, `src/ui/navball.js`, `src/ui/crewPortraits.js`, `src/ui/hud.css`, `tests/hud.html`.

## What was built

**FlightHUD** (`hud.js`), per ARCHITECTURE §7. It reads `flight.active.telemetry` every frame and changes the vessel only
through the documented controls: `vessel.setControl`, `vessel.controls.sasMode`, `flight.setWarp(i)` and `flight.warpTo(ut)`.

- **Top center: altimeter.** An 8-wheel odometer that rolls like a mechanical counter: digits rest on whole numbers, snap-roll
  through each unit and carry into the higher wheels. Leading zeros are dimmed and wheels that spin fast blur. Switches to km/Mm
  for huge values. **At rest** (smoothed rate < 1.5 units/s) it holds the nearest whole number (hysteresis ±0.62) and eases
  the wheels to it, so a vessel sitting at 79.5 m reads `80`, never a half-rolled `7/8`; a roll only happens as a
  transition. Click the header to toggle **ASL / terrain (radar)**; the digits turn amber in radar mode. The choice is
  saved to storage key `hud.altMode`. On final approach (landing aids active) it switches to terrain by itself
  ("Terrain · auto · landing"); a click flips it back for that approach. Below the digits: a color-coded situation pill, the body name and the biome (see
  "Biome" under Integration notes). Then the UT clock (`fmtUT`), the MET (`T+ …`, or `T− ready` on the pad) and **8
  clickable warp chevrons** that call `flight.setWarp(i)`. Chevron 0 means 1×. Rails warp shows orange, physics warp shows
  green, and the actual rate appears as a label. A refused warp (`{ok:false, reason}` or `warp:denied`) shakes a red note
  under the bar. A green **Recover vessel** button appears when LANDED/SPLASHED on `HOME_BODY` (only if `onRecover` was
  passed).
- **Landing aids strip** (under the time bar, final approach only: descending below 1.5 km in an atmosphere or
  5–10 km on airless bodies, until 8 s after touchdown): **Slope** under the vessel (4 `surfaceHeight` samples ±2.5 m;
  green < 8°, amber < 15°, red; "Water"), **Impact** (time to the ground: free fall, or h/v under chutes / thick air),
  **Burn in** (suicide-burn countdown: solves h(t) = v(t)²/2a under free fall with 92 % of full thrust; "Now!" flashes,
  "Too weak" if thrust < weight; the last 4 s also go to the cue pill above the navball), **Drift** (horizontal speed,
  green < 1 m/s) and **Lean** (nose vs local vertical, near the ground). A lander with legs whose lean passes 22° and keeps
  growing (> 2.5°/s) raises a red **Tipping over** alert.
- **Top left: resources** (collapsible, state saved to `hud.resCollapsed`). Each resource gets a thick bar for the vessel
  total and a thin bar for the current stage, colored from `RESOURCES`. Values turn orange when low and red when empty.
- **Top right**
  - Map and Pause buttons, shown only if the matching callback was passed.
  - **Orbit panel:** a mini SVG orbit diagram (planet in the body's color, atmosphere ring, ellipse or hyperbola, Ap/Pe
    dots and a pulsing vessel dot placed by solving Kepler's equation from `timeToPe`/`period`). Radii map as
    `s(r) = Rs + (r − R)·k2`: a pure scale while the planet is big enough, a radial squeeze when the planet is clamped to its
    4-unit minimum, so a 12 000 km orbit stays inside the box (and the svg clips). Ap/Pe show time-to plus "impact" or
    "in atmo" flags; **clicking Ap or Pe warps to 30 s before it** (`flight.warpTo(ut − 20)`; the chip turns into ⏩ on
    hover; refused with a note when it is < 30 s away / on the ground). Inclination, eccentricity and period read "—"
    while PRELAUNCH/LANDED/SPLASHED. A Flight section shows vertical speed (▲▼), horizontal speed, Mach, Q, **TWR
    current/max against the body's SURFACE gravity** (before ignition or after a flameout the max is the next stage's
    full-throttle TWR, in a lighter color), mass, and stage/total ΔV (same reference as the staging stack).
  - **Maneuver panel:** remaining Δv from `burnVector` (in `game/maneuver.js`) with a progress bar. Burn time comes from
    `estimateBurnTime`, falling back to `dv/(maxThrust/mass)`. It shows "Node in T−mm:ss" and a burn cue:
    `Burn in T−00:32` (the countdown to node.ut − burnTime/2), amber and pulsing under 10 s, then **flashing "Burn now!"**
    from half the burn time before the node, then "Node complete". **"Done" is latched per node** (until its Δv or time is
    edited): it triggers when the remainder is < 0.2 m/s or < 0.4 % of the node, or when the remaining vector flips
    direction between two ticks while both remainders are < max(5 m/s, 25 %) (an overshoot — it can only reverse by
    passing through zero). On completion SAS maneuver mode switches to stability hold (so it
    doesn't flip the ship to chase the reversed residual) with a "Node complete — SAS holding attitude" message, and a
    **Delete node** button appears. A "Warp to burn" button calls `flight.warpTo(start − 15 s)`.
  - **Cue pill** above the navball (visible in map mode too), by priority: suicide-burn cue › maneuver cue › **ascent
    guidance** ("Ap 42.1 km in 48s · pitch 45°", then "cut throttle" / "coast" once Ap reaches the atmosphere + 10 km).
- **Bottom left: staging stack.** Groups come from `vessel.getStages()`; the numbers come from `game/deltav.js`
  `computeStageStats` (the VAB's simulator) run twice at ~1 Hz: in **vacuum** and at the **current pressure**, with the
  body's surface gravity. The header chip toggles the reference (`vac` default = the VAB's numbers; `now`; saved as
  `hud.dvMode`); each row shows the other reference in small text while in the air ("now 1,041") and the stage's **TWR**
  (next/active stage at the current pressure — the launch TWR on the pad, later stages in the chosen reference; red < 1,
  amber < 1.3 on the ground). On the ground a thin bar compares the total vacuum ΔV with a rough "Verda orbit ≈ 3,400 m/s"
  (Lune ≈ 640) tick. The next stage to fire is at the bottom and pulses
  orange with a "NEXT Space" badge; the burning stage is green ("ACTIVE"). Engines lit in earlier stages that are still
  burning (for example the core engine after the boosters drop) are merged into the active group, so the player always sees
  what is burning. Each group shows:
  - its ΔV as text plus a bar, with burn time
  - part icons, with identical parts merged into "×N"
  - for active engines: a live fuel bar, a burning glow, a low-fuel color and a blinking red flameout state

  A hint line reads "Press SPACE to launch" on the pad, or "Flameout — press SPACE to stage". The stack shows up to 6
  groups; overflow is clipped from the top so the important rows stay visible.
  Icons use `renderPartThumbnail(def,128)` from `render/partMeshes.js`, auto-cropped to the part's bounding box. While that
  is unavailable or pending, crisp color-coded SVG glyphs are used per kind (engine, SRB, decoupler, radial decoupler,
  chute, legs, capsule, probe, tank, fin, heat shield, generic).
- **Bottom center: navball cluster.**
  - A gauges panel: **G meter** (0–8 g, green/amber/red zones and needle), **ATM** (log density relative to Verda sea level,
    with pressure in atm as the readout) and **HEAT** = the hottest part's load above ambient,
    max over parts of (T − 300 K)/(maxTemp − 300 K) — 0 % for parts at room temperature (288 K on the pad, ≤ 290 K in
    orbit), 100 % at the limit; amber above 50 %, flashing red + Overheat above 80 %. Tooltip names the hottest part and
    its temperature. (`telemetry.heatRatio` = T/maxTemp read 21 % for a cold 1 400 K chute; it is only a fallback.) The same
    value drives the crew's heat fear (`crew.update(…, { heat })`).
  - The navball in a metallic bezel. A **throttle arc** (green→orange gradient, knob and ticks) wraps its left side, a
    heading tab sits on top and a throttle tab at the bottom.
  - Above the ball, the **speed readout** (click cycles Surface / Orbit / Target; the Target option appears only when a target
    exists). It **is the vessel's speed frame**: a click calls `vessel.setControl('navMode', mode)` so SAS
    prograde/retrograde hold the marker the player sees ('auto' when the choice equals the automatic mode); the automatic
    mode is physics' `autoNavMode` (half the atmosphere — 35 km on Verda — or max(10 km, 5 % R) on airless bodies; surface
    while landed), and a manual Surface/Orbit choice returns to auto when the automatic mode flips (Target stays).
    Faint green diamond on the ball = **ascent guidance** (standard gravity turn: 88° at 1.5 % of the atmosphere, 45° at
    14 % — 10 km on Verda, 10° at 57 %, flat at 80 %; airless bodies use a max(8 km, 4 % R) band), along the ground track,
    only while climbing under thrust below the target Ap and without a node.
    Alert chips: Overheat, High G, Flameout, Low power, No control, Tipping over, Precision, **Chute unsafe** (a SEMI chute
    faster than its `safeSpeed` within 1.6 × its `deployAltitude` — it will rip) and **Chute armed** (info: armed and
    waiting for air / a speed below `safeSpeed`; physics only semi-deploys then, so this is not a danger).
  - On the right, the **SAS panel**: SAS and RCS toggles, 10 mode buttons whose icons match the navball markers, and
    Gear/Brakes/Lights indicators (all clickable). Maneuver mode is greyed out without a node; target and anti-target
    without a target. Choosing a mode while SAS is off turns SAS on.
- **Bottom right: crew portraits** (`CrewPortraits`), with the vessel name as the caption.
- **`showMessage(text, secs, kind?)`**: big centered text with blur-in and fade-out (Web Animations API). A new message
  replaces the current one.
- **`setMapMode(bool)`**: a compact layout that keeps the warp and clock bar, the navball cluster (scaled to 88%, without
  gauges), SAS, the staging stack (height-capped to stay below the map's left focus bar) and the burn-cue pill. The
  altimeter, resources, orbit panel, crew and the HUD maneuver panel are hidden, because the map has its own node editor at
  right-middle.
- **Vessel lost / no active vessel:**
  - the navball greys out behind a "NO SIGNAL" overlay
  - portraits switch to animated static with "SIGNAL LOST"
  - instrument panels desaturate
  - the situation pill reads "Signal lost" and the staging panel shows "Vessel lost"
- **Recovered (ended):** when the active vessel is removed intact (`vessel:removed` for the HUD's vessel, not destroyed —
  i.e. `flight.recover`), the HUD does NOT use the lost styling: root class `ended`, every cluster fades out over 0.9 s
  (neutral texts underneath: "Recovered", "Vessel recovered"), so the "Welcome Home!" report sits on a clean view.
- **Scaling:** everything is designed at a 1500×860 reference size and each corner cluster is scaled by `--s =
  clamp(min(w/1500, h/860), 0.72, 2.2)`. Canvases get backing stores of cssSize × s × devicePixelRatio, so they stay crisp
  from 1280×720 up to 2560×1440. Panels slide in on creation.

**Navball** (`navball.js`) has its own `THREE.WebGLRenderer` and canvas.
- **Texture:** a procedural 2048×1024 equirectangular canvas, shared by every navball on the page. It has sky-blue and
  brown hemispheres with gradients, meridians every 30°, pitch rings every 10° with 5° ticks, and pitch labels (20–60) in
  pairs beside the cardinal meridians. Labels are stretched horizontally by 1/cos(pitch) so they read correctly on the
  sphere. The horizon band carries heading ticks every 5/10/30°, N/E/S/W (N in gold) and numbers every 30°, plus zenith and
  nadir caps. If the label font was not loaded when the texture was built, the texture is redrawn once it loads.
- **Shading:** a custom ShaderMaterial (with the logdepth chunks) adds limb darkening, a key light, a specular glint and a
  cool rim.
- **Reticle:** a fixed orange chevron sprite whose center dot sits exactly at the nose.
- **Markers:** sprites whose icons are shared with the SAS buttons (`MARKER_TYPES`):
  - prograde/retrograde: yellow
  - normal/anti-normal: purple
  - radial in/out: cyan
  - maneuver: blue
  - target/anti-target: magenta
  - `guide` (ascent guidance, not a SAS mode): a small green diamond, 80 % opacity, drawn under the others

  Markers fade out toward the limb and hide behind the ball.
- **Readouts and fallback:** exposes `heading/pitch/roll` computed from the vectors, used only when telemetry lacks them.
  There is a 2D-canvas fallback if a WebGL context can't be created.

**CrewPortraits** (`crewPortraits.js`) draws original **Tinynauts** on 2D canvases as a cockpit video feed.
- **Character:** round pastel heads, huge glossy eyes with lids and saccades, a sprout, curl, spikes or shiny-bald hairdo,
  optional ears and freckles.
- **Helmet:** a bubble helmet whose **spring-loaded antenna** has a glowing tip and wobbles with g changes and shaking.
- **Suit:** pastel, with a mission badge, shoulder stripe and collar ring. The suit uses `member.color` if the roster
  provides one.
- **Cabin:** a porthole shows sky, space with the planet's curve, or reentry fire. Panel LEDs blink, with scanlines and a
  vignette.

Expressions blend smoothly from telemetry and personality:

| Mood | Trigger | What it looks like |
|---|---|---|
| Thrilled | liftoff (the PRELAUNCH→flight transition) or hard burns and supersonic flight in the air | big toothy grin, raised brows, sparkles, cabin shake |
| Terrified | high g (> 3.2 g), heat, or a fast fall near the ground | wide eyes, tiny trembling pupils, a wobbling "O" mouth, worried brows, sweat drops, the face squashed by g, a red blackout vignette at very high g |
| Floating | weightless | bobbing and tilting, "^ ^" happy squints, blush, and a zero-g star plushie drifting around the cabin |
| Sleepy | rails warp ≥ 50× | half-closed lids, yawns, drifting "z"s |
| Relieved | landed after flying | happy grin |
| Signal lost | crew lost | animated TV static with a rolling bar |

- Blinks happen at random times.
- Personality tunes the reactions: courage (less fear), stupidity (enjoys danger) and badass (fearless).
- Probe-only vessels get a cute octagonal **probe core** with an LED face that goes through the same moods.
- A status LED on each card shows the state: ok, stress, sleep or lost.
- Portraits render at 30 fps and skip drawing while hidden.

## Public API

```js
// hud.js
new FlightHUD(app, { flight, onMapToggle?, onPause?, onRecover? })   // appends .root to app.uiRoot
hud.root; hud.update(dt); hud.setMapMode(bool); hud.showMessage(text, seconds = 2, kind = 'default'); hud.dispose();
// additions (see deviations): hud.setVisible(bool); hud.onResize(); hud.toggleAltMode(); hud.cycleSpeedMode();
// hud.toggleDvMode(); FlightHUD.ready() → Promise (optional helper modules loaded — tests await it)
// hud.navball (Navball), hud.crew (CrewPortraits), hud.speedMode ('surface'|'orbit'|'target'), hud.altMode ('asl'|'radar'),
// hud.dvMode ('vac'|'now')

// navball.js
new Navball({ size = 210 })     // .canvas; setSize(cssPx, scale); setAttitude(telemetryLike); setMarker(name, dir|null);
                                // hideAllMarkers(); setSignal(ok); project(dir, out) → scene coords; render(dt); dispose()
export MARKER_TYPES, markerSVG(type, {size, color, stroke}), drawMarker(ctx, type, x, y, size, opts)

// crewPortraits.js
new CrewPortraits({ maxCards = 4 })   // .root; setCrew(crew[], { probeName }); setTitle(text); setScale(s);
                                      // setVisible(bool); update(dt, telemetry|null, { lost, warpRate, warpMode, heat? }); dispose()
                                      // heat: 0..1 load above ambient (the HUD's HEAT value); falls back to t.heatRatio
```

### Deviations and additions to ARCHITECTURE.md
- These are all additive; the §7 signatures are unchanged.
  - `showMessage` takes an optional third argument, `kind`: `'default'|'good'|'warn'|'bad'|'info'`.
  - Extra methods: `setVisible(bool)` for F2 hide-UI (the navball and portraits stop rendering while hidden),
    `onResize()` (the HUD also listens to window `resize` itself), `toggleAltMode()` and `cycleSpeedMode()`.
- The HUD itself reacts to some bus events:
  - `soi:change` → a small info message, "Entering Lune's sphere of influence"
  - `warp:denied` → the red note under the warp bar
  - `vessel:staged`, `decouple`, `part:destroyed`, `vessel:switched`, `vessel:destroyed` → refresh the stage stack (with a
    slide-in animation)
  - `vessel:removed` for the HUD's own (intact) vessel → the neutral "ended" state (recovery), see above

  It does **not** show "STAGING" or "SAS ON" messages; the flight scene calls `showMessage` for those if it wants them.
- Every HUD button emits `bus.emit('ui:click', {})`. Buttons have `tabindex=-1` and prevent focus on mousedown, so pressing
  Space never activates a HUD button.
- Optional physics telemetry extras are used when present:
  - `t.biome`
  - `t.controllable === false` → a "No control" alert
  - `t.hasTarget`, `t.targetDir` and `t.targetRelSpeed`, as a fallback when the HUD's own target math (below) fails
- Vessel controls the HUD writes (all through `vessel.setControl` when available): `sas/rcs/gear/brakes/lights`, `sasMode`
  (mode buttons; also maneuver → stability when a node completes) and **`navMode`** (speed readout click, reset to
  `'auto'` when the automatic surface/orbit mode flips or the target disappears). Vessels without `controls.navMode` keep
  a HUD-local override. Also `flight.setWarp`, `flight.warpTo` (burn, Ap, Pe) and `maneuver.removeNode` (Delete node).
- Storage keys: `tsp.hud.altMode`, `tsp.hud.resCollapsed` and `tsp.hud.dvMode`.

## How to test

- `tests/hud.html` has a realistic mock FlightSim and Vessel: a 3-crew, 5-stage rocket with SRBs, radial decouplers,
  staged engines, chutes, resources, a target station and maneuver nodes. Mock parts form a real tree (`parentUid` /
  `attach`), so `game/deltav.js` simulates their staging like in flight; each phase's `t.heatRatio` is turned into part
  temperatures (the HEAT gauge reads parts). The mock follows the vessel frame of ARCHITECTURE §1 (right = forward × top,
  pad: belly east / top west). Pick the phase with the URL hash; keys 1–9 switch phases.
  - Phases: `#pad #liftoff #ascent #orbit #burn #warp #reentry #chute #landed #destroyed #probe #landing #touchdown
    #highorbit #nodedone #recovered #map` (`?preroll=N` pre-rolls N s, e.g. `tests/hud.html?preroll=25#landing` for the
    suicide-burn cue, `?preroll=5#touchdown` for the tip-over alert, `?preroll=3#nodedone` for a latched node)
  - `#crew` shows a large gallery of every Tinynaut mood.
  - `#real` launches the actual `FlightSim` + `orbiter_1` stock craft from the physics area, driving the HUD with real
    telemetry and staging.

  Each phase pre-rolls about 4 s of simulated time, so the slow headless renderer still shows steady-state expressions.
- Screenshots:
  `node tools/snap.mjs "tests/hud.html#orbit" --out shots/hud_orbit.png --wait 5000 [--size 1920x1080]`.
  Current shots: `shots/hud_*.png` at 1280×720, plus `_1080` and `_1440` variants and `hud_crew_gallery.png`.
- Self-test (32 checks):
  `node tools/snap.mjs "tests/hud.html#orbit" --out shots/x.png --wait 6000 --eval "JSON.stringify(window.__hudTest.selfTest())"`.
  It checks:
  - navball math: the nose maps to the center, top to screen-up and right to screen-right; the ball texture rotation matches
    the projection for random attitudes; the texture heading convention (u = heading/360, east = ball-local +Z); the pad
    attitude shows east straight down and north on the left
  - speed readout ↔ `vessel.controls.navMode` (and the reset to auto at the 35 km switch)
  - HEAT 0 % at 288 K / 90 % + Overheat near the limit; altimeter at rest on 79.512 m shows whole digits (80)
  - chute alerts (semi at 278 m/s fine, semi at 340 m/s near deploy altitude unsafe, armed + fast = info)
  - mini orbit diagram inside its box on a 12 000 × 24 000 km orbit
  - pad: "—" orbital elements, launch-stage TWR, vacuum staging ΔV with per-stage TWR
  - node "done" latch through an overshoot, SAS maneuver → stability, Delete node button
  - recovery → `ended` (not `lost`, no NO SIGNAL / "Vessel lost")
  - no throws on `{}`, `null` or NaN telemetry, a null active vessel, or a throwing `getStages`
  - SAS toggle, SAS mode, maneuver-mode availability, gear, warp chevrons → `setWarp`, `ui:click`
  - speed-mode cycling, map mode, `showMessage`
  - dispose and re-create
  - **zero DOM mutations in steady-state frames**
  - click-through of empty screen areas
- Syntax: `node --check src/ui/hud.js src/ui/navball.js src/ui/crewPortraits.js`.

## Integration notes (for the flight-scene engineer)

- Create: `this.hud = new FlightHUD(app, { flight: game.flight, onMapToggle: () => this.toggleMap(), onPause: () => this.openPause(), onRecover: () => this.recover() })`.
- Every frame, after `flight.update(dt)`, call `hud.update(dt)`. On map toggle call `hud.setMapMode(on)`; on F2 call
  `hud.setVisible(!hidden)`; in `exit()` call `hud.dispose()`. The HUD does no keyboard handling, so the scene keeps all
  key bindings.
- `hud.dispose()` releases the navball's WebGL context (`forceContextLoss`), unsubscribes from the bus and removes the
  resize listener, so re-entering the flight scene is safe.
- **Navball orientation convention** (ARCHITECTURE §1, pilot's view, not mirrored): screen center is `forward` (+Y),
  screen-up is `top` (+Z), screen-right is the pilot's right (+X = forward × top). D (yaw → +X) moves the nose right, W
  (pitch down → −Z, the belly) moves it down.
  - On the pad (belly east, top west, +X south) the ball shows the belly heading E at the bottom and N on the left;
    after W tips the nose east the top points at the sky and the horizon is level.
- Speed mode = the vessel's `navMode` (see above): automatic switch at physics' `autoNavMode` threshold (35 km on Verda,
  10 km on Lune), surface while landed; the player overrides by clicking. Target mode computes the relative
  position and velocity from `flight.vessels` (same SOI), or through `physics/universe.js` for other SOIs and body targets.
- **Biome:** the HUD uses `t.biome` from physics when available. Otherwise it calls `world/terrain.js` `biomeName` on the
  body-fixed direction (`universe.inertialToFixed(pos)`, falling back to lat/lon in degrees). Biome is shown only below
  max(atmosphere height, 10% of the radius). On PRELAUNCH it always reads "Launch Pad".
- Crew objects may carry `color` (used as the suit color) and `dead`/`kia`/`status: 'dead'|'kia'|'lost'`, which switches
  that portrait to static. `vessel.destroyed` or `flight.active === null` puts the whole HUD in the lost state — unless
  the vessel was removed intact (recovery), which fades the HUD out instead.
- Low graphics (`game.settings.graphics === 'low'` at construction) disables the frosted-glass `backdrop-filter`.
- Optional modules are loaded once through defensive dynamic imports: `world/terrain.js`, `game/maneuver.js`,
  `physics/universe.js`, `render/partMeshes.js`, `physics/telemetry.js` (`autoNavMode`) and `game/deltav.js`
  (`computeStageStats`). Every one has a fallback (local autoNavMode copy; `getStages()` ΔV; telemetry TWR). `burnVector` falls back first to
  `node.targetVel − orbit.getStateAtUT(node.ut).vel`, then to `node.dv` in the current burn frame.

## Known issues / limitations

- Part thumbnails render one at a time inside partMeshes, so on the first HUD build the icons show SVG glyphs and then swap to
  thumbnails as they finish. Flat parts (decouplers, heat shields) are still hard to tell apart as 30 px thumbnails; the
  colored icon border (orange engine, yellow decoupler, teal chute…) helps. To prefer glyphs, return `null` from `_thumb`.
- Headless SwiftShader renders the HUD at about 1 fps because of software-composited `backdrop-filter`. The HUD's own
  JavaScript cost is around 0.1 ms per frame (measured: navball render call about 0.06 ms, portraits about 0.1 ms). Real
  GPUs are unaffected.
- Staging ΔV numbers refresh at about 1 Hz; the stack structure is rebuilt only when the vessel, `currentStage` or part
  count changes, or on staging and decouple events.
- The mini orbit diagram is a schematic: Pe is always drawn to the right, and it ignores inclination and argument of
  periapsis.
- The mini orbit diagram squeezes radii when the planet has to be clamped (orbits > ~10 planet radii): shapes of very
  eccentric high orbits are schematic, not to scale.
- Landing aids use the vertical speed only for the suicide burn (horizontal drift is assumed small) and the slope directly
  under the vessel (not at the predicted touchdown point). The burn countdown keeps an 8 % thrust margin and a 4 m
  height margin; it is advice, not an autopilot.
- Ascent guidance is a fixed profile scaled by the atmosphere height; very low-TWR rockets need a flatter-later turn than
  it shows, and it does not know about the vessel's aerodynamics.

## Playtest round 2 — what changed (HUD)

| Report | Fix |
|---|---|
| HEAT reads 21–24 % when cold (×2 reports) | HEAT = max (T − 300 K)/(maxTemp − 300 K) from the parts (0 % on the pad and in orbit); alerts and crew fear use it; tooltip names the hottest part |
| Speed readout Surface/Orbit didn't change what SAS holds; HUD switched at 36 km, SAS at 35 km (×2 reports) | the readout **is** `controls.navMode` (setControl on click, reset to auto at the automatic switch); automatic mode = physics' `autoNavMode` |
| Odometer half-rolled digits at rest (79.5 m) | at-rest hold of the nearest integer with hysteresis + eased transitions; reset on unit/mode switch |
| "Chute unsafe" while a semi chute was fine | per-part `safeSpeed`/`deployAltitude`: only a SEMI chute that is too fast near its deploy altitude is unsafe; armed-and-waiting is an info chip |
| Recovery showed red NO SIGNAL / "Vessel lost" | `vessel:removed` of the intact active vessel → `ended`: the HUD fades out, neutral texts |
| Burn cue went back to "Burn now!" after an overshoot, SAS maneuver flipped the ship | per-node latched "done" (small remainder or a direction flip), SAS maneuver → stability on completion, Delete node button |
| TWR "0.00 / 2,026.93" near Lune's SOI edge, "880.99" on a 12 000 km orbit (×2) | TWR against the body's surface gravity |
| Staging ΔV (sea level) disagreed with the VAB (vac) | vac/now ΔV from `computeStageStats` (VAB simulator), toggle chip, other reference per row, per-stage TWR |
| Pad: e 0.9948, TWR 0.00/0.00 | "—" for inc/ecc/period on the ground; max TWR = launch stage before ignition |
| Mini orbit diagram overflowed on high orbits | bounded radial mapping (fit radius 43/50) + `overflow: hidden` |

Improvements: warp to Ap/Pe (orbit panel chips), ascent guidance (navball diamond + Ap/time-to-Ap/pitch cue), landing aids
(slope, impact, suicide-burn countdown, drift, lean, tip-over alert, auto radar altimeter), "Verda orbit ≈ 3,400 m/s" bar on
the ground, orbit-panel stage/total ΔV in the staging reference, SAS mode buttons go through `setControl('sasMode')` (resets
the SAS hold like the keyboard does).
