// Celestial body catalog. Stats follow KSP's stock system (scaled-down "tiny" planets) under original names.
// Frame conventions (see ARCHITECTURE.md §Frames):
//   - World/inertial axes: +Y = north (rotation axis of every body & normal of the ecliptic), XZ = equatorial/ecliptic plane.
//   - Prograde orbits & body spin are counter-clockwise seen from +Y (angular momentum along +Y).
//   - Orbit elements (angles in DEGREES here; orbit.js converts): inc from the XZ plane, lan/argPe per ARCHITECTURE.md.
//   - Body-fixed frame = inertial frame rotated about +Y by rotationAngle(ut) = initialRotation + 2π·ut/rotationPeriod.
//   - latLonToDir(lat, lon) = (cos lat·cos lon, sin lat, −cos lat·sin lon) in the body-fixed frame (east = increasing lon).

export const BODIES = {
  sola: {
    id: 'sola', name: 'Sola', type: 'star', parent: null,
    radius: 261600000, mu: 1.1723328e18, rotationPeriod: 432000, initialRotation: 0,
    soi: Infinity, atmosphere: null, orbit: null,
    color: '#fff1c0', mapColor: '#ffd75e',
    description: 'A friendly yellow star. Warm, bright, and absolutely not for landing on.',
    terrain: null,
    warpAltitudes: [0, 3e9, 3e9, 3e9, 3e9, 3e9, 3e9, 6e9],
  },
  cinder: {
    id: 'cinder', name: 'Cinder', type: 'planet', parent: 'sola',
    radius: 250000, mu: 1.6860938e11, rotationPeriod: 1210000, initialRotation: 3.14,
    soi: 9646663, atmosphere: null,
    orbit: { sma: 5263138304, ecc: 0.2, inc: 7, lan: 70, argPe: 15, meanAnomalyAtEpoch: 3.14, epoch: 0 },
    color: '#8a5a43', mapColor: '#b0714f',
    description: 'A scorched little world hugging the star. Cracked basalt plains and glowing fissures.',
    terrain: { style: 'scorched', maxHeight: 7000, ocean: false, seed: 11,
      palette: { low: '#3a2a24', mid: '#6b4a3a', high: '#9c7a64', accent: '#ff6a2a' } },
    warpAltitudes: [0, 10000, 10000, 10000, 25000, 50000, 100000, 200000],
  },
  vesper: {
    id: 'vesper', name: 'Vesper', type: 'planet', parent: 'sola',
    radius: 700000, mu: 8.1717302e12, rotationPeriod: 80500, initialRotation: 0,
    soi: 85109365,
    atmosphere: { height: 90000, pressureASL: 506.625, scaleHeight: 7200, temperatureASL: 420, temperatureTop: 160, densityASL: 6.2,
      rayleigh: [0.72, 0.42, 0.95], sunset: [1.0, 0.55, 0.85], hazeDensity: 1.6 },
    orbit: { sma: 9832684544, ecc: 0.01, inc: 2.1, lan: 15, argPe: 0, meanAnomalyAtEpoch: 3.14, epoch: 0 },
    color: '#9a6ad0', mapColor: '#b184f0',
    description: 'A purple world with a crushing atmosphere and shimmering violet seas. Easy to land on. Hard to leave.',
    terrain: { style: 'violet', maxHeight: 7500, ocean: true, seed: 23,
      palette: { ocean: '#3b1d6e', shore: '#7e5aa8', low: '#5c3d80', mid: '#7a5d96', high: '#b8a7cf' } },
    warpAltitudes: [0, 90000, 90000, 90000, 120000, 240000, 480000, 600000],
  },
  verda: {
    id: 'verda', name: 'Verda', type: 'planet', parent: 'sola',
    radius: 600000, mu: 3.5316e12, rotationPeriod: 21549.425,
    // Chosen so the launch site is in mid-morning sunlight at UT 0.
    initialRotation: 0.60318,
    soi: 84159286,
    atmosphere: { height: 70000, pressureASL: 101.325, scaleHeight: 5600, temperatureASL: 288, temperatureTop: 200, densityASL: 1.225,
      rayleigh: [0.30, 0.56, 1.0], sunset: [1.0, 0.55, 0.3], hazeDensity: 1.0 },
    orbit: { sma: 13599840256, ecc: 0, inc: 0, lan: 0, argPe: 0, meanAnomalyAtEpoch: 3.14, epoch: 0 },
    color: '#3f7fd1', mapColor: '#4f95ff',
    description: 'Home sweet home. Blue oceans, green hills, and a space program with more enthusiasm than safety codes.',
    terrain: { style: 'earthlike', maxHeight: 6700, ocean: true, seed: 42,
      palette: { ocean: '#1c4f8a', shallow: '#2f8fb5', sand: '#d8c98f', grass: '#4f8f3a', forest: '#2f6a2c', rock: '#7c6f60', snow: '#f2f5f8' } },
    warpAltitudes: [0, 70000, 70000, 70000, 120000, 240000, 480000, 600000],
  },
  lune: {
    id: 'lune', name: 'Lune', type: 'moon', parent: 'verda',
    radius: 200000, mu: 6.5138398e10, rotationPeriod: 138984.38, initialRotation: 1.7,
    soi: 2429559.1, atmosphere: null,
    orbit: { sma: 12000000, ecc: 0, inc: 0, lan: 0, argPe: 0, meanAnomalyAtEpoch: 1.7, epoch: 0 },
    color: '#a9a9a9', mapColor: '#c4c4c4',
    description: 'Verda\'s big grey moon. Craters on craters on craters. The first great destination.',
    terrain: { style: 'cratered', maxHeight: 7000, ocean: false, seed: 7,
      palette: { mare: '#5d5d62', low: '#8a8a8e', high: '#b9b9bd', ejecta: '#d8d8dc' } },
    warpAltitudes: [0, 5000, 5000, 10000, 25000, 50000, 100000, 200000],
  },
  pip: {
    id: 'pip', name: 'Pip', type: 'moon', parent: 'verda',
    radius: 60000, mu: 1.7658e9, rotationPeriod: 40400, initialRotation: 0.3,
    soi: 2247428.4, atmosphere: null,
    orbit: { sma: 47000000, ecc: 0, inc: 6, lan: 78, argPe: 38, meanAnomalyAtEpoch: 0.9, epoch: 0 },
    color: '#a8e6cf', mapColor: '#b6f5da',
    description: 'A tiny minty moon with glassy flats. Gravity so gentle you could jump into orbit. Almost.',
    terrain: { style: 'flats', maxHeight: 5700, ocean: false, seed: 99,
      palette: { flats: '#d9f7ec', low: '#9fe0c6', mid: '#7cc9ae', high: '#c6efe0' } },
    warpAltitudes: [0, 3000, 3000, 6000, 12000, 24000, 48000, 60000],
  },
  rusta: {
    id: 'rusta', name: 'Rusta', type: 'planet', parent: 'sola',
    radius: 320000, mu: 3.0136321e11, rotationPeriod: 65517.859, initialRotation: 1.0,
    soi: 47921949,
    atmosphere: { height: 50000, pressureASL: 6.75, scaleHeight: 3800, temperatureASL: 250, temperatureTop: 160, densityASL: 0.15,
      rayleigh: [0.95, 0.62, 0.45], sunset: [0.45, 0.6, 1.0], hazeDensity: 0.6 },
    orbit: { sma: 20726155264, ecc: 0.051, inc: 0.06, lan: 135.5, argPe: 0, meanAnomalyAtEpoch: 3.14, epoch: 0 },
    color: '#c1583a', mapColor: '#e06a45',
    description: 'The rusty red planet. Dusty canyons, ice caps, and a thin pink sky.',
    terrain: { style: 'desert', maxHeight: 8200, ocean: false, seed: 314,
      palette: { low: '#8a3b25', mid: '#b5583a', high: '#d88a62', ice: '#f3ece6' } },
    warpAltitudes: [0, 50000, 50000, 50000, 100000, 200000, 300000, 400000],
  },
  nib: {
    id: 'nib', name: 'Nib', type: 'moon', parent: 'rusta',
    radius: 130000, mu: 1.8568369e10, rotationPeriod: 65517.862, initialRotation: 0.4,
    soi: 1049598.9, atmosphere: null,
    orbit: { sma: 3200000, ecc: 0.03, inc: 0.2, lan: 0, argPe: 0, meanAnomalyAtEpoch: 1.7, epoch: 0 },
    color: '#7d7470', mapColor: '#9a908b',
    description: 'Rusta\'s lumpy grey companion, with surprisingly tall mountains.',
    terrain: { style: 'cratered', maxHeight: 11000, ocean: false, seed: 5,
      palette: { mare: '#4e4845', low: '#6f6763', high: '#9b928d', ejecta: '#bdb4ae' } },
    warpAltitudes: [0, 5000, 5000, 5000, 20000, 40000, 80000, 150000],
  },
};

