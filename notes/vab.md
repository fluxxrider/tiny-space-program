# VAB area — Vehicle Assembly Building, craft format, ΔV, stock crafts

Owner files: `src/scenes/vab.js`, `src/scenes/vab/*` (editOps, partVisuals, fallbackParts, hangar, orbitRig, fx, ui, icons),
`src/ui/vab.css`, `src/game/craft.js`, `src/game/deltav.js`, `src/game/stockCrafts.js`, `tests/craft.test.mjs`,
plus headless scenario scripts `tests/vab_scenario_{stock,build,misc,radial}.mjs` (driven by `tools/snap.mjs --script`).

## What was built

**Scene** (`index.html?scene=vab`): a procedural hangar — polished tiled floor with bay markings (hazard ring, ticks,
circular stencil text, lanes to the door), glowing assembly platform, ribbed walls with pillars/girders and emissive light
strips, roof trusses & lamp fixtures, a huge painted door with a sliver of daylight, a red launch-tower gantry with service
arms, an overhead crane with a swaying hook, crates/barrels/cones, a "days since last rapid unplanned disassembly: 0"
banner. Warm key light with PCF-soft shadows fitted around the craft, cool fill, rim, hemisphere + RoomEnvironment PMREM.

**Editing** (all KSP-style):
- Click (or drag) a part card → the part follows the cursor. When not attachable it is a scanning blue hologram; when snapped
  it shows real materials with a breathing rim, plus symmetry ghosts. Invalid surface → red.
- Stack snapping in screen space (46 px node↔node, or 30 px cursor↔node marker), size mismatch allowed with a penalty so
  same-size nodes win. Node markers: green dot + ring sized to the node (ring faces the node direction); target = pulsing
  yellow; the carried part's own free nodes = cyan.
- Surface attach by raycasting part meshes (parts with `allowSrfAttach`), exact radial normals on round parts, srfAttach
  convention (part +X = outward normal, +Y as close to vessel +Y as the surface allows). Angle snap (C) = 15° around the
  parent's axis. **Radial decouplers have one fixed attach point** (centre of the outer +X face, `surfacePointLocal(def,0,0)`),
  whichever face the cursor is on — boosters always sit flush and centred, 1.45 m from a 1.25 m core's axis.
- Symmetry 1/2/3/4/6/8 (X / Shift+X or the toolbar button, right-click = reverse), see `ops.symmetryPlan`:
  * parent in a symmetry group → **inherited** (KSP): one copy per counterpart parent, the toolbar count is ignored
    (cursor label "×2 · symmetry from the Radial Decoupler", hint "sym from parent (×2)");
  * round parent (`isRevolutionPart`) not in a group → the toolbar count, copies rotated about the parent's own axis;
  * non-round parent (radial decoupler, girder) or stack attachment → never multiplied.
  * A picked-up group whose members sit ×k on each of several counterpart parents comes back the same way
    (`held.nested = k`); per-parent groups made by the stock builder ("2 fins on each booster") are matched on the
    counterpart parents and lifted with it, so pick-up + re-place is lossless.
- **Clipping check**: every ghost (all symmetry copies, whole carried subtree) is tested against the craft and against
  the other copies (`ops.heldClipping`). A clipping ghost turns red, the cursor label says "Clips into the FT-800 Fuel
  Tank · move it or rotate it (WASDQE)", the hint says "blocked — it would clip", and clicking does not place it.
- Rotation keys (90°, Shift = 15°): stack parts W/S about X, A/D about Z, Q/E about Y (roll about the stack axis).
  **Radial parts** (snapped to a surface, or surface-only parts like fins): Q/E roll about the surface normal (the part
  stays on the outside), W/S tilt about the surface tangent, A/D turn about the vertical (can turn it into the parent →
  red ghost).
