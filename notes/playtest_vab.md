# Playtest — scenario "vab" (builder experience, space center UX, launch fidelity)

Tester: detail-obsessed KSP veteran. All input through real mouse / keyboard (puppeteer); hooks were only used to
*read* state (screen positions of nodes/parts, craft JSON, flight vessel). Headless SwiftShader, 1280×720 and 1920×1080.

## Verdict
The VAB is genuinely good: snapping, node markers, the hoist-to-platform, live ΔV/TWR per stage, auto-staging, the
staging drag & drop, undo/redo, Alt+click copy, save/load/new and the stock rollouts all work, and the numbers are right
(hand-checked with the rocket equation: upper stage 1,725 m/s, launch TWR 3.44, booster stage 1,200 m/s vac — exact).
The launched vessel matches the VAB design exactly (max position error 1.8e-15 m, rotation 1.6e-4 rad, fins +X outward,
boosters outward, staging order identical, Z/Space ignite Reliant + both Hammers, 2nd Space drops the boosters, 3rd lights
the Swivel). But the single most common KSP move — putting boosters on a symmetric pair of radial decouplers with the
symmetry still set to ×2 — silently builds **four** boosters, two of them buried inside the core tank, and the
Engineer's Report calls it "All systems nominal". Even with ×1, clicking the radial decoupler itself usually hangs the
booster sideways off its front face, half inside the core. Graphics quality chosen in the Space Center never reaches the
terrain.

## Scripts (all under tests/playtest/)
| script | what | run |
|---|---|---|
| `pt_vab_1_spacecenter.mjs` | first-time space center, title card, hint, dock/label geometry | `node tools/snap.mjs "index.html" --wait 6000 --script tests/playtest/pt_vab_1_spacecenter.mjs --out shots/pt_vab_sc720_end.png [--size 1920x1080]` |
| `pt_vab_2_sc_ui.mjs` | hover buildings (3D pick), Launch Pad / Mission Control / Astronaut Complex, Settings Low/Medium/High + bloom off/on, Help, click the VAB building | `… --script tests/playtest/pt_vab_2_sc_ui.mjs --out shots/pt_vab_scui720_end.png` |
| `pt_vab_3_build.mjs` | SC dock → VAB, build the two-stage rocket from scratch (pod, chute, FT-400, Swivel, S1 decoupler, FT-800, Reliant, 4 fins ×4, 2 radial decouplers ×2, Hammers, nose cones), shows the ×2 booster bug, then the ×1 workaround; staging/stats/engineer dump; Exit → SC → VAB | `node tools/snap.mjs "index.html" --wait 5000 --script tests/playtest/pt_vab_3_build.mjs --out shots/pt_vab_build720_end.png` (writes `shots/pt_vab_built_craft.json`) |
| `pt_vab_4_launch.mjs` | load the built craft from "My rockets", Launch, compare flight vessel with the VAB craft, Z/Space staging, booster separation | `node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_4_launch.mjs --out shots/pt_vab_launch_end.png` |
| `pt_vab_5_edit.mjs` | hover label, Alt+click copy, undo/redo (Ctrl+Z/Y, Ctrl+Shift+Z, Cmd+Z, toolbar), rotate carried part, Delete on hover, pick-up + Esc, popup, staging drag + Auto, engineer collapse, rename + Save, New (clean/dirty), Load saved, Load stock | `node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_5_edit.mjs --out shots/pt_vab_edit720_end.png` |
| `pt_vab_6_quality.mjs` | Settings → Low in the space center, then launch: which terrain quality does flight use? | `node tools/snap.mjs "index.html" --wait 5000 --script tests/playtest/pt_vab_6_quality.mjs --out shots/pt_vab_quality_end.png` |
| `pt_vab_7_misc.mjs` | carried-fin rotation axes (E/D/S), fins ×2 on a symmetric booster pair, pre-launch report (chute deleted) | `node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_7_misc.mjs --out shots/pt_vab_misc_end.png` |
| `pt_vab_8_sc_labels.mjs` | clicking floating building labels at 1080p | `node tools/snap.mjs "index.html" --size 1920x1080 --wait 6000 --script tests/playtest/pt_vab_8_sc_labels.mjs --out shots/pt_vab_labels1080_end.png` |
| `pt_vab_9_radial_faces.mjs` | where a Hammer attaches when you aim at a radial decoupler (5 aim points, hover only) | `node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_9_radial_faces.mjs --out shots/pt_vab_radial_end.png` |
| `pt_vab_10_sc_return.mjs` | Space Center → VAB → Exit: does the SC UI come back | `node tools/snap.mjs "index.html" --wait 5000 --script tests/playtest/pt_vab_10_sc_return.mjs --out shots/pt_vab_return720_end.png` |
| `pt_vab_deltav_empty_decouplers.mjs` | node-only ΔV repro | `node tests/playtest/pt_vab_deltav_empty_decouplers.mjs` |
| `pt_vab_engineer_staging.mjs` | node-only: Engineer's Report with boosters jettisoned at ignition | `node tests/playtest/pt_vab_engineer_staging.mjs` |
| `pt_vab_lib.mjs` | shared helpers (real mouse/keyboard wrappers) | — |

