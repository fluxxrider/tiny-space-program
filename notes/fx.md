# fx — visual effects, particles, audio & music

Owner files: `src/render/effects.js`, `src/render/particles.js`, `src/audio/{audio,music,sfx,flightSound,synth}.js`,
`tests/effects.html`, `tests/audio.html`, `tests/fx.test.mjs` (node tests for this area), `notes/fx.md`.

## What was built

### Particles (`src/render/particles.js`)
* `ParticleSystem` — CPU-simulated, GPU-drawn instanced billboards. State is structure-of-arrays typed buffers;
  positions are **Float64** in the body-relative inertial frame. Per frame: exponential drag toward the air velocity
  **ω × r**, gravity μ/r², buoyancy along local up, per-particle floor radius (ground/sea collision: slide or bounce),
  swap-remove death. Upload writes only the live range relative to the floating origin (no allocations; update ranges
  are reused objects).
* Two kinds:
  * `smoke` — lit, premultiplied-alpha quads in three flavours per particle: camera-facing **billboards**,
    **stretched billboards** (preset `stretch` > 0: elongated along the screen-projected velocity relative to the
    reference vessel — ballistic regolith streaks, vacuum vents) and **flat quads** (preset `flat: 1`: lie in the plane
    normal to the macro normal — foam, dye marker, scorch marks, footprints). **Soft ground contact**: a billboard with a
    ground radius (`gnd`, defaults to its floor radius, `setGround(i, r)` overrides) fades where it crosses that ground/sea
    plane (distance to the intersection line measured in the sprite plane → works at every view angle) — a cheap
    soft-particle substitute that removes the hard straight cut lines. Preset `translucency` (0..1) lights thin water
    mist/spray/vapour through (no dark core, strong forward scattering).
    Base look: Sprite = procedurally generated 2×2 "cauliflower" atlas (smooth union of
    sphere lumps + fbm; RG = normal, B = thickness, A = soft wispy density). Lighting: wrap-diffuse with a
    multiple-scattering floor, silver lining when back-lit, hemisphere ambient, per-particle **macro normal** (the
    cloud mass' outward direction) so whole clouds shade like domes/columns, heat emission (dark-red → orange → yellow)
    and an additive factor so one particle can go from fireball glow to sooty smoke. O(n) back-to-front bucket sort.
    Near-camera fade avoids full-screen overdraw walls.
  * `glow` — additive soft glows and velocity-stretched sparks/streaks (stretch relative to a reference velocity,
    normally the active vessel, so streaks look right from the chase camera). Opt-in soft ground fade (`setGround`),
    used by the flame glow where the jet hits the ground (it used to show a hard straight bottom edge).
  * Flat quads get a **view-ray depth bias** in the vertex shader (each vertex slides ~0.35 m + 2 % of its distance
    toward the camera along its own view ray: same pixel, smaller depth), so ground decals lying on the analytic height
    still win against terrain triangles that sit a little above it.
* All ShaderMaterials include the logdepthbuf chunks + tonemapping/colorspace chunks.

### Effects (`src/render/effects.js`) — `new Effects(scene, { quality })`
* **Engine smoke trails** from every active engine of every vessel within `RENDER_RANGE` (nozzle = `partWorldPos` +
  `nozzle.y` along the part +Y; exhaust = −part +Y). Density ∝ √pressure × throttle × `plume.smoke`; SRBs thick
  billowing white, liquids thin; **none in vacuum** (p < 0.25 kPa). Smoke forms nearly at rest in the air (only 12 %
  of the vessel airspeed kept + exhaust push) and is spawned along the path travelled this frame with sub-frame ages,
  so trails stay continuous at hundreds of m/s. Trail is suppressed while the plume still reaches the ground.
* **Liftoff / ground interaction** when the exhaust hits the ground within ~40 m (scaled by thrust). What it hits is
  sampled 4×/s (`terrainSample`): the **launch site** (biome `Launch Site`: deluge water) and **water** get the huge white
  radial ground-hugging clouds + rising steam; **natural ground** gets terrain-coloured **dust** (`dustColor()`:
  vegetation → soil brown, otherwise the ground albedo lifted a little — red on Rusta, grey on Lune, mint on Pip), smaller
  puffs that settle, and the white exhaust trail is suppressed while the jet hits the ground; thin air (Rusta) carries it
  further. In **vacuum**: ballistic regolith **streaks** (stretched, gravity, no drag, no billowing) + a thin flat dust
  sheet racing over the surface. A sustained burn near natural ground leaves up to 5 **scorch** decals per engine;
  flickering flame glow at the impingement point.
* **Touchdown** (`situation:change` → LANDED from a flight situation): a small dust ring at every deployed leg foot (or
  under the hull), terrain coloured (streaks in vacuum), visible even at 1 m/s, + **footprint** decals (5 min).
* **Explosions** on `part:destroyed` (scaled by `size` and fuel on board): flash sprite + pooled point light,
  turbulent fireball turning into rolling soot, sparks, bouncing embers, tumbling charred **debris shards**
  (InstancedMesh, glowing hot → cooling, trailing smoke, bouncing on the ground), ground shock dust ring (or a splash
  over water), camera trauma with distance falloff. Chain reactions share a per-frame budget (1/√n).
* **Decouple** (`decouple`): ring (stack) or directional (radial) pyro puffs + sparks + small flash, owner vessel found
  among `newVessels` (in vacuum the puffs are short translucent vents). **Engine ignition** puffs (`engine:ignite`, in
  air). **Flameout**: a sooty cough in air; in vacuum a 0.25–0.45 s additive flash of sunlit propellant vapour (scaled by how
  sunlit the scene is) + ice glints — no smoke particles at all.
* **Reentry / heating**: two-layer flow-aligned plasma sheath (thin white-hot fresnel bow shock standing off the windward
  end, the craft stays visible through it; streaky orange flame tongues trailing behind, flickering). Geometry from the
  flow-aligned extents (`_heatGeom`: exact cylinder extents per part, radius of the windward section, slenderness):
  a **blunt** body (capsule) gets a volumetric wake streaming far behind it; a **slender** rocket flying nose first gets
  only a nose cap + a short rim-lit sleeve over its nose section (the rest flies in the attached, cooler boundary
  layer) — never a uniform shell around the stack. Visual intensity = `heatVisual(ri) = ri²` of
  `vessel.reentryIntensity`: a hot ascent (ri ≈ 0.5–0.7 at Mach 5–6.5, 30–45 km) is a modest orange nose glow, only a
  real entry (ri → 1) is the full white-hot sheath. Ember streaks shed from the windward shoulder, ablation smoke wake
  behind the vessel, and an **afterglow**: after a real plasma entry a thin smoke trail + embers keep coming off the
  windward end for ~20 s into the subsonic descent. Up to 3 vessels (1 on low).
* **Vapor cone** near Mach 0.95–1.1 in dense humid air (flow-aligned flared shell + vapor wisps).
* **Water splash** (crown sheet, Worthington jet, flat foam patches on the water, faint mist born above the surface,
  droplet glints; spray/mist are bright translucent white with soft contact at the sea plane — no cut lines) on
  splashdown (`situation:change` → SPLASHED, per-frame sea-level crossing detection, or explosions over water).
  A splashed-down active vessel then releases a spreading fluorescent-green **dye marker** on the sea (≈16 s, lasts 1.5 min).
* **Flight moments** (active vessel): `bus.emit('fx:moment', { id, text, vessel })` with `supersonic` ('SUPERSONIC',
  accelerating through Mach 1), `maxq` ('MAX-Q', dynamic pressure peaked above 6 kPa on the way up), `meco` / `seco`
  (all engines stopped after an ≥ 8 s burn, climbing above 2 km), `space` ('SPACE!', crossing the atmosphere top),
  `blackout` ('COMMS BLACKOUT', plasma while descending) / `signal` ('SIGNAL ACQUIRED'). Flags are seeded from the state
  when the active vessel changes (no stale callouts after switching/loading). Audio plays stingers for them.
* **Camera shake**: `cameraShake()` → Vector3 (m, world axes; reused object) combining thrust rumble near the ground
  (active vessel, distance falloff), structure-borne rumble while engines run, explosion trauma, reentry / transonic buffet.
* **Quality** (`FX_QUALITY`): capacities smoke 7000/4000/1800, glow 3500/2000/900, shards 150/90/40, lights 2/2/1,
  emission rate 1/0.65/0.35; lower quality uses fewer but larger puffs. Follows `game.settings.graphics` changes live
  (capacity is fixed at construction). Adaptive budget throttles emission as systems fill up.
* **Lighting of smoke** matches the scene: sun direction from `universe.sunDirection` (+ `isInShadow`), intensity/colour
  from the scene's DirectionalLight (planets' `sunLight`, which already carries sunset transmittance & eclipses),
  ambient from HemisphereLight/AmbientLight floored by an atmosphere-based sky estimate; partially desaturated so
  warm-sun × blue-sky doesn't turn white smoke lavender. Falls back to its own model without scene lights.

