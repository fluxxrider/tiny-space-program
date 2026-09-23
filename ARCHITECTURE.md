# Tiny Space Program — Architecture & Module Contracts

A Kerbal-Space-Program-inspired rocket building & orbital-flight sandbox that runs in the browser.
Build rockets from parts in the VAB, launch from the pad, fly with real Newtonian physics, reach orbit with patched-conic
orbital mechanics, plan maneuvers in the map view, visit moons & planets, re-enter with fire and float down on parachutes —
or explode spectacularly. **Quality bar: it should feel amazing** — beautiful planets with atmospheres, satisfying launches
(smoke, rumble, camera shake), intuitive editor, readable HUD, charming crew.

This document is the **contract** between modules written in parallel by different engineers. Follow the signatures exactly.
If you truly need something not specified here, implement it inside *your own* files with a safe fallback, and record it
in your `notes/<area>.md` under "Integration notes".

---------------------------------------------------------------------------------------------------------------------------

## 0. Tech stack, running, layout

* Plain **ES modules** (no build step, no TypeScript, no frameworks). **three.js r170** via import map:
  `import * as THREE from 'three'` and addons from `'three/addons/...'` (e.g. `three/addons/postprocessing/EffectComposer.js`).
* Run: `node tools/serve.mjs` → http://localhost:8765/ . Node tests: `node tools/run-tests.mjs [filter]`.
* Headless browser harness (WebGL works via SwiftShader — slow but correct):
  `node tools/snap.mjs <page> --out shots/x.png --wait 5000 [--eval "<js>"] [--script tests/scn.mjs] [--shots 1000,5000]`
  prints JSON `{errors, warnings, logs, shots, evalResult}`; view PNGs with the Read tool. **Use it to verify your work visually.**
* `package.json` has `"type": "module"`, so node can import any module under `src/` that does not touch `window`/`document`
  at import time (all physics/data/game-logic modules MUST be node-importable; `three` resolves from node_modules).

```
index.html                 import map, canvas#game-canvas, div#ui-root, div#toast-root, div#loading
src/main.js                App: renderer, scene manager, loop, debug hooks (window.TSP)
src/core/constants.js      G0, PHYSICS_DT, WARP_RATES, SIZE_RADIUS, RESOURCES, …
src/core/events.js         bus (on/once/off/emit), toast()
src/core/state.js          game singleton, storage (localStorage JSON, prefix "tsp."), settings
src/data/bodies.js         BODIES, BODY_ORDER, HOME_BODY, LAUNCH_SITE, latLonToDir, dirToLatLon
src/data/parts.js          PARTS, PART_LIST, PART_CATEGORIES, getPart, partWetMass
src/game/input.js          polled keyboard/mouse input
src/ui/dom.js              el(), loadCSS(), fmtDistance/fmtSpeed/fmtMass/fmtDuration/fmtUT/fmtDeltaV/clamp/lerp
src/ui/toast.js, base.css  toasts + design system (CSS variables --tsp-*, classes .tsp-panel/.tsp-btn/.tsp-modal …)
```

### File ownership (only edit files you own; core files above are read-only for everyone)

| Area (notes file) | Owns |
|---|---|
| **orbits** (`notes/orbits.md`) | `src/physics/orbit.js`, `src/physics/universe.js`, `tests/orbit.test.mjs`, `tests/universe.test.mjs` |
| **physics** (`notes/physics.md`) | `src/physics/atmosphere.js`, `src/physics/vessel.js`, `src/physics/flight.js`, `src/physics/sas.js`, any `src/physics/*` helper not owned by orbits, `tests/vessel.test.mjs`, `tests/flight.test.mjs` |
| **worlds** (`notes/worlds.md`) | `src/world/*` (terrain.js, noise.js), `src/render/planets.js`, `src/render/terrainLOD.js`, `src/render/atmosphere.js`, `src/render/sky.js`, `src/render/water.js`, `tests/terrain.test.mjs`, `tests/planets.html` |
| **parts3d** (`notes/parts3d.md`) | `src/render/partMeshes.js`, `src/render/materials.js`, `src/render/vesselRenderer.js`, `src/render/plume.js`, `tests/parts.html`; may add purely visual fields (under `mesh:`) to `src/data/parts.js` |
| **fx** (`notes/fx.md`) | `src/render/effects.js`, `src/render/particles.js`, `src/audio/*`, `tests/effects.html`, `tests/audio.html` |
| **vab** (`notes/vab.md`) | `src/scenes/vab.js`, `src/scenes/vab/*`, `src/ui/vab.css`, `src/game/craft.js`, `src/game/deltav.js`, `src/game/stockCrafts.js`, `tests/craft.test.mjs` |
| **hud** (`notes/hud.md`) | `src/ui/hud.js`, `src/ui/navball.js`, `src/ui/crewPortraits.js`, `src/ui/hud.css`, `tests/hud.html` |
| **map** (`notes/map.md`) | `src/ui/mapView.js`, `src/ui/map.css`, `src/game/maneuver.js`, `tests/map.html`, `tests/maneuver.test.mjs` |
| **shell** (`notes/shell.md`) | `src/scenes/flightScene.js`, `src/scenes/spaceCenter.js`, `src/scenes/tracking.js`, `src/render/kscModels.js`, `src/game/cameraController.js`, `src/game/missions.js`, `src/game/crew.js`, `src/game/persistence.js`, `src/ui/menus.js`, `src/ui/shell.css`; may edit `src/main.js` and `index.html` |

---------------------------------------------------------------------------------------------------------------------------

## 1. Conventions

### Units
SI inside the simulation: meters, seconds, kilograms, newtons, radians, kelvin, pressure in **kPa**.
Part definitions use KSP units (tonnes, kN, kN·m, resource units) — convert when loading (`×1000`).
Angles in `bodies.js` orbit elements and part `gimbal`/`maxDeflection` are in **degrees**; everything at runtime is radians.

