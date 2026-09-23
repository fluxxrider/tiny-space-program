# parts3d — part models, materials, vessel renderer, plumes

Owner files: `src/render/partMeshes.js`, `src/render/materials.js`, `src/render/vesselRenderer.js`, `src/render/plume.js`,
`tests/parts.html`, `tests/parts3d.test.mjs`, `tests/parts3d_perf.mjs`, `tests/parts3d_return.mjs`. `src/data/parts.js` was
**not** modified (labels and paint schemes are keyed by part id inside `materials.js`; `def.mesh.label` is honoured if
someone adds it later).

## Playtest round 2 (return / robust) — what changed

| Finding | Fix |
|---|---|
| **MAJOR** heat glow never appears on a heat-shielded capsule (shield peaks ≈ 1250 K of 3300 K maxTemp) | `heatGlowLevel(temp, maxTemp)` (exported from `vesselRenderer.js`) = max(**absolute incandescence** `smoothstep(720, 1700, T)^0.8`, near-failure warning `(T/maxTemp − 0.5)/0.5`). 900 K ≈ 0.14 (faint red), 1000 K 0.27 (dull red), 1250 K 0.63 (orange), ≥ 1700 K 1 (yellow-white). Windward weighting unchanged. Verified in the real game: `pt_return_heat` overlays now `heatshield_s1:glow…`, `shots/parts3d_return_B2_shield_1250K.png`, `p3d_ptr_07_reentry_28km.png`. |
| **POLISH** Terrier vacuum plume at 100 % is a faint grey haze | Vacuum plume redesigned (sea level unchanged, all terms are `vac`-weighted): new `uFlare` uniform (radius ∝ s^0.45 in vacuum, so the bell flares right at the lip), bright white-hot core cone at the exit (intensity 1.05, longer, flaring), outer bell intensity 0.42 → 0.52 but faster tail fade and softer edges, a deeper/saturated version of the engine colour for the bell, brighter exit halo. Still pure additive (stars show through). `shots/parts3d_burn_vacuum.png`, `p3d_vessels_v2.png`, in game `parts3d_return_A1_deorbit_burn_default.png`, `p3d_ptr_03_deorbit_burn.png`. |

Improvements:
* **Night-return visibility kit** (`vesselRenderer.js`, `partMeshes.js`, `materials.js`). Night factor per vessel from the
  body's shadow cylinder with a twilight band (2.5 % of R with an atmosphere, 0.4 % airless), smoothed; `opts.night`
  overrides. Crewed pods get a red **beacon** (flash every 1.3 s) and a white **strobe** (double flash every 1.7 s), the
  probe core a slow amber pulse, the Trio and Lander can a **lamp/searchlight** that is on while LIGHTS (U) is on — glow
  sprites (HDR, bloom) with a minimum apparent size (a point of light from far away), hidden when the fixture faces away,
  30–45 % brightness in daylight, off on debris / flat probes. **Cabin windows** glow warm at night when crew is aboard
  (or with LIGHTS on) via a per-vessel clone of the glass material. Canopies got a **retro-reflective tape band** that
  catches the strobe flashes. The active vessel gets a soft **moonlight fill** (one budgeted PointLight from the camera
  side and above, `FILL_E` 0.5 irradiance at full night, 0 by day). `U` (LIGHTS) now does something visible.
* **Ablator charring**: the heat shield's ablator darkens (per-vessel material) with the fraction of Ablator used.
* **Per-vessel static batching**: every static part mesh (`userData.tspStatic`, direct children that never move/hide)
  is merged into one multi-material mesh per vessel (one draw per material), built time-sliced (4 ms/frame) 0.4 s after
  the last topology change; any add/remove/move drops it at once (no ghost of a departed stage). Originals are hidden
  (`tspBatched`), stay raycastable, keep partUid, count for `partBounds`, and heat/highlight overlays are attached as
  siblings so they still show.
* **Vessel LOD**: `buildPartMesh(def, { lod: 1|2 })` builds coarser models with the same builders (`LOD_LEVELS`: segment
  counts × 0.4 / × 0.22 in every curved helper, details under 3 cm / 9 cm dropped; node planes and rig node names are
  identical, asserted per part). The renderer switches the whole vessel (geometry + materials swapped by mesh path,
  hysteresis ±10 %) when its largest part radius covers < 40 px (LOD 1) / < 12 px (LOD 2) on screen; LOD models are
  prewarmed in idle time. Catalogue triangles: LOD 1 = 29 %, LOD 2 = 16 %.
