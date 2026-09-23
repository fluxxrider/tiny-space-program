// Terrain API tests (worlds area): determinism, launch-site flattening, speed, ocean fraction, coastal pad, API shape.
import assert from 'node:assert/strict';
import { terrainHeight, surfaceHeight, terrainSample, isWater, biomeName, getTerrainGenerator, launchSiteDir } from '../src/world/terrain.js';
import { buildChunk, faceDir, dirToFace, makeIndices, vertexCount } from '../src/world/chunkBuilder.js';
import { Noise3, mulberry32 } from '../src/world/noise.js';
import { BODIES, BODY_ORDER, LAUNCH_SITE, latLonToDir } from '../src/data/bodies.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

const rand = mulberry32(20240922);
function randomDir() {
  const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}
const TERRAIN_BODIES = BODY_ORDER.filter(id => BODIES[id].terrain);
const R = BODIES.verda.radius;
const site = launchSiteDir();
// site-local tangent frame (east = north × up, per ARCHITECTURE.md)
const up = [site.x, site.y, site.z];
let north = [-up[1] * up[0], 1 - up[1] * up[1], -up[1] * up[2]];
{ const l = Math.hypot(...north); north = north.map(v => v / l); }
const east = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
function sitePoint(eM, nM) {
  const x = up[0] + (east[0] * eM + north[0] * nM) / R, y = up[1] + (east[1] * eM + north[1] * nM) / R, z = up[2] + (east[2] * eM + north[2] * nM) / R;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

console.log('terrain.test.mjs');

test('noise is deterministic and bounded', () => {
  const a = new Noise3(42), b = new Noise3(42), c = new Noise3(43);
  let diff = 0;
  for (let i = 0; i < 2000; i++) {
    const x = rand() * 100, y = rand() * 100, z = rand() * 100;
    const va = a.noise(x, y, z);
    assert.equal(va, b.noise(x, y, z));
    assert.ok(va >= -1.001 && va <= 1.001);
    if (va !== c.noise(x, y, z)) diff++;
  }
  assert.ok(diff > 1900, 'different seeds give different noise');
});

test('terrainHeight is deterministic for every body', () => {
  for (const id of TERRAIN_BODIES) {
    for (let i = 0; i < 300; i++) {
      const d = randomDir();
      const h1 = terrainHeight(id, ...d), h2 = terrainHeight(id, ...d);
      assert.equal(h1, h2, `${id} deterministic`);
      assert.ok(Number.isFinite(h1), `${id} finite`);
      assert.ok(Math.abs(h1) < BODIES[id].terrain.maxHeight * 1.6, `${id} height ${h1} within bounds`);
    }
  }
});

test('terrainSample agrees exactly with terrainHeight and has a sane shape', () => {
  const out = { color: [0, 0, 0] };
  for (const id of TERRAIN_BODIES) {
    for (let i = 0; i < 300; i++) {
      const d = randomDir();
      const s = terrainSample(id, ...d, out);
      assert.equal(s, out, 'writes into out');
      assert.equal(s.height, terrainHeight(id, ...d));
      assert.equal(s.water, isWater(id, ...d));
      assert.equal(typeof s.biome, 'string'); assert.ok(s.biome.length > 0);
      assert.equal(s.biome, biomeName(id, ...d));
      for (const c of s.color) assert.ok(c >= 0 && c <= 1 && Number.isFinite(c), `${id} colour in [0,1]`);
      const sh = surfaceHeight(id, ...d);
      if (BODIES[id].terrain.ocean) assert.equal(sh, Math.max(s.height, 0)); else assert.equal(sh, s.height);
    }
  }
  const fresh = terrainSample('lune', 0, 1, 0);
  assert.ok(Array.isArray(fresh.color) && fresh.color.length === 3);
});

test('bodies without terrain return 0', () => {
  assert.equal(terrainHeight('sola', 1, 0, 0), 0);
  assert.equal(surfaceHeight('sola', 0, 1, 0), 0);
  assert.equal(isWater('sola', 0, 0, 1), false);
  assert.equal(typeof biomeName('sola', 1, 0, 0), 'string');
  const s = terrainSample('sola', 1, 0, 0);
  assert.equal(s.height, 0);
});

test('launch pad is flattened to exactly LAUNCH_SITE.altitude', () => {
  const d = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon);
  assert.equal(terrainHeight('verda', d.x, d.y, d.z), LAUNCH_SITE.altitude);
  assert.equal(surfaceHeight('verda', d.x, d.y, d.z), LAUNCH_SITE.altitude);
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * LAUNCH_SITE.flattenRadius * 0.999;
    const p = sitePoint(Math.cos(a) * r, Math.sin(a) * r);
    assert.equal(terrainHeight('verda', ...p), LAUNCH_SITE.altitude, `flat at ${r.toFixed(1)} m`);
    n++;
  }
  assert.equal(n, 4000);
  assert.equal(biomeName('verda', d.x, d.y, d.z), 'Launch Site');
});

