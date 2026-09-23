# Playtest: "ascent" scenario (pad to orbit, Orbiter I and Big Bertha)

This is a KSP-veteran playtest of the launch, gravity turn, staging, coast and circularization loop. I flew it with real keys (Z, Space, T, W, X, `.`, `,`, `/`, M, V) and HUD clicks (the SAS prograde button, the navball speed readout). Every bug below was reproduced at least twice, either in two headless-browser runs or in one browser run plus the node physics harness.

- Screenshots: `shots/pt_ascent_*.png`
- Scripts: `tests/playtest/pt_ascent_*.mjs` (each file header has its run line)

## Verdict

The core loop works. Orbiter I reaches a stable orbit with a lazy "tap W to ~80°, then SAS prograde" ascent and has about 1,300 m/s left, so the rocket is not short on ΔV.

The ascent looks great:
- liftoff smoke and SRB trails
- a sky that fades from blue to black between 10 and 30 km
- a crisp atmosphere limb, visible planet curvature and a cloud deck
- plumes that widen in vacuum
- a working navball (markers, headings, prograde/normal/radial holds)
- physics warp in the air and rails warp above 70 km

Things that stop it from being amazing:
- Booster separation is violent and clips through the core.
- The in-flight ΔV readout contradicts the VAB and suggests Orbiter I cannot reach orbit.
- The HEAT gauge reads 20 %+ while cold.
- Big Bertha can burn off its own main parachute on the way up.
- A handful of HUD, warp and feel issues (listed below).

## Bugs

### 1. Boosters tumble at about 1,000°/s and swing through the core (major, physics)
**Repro:** `node tests/playtest/pt_ascent_node_sep.mjs orbiter_1 60 80`, and in the browser
`PT_YAW=0 PT_TIMES=0.05,0.15,0.22,0.28,0.34,0.45 PT_TAG=sep_o1_side node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --size 1600x900 --script tests/playtest/pt_ascent_sep.mjs`

**What happens:** Orbiter I's Hammers burn out at 6.8 km, Mach 2 and q = 81 kPa, which is exactly max-Q. In the browser (side-view run) after staging:

| Time after staging | Tilt | Spin |
|---|---|---|
| +0.05 s | 2° | 37°/s |
| +0.22 s | 26° | 325°/s |
| +0.28 s | 59° | 695°/s |
| +0.34 s | 118° | 1,078°/s |

At +0.28 s and +0.34 s a booster part's centre is 0.56 m and then 0.42 m from the core axis (core radius 0.66 m), so it is inside the core. The first browser run gave 0.18 m at +0.30 s.

**Visual:** in `pt_ascent_sep_o1_side_+0.28s.png` and `+0.34s.png` both boosters form a "V" whose nozzle ends pass through the core's engine and fins. The node run gives the same numbers: +0.3 s, tilt 85°, 951°/s, then 1,177°/s at +0.4 s.

**Root cause:**
- `_fireDecouplers` applies a small ejection impulse (about 6 m/s) at the decoupler, which is level with the booster's CoM, so there is no outward tip.
- Per-part aero forces act at part centres. A long empty SRB therefore gets essentially no pitch damping (`AERO.ANG_DAMP = 0.004/s`), while its nose cone's `K_NOSE` normal force makes it statically unstable.
- There are no vessel–vessel collisions, so the booster flips nose-in and passes through the core.

**Fix:**
- Add per-part aerodynamic rotational damping, with a C_mq-like term ∝ q·A_lat·L²·ω/v for long parts, in the `dynamics.js` aero loop.
- Give radial decouplers a top-out angular kick, like sepratrons: apply part of the impulse at the booster's top node, or add an angular impulse.
- Optionally fade aero torque in over about 0.3 s on freshly created debris.

### 2. Big Bertha burns off its own main parachute on a normal ascent (major, physics + parts data)
**Repro:** `node tests/playtest/pt_ascent_node_heat.mjs heavy_lifter 80 70`. This is full throttle, a W kick to 70° at 80 m/s, then SAS prograde.

**What happens:** `chute_xl` reaches 1,399/1,400 K at 39 km (Mach 7.1, q = 2.4 kPa) and is destroyed with `reason=heat`. The HUD shows HEAT 100 % and the Overheat alert. Only the two radial chutes are left for landing.

**In the browser** (`pt_ascent_hl_*`, with a gentler kick to 78°), HEAT reads 62 % at 31 km, 72 % at 40 km and 74 % at MECO (43.7 km). Big Bertha is so over-powered that the Kickbacks alone push Ap to 95–250 km, and Mach 6–7 at 30–40 km is unavoidable without throttling.

**Fix:** any of these:
- Raise parachute `maxTemp`. KSP chutes are about 2,500 K; here Mk16 and XL are 1,400.
- Make heating depend on exposure, so a nose chute on a capsule at AoA ≈ 0 gets less.
- Detune `heavy_lifter` (fewer Kickbacks, or partial solid fuel), and let the craft description suggest pitching over harder.