- Click a placed part = pick it up with its subtree (its symmetry counterparts are removed and re-created on placement;
  symmetry mode switches to the group's local count). Clicking the root carries the whole craft. Alt+click duplicates.
- Delete/Backspace scraps the carried part (or the hovered part), dropping on the parts list scraps it too (the panel turns
  into a red "scrap" bin), Esc cancels a pick-up (restores exactly), Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z undo/redo (JSON
  snapshots, 150 deep), Ctrl+S saves (also while renaming), F frames the craft.
- The craft always rests on the platform; while a snapped ghost would dip below it, the craft is hoisted just enough
  (the camera follows the craft, so the parts under the cursor don't move).
- Right-click a part → action popup: live resource sliders (applied to symmetry mates, e.g. partial SRB loads), stage ±,
  Pick up, Duplicate, Delete.
- Hover: blue tint on the part, lighter on its subtree, purple on symmetry mates, cursor label with name/"+N attached".
- Camera: right-drag (or left-drag on empty space) orbit, wheel zoom, middle-drag / Shift+wheel vertical pan, damped;
  auto-frames on load/new/first part and zooms out (never in) when the craft outgrows the view. The projection center is
  offset into the free area between the UI panels (`camera.setViewOffset`).

**UI**: top bar (VAB badge, editable name, New/Load/Save, undo/redo, symmetry/snap/CoM toggles, frame, Exit, Launch with a
glow when the engineer is happy), parts panel (category rail with short labels that fit the 58 px rail — Aero, Struct —,
3D thumbnails from parts3d with 2D fallback icons, search,
rich tooltip: wet/dry mass, cost, size, thrust & Isp vac/ASL, gimbal, TWR alone, resources, crash tolerance, max temp,
attach rules, description), staging panel (highest first; stage icons grouped by symmetry with ×N; drag icons between
stages or onto "new first/last stage" overlays; + Stage; Auto (wand); × removes a stage; per stage ΔV vac & ASL, TWR at
Verda sea level colour-coded for the launch stage, burn time; totals; below 820 px window height the cards switch to a
compact one-row layout so a 5-stage Big Bertha fits at 1280×720 without scrolling), Engineer's Report (collapsible; neutral
"Empty" badge for an empty hangar; every item that concerns parts lights them up on hover; staging problems offer a
one-click **Fix staging** (= Auto) when automatic staging would clear them), stats pill (mass, parts, cost, height, crew,
ΔV, launch TWR; labels never wrap), contextual key hints on a dark translucent pill (hidden when
`settings.tutorialHints === false`), empty-hangar onboarding, **first-rocket guide** (checklist card top-left of the
view: pod → parachute → fuel tank → engine → launch; the next part's category tab and card glow; click a step to open
its category; shown for crafts started from an empty hangar / New, hidden for loaded crafts; done for good after the
first launch with a complete checklist or ×, stored in `tsp.vabGuideDone`; off with `tutorialHints`), Load modal (stock
cards with stats + saved crafts with 2-click delete; damaged saves listed as such so they can be deleted), pre-launch
report modal, **stage preview** (hover a stage card: what fires glows orange, what falls away glows red, with a small
legend in the panel). Responsive down to ~1024×640 (labels collapse to icons).

**Sounds** (`src/audio/audio.js`, imported defensively): `setScene('vab')`; `pickup`, `place`, `delete`, `error`,
`toggle` (keyboard toggles) and `click` for non-button clicks. Buttons get click/hover sounds from audio.js' global hook.

## Public API

### `src/game/craft.js` (node-importable)
Contract (ARCHITECTURE §6): `layoutCraft, validateCraft, autoStage, cloneCraft, serializeCraft, parseCraft, craftStats,
saveCraft, listSavedCrafts, loadCraft, deleteCraft`. Extras used by the VAB/stock builder:
`CRAFT_FORMAT, HOME_GRAVITY (9.81), HOME_ASL_PRESSURE, createCraft(name), craftPartDef(p), stageKind(def)
('engine'|'decoupler'|'chute'|null), isStageable, partResources(p) → {Res:{amount,max}}, partMass(p) (t), nextUid,
nextSymId, partIndex, childrenIndex, findRoot, findAnchor, subtreeUids, nodeUsage, nodeInVessel(p, node),
surfaceAttachFrame(normal), isRevolutionPart(def), surfacePointLocal(def, y, θ), surfaceAttachTransform(parent, def, y, θ),
compactStages, maxStage, partLocalBox(def), craftBounds(craft), sanitizeCraft, stageDrops, findClipping, clipDepth,
partShape, shapeDepth, clipExempt, CLIP_INSET, CLIP_TOL`.
- uids are integers (any unique value works everywhere; other areas' tests use strings).
- `craftStats` → `{ mass, dryMass (tonnes), cost, partCount, height, width (m), crew, engines, stages, resources }` (superset).
- `listSavedCrafts()` → `[{ name, updated, partCount, corrupt? }]` newest first; storage key `tsp.crafts` =
  `{ [name]: { updated, craft: <serialized> } }`. Never throws: a stored value that is not a plain object (null, array,
  string) reads as "no saves" (and the next save replaces it), entries that are not records are skipped, records whose
  craft does not parse (or has no buildable part) are listed with `corrupt: true`; `loadCraft` returns null for all of
  them. `sanitizeCraft(craft)` (used by `listSavedCrafts`, `loadCraft` and `VABScene.setCraft`) drops unknown part ids,
  duplicate uids and parts not connected to the root, gives uid-less parts a uid, and returns how many parts it removed
  (`loadCraft` exposes it as the non-enumerable `craft.removedParts`; the VAB toasts "N parts … could not be rebuilt").
- `stageDrops(craft, s)` → uids of the parts stage `s` jettisons (after every earlier stage fired) — the VAB stage preview.
- `validateCraft` → `{ ok, errors, warnings, issues }` — `issues` (superset) = the same messages in order as
  `{ level:'error'|'warn', text, uids:[…parts involved], kind?:'staging'|'clipping' }` for highlighting.
  Errors: empty, broken part entry, unknown part, duplicate uid, bad transform, no root / loose parts / missing parent, bad or
  doubly-used stack node. Warnings (Engineer's report): no command part, crewed without parachute, no engines, unstaged
  engines/chutes/decouplers, engine without fuel in its crossfeed domain, first stage without engines, launch TWR < 1 / < 1.2,
  **engines jettisoned the moment they ignite** (a staged decoupler whose separated piece — the side without the anchor —
  holds an engine of the same stage), **engines dropped before they ever ignite** (engine stage < decoupler stage),
  parachute staged with an engine, **parachute firing before the engines** (armed on the pad), probe with little EC and no
  solar panels, **parts clipping into each other** (one line: "Hammer Solid Booster ↔ FT-800 Fuel Tank ×2, …").
- Clipping (`findClipping(craft)` → `[{a, b, depth}]`, `clipDepth(A, B)` for `{def, pos, rot}`, `partShape(def)`,
  `shapeDepth`, `clipExempt`, `CLIP_INSET`/`CLIP_TOL` = 4 cm): round parts are truncated cones (nose cones to 12 % tip),
  others their `partLocalBox`; sample points 4 cm inside one part must lie > 4 cm inside the other, so touching parts
  (stack faces, radial parts on pods/cones) never count. Whip antennas are exempt (their base plate hangs 0.4 m below the
  attach point by design — the stock sounding rocket's would otherwise "clip" into its adapter). ~1–2 ms for 40 parts.
- `autoStage` (KSP-like): split the tree into "pieces" at decoupler joints (stack decoupler: top-node joint; radial: joint
  to its parent), walk outward from the anchor (first command part from the root). A stacked piece is dropped by its
  decoupler in the stage in which the piece above ignites; radial pieces with engines (boosters) ignite together with the
  core they hang on and their decouplers fire in the next stage; all chutes → stage 0; stages compacted.

### `src/game/deltav.js` (node-importable)
`computeStageStats(parts, { pressure=0, gravity=9.81, fromStage=null })` → `{ stages:[{stage, deltaV, burnTime, startMass,
endMass, thrust, twr, isp}], totalDeltaV }`, stages in firing order down to 0. **Units: masses in kg, thrust in N** (SI).
Accepts craft parts and physics PartStates (`def|part|id`, `parentUid|parent`, resources as numbers or `{amount,max}`,
`engine.active`, `decoupled`). `fromStage` = the most recently activated stage (vessel.currentStage); stages above it count
as fired/lit; `null` or a value above the max stage = nothing activated yet (prelaunch).
Also exported: `buildPartGraph, anchorIndex, crossfeedDomains, partDefOf, craftDeltaV(craft)`.
Model: SolidFuel stays in its part; everything else flows inside crossfeed domains (cut at decoupler joints); fuel flow fixed
by throttle (§3); event-driven segments integrated exactly with the rocket equation ("time-stepped" with adaptive steps and
no step error). A stage ends when nothing burns, or early when the next stage's decouplers would drop at least one
lit-and-burnt-out engine and no burning one (dead strap-on boosters while the core keeps burning). Decouplers holding
nothing (boosters removed with custom staging, or being carried in the VAB) or only unlit/non-engine parts never end a
stage early (this fixed the "launch stage 0 m/s, decoupler stage 1,447 m/s" readout). ~0.02 ms for a 52-part craft.

### `src/game/stockCrafts.js`
`STOCK_CRAFTS`, `getStockCraft(id)` (deep clone), `CraftBuilder` (node-aligned stacking helper: `root, stack, below, above,
surface{count,y,angle}, surfaceEach, aboveEach, belowEach, surfaceOnEach, build`), `SOUNDING_ROCKET_SOLID_FUEL`.

| id | parts | mass | ΔV vac / ASL | pad TWR | notes |
|---|---|---|---|---|---|
| flea_hopper | 7 | 2.5 t | 859 / 729 | 6.51 | pod, chute, decoupler, Flea, 3 fins |
| sounding_rocket | 11 | 2.2 t | 1379 / 1202 | 9.21 | probe; Hammer loaded with 150/375 SF → ≈31 km apogee (1-D estimate) |
| orbiter_1 | 20 | 18.5 t | 4725 / 2535 | 3.10 | 2 stages + 2 Hammers, heat shield, chute |
| lune_lander | 38 | 60.8 t | 7284 / 4352 | 1.79 | 2.5 m first stage + Thumpers, transfer stage, lander (2946 m/s) with **6 legs** mounted low (feet 0.38 m below the Terrier bell) + a reaction wheel so SAS holds it level on touchdown, RCS, solar |
| pip_probe | 29 | 19.3 t | 8458 / 5434 | 2.98 | probe core, 4 solar panels, Spark probe stage (3134 m/s), kick stage, boosters |
| heavy_lifter ("Big Bertha") | 40 | 181 t | 7004 / 3981 | 2.11 | Trio pod, Mainsail core, 4 Kickbacks with fins & nose cones |

Editor ops (`src/scenes/vab/editOps.js`) additions: `symmetryPlan(craft, target, symMode, {nested})` →
`{ parents, perParent, count, inherited }`, `symmetryPlacements(…, symMode, {nested})`, `heldClipping(craft, held, placements)`
→ `{ heldPart, other, otherUid (null = a symmetry copy), depth } | null`; `pickUp` returns `held.nested`.

### `src/scenes/vab.js` — Scene contract (§7)
`enter(params)`: `params.craft` overrides, else `game.editorCraft`, else an empty craft. Every committed edit (and the name)
is mirrored into `game.editorCraft` (a clone). Launch → `validateCraft`; errors block, warnings show a pre-launch report
("Launch anyway"); then `app.goto('flight', { craft: clone })`. Exit → `app.goto('spacecenter')`.
Debug/test hooks: `window.TSP.vab = { scene, loadStock(id), newCraft(), getCraft(), stats(), pick(partId),
held() (→ { part, parts, cand, source, placements, nested, clip, plan }), place(),
cancel(), setSymmetry(n), setAngleSnap(b), toggleCoM(), frame(), orbit(yaw,pitch,dist), undo(), redo(), partUids(partId),
nodeScreen(uid,node), partScreen(uid), surfaceScreen(uid,y,deg), openLoad(tab), rendererInfo(), fallback }`.

## Deviations / clarifications vs ARCHITECTURE.md
- `layoutCraft`: surface-attached parts keep their transform **relative to their parent** (identical to "keep theirs" when the
  parent does not move; if a stack parent is re-laid-out its radial parts follow it). The root goes to the origin.
- `computeStageStats` returns kg / N (SI); `craftStats` returns tonnes (KSP units, like parts.js).
- `craftStats` / `listSavedCrafts` return supersets of the documented fields.
- Parts carried from the palette never float free: a part must attach to a node/surface (or be the first part = root).
- Staging edits allow empty stages (shown until removed with ×); a part can't be "unstaged" in the editor, so every engine,
  decoupler and parachute always has `stage ≥ 0` (Launch also fixes crafts loaded from elsewhere).

## How to test
- `node tools/run-tests.mjs craft` — 19 tests: exact node alignment for every stock craft, surface contact/orientation,
  layout idempotence, autoStage (stack, radial, 3-stage + boosters, custom staging preservation), ΔV vs the rocket equation
  (≤1 %, vac & ASL, 4 engines), nuclear LF-only, partial SRB loads, decoupler crossfeed blocking, booster two-phase burn,
  `fromStage` + PartState input, performance (<2 ms), stock targets + printed per-stage table + sounding-rocket apogee,
  validation, serialization, localStorage, editor ops (symmetry, counterpart parents, pick-up/duplicate/delete, nested groups).
- New regression tests (26 total): engineer staging checks (jettisoned at ignition, dropped before ignition, chute on the
  pad), clipping (stock crafts clean, misplaced booster flagged), ΔV with empty radial decouplers, corrupt `tsp.crafts`
  (null / number / broken entries, array / string / null root), inherited symmetry (×2 on a decoupler pair → 2 boosters,
  single non-round parent never multiplies), ghost clipping (side-face booster, fin turned into its tank), nested fin groups
  (Big Bertha fin pick-up → 8 fins back in place).
- Headless scenarios (each prints OK/FAIL lines and writes screenshots to `shots/vab_*`):
  `node tools/snap.mjs "index.html?scene=vab&debug=1" --wait 7000 --script tests/vab_scenario_radial.mjs --out shots/vab_radial_end.png`
  (empty-hangar state, guide, pod/tank/engine by mouse, ×2 decouplers + Hammer with symmetry still ×2 → 2 boosters, aim
  points around the decoupler all give the outer-face centre, fin Q/E roll vs A/D into the tank → red + refused, staging
  chip drag into the launch stage → Engineer warning + hover highlight + Fix staging, carried boosters keep the launch ΔV,
  Big Bertha / Lune Lander staging fits at 720p, Load dialog on corrupt storage, a save with an unknown part loads without
  it) — 40/40 checks; screenshots `shots/vab_radial_*.png`, 1080p `shots/vab_hd_*.png`, lander close-up
  `shots/vab_lune_lander_legs.png`. `vab_scenario_build.mjs` now aims its radial decouplers between two fins (in line with
  a fin the Hammer would clip through it and is correctly refused).
  `node tools/snap.mjs "index.html?scene=vab&debug=1" --wait 6000 --script tests/vab_scenario_build.mjs --out shots/vab_build_end.png`
  (real mouse/keyboard: root pod, stack snapping, 4× fins, chute, 2× radial decouplers + replicated boosters, hover, undo/redo,
  popup, carry/Esc, staging drag, auto-stage, load dialog), `tests/vab_scenario_misc.mjs` (tooltip, CoM/CoT, stage hover,
  Alt+click duplicate, scrap bin, Delete, keyboard rotation, pre-launch report, rename + Ctrl+S + load),
  `tests/vab_scenario_stock.mjs` (stock crafts screenshots).

## Known issues
- `chute_mk16` currently throws inside parts3d's `buildPartMesh` (their test also fails); the VAB catches it and uses its own
  fallback mesh for that part only. Nothing to do on the VAB side once parts3d fixes it.
- Surface attachment onto girders uses the raw mesh face normal (fine for a box); radial decouplers use their fixed point.
- The clipping solids are approximations (cones/boxes): an engine is a full-radius cylinder over its height, a leg or
  fin its box. Deliberate KSP-style part clipping is not possible (no "allow clipping" toggle).
- The sounding-rocket apogee (≈31 km) comes from a 1-D drag estimate; if the physics drag model differs a lot, tune
  `SOUNDING_ROCKET_SOLID_FUEL` in `stockCrafts.js`.
- Headless SwiftShader renders the hangar at ~10–14 fps; on a GPU it is far lighter (≈150–300 draw calls with a big craft).

## Integration notes (flight / shell / physics)
- The flight scene receives `params.craft` in the §6 craft format (root at the origin, +Y = nose, every stack joint exact).
  `Vessel.fromCraft` should honour `part.resources` overrides (e.g. the sounding rocket's partial SRB).
- `physics/vessel.js` already calls `computeStageStats(this.parts, { pressure, gravity, fromStage })` with
  `fromStage = currentStage ≤ maxStage ? currentStage : null` — exactly the semantics implemented here.
- `game.editorCraft` is always a clone of the current editor craft; "unsaved changes" is tracked against the last
  saved/loaded snapshot (module scope), so leaving and re-entering the VAB doesn't produce spurious prompts.
- The VAB sets `scene.environment` to its own PMREM and temporarily clears parts3d's shared part env map
  (`setPartEnvMap(null)`), restoring the previous one on exit. It also restores `toneMappingExposure`.
- Scene switch VAB→VAB/VAB→SC→VAB leaves renderer geometries/textures constant (checked with `renderer.info.memory`).

## Playtest round 2 (vab scenario + lune + robust findings)
| Finding | Fix |
|---|---|
| ×2 symmetry on a radial-decoupler pair made 4 boosters (2 inside the core) | `symmetryPlan`: symmetry inherited from symmetric parents, never around non-round parents; ghost count shown in the cursor label/hint |
| Boosters hung off the decoupler's front/side face, half inside the core | fixed attach point on radial decouplers (outer-face centre) + clipping check (red ghost, refused) |
| Engineer silent about boosters jettisoned at ignition | `stagingChecks` in `validateCraft` (+ dropped-before-ignition, chute on the pad, clipping) with hover highlight and Fix staging |
| Launch stage 0 m/s when radial decouplers hold nothing | `deltav.js` early stage end needs a spent engine among the dropped parts |
| "ERODYNAMIC" tab | short rail labels |
| Hint bar unreadable over the platform | dark translucent pill |
| NOMINAL on an empty hangar, LAUNCH TWR / burn time wrapping, stage 0 cut off at 720p | neutral "Empty" badge, `nowrap`, compact stage cards below 820 px height |
| Q/E turned a fin into the tank | radial parts roll about the surface normal; turning into the parent is flagged as clipping |
| null / array `tsp.crafts` broke Load and lost saves | `readAll` / `listSavedCrafts` / `loadCraft` validate entries |
| unknown part ids in a save crashed the VAB when loaded | `sanitizeCraft` on list/load/setCraft |
| Improvements | first-rocket guide, Engineer hover highlight + Fix staging, stage preview on hover (fires / falls away), clipping ghosts drawn through other parts |
| lune_lander tipped over on ≥ 12° slopes | 6 legs mounted lower + a reaction wheel (see the table). Together with the physics area's contact/SAS changes, the playtest drop test (`tests/playtest/pt_lune_droptest.mjs`) went from 9/27 tipped to 0/27. A wider scratch drop test (fair placement on 0–27° sites, 1 and 2.5 m/s, full and 35 % fuel) stays upright on every site up to 19° and on 6 of 8 drops on 20–27° slopes. Wider-stance variants (a 2.5 m Jumbo-16 lander, legs on girders) were tried and did *worse* with SAS on (more mass per unit of reaction-wheel torque): in the current contact model, SAS authority matters more than stance. A node ascent (FlightSim + the playtest pitch program) still reaches a 121 × 85 km orbit with 1,003 m/s left in the transfer stage. |

Note for `tests/playtest/pt_lune_droptest.mjs` (playtest-owned): it hard-codes the deployed feet at y = −5.875; the new
lander's feet are at −6.225, so its drops start 0.35 m higher (slightly faster touchdowns) — the result above already
includes that. It also places the craft by the terrain under the CoM, so on steep sites the uphill foot can start
inside the ground (the "touchV 10.59" rows); `pt_lune_legs_geom.mjs` reports the new geometry (stance 1.175 m, feet
0.375 m below the bell, static tip angle 17.1° vertex / 16° edge with 6 legs).