test('flatten zone blends smoothly (no cliffs) and stays on land', () => {
  let maxSlope = 0;
  for (let k = 0; k < 72; k++) {
    const a = k / 72 * Math.PI * 2;
    let prev = null;
    for (let r = 0; r <= LAUNCH_SITE.blendRadius + 500; r += 25) {
      const p = sitePoint(Math.cos(a) * r, Math.sin(a) * r);
      const h = terrainHeight('verda', ...p);
      // land & shallows (what you can see from the pad); the natural sea floor further out may be steeper
      if (prev !== null && h > -20 && prev > -20) maxSlope = Math.max(maxSlope, Math.abs(h - prev) / 25);
      if (r <= LAUNCH_SITE.blendRadius * 0.6) assert.ok(h > 5, `land near the pad (r=${r}, h=${h.toFixed(1)})`);
      prev = h;
    }
  }
  assert.ok(maxSlope < 0.12, `max slope ${maxSlope.toFixed(3)} (< 0.12 ≈ 7°)`);
});

test('launch pad sits near a coast (sea to the east within 10 km)', () => {
  let seaEast = Infinity;
  for (let e = 0; e <= 20000; e += 100) {
    if (isWater('verda', ...sitePoint(e, 0))) { seaEast = e; break; }
  }
  assert.ok(seaEast >= LAUNCH_SITE.blendRadius * 0.6 && seaEast <= 10000, `coast ${seaEast} m east of the pad`);
  // land to the west (inland)
  for (let w = 0; w <= 20000; w += 500) assert.ok(!isWater('verda', ...sitePoint(-w, 0)), `land ${w} m west`);
  // plenty of water around within 25 km
  let water = 0;
  for (let i = 0; i < 400; i++) {
    const a = rand() * Math.PI * 2, r = 5000 + rand() * 20000;
    if (isWater('verda', ...sitePoint(Math.cos(a) * r, Math.sin(a) * r))) water++;
  }
  assert.ok(water > 60 && water < 340, `mixed land & sea around the pad (${water}/400 water)`);
});

test('Verda ocean fraction is 50–70 %', () => {
  let water = 0; const N = 30000;
  for (let i = 0; i < N; i++) if (isWater('verda', ...randomDir())) water++;
  const f = water / N;
  console.log(`       Verda ocean fraction ${(f * 100).toFixed(1)} %`);
  assert.ok(f >= 0.5 && f <= 0.7, `ocean fraction ${f}`);
});

test('Vesper has seas; airless bodies have none', () => {
  let w = 0;
  for (let i = 0; i < 5000; i++) if (isWater('vesper', ...randomDir())) w++;
  assert.ok(w > 1000 && w < 4000, `vesper seas ${w}/5000`);
  for (const id of ['lune', 'pip', 'rusta', 'cinder', 'nib']) {
    for (let i = 0; i < 200; i++) assert.equal(isWater(id, ...randomDir()), false);
  }
});

