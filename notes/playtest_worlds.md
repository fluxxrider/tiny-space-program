# Playtest: "worlds" — a visual & physical tour of every body

Tester: KSP-veteran playtest pass (headless Chrome / SwiftShader, 1280×720). All scripts are in `tests/playtest/`,
all screenshots in `shots/pt_worlds_*`. Every image referenced below was looked at; numbers are measured.

## How it was driven
* `pt_worlds_lib.mjs` — shared helpers installed as `window.PT`: sun geometry (`subsolar`, `lonForSun`), `orbitAt(body, alt,
  angleFromSubsolar)` (circular orbit placed at noon / terminator / midnight), a camera override that wraps
  `FlightCamera.update` (look anywhere in local ENU, at the sun or at another body), `settle()` (waits until the terrain
  LOD queue is empty), `groundRay()` (ray-casts the *rendered* terrain meshes — CPU copies of the chunk vertices are
  kept by patching `TerrainLOD._apply` — and compares with `terrainHeight()`), `stageTo()` and a powered-descent
  autopilot (`LANDER_ONSTEP`, SAS "direction" mode, vertical-speed throttle loop).
* `pt_worlds_tour.mjs` (`PT_BODY=lune|pip|nib|cinder|rusta|vesper|verda`) — high orbit day / terminator / night, low orbit
  (20–25 km) incl. limb and sun-ward views, "above the atmosphere" limb, powered landing of the Lune Lander stage at
  sun 30°, horizon and sky views, then landings at sunset (sun +2°) and at night (sun −35°), and back to high orbit.
* `pt_worlds_ksc.mjs` — Verda launch site: day views, aerial/top-down, coast, then rails-warped to sunset, night, sunrise.
* Targeted repro scripts: `pt_worlds_glints.mjs`, `pt_worlds_nan.mjs`, `pt_worlds_nightleak.mjs`, `pt_worlds_eclipse.mjs`,
  `pt_worlds_seasky.mjs`, `pt_worlds_landing.mjs`, `pt_worlds_seams.mjs`, `pt_worlds_skybodies.mjs`,
  `pt_worlds_pngstat.mjs` (tiny PNG reader for mean-colour measurements).

Run e.g. `PT_BODY=lune node tools/snap.mjs "index.html?scene=flight&craft=lune_lander&debug=1" --wait 3000 --script tests/playtest/pt_worlds_tour.mjs --out shots/pt_worlds_lune_end.png`
(each tour takes 20–35 min headless because every view waits for the LOD to finish streaming).

Console: **zero errors / warnings** in all runs (tours of 7 bodies, KSC day/night cycle, 12 targeted runs); `TSP.app.errors` empty.

## What is great
* Terrain / physics agreement is excellent everywhere: rendered mesh vs `terrainHeight()` under the vessel differs by
  ≤ 0.02 m at 20 landing sites (15-point grid around the Pip site: all 0.000 m; Nib worst 0.147 m at 20 m distance). No
  floating or sunken landers, radar altitude matches what you see.
* No LOD cracks: drawing the chunks *without* their skirts (`pt_worlds_seams_*_noskirts.png`) looks identical to the
  normal render on Pip and Nib — seams are watertight. No holes while streaming.
* KSC sits on a perfectly flat lawn, no floating buildings; coast 4 km east (terrain samples: sea at 4 km on azimuth 90°,
  land rising to the west) exactly as designed. KSC at night (floodlit pad, lit windows, runway lights, red beacons) and at
  sunrise/sunset looks lovely (`pt_worlds_ksc_night_west_ksc.png`, `pt_worlds_ksc_sunrise_east_coast.png`).
* Atmosphere colours read well: Verda blue with clouds and a bright limb, Vesper lavender haze, Rusta salmon sky with a
  thin pale limb; Lune/Pip/Nib/Cinder have crisp black skies with the Milky Way.

## Bugs (most severe first)

### 1. NaN "sparkles" (white stars / squares) on night sides and limbs — terrain gloss → negative shininess — MAJOR (worlds)
* Seen: Pip's night side covered in white star-shaped sparkles (`pt_worlds_pip_high_night.png`,
  `pt_worlds_glints_pip_baseline.png`); rows of white squares along the night limb of Vesper and Verda
  (`pt_worlds_vesper_high_night.png`, `pt_worlds_verda_high_night.png`, `pt_worlds_nan_vesper_baseline.png`).
* Measured (`pt_worlds_nan.mjs`, scene rendered into a float target): Pip night 613 NaN pixels with 4× MSAA, 0 without
  MSAA; Vesper 94, Verda 110 (MSAA) → **0** after clamping the gloss varying (`clamp(vExtra.y, 0.0, 1.0)` in the terrain
  shader). `pt_worlds_nan_vesper_clampedGloss.png` / `pt_worlds_nan_pip_clampedGloss.png`: sparkles completely gone.
  `pt_worlds_glints.mjs`: 368 near-white pixels on Pip's dark disc with bloom, 0 with bloom off.