* Measured in the real game, heavy_lifter on the pad at the default camera (1600×900, bloom, `tests/parts3d_perf.mjs`):

  | | frame draw calls | frame triangles | vessel draws | vessel triangles |
  |---|---|---|---|---|
  | before (no batch, full detail) | 392 | 762 k | 161 | 175 k |
  | batch + auto LOD (LOD 1 at 55 m) | 180 | 515 k | 55 | 52 k |
  | 250 m away, LOD 2 | 208 | 536 k | 52 | 32 k (vs 175 k at full detail) |

  Screens look identical (`parts3d_perf_pad_batched.png` vs `_unbatched.png`). Batch build: heavy_lifter 7–13 ms total
  (time-sliced), a 160-part test craft ≈ 10–15 ms at LOD 1 / 30–60 ms at LOD 0 (spread over frames).


## What was built

* **46 procedural part models**, one per entry in `PART_LIST`, each matching its definition exactly:
  stack parts span precisely `[-height/2, +height/2]` (node planes) with footprint radius = `def.radius` / `topRadius`,
  surface parts grow along +X from `srfAttach`, the radial decoupler's faces sit at x = 0 and x = `mesh.thickness`,
  engine exit planes sit at `modules.engine.nozzle.y` with exit radius ≈ `nozzle.radius`, leg feet land exactly on
  `footStowed` / `footDeployed`. All of this is asserted by `tests/parts3d.test.mjs` (plus a flush tank-on-tank stack).
  * Tanks: white panelled walls with seams, rivet rows (bump), stencilled labels (FT-400, JUMBO-64…), black/orange
    bands, roll-pattern quarters on tall tanks, TSP roundels, weld rings, cable raceway; Jumbos in safety orange with a
    feed line. Mono-80 is an open-frame torus tank. Oscar has a fill valve.
  * Engines: lathe-profiled Rao-style bells (quadratic contour from throat angle to exit angle) with heat-tint gradient +
    cooling-tube bump, inner soot wall, exit lip & hat bands; chamber (foil-wrapped on vacuum engines), convergent
    section, injector dome; open trusses with turbopumps, feed lines, pressurant spheres (Terrier) or painted shrouds
    with louvres (Reliant/Skipper/Mainsail/Poodle); orange gimbal actuators; Mainsail turbine exhaust ducts ride the bell.
    The nozzle assembly is a separate `nozzle` pivot at the chamber top (gimbal).
  * Nerva: reactor drum with trefoils, radiator fins, feed lines, green status LED. SRBs: aft skirt, stubby ablative
    nozzle, field-joint bands, raceway, separation motors, per-booster paint (Flea red top, Hammer roll checks,
    Thumper hazard chevrons, Kickback candy stripes).
  * Pods: Mk1 (window wrapped onto the hull, hatch, handrails, RCS ports, Tinyland flag), Trio (three windows, hatch
    window, RCS quads, docking tunnel), Lander can (down-looking visor with twin panes, searchlight, foil skirt, ladder),
    Octo probe (flat-shaded octagon, crinkled gold foil, label plate, LEDs, sensor dish).
  * Decouplers with hazard ring + explosive bolts, radial decoupler bracket with pistons, ogive nose cones (rounded tip),
    swept extruded fins (control fin has a hinged `flap`), ablative heat shields (honeycomb), parachute canisters with a
    pop-off `chuteCover` and packed canvas, articulated telescoping landing leg (3-stage strut, damper + spring,
    self-levelling foot pad), RCS quad, battery, sun-tracking solar panel, whip antenna, yellow girder truss.
* **Materials** (`materials.js`): shared cache; untextured palette colours are baked into vertex colours and drawn with
  two shared materials (`paintVC` dielectric, `metalVC` metal) → ~5 draw calls per part on average (233 for all 46).
  Canvas textures (color + half-res bump) painted once per part and cached (mipmaps, anisotropy 8, sRGB); shared tiling
  textures for gold foil, bell tint, ablator honeycomb, bolt-circle caps, solar cells, grilles, hazard stripes.
