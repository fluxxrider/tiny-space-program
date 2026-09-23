# Physics area — notes

Owner files: `src/physics/{atmosphere,vessel,flight,sas}.js` plus helpers `src/physics/{dynamics,contact,collide,telemetry,
stagesim,graph,partgeom,craftkit,controls}.js`, tests `tests/vessel.test.mjs`, `tests/flight.test.mjs`, and the
browser verification page `tests/physics.html` (screenshot: `shots/physics_recorder.png`).

## What was built

| File | Role |
|---|---|
| `atmosphere.js` | `atmosphereAt(bodyId, alt, out?)` exactly per contract (exponential, tapered to 0 at the top, ρ ∝ P, smooth lapse rate, speed of sound). Extras: `pressureAt`, `temperatureAt`, `hasAtmosphere`, `atmosphereHeight`, `altitudeForPressure`. |
| `vessel.js` | `Vessel`: parts from a craft, topology caches, mass/CoM/inertia tensor (cylinders + parallel axis, O(n) recompute every step), fuel domains, staging, decoupling & destruction graph splits (with ejection impulses), crew seats, pinning, ΔV/stage stats, telemetry hook, exact serialization. |
| `flight.js` | `FlightSim`: fixed-step physics for loaded vessels, rails (Kepler) for the rest, warp (rails 1…100 000×, physics 2–4×), `warpTo`, SOI switching (physics & rails, exact transition times), situations & history, debris range rules, launch/recover/pack, serialization, `window.TSP.physics` debug helpers. |
| `dynamics.js` | One physics step of one vessel: engines (spool, fuel flow fixed by throttle, gimbal), RCS, reaction wheels, EC/solar, per-part aero (occlusion, transonic drag rise, pointed vs blunt faces, fin lift, control-fin deflection), parachutes (reefed opening), heating/ablation/radiation/conduction, integration, pin/unpin, crashes. |
| `contact.js` | Ground & water: terrain sampling, sequential-impulse contact solver (restitution, friction, brakes), landing-leg suspension with **auto-levelling**, buoyancy/water drag, crash detection. |
| `collide.js` | **Vessel–vessel contact** between loaded vessels (part frustum/box proxies + surface probe points, sequential impulses, impacts break parts). |
| `sas.js` | Input smoothing, control authority per axis, SAS (all modes), actuator mixing. |
| `telemetry.js` | Allocation-free telemetry (every contract field + extras). |
| `stagesim.js` / `graph.js` / `partgeom.js` | Internal ΔV estimator; tree/crossfeed/split helpers; part shape data (hull points, areas, inertia). |
| `craftkit.js` | `CraftBuilder` — build tsp-craft-1 crafts in code (stack/radial/symmetry); `buildTestRocket()`, `buildCapsule()`. |
| `controls.js` | Optional `applyFlightInput(flight, input, realDt)` — maps the §7 key bindings onto the active vessel. |

## Verified behaviour (all in the tests)