* Root cause: `terrainLOD.js` sets `material.specularShininess = mix(10.0, 180.0, vExtra.y)` and
  `specularColor = vec3(0.015 + 0.5 * vExtra.y)` from the per-vertex gloss. With MSAA (the flight composer's target is
  4× MSAA, the canvas too) varyings are evaluated at the pixel centre even for samples outside the triangle, so at
  silhouettes the gloss is *extrapolated* below 0 where it has a steep gradient (glass flats 0.9 next to cliff 0) →
  negative shininess → `pow(dotNH = 0, negative) = +Inf` (dotNH is 0 on the night side) → `Inf * 0 = NaN`; even the
  engine PointLight at intensity 0 produces it (71 NaN pixels with the sun light hidden).
* Fix: clamp `vExtra` in the fragment shader (`vec2 ex = clamp(vExtra, vec2(-1.0, 0.0), vec2(1.0))` for gloss) and use
  `max(shininess, 1.0)`; optionally declare the varyings `centroid` (WebGL2).

### 2. Cinder's fissure network aliases into a red "circuit-board maze" from orbit — MAJOR (worlds)
* `pt_worlds_cinder_high_day.png`, `pt_worlds_cinder_high_night.png` (zoom: grid-aligned stair-step contours covering
  the whole planet), `pt_worlds_cinder_low_down.png` (25 km: blocky contour lines). On the night side the planet looks
  like a red wireframe sphere.
* Root cause: the fissure fields `fa/fb` (`terrain.js` ScorchedGen, `a * 140 * wk` clamped to ±9) are sampled per
  vertex; on coarse LOD chunks the zero crossings of that noise are far below the vertex spacing, so linear interpolation
  between clamped samples produces spurious crossings along triangle edges. `tspFissure()` keeps every line ≥ 1 px wide
  (`w = max(1.0, fwidth(v) * 1.2)`) and never fades, so the density of lines stays constant at any distance.
* Fix: fade fissure emission/darkening with the terrain footprint (e.g. `1 - smoothstep(20.0, 120.0, tspFoot)` or by
  chunk level), and for far LODs show a low-frequency "hot plains" glow instead of lines; don't clamp the field to ±9
  before interpolation (store a signed distance-like value scaled so it stays linear across a quad).

### 3. Eclipses don't darken the ground: Lune in Verda's shadow keeps full daylight — MAJOR (worlds)
* `pt_worlds_eclipse.mjs` finds mid-eclipse (UT 32341, Sun–Verda–Lune aligned to 0.0001°; Lune's orbit is equatorial so
  this happens every Lune orbit and lasts ~37 min). `pt_worlds_eclipse_mid.png`: the vessel is a pitch-black silhouette
  (`planets.sunLight.color` = [0,0,0], `isInShadow(..., {eclipses:true})` = true) over brilliantly sunlit white ground.
* Root cause: `terrainLOD.js` overrides the directional light colour in the shader with `uSunColor * vSunT`, and
  `planets.js update()` sets `tu.uSunColor` (terrain, ocean, clouds) to the *un-eclipsed* `SUN_BASE × SUN_INTENSITY`
  every frame; the eclipse factor `lightF` is only applied to `sunLight.color`.