* **VesselRenderer** + **plumes/effects** (see API). Canopy: smooth gores in alternating colours, scalloped skirt,
  suspension lines, reefed streamer (semi), opening with ~12 % overshoot driven by `chute.t`, breathing & sway,
  collapse-and-hide on cut/destroyed, oriented against the airflow, reflective tape band. Heat glow: windward-weighted
  overlay whose colour ramps dull red → orange → white-hot per fragment (hot centre of a heat shield, red rim, lee side
  dull), driven by `heatGlowLevel` (absolute temperature + near-failure warning).

## Public API

```js
// partMeshes.js
buildPartMesh(def, { ghost = false, thumbnail = false, lod = 0 } = {}) → THREE.Group   // per ARCHITECTURE §5; lod 1/2 = coarser
LOD_LEVELS                              // [{ detail, minFeature }] per level
disposePartMesh(obj)                    // frees only per-instance resources (template geometry/materials are shared)
renderPartThumbnail(def, size = 128) → Promise<dataURL>   // cached per (id,size); one shared offscreen renderer
partBounds(obj, out?) → Box3            // bounds of visible (or batched), non-fx geometry in obj's frame (VAB uses it)
clearPartMeshCache()                    // dispose all cached template geometry (only when quitting)

// vesselRenderer.js
new VesselRenderer(vessel, { lights = true, batch = true, lod = true } = {})
  .group, .sync(vessel), .update(dt, vessel, { pressure, camera, ut, envIntensity?, sunDirection?, night? (0..1) }),
  .setHighlight(uid | null, color = 0x4fc3ff), .getPartObject(uid), .setLod(0|1|2), .dispose()
  .night (0..1, smoothed), .lod, .stats { batchBuilds, batchMs, batchDraws, batchedMeshes, lodSwitches, pxPerPart }
highlightPartObject(obj, color | null)  // same hover overlay for a standalone part mesh (VAB)
heatGlowLevel(tempK, maxTempK) → 0..1.1 // glow level used by the heat overlay; GLOW_T0/GLOW_T1 = 720/1700 K

// materials.js (optional helpers)
createPartEnvironment(renderer, { preset: 'sky'|'studio'|'space' }) → PMREM texture (caller owns)
setPartEnvMap(tex|null), getPartEnvMap(), setPartEnvIntensity(k), setGhostColor(color), getMaterial(key),
heatColor(t, outColor), disposeAllPartMaterials()

// plume.js (used by VesselRenderer; usable standalone)
new EnginePlume(def, meshUserData.engine) .group .update(dt, time, throttleEff, pressureKPa) .dispose()
new RcsPuffs(nozzles) .group .update(firingArray, time) .dispose()
glowTexture()                           // shared soft radial sprite texture (null without a DOM)
```

### Deviations / additions to ARCHITECTURE.md (all backwards compatible)
* `userData.animate(state, dt, ctx?)` takes an optional third arg `ctx = { time, airflow?: Vector3, sun?: Vector3 }`
  (part-local unit vectors: where the canopy should trail / toward the sun). `animate(null)` keeps the default pose
  (legs stowed, chute stowed) — this is how the VAB calls it.
* `userData.engine` also has `gimbalY, throatY, bellLen, throatR` and a non-enumerable `nozzle` (the gimbal pivot).
  Extra `userData.chute = { attach, diameter }`, `userData.rcs = { nozzles:[{pos, dir}] }`, `userData.style`,
  `userData.lights = [{ kind: 'beacon'|'strobe'|'lamp'|'probe', pos, normal, size }]` (command parts).
  Mesh flags: `userData.tspStatic` (mergeable), `userData.tspBatched` (hidden because a VesselRenderer draws it merged).
* **Gimbal convention (visual):** `nozzle.rotation.x = part.engine.gimbal.x`, `nozzle.rotation.z = part.engine.gimbal.y`
  (radians, part-local). If physics defines the opposite sign, flip it there or tell parts3d.
* `VesselRenderer` constructor takes optional `{ lights, batch, lod }`; `update()` accepts optional `envIntensity`,
  `sunDirection`, `night`; `pressure` defaults to `vessel.telemetry.staticPressure`. It also accepts craft-format parts
  (`{uid, part, pos:[..], rot:[..]}`) so the VAB/space center can reuse it. It reads `vessel.controls.lights`,
  `vessel.crew`, `vessel.type` ('debris' → no beacons), `telemetry.electricCharge`, `part.resources.Ablator`.