### Audio (`src/audio/*`) — all synthesized, no files
* `synth.js`: node-safe helpers; per-context lazily built seamless-looping white/pink/brown noise, crackle & sizzle
  buffers, synthetic stereo reverb IRs (early reflections + darkening exponential tail).
* `sfx.js`: 26 one-shot recipes `(ctx, out, t, opts, lib, wet) → duration` — works on live and offline contexts.
  New: `touchdown {speed}` (thud + gravel), `sonic_boom` (N-wave double crack + rumble), `quindar {out}` (mission-control
  callout tone), `space` (air noise falling away into a shimmering chord), `static {on}` (radio blackout hiss / end burst).
* `flightSound.js`: continuous `FlightSoundscape` — engine (brown-noise rumble, pink roar, hiss, SRB crackle + flutter,
  detuned sub-saws), lowpassed toward vacuum and with camera distance/air absorption; wind roar (bandpass tracking
  Mach, transonic buffet LFO), high whistle; reentry roar, low rumble & sizzle. Silent when paused / rails warp.
* `music.js`: `MusicDirector` look-ahead scheduler with four crossfaded generative moods (weighted chord random walks,
  scale-walk melodies, phrase density, humanized timing, long synthetic reverb, ping-pong echo, glue compressor):
  spacecenter (D-major pads, sub, plucks), vab (swing FM e-piano comping, walking bass, brushes/hats, fills),
  flight (E-lydian airy pads, breathing lowpass, FM bells, shimmer), map (A-aeolian drones, glass tones, sonar pings).