| Requirement | Result |
|---|---|
| Autopilot ascent, 17 t pod/chute/decoupler/FT-400+Terrier/decoupler/FT-800+Swivel + 4 fins + 2 Hammers | Orbit 76 × 83 km at T+221 s, ~3 280 m/s used, max Q 87 kPa, no damage |
| ~9.3 t, TWR 1.85, 4 fins, only 3 462 m/s vacuum ΔV | Orbit 72 × 76 km using **3 396 m/s**; max AoA < 10° |
| Mk1 + Canopy chute at sea level | **≈6.1 m/s** touchdown (capsule drag now helps), lands intact, chute cut after 2 s at rest, pins |
| Mk1 + heat shield, LEO return (Pe 30 km) | survives, ablator ≈100/200 left, pod ≤ ~400 K, peak 2.5 g at ~17 km |
| Mk1 without shield, steep Lune return (3.15 km/s, Pe 15 km) | pod burns up (`part:destroyed` reason `heat`) |
| Mk1 without shield, LEO return | survives hot (~1 700 K) — its recovery temperature (~2 200 K) is below the pod's 2 400 K limit |
| 50 m/s impact | both parts destroyed, `part:destroyed` ×2 + `vessel:destroyed` |
| Finned rocket, no SAS | weathervanes (AoA < 2°); finless no-gimbal rocket tumbles even with SAS |
| SAS stability hold | captures ~1 s after input release, 60 s drift 0.0004°; 106° slew with 5 kN·m wheel, no overshoot |
| Rails vs physics | one full orbit (108 649 steps) differs from Kepler by **6 mm** |
| SOI transition under 1 000× warp | lands exactly on `findNextSOITransition` time, frame switched, warp stopped |
| Performance | 1000 steps × 32 parts = **~35 ms** (≈35 µs/step; budget 1.5 ms) |
| Serialization | `serialize(deserialize(x))` deep-equals `x`, and both copies then evolve bit-identically |
| Booster separation at max-Q (85 kPa) | boosters tilt < 5° and are 4 m out after 0.4 s, never swing into the core, tumble damped to ~60°/s after 2 s |
| warpTo on a 148 × 88 km orbit | never freezes (was: stuck forever at exactly 120 000 m in 20/40 random parking orbits) |
| Throttle cut (X) | thrust gone in < 0.2 s (Δv tail < 1.5 m/s), rails warp available immediately |
| SAS on + held W | steady ≤ 12°/s pitch rate (26°/s in vacuum), ≤ 3–4° overshoot after release (was: +23°/s² runaway) |
| Mk1 + heat shield without chute | ≈ 115–150 m/s at 2 km (was 240 m/s); chute opening ≤ 3 g |
| Capsule after reentry | cools under the chute (650 → 540 K in 60 s) and is quenched afloat (shield 650 → 300 K in 60 s) |
| Stage decoupled on the pad | the upper piece rests on the lower one (was: fell through it) |
| Lander on a 12–15° Lune slope, SAS on | stays upright (tilt ≈ 2–12°) with auto-levelling legs (was: tipped over at ≥ 12°) |

## Public API — as in ARCHITECTURE.md §4, plus extensions

### Deviations / clarifications (please read)
1. **`FlightSim.update(realDt)` time stepping**: physics mode runs fixed 0.02 s steps **plus one shorter final step** so
   `game.ut` advances exactly `realDt × rate` every frame. With purely fixed steps a 60 Hz display shows visible
   stutter (some frames get no step). Every step is ≤ 0.02 s so stability is unchanged; tests calling `update(0.02)`
   get exactly fixed steps.
2. **Vessel-local origin after staging**: new vessels created by a split are re-origined so their root is at (0,0,0).
   The vessel that *keeps its identity* keeps its old frame (its root may no longer be at the origin, e.g. when the
   original root was jettisoned). Renderers must always place parts at `part.pos` (they do) — never assume root = origin.
3. **Parachutes**: `armed` chutes semi-deploy when `pressure > minPressure` **and surface speed < safeSpeed** (KSP's
   "deploy when safe"), so staging chutes early is safe. The canopy area is **reefed**: the total aerodynamic load
   (hull + canopies) never exceeds `REEF_G` = 3 g while it opens, so the jolt stays below a normal reentry peak. A chute that reaches its full-deploy altitude above `safeSpeed` becomes
   `'destroyed'` and emits **`chute:cut` `{vessel, part, reason:'ripped'}`** — the part itself is not destroyed.
4. **`part:destroyed`** payload also carries `crew: [...]` (crew members lost with that part; they are removed from
   `vessel.crew`).
5. **Destroyed active vessel**: when every part of the active vessel is gone it is removed from `flight.vessels`,
   `destroyed = true`, but `flight.active` still points at it (the flight scene decides: revert, recover, switch
   with `cycleActive`). Its wreckage (split pieces) keeps full physics around its last position.