### 3. In-flight ΔV uses sea-level (current) Isp for every stage (major, physics; also HUD/VAB consistency)
**On the pad:**
- Orbiter I shows Σ 2,564 m/s. The Terrier upper stage shows 587 m/s at TWR 0.38.
- The VAB shows 4,725 m/s vacuum for the same craft, and 2,287 m/s for the Terrier stage.
- Big Bertha shows 4,023 m/s on the pad against 7,004 m/s vacuum.

The readout then "grows" during the climb, from 2,564 to 3,242 m/s at 26 km.

**Why it matters:** a player who knows orbit needs about 3,400 m/s is told Orbiter I cannot make it.

**Evidence:** `pt_ascent_pad_orbiter_1.png`, `tests/playtest/pt_ascent_pad.mjs` output, and `node` with `computeStageStats(…, {pressure:0})`.

**Cause:** `Vessel.stageStats()` computes every stage with `t.staticPressure`.

**Fix:** use the current pressure only for the stage that is burning now, or the first stage on the pad. Use vacuum Isp for later stages, or expose both and show "vac/ASL" like the VAB.

### 4. HEAT gauge reads 21–24 % when everything is cold (minor, HUD)
**Evidence:**
- Orbiter I on the pad: 21 % (heatRatio 0.206 = chute 288 K / 1,400 K).
- Big Bertha on the pad: 24 % (solar panels 288 / 1,200 K).
- In orbit with all parts at 288 K: still 21 % (`pt_ascent_orbitcheck`).
- During a normal Orbiter I ascent it hovers at 28–39 %.

**Cause:** `telemetry.heatRatio` is literally temp/maxTemp, and `hud.js _updateGauges` displays it as a percentage.

**Fix:** display (T − T_ref)/(maxTemp − T_ref) with T_ref ≈ 300 K or the part's ambient sink, clamped to ≥ 0, or add `heatFraction` to the telemetry.

### 5. Navball Surface/Orbit toggle does not change what SAS prograde holds (minor, HUD)
**Repro:** `pt_ascent_navwarp.mjs`. At 20 km, click the speed readout until it says ORBIT.
- The yellow prograde marker jumps to the orbital prograde.
- SAS "prograde" keeps holding surface prograde (`controls.navMode` stays `auto`).
- The nose then sits 8.7° away from the marker the player is following.

Also, the HUD auto-switches at 36 km (6 % of R) while the physics `autoNavMode` switches at 35 km (half the atmosphere).

**Fix:**
- In `FlightHUD.cycleSpeedMode()`, call `v.setControl('navMode', this.speedMode)`, and reset it to `'auto'` on the automatic switch.
- Reuse `autoNavMode` from `telemetry.js` for the HUD threshold.

### 6. `,` (warp down) just above 70 km speeds time up from 4× to 10× (minor, integration)
**Repro:** `pt_ascent_warpkeys.mjs` (also node `pt_ascent_node_warp.mjs`).

**Browser sequence:**
- `.` ×3 in the air gives 2×P, 3×P, 4×P. Correct.
- Coast past 70 km, still at 4× physics.
- `,` (slow down) gives 10× RAILS. Screenshot: `pt_ascent_warpkeys_after_comma.png`.

**Cause:** `flightScene._handleActions` passes `flight.warp.index − 1`, which is a physics-warp index, to `setWarp()`, and `setWarp()` treats it as a rails index. `.` from 4× physics above 70 km likewise jumps to 50× rails.

**Fix:** when `warp.mode === 'physics'`:
- `,` should call `setPhysicsWarp(i − 1)`.
- `.` should call `setPhysicsWarp` inside the atmosphere, or rails index 1 above it.

A physics-side `stepWarp(±1)` would keep the HUD chevrons consistent too.

### 7. Altimeter wheels sit half-rolled when the vessel is at rest (minor, HUD)
**Evidence:** Big Bertha on the pad reads "79.5 m", with the tens wheel between 7 and 8 and the ones wheel between 9 and 0.
- Screenshots: `pt_ascent_hl_01_pad.png` and `pt_ascent_pad_heavy_lifter.png`.
- Strip transforms are −7.54 em and −9.54 em while the altitude is constant at 79.512 m (`pt_ascent_pad.mjs`, `PT_CRAFT=heavy_lifter`).
- Pip Pathfinder (75.40 m) and Flea (71.36 m) are also partly rolled.

**Cause:** `Odometer.set` maps the fractional part 0.3–0.7 straight to a mid-roll position.

**Fix:** when |rate| is small, round to the nearest integer, or animate the roll over time instead of deriving it from the fraction.