test('Verda has snowy peaks and polar caps; cinder has glowing fissures', () => {
  const biomes = new Set();
  for (let i = 0; i < 20000; i++) biomes.add(biomeName('verda', ...randomDir()));
  for (const b of ['Grasslands', 'Forests', 'Shores', 'Mountains', 'Ice Caps']) assert.ok(biomes.has(b), `verda has ${b} (${[...biomes].join(', ')})`);
  const pole = terrainSample('verda', 0, 1, 0);
  assert.ok(pole.color[0] > 0.6 && pole.color[2] > 0.6, 'north pole is icy white');
  let glow = 0;
  const out = { color: [0, 0, 0] };
  for (let i = 0; i < 5000; i++) { terrainSample('cinder', ...randomDir(), out); if (out.glow > 0.3) glow++; }
  assert.ok(glow > 20, `cinder fissures glow (${glow})`);
});

test('terrainHeight speed ≥ 300k samples/s on every body', () => {
  const dirs = [];
  for (let i = 0; i < 60000; i++) dirs.push(randomDir());
  for (const id of TERRAIN_BODIES) {
    let s = 0;
    for (let i = 0; i < 5000; i++) s += terrainHeight(id, ...dirs[i]);   // warm-up
    const t0 = performance.now();
    for (let i = 0; i < dirs.length; i++) { const d = dirs[i]; s += terrainHeight(id, d[0], d[1], d[2]); }
    const rate = dirs.length / ((performance.now() - t0) / 1000);
    console.log(`       ${id.padEnd(7)} ${(rate / 1000).toFixed(0)}k samples/s`);
    assert.ok(Number.isFinite(s));
    assert.ok(rate >= 300000, `${id}: ${rate.toFixed(0)} samples/s`);
  }
});

test('cube-sphere mapping round-trips and chunks are seamless', () => {
  const o = [];
  for (let i = 0; i < 500; i++) {
    const d = randomDir();
    const f = dirToFace(...d);
    faceDir(f.face, f.s, f.t, o);
    assert.ok(Math.hypot(o[0] - d[0], o[1] - d[1], o[2] - d[2]) < 1e-9);
  }
  const N = 17;
  const a = buildChunk({ id: 1, bodyId: 'verda', face: 4, level: 5, ix: 11, iy: 20, N });
  const b = buildChunk({ id: 2, bodyId: 'verda', face: 4, level: 5, ix: 12, iy: 20, N });
  assert.equal(a.pos.length, vertexCount(N) * 3);
  for (let j = 0; j < N; j++) {
    const va = j * N + (N - 1), vb = j * N;
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs((a.pos[va * 3 + k] + a.center[k]) - (b.pos[vb * 3 + k] + b.center[k])) < 0.05, 'shared edge vertex positions match');
      assert.equal(a.nor[va * 3 + k], b.nor[vb * 3 + k], 'shared edge normals match');
    }
  }
  const idx = makeIndices(N);
  assert.ok(Math.max(...idx) < vertexCount(N));
  // vertices are stored relative to the chunk centre (small float32 values)
  let maxAbs = 0; for (const v of a.pos) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs < 60000, 'local positions are small');
});

test('pad chunk reproduces the flattened pad exactly', () => {
  const d = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon);
  const f = dirToFace(d.x, d.y, d.z);
  const level = 12, n = 1 << level;
  const ix = Math.floor((f.s + 1) / 2 * n), iy = Math.floor((f.t + 1) / 2 * n);
  const c = buildChunk({ id: 3, bodyId: 'verda', face: f.face, level, ix, iy, N: 33 });
  const r0 = Math.hypot(...c.center);
  assert.ok(Math.abs(r0 - (R + LAUNCH_SITE.altitude)) < 0.01, `chunk centre radius ${r0 - R}`);
});