Scripts 4, 5, 7, 9 read `shots/pt_vab_built_craft_720.json` / `pt_vab_built_craft.json` (written by script 3) and put it in
localStorage as a craft "saved in an earlier session", then load it through the real Load dialog.

## Bugs

### MAJOR — Boosters on a symmetric radial-decoupler pair are multiplied (4 boosters, 2 inside the core) — vab
* Repro (`pt_vab_3_build.mjs` step 10): place 2 radial decouplers with symmetry ×2 on the FT-800, pick the Hammer and
  click the outer face of one decoupler **without** changing the symmetry (×2 is still shown in the toolbar, exactly what
  a KSP player does). Ghost shows 4 boosters; `held.placements.length === 4`; placing adds 4 Hammers
  (and later 4 nose cones). Distances of the booster axes from the core axis: `[1.454, 0.228, 1.454, 0.228]` m —
  two boosters are *inside* the 0.625 m FT-800. Staging: "Hammer Solid Booster ×4", launch TWR 4.07 instead of 3.44,
  Engineer: "All systems nominal". Reproduced in three full runs (720p ×2, 1080p: `[1.056, 0.881, …]`). Only after Ctrl+Z, Shift+X (→ ×1) and placing again
  do you get 2 boosters.
* Evidence: `shots/pt_vab_build720_10_booster_ghost.png`, `shots/pt_vab_build720_10b_boosters_placed.png` (4 HAMMERs,
  two clipping through the core), `shots/pt_vab_built_craft_4boosters.json` (uids 15/17 at r = 0.228 m).
* Root cause: `src/scenes/vab/editOps.js symmetryPlacements()` — for surface attachment it makes one copy per
  counterpart parent **and** `symMode` rotations about each parent's own local +Y axis
  (`n = target.kind === 'surface' ? symMode : 1`). A radial decoupler sits off the vessel axis and is not a body of
  revolution, so rotating 180° about *its* axis puts the copy on the far side of the decoupler, i.e. inside the core.
  Same mechanism gives 4 fins (2 per booster) when you put fins ×2 on the booster pair (`pt_vab_7_misc.mjs`).
* Fix: when the parent belongs to a symmetry group (`parents.length > 1`) inherit the parent's symmetry (`n = 1`, KSP
  behaviour) and never rotate about a parent that is not `isRevolutionPart()`; show the effective count in the hint
  ("×2 — from parent"). Add an overlap check (part AABB/cylinder vs. the parent/core) that turns the ghost red and an
  Engineer warning "parts are clipping into each other".

### MAJOR — Boosters snap sideways onto the radial decoupler's front/side face and sit inside the core — vab
* The radial decoupler accepts surface attachment on **every** face. Aiming at the decoupler the way a player does
  (at the part itself, which from the default VAB angle means its camera-facing face) attaches the booster tangentially,
  with the booster axis 0.89–1.05 m from the core axis (it must be ≥ 1.45 m to clear the 0.625 m FT-800). The ghost is
  shown in "snapped" colours, no red, and the Engineer says nominal.