### 8. Reentry plasma sheath shows on the way up (polish, fx)
Big Bertha at 30–44 km (Mach 5.5–6.4, q 0.8–6 kPa, even after MECO) is wrapped in a uniform glowing orange capsule-shaped shell around the whole stack. Screenshots: `pt_ascent_hl_07_sep_0.5s.png`, `pt_ascent_hl_09_sep_side.png`, `pt_ascent_hl_12_30km.png`, `pt_ascent_hl_14_meco.png`. It reads as a force field rather than ascent heating.

**Fix:** scale the sheath with actual convective flux, which is low at q ≈ 1 kPa. Concentrate it on the windward nose and let it stream aft.

### 9. Manual pitch is very twitchy, and Orbiter I is over-powered for a starter rocket (minor, physics/vab)
Holding W with SAS on at 50 m/s:

| W held | Pitch-over |
|---|---|
| 0.5 s | about 2° |
| 1.0 s | 24° (rate keeps growing at about 23°/s² until the key is released) |
| 2.0 s | 42°+, then a crash in prograde hold |

Sources: `pt_ascent_node_pitchrate.mjs` and `pt_ascent_node_sim.mjs` scans.

Releasing the key does not stop the swing. SAS only has the same torque to brake with, so the nose keeps turning about as far again.
- Big Bertha, W held for 3.5 s: released at 48° pitch, stopped at −2.6°, below the horizon, 4 s later (`node tests/playtest/pt_ascent_node_pitchrate.mjs heavy_lifter 3.5 60`).
- In the browser run, releasing W at 78° ended at 62° (`pt_ascent_hl`, post-kick step).

Orbiter I leaves the pad at TWR 3.1 and reaches TWR 5.5 and 5 g at SRB burnout, with max-Q about 80 kPa at 6 km. The tutorial hint suggests starting the turn after 1.5 km. At that point prograde hold drifts back to about 80° pitch, the rocket goes almost straight up (MECO at 25 km, 330 m/s horizontal) and needs about 1,700 m/s to circularize.

**Fix:** make manual input rate-commanded when SAS is on (for example, max 10–15°/s per axis). Tune Orbiter I to TWR ≈ 1.7–2, for example with less Hammer fuel or thrust. Start the turn hint at about 100 m/s.

### 10. Engine spool-down tail blocks rails warp for ~2.4 s and adds unwanted Δv after X (minor, physics)
- The first `.` after X gives "2× physics" plus "Cannot rails-warp while under thrust". The `pt_ascent_orbitcheck` warp sequence is 2×P, 10×R, 50×R.
- The same tail keeps pushing after the cut. `pt_ascent_quickorbit` cut the circularization burn at Ap 90.5 / Pe 72.7 km, and five seconds later the orbit was 94.2 × 77.1 km, roughly 4–9 m/s of extra Δv on a 3 t stage. The node physics shows the same thing: after cutting at Pe 72.3 km, the orbit 5 s later is Pe 76.9 / Ap 93.7 km, +7.2 m/s.
- **Cause:** liquid engines spool down exponentially (`spool` 0.35 s). `throttleEff` only snaps to 0 below 1e-3 (`dynamics.js` l.200–201), about 2.4 s after the cut. `FlightSim.setWarp` counts any `engine.thrust > 0` as thrusting.
- **Fix:** make the spool-down much faster than the spool-up (KSP liquid engines cut almost instantly), or snap to 0 below about 2 %. In `setWarp`, ignore engines whose commanded throttle is 0.

### 11. Land looks like shallow tropical water from 7–11 km (polish, worlds)
The aerial-perspective tint turns green land into turquoise. Screenshots: `pt_ascent_sep_o1_+0.10s.png`, `pt_ascent_o1_09_sep_side.png`, `pt_ascent_o1_11_10km_horizon.png`. The coastline is only readable by the beach line.

## "Make it amazing" ideas (ranked)
1. **Warp to Ap / Pe** (hud + map). Clicking the Ap/Pe chip in the orbit panel, or the map marker, warps to 30 s before it. Right now stopping rails warp near apoapsis is fiddly: at 50× a single frame is 5 s. It is the most common KSP action on every ascent.
2. **Circularize helper** (map). A one-click "circularize at Ap" node, plus a burn-cue pill. It pairs with the existing burn countdown and turns the hardest part for new players into a guided moment.
3. **Booster separation choreography** (physics + fx). Fix the tumbling (bug 1), then add a sepratron-style puff and an outward tip. Let spent boosters trail smoke as they fall away, with an optional 2 s "booster cam" picture-in-picture. This is the most cinematic moment of an ascent.
4. **Ascent guidance on the navball** (hud). A faint target-pitch caret (for example 90° at 0 km to 45° at 10 km to 10° at 40 km), and big Ap and time-to-Ap numbers during ascent. Pair it with rate-limited manual steering (bug 9) so the gravity turn feels deliberate, not twitchy.
5. **ΔV panel that tells the truth** (hud/physics). Show vac/current per stage, a "ΔV to orbit ≈ 3,400 m/s" marker line on the Σ bar, and TWR per stage. Players can then see that Orbiter I has margin.
6. **Flight milestones with sound and camera** (fx + audio + integration):
   - callouts for MAX-Q, SUPERSONIC (vapor cone + boom), MECO and "SPACE!" at 70 km (sky sting + star fade-in)
   - a short tower-cam shot for the first 4 s after liftoff, blending into the chase view
   - keep the exhaust clear of the navball cluster with a small vertical screen offset in the auto camera