* `audio.js`: the `audio` singleton (contract API) + bus wiring + master chain
  `music/world/ui → sfx → master → limiter → destination`. **Mute**: `Ctrl+M` anywhere (captured on window before the
  polled game input, so the map doesn't toggle), `audio.toggleMute()` / `setMuted(bool)` / `muted`; remembered in
  `tsp.audio` storage; the volume settings are untouched (unmute restores them); raising the master slider while muted
  unmutes; emits `audio:mute { muted }`; toast feedback.

## Public API

### `src/render/effects.js`
```js
export class Effects {
  constructor(scene, { quality = game.settings.graphics, universe?, terrain? } = {})
  update(dt, { flight, originRootPos, camera, ut })     // contract
  cameraShake() → Vector3                               // contract (reused vector — add, don't keep)
  dispose()                                             // contract (removes everything, unsubscribes bus)
  // extensions
  setQuality(q) · clear() · addTrauma(amount) · explode(bodyId, relPos, vel, size, fuelTonnes) · splash(bodyId, relPos, strength)
  stats { smoke, glow, shards, updateMs } · root (THREE.Group) · smoke / glow (ParticleSystem) · shards · sheaths · cones · lights
}
export const FX_QUALITY; export function atmPressure(body, alt); export default Effects;
export function heatVisual(ri) → 0..1          // visual heating intensity (ri²)
export function dustColor(rgb, out) → out      // dust colour kicked up from ground of albedo rgb
```
### `src/render/particles.js`
```js
export class ParticleSystem { constructor({ capacity, kind:'smoke'|'glow', renderOrder? }); spawn(preset, x,y,z, vx,vy,vz,
  sizeK, lifeK, alphaK, dragK, floorR) → i|-1; setNormal(i,x,y,z,w); setGround(i, radius); tint(i,r,g,b); setColor(i,…); simulate(dt, mu, omega);
  upload(ox,oy,oz, camera, rvx,rvy,rvz); translate(…); clear(); setLighting(…); dispose(); count; capacity; fill; sizeBoost }
export function makePreset(o); export function buildPuffAtlasData(size); export function flagRange(attr, count);
export const RENDER_ORDER = { vapor: 7, smoke: 8, sheath: 9, glow: 13 };
```
### `src/audio/audio.js`
```js
export const audio = {
  init(), setScene(name), updateFlight(dt, params), play(name, opts?), setVolumes({master, music, sfx}), pauseAll(bool),  // contract
  updateFromFlight(dt, flight, { cameraDist, paused = game.paused })   // extension: derives updateFlight params from a FlightSim
  context, running, ready, scene, volumes, music (MusicDirector), flightSound
};
export const SFX_NAMES;   // also: src/audio/sfx.js SFX, src/audio/music.js MusicDirector / MOOD_NAMES / moodForScene
```
`play()` names: all contract names (`click hover stage decouple explosion{size,distance} chute{state} sas_on sas_off warp{up}
milestone flameout error toggle{value} launch gear place pickup delete countdown{final}`) **plus** `ignite`, `splash{size}`,
`touchdown{speed}`, `sonic_boom`, `quindar{out}`, `space`, `static{on}`. Also `audio.muted`, `setMuted(on, {silent})`, `toggleMute()`.

### Deviations / extensions (none break the contract)
* Effects constructor accepts optional `universe` / `terrain` module injection (tests); otherwise it imports
  `../physics/universe.js` and `../world/terrain.js` dynamically and falls back gracefully (origin fallback = active CoM,
  ground from `telemetry.radarAltitude`) if they are missing.
* `audio.pauseAll(true)` silences **world** sounds (engine/wind/explosions…) and ducks music to 50 %; UI sounds still
  work (pause menus need clicks). The context is also suspended while the tab is hidden.
* `setScene`: `tracking` → map mood, `menu` → spacecenter mood, `'silence'`/null → fade out. Audio also follows
  `scene:change` on the bus by itself, and `settings:changed` / `game.settings` volume changes.
* Volume sliders map through `v^1.7` (perceptual).
* Audio auto-adds a subtle hover/click sound to every `button`, `.tsp-btn` and `[data-sfx]` element (document-level
  capture listeners, de-duplicated with `ui:click`); opt out with `data-sfx="off"`. It also calls `init()` on the first
  pointer/key gesture as a fallback (the shell still should).
* Debug hooks: `window.TSP.fx` (Effects instance), `window.TSP.audio` (after init).

## Integration notes (flight scene)
```js
import { Effects } from '../render/effects.js';
import { audio } from '../audio/audio.js';
// enter()
this.fx = new Effects(this.scene, { quality: game.settings.graphics });
audio.setScene('flight');
// update(dt) — AFTER flight.update(), after the floating origin is chosen and the camera base pose is set:
this.fx.update(dt, { flight: game.flight, originRootPos, camera: this.camera, ut: game.ut });
this.cam.update(dt, { …, shake: this.fx.cameraShake() });          // FlightCamera already supports `shake`
audio.updateFromFlight(dt, game.flight, { cameraDist: this.cam.distance });   // or audio.updateFlight(dt, {...})
// map toggle
audio.setScene(mapOpen ? 'map' : 'flight');
// quickload / revert / vessel teleport
this.fx.clear();                                                   // (ut jumps > 3 s are cleared automatically)
// exit()
this.fx.dispose();
```
* `originRootPos` must be in the **root** frame (as in ARCHITECTURE §1); Effects converts with `universe.bodyPosition`.
  Particles live in the active vessel's body frame and are converted (or cleared) on SOI changes.
* `updateFlight` params if you don't use `updateFromFlight`: `thrustFrac` = engine loudness 0..1 (scale with absolute
  thrust, e.g. `min(1, (thrustN/3e5)^0.4)`), `solidFrac` = SRB share of thrust, `dynPressure`/`pressure` in kPa, `mach`,
  `reentry` = `vessel.reentryIntensity`, `warpRate`, `paused`, `cameraDist` (m). If not called for 0.4 s the flight
  layers fade out by themselves (and are released after 20 s).