* Plumes use premultiplied-alpha blending rather than pure additive: in vacuum alpha → 0 (pure additive glow); at sea
  level the envelope gets partial coverage (≤ 0.5) so an orange flame reads against a bright sky.

## How to test

* Logic/geometry (node): `node tools/run-tests.mjs parts3d` — builds all 46 parts (no DOM → no textures), checks node
  planes, radii, attach sides, nozzle metadata, leg foot positions (stowed/deployed/compressed), chute state machine &
  airflow orientation, flap clamping, ghost transparency, shared geometry; VesselRenderer plumes/gimbal/light budget/
  highlight/heat overlays/decouple sync/dispose/craft-format parts; incandescence levels (1250 K shield glows, 300 K pod
  doesn't), ablator charring, static batching (hidden originals, partBounds, overlays while batched, drop on decouple,
  time-sliced build + cancel), LOD models for every part (coarser, same node planes and rig nodes), LOD switching
  (manual + from the camera distance, exact restore at LOD 0, cabin glass kept), night kit (beacons flash, cabin
  light, fill only at night, LIGHTS in daylight, none on debris, one fill light).
* Visual (`tests/parts.html?view=…`), e.g.
  `node tools/snap.mjs 'tests/parts.html?view=grid' --out shots/parts3d_grid.png --wait 8000 --size 1800x1100`
  * `grid` — every part labelled (`&only=id,id`, `&cat=engine`, `&ghost=1|id`, `&highlight=id`, `&pose=display`,
    `&lod=1|2` LOD models)
  * `vessels` — split screen, same rockets firing at 101 kPa vs vacuum (`&throttle=0.4`)
  * `landing` — lander on deployed legs + RCS puffs + solar/antenna/battery, capsule under a deployed chute, Trio with a
    streamer and opening radial chutes, a re-entering capsule glowing, hover highlight (`&noenv=1` tests the auto env)
  * `closeup&part=id` — one part, orbitable (`&throttle`, `&pressure`, `&temp=0.9` (× maxTemp) or `&tempK=1250`,
    `&chute=semi`, `&rcs=1,0,1,0`, `&zoom`, `&az`, `&el`, `&ty`, `&hide=core|outer|glow`, `&bloom=1|game`)
  * `burn` — in-game-like burn: Orbiter I upper stage (`&stack=id,…`), `&pressure` (0 = space), `&throttle`, `&dist`,
    `&az`, `&el`, `&ty`, `&bloom=game` (the flight scene's bloom settings)
  * `night` — night kit: capsule under a chute (owns the fill; `&fill=0`), lander with LIGHTS on, Trio, probe core
    (`&night=0..1`, `&lights=1`, `&dist`, `&az`, `&el`, `&ty`)
  * `anim&dt=0.1` — timeline: chute armed → semi → deployed, legs deploying, fin flap waving (use `--shots`)
  * `thumbs` — thumbnail sheet via `renderPartThumbnail` (logs total time & cache hit)
* Screenshots of all of the above are in `shots/parts3d_*.png` (incl. the real VAB with stock crafts).
* Real game:
  * `node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 --script tests/parts3d_return.mjs --out shots/parts3d_return_end.png`
    — A) deorbit burn (vacuum plume, default + close camera), B) heat shield forced to 1250 K in real plasma
    (3 views + overlay levels), C) dropped on the night side under the chute (night factor, fill, cabin, fixtures).
  * `node tools/snap.mjs "index.html?scene=flight&craft=heavy_lifter&debug=1" --wait 3000 --size 1600x900 --script tests/parts3d_perf.mjs --out shots/parts3d_perf_end.png`
    — draw calls / triangles with batching + LOD vs without, on the pad and 250 m away (numbers above).
  * The playtest scripts `tests/playtest/pt_return_heat.mjs` / `pt_return_reentry.mjs` (`PT_TAG=p3d_ptr_`) were re-run.

## Integration notes (flight scene / shell)