* Repro: `pt_vab_9_radial_faces.mjs` (hover only, symmetry ×1, five aim points around the decoupler):
  `[0,0] r=0.887 +X=[-0.23,0,0.97]`, `[6,0] r=1.052 +X=[0,0,1]`, `[0,±10] r≈0.886`, `[-6,0]` → attaches to the tank
  instead. None gives a correct booster. Also happened in the full 1080p build (`pt_vab_3_build.mjs --size 1920x1080`):
  booster uids 14/15 at r = 1.056, +X = (0,0,±1) (`shots/pt_vab_built_craft_1080.json`).
  In the 720p build the click happened to land on the outer face, but even then the booster is 0.108 m off-centre
  (`outwardDot` 0.998 in flight).
* Evidence: `shots/pt_vab_radial_0_ghost.png` (booster + mirror overlapping the core), `shots/pt_vab_build1080_10c_booster_ghost_x1.png`,
  `shots/pt_vab_build1080_12_built.png`, `shots/pt_vab_build1080_14_reentered_vab.png` (booster visibly through the core).
* Root cause: `src/scenes/vab.js _computeCandidate()` raycasts the parent mesh and `_surfaceNormal()` returns the raw hit
  face normal for non-revolution parts (noted as a known limitation in notes/vab.md), so any face of the 0.2 × 0.35 × 0.7 m
  box is a valid attach surface.
* Fix: when the parent is a radial decoupler (`pdef.modules.decoupler?.radial` / `mesh.style === 'radial_decoupler'`),
  ignore the hit face: attach at the centre of its outer +X face (`surfacePointLocal(def, 0, 0)` already returns that
  point/normal) — KSP's radial decouplers have exactly one attach point. Reject (red) surface hits whose normal points
  back toward the vessel axis.

### MAJOR — Graphics "Quality" chosen in the Space Center never reaches the terrain — integration (+ shell)
* Repro (`pt_vab_6_quality.mjs`): Space Center → Settings → Low → Done → Launch Pad → Flea Hopper → Launch!
  Log: `after choosing Low {"setting":"low","stored":"low","planets":"high"}`, `in flight {"setting":"low","planets":"high","fx":"low"}`.
  Same in `pt_vab_2_sc_ui.mjs` (720 and 1080): `after Low … "planetsQ":"high"`. The only visible effect of Low in the
  space center is that bloom is switched off (while the Bloom toggle in the same dialog still shows ON).
* Root cause: the shared `PlanetSystem` is created once with the quality of that moment; only `flightScene.js`
  listens to `settings:changed` (`planets.setQuality`) and only while flying. `spaceCenter.js` only rebuilds bloom,
  and nobody syncs the quality when a scene is entered.
* Fix: in `FlightScene.enter` / `SpaceCenter.enter` / tracking enter call `planets.setQuality?.(game.settings.graphics)`
  (cheap no-op when equal), and add `graphics` handling to the space center's `settings:changed` listener. Show
  "Bloom (off on Low)" or disable the toggle when Low forces it off.

### MINOR — Engineer's Report does not catch boosters dropped at ignition — vab
* Repro (`pt_vab_5_edit.mjs` step h): drag the "Radial Decoupler ×2" chip into the Launch stage (the classic KSP mistake).
  Staging: `3: Reliant, Hammer ×2, Radial Decoupler ×2 — 1,447 m/s TWR 1.98`; the ΔV already assumes the boosters fall off
  at launch, yet the report says "NOMINAL — All systems nominal". Evidence `shots/pt_vab_edit720_11_after_stagedrag.png`;
  node repro `node tests/playtest/pt_vab_engineer_staging.mjs` → `validateCraft {"ok":true,"errors":[],"warnings":[]}`
  with S3 TWR 1.98 (boosters already gone).
* Fix (`src/game/craft.js validateCraft`): for every decoupler in stage s, if the piece it separates contains an engine
  with stage ≥ s (ignites in the same or an earlier stage), warn "Boosters are jettisoned the moment they ignite".
  Also worth adding: decoupler staged before the engine above it ignites, engines of a separated piece never ignite.