* **Render order**: smoke 8 (drawn before the parts3d plume at 10–12 so the flame shines through the exhaust cloud),
  vapor 7, reentry sheath 9, additive sparks 13. Atmosphere (−50)/sky (≤ −90) earlier, lens flare (1000) later.
* Effects keeps **2 PointLights** (1 on low) permanently in the scene at intensity 0 (explosion flashes) so shader
  programs never recompile when something explodes.
* Smoke lighting auto-detects the scene's DirectionalLight/HemisphereLight (scan every ~15 s or when detached).
* Bus events consumed: `part:destroyed`, `decouple`, `engine:ignite`, `engine:flameout`, `situation:change` (effects);
  `vessel:staged`, `decouple`, `part:destroyed`, `chute:deploy`, `warp:change`, `warp:denied`, `milestone`,
  `control:toggle`, `engine:flameout`, `engine:ignite`, `situation:change`, `ui:click`, `scene:change`,
  `settings:changed`, `fx:moment` (audio). Nobody needs to call `audio.play` for those.
* **Bus events emitted (fx extensions, not in the ARCHITECTURE table):** `fx:moment { id, text, vessel }` (see Flight
  moments above; meant for HUD callouts via `hud.showMessage(text)` and a COMMS BLACKOUT chip) and
  `audio:mute { muted }` (for a HUD / space-center speaker toggle that calls `audio.toggleMute()`).

