# Playtest — "return" (deorbit → reentry → chutes → touchdown → recovery; crashes & reverts)

Tester: KSP-veteran playtest pass, 2026-09-23. Headless SwiftShader (1600×900), machine heavily loaded (load avg 80–190),
so everything was driven with `TSP.flightScene.fastForward` and screenshots taken after letting frames render.
All screenshots below were looked at. Console: **zero errors / warnings** in every run (`TSP.app.errors` empty).

## Scripts (tests/playtest/)
| Script | What it does |
|---|---|
| `pt_return_reentry.mjs` | Orbiter I → `TSP.physics.orbit('verda',100000)` → stage down to the Terrier stage → T + HUD retrograde → Z burn until Pe < `PT_PE` → jettison → rails coast → reentry sampled every 1.5 s (alt, speed, q, g, temps, ablator, AoA, sheath, HUD gauges) + shots at 60/45/35/28/22 km + close side/front views → chute → touchdown → HUD Recover → results → space center. Env: `PT_SAS=retrograde|off`, `PT_PE`, `PT_TAG`. |
| `pt_return_heat.mjs` | Bare capsule put at orbital speed at 42 km → 2 min of full plasma; logs part temps and which parts actually show the heat overlay; close-ups. |
| `pt_return_land.mjs` | Bare capsule dropped at 6 km/−150 m/s by `TSP.physics.drop` → chute → touchdown → Recover → Space Center → Mission Control. `PT_MODE=land` (Forests), `sea` (Seas, daylight), `crashland` (no chute). Probes where the canopy is in camera NDC. |
| `pt_return_flea_crash.mjs` | Flea Hopper hop to 9 km, decouple, **no chute** → impact on the pad → results → Space Center → Astronaut Complex memorial (`PT_CRASH_NEXT=revert` reverts instead). |
| `pt_return_topple.mjs` | Botched launch (full pitch-down + yaw from the tower, SAS off) → crash next to the pad → results → Revert to Launch → Revert to VAB, roster checked at each step. |
| `pt_return_pad_chaos.mjs` | Stage everything at once on the pad, pause → Revert to Launch, (debug) topple attempt, Revert to VAB. |
| `pt_return_hudcheck.mjs` | HEAT gauge at ambient temperature; staging-stack ΔV vs telemetry. |

Run: `node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 --script tests/playtest/<script> --out shots/pt_return_x.png`
(flea: `craft=flea_hopper`). Harness gotcha: key presses are only consumed by a *rendered* frame — `fastForward` does not
read input — so always `waitFor` the effect (stage number, throttle) before fast-forwarding.

## What works well
* Deorbit flow: HUD retrograde SAS aligns to 0.99999, burn/Pe readouts, "in atmo"/"impact" flags, jettison puff.
* **Plasma sheath** (`pt_return_07_reentry_45km/35km`, `_r2_07c_reentry_close_front`, `_heat_10/18/30_close`): gorgeous, correctly
  oriented against the airflow (bow on the shield side, flame tongues + sparks trailing), fades with Mach.
* Capsule aerodynamic stability: with SAS **off** the capsule entering at 70–75° AoA weathervanes to shield-first by ~64 km
  and holds 0–7° AoA (`pt_return_sasoff_*`). Ablator 200 → 116–124 for LEO returns; pod ≤ 670 K.
* Chute sequencing (armed → semi at <300 m/s → full at 1 km, reefed opening ≤ ~5 g), cut 2–3 s after touchdown, daylight
  canopy looks great when you zoom out (`pt_return_sea_04b_chute_full_wide.png`).
* Splashdown / landing situations, Recover button, "Welcome Home!" report (recovered value 13–98 % by distance), milestones
  (Chute Happens, Splashdown, Reentry Survivor, Welcome Home), roster back to *available*, Mission Control recoveries.
* Crash → crew K.I.A. chip, "Rapid Unplanned Disassembly" report, memorial entry "Lithobraked on Verda · Flea Hopper · Y1 D1 00:01:34".
* Revert to Launch / Revert to VAB restore vessel, UT, crew assignment and memorial exactly (`pt_return_topple` roster log).