### MINOR — ΔV credited to the wrong stage when radial decouplers hold nothing — vab (deltav.js)
* Repro: `node tests/playtest/pt_vab_deltav_empty_decouplers.mjs` → with the boosters removed and the decouplers left in
  stage 2: `S3: 0 m/s 0 s | S2: 1447 m/s 51 s`. In the VAB this is what the staging panel shows while you carry the
  boosters (`shots/pt_vab_edit720_08_carry_booster.png`: Launch stage has no ΔV, "Stage 2" radial decouplers 1,447 m/s)
  and it persists with custom staging. The flight HUD uses the same function.
* Root cause: `src/game/deltav.js nextStageDropsOnlySpent()` counts the radial decouplers themselves as "dropped parts
  without burning engines", so the launch stage ends at t = 0.
* Fix: ignore decoupler parts (or parts without engines/tanks) when deciding `dropped`; require at least one dead engine
  or empty tank among the dropped parts.

### MINOR — "Aerodynamics" category tab label is clipped ("ERODYNAMIC") — vab
* Evidence: `shots/pt_vab_scui720_8_vab_first.png` (crop of the left rail), every VAB shot at 720 and 1080.
* `src/scenes/vab/ui.js` uses `c.name.split(' ')[0]` = "Aerodynamics" in a ~58 px rail. Use a short label map
  (`aero → 'Aero'`) or `font-size`/`letter-spacing` shrink + `text-overflow: ellipsis`.

### MINOR — Flight HUD staging ΔV disagrees with the VAB (every stage at sea level) — hud
* VAB: 1,200 / 855 / 1,725 m/s vac, total 3,779. On the pad the HUD staging stack shows 1,041 / 732 / 1,352, Σ 3,126
  (`shots/pt_vab_launch_04_pad.png`): the upper stage, which only fires in vacuum, is shown with its sea-level ΔV.
  Numbers are internally consistent (current pressure) but a player comparing VAB and pad thinks 650 m/s vanished.
* Fix: label it ("ASL") and/or show vac for stages that will fire above the atmosphere, or add the VAB's vac/ASL toggle.

### MINOR — Orbit panel shows nonsense on the pad — hud
* `shots/pt_vab_launch_04_pad.png`, `shots/pt_vab_quality_flight_low.png`: PRE-LAUNCH vessel shows Inclination 0.10°,
  Eccentricity 0.9948, TWR 0.00 / 0.00 (the VAB said 3.44). Show "—" for orbital elements while LANDED/PRELAUNCH and the
  launch-stage max TWR before ignition.

### POLISH
* **VAB key-hint bar unreadable** over the white/yellow platform (`shots/pt_vab_scui720_8_vab_first.png`, bottom): white
  12 px text with only a text-shadow. Give `.vab-hints` a translucent dark pill (`src/ui/vab.css`).
* **Engineer's Report says "NOMINAL" (green) for an empty hangar** (`pt_vab_build720_00_empty.png`). Use a neutral state.
* **Stats pill "LAUNCH TWR" wraps to two lines** once it has a value at 1280×720 (`pt_vab_build720_05_decoupler_snap.png`)
  — `.vab-stat-k` needs `white-space: nowrap`. Burn time "1m 02s" wraps on its own line in stage cards (Big Bertha,
  `pt_vab_edit720_19_stock_bertha.png`).
* **Staging panel at 720p shows only 3½ stages** of a 4-stage rocket (stage 0 cut, needs scrolling) —
  `pt_vab_build720_12_built.png`. Stage cards are ~100 px tall; a compact mode would help.
* **Carried-part rotation keys**: Q/E rotate about the vessel vertical, so two presses of E turn a fin's span from
  outward `[1,0,0]` to `[-1,0,0]` — straight into the tank — and it still snaps green (`pt_vab_7_misc.mjs` log).
  KSP players expect Q/E to roll about the surface normal for radial parts.