### Frames
* **World/inertial axes** (shared by every body): **+Y = north** (spin axis of every body, normal of the ecliptic), XZ = equatorial plane.
  Every body spins and every orbit is prograde **counter-clockwise when viewed from +Y** (angular momentum ∥ +Y).
* **Root frame**: inertial, origin at the star (Sola). `universe.bodyPosition(id, ut)` is in this frame.
* **Body-relative inertial frame**: inertial axes, origin at a body's center. **Vessel `pos`/`vel` are in this frame for
  the body whose SOI the vessel is in** (`vessel.bodyId`).
* **Body-fixed (rotating) frame**: rotates with the body about +Y. `inertial = Ry(θ) · fixed` with
  `θ(ut) = body.initialRotation + 2π·ut/body.rotationPeriod` and `Ry(θ)` = `new THREE.Quaternion().setFromAxisAngle(Y, θ)`
  (x' = x cosθ + z sinθ, z' = −x sinθ + z cosθ). Terrain, lat/lon, the launch pad and landed vessels live here.
* **Lat/lon**: `latLonToDir(lat, lon) = (cos lat cos lon, sin lat, −cos lat sin lon)` (body-fixed). East = increasing lon.
  At body-fixed (R,0,0) (lat 0, lon 0): up = +X, north = +Y, **east = −Z**. Surface velocity of the air = ω × r with ω = (0, 2π/T, 0).