6. **Stack decoupler crossfeed**: decoupler parts block crossfeed completely (like KSP's default).
7. **Stage numbering**: `stage()` skips empty stage numbers (activates the next lower number that has parts).
8. **`engine.gimbal`** (Vector2, rad): `x` = rotation about part-local X (thrust tilts toward +Z), `y` = rotation about
   part-local Z (thrust tilts toward −X); apply to the nozzle as `Rz(gimbal.y)·Rx(gimbal.x)`.
9. **`controls.x/y/z`** (RCS translation) are the desired force direction in vessel-local axes:
   `H` → y=+1, `N` → y=−1, `J` → x=−1, `L` → x=+1, `I` → z=−1 (vessel top), `K` → z=+1.
10. **Uncontrollable vessels** (no crew, probe without EC, debris): steering/SAS are ignored, the throttle stays frozen
    at its last value, `stage()` returns null. Debris starts with liquid engines at throttle 0 (SRBs keep burning).
11. **Buoyancy**: effective displacement = 2 × geometric part volume (so capsules and tanks float, like KSP).
12. **Manual input with SAS on is a rate command** (`sas.USER_RATE`): full key = 0.21 rad/s (≈12°/s) pitch/yaw in the
    lower atmosphere blending to 0.45 rad/s (≈26°/s) in vacuum, roll ×2, precision mode ×0.25; the SAS rate loop
    tracks it and brakes to zero on release. With SAS off input is still a raw torque command (KSP-like).
13. **Engines throttle down/cut off with a 0.05 s time constant** (`SPOOL_DOWN`; spool-up keeps the part's `spool`) and
    snap to 0 below 2 %. `setWarp` treats an engine as thrusting only while it is *commanded* to burn.
14. **Pinned vessels end each physics step at `ut + dt`** (they used to lag one step of planet rotation — up to 3.5 m
    on Verda's equator — behind the terrain).
15. **Vessel–vessel contact** (`collide.js`): loaded vessels touching each other push apart; impacts faster than a
    part's `crashTolerance` destroy it (reason `'impact'`). Exceptions: debris pieces of one staging event never collide
    with each other (`_sepGroup`), and the pieces of a split never damage each other during the first 1.5 s. A vessel
    resting on a grounded vessel counts as landed (it pins, and is released when its support moves).
16. **Radial decouplers** push the booster straight out through its own CoM and tip its nose outward (≤ 0.12 rad/s,
    ±20 % per decoupler); freshly decoupled pieces get their aerodynamic torque faded in over `SEP_AERO_RAMP` (0.6 s).

### Vessel extensions
`launched`, `controllable`, `ut` (time of its state), `topologyVersion` (increments when parts are added/removed),
`pinned`, `maxStage`, `boundingRadius`, `lists` ({engines, chutes, legs, fins, rcs, wheels, solar, shields, commands,
crewed, ec, mono, decouplers}), `getPart(uid)`, `partWorldQuat(part, out)`, `partWorldVel(part, out)`,
`localToWorldPoint(p, out)`, `stageStats(force?)` (→ `{stages:[{stage, deltaV, burnTime, startMass, endMass, thrust,
twr, isp, deltaVVac, deltaVNow, atPressure}], totalDeltaV, totalDeltaVVac, totalDeltaVNow, pressure}`, cached ~0.5 s;
uses `src/game/deltav.js` when it loads, internal `stagesim.js` otherwise). **`deltaV` is the realistic mix**: the
stage burning now (or the launch stage on the pad) at the current static pressure, every later stage at vacuum Isp;
`deltaVVac`/`deltaVNow` are the all-vacuum / all-current-pressure values. `getStages()` entries carry `deltaVVac`,
`deltaVNow` and `twr` too. Exported `mergeStageStats(now, vac, pressure)`.
`cutChutes()`, `armChute(part)`, `assignCrew(crew)`, `crewInPart(part)`, `destroyParts(parts, reason)`,
`applyImpulse(J, point)`, `pin(theta)`/`unpin()`.
Controls extension: `controls.navMode` = `'auto'|'surface'|'orbit'|'target'` (set via `setControl('navMode', m)`): the
speed frame used by prograde/retrograde SAS and `telemetry.speed`. SAS extension: `sasMode: 'direction'` points the
nose along `vessel.sasDirection` (inertial Vector3) — used by the autopilot tests, handy for cinematics/autopilots.

### Telemetry extensions
`biome`, `terrainHeight`, `controllable`, `navMode`, `speed` (matches navMode), `hasTarget`, `targetDir` (unit),
`targetDistance`, `targetRelSpeed`, `bodyRadius`, `localGravity`, `surfaceVelocity` (Vector3, m/s),
`heatFraction` (hottest part's (T − 300 K)/(maxTemp − 300 K), ≥ 0 — reads 0 on a cold vessel; the HEAT gauge value),
`hottestPartUid` (uid of that part | null — `vessel.getPart(uid)`), `slope` (deg, terrain slope under the vessel on a 3 m baseline while the radar altitude
is < 1 500 m over land, else 0 — for a "too steep to land" warning). Exported helper `terrainSlopeDeg(bodyId, nx, ny, nz, radius)`.
`radarAltitude` is measured from the vessel's lowest hull point. `heading` when pointing straight up is the direction of
the vessel's +X (so it reads 90° on the pad and stays continuous through a yaw-right pitch-over).

### FlightSim extensions
`setPhysicsWarp(i)` (0..3), `cancelWarpTo()`, `warpTarget` (ut | null), `debug.infiniteFuel`, `ut` getter,
exported `placeOnPad(vessel, ut)`. `setWarp(i)` returns `{ok, reason}`, emits `warp:denied` when it had to clamp
(physics warp in atmosphere/under thrust/moving on the ground; altitude limits from `warpAltitudes`).

### Debug (`window.TSP.physics`, installed when a FlightSim is created in a browser)
`sim`, `active`, `orbit(bodyId='verda', altitude=100000, incDeg=0)`, `drop(altitude, {bodyId, lat, lon, vs})`,
`refuel()`, `infiniteFuel(on)`, `stats()`.

## Model summary & tuning knobs
All knobs are exported objects/constants so they can be tweaked live from the console.
* **Aero** (`dynamics.AERO`): per part, flow in part-local axes. Axial drag uses the *exposed* face area (stack
  neighbours on the windward node occlude it, `dragArea`/`dragCd` from parts.js), times `machDragFactor` (×1.9 peak
  at Mach 1.05, ×1.25 hypersonic). Crossflow drag `CD_LAT` on the side area (∝ sin²α). **Pointed** leading faces
  (cones, pod tops, adapters) add a slender-body normal force `K_NOSE` (destabilising — finless rockets flip).
  **Blunt** faces push along the flow through a centre of pressure behind the face (capsules fly heat-shield first);
  heat-shield faces use at least `CD_SHIELD` 1.1 and bare pod bottoms `CD_POD` 0.6 (with a softened transonic rise),
  so a Mk1 + shield falls at ~115 m/s at sea level (was 240 m/s with the parts' dragCd 0.3).
  Fins: `C_N = 2K·sinα·cos³α + 1.1·sinα|sinα|` on the (deflected) fin plane; control fins deflect with the command.
  **Pitch damping** of every stack part's own length: `τ = −ρ·s·A_lat·L²/12·(C_MQ + CD_LAT·sinα)·ω⊥` (`C_MQ` 2) — forces
  act at part centres, so a long part spinning about its middle used to feel no aerodynamic resistance at all.
* **Heat** (`dynamics.THERMAL`): `h = HC·√ρ·v`, flux `h·A_exposed·(T_recovery − T)` with `T_rec = T_air + 0.9·v²/2cp`
  (LEO ≈ 2 200 K, Lune return ≈ 4 500 K), shielded parts see a wake fraction of their area (`WAKE` 0.004 hypersonic →
  `WAKE_SUBSONIC` 0.25 below Mach 0.8), natural convection `H_NATURAL`·ρ/1.225 over the whole surface, water quench
  `H_WATER` on the submerged fraction of floating parts, radiation εσA(T⁴−T_sink⁴), conduction 40 W/K along joints,
  heat shields ablate (≤ 92 % of their convective load, `ABLATOR_SCALE` 0.55: LEO ≈ 50 %, Lune return 70–85 %).
  `reentryIntensity` = smoothstep on recovery temperature × √ρv³, low-passed 0.25 s.
* **Contacts** (`contact.js`): hull points (rims of stack parts, minus rims hidden inside neighbours; fin/leg/box points
  for surface parts), exact terrain heights per candidate point, local terrain normal, 4 sub-steps, 8 solver iterations,
  friction 0.8 (1.3 with brakes), penetration recovery capped at 1.5 m/s. Legs: springs with 25 % static compression
  (never softer than for 4 m/s² gravity), progressive compression damping + stiff rebound damping (no bouncing).
  Impact > `crashTolerance` (×2 on water) destroys the part. Resting (<0.3 m/s, no thrust) for 0.5 s ⇒ pinned.
  **Auto-levelling legs** (`contact.LEG_LEVEL`): near the ground with ≥ 3 legs deployed on a controllable vessel, the
  ground under every foot is sampled and each leg's actuator retracts (up to 1.5 × stroke, 0.4 m/s, in series with
  the shock absorber) by its ground height above the lowest foot, so the feet meet a slope together and the vessel
  stands upright; the retraction is reduced where a low hull point (engine bell between the legs) would otherwise touch
  the ground first (`CLEARANCE` 0.12 m).
* **Vessel–vessel contact** (`collide.js`, `VCOLLIDE`): per part a frustum (stack parts, engines down to the nozzle
  exit) or box (surface parts) plus surface probe points (rings every 0.6 m); probe points of one vessel inside a solid
  of the other give contacts (normal = shortest exit through an exposed face), solved with 6 sequential-impulse
  iterations (friction 0.6, restitution 0.1, Baumgarte 0.25, ≤ 2 m/s correction). Pinned vessels are immovable (a hit
  > 1 m/s wakes them). Cost ≈ 0.1 ms per step for a close pair; pairs whose bounding spheres don't touch cost nothing.
* **SAS** (`sas.js`): per-axis cascade: desired rate = min(kp·e, √(α_max·e), 1.2 rad/s), rate loop with gain
  limited by the per-axis authority/inertia, small leaky integrator in hold. User input replaces the attitude target
  on its axis by a rate target (`USER_RATE`, see deviation 12); stability mode re-captures after the vessel settles
  (< 0.012 rad/s) so it never snaps back.
* **Warp limits**: raising (`setWarp`) and dropping (`_railsUpdate`) use the same threshold `alt ≤ limit + 1 m`, and a
  rails step that ends at its own start always lowers the rate (warpTo could freeze game time forever at exactly
  120 000 m / 240 000 m).

## How to test
```
node tools/run-tests.mjs vessel     # 15 unit tests (mass/inertia, domains, staging, splits, ΔV vac/now, cut-off,
                                    #  nose-out booster tip, serialization, perf)
node tools/run-tests.mjs flight     # 24 integration tests (pad, ascent to orbit ×2, chute, crash, legs, splashdown,
                                    #  reentry, rails vs physics, SOI under warp, warp rules, situations, debris, recover,
                                    #  warpTo freeze, cut-off → rails, booster separation at max-Q, SAS rate command,
                                    #  capsule drag & chute jolt, cooling/quench, stack-on-stack contact, slope landing)
# playtest repros (node): warp freeze, separation, pitch rate, lander drop test on Lune slopes
node tests/playtest/pt_lune_warpstall_stats.mjs          # 0/40 freezes
node tests/playtest/pt_ascent_node_sep.mjs orbiter_1 60 80
node tests/playtest/pt_ascent_node_pitchrate.mjs orbiter_1 1 50
node tests/playtest/pt_lune_droptest.mjs                 # drops right next to the ground: legs get no time to level
# browser
PT_YAW=0 PT_TIMES=0.1,0.3,0.45,0.7,1.2 PT_TAG=phys_sep_o1_side node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" \
   --wait 5000 --size 1600x900 --script tests/playtest/pt_ascent_sep.mjs      # shots/pt_ascent_phys_sep_o1_side_*.png
node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_4d_warpfreeze_realframes.mjs  # frozen:false
node tools/snap.mjs tests/physics.html --out shots/physics_recorder.png --wait 8000 --size 1280x960
```
`tests/physics.html` runs an ascent, two reentries and a chute descent live in the browser and charts them.

## Known issues / limitations
* Tall, narrow landers (the stock Lune Lander: feet 1.17 m from the axis, CoM 3.6 m above them, Terrier bell 0.23 m
  above the feet) still tip on ≥ 12° slopes **with SAS off**, or at ≥ 3 m/s touchdowns on ≥ 13° slopes; with SAS on
  and the auto-levelling legs they stand upright up to ~14°. A wider stance (parts.js / stockCrafts.js) is the real fix.
  Levelling needs ~1 s near the ground: the node drop test (`pt_lune_droptest.mjs`), which releases the lander 0.3 m
  above the ground, underestimates it.
* No docking; vessel–vessel contact is rigid-body only (no joints). Debris of one staging event pass through each other.
* An empty finless booster released at max-Q still flips once it is clear of the core (up to ~900°/s for a moment,
  damped within ~1.5 s) — that is the aerodynamics of a nose-heavy-drag body; sepratrons/fins would calm it.
* Big Bertha (stock `heavy_lifter`) reaches Mach 6–8 below 40 km, where the nose chute (maxTemp 1 400 K) can burn off:
  a parts/stock-craft balance issue (see cross-area requests), not a heating-model bug (T_recovery ≈ 2 200 K there).
* Rails warp freezes rotation (SAS direction modes re-point the vessel each rails frame; spins are zeroed on pack).
* Electric charge is not simulated while on rails.
* Parts are thermally lumped (one temperature each); `maxTemp` is the only failure criterion (no g/aero overload
  destruction besides ripped chutes and emergent tumbling).
* The kept vessel's frame can have its root off-origin after the original root is jettisoned (see deviation 2).

## Integration notes (for the flight-scene engineer)
Per frame (`FlightScene.update(dt)`):
1. `const act = applyFlightInput(game.flight, input, dt)` (from `src/physics/controls.js`, optional) → handle
   `act.stage` → `flight.stage()`, `act.warpUp/Down/stopWarp` → `flight.setWarp(flight.warp.index ± 1 / 0)`
   (note `warp.index` is a physics-warp index when `warp.mode === 'physics'`), `act.cycle` → `flight.cycleActive(±1)`.
   Map view uses the same `setWarp`.
2. `flight.update(dt)` — advances `game.ut`, all vessels, telemetry of the active vessel.
3. Floating origin: `originRootPos = bodyPosition(active.bodyId, ut) + active.pos`. For each vessel to render:
   `group.position = bodyPosition(v.bodyId, ut) + v.pos − originRootPos − rot·comLocal` and
   `group.quaternion = v.rot` (i.e. contract §5). Render vessels within `RENDER_RANGE` of the active one.
4. Call `VesselRenderer.sync(v)` on `decouple`, `part:destroyed`, `vessel:created` (or when `v.topologyVersion` changes);
   dispose renderers on `vessel:removed` / `vessel:destroyed`.
5. Visual state to read: `part.engine.throttleEff / thrust / gimbal / flameout`, `part.rcs.firing[]`,
   `part.chute.state / t` (+ `part._cda` = current canopy Cd·A if you want canopy size to follow reefing),
   `part.legs.t / compression`, `part.fin.deflection`, `part.temp / def.maxTemp`, `vessel.reentryIntensity`,
   `vessel.gForce`, `vessel.telemetry.dynamicPressure/mach`, `vessel.controls.lights`.
6. Camera: `vessel.boundingRadius` is the CoM-centred bounding radius (m).
7. Leaving the flight scene: `flight.packAll()`; entering with `{resume:true}`: nothing to do (vessels unpack when loaded).
   Quicksave: `flight.serialize()` / `FlightSim.deserialize(json, game)` (restores `game.ut`).
8. HUD: to make SAS prograde/retrograde follow the navball's Surface/Orbit/Target toggle, call
   `vessel.setControl('navMode', mode)` when the player changes it ('auto' by default).
9. The active vessel may be `destroyed` (see deviation 5): show the "vessel destroyed" UI, offer revert/switch.
10. HUD: `telemetry.heatFraction` is the HEAT gauge value measured from room temperature (0 when cold);
    `telemetry.slope` (deg) is available for a "too steep" landing alert (the auto-levelling legs cope with ~14°);
    `getStages()[i].deltaVVac / deltaVNow` for "vac / now" columns — `deltaV` / `telemetry.totalDeltaV` already mix
    them (current stage at the current pressure, later stages vacuum).

## Playtest round 2026-09-23 — what changed (physics)
| Finding | Fix |
|---|---|
| Orbiter I boosters tumble at ~1 100°/s and swing through the core | radial decouplers push through the booster CoM + nose-out tip; aero torque fade-in (0.6 s) on fresh pieces; per-part pitch damping (`C_MQ`); vessel–vessel contact as a safety net |
| In-flight ΔV uses sea-level Isp for every stage | `stageStats()` mixes: current/launch stage at the current pressure, later stages vacuum; vac/now exposed |
| warpTo freezes at a warp-altitude limit | same threshold for raise and drop; stalled rails step always lowers the rate |
| Manual pitch twitchy (+23°/s² with SAS) | SAS-on manual input = rate command (12°/s atmosphere, 26°/s vacuum) |
| Spool-down tail blocks warp, adds ~7 m/s | 0.05 s throttle-down, snap below 2 %, warp checks the commanded throttle |
| Capsule terminal velocity 240 m/s; chute jolt = max g | blunt-body Cd on heat shields/pod bottoms; reefing caps the total load at 3 g; ablator scale retuned |
| Capsule never cools (600 K afloat) | subsonic wake fraction, natural convection, water quench; `telemetry.heatFraction` |
| Stages fall through each other on the pad | new `collide.js` vessel–vessel contact; resting on a grounded vessel pins |
| Lune Lander tips on 13–19° slopes | auto-levelling legs (open-loop from per-foot ground samples, clearance-limited); `telemetry.slope` |
| (found while testing) pinned vessels lagged one physics step behind the rotating ground | pinned step ends at `ut + dt` |