## How to test
* Node: `node tools/run-tests.mjs fx` — atmosphere formula, atlas, particle physics (advection with ω×r, floor,
  capacity), Effects with a mock flight (liftoff clouds, trail, no smoke in vacuum, explosions/shards above ground,
  flash light, decouple, reentry sheath on/off, splash, vapor cone, time-jump clear, dispose/unsubscribe, fallback
  without universe/terrain, per-frame cost), audio importable & no-op in node.
* Node (new, 2026-09-23): shader attribute encoding of flat/soft/streak/translucency; slender rocket at 40 km with
  ri 0.68 → modest sheath + short sleeve vs capsule at ri 1 → full wake; vacuum flameout vents and is gone in < 1 s;
  red terrain → red dust (no white steam); touchdown puff on `situation:change`; `fx:moment` supersonic + space once.
* Visual: `tests/effects.html?mode=liftoff|ascent|explosion|reentry|vapor|splash|dust|decouple|heat|landing|touchdown|flameout|atlas`
  params: `warm=<s>` pre-simulate, `fixed=<dt>` fixed step per frame, `quality=low|medium|high`, `bloom=0`,
  `sun=front`, `real=1` (use the real universe.js/terrain.js with true root-frame coordinates);
  `heat`: `ri=<0..1>`, `view=chase`; `landing`/`touchdown`: `body=verda|rusta|lune|pip`, `view=top` (touchdown);
  `reentry`: `after=1` (plasma fades while the capsule slows → afterglow). E.g.
  `node tools/snap.mjs "tests/effects.html?mode=explosion&warm=0.9&fixed=0.025" --out shots/fx_explosion.png --shots 3000,6000`.
  `window.__fxStats()` returns counts/timing. Screenshots: `shots/fx_*.png`.
* In game: `tests/fx_scenario_world.mjs` (FX_CASE=heat|reentry|splash|land|flameout, FX_BODY for land) —
  e.g. `FX_CASE=land FX_BODY=rusta node tools/snap.mjs "index.html?scene=flight&craft=lune_lander&debug=1" --wait 3000
  --script tests/fx_scenario_world.mjs --out shots/fx_world_end.png` (heat: `craft=heavy_lifter`, reentry: `orbiter_1`,
  splash: `flea_hopper`). It freezes the sim (`game.paused`) for every screenshot and logs ri / sheath / smoke counts.
  Shots: `shots/fx_final_*.png`, `shots/fx_world_*.png`.
* Audio: `tests/audio.html` — buttons for every sound/variant, mood switcher, volume and flight sliders (drive
  `updateFlight` live). On load it renders every SFX variant, each mood (26 s) and 7 flight configurations in
  `OfflineAudioContext`s and checks non-silence, no clipping, no NaN, no dead-silent music windows, UI-vs-explosion
  balance, VAB busier than flight, vacuum engine duller than sea level, silence when paused/on rails:
  `node tools/snap.mjs tests/audio.html --size 1280x2200 --wait 20000 --eval "window.__audioResults.pass"` → `true`
  (all 46 renders pass — 35 sfx variants incl. touchdown / sonic_boom / quindar / space / static). Measured: UI click −22 dBFS peak, big explosion ≈ −4 dBFS, music moods RMS −13…−17 dBFS
  pre-bus, full-thrust sea-level engine −17 dBFS RMS vs −27 in vacuum (centroid 900 Hz → 95 Hz).
  The live path (init → moods → bus events → flight layers → pause) is also verified with an AnalyserNode.

