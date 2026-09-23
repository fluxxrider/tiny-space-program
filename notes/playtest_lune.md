# Playtest: "lune" (the flagship mission)

Tester: KSP-veteran playtest pass on the whole Lune round trip with `lune_lander`. Everything was driven through the
real game page with `tools/snap.mjs` (SwiftShader, 1280×720). Screenshots are `shots/pt_lune_*.png`, scripts
`tests/playtest/pt_lune_*.mjs`, and the live progress logs `shots/pt_lune_progress*.log`.

## What I did

1. **Ascent (real, not teleported).** I launched `lune_lander` from the pad: Z, then Space, then a scripted gravity turn
   using SAS `direction` and staging on flameout. I cut the engine at Ap 90 km and circularised at apoapsis. Result:
   a 148 × 88 km orbit at T+4:30, with 1,014 m/s left in the transfer stage and 3,053 m/s in the lander.
   Script: `pt_lune_1_ascent.mjs`.
   * The universe is saved to `tests/playtest/pt_lune_save_*.mjs`. Every later phase injects the previous phase's save
     into `tsp.persistent` and starts from the Tracking Station, then presses "Fly". That exercises Fly every time.
     Loader: `pt_lune_common2.mjs`.
2. **Tracking Station → Fly** (real click) → M → **right-click Lune → "Set as target"** (real clicks) → click the orbit line
   → "+ Add maneuver" → "Orbit ⏭" → retime to the 110° phase angle → **drag the prograde handle with the real mouse**
   until "→ Lune encounter" appears (797 m/s). I then refined by typing into the prograde field: 812.8 m/s gives a Lune
   Pe of 43 km. Scripts: `pt_lune_2_plan.mjs`, `pt_lune_3_transfer.mjs`.
3. **HUD "Warp to burn"** → SAS maneuver (HUD button) → burn at the cue with Z/X while watching the remaining Δv.
   Scripts: `pt_lune_3_transfer.mjs`, `pt_lune_4*.mjs`.
4. **Coast.** Delete the node, rails warp with ".", then cross the SOI (toast, milestone, patches), warp to Pe, SAS
   retrograde, and the capture burn, staging on flameout. Result: a 450 × 424 km Lune orbit. Script: `pt_lune_5_coast.mjs`.
5. **Landing.** Deorbit, suicide burn, gear (G) at 3 km, touchdown at 1.2 m/s, then milestones and a surface photo tour.
   Script: `pt_lune_6_land.mjs`.
   * The lander tipped over (see bug 2). So I also placed it on a flat site with `TSP.physics.drop` to test the sky,
     takeoff and return. Script: `pt_lune_8_site_return.mjs`.
6. **Verda in Lune's sky** at several phases (`pt_lune_9/12`), takeoff to a 28 × 15 km orbit, and a return node
   (Lune escape → Verda Pe 34 km). Then aerocapture, a second pass, chute, touchdown, the "There and Back Again"
   milestone, and **Recover → "Welcome Home!"**. Script: `pt_lune_11_home.mjs`.

No console errors or `TSP.app.errors` came up in any phase.

## Bugs (most severe first)

### 1. MAJOR · physics — "Warp to burn" / warpTo freezes game time on ordinary parking orbits