## Verified OK (no action)
- Staging order is correct:
  - Orbiter I: SRBs + Swivel, then radial decouplers, then core decoupler + Terrier, then pod decoupler, then chute.
  - Big Bertha's boosters separate cleanly at 31 km (q = 5 kPa, no tumble; node `pt_ascent_node_sep.mjs heavy_lifter`).
- Fuel drains from the right tanks. The upper T400 stays full until its stage (`pt_ascent_node_fuel.mjs`).
- Physics warp in the air (2×, 3×, 4×, then "Only physics warp inside Verda's atmosphere") and rails warp above 70 km (5×, 10×, 50×, then "Too close…" for 100× below 120 km) both work.
- A real orbit in the browser: 94.2 × 77.1 km with 1,286 m/s left. Profile: W kick to 80° at 60 m/s, SAS prograde, MECO at Ap 80 km (alt 26 km), rails warp to Ap, prograde burn (`pt_ascent_quickorbit.mjs`). The HUD Ap/Pe/period/inclination match the telemetry. The map shows the orbit line, Pe marker and launch site.
- Navball, pilot's view after a real ascent: prograde is at the centre, normal on the left, radial-out at the top, heading 090. Projected markers: normal (−1, 0), antinormal (1, 0), radialOut (0, 1), radialIn (0, −1).
  - SAS normal holds heading 000 and radial-out holds pitch 90.
  - Sky/ground and the horizon band are correct at pitch 0, 20 and 45 (`pt_ascent_navball_attitude.mjs`, pixel-sampled).
- The g-meter reads 1.0 on the pad and 0.0 in coast.
- Shift, Ctrl and Z throttle correctly (`pt_ascent_throttle.mjs`).
- Camera modes cycle auto → free → orbital → chase → locked. Chase and locked look straight up the nozzle when prograde-holding in orbit, so the vessel reads as a dark disc (polish).
- Liftoff: `TSP.audio` is running with the flight soundscape, the camera shakes (0.25 m at ignition, decaying to about 0.03–0.07 m), pad smoke is present (about 3,000 particles), the "LIFTOFF!", "SAS ON" and "STAGE 3" messages appear, and the tower clears.
- No console or app errors in any run.

## Scripts (all under `tests/playtest/`)
| Script | What it does |
|---|---|
| `pt_ascent_fly.mjs` | Full player ascent in the browser: keys, the HUD SAS click, a screenshot per phase, HUD and telemetry snapshots, the separation probe, warp checks, map and camera modes. Environment variables: `PT_TAG`, `PT_KICK_V`, `PT_KICK_S` or `PT_KICK_PITCH`, `PT_AP`. The circularization timing is not reliable in headless mode, because real-time key latency under 50× rails warp overshoots Ap. Use `pt_ascent_quickorbit.mjs` for the orbit itself. |
| `pt_ascent_quickorbit.mjs` | A player-equivalent autopilot inside `fastForward` that reaches a real orbit, then checks the orbit HUD, navball markers, map (M) and V modes. |
| `pt_ascent_sep.mjs` | Booster separation close-up. The game is frozen at +t after staging, with a per-booster tilt/spin/axis-distance log. `PT_YAW=0` gives the side view. |
| `pt_ascent_pad.mjs` | Pad telemetry, stage stats and altimeter wheel offsets (`PT_CRAFT`). |
| `pt_ascent_navwarp.mjs` | Navball Surface/Orbit toggle compared with the SAS prograde target. |
| `pt_ascent_warpkeys.mjs` | `.` `,` `/` in the air and across 70 km. |
| `pt_ascent_orbitcheck.mjs` | Checks after the debug `orbit()` teleport: SAS normal/radial holds, gauges, rails warp, map, and a dump of the navball texture. |
| `pt_ascent_navball_attitude.mjs` | Exact pitch 0/20/45° navball screenshots. |
| `pt_ascent_throttle.mjs` | Throttle keys on the pad. |
| `pt_ascent_node_sim.mjs`, `_node_sep.mjs`, `_node_heat.mjs`, `_node_pitchrate.mjs`, `_node_fuel.mjs`, `_node_warp.mjs` | Node-only physics harnesses. They are fast and deterministic, and every run line is in the file header. |