test('chunk builds band-limit small craters without touching the public API (physics sees full detail)', () => {
  // a coarse Lune chunk: the builder samples with its vertex spacing, the public API must stay full-detail afterwards
  const dirs = []; for (let i = 0; i < 3000; i++) dirs.push(randomDir());
  const before = dirs.map(d => terrainHeight('lune', ...d));
  const g = getTerrainGenerator('lune');
  buildChunk({ id: 10, bodyId: 'lune', face: 2, level: 2, ix: 1, iy: 2, N: 17 });
  assert.equal(g._spacing, 0, 'spacing restored after a build');
  dirs.forEach((d, i) => assert.equal(terrainHeight('lune', ...d), before[i]));
  // with a coarse spacing the smallest crater octaves vanish: less small-scale variance, no single-vertex ejecta specks
  let ejFull = 0, ejCoarse = 0;
  const out = { color: [0, 0, 0] };
  for (const d of dirs) {
    g._spacing = 0; g.sample(...d, out); ejFull += g._crEj > 0.05 ? 1 : 0;
    g._spacing = 1500; g.sample(...d, out); ejCoarse += g._crEj > 0.05 ? 1 : 0;
  }
  g._spacing = 0;
  assert.ok(ejCoarse < ejFull * 0.6, `ejecta coverage drops at a coarse spacing (${ejFull} → ${ejCoarse})`);
  // the finest chunks (≈ 2 m spacing) keep every crater: their vertices equal terrainHeight exactly
  const d0 = latLonToDir(5, 20);
  const f = dirToFace(d0.x, d0.y, d0.z);
  const level = 14, n = 1 << level;
  const c = buildChunk({ id: 11, bodyId: 'lune', face: f.face, level, ix: Math.floor((f.s + 1) / 2 * n), iy: Math.floor((f.t + 1) / 2 * n), N: 33 });
  const cx = c.center[0], cy = c.center[1], cz = c.center[2];
  const r = Math.hypot(cx, cy, cz);
  assert.ok(Math.abs(r - (BODIES.lune.radius + terrainHeight('lune', cx / r, cy / r, cz / r))) < 1e-3, 'fine chunk centre on the physics surface');
});

test('cinder fissure fields are stored with a wide range (linear across coarse quads) plus plains heat', () => {
  const c = buildChunk({ id: 12, bodyId: 'cinder', face: 0, level: 2, ix: 1, iy: 1, N: 17 });
  assert.equal(c.extSize, 3);
  assert.equal(c.ext.length, vertexCount(17) * 3);
  assert.ok(c.extScale >= 256, `extScale ${c.extScale}`);
  let big = 0, hot = 0;
  for (let v = 0; v < 17 * 17; v++) {
    const fa = c.ext[v * 3] / 32767 * c.extScale;
    if (Math.abs(fa) > 20 && Math.abs(fa) < c.extScale * 0.99) big++;     // was clamped at ±9
    if (c.ext[v * 3 + 2] > 3000) hot++;
  }
  assert.ok(big > 20, `unclamped fissure values present (${big})`);
  assert.ok(hot > 0, 'plains heat channel filled');
  const other = buildChunk({ id: 13, bodyId: 'lune', face: 0, level: 2, ix: 1, iy: 1, N: 17 });
  assert.equal(other.extSize, 2);
});

// (render-side helper, but pure maths and node-importable: three.js only)
const { atmosphereParams, buildSkyLUT, sampleSkyLUT } = await import('../src/render/atmosphere.js');
test('sky LUT: twilight darkens smoothly, night is dark, Vesper twilight is not green', () => {
  for (const id of ['verda', 'rusta', 'vesper']) {
    const lut = buildSkyLUT(atmosphereParams(BODIES[id]));
    const E = (deg) => { const e = sampleSkyLUT(lut, 0, Math.sin(deg * Math.PI / 180)); return e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722; };
    let prev = E(30);
    for (const deg of [10, 4, 0, -4, -8, -14]) { const e = E(deg); assert.ok(e <= prev * 1.02, `${id}: irradiance falls at ${deg}° (${e} vs ${prev})`); prev = e; }
    assert.ok(E(-14) < E(30) * 0.05, `${id}: night sky much darker than day`);
  }
  const v = sampleSkyLUT(buildSkyLUT(atmosphereParams(BODIES.vesper)), 1, Math.sin(-3 * Math.PI / 180));
  assert.ok(v[1] <= Math.max(v[0], v[2]), `Vesper twilight glow towards the sun is not green (${v.map(x => x.toFixed(4))})`);
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall terrain tests passed');