export const BODY_ORDER = ['sola', 'cinder', 'vesper', 'verda', 'lune', 'pip', 'rusta', 'nib'];
export const ROOT_BODY = 'sola';
export const HOME_BODY = 'verda';

// The launch pad. Terrain within flattenRadius is flattened to exactly `altitude` meters ASL (terrain.js must honour this),
// so the pad surface is perfectly flat and physics/rendering agree.
export const LAUNCH_SITE = {
  bodyId: 'verda', name: 'Launch Pad',
  lat: -0.0972, lon: -74.5577,     // degrees
  altitude: 70,                    // m above sea level (top of pad surface)
  flattenRadius: 1500,             // m — perfectly flat within this radius…
  blendRadius: 5000,               // m — …smoothly blending back to natural terrain by this radius
  // Vessels spawn nose-up with local +X (pilot's right) pointing along this heading (180° = south), so the vessel top (+Z)
  // faces west and its belly (−Z) faces east: pitching down (W) tips the nose east and the navball stays level in the turn.
  heading: 180,
};

export function getBody(id) {
  const b = BODIES[id];
  if (!b) throw new Error('Unknown body: ' + id);
  return b;
}

/** Body-fixed unit direction for a latitude/longitude in degrees. Writes into `out` (array or {x,y,z}) if given. */
export function latLonToDir(latDeg, lonDeg, out = { x: 0, y: 0, z: 0 }) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  const c = Math.cos(la);
  out.x = c * Math.cos(lo); out.y = Math.sin(la); out.z = -c * Math.sin(lo);
  return out;
}

/** Inverse of latLonToDir for a (not necessarily unit) body-fixed vector. Returns degrees. */
export function dirToLatLon(x, y, z) {
  const r = Math.hypot(x, y, z) || 1;
  return { lat: Math.asin(Math.max(-1, Math.min(1, y / r))) * 180 / Math.PI, lon: Math.atan2(-z, x) * 180 / Math.PI };
}