* Create one `VesselRenderer` per rendered vessel (within `RENDER_RANGE`), add `group` to the scene, each frame:
  `vr.sync(vessel)` (cheap), set `group.position = (vesselRootPos − originRootPos) − rot·comLocal`,
  `group.quaternion = vessel.rot`, then `vr.update(dt, vessel, { pressure: tel.staticPressure, camera, ut })`.
  Dispose on `vessel:removed`/`vessel:destroyed`/scene exit. Decoupling = parts vanish from `vessel.parts` → `sync`
  removes them; the new debris vessel gets its own renderer (templates are shared, so it is cheap).
* **Engine lights:** at most 3 point lights exist across all renderers (a light is allocated the first time a renderer
  with engines is created and returned on dispose). Adding lights changes three's light count → one-time shader
  recompile; pass `{ lights: false }` for debris / parked vessels (the space center already does). Consider giving the
  active vessel its renderer first. The **night fill** is one more PointLight, at most one across renderers, allocated
  by the first `lights: true` renderer (the active vessel; intensity 0 in daylight, so no recompile at dusk).
* **Batching/LOD** are automatic. Anything that toggles the visibility of a part's direct-child meshes from outside must
  not rely on it while batched (nothing does today); `vr.stats` exposes the numbers. `vr.setLod(n)` + `vr._lodEnabled =
  false` force a level (used by the perf script).
* **Environment:** part metals/glass want an environment map. If `scene.environment` is set, parts use it. If not, the
  first part mesh's `onBeforeRender` schedules a soft procedural sky PMREM (microtask, once per renderer) and assigns
  it to the part materials only. In space, call `update(..., { envIntensity: 0.3 })` (or `setPartEnvIntensity`) so the
  night side isn't studio-lit; ~1 on a sunny pad. `createPartEnvironment(renderer, {preset:'space'})` is a good
  `scene.environment` for orbit if the worlds area doesn't provide one.
* **Picking:** every body mesh has `userData.partUid`; plumes, puffs, overlays and the canopy are `userData.fx` and
  have no-op `raycast`, so hover/click picking hits real parts only. `setHighlight(uid)` for hover.
* **Solar panels** track the sun automatically via `physics/universe.js#sunDirection` (dynamic import) or
  `opts.sunDirection` (inertial). **Canopies** use `telemetry.surfacePrograde` (or vel − ω×r fallback).
* Heat glow reads `heatGlowLevel(part.temp, def.maxTemp)` (absolute incandescence from ~800 K, or > 50 % of maxTemp) and
  weights windward faces using `telemetry.surfacePrograde`; the fx area draws the plasma. Plumes don't collide with the ground; ground
  smoke/dust is the fx area's job. Plume geometry is not frustum culled (cheap, avoids popping).
* Thumbnails: `renderPartThumbnail` queues one render per macrotask on a private 256² context (released after 10 s
  idle); all 46 take ~8 s under SwiftShader, far less on a GPU. HUD and VAB already use it.

## Known issues / limits

* Stencil fonts rely on system fonts ("Arial Narrow"/"Arial Black", falling back to Arial) — fine on macOS/Windows,
  slightly different lettering on Linux.
* Canopy suspension lines are 1-px `LineSegments`.
* Plume envelope alpha is order dependent in principle; it is capped at 0.5 so no banding is visible (checked from below
  looking up the plume, the worst case).
* Texture budget ≈ 45 MB GPU for the whole catalogue (half-res bump maps, 512-wide SRB skins); templates/textures are
  only created for parts actually built.
* The `thumbnail` pose shows legs deployed and the solar panel tilted; the in-game default pose is stowed.
* The night factor of vessels parked at the space center uses their stored `pos`, which may be stale there (only the
  beacon brightness depends on it; parked renderers have no fill light).
* The glow-sprite fixtures are depth-tested; a sprite on a hull edge can be slightly clipped by the hull behind it
  (they fade out when the fixture faces away from the camera, which hides the worst case).
* LOD templates keep geometry for every part type × level ever used (tiny); `clearPartMeshCache()` also drops them, but a
  live VesselRenderer's LOD lookup cache would then be stale — only call it when quitting.
* The VAB (`scenes/vab.js`) builds part meshes directly, so it gets neither batching nor LOD (≈ 230 draws for the
  lune_lander in the VAB).