## Performance
* `Effects.update` ≈ 0.1–0.3 ms/frame with 2–4k particles (headless Chrome), 0.02 ms in node; allocation profile shows
  only V8 number boxing (~40 B/frame). One draw call per particle kind + one for shards (+ sheath/cone meshes when active).

## Playtest fixes (2026-09-23)
| Finding | Fix |
|---|---|
| Plasma sheath wraps the whole Big Bertha stack during ascent (30–44 km, Mach 5.5–6.4), even after MECO | Reproduced (heavy_lifter at 40 km/1.9 km/s: physics ri = 0.68). Note: the convective flux there is *not* low (√ρv³ ≈ 2e8, the same as a LEO entry at 45 km) — speed (recovery temperature) is the only discriminator, and physics' ri already contains it. So: visual intensity = ri² (0.46 here → orange nose glow; entry ri → 1 stays full white-hot) and the sheath shape depends on slenderness: nose cap + short rim-lit sleeve on long rockets, volumetric wake only behind blunt bodies. It still persists after MECO while the rocket is that fast in that air (physically right), fading as it climbs out. `shots/fx_final_heat_*.png` vs `fx_base_heat_*.png`. |
| Splash mist hard-clipped by the sea, grey smoke look | Soft ground/sea contact fade in the smoke shader; foam is now flat patches on the water; spray = bright translucent velocity-stretched droplet streaks spawned above the surface; mist born above the surface, short and faint. Plus a dye marker. |
| Flameout spawns grey clouds in vacuum; Lune landing dust = cotton balls | Vacuum flameout = a 0.25–0.45 s additive vapour flash + ice glints (no smoke particles); vacuum decouple puffs are short translucent vents; vacuum ground dust = ballistic regolith streaks + a flat racing sheet (no billowing, no drag). |
| White "cotton" landing dust on red Rusta / green Verda | Surface classification (launch site / water / natural ground); natural ground → `dustColor(terrain)` dust (≥ 0.8 terrain weight, vegetation → soil), smaller & settling, white trail suppressed while the jet hits the ground; flame glow soft at the ground. |
| (found while verifying) explosions / decouple puffs misplaced by tens to hundreds of metres | Events were converted to the particle frame with the *frame's* UT, but `part:destroyed.rootPos` is computed at the physics sub-step (Verda orbits at 9.3 km/s → 185 m per 20 ms), and staging puffs captured before the physics step stayed behind a fast vessel (2.3 km/s × dt). Every event now carries the vessel's `ut`; body positions are taken at that time and the event is carried along with its velocity to the frame time. Test: "events are placed at their own sub-step time" (92/92 sparks > 25 m off without the fix). |

Improvements: touchdown puffs + footprints, scorch marks, reentry afterglow, dye marker, flight moments (`fx:moment`) with
sonic boom / Quindar callout tones / "space" stinger / blackout static, Ctrl+M mute with persistence, explosion ground-shock
dust in the dust palette, decals with a view-ray depth bias (visible on bumpy terrain).

## Known issues / limitations
* Soft contact is against a sphere at the particle's ground radius (sampled at spawn), not a depth texture: on steep
  or bumpy terrain a big puff can still show a short intersection line where the real ground rises above that sphere.
* Decals (scorch, footprints, dye) are flat quads on the local tangent plane: on slopes they can partly sink into or
  float above the ground (the view-ray depth bias hides ~0.3–0.6 m of error). They are cleared by a time jump > 3 s
  (rails warp) like every particle.
* The COMMS BLACKOUT / callout *text* and a HUD speaker button are not drawn by fx (see cross-area requests in the
  integration/hud notes): fx only emits `fx:moment` / `audio:mute` and plays the sounds.
* Bucket sort (1024 buckets) is approximate for extremely deep clouds; not noticeable in practice.
* Smoke is advected by ω×r only (no wind model); the vapor cone is a stylised shell.
* Audio quality was tuned by measurement (levels, spectra, onset density) — the author could not listen to it.
* Headless SwiftShader runs the effects page at 10–25 fps; trails look sparser there than at 60 fps.