## Bugs (most severe first)
1. **MAJOR · integration — camera ends up at/under the ground after the active vessel is destroyed; the explosion is never framed.**
   Flea on the pad: camera below the terrain showing chunk skirts and the underside of the pad (`pt_return_crash_02_impact`,
   `_03_explosion`, `_04_aftermath`, `_05_results`). Capsule crash in the Forests: screen fully green (`pt_return_crashland_04_aftermath`,
   cam 1.18 m above the anchor, 6.6 m away). Botched launch: camera in the grass, fireball off-screen right (`pt_return_topple_02/03/04`).
   fx stats prove the explosion exists (784–7000 smoke particles, shards). Cause: `flightScene._frame` passes
   `cp.radarAltitude = anchor.destroyed ? null : …`, which disables the FlightCamera ground clamp *and* the pitch clamp
   (`cameraController._clampPitch` → lo = −1.53), while the anchor (last CoM) is itself at/below the surface after a 240 m/s
   impact (≈5 m per 0.02 s step); explosion particles also inherit the ~100 m/s vessel velocity and leave the frame.
   Fix: when the anchor is destroyed compute radar altitude from `terrain.surfaceHeight` at the anchor direction (keep the
   clamp), lift the orbit target to ground + 2 m, and on `_onActiveDestroyed` pull back (`cam.reset({distance: max(35, 8R), pitch: 0.35})`)
   / track the explosion centroid; consider damping inherited velocity of fireball particles in `effects._onDestroyed`.
2. **MAJOR · parts3d — heat glow never appears on a heat-shielded capsule.** `vesselRenderer._updateHeat` only glows above
   `temp/maxTemp > 0.5`. Heat shield maxTemp 3300 K peaks at 1246–1261 K in real LEO returns (ratio 0.38), pod 424–666 K/2400.
   `pt_return_heat.mjs`: 2 min at full plasma (reentryIntensity 1.0), overlays `-` on every part every sample
   (`pt_return_heat_04/10/18/30_close.png` — brown honeycomb, no glow). Fix: drive the glow by absolute temperature too,
   e.g. `target = max((ratio−0.5)/0.5, smoothstep(750, 1700, part.temp))` (Draper point ~800 K), weighted windward as now.
3. **MAJOR · integration — deployed canopy is always off-screen in the default camera.** Canopy probe (sea run): canopy centre at
   NDC y = 2.98 (off-screen) with the auto camera at 6.6 m (boundingRadius 0.98 m); only the risers are visible
   (`pt_return_land_03_chute_opening`, `_04_chute_full`, `_05_chute_low`, `_r2_10_chute_full`, `pt_return_land_02_chute_semi`).
   Pulled back to 45 m it is on-screen and beautiful (`pt_return_sea_04b_chute_full_wide`). Fix: in `flightScene._vesselRadius`
   (camera `vesselSize`) include semi/deployed canopies (≈ canopyDiameter + riser length), so the FlightCamera's min distance
   pushes out automatically, and aim between capsule and canopy.
4. **MINOR · physics — capsule is far too "dense"; reentry and chute loads feel wrong.** Blunt face uses `dragCd 0.3` of the
   heat shield/pod bottom (`dynamics.js` blunt-face branch). Mk1+shield terminal velocity at sea level 221–249 m/s
   (`pt_return_crashland` descent log 249→245 m/s; flea pod 240 m/s); peak deceleration only 2.6–2.7 g at 13–15 km (samples in
   `pt_return_reentry` output); the **semi-chute opening (5.3–5.8 g) is the highest g of the whole return**. Real/KSP capsules
   have Cd ≈ 1.1–1.3 on the blunt side → ~100–130 m/s terminal and higher-altitude, stronger deceleration. Fix: blunt-face Cd ≈ 1.2.
5. **MINOR · integration (parts.js stats) — splashdown/landing speed 7.6–7.8 m/s**, above the 6–7 m/s target (sea 7.63, land 7.74,
   r2 ≈7.5 at 1.20–1.28 t). The physics test's 6.72 m/s is without the heat shield. Fix: `chute_mk16.fullArea` 350 → ~480.
6. **MINOR · hud — HEAT gauge reads 21 % at room temperature** (pad, orbit, everywhere): `heatRatio` = 288 K / 1400 K (chute).
   During the hottest part of reentry it only reaches 24–38 %. Map it from ambient: `(T − T_amb)/(maxTemp − T_amb)`.
   Evidence: `pt_return_hudcheck` (`heatGauge "21%"`, hottest chute 288/1400), every flight screenshot.
7. **MINOR · hud — "CHUTE UNSAFE" alert while a correctly semi-deployed chute is fine.** Hard-coded `surfaceSpeed > 250` vs the
   part's `safeSpeed` 300 (`_updateAlerts`). `pt_return_sasoff_09_chute_semi.png`: semi at 278 m/s, alert on, chute later
   opened fine. Use `def.modules.parachute.safeSpeed`, warn only for `armed` chutes or when near `deployAltitude` above safeSpeed.