**What happens.** A vessel in the stock-ascent parking orbit (148 × 88 km) is warping to its transfer node. When it
descends through 120 km (Verda's 100× limit), game time stops. The warp bar keeps showing "50× RAILS", the altimeter
sits on exactly 120 000 m, and nothing moves until the player presses "/".

**Evidence.**
* Real frames: `pt_lune_4d_warpfreeze_realframes.mjs` → `shots/pt_lune_4d_frozen_warp.png`. UT stayed at 1625.74 for
  85 s of wall time while app time kept advancing.
* Node repro: `node tests/playtest/pt_lune_warpstall.mjs` → "BUG: game time frozen".
* Frequency: `node tests/playtest/pt_lune_warpstall_stats.mjs` → **20 of 40** random 75–115 × 125–375 km orbits froze,
  at 120 km or 240 km.

**Root cause** (`src/physics/flight.js`).
* `_railsUpdate` stops the step at the crossing and drops the index when `alt <= limit + 1` (line 484).
* On the next frame `_autoWarp` asks for a higher rate again (line 265). `setWarp` allows the higher level because
  `alt < limit` is false at `alt == limit` (line 211).
* `nextRadiusCrossing` then returns `ut` itself, so zero time passes, and the cycle repeats forever.

**Fix.**
* Use the same threshold in `setWarp` (`alt <= limit + 1`), or add a margin while descending.
* Ignore crossings with `tc <= ut + ε`.

### 2. MAJOR · vab (stock craft) + physics — the stock lune_lander tips over after perfect touchdowns on ordinary slopes

**What happens.** The playtest landing touched down at 1.2 m/s vertical, 0 horizontal, SAS on, on a 13.6° slope, and
ended lying on its side (tilt 92.5° and 35.7° → falling in the two runs; `shots/pt_lune_6_landed_hud.png`). A lander
on its side cannot take off, so the crew is stranded.

**Drop test.** `node tests/playtest/pt_lune_droptest.mjs`: 27 purely vertical drops at 1–3 m/s with SAS re-captured.
* Every site of 12° or more tips over (final tilt 86–106°).
* Sites of 8–11° end up 10–19° tilted.

**How common.** `pt_lune_slopes.mjs`: 15.5 % of Lune's surface is steeper than 12° at the leg footprint scale.

**Geometry.** `pt_lune_legs_geom.mjs`:
* Deployed feet sit only 1.175 m from the axis and just 0.225 m below the Terrier nozzle.
* The CoM is 3.64 m above the feet, so the static tip angle is 17.9°.

**Fix.**
* A wider stance: `legs_lt1.footDeployed` [0.55, −1.45, 0] → ~[1.0, −1.6, 0], or mount the legs lower and further out
  in `stockCrafts.js`.
* Optionally let SAS level the vessel on contact, and add a HUD slope warning.

### 3. MAJOR · map — the map shows flat single-colour planets after visiting the Tracking Station (or any second MapView)

**What happens.** Tracking Station (bakes finish) → Fly → M: every body keeps `texLevel −1`. Verda is a flat blue ball
and Lune a flat grey one: `shots/pt_lune_14_flight_map_after_tracking.png` and `pt_lune_14_mapbake.mjs`
(texLevels logged for 15 s).

**Root cause.** `MapView._updateBodyTextures()` (mapView.js:1065) is only called when a new bake job finishes
(line 1086). A new MapView whose wanted bakes are already in the module-level `BAKES` cache never applies them.

**Fix.** Call `_updateBodyTextures()` in `enter()`, or every frame while any `b.texLevel < BAKES.get(id).level`.

### 4. MAJOR · integration (hints) — first-flight tips cover the HUD maneuver panel and give the wrong advice in orbit

**What happens.** After Fly from the Tracking Station, the "Map view" hint ("cut the engine once Ap reaches about 80 km")
and the "Time warp" hint ("burn until your periapsis leaves the atmosphere") pop up while the ship is already in a
stable orbit planning a transfer. The cards stack exactly over the HUD Maneuver panel.

**Evidence.**
* The "Warp to burn" button is covered: `elementFromPoint` returns `.sh-hint-actions`, and a real click does nothing
  (`pt_lune_4_warpto.mjs`, `shots/pt_lune_4_hint_over_node_panel.png`, `pt_lune_3_hud_node_panel.png`,
  `pt_lune_3_burning.png`).
* The hint conditions in `src/scenes/flight/hints.js` (flight_map / flight_warp) don't check that the vessel is still
  ascending.

**Fix.**
* Require a SUB_ORBITAL/FLYING ascent (for example Pe < atmosphere height) for these hints.
* Move `#sh-hints` in flight (flight.css) so it avoids the orbit/maneuver panels.

### 5. MINOR · shell — the Tracking Station tip leaks into the flight scene

If Fly is pressed within 0.9 s of entering the Tracking Station, the "Tracking Station" card appears on top of the
flight HUD (`shots/pt_lune_4_hint_over_node_panel.png`, second card).

**Cause.** `showTutorialHint(..., {delay: 900})` in tracking.js:69 uses a `setTimeout` (menus.js:382) that is never
cancelled on scene exit.

**Fix.** Keep the returned `dismiss(false)` and call it in `exit()`.

### 6. MINOR · map — mouse-wheel zoom silently edits the maneuver when the cursor is over a gizmo handle

**What happens.** Six wheel ticks at the handle position changed `normal` 0 → −6 m/s. The camera did not zoom and the
Lune Pe changed (`pt_lune_15_wheel_handle.mjs`).

This also happened by accident in `pt_lune_3_transfer.mjs`: zooming out for a screenshot left the transfer node with
`normal −7`.

**Cause.** `_onHandleWheel` (mapView.js:1713).

**Fix.** Require a hover dwell or a modifier, and show a "+1 m/s Normal" flash.

### 7. MINOR · map — the DN marker label is invisible

The text is `rgb(7,16,28)` on a `rgba(8,14,26,.92)` background. `.mk-dn .mk-icon` (map.css:68) sets a dark
background but not `color: var(--c)`.

**Evidence.** `pt_lune_17_misc.mjs`, `shots/pt_lune_crop_dn_marker.png` (from `pt_lune_6_map_lune_orbit.png`).

### 8. MINOR · map — "Closest approach · Lune 2.430 Mm" is shown while you are already inside Lune's SOI

**What happens.** With Lune targeted, after the SOI change the CA marker is computed on the Verda patch after SOI exit,
so it shows the SOI radius (`shots/pt_lune_5_map_in_lune_soi.png`).

**Fix.** Skip the CA when `v.bodyId === tgt.id` (mapView.js:2273), or clear the target on entering its SOI, as KSP does.

### 9. MINOR · integration + hud — the SOI-change announcement is shown three times and overlaps itself

On entering Lune's SOI there is:
* the milestone toast,
* an "Entering Lune's sphere of influence" toast (flightScene.js:361),
* the same text as the HUD big message.

The HUD message is hidden behind the toasts; only "ENT…NCE" peeks out (`shots/pt_lune_5_map_soi_change.png`).

**Fix.** Drop the flightScene toast, or offset the HUD message.

### 10. MINOR · hud — the burn cue flips back to "Burn now!" after a node is complete, and SAS maneuver spins the ship 180°

**What happens.**
* A 3.2 m/s overshoot on an 813 m/s burn shows "Node complete".
* At a 4.6 m/s overshoot the cue shows "BURN NOW! · 4.6 M/S" again (`shots/pt_lune_3_burn_done.png`).
* The maneuver vector reverses, and SAS starts a 174° flip (burn trace in `pt_lune_3_transfer.mjs`).

**Cause.** `done` is recomputed each tick as `remaining < dv0·0.004` (hud.js:1150).

**Fix.**
* Latch "done" until the node is edited.
* Have SAS hold attitude when the remaining vector is small and more than 90° from the nose.

### 11. MINOR · missions — a jettisoned stage burning up awards "Rapid Unplanned Disassembly" + "Too Hot to Handle"

During the flawless return, the discarded lander stage (debris) burned up and fired both milestones
(`shots/pt_lune_progress_11.log`).

**Cause.** The `part:destroyed` handler (missions.js:239) doesn't skip debris for rud/too_hot, although it does for
lithobraking.

### 12. MINOR · fx — the flameout effect spawns grey billowing smoke clouds in vacuum

**What happens.** Grey puffs float around the ship at the Swivel flameout, 425 km above Lune
(`shots/pt_lune_5_capture_flameout.png`).

**Cause.** `_flameout` (effects.js:1666) only halves the opacity when `dens < 0.002`, whereas `_ignite` returns early.

Related: the Lune touchdown/takeoff "dust" also reads as cotton-ball smoke hanging above the ground
(`shots/pt_lune_16_vac_plume_30.png`, `pt_lune_17_plume_side_low.png`).

### 13. POLISH · map — the node panel Δv wraps "m/s" to a second line at 1,000 m/s or more

See `shots/pt_lune_2_map_dragging.png` ("1,309.0 / m/s"). The first grid column (`.mn-summary`) is too narrow.

### 14. POLISH · hud — TWR uses local gravity: "TWR 0.00 / 2,026.93" at Lune's SOI edge, "54.00" in Lune orbit

See `shots/pt_lune_5_flight_lune_soi.png` and `pt_lune_6_lune_from_orbit.png`. Show the TWR against the current body's
**surface** gravity (what a lander pilot needs).

### 15. POLISH · hud — clicking Surface/Orbit on the speed display doesn't change what SAS prograde/retrograde follows

The HUD never calls `setControl('navMode')` (physics integration note 8). Measured: HUD 'surface', vessel navMode 'auto',
telemetry 'orbit' at 27 km over Lune. The difference is ≤ 1° on Lune, but the marker you see isn't what SAS holds.

### 16. POLISH · worlds — Lune ground and distant Verda look low-res at the moments that matter most

* The terrain near the lander is smeared or blocky under grazing light (`shots/pt_lune_crop_grazing_terrain.png`,
  `pt_lune_6_surface_high.png`).
* Verda in Lune's sky (5.8° wide) shows a blocky 8–10 px cloud/continent texture (`pt_lune_crop_verda_halfphase.png`).
* The phases themselves are correct: a new-Verda solar eclipse, a half phase, and a gibbous phase
  (`pt_lune_crop_verda_*.png`). That is lovely.

## What works well

* The real ascent reaches orbit with the stock lune_lander, with the ΔV the VAB promises.
* Right-click targeting, closest approach, SOI rings and the encounter ghost all work.
* The encounter search reacts smoothly as Δv changes. The Lune Pe passes through "impact" to the other side, which is
  correct.
* The burn-time estimate (41 s) matches the real burn (≈42 s).
* SAS maneuver alignment takes about 2 s. The navball maneuver and target markers are correct.
* Warp stops exactly at the SOI change, with the milestone.
* The capture, and the flameout → "press SPACE to stage" hint.
* On landing, the "Touchdown on Lune" milestone appears.
* On the way home: Lune escape, aerocapture, chute, "There and Back Again", and a nice "Welcome Home!" report.
* Maneuver math is fast: 0.1 ms per edit in the browser (`pt_lune_10_nodeperf_browser.mjs`).

## Notes on method

* The coast and descent segments use `fastForward` because SwiftShader runs at about 10 fps. All interactions (map
  clicks, handle drags, the HUD buttons Fly, Warp to burn and SAS modes, and the keys M, G, Z, X, Space, ., /, F2)
  were real input.
* Balance observation, not filed as a bug: the 34 km-Pe Lune return skips out once (aerocapture to a 1,116 km Ap) and
  uses 100 % of the heat-shield ablator over two passes.