* Fix: compute an eclipse factor per body (occluder parent/siblings vs the body's position, or per vertex/fragment with
  an occluder uniform: centre + radius, soft over the sun's angular size) and multiply `uSunColor` of that body's
  terrain/ocean/cloud materials; the sky/env map should follow as well.

### 4. Ocean reflects a stale noon sky: lilac sea under a black sky (Vesper), blue sea under an orange sunset (Verda) — MAJOR (worlds)
* `pt_worlds_seasky.mjs`: Vesper, sun −1°, looking east: sky just above the horizon (0,0,0) but the sea below it (20,12,30);
  with `uSkyDay/uSkyHorizonDay` zeroed the sea becomes (0,0,0) → 100 % of the sea colour is the noon-sky constant.
  Vesper sun +2° (`pt_worlds_vesper_sunset_gamecam.png`): sea (133,111,156) glowing under a dark (40,29,40) sky.
  Verda sun −4° (`pt_worlds_seasky_verda_west.png`): vivid orange glow on the horizon, the sea is uniform steel blue with no
  warm reflection at all.
* Root cause: `planets.js` BodyView constructor copies `skyZenith`/`skyHorizon` (sky radiance for the sun at the zenith)
  into the ocean uniforms once; `water.js` only scales them by a day factor `smoothstep(-0.18, 0.25, sunUp)`.
* Fix: update the ocean sky uniforms every env refresh from `skyRad(p, r0, …, muS, …)` (as `_updateEnv` already does for
  the env map), and add a sun-azimuth term (sky toward vs away from the sun) so sunsets reflect; or sample the env map
  (`planets.envMap`) with the reflected vector.

### 5. Rusta's ground is brighter at sunset than in mid-afternoon — MAJOR (worlds)
* Sun +1.9° (`pt_worlds_rusta_sunset_towardsun.png` / `_awayfromsun.png`): ground (177,42,21) / (157,34,17); sun +30°
  (`pt_worlds_rusta_landed_horizon_east.png` / `_west.png`): (119,33,20) / (111,34,24) — ≈ 1.45× brighter at sunset, under a
  dark grey sky. Verda grass does get darker at sunset (KSC: 135 → 88 green), Lune correctly drops 109 → 17.
* Root cause: the terrain ambient in `terrainLOD.js` (`lights_fragment_maps` replacement) multiplies the constant noon
  `uAmbDay` by `(1 + 2.2 * dusk)` with a warm tint — a twilight lift tuned for Verda. Rusta's noon ambient is large and red
  (thin, bright pink sky) and its sun is barely attenuated near the horizon, so the lift dominates.
* Fix: drive the ambient from the actual sky irradiance at the current sun angle (CPU `skyRad` per body per frame →
  `uAmbNow`) or at least clamp the lifted ambient to ≤ the noon ambient and scale the lift by the atmosphere's density.

### 6. Airless bodies: sun-facing slopes stay lit deep into the night (no planet shadow in the terrain shader) — MINOR (worlds)
* `pt_worlds_nightleak.mjs`: Lune, orbit 12.6° past the terminator: 53 772 lit pixels vs 1 147 with the terrain's sun term
  zeroed (Nib: 62 539 vs 477). `pt_worlds_nightleak_lune_orbit_night12.png`: whole crater walls brightly lit where the sun is
  12° below the horizon (peaks need > 4.5 km of relief to see it). With a geometric shadow term patched in
  (`PT_GEOM=1`, `_geomshadow.png`) only the genuinely tall peaks remain lit.
* Root cause: without an atmosphere the terrain vertex shader sets `vSunT = vec3(1.0)`; lighting then only uses the
  (bumped) normal, so any slope tilted toward the sun is lit regardless of the body's own shadow.
* Fix: in the `#else` branch compute the same tangent-altitude test `atmoSunTransmittance` uses:
  `ta = su >= 0 ? 1 : rr * sqrt(1 - su*su) - 1; vSunT = vec3(smoothstep(-soft, soft, ta))` (rr = vertex radius / R).

### 7. Vesper's twilight glow turns green — MINOR (worlds)
* Sun −1° (`pt_worlds_seasky_vesper_west.png`, run 1) and −3° (same file name, run 2 — measured horizon glow (39,45,29),
  G > R, B): a lime/olive glow sits under a purple sky. The design notes say extinction is desaturated precisely to avoid
  green horizons on Vesper, and `sunset` is pink [1, 0.55, 0.85].
* Root cause: `atmosphereParams` desat 0.65 still leaves green the least-extinguished channel over grazing twilight
  paths (Rayleigh [0.72, 0.42, 0.95]); the sunset tint only applies while `mu > -0.08` and the multiple-scattering term
  (`sqrt(sunT)`) carries the green.
* Fix: stronger desaturation of `tauRExt` for non-earthlike bodies (≈ 0.9) or tint the twilight (mu < 0) in-scatter
  with `uSunset` as well.

### 8. Stock Lune Lander tips over on 13–19° slopes — MINOR (physics)
* `pt_worlds_landing.mjs` on Rusta (lat 3, lon 165.6285, slope 13.2° measured from `terrainHeight`): vertical touchdown at
  0.77 m/s, 0.007 m/s drift, 0.01° tilt → tilt 52° after 4 s, lying at 104.5° after 7 s. Deterministic (2/2 runs), same
  with SAS off (`PT_SAS_OFF=1`). Also tipped at Cinder (19.2°, `pt_worlds_cinder_landed_horizon_west.png`) and Nib (18.2°,
  `pt_worlds_seams_nib_noskirts.png`). On flat Pip sites it stands (0.2–1.6° final tilt).
* Likely cause: narrow stance (feet at ≈ 1.18 m radius, 45°-rotated square → 0.83 m half-width) under a tall CoM, plus
  the downhill legs' 0.3 m stroke adding ≈ 10° of lean; the contact solver lets the legs slide downhill (1.45 m/s
  horizontal during the tip).