8. **MINOR · shell — Mission Control "Crashes" never increments for normal crashes.** The pod dies first, the vessel is re-ranked
   `type='debris'`, and `missions.js` ignores `vessel:destroyed` for debris. Repro (node): `Vessel.fromCraft(flea)`,
   `destroyParts([pod])` → type `debris` → `vessel:destroyed` with type `debris`. Topple run: stats `crashes: 0` after a crew-killing crash.
   Fix: count crashes on the flight scene's `_onActiveDestroyed`, or remember "was a ship" on the vessel (`history.launchUT`/crew cache).
9. **MINOR · integration/shell — Revert keeps the reverted flight's progress** (milestones like "Rapid Unplanned Disassembly",
   launch count): pad run B2 milestones still include `rud` after Revert to Launch. Snapshot/restore `game.progress` with the revert.
10. **MINOR · physics — vessels interpenetrate; "stage everything on the pad" drops the capsule *through* the lower stage.**
    Events: dec1 fires at 0.5 s → Terrier/T400/decoupler/heat shield destroyed by impact 1.8–2.0 s → pod ends up on the pad
    embedded in the standing lower stage's engine (`pt_return_pad_A3_all_staged_10s.png`). Known "no vessel–vessel collisions";
    a cheap proxy (per-part spheres between loaded vessels < 50 m apart) would fix the most visible cases.
11. **MINOR · physics — capsule never cools after reentry**: pod 605–618 K and chute canister ~634 K after 200 s of chute descent
    and while floating in the ocean (heat 0.45–0.53 in `pt_return_reentry` r2/SAS-off chute logs); the HEAT gauge sits amber for
    minutes after splashdown. Wake cooling (`THERMAL.WAKE` 0.004) is tuned for plasma shielding; add a subsonic wake/natural
    convection floor and water quenching when SPLASHED.
12. **MINOR · worlds/integration — night-side reentry and chute descent are pitch black**: capsule invisible at 11.8 km
    (`pt_return_08_portraits_reentry.png`), only a tiny dark shape under the chute (`pt_return_r2_09_chute_semi`, `_r2_10_chute_full`).
    Add a faint moon/sky fill for vessels at night or a camera-relative rim light.
13. **POLISH · integration — tutorial hints linger after the vessel is destroyed/recovered** ("Coming home — stage your parachute"
    next to the RUD report: `pt_return_crash_05_results`, `pt_return_topple_05_results`; "Touchdown!" behind the recovery report).
    `hints.update` returns early for destroyed/missing vessels without retiring the current hint.
14. **POLISH · integration — Time-warp hint shows bare punctuation keys** ("Press . to speed time up and , to slow it down (/ stops
    warp)") — unreadable (`pt_return_01_orbit.png`). Use `<kbd>` chips / "the . (period) key".
15. **POLISH · hud — after a successful recovery the HUD shows red "NO SIGNAL" / "Vessel lost" styling** behind the Welcome Home
    report (`pt_return_land_08_results`, `pt_return_r2_14_results`). Fade the HUD out instead.
16. **POLISH · fx — splash mist puffs are hard-clipped by the sea surface** (straight horizontal edges, grey smoke look):
    `pt_return_sea_07_touchdown_orbit.png`, `pt_return_r2_12_touchdown.png`. Soft-particle fade near the water plane / spawn
    above it, whiter spray.
17. **POLISH · parts3d — vacuum Terrier plume at 100 % is a faint grey haze** during the deorbit burn
    (`pt_return_03_deorbit_burn`, `pt_return_r2_03_deorbit_burn`).
18. **POLISH · shell — results dialog: "Keep watching" wraps onto its own row** (4 buttons) — `pt_return_crash_05_results`.

## "Make it amazing" ideas
* Reentry drama (fx/hud): radio-blackout static on crew portraits, crew reacts to reentry (white-knuckle face, shaking), ablator
  char darkening on the shield + ablation smoke, capsule-cam view through the window with plasma.
* Parachute moment (integration/fx/audio): auto-frame the canopy on deploy, "whump" + canopy flutter sound, short slow-mo.
* Crash cinematics (integration/fx): 0.3× slow-mo + orbit around the fireball, then settle on the wreckage; report the cause
  ("Lithobraked at 245 m/s") and impact speed in the results.
* Richer mission report (shell): flight timeline (liftoff, orbit, peak heat, peak g, splashdown), distance from KSC,
  ablator used, max temperature, milestones earned this flight.
* Splashdown recovery flourish (fx/shell): flotation bag inflation, dye marker, recovery helicopter/boat flyby, crew waving.
* Night visibility (parts3d): capsule strobe/beacon + window glow so night returns are readable and pretty.
