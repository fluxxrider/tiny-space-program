# Worlds area — terrain, planets, atmospheres, ocean, sky

Owner files: `src/world/noise.js`, `src/world/terrain.js`, `src/world/chunkBuilder.js`, `src/world/terrainWorker.js`,
`src/world/ephemeris.js`, `src/render/planets.js`, `src/render/terrainLOD.js`, `src/render/atmosphere.js`,
`src/render/water.js`, `src/render/sky.js`, `tests/terrain.test.mjs`, `tests/planets.html`.

## What was built

### Terrain (`src/world/terrain.js`, pure / deterministic / node-importable)
* `noise.js`: seeded 3D simplex (≈15 ns/call), fBm, ridged multifractal, billow, integer lattice hashes, PRNG.
* One generator class per `terrain.style`; `natural(x,y,z)` returns metres and leaves scratch fields that `shade()` turns
  into a colour and biome, so **`terrainHeight` and `terrainSample().height` are always bit-identical**.
  * **earthlike (Verda)** — domain-warped continents (≈ 63 % ocean), continental shelves → abyss, coastal lowland ramp,
    rolling hills, ridged mountain ranges (to ≈ 7 km) with a snow line at ≈ 3 km that drops toward the poles, polar ice caps,
    moisture-driven grassland / forest / savanna / badlands / tundra, narrow beaches, sea-floor colours.
    The launch site is shaped explicitly: the pad is on a lowland ≈ 4 km west of an irregular coast (sea to the east, land
    inland to the west, relief suppressed within ≈ 40 km so the flatten blend never meets a cliff). The noise domain offset
    was searched so the natural coastline already runs there.
  * **cratered (Lune, Nib)** — highlands + dark smooth maria + 6 octaves of cellular craters (bowls, flat floors, raised rims,
    central peaks, age/erosion, bright ejecta haloes), scaled to body size. Craters are **band-limited** to the chunk
    builder's sample spacing (`gen._spacing`, set only while a chunk is built; the public API always samples at full
    detail): craters narrower than ~3 samples fade out (height, floor darkening and ejecta), so no single-vertex
    "diamond" specks from orbit.
  * **flats (Pip)** — glassy mint flats (glossy) and angular, terraced crystal hills (octahedral pyramids + ridged noise).
  * **desert (Rusta)** — warped highlands/lowlands, mesas, canyon networks, dune seas, 4 crater octaves, polar ice (glossy).
  * **violet (Vesper)** — purple seas, rose fields, terraced lilac highlands.
  * **scorched (Cinder)** — dark ash plains cut by a fissure network (glowing lava lines rendered crisply in the shader),
    basalt highlands, craters. The signed fissure fields `fa/fb` are stored with a wide range (±`FISSURE_MAX` = 512, was
    ±9) so per-vertex linear interpolation stays linear across a coarse quad (the tight clamp created fake zero crossings
    along triangle edges → grid-aligned "circuit board" lines), plus `hot` (plains heat, 0..1) for the far-range glow.
* Launch-site flattening: exactly `LAUNCH_SITE.altitude` within `flattenRadius` (chord distance × R, identical to arc
  distance to < 1 cm), smoothstep blend to natural terrain at `blendRadius`. Biome `'Launch Site'` on the flat.
* Speed (node, this machine): 550k–2M `terrainHeight` calls/s depending on the body (Verda ≈ 800k/s).

### Chunk building (`src/world/chunkBuilder.js`, `src/world/terrainWorker.js`)
* Cube-sphere with tangent-warped faces; chunk (face, level, ix, iy) = N×N vertices + a skirt ring. Heights sampled on an
  (N+2)² grid so normals are central differences that are **identical on both sides of a chunk seam**.
* Positions are float32 **relative to the chunk centre** (centre computed in float64). Vertex attributes:
  `position` f32×3, `normal` snorm8×3, `color` unorm8×3 (√-encoded linear colour, squared in the shader),
  `aDetail` f32×3 (body-fixed position modulo 1024 m, for seamless shader detail), `aExtra` snorm16×2
  (glow/gloss), or ×3 on Cinder (signed fissure fields / `FISSURE_MAX`, plains heat); `data.extSize` says which. Ocean patches (chunks that touch water) are built alongside:
  sea-level positions, radial normals, `aDepth` (sea-floor depth), own skirts.