* **Vessel-local frame**: root part at the origin, **+Y = nose** (thrust direction of a normal rocket), **+Z = top** (the
  pilot's "up"), **+X = pilot's right** (= forward × top), **−Z = belly**. At launch the vessel stands nose-up with its
  **belly facing east, top facing west, +X facing south** (LAUNCH_SITE.heading = 180), so pitching down (W) tips the nose
  east and after the gravity turn the top points at the sky — the navball and chase camera stay level.
  `vessel.rot` (Quaternion) maps vessel-local → inertial. `vessel.pos` is the inertial position of the **center of mass**;
  `vessel.comLocal` is the CoM in vessel-local coordinates. Inertial position of a vessel-local point p:
  `pos + rot·(p − comLocal)`. When comLocal changes (fuel burn / staging) shift `pos` by `rot·(newCom − oldCom)` so nothing jumps.
* **Part-local frame**: origin at part center, +Y up the stack; `part.pos`/`part.rot` place it in vessel-local space.
* **Scene frame (rendering, floating origin)**: 1 unit = 1 m, three.js axes = world axes. Each frame the flight scene picks an
  `originRootPos` (Vector3, root frame; normally the active vessel's CoM) and every object is placed at
  `rootPos − originRootPos`. Nothing large ever sits at huge coordinates in float32 on the GPU.
  The renderer uses `logarithmicDepthBuffer: true` — **every custom ShaderMaterial must include the logdepthbuf chunks**
  (`#include <common>`, `#include <logdepthbuf_pars_vertex>`, `#include <logdepthbuf_vertex>` after gl_Position,
  `#include <logdepthbuf_pars_fragment>`, `#include <logdepthbuf_fragment>`) or it will z-fight/vanish.

### Control axes (vessel-local torques)
| Input | Keys | Effect | Torque axis (vessel-local) |
|---|---|---|---|
| pitch +1 | S (pitch up) | nose → +Z (top) | +X |
| pitch −1 | W (pitch down) | nose → −Z (belly; east on the pad) | −X |
| yaw +1 | D (yaw right) | nose → +X | −Z |
| yaw −1 | A | nose → −X | +Z |
| roll +1 | E (roll right) | top rolls toward +X (clockwise seen from behind) | +Y |
| roll −1 | Q | | −Y |
Translation (RCS, vessel-local force direction, `controls.x/y/z`): `H` forward (+Y), `N` back (−Y), `J` left (−X), `L` right (+X), `I` up (+Z, toward the vessel top), `K` down (−Z).
Navball: screen center = nose, screen-up = top (+Z), screen-right = +X (the pilot's view, not mirrored).

### Orbit element conventions
Elements in `bodies.js`: `sma` (m), `ecc`, `inc`/`lan`/`argPe` (deg), `meanAnomalyAtEpoch` (rad), `epoch` (s).
Standard Keplerian math is done in an internal **Z-up** frame and mapped to world by `world = (xi, zi, −yi)`,
`internal = (xw, −zw, yw)` (a proper rotation; cross products preserved). Hence inc = 0 ⇒ angular momentum ∥ world +Y,
LAN measured from world +X toward internal +Y (= world −Z). Hyperbolic orbits: `ecc > 1`, `sma < 0`.
Maneuver/burn frame: **prograde** P = v̂, **normal** N = (r × v)̂, **radial-out** R = P × N.

---------------------------------------------------------------------------------------------------------------------------

## 2. Core (already written — read the source)

* `bus.on(name, fn) → unsubscribe`, `bus.once`, `bus.off`, `bus.emit(name, payload)`; `toast(text, kind, ms)`.
* `game` (core/state.js): `ut`, `flight` (FlightSim), `editorCraft`, `lastLaunchCraft`, `settings`
  (`masterVolume, musicVolume, sfxVolume, graphics:'low'|'medium'|'high', bloom, shadows, mouseSensitivity, invertY, showFPS, tutorialHints`),
  `progress` ({milestones:{[id]:{ut, date}}, stats}), `roster`, `debug`, `paused`. `saveSettings()`, `saveProgress()`, `storage.get/set/remove`.
* `input.isDown(code)`, `input.wasPressed(code)`, `input.wasReleased(code)`, `input.shift()/ctrl()/alt()`,
  `input.mouse {x,y,dx,dy,wheel,buttons}`; `input.endFrame()` is called by main loop. Codes are `KeyboardEvent.code`.
* `el(tag, attrs, ...children)`, `loadCSS(href)`, formatting helpers in `src/ui/dom.js`. **Use them** for consistency.

### Events (bus) — canonical names & payloads
| Event | Payload | Emitted by |
|---|---|---|
| `scene:change` | `{from, to, params}` | main |
| `toast` | `{text, kind, duration, title?}` | anyone |
| `flight:launched` | `{vessel}` | physics |
| `vessel:staged` | `{vessel, stage, parts}` | physics |
| `engine:ignite` / `engine:flameout` | `{vessel, part}` | physics |
| `decouple` | `{vessel, part, newVessels}` | physics |
| `part:destroyed` | `{vessel, part, reason:'impact'|'heat'|'aero'|'chute', rootPos:Vector3, bodyId, vel:Vector3, size:number(m)}` | physics |
| `vessel:created` / `vessel:removed` / `vessel:destroyed` | `{vessel}` | physics |
| `vessel:switched` | `{from, to}` | physics |
| `chute:deploy` | `{vessel, part, state:'semi'|'deployed'}` ; `chute:cut` `{vessel, part}` | physics |
| `soi:change` | `{vessel, from, to}` | physics |
| `situation:change` | `{vessel, from, to}` | physics |
| `warp:change` | `{index, rate, mode:'rails'|'physics'}` ; `warp:denied` `{reason}` | physics |
| `control:toggle` | `{vessel, what:'sas'|'rcs'|'gear'|'brakes'|'lights', value}` | physics (via Vessel setters) |
| `maneuver:changed` | `{vessel}` | map |
| `milestone` | `{id, title, description, reward?}` | shell/missions |
| `flight:quicksave` / `flight:quickload` | `{}` | shell |
| `ui:click` | `{}` (any button click, for sfx) | UI modules (optional) |

---------------------------------------------------------------------------------------------------------------------------

## 3. Data

### bodies.js
`BODIES[id] = { id, name, type:'star'|'planet'|'moon', parent, radius, mu, rotationPeriod, initialRotation (rad), soi,
atmosphere: null | { height, pressureASL (kPa), scaleHeight, temperatureASL, temperatureTop, densityASL, rayleigh:[r,g,b], sunset:[r,g,b], hazeDensity },
orbit: null | { sma, ecc, inc, lan, argPe, meanAnomalyAtEpoch, epoch }, color, mapColor, description,
terrain: null | { style:'earthlike'|'cratered'|'flats'|'desert'|'violet'|'scorched', maxHeight, ocean, seed, palette:{…} },
warpAltitudes:[8 numbers] }`.
Bodies: `sola` (star) · `cinder` · `vesper` (thick purple atmosphere, oceans) · **`verda` (home, oceans, 70 km atmosphere)** ·
`lune` (Verda's big moon) · `pip` (Verda's tiny moon) · `rusta` (red planet, thin atmosphere) · `nib` (Rusta's moon).
`LAUNCH_SITE = { bodyId:'verda', lat:-0.0972, lon:-74.5577, altitude:70, flattenRadius:1500, blendRadius:5000, heading:180 }`.
`warpAltitudes[i]` = minimum altitude (ASL) for rails warp index i (index 0 = 1× always allowed).

### parts.js — part definition schema
```
{ id, name, category, description, cost,
  mass (t, dry), radius (m), topRadius? (m, for cones/adapters), height (m), size (0|1|2),
  nodes: { top?: {pos,dir,size}, bottom?: {pos,dir,size} },  srfAttach: [x,y,z] | null,  allowSrfAttach: bool,
  crew?: n, resources: { Name: maxUnits }, dragCd, dragArea (m²), maxTemp (K), crashTolerance (m/s),
  modules: { … see below … }, mesh: { style, … visual hints } }
```
Modules:
* `command {crew, probe, ecPerSec}` — makes the vessel controllable (probe needs ElectricCharge > 0; crewed pods always work).
* `reactionWheel {torque (kN·m), ecPerSec (at full use)}`.
* `engine {type:'liquid'|'solid'|'nuclear', thrustVac (kN), ispVac, ispASL, propellants:{Res: ratioByUnits}, gimbal (deg),
  throttleLocked (SRBs: once lit burn at 100% until empty), spool (s, throttle response time constant),
  nozzle:{y (part-local exit y), radius}, plume:{color, core, length, smoke}}`.
  **Fuel flow is fixed by throttle**: `maxMassFlow = thrustVac·1000 / (ispVac·G0)` kg/s; actual thrust
  `F = throttleEff · maxMassFlow · G0 · isp(p)`, `isp(p) = ispVac + (ispASL − ispVac)·(p / 101.325)` clamped to ≥ 0.05·ispVac.
  Propellant units/s: `k = massFlow / Σ(ratio_i·density_i·1000)`, `units_i = ratio_i·k`.
* `decoupler {ejectionForce (kN, applied for one physics step to both sides, opposite directions), radial}`.
  Stack decoupler: separates at its **top** node — cuts the connection between the decoupler and whatever is attached to its
  top node; the decoupler stays with the part(s) on its bottom node. Radial decoupler: cuts the connection to its **parent**
  (the core); the decoupler stays with the booster. The piece containing the vessel's command part (or root) stays the vessel;
  the other piece becomes a new debris `Vessel`.
* `parachute {semiArea, fullArea (Cd·A in m²), minPressure (kPa), deployAltitude (m above terrain), safeSpeed (m/s), canopyDiameter, canopyColor}`.
  Staged → `armed`; when static pressure > minPressure → `semi` (streamer); when radar altitude < deployAltitude → `deployed`
  (opening over ~2 s). If full deployment happens above safeSpeed (surface speed) the chute is `destroyed`. Chutes are `cut`
  after landing (speed < 0.5 m/s for 2 s) or by user action.
* `legs {footStowed, footDeployed ([x,y,z] part-local), stroke (m), deployTime (s)}` — toggled by G (gear). Contact points
  at the foot, spring-damper suspension with the given stroke.
* `fin {area (m²), control, maxDeflection (deg), span, rootChord, tipChord}` — lift ∝ sin(2α)·q·area applied at the fin
  (normal to the fin plane = part-local Z); control fins deflect with pitch/yaw/roll input & SAS.
* `heatShield {ablatorPerKW}` — consumes Ablator to reject heat.
* `rcs {thrust (kN per nozzle), ispVac, ispASL, nozzles:[{pos, dir (EXHAUST direction, part-local)}]}` — uses MonoPropellant.
* `solarPanel {chargeRate (EC/s in full sun)}`.

---------------------------------------------------------------------------------------------------------------------------

## 4. Physics (orbits + physics areas)

### src/physics/orbit.js  (orbits)
```js
export class Orbit {
  constructor({ mu, sma, ecc, inc, lan, argPe, meanAnomalyAtEpoch, epoch })   // angles in RADIANS
  static fromBodyElements(bodyOrbitDeg, mu)          // convert a bodies.js orbit (degrees) → Orbit
  static fromStateVectors(pos, vel, mu, ut)          // THREE.Vector3 world-axis vectors relative to the central body
  // properties: mu, sma, ecc, inc, lan, argPe, meanAnomalyAtEpoch, epoch, meanMotion, period (Infinity if ecc>=1),
  //             semiLatusRectum, apoapsis (radius; Infinity if ecc>=1), periapsis (radius), energy
  getStateAtUT(ut, outPos?, outVel?)  → { pos, vel }   // robust for elliptic (0≤e<1, incl. e≈0), parabolic-ish and hyperbolic
  getPositionAtUT(ut, out?) → Vector3
  meanAnomalyAtUT(ut), trueAnomalyAtUT(ut), radiusAtTrueAnomaly(nu), positionAtTrueAnomaly(nu, out?)
  timeToApoapsis(ut) (Infinity if hyperbolic), timeToPeriapsis(ut) (time until next periapsis; for a hyperbolic orbit already past Pe return a negative value = −time since Pe)
  UTAtTrueAnomaly(nu, afterUT)                          // next time ≥ afterUT the body is at true anomaly nu
  trueAnomalyAtRadius(r)                                // [0, π] or NaN
  getOrbitPoints(n, { maxRadius = Infinity, fromNu, toNu } = {}) → Vector3[]  // for drawing (relative to central body)
  normal (Vector3, unit angular momentum), clone()
}
export function burnFrame(pos, vel) → { prograde, normal, radial }          // unit Vector3s (see §1)
export function dvToWorld(pos, vel, dv /*{prograde,normal,radial}*/, out?) → Vector3
export function worldToDv(pos, vel, vec) → { prograde, normal, radial }
export function predictTrajectory({ bodyId, pos, vel, ut, maneuvers = [], maxPatches = 4, maxTime = 20 yrs })
  → [ { bodyId, orbit, startUT, endUT, endReason: 'soi_exit'|'soi_enter'|'impact'|'maneuver'|'end', nextBodyId? , impactUT? } ]
  // maneuvers: [{ ut, dv:{prograde,normal,radial} }] applied in order (dv expressed in the frame at the node on the then-current patch).
export function findNextSOITransition(orbit, bodyId, fromUT, toUT) → { ut, toBodyId, kind:'exit'|'enter' } | null
export function findImpactUT(orbit, body, fromUT, toUT) → ut | null        // first time radius ≤ body.radius (sea level) — terrain handled by physics
```

### src/physics/universe.js  (orbits)
```js
export function bodyOrbit(id) → Orbit | null                 // around parent (cached)
export function bodyStateRelParent(id, ut, outPos?, outVel?) → { pos, vel }
export function bodyPosition(id, ut, out?) → Vector3         // root frame (sums up the hierarchy); sola → (0,0,0)
export function bodyVelocity(id, ut, out?) → Vector3         // root frame
export function children(id) → string[]
export function soiBodyAt(rootPos, ut) → id                  // deepest body whose SOI contains the point
export function rotationAngle(id, ut) → θ (radians)
export function rotationQuat(id, ut, out?) → Quaternion      // body-fixed → inertial
export function inertialToFixed(id, vec, ut, out?)            // rotate a body-relative inertial vector into body-fixed
export function fixedToInertial(id, vec, ut, out?)
export function surfaceVelocity(id, relPos, out?) → ω × r    // velocity of the ground/air at relPos (inertial)
export function latLonAlt(id, relPos, ut) → { lat, lon, alt }  // alt above sea level (radius)
export function sunDirection(bodyId, relPos, ut, out?) → unit Vector3 from the point toward Sola
export function isInShadow(bodyId, relPos, ut) → bool         // occluded by its own body (cylindrical shadow is fine)
export function surfaceFrame(id, relPos, out = {up, north, east}) // unit vectors at relPos (inertial axes)
```

### src/physics/atmosphere.js  (physics)
`atmosphereAt(bodyId, altitude) → { pressure (kPa), density (kg/m³), temperature (K), speedOfSound (m/s) }`.
Exponential with scale height, tapered to exactly 0 at `atmosphere.height` (`P = P0·(e^{−h/H} − e^{−h_top/H})/(1 − e^{−h_top/H})`).
Density ∝ pressure (use densityASL). Zero outside atmosphere / airless bodies.

### src/physics/vessel.js  (physics)
```js
export class Vessel {
  static fromCraft(craft, { bodyId, ut, name? }) → Vessel     // builds parts; caller then places it (FlightSim.launch)
  id (string), name, type: 'ship'|'probe'|'debris'
  parts: PartState[]            // alive parts only (destroyed/decoupled parts are removed from this array)
  root: PartState
  bodyId, pos: Vector3, vel: Vector3, rot: Quaternion, angVel: Vector3 (inertial rad/s), comLocal: Vector3
  mass (kg, total), situation: 'PRELAUNCH'|'LANDED'|'SPLASHED'|'FLYING'|'SUB_ORBITAL'|'ORBITING'|'ESCAPING'
  onRails (bool), orbit (Orbit | null — osculating orbit, kept current every frame for display & rails)
  landedAt: null | { fixedPos: Vector3 (body-fixed CoM pos), fixedRot: Quaternion (vessel-local → body-fixed) }  // when LANDED/SPLASHED/PRELAUNCH
  controls: { throttle 0..1, pitch, yaw, roll, x, y, z (−1..1), sas, sasMode, rcs, gear, brakes, lights, precision }
     // sasMode: 'stability'|'prograde'|'retrograde'|'normal'|'antinormal'|'radialIn'|'radialOut'|'maneuver'|'target'|'antitarget'
  currentStage (int)            // starts at maxStage+1; stage() decrements and activates parts with part.stage === currentStage
  crew: [{ name, role, courage, stupidity, badass, id }]   // assigned by the shell at launch; HUD shows portraits
  maneuverNodes: [ node ]       // see game/maneuver.js
  target: null | { type:'body'|'vessel', id }
  history: { launchUT, maxAltitude, maxSpeed, visited:Set<bodyId>, landed:Set<bodyId>, orbited:Set<bodyId>, splashed:Set }
  telemetry: { … see below … } // refreshed every physics frame for the active vessel (and on demand for others)
  destroyed (bool), reentryIntensity (0..1), gForce (g)

  stage() → { stage, parts } | null
  setControl(name, value)       // sas/rcs/gear/brakes/lights emit control:toggle
  getStages() → [{ stage, parts:[PartState], deltaV, burnTime }]  // for the HUD staging stack (current & future stages)
  partWorldPos(part, out) → Vector3   // body-relative inertial
  localToWorldDir(v, out), worldToLocalDir(v, out)
  totalResources() → { Res: {amount, max} }, stageResources() → same, for the current stage's engines' fuel domain
  updateTelemetry(ut)
  serialize() → plain JSON ; static deserialize(json) → Vessel
}
PartState = {
  uid, id (part def id), def, pos: Vector3, rot: Quaternion (part-local → vessel-local), parentUid, attach, stage, sym,
  resources: { Res: { amount, max } }, temp (K), destroyed,
  engine?: { active, throttleEff (0..1 actual output), thrust (N, current), flameout, gimbal: Vector2 (rad) },
  chute?: { state: 'stowed'|'armed'|'semi'|'deployed'|'cut'|'destroyed', t (0..1 opening progress) },
  legs?: { deployed (bool), t (0..1 animation), compression (0..1) },
  fin?: { deflection (rad) }, rcs?: { firing: number[] (0..1 per nozzle) }, decoupled?: bool
}
```
**Telemetry** object (all fields always present; numbers in SI; vectors are unit THREE.Vector3 in inertial axes):
```
{ bodyId, bodyName, situation, ut,
  altitude (ASL), radarAltitude (above terrain or sea surface), lat, lon,
  orbitalSpeed, surfaceSpeed, verticalSpeed, horizontalSpeed,
  apoapsis, periapsis (altitudes ASL; apoapsis = Infinity if escaping), timeToAp, timeToPe, inclination (deg), eccentricity, period,
  gForce, mach, dynamicPressure (kPa), staticPressure (kPa), density, externalTemp,
  mass (kg), thrust (N), maxThrust (N, current stage at current pressure), twr (current), maxTwr,
  stageDeltaV, totalDeltaV, stageBurnTime (s),
  throttle, sas, sasMode, rcs, gear, brakes, lights, currentStage,
  heatRatio (max part temp / maxTemp, 0..1+), reentryIntensity (0..1), electricCharge (fraction 0..1),
  resources { Res: {amount,max} }, stageResources { … },
  up, north, east, forward (vessel +Y), top (vessel +Z), right (vessel +X),
  prograde (orbital), surfacePrograde, normal, radialOut,
  heading, pitch, roll (deg, relative to the surface frame; heading 0 = north, 90 = east),
  warpRate, warpMode }
```

### src/physics/flight.js  (physics)
```js
export class FlightSim {
  constructor(game)                  // uses game.ut
  vessels: Vessel[], active: Vessel | null
  warp: { index, rate, mode: 'rails'|'physics' }
  update(realDt)                     // advance game.ut by realDt × warp rate (fixed 0.02 s steps in physics mode, analytic on rails)
  launch(craft, { crew } = {}) → Vessel   // spawns at LAUNCH_SITE resting on the pad (PRELAUNCH), makes it active
  stage()                            // active vessel
  setWarp(index) → { ok, reason }    // picks physics warp (index 1..3 → 2×/3×/4×) automatically inside atmospheres / under thrust
  warpTo(ut)                         // auto-warp until ut (stops 10 s before)
  setActive(vessel), cycleActive(dir)
  removeVessel(vessel), recover(vessel) → { funds?, crew }     // only when LANDED/SPLASHED on home body
  packAll()                          // put everything on rails (leaving the flight scene)
  serialize() → JSON ; static deserialize(json, game) → FlightSim
}
```
**Behaviour requirements**
* Forces: gravity (current SOI body), thrust (per engine, along engine −(exhaust) direction incl. gimbal), drag per part at part position
  (relative to air: `v − ω×r`; occlusion — stack parts shielded by an attached neighbour on the windward node contribute little),
  fin lift, parachute drag (applied at chute position; makes the capsule hang nose-up), contact forces, RCS.
  Torques emerge from force positions relative to CoM + reaction wheels + gimbal. Integrate translation & rotation
  (inertia tensor from parts as cylinders/point masses) with a stable integrator (sub-step if needed). Add mild angular damping.
* Resting on the pad must be perfectly still (PRELAUNCH is pinned in the body-fixed frame until thrust > weight or the user
  stages). Landed vessels with |v_surface| < 0.3 m/s and no thrust are pinned (`landedAt`) to avoid jitter.
* Ground contact vs `terrain.surfaceHeight` (use part bounding points + leg feet). Impact faster than crashTolerance
  destroys that part (`part:destroyed`, reason 'impact'); the vessel splits into pieces if the tree is cut. Water: SPLASHED.
* Heating: convective flux ∝ √ρ·v³ above ~Mach 2; parts facing the airflow heat most; parts shielded behind a heat shield
  or pod heat much less; radiate to ambient. temp > maxTemp → destroyed (reason 'heat'). `reentryIntensity` for effects.
* Aero overload: dynamic pressure isn't limited, but ripped chutes / tumbling are emergent.
* SAS: PD controller that respects available torque (critically damped, no oscillation), modes listed above.
  Maneuver mode aims along `burnVector()` from game/maneuver.js (import dynamically/defensively).
* Electric charge: probes & reaction wheels consume, solar panels produce when not in shadow. No EC ⇒ probe cores lose control.
* Warp: rails allowed only if no thrust, not in atmosphere (below `atmosphere.height`) unless landed, and altitude ≥
  `warpAltitudes[index]` (auto-reduce when crossing below). Physics warp 2–4× with same fixed step (more sub-steps).
  On rails propagate `vessel.orbit` analytically; landed vessels stay pinned. Stop warping on SOI change, on entering atmosphere,
  and 10 s before `warpTo` targets. Rails steps must land exactly on SOI transitions (`findNextSOITransition`).
* SOI: switch frames when leaving SOI / entering a child SOI (convert pos/vel, rebuild orbit, emit `soi:change`).
* Debris & other vessels: full physics within PHYSICS_RANGE of the active vessel, otherwise rails; debris on rails whose
  periapsis is inside an atmosphere (or below the surface) is deleted when it goes out of range (`vessel:removed`).
* Must be fast: ≤ 1.5 ms per physics step for a 40-part vessel.

---------------------------------------------------------------------------------------------------------------------------

## 5. Worlds & rendering

### src/world/terrain.js  (worlds) — pure, deterministic, node-importable
```js
export function terrainHeight(bodyId, nx, ny, nz) → meters relative to body.radius (can be < 0 under the sea)
    // (nx,ny,nz) = unit direction in the BODY-FIXED frame. Must honour LAUNCH_SITE flattening exactly.
export function surfaceHeight(bodyId, nx, ny, nz) → max(terrainHeight, 0) if body has ocean, else terrainHeight
export function terrainSample(bodyId, nx, ny, nz, out?) → { height, color:[r,g,b] (linear 0..1), biome:string, water:bool }
export function isWater(bodyId, nx, ny, nz) → bool
export function biomeName(bodyId, nx, ny, nz) → 'Highlands'|'Shores'|… (fun names for the HUD)
```
Speed target: ≥ 300k `terrainHeight` calls/s. Stars/bodies with `terrain:null` return 0.

### src/render/planets.js  (worlds)
```js
export class PlanetSystem {
  constructor(renderer, { quality = game.settings.graphics } = {})
  root: THREE.Group             // add to your THREE.Scene (it contains all bodies, sky, sun light)
  sunLight: THREE.DirectionalLight   // castShadow; shadow camera auto-fits ±shadowExtent around the scene origin
  shadowExtent (m, default 40)       // flight scene sets it from vessel size
  update(camera, originRootPos, ut)  // position everything relative to the floating origin, update LOD for the camera,
                                     //  sun direction/light, atmosphere uniforms, sky fading (stars dim in daylight)
  bodyFixedGroup(bodyId) → THREE.Group  // scene-space group that sits at the body center and rotates with the body
                                     //  (children use body-fixed coordinates, e.g. launch pad buildings)
  setVisible(bool), dispose()
  getSkyColor(cameraRootPos) → THREE.Color // for fog/clear color decisions (optional)
}
```
Features: quadtree cube-sphere LOD terrain per body (chunks built from `terrainSample`, vertices relative to chunk
center, skirts to hide cracks, time-sliced generation, meters-level detail near the camera), ocean surface with sun glint & fresnel,
atmospheric scattering (planet limb glow from space + sky dome & sunsets from inside the atmosphere) per body with
`atmosphere.rayleigh/sunset`, the star (glowing sprite + lens flare), starfield/milky-way skybox that fades in daylight, day/night terminator,
distant bodies visible as lit spheres/dots from far away. Quality levels reduce LOD depth / chunk resolution.

### src/render/partMeshes.js & vesselRenderer.js  (parts3d)
```js
export function buildPartMesh(def, { ghost=false, thumbnail=false } = {}) → THREE.Group
   // origin = part center, +Y up the stack, dimensions match def.radius/height/nodes exactly.
   // userData: { partId, engine?: { nozzleExit: Vector3, nozzleRadius }, animate?: (state, dt) => void }
   // PBR materials (MeshStandardMaterial / MeshPhysicalMaterial), canvas-generated textures (panel lines, decals, stripes).
   // Meshes castShadow/receiveShadow. Every mesh has userData.partUid set later by callers.
export function disposePartMesh(obj)
export function renderPartThumbnail(def, size=128) → Promise<string dataURL>  // uses its own small renderer, cached per id

export class VesselRenderer {
  constructor(vessel)            // builds one Group; child per part (placed at part.pos/rot)
  group: THREE.Group             // origin = vessel-local origin (root part). Caller sets group.position/quaternion.
  sync(vessel)                   // add/remove part meshes when parts change (decouple/destroy)
  update(dt, vessel, { pressure (kPa), camera, ut })   // engine plumes (throttleEff; expand in vacuum, shock diamonds at sea level,
                                  //   flicker), gimbal visual, parachute canopy (semi/deployed/cut, sways), legs deploy, fin flaps,
                                  //   RCS puffs, heat glow on hot parts (emissive by temp/maxTemp)
  setHighlight(partUid | null, color?)
  dispose()
}
```
The **flight scene** places `group.position = (vesselRootPos − originRootPos) − rot·comLocal` and `group.quaternion = vessel.rot`.

### src/render/effects.js  (fx)
```js
export class Effects {
  constructor(scene, { quality })
  update(dt, { flight, originRootPos, camera, ut })  // spawns/updates particles for every rendered vessel
  cameraShake() → Vector3 offset (m) to add to the camera this frame (from thrust near ground, explosions, reentry)
  dispose()
}
```
Particles live in body-relative inertial coordinates (doubles) and are advected with the air (ω×r) so smoke stays
behind in the sky; drawn relative to the floating origin. Effects: engine smoke trails (dense at sea level, none in vacuum;
SRBs smokier), launch-pad billowing clouds + steam at liftoff, explosions (flash light + fireball + smoke + flying shards)
listening to `part:destroyed`, decoupling puffs (`decouple`), reentry plasma sheath & sparks oriented against the airflow
(`vessel.reentryIntensity`), vapor cone near Mach 1, ground dust when engines fire near the surface, splash on water impact.

### src/audio/audio.js  (fx) — WebAudio, fully synthesized (no audio files)
```js
export const audio = {
  init(),                        // idempotent; creates/resumes AudioContext — call on first user gesture (shell does)
  setScene(name),                // 'spacecenter'|'vab'|'flight'|'map'|'tracking'|'menu' → switches generative music mood
  updateFlight(dt, { thrustFrac, solidFrac, dynPressure, mach, pressure, reentry, warpRate, paused, cameraDist }),
  play(name, opts?),             // 'click','hover','stage','decouple','explosion'{size,distance},'chute','sas_on','sas_off',
                                 // 'warp','milestone','flameout','error','toggle','launch','gear','place','pickup','delete','countdown'
  setVolumes({ master, music, sfx }),
  pauseAll(bool),
}
```
Audio subscribes itself to bus events (staging, explosions, chutes, milestones, warp) — callers only need `updateFlight`/`setScene`/`play`.
Music: generative ambient score (pads, gentle arpeggios, reverb) with distinct moods: space center (bright, hopeful),
VAB (playful, light jazz-ish swing), flight/space (vast, calm pads), map (sparse, mysterious).

---------------------------------------------------------------------------------------------------------------------------

## 6. Game logic

### Craft format (src/game/craft.js — vab)
```js
craft = {
  format: 'tsp-craft-1', name, description, id?,           // id for stock crafts
  parts: [ { uid, part (def id), parent (uid|null), attach: null | { kind:'stack', node, parentNode } | { kind:'surface' },
             pos:[x,y,z], rot:[x,y,z,w] (vessel-local; root at origin), stage (int, −1 = none), sym (int|null),
             resources?: { Res: amount } (override starting amounts), crewSeats?: n } ]
}
export function layoutCraft(craft)          // recompute pos/rot for stack-attached parts from nodes (surface parts keep theirs)
export function validateCraft(craft) → { ok, errors:[], warnings:[] }   // has command part, tree connected, etc.
export function autoStage(craft)            // KSP-like default staging (see vab notes)
export function cloneCraft(craft), serializeCraft(craft) → string, parseCraft(str) → craft
export function craftStats(craft) → { mass, dryMass, cost, partCount, height, width }
export function saveCraft(craft), listSavedCrafts() → [{name, updated}], loadCraft(name), deleteCraft(name)   // localStorage "tsp.crafts"
```
Stage numbers: higher numbers fire first; launch = `max(stage)`. Every engine, decoupler and parachute has `stage ≥ 0`.

### src/game/deltav.js (vab)
```js
export function computeStageStats(parts, { pressure = 0, gravity = 9.81, fromStage = null } = {})
  → { stages: [{ stage, deltaV, burnTime, startMass, endMass, thrust, twr, isp }], totalDeltaV }
  // parts: [{ uid, def|part, parentUid|parent, attach, stage, resources?: {Res: {amount,max}|number}, decoupled? }]
  // Time-stepped simulation of full-throttle burns (handles SRB+liquid mixes, fuel domains blocked by decouplers).
```
### src/game/stockCrafts.js (vab)
`export const STOCK_CRAFTS = [craft…]; export function getStockCraft(id) → deep clone`.
Required, all flight-tested via deltav numbers: `flea_hopper` (pod+chute+Flea), `sounding_rocket` (≈30 km apogee),
`orbiter_1` (≥ 4200 m/s vac ΔV, TWR ≥ 1.4 on the pad; reaches orbit + deorbit + chute), `lune_lander` (≥ 7000 m/s; lands on Lune
with legs and returns), `pip_probe` (probe core, solar, ≥ 5500 m/s), `heavy_lifter` (big boosters, fun).

### src/game/maneuver.js (map)
```js
export function createNode(vessel, ut) → node { id, ut, dv:{prograde,normal,radial}, targetVel: Vector3|null, bodyId }
export function setNodeDv(vessel, node, dv)          // recompute targetVel from the vessel's CURRENT orbit
export function removeNode(vessel, node)
export function burnVector(vessel, node, out?) → Vector3   // remaining Δv (inertial) = targetVel − currentOrbitVelAt(node.ut)
export function estimateBurnTime(vessel, dv) → seconds      // uses current stage thrust/mass/isp
export function nodeTrajectory(vessel) → predictTrajectory result including maneuvers
```
### src/game/missions.js, crew.js, persistence.js (shell)
Milestones (toast + fanfare + persistent): first launch, 10 km, space (> home atmosphere), orbit, Lune/Pip/other SOI, orbit each,
land each, return home after landing elsewhere, splashdown, 1,000 m/s, supersonic, reentry survival, destroyed vessel ("rapid unplanned disassembly").
Crew roster with generated names (`<First> Tinyman`), courage/stupidity stats, KIA memorial. Persistence: universe (FlightSim) saved to
`tsp.persistent` on scene exit/quicksave.

---------------------------------------------------------------------------------------------------------------------------

## 7. UI

### Scene contract (main.js)
Each file in `src/scenes/` default-exports a class:
```js
export default class XScene {
  constructor(app)        // app: { renderer, uiRoot, canvas, game, bus, input, width, height, time, goto(name, params), getShared(key, factory), reportError }
  async enter(params)     // build THREE.Scene, camera, DOM under app.uiRoot
  exit()                  // dispose GPU resources you created, remove DOM, unsubscribe bus handlers
  update(dt)              // real seconds (≤ 0.1)
  render()                // app.renderer.render(...) or composer
  onResize(w, h)
}
```
Scene names: `spacecenter`, `vab` (params `{craft?}`), `flight` (params `{craft}` new launch | `{resume:true}` | `{vesselId}`), `tracking`.
Shared expensive objects via `app.getShared('planets', () => new PlanetSystem(app.renderer))` — move its `.root` between scenes.

### src/ui/hud.js (hud)
```js
export class FlightHUD {
  constructor(app, { flight, onMapToggle, onPause, onRecover })
  root: HTMLElement              // appended to app.uiRoot by the constructor
  update(dt)                     // reads flight.active.telemetry (never mutates physics except via documented controls)
  setMapMode(bool)               // compact layout while in map view
  showMessage(text, seconds)     // big centered transient text ("STAGING", "SAS ON")
  dispose()
}
```
Layout (KSP-like, but cleaner): top-center altimeter + UT clock + time-warp arrows (clickable) + situation/biome;
bottom-center **navball** (3D sphere rendered with its own tiny three scene into a canvas: sky-blue/ground-brown hemispheres, heading
labels, pitch ladder, prograde/retrograde/normal/antinormal/radial/maneuver/target markers, speed readout with Surface/Orbit/Target mode);
left of navball: vertical throttle gauge, g-meter, heat/atmo gauges; right of navball: SAS mode buttons, RCS/SAS/gear lights;
bottom-left: **staging stack** (stage groups with part icons, current stage highlighted, per-stage ΔV);
top-left: resources panel (collapsible); top-right: orbit panel (Ap/Pe/time-to/inclination), maneuver node info (Δv remaining,
burn time, time to node countdown); bottom-right: **crew portraits** (canvas-drawn original Tinynaut faces that react — calm, excited,
terrified at high g / heat / freefall, joyful in orbit, and a static/"signal lost" frame when destroyed).
### src/ui/mapView.js (map)
```js
export class MapView {
  constructor(app, { flight, mode: 'flight'|'tracking', onSelectVessel? })
  enter(), exit(), update(dt), render(), onResize(w,h), dispose()
  focus(bodyIdOrVesselId)
}
```
Own THREE.Scene with scaled rendering (e.g. 1 unit = 1 km, floating around the focused object), bodies as textured spheres
(color from `terrainSample`-baked equirect texture + atmosphere rim), orbit lines for all bodies & vessels (patched conics colored per patch,
dashed after maneuvers), Ap/Pe/AN/DN/SOI-encounter markers with hover info, closest-approach markers for targets,
maneuver-node creation by clicking the orbit line, 6-handle Δv gizmo (drag to change prograde/retrograde/normal/antinormal/radial),
node timing drag, delete; camera orbit/zoom with smooth focus transitions (Tab cycles focus, double-click focuses).
In `tracking` mode: vessel list sidebar with Fly / Terminate buttons, time warp controls.

### Controls (flight)
W/S pitch · A/D yaw · Q/E roll · Shift/Ctrl throttle up/down · Z full · X cut · Space stage (hold-safe: one stage per press) ·
T SAS · R RCS · G gear · B brakes · U lights · CapsLock precision · H/N/J/L/I/K RCS translation · M map · `.`/`,` warp up/down ·
`/` stop warp · F5 quicksave · F9 quickload · V camera mode ·
[ / ] switch vessel · Esc pause menu · F2 hide UI · F1 screenshot (download PNG) · mouse right-drag orbit camera · wheel zoom.

---------------------------------------------------------------------------------------------------------------------------

## 8. Verification (everyone)

* Node-importable logic gets `tests/*.test.mjs` using `node:assert/strict`; run `node tools/run-tests.mjs`.
* Visual modules get a standalone test page under `tests/` that exercises the module in isolation (with import map pointing to
  `../node_modules/three/...`). Screenshot it with `tools/snap.mjs` and LOOK at the image; iterate until it looks great.
  Use `window.__testReady = true` when your page finished setup so scripts can poll it.
* Syntax check any browser file: `node --check file.js`.
* `window.TSP = { app, game, bus, THREE, ready }` exists on the real game page; `index.html?scene=flight&craft=orbiter_1&debug=1`
  launches directly. Each area may add debug helpers under `window.TSP.<area>`.
* Write `notes/<area>.md`: what you built, public API (esp. deviations), how to test, known issues, integration notes.