* Fix: wider `footDeployed` for `legs_lt1` (or a longer leg on the stock lander), stiffer/damped suspension on slopes,
  higher static friction for leg feet. Gameplay: without a slope readout players can't tell a 13° site from a flat one
  (see improvements).

### 9. Landing-engine ground dust is white "cotton" on every surface — POLISH (fx)
* `pt_worlds_rusta_sunset_towardsun.png` (white puffs on red Rusta), `pt_worlds_rusta_landed_horizon_east.png`,
  `pt_worlds_verda_landed_gamecam.png` (huge white clouds around a lander on grass).
* Root cause: `effects.js` ground interaction tints the liftoff smoke by only `dusty = 0.14` of the terrain colour.
* Fix: in vacuum/thin air or on non-pad ground, use the terrain colour (`terrainSample`) as the dust base colour (≥ 0.7),
  smaller, faster-settling puffs away from the launch pad deluge.

### 10. Lune/Nib maria sprinkled with diamond-shaped white specks from orbit — POLISH (worlds)
* `pt_worlds_lune_high_day.png` (zoom): 4-point "star" specks all over the dark maria — single-vertex ejecta haloes /
  small craters rendered as diamonds by the vertex-colour interpolation. Same aliasing class as bug 2.
* Fix: attenuate crater octaves (and their ejecta colour) whose size is below the chunk's sample spacing (pass the
  spacing from `chunkBuilder` to `terrainSample`/`craterField`).

### 11. LOD node counter only grows — MINOR (worlds, debug stats)
* After landing and returning to high orbit: `stats().bodies.rusta.nodes = 2858` while the real tree has 30 nodes
  (Pip 742 vs 26, Nib 646 vs 62 — `pt_worlds_seams.mjs` "afterLeave").
* Root cause: `TerrainLOD._visit` does `stats.nodes -= 4` when merging, but `_disposeNode` recursively disposes
  grandchildren without decrementing. Misleading in `tests/planets.html` / perf HUD.
* Fix: decrement in `_disposeNode` for each disposed node (or recount on merge).

### 12. HDR sanitize pass doesn't neutralise NaN on this backend — MINOR (integration)
* Bug 1's NaN pixels still bloom into white stars even though `post.js` runs `TSPSanitizeHDR` before the bloom (368 bright
  pixels with bloom, 0 without, `pt_worlds_glints.mjs`). `isnan()/isinf()` are allowed to be compiled away (ANGLE /
  SwiftShader / some drivers).
* Fix: bit-level test that survives fast-math, e.g. `uvec4 b = floatBitsToUint(c); bvec4 bad = equal(b & 0x7f800000u,
  uvec4(0x7f800000u)); if (any(bad)) c = vec4(0,0,0,1);` (WebGL2).

## Checked and fine
* Night on Verda from orbit, clouds, limb, terminator (`pt_worlds_verda_high_terminator.png`), Lune/Pip/Nib/Cinder skies,
  sun glare, other bodies as lit discs/dots (Lune from Verda, Rusta from Nib, Verda from Pip at new phase).
* KSC grounds: no floating buildings, no z-fighting of lawn/roads/runway in day, sunset, night, sunrise and aerial views.
* Coast next to the KSC: sand beach, shallow/deep water, no z-fighting between ocean and land at the shore
  (`pt_worlds_ksc_coast_low.png`, `_coast_grazing.png`, `_aerial_high_east.png`).
* Rails-warping the pad through a full day/night cycle: no errors, KSC night factor, lamps and pools all correct.

## Improvement ideas ("make it amazing")
1. (hud) Landing aids: slope under the vessel + a "suitable / too steep" colour on the altimeter when radar < 500 m, and
   a ground-contact/tip-over warning. The terrain API already gives the normal.
2. (worlds) Terrain self-shadowing for low sun: long crater-rim and mountain shadows at the terminator would make Lune,
   Nib and Rusta sunsets breathtaking (horizon-angle map per chunk, or screen-space shadows near the vessel).
3. (worlds) Earthshine / planetshine on moons: Lune's night side lit by a full Verda, Nib by Rusta — cheap (hemi light
   from the parent's direction with the parent's phase and albedo) and very photogenic.
4. (worlds) Surface scatter details: boulders/rocks near the lander (instanced, seeded by chunk), glassy crystal shards on
   Pip, lava glow pools on Cinder — ground at 2 m currently only has shader detail noise.
5. (fx) Per-body landing dust: coloured dust sheets with ballistic arcs in vacuum (Lune/Pip), red dust storms on Rusta,
   steam on Vesper seas, visible touchdown puff even at 1 m/s.
6. (map/worlds) A scenic "photo mode" camera (free-fly around the vessel, FOV, time-of-day scrub, HUD off) — the planets
   deserve to be shown off; the helper in `pt_worlds_lib.mjs` shows how little is needed.