* Slope-based cliff colouring is applied per vertex from the computed normals.
* Runs in 4 module workers (`new Worker(new URL('../world/terrainWorker.js', import.meta.url), {type:'module'})`), with a
  synchronous main-thread fallback (automatic if workers are unavailable). ≈ 1.6 ms per 33×33 chunk.

### PlanetSystem (`src/render/planets.js`) — contract §5 + extras
* One group per body at `bodyRootPos − originRootPos`, a child `bodyFixed` group rotated with `universe.rotationQuat`;
  terrain chunks live in the body-fixed group (all matrix math in float64 on the CPU, only small numbers reach the GPU).
* **Terrain LOD** (`terrainLOD.js`): per-body quadtree, screen-space split criterion (target on-screen quad size, clamped
  distance/arc ratio), 6 root chunks built synchronously at construction (the base level is always complete), a node keeps
  drawing until all 4 children are ready (never holes), hysteresis on merge, horizon culling (+ three's frustum culling),
  build queue sorted by urgency, uploads limited per frame. Vertex arrays are released after GPU upload.
  Quality presets: `high` 33² chunks / 2 m min quad, `medium` 29² / 4 m, `low` 25² / 8 m.
  Distant bodies (camera > 0.3 R away) aim for ≈ 3–4 px quads with a much higher split-factor cap (vertex colours are the
  only albedo detail there: Verda seen from Lune went from 6 root chunks to ≈ 60–130 chunks, no more blocky coasts).
  `stats.nodes` is now exact (merges of deeper subtrees were not subtracted).
* **Terrain material**: `MeshPhongMaterial` (vertex colours, shadows received) patched via `onBeforeCompile`:
  periodic 6-octave detail noise (0.125 m – 128 m, faded by the anisotropic pixel footprint) for albedo + bump — odd
  octaves run in domains rotated by integer "3 × rotation" matrices (keeps the 1024 m period, no axis-aligned square
  blotches under grazing light) —, a **close-range crater layer** on cratered worlds (and sparse on Rusta: 1–3 octaves of
  4–64 m cells by quality, smooth bowls + raised rims + bright fresh ejecta, faded by footprint), vegetation tint
  variation, per-vertex sun transmittance (sunset-coloured light on distant terrain), the sun light is re-aimed per body
  (correct lighting of other planets), **sky ambient from the sky LUT** (see Atmosphere) for the local sun elevation,
  **planetshine** from the parent planet, **eclipses** (per-vertex shadow of up to two occluders), on airless bodies the
  **body's own shadow** (sun below the vertex's geometric horizon, soft over the sun's disc), faint night side, emissive
  lava fissures (Cinder: lines fade out with the pixel footprint — fine network at 25–80 m/px, major at 100–300 m/px —
  and a soft glow over the hot plains replaces them from orbit), glossy ice/glass (Blinn-Phong, gloss clamped + `centroid`
  varying + shininess ≥ 1: no NaN under MSAA), per-vertex **aerial perspective** whose weight/saturation grows with the
  path's optical depth (land keeps its colour from 5–20 km instead of turning teal; dense Vesper keeps its haze).
* **Ocean** (`water.js`): depth-based colour, soft transparent shoreline + animated foam, fresnel reflection of the
  **actual sky** (sky LUT by local sun elevation, reflected-ray elevation and its azimuth to the sun: sunset glow mirrored
  towards the sun, dark sea under a dark sky), eclipses,
  18-wave analytic spectrum (integer wave-vectors → tiles with the 1024 m detail period), each wave fades before it can
  alias; unresolved waves widen the GGX glint and lower the effective fresnel (distant sea stays blue), aerial perspective.
* **Atmosphere** (`atmosphere.js`): single scattering Rayleigh + Mie (+ cheap isotropic multiple-scattering term,
  ozone-like absorption on earthlike worlds for blue twilight zeniths) with Schüler's Chapman optical-depth approximation
  (no inner loop), density-adaptive ray sampling, planet shadow in the air. The sky shell is a back-faced sphere
  (premultiplied blending: `dst·T + inscatter`, so stars/sun/moons behind the air are dimmed). Per-body colours from
  `atmosphere.rayleigh / sunset / hazeDensity / pressureASL`. The sun colour is white-balanced to Verda's zenith
  transmittance so midday light at home is neutral white. Includes all logdepthbuf chunks. Extinction is desaturated
  0.9 on non-earthlike bodies except Rusta (0.65 left Vesper's twilight glow lime green). Moon/planet shadows also darken
  the in-scattered light (eclipses).
* **Sky LUT** (`buildSkyLUT` / `sampleSkyLUT` / `skyLUTTexture` / `SKY_LUT_GLSL`): per body with air, 64 × 6 half-float
  table over the sun zenith cosine (−0.35…1) built once from `skyRadianceCPU` (≈ 5–12 ms): sky irradiance on a horizontal
  surface, horizon radiance towards / away from the sun, 20° up towards / away, zenith. Terrain/cloud ambient, ocean
  reflections, the hemisphere light and `BodyView.skyIrradiance(muS)` all use it, scaled so noon matches the tuned
  `ambDay`; a gentle dusk lift is kept but capped at the noon value (Rusta's ground was 1.45× brighter at sunset).
* **Clouds** (Verda): a procedural cloud deck at 4.2 km (`CloudLayer` in `atmosphere.js`, body-fixed sphere,
  renderOrder −45): warped simplex weather systems + billowy cumulus detail, octaves faded by pixel footprint (no
  aliasing at any distance), climate bands (ITCZ, subtropical clear belt), lit by the attenuated sun (orange at sunset,
  silver lining towards the sun, grey bellies from below), aerial perspective, fades when flying through it, slow drift
  with game time. Terrain and ocean receive **cloud shadows** (per vertex). The second base octave fades by footprint too
  and the coverage edge widens when a pixel spans many cells (no pixel-sized blocky clouds on a distant Verda).
* **Sky** (`sky.js`): 9k/6k/3.5k point stars (colour temperatures, twinkle inside an atmosphere), a milky-way/nebula cube map
  baked once on the GPU, stars fade in daylight; Sola as an HDR billboard (limb-darkened disc, corona, glare spikes,
  anamorphic streak) depth-tested at a far-plane-safe distance (planets and mountains occlude it); lens-flare ghosts
  (hidden when a body blocks the sun); distant bodies as phase-lit coloured dots when smaller than ~2 px.
* **Lighting**: `sunLight` (DirectionalLight, castShadow, shadow camera ±`shadowExtent` around the origin, colour =
  sun × atmospheric transmittance × eclipses by other bodies), `hemiLight` (HemisphereLight: local sky light from the
  sky LUT above — plus planetshine on moons —, lit ground below, with a **night floor**: faint moonlit-sky blue inside an
  atmosphere, dimmer neutral fill on airless bodies / in space, so night-side vessels, chutes and splashdowns read as
  shapes), `envMap` (PMREM of a tiny sky/ground/sun scene with the same night floor, **stable texture reference**,
  re-rendered at most every 0.4 s when the situation changes).
* **Eclipses** (`PlanetSystem._updateOccluders`): per body, the (up to) two bodies whose shadow cone incl. penumbra
  reaches it are passed as `uOcc0/uOcc1` (centre + radius in body radii) with the sun's angular radius; terrain, ocean,
  clouds and the sky shell evaluate the visible fraction of the sun's disc per vertex / sample (umbra, soft penumbra,
  annular). Lune goes dark in Verda's shadow; Lune's and Nib's shadows sweep over Verda / Rusta.
* **Planetshine** (`_updateShine`): moons get a directional fill from their parent planet (parent colour, Lambert-sphere
  phase, (R/d)², amplified ×120 like a long exposure, capped at 0.25): a full Verda softly lights Lune's night side.
* **Surface scatter** (`SurfaceScatter` in `terrainLOD.js`): instanced boulders (Lune, Nib, Rusta, Cinder) or crystal
  shards (Pip) within 170 m of the camera when it is < ~250 m above the ground, seeded per 5 m cell of the cube-face grid
  (cached, stable while moving), placed on `terrainHeight()`, tinted with the terrain colour, cast/receive shadows,
  shrink near the patch edge and within ~5 m of the vessel, none inside lava fissures. Purely visual (no collisions).
  Rebuilt when the camera's ground point moves > 12 m. `planets._noScatter = true` disables it.

## Changes after the worlds / ascent / return / lune playtests
| Finding | Root cause | Fix |
|---|---|---|
| NaN sparkles on night sides / limbs (MAJOR) | MSAA extrapolates the gloss varying off-triangle → negative shininess → `pow(0, <0)` | gloss clamped, shininess ≥ 1, `vExtra` is a `centroid` varying; ocean GGX half-vector guarded. `pt_worlds_nan.mjs`: 0 NaN on Pip / Vesper / Verda with and without MSAA |
| Cinder "circuit board" from orbit (MAJOR) | fissure fields clamped to ±9 → fake crossings on coarse quads; lines never faded | fields stored ±512, lines fade with the footprint, soft far glow over hot plains |
| Eclipses don't darken terrain/sea (MAJOR) | only `sunLight` got the eclipse factor | per-vertex occluder test (`uOcc0/1`) in terrain, ocean, clouds, sky shell |
| Sea reflects a fixed noon sky (MAJOR) | ocean sky uniforms set once from noon sky | sky LUT by local sun elevation + reflected elevation/azimuth |
| Rusta brighter at sunset (MAJOR) | noon ambient × hand-tuned ×3.2 dusk lift | ambient from the sky LUT, lift ≤ noon value (sunset ground now ≈ 0.55× afternoon) |
| Airless slopes lit past the terminator (minor) | no body shadow without air (`vSunT = 1`) | geometric horizon test per vertex (Lune −12.6°: 7.9k lit px vs 53.8k; only tall peaks) |
| Vesper twilight turns green (minor) | extinction desat 0.65 left green least extinguished | desat 0.9 (horizon glow at sun −3° is pink/violet) |
| Night re-entry / chute invisible (minor) | only the dim night env + hemi light | night floor for hemi light + env map; planetshine lights vessels on moons |
| Maria diamond specks (polish) | sub-sample craters caught by single vertices | craters band-limited to the chunk's sample spacing |
| `stats.nodes` only grows (minor) | deep merges not subtracted | `_disposeNode` decrements (verified: stats = real tree size) |
| Land teal from 7–11 km (polish) | fixed 0.78 × saturated single-scatter in-scatter | in-scatter weight/saturation scale with path optical depth |
| Low-res Lune ground / Verda in Lune's sky (polish) | coarse LOD for distant bodies, axis-aligned detail noise, cloud octave aliasing | finer far LOD, rotated detail octaves, micro-crater layer, cloud octave fade, surface scatter |
Improvements: planetshine on moons, instanced surface scatter (rocks / crystals), close-range crater detail.
Not done: terrain self-shadowing (horizon maps) — see Known issues.

## Public API

```js
// src/world/terrain.js  (contract)
terrainHeight(bodyId, nx, ny, nz) → m      surfaceHeight(...) → m      isWater(...) → bool      biomeName(...) → string
terrainSample(bodyId, nx, ny, nz, out?) → { height, color:[r,g,b] linear, biome, water, glow (0..1), gloss (0..1) }
// extras
getTerrainGenerator(bodyId) → { R, maxH, ocean, style, minHeight, maxHeightBound, cliff, ... } | null   (physics uses maxHeightBound)
launchSiteDir() → {x,y,z}        terrainStyleInfo(bodyId) → { style, ocean, maxHeight, minHeight, maxHeightBound } | null
hexToLinear('#rrggbb') → [r,g,b]

// src/render/planets.js  (contract)
new PlanetSystem(renderer, { quality = game.settings.graphics, workers = 'auto' })
  .root, .sunLight, .shadowExtent (default 40), .update(camera, originRootPos, ut), .bodyFixedGroup(bodyId),
  .setVisible(bool), .dispose(), .getSkyColor(cameraRootPos) → shared THREE.Color, .envMap (getter)
// extras
  .prewarm(camera, originRootPos, ut, maxMs = 2500) → ms   // build all needed chunks synchronously (loading screens)
  .setQuality('low'|'medium'|'high')                       // rebuilds terrain; children you added to bodyFixedGroup are kept
  .stats() → { building, workers, bodies: { id: { visible, nodes, maxLevelShown, angPx } } }
  .hemiLight, .hemiScale (default 1), .nearestBody, .cameraAltitude, .sunDirection (scene-space unit vector to Sola)
  .bodies.get(id).skyIrradiance(muS, out[3])            // sky light on a horizontal surface (0 on airless bodies)

// src/render/atmosphere.js extras
buildSkyLUT(params, sunColor) → Float32Array   sampleSkyLUT(lut, row, muS, out)   skyLUTTexture(lut)   SKY_LUT_GLSL
// src/world/terrain.js extras
FISSURE_MAX   // range of Cinder's fissure fields (chunk extScale)
```

**Deviations from ARCHITECTURE.md:** none in signatures. Notes:
* `bodyFixedGroup('sola')` also works (a rotating group at the star's centre).
* `envMap` is a getter; the texture object is stable for the lifetime of the PlanetSystem.
* If the root's scene has `environment === null` (or still our previous map), `update()` sets
  `scene.environment = planets.envMap` automatically. Set your own `scene.environment` to opt out.
* Private fallback ephemeris `src/world/ephemeris.js` is only used if `src/physics/universe.js` fails to import
  (it matches universe.js to micrometres). `planets.js` uses a top-level `await import()` for this.

## How to test
* `node tools/run-tests.mjs terrain` — determinism, exact pad flattening (4000 random points), smooth blend (max slope < 7°
  on land/shallows), pad on land with the sea 3–10 km east and land to the west, Verda ocean fraction (≈ 63 %), Vesper seas,
  biome coverage (peaks, ice caps…), Cinder fissures, ≥ 300k samples/s on every body, seamless chunk edges, pad chunk,
  crater band-limiting (public API untouched by chunk builds), Cinder's wide fissure fields + heat channel, sky LUT
  (twilight falls monotonically, night ≪ day, Vesper twilight glow not green).
* Playtest repro scripts re-run after the fixes (`tests/playtest/`): `pt_worlds_nan.mjs` (0 NaN pixels on Pip, Vesper,
  Verda, MSAA on/off), `pt_worlds_eclipse.mjs` (dark ground + vessel mid-eclipse), `pt_worlds_nightleak.mjs` (Lune −12.6°:
  7.9k lit px, was 53.8k), `pt_worlds_seasky.mjs` (Vesper −3°: horizon glow (38,25,48) pink, sea below the sky; Verda −4°:
  orange glow mirrored on the sea), `pt_return_reentry.mjs` (capsule / chute visible at night).
* `tests/planets.html#<preset>` (orbit controls, `[`/`]` shift time ±5 min, `h` hides the HUD, `?q=low|medium|high`,
  `?clean=1`). Presets: `pad`, `sunset`, `lowOrbit`, `space`, `lune`, `rusta`, `vesper`, `pip` (required) plus
  `mountains`, `coast`, `beach`, `cinder`, `nib`, `lunesurface`, `rustasurface`, `vespersurface`, `pipsurface`,
  `eclipse`, `terminator`, `deep` (1e11 m), `moonrise`, `dusk`, `alt15`, `descent` (animated 150 km → 150 m descent
  without prewarm: LOD streaming test). Regression views for the playtest findings: `luneeclipse` (Lune in Verda's
  shadow), `lunepenumbra`, `verdaeclipse` / `rustaeclipse` (moon shadows on planets), `luneshine` / `nibshine`
  (planetshine), `verdafromlune` (9° lens), `lunenight` (airless terminator), `rustasunset` vs `rustaafternoon`,
  `verdaseaset` / `vesperseaset` / `vespertwilight` (sea reflections, twilight colour), `cindernight` / `cinderday` /
  `cinderlow` / `cindersurface` (fissures), `lunehigh` (maria specks), `ascent8` (land colour from 8 km).
  Screenshots: `node tools/snap.mjs "tests/planets.html#pad" --out shots/worlds_pad.png --wait 6000`
  (`shots/worlds_*.png` hold the latest set). The HUD shows fps, draw calls, `update()` CPU time and LOD stats.

## Performance (measured)
* `update()` CPU time: 0.1–0.3 ms per frame typical, < 1.5 ms worst case (chunk uploads), everything else is in workers.
* Chunk counts (visible after horizon culling, before frustum culling) at the pad: high ≈ 455, medium ≈ 370, low ≈ 277;
  typically 150–250 draw calls on screen at the pad, 40–120 in orbit, < 10 in deep space.
* GPU memory ≈ 35 B/vertex → ≈ 40 KB per high-quality chunk (+ ocean patch where needed).
* Headless SwiftShader renders are slow (2–15 fps); on real GPUs the heaviest parts are the sky shell (16 samples/pixel
  when inside an atmosphere) and the per-vertex aerial perspective (6 samples/vertex).

## Integration notes (flight scene / space center)
* Camera: use `logarithmicDepthBuffer` (main.js does), `near` ≈ 0.1–0.5 m and `far` ≥ 1e12 so distant planets are not
  clipped (the sun billboard is automatically pulled inside `far`).
* Call `planets.update(camera, originRootPos, ut)` **after** the camera has its final transform for the frame
  (including shake). All shader uniforms are in scene space, so a late camera nudge is harmless; LOD choice just lags a frame.
* Add vessels etc. to the scene yourself; for the launch pad / KSC use `planets.bodyFixedGroup('verda')` with body-fixed
  coordinates (as spaceCenter.js already does).
* `planets.shadowExtent = <metres>` whenever the vessel size changes; the shadow camera is re-fitted automatically.
* Loading screens: `planets.prewarm(camera, origin, ut, 2000)` builds the full LOD synchronously (≈ 0.5–1.5 s at the pad)
  so the first frame is sharp. Without it the coarse base is shown and refined over ~1 s by the workers.
* Materials: vessel parts that are `MeshStandardMaterial` get `planets.envMap` via `scene.environment`; the hemisphere
  light adds a soft fill for other material types. If a scene uses its own hemi light, lower `planets.hemiScale`.
* Render order used: stars/milky way/planet dots −1001…−999 (opaque list, depthTest off), sun −90, ocean −60,
  atmosphere shell −50, clouds −45, lens flare 1000 (transparent list). Custom transparent effects at renderOrder ≥ 0 draw after the sky,
  so smoke and plumes are never tinted by the shell.
* Bloom: the sun disc is ≈ 60× HDR and fissures/glints exceed 1.0 — `UnrealBloomPass` with threshold ≈ 1 picks them up.
* Map view / HUD can use `terrainSample()` colours and `biomeName()` directly (both cheap).

## Known issues / limitations
* No cast shadows from terrain (mountains don't shadow the valley or the vessel); relief shading only (the airless
  body-shadow term is per vertex against the mean sphere, so crater rims near the terminator don't cast long shadows yet).
* Planetshine is a single directional term from the parent's centre (no crescent-shaped source), and is not eclipsed.
* Scatter rocks are not physical (landing legs go through a boulder); they shrink away within ~5 m of the vessel.
* The daylight hemisphere light is quite blue (noon sky irradiance ≈ half the sun in the blue channel), so a white
  vessel's shady side looks cyan at the pad. Pre-existing; `hemiScale` can tone it down.
* Aerial perspective on terrain/ocean is per vertex: on very coarse far chunks there can be faint banding in the ocean glint.
* Clouds are a single 2D layer (no volumetric thickness); flying through it fades it out smoothly.
* The sun disc is a billboard (fine at planetary distances; flying *very* close to Sola just shows a huge glowing disc).
* Coastlines seen from far orbit follow the vertex resolution of the LOD level (slightly polygonal at < 10 px/quad).
* Vesper's thick atmosphere deliberately hazes its surface from orbit (it is the "Eve" of this system).
* `planets.update()` after `dispose()` is a no-op.