* **Staging panel keeps stale stages while carrying a picked-up subtree** (see the ΔV item above).
* **Help → Vehicle Assembly section** lists only Click / Right-drag / Wheel (`pt_vab_scui720_6_help.png`); missing X/Shift+X
  symmetry, C snap, WASDQE, Alt+click copy, Del, Ctrl+Z/Y, F, Shift+wheel (`src/ui/menus.js openHelp`).
* **Space center framing**: at 1280×720 the drifting camera parks the Tracking Station under the dock (hovering its
  projected hitbox centre lands on the dock's Astronaut Complex button, `pt_vab_scui720_1_hover_tracking.png`,
  label dot inside the dock in `pt_vab_scui720_5d_bloom_on_high.png`); the Astronaut Complex is hidden behind the VAB
  (its hitbox centre picks the VAB at both 720 and 1080); at 1080p the whole KSC is a small cluster in the middle of
  the screen (`pt_vab_sc1080_1_overview.png`). Labels also slide 100+ px for ~1 s after a dialog closes (camera swoops
  back) so a quick click on a label misses (`pt_vab_8_sc_labels.mjs`: Launch Pad label click opened nothing).
* **Launch Pad dialog**: ΔV tile "7,424 m/s" wraps; the dialog re-centres vertically (jumps ~10 px) when you select
  crafts with longer descriptions (`pt_vab_scui720_2_pad_dialog.png` vs `…2b_pad_lune.png`).
* **Astronaut Complex**: Zeb and Nova share the same flavour line "Cool as a cucumber in a centrifuge."
  (`pt_vab_scui720_4_astronaut.png`). Part popup cost "800" has no unit.

## Verified OK
Stack snapping (46 px), node markers (green free / yellow target / cyan held), hoist onto the platform, fins ×4 outward
and at 45° diagonals, radial decouplers ×2 outward, Alt+click copy of a 4-fin group (8 fins, undo → 4, redo → 8,
Ctrl+Shift+Z, Cmd+Z, toolbar buttons + disabled states), Delete on hover removes the symmetry group, click-pick with
subtree + Esc restores, right-click popup (fuel slider, stage ±), staging drag + "Auto" reset, Engineer collapse,
rename + Ctrl+S/Save, New (clean → no prompt, dirty → "Unsaved changes"), Load saved (identical up to 1e-15 float noise),
Load stock (Big Bertha 40 parts), pre-launch report (no chute → "Launch anyway"), VAB → flight part transforms,
staging order in flight, booster separation, Exit → Space Center → VAB keeps the craft (17/17 parts, 1080p run).
Space-center UI after returning from the VAB fades back in (opacity 0 → 1 within 3 s, `pt_vab_10_sc_return.mjs`).
Zero console errors / page errors in every run.

## "Make it amazing" ideas
1. **KSP-grade radial building (vab)** — symmetry inherited from the parent, one fixed centred attach point on radial
   decouplers, a red ghost + "clipping" warning when a part intersects another. This is the #1 thing a KSP player will hit.
2. **An Engineer who actually engineers (vab)** — staging sanity checks (boosters jettisoned at ignition, decoupler fires
   before the engine above lights, stage with no engine after separation, chute not last, upper-stage vacuum TWR < 0.5,
   fins/CoL behind CoM), each item clickable to highlight the offending parts, plus a one-click "Fix staging".
3. **Guided first rocket (vab)** — the space center has tutorial hints but the VAB has none beyond the empty state:
   a 5-step checklist (pod → chute → tank → engine → Launch) that glows the next part card and the target node.
4. **Staging preview (vab)** — hover a stage card: engines that ignite flare, parts that separate drift away as ghosts;
   show the per-stage ΔV the stage will really get (ASL for the launch stage, vacuum for stages above ~25 km).
5. **Same ΔV language in VAB and flight (hud)** — VAB vac/ASL numbers and the flight staging stack disagree on the pad
   (3,779 vs 3,126 m/s); add the VAB's vac/ASL/current toggle to the flight stack and "—" orbital elements while landed.
6. **Roll-out moment (shell)** — after Launch in the VAB, a 3-second crawler roll-out from the open VAB door to the pad
   (the KSC model already has both), and a rotating 3D preview of the selected craft in the Launch Pad dialog.
