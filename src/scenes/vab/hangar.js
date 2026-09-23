// Procedural Vehicle Assembly Building interior: polished floor with bay markings, assembly platform, ribbed walls with
// light strips, roof trusses & lamps, the big door with a sliver of daylight, a launch-tower gantry, an overhead crane,
// props and signage. Lighting: warm key light with soft shadows, cool fill, rim light, hemisphere + room environment.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const STAND_TOP = 0.35;
export const HANGAR = { half: 60, height: 64 };
const FONT = '"Rajdhani", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

function canvasTexture(w, h, draw, { repeat = [1, 1], srgb = true, aniso = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function hazard(g, x, y, w, h, stripe = 24, colors = ['#ffc21a', '#15171a']) {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = colors[1]; g.fillRect(x, y, w, h);
  g.fillStyle = colors[0];
  for (let k = -h; k < w + h; k += stripe * 2) {
    g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + stripe, y + h); g.lineTo(x + k + stripe + h, y); g.lineTo(x + k + h, y); g.closePath(); g.fill();
  }
  g.restore();
}

// ───────────────────────── textures ─────────────────────────

function floorTextures(aniso) {
  const R = rng(7);
  const noise = document.createElement('canvas');
  noise.width = noise.height = 1024;
  const n = noise.getContext('2d');
  n.fillStyle = '#808080'; n.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 9000; i++) {
    const v = 110 + R() * 40 | 0;
    n.fillStyle = `rgba(${v},${v},${v},${0.05 + R() * 0.08})`;
    const s = 2 + R() * 24;
    n.fillRect(R() * 1024, R() * 1024, s, s * (0.3 + R()));
  }
  const map = canvasTexture(1024, 1024, (g) => {
    g.fillStyle = '#737c88'; g.fillRect(0, 0, 1024, 1024);
    g.globalAlpha = 0.55; g.drawImage(noise, 0, 0); g.globalAlpha = 1;
    // subtle tile tone variation (2×2 tiles of 4 m)
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      g.fillStyle = `rgba(${R() < 0.5 ? 255 : 0},${R() < 0.5 ? 255 : 0},255,${0.012 + R() * 0.02})`;
      g.fillRect(i * 512, j * 512, 512, 512);
    }
    // scuffs
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(30,32,38,${0.04 + R() * 0.07})`;
      g.lineWidth = 1 + R() * 3;
      g.beginPath(); const x = R() * 1024, y = R() * 1024; g.moveTo(x, y); g.quadraticCurveTo(x + R() * 60, y + R() * 20, x + R() * 120 - 40, y + R() * 40); g.stroke();
    }
    // seams
    g.fillStyle = 'rgba(20,24,30,0.75)';
    for (const p of [0, 512]) { g.fillRect(p, 0, 3, 1024); g.fillRect(0, p, 1024, 3); }
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (const p of [3, 515]) { g.fillRect(p, 0, 1, 1024); g.fillRect(0, p, 1024, 1); }
    // corner bolts
    g.fillStyle = 'rgba(25,28,32,0.6)';
    for (const x of [14, 498, 526, 1010]) for (const y of [14, 498, 526, 1010]) { g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill(); }
  }, { repeat: [15, 15], aniso });
  const rough = canvasTexture(1024, 1024, (g) => {
    g.fillStyle = '#6a6a6a'; g.fillRect(0, 0, 1024, 1024);
    g.globalAlpha = 0.9; g.drawImage(noise, 0, 0); g.globalAlpha = 1;
    g.fillStyle = '#d0d0d0';
    for (const p of [0, 512]) { g.fillRect(p, 0, 4, 1024); g.fillRect(0, p, 1024, 4); }
  }, { repeat: [15, 15], srgb: false, aniso });
  return { map, rough };
}

function bayMarkings(aniso) {
  const S = 2048, M = 32;             // texture px, meters covered
  const px = S / M;
  return canvasTexture(S, S, (g) => {
    g.clearRect(0, 0, S, S);
    const c = S / 2;
    const ring = (r, w, color) => { g.strokeStyle = color; g.lineWidth = w * px; g.beginPath(); g.arc(c, c, r * px, 0, Math.PI * 2); g.stroke(); };
    ring(15.2, 0.12, 'rgba(255,194,26,0.85)');
    ring(14.6, 0.04, 'rgba(255,255,255,0.35)');
    ring(8.6, 0.05, 'rgba(255,255,255,0.4)');
    // hazard ring 6.2..7.0 m
    g.save();
    g.beginPath(); g.arc(c, c, 7.0 * px, 0, Math.PI * 2); g.arc(c, c, 6.2 * px, 0, Math.PI * 2, true); g.clip();
    g.fillStyle = '#15171a'; g.fillRect(0, 0, S, S);
    g.translate(c, c);
    for (let a = 0; a < 72; a++) {
      g.rotate(Math.PI * 2 / 72);
      if (a % 2) continue;
      g.fillStyle = '#ffc21a';
      g.beginPath(); g.moveTo(6.1 * px, 0); g.lineTo(7.1 * px, 0.45 * px); g.lineTo(7.1 * px, 1.25 * px); g.lineTo(6.1 * px, 0.8 * px); g.closePath(); g.fill();
    }
    g.restore();
    // ticks every 5°, long every 30°
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let a = 0; a < 72; a++) {
      const ang = a * Math.PI / 36, long = a % 6 === 0;
      const r0 = (long ? 7.4 : 7.6) * px, r1 = (long ? 8.5 : 8.1) * px;
      g.lineWidth = (long ? 0.08 : 0.035) * px;
      g.beginPath(); g.moveTo(c + Math.cos(ang) * r0, c + Math.sin(ang) * r0); g.lineTo(c + Math.cos(ang) * r1, c + Math.sin(ang) * r1); g.stroke();
    }
    // crosshair lanes
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 0.06 * px;
    g.setLineDash([0.8 * px, 0.5 * px]);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      g.beginPath(); g.moveTo(c - dx * 15 * px, c - dy * 15 * px); g.lineTo(c - dx * 8.8 * px, c - dy * 8.8 * px); g.stroke();
      g.beginPath(); g.moveTo(c + dx * 8.8 * px, c + dy * 8.8 * px); g.lineTo(c + dx * 15 * px, c + dy * 15 * px); g.stroke();
    }
    g.setLineDash([]);
    // circular text
    const text = '  TINY SPACE PROGRAM  ·  VEHICLE ASSEMBLY BUILDING  ·  BAY 01  ·  MIND THE BOOSTERS  ·';
    g.font = `700 ${0.62 * px}px ${FONT}`;
    g.fillStyle = 'rgba(255,255,255,0.42)';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const R = 11.6 * px;
    const total = text.length;
    for (let i = 0; i < total; i++) {
      const a = (i / total) * Math.PI * 2 - Math.PI / 2;
      g.save(); g.translate(c + Math.cos(a) * R, c + Math.sin(a) * R); g.rotate(a + Math.PI / 2); g.fillText(text[i], 0, 0); g.restore();
    }
    // cardinal letters
    g.font = `700 ${1.1 * px}px ${FONT}`;
    g.fillStyle = 'rgba(255,194,26,0.75)';
    for (const [t, a] of [['N', -Math.PI / 2], ['E', 0], ['S', Math.PI / 2], ['W', Math.PI]]) {
      g.save(); g.translate(c + Math.cos(a) * 13.3 * px, c + Math.sin(a) * 13.3 * px); g.rotate(a + Math.PI / 2); g.fillText(t, 0, 0); g.restore();
    }
  }, { aniso });
}

function wallTexture(aniso) {
  return canvasTexture(512, 512, (g) => {
    const grd = g.createLinearGradient(0, 0, 512, 0);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      grd.addColorStop(Math.min(1, t), i % 2 ? '#8b95a3' : '#a5afbd');
    }
    g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
    // rib shading
    for (let i = 0; i < 8; i++) {
      const x = i * 64;
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(x + 4, 0, 4, 512);
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x + 58, 0, 6, 512);
    }
    // panel seams + rivets
    g.fillStyle = 'rgba(30,35,45,0.55)'; g.fillRect(0, 0, 512, 5); g.fillRect(0, 256, 512, 3);
    g.fillStyle = 'rgba(40,44,52,0.5)';
    for (let x = 16; x < 512; x += 32) for (const y of [12, 266]) { g.beginPath(); g.arc(x, y, 2.4, 0, 7); g.fill(); }
    // grime towards the bottom
    const dirt = g.createLinearGradient(0, 380, 0, 512);
    dirt.addColorStop(0, 'rgba(40,36,30,0)'); dirt.addColorStop(1, 'rgba(40,36,30,0.18)');
    g.fillStyle = dirt; g.fillRect(0, 380, 512, 132);
  }, { repeat: [30, 8], aniso });
}

function doorTexture(aniso) {
  return canvasTexture(1024, 1024, (g, W, H) => {
    g.fillStyle = '#b9c1cc'; g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 32) {
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x + 3, 0, 3, H);
      g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x + 27, 0, 5, H);
    }
    for (let y = 0; y < H; y += 128) { g.fillStyle = 'rgba(30,35,45,0.45)'; g.fillRect(0, y, W, 6); }
    hazard(g, 0, H - 70, W, 70, 30);
    hazard(g, 0, 0, W, 26, 30);
    // big painted numerals + roundel
    g.save();
    g.translate(W / 2, H * 0.44);
    g.fillStyle = 'rgba(30,70,160,0.85)';
    g.beginPath(); g.arc(0, 0, 190, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#f2f4f8'; g.lineWidth = 16; g.beginPath(); g.arc(0, 0, 150, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ff6a1a';
    g.beginPath(); g.moveTo(0, -120); g.quadraticCurveTo(52, -40, 38, 70); g.lineTo(-38, 70); g.quadraticCurveTo(-52, -40, 0, -120); g.fill();
    g.fillStyle = '#f2f4f8';
    g.beginPath(); g.moveTo(-38, 70); g.lineTo(-72, 110); g.lineTo(-30, 96); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(38, 70); g.lineTo(72, 110); g.lineTo(30, 96); g.closePath(); g.fill();
    g.fillStyle = '#3fa9ff'; g.beginPath(); g.arc(0, -20, 18, 0, 7); g.fill();
    g.restore();
    g.fillStyle = 'rgba(28,32,40,0.82)';
    g.font = `700 150px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('VAB · 01', W / 2, H * 0.83);
  }, { aniso });
}

function bannerTexture(aniso) {
  return canvasTexture(1024, 320, (g, W, H) => {
    g.fillStyle = '#10151d'; g.fillRect(0, 0, W, H);
    hazard(g, 0, 0, W, 22, 18); hazard(g, 0, H - 22, W, 22, 18);
    g.textAlign = 'center';
    g.fillStyle = '#ffc21a'; g.font = `700 58px ${FONT}`;
    g.fillText('DAYS SINCE LAST', W / 2 - 110, 100);
    g.fillText('RAPID UNPLANNED DISASSEMBLY', W / 2 - 110, 168);
    g.fillStyle = '#ff4f45';
    g.fillRect(W - 250, 50, 190, 190);
    g.fillStyle = '#10151d'; g.fillRect(W - 240, 60, 170, 170);
    g.fillStyle = '#ff4f45'; g.font = `700 170px ${FONT}`;
    g.fillText('0', W - 155, 210);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = `600 30px ${FONT}`;
    g.fillText('SAFETY IS EVERYONE\'S JOB  ·  WEAR YOUR HELMET', W / 2 - 110, 240);
  }, { aniso });
}

function logoTexture(aniso) {
  return canvasTexture(1024, 512, (g, W, H) => {
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(242,244,248,0.92)';
    g.font = `700 150px ${FONT}`;
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('TINY', 40, 150);
    g.fillStyle = 'rgba(255,122,26,0.95)';
    g.fillText('SPACE', 40, 290);
    g.fillStyle = 'rgba(242,244,248,0.92)';
    g.fillText('PROGRAM', 40, 430);
  }, { aniso });
}

function crateTexture(aniso) {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#7a6443'; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 32) { g.fillStyle = y % 64 ? '#83704d' : '#6f5a3b'; g.fillRect(0, y, 256, 30); }
    g.strokeStyle = '#4b3b25'; g.lineWidth = 14; g.strokeRect(7, 7, 242, 242);
    g.beginPath(); g.moveTo(14, 14); g.lineTo(242, 242); g.stroke();
    g.fillStyle = 'rgba(20,20,20,0.7)'; g.font = `700 40px ${FONT}`; g.textAlign = 'center';
    g.fillText('TSP', 128, 110); g.font = `600 22px ${FONT}`; g.fillText('THIS SIDE UP ↑', 128, 150);
  }, { aniso });
}

function plateTexture(aniso) {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#50565f'; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 32) for (let x = 0; x < 256; x += 32) {
      g.save(); g.translate(x + ((y / 32) % 2) * 16 + 8, y + 16); g.rotate(((x + y) / 32) % 2 ? 0.8 : -0.8);
      g.fillStyle = 'rgba(210,220,235,0.22)'; g.fillRect(-9, -2.5, 18, 5);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(-9, 2, 18, 1.5);
      g.restore();
    }
  }, { repeat: [5, 5], aniso });
}

function hazardTexture(aniso, rep = 20) {
  return canvasTexture(256, 64, (g, W, H) => hazard(g, 0, 0, W, H, 24), { repeat: [rep, 1], aniso });
}

// ───────────────────────── builders ─────────────────────────

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();

function instanced(geo, mat, list, { cast = false, receive = true } = {}) {
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((it, i) => {
    _p.set(it.p[0], it.p[1], it.p[2]);
    _s.set(it.s?.[0] ?? 1, it.s?.[1] ?? 1, it.s?.[2] ?? 1);
    _q.setFromEuler(_e.set(it.r?.[0] ?? 0, it.r?.[1] ?? 0, it.r?.[2] ?? 0));
    im.setMatrixAt(i, _m4.compose(_p, _q, _s));
  });
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = cast; im.receiveShadow = receive;
  im.computeBoundingSphere();
  return im;
}

/** A beam between two points as an instance description for a unit box. */
function beam(a, b, t) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  _p.set(dx, dy, dz).normalize();
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _p);
  const e = new THREE.Euler().setFromQuaternion(_q);
  return { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], s: [t, len, t], r: [e.x, e.y, e.z] };
}

export class Hangar {
  constructor(renderer, scene, { quality = 'high', shadows = true } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'hangar';
    scene.add(this.group);
    this.disposables = [];
    this.time = 0;
    this.quality = quality;
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1);
    this.aniso = aniso;
    const D = (x) => { this.disposables.push(x); return x; };
    this.D = D;

    // Environment for PBR reflections
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTarget = D(pmrem.fromScene(room, 0.03));
    this.envMap = this.envTarget.texture;
    room.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); } });
    pmrem.dispose();
    scene.environment = this.envMap;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.55;
    scene.background = new THREE.Color(0x1b222c);
    scene.fog = new THREE.Fog(0x55606e, 70, 190);

    this._buildShell(D, aniso);
    this._buildPlatform(D, aniso);
    this._buildGantry(D);
    this._buildCrane(D);
    if (quality !== 'low') this._buildProps(D, aniso);
    this._buildLights(shadows);
  }

  _buildShell(D, aniso) {
    const { half, height } = HANGAR;
    const g = this.group;
    // Floor
    const ft = floorTextures(aniso);
    D(ft.map); D(ft.rough);
    const floorMat = D(new THREE.MeshStandardMaterial({ map: ft.map, roughnessMap: ft.rough, roughness: 0.72, metalness: 0.08, envMapIntensity: 0.6 }));
    const floor = new THREE.Mesh(D(new THREE.PlaneGeometry(half * 2, half * 2)), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    g.add(floor);
    // Bay markings decal
    const bay = D(bayMarkings(aniso));
    const bayMat = D(new THREE.MeshStandardMaterial({ map: bay, transparent: true, roughness: 0.6, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    const decal = new THREE.Mesh(D(new THREE.PlaneGeometry(32, 32)), bayMat);
    decal.rotation.x = -Math.PI / 2; decal.position.y = 0.01; decal.receiveShadow = true; decal.renderOrder = 1;
    g.add(decal);
    // Lanes toward the door (−Z)
    const laneMat = D(new THREE.MeshStandardMaterial({ color: 0xffc21a, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }));
    const laneGeo = D(new THREE.PlaneGeometry(0.22, 40));
    for (const x of [-7.5, 7.5]) {
      const lane = new THREE.Mesh(laneGeo, laneMat);
      lane.rotation.x = -Math.PI / 2; lane.position.set(x, 0.012, -36);
      lane.receiveShadow = true; g.add(lane);
    }
    // Walls
    const wt = D(wallTexture(aniso));
    const wallMat = D(new THREE.MeshStandardMaterial({ map: wt, roughness: 0.62, metalness: 0.35, envMapIntensity: 0.5 }));
    const wallGeo = D(new THREE.PlaneGeometry(half * 2, height));
    const walls = [[0, -half, 0], [0, half, Math.PI], [-half, 0, Math.PI / 2], [half, 0, -Math.PI / 2]];
    for (const [x, z, ry] of walls) {
      const w = new THREE.Mesh(wallGeo, wallMat);
      w.position.set(x, height / 2, z); w.rotation.y = ry; w.receiveShadow = true;
      g.add(w);
    }
    // Wainscot band + yellow cap line
    const wainMat = D(new THREE.MeshStandardMaterial({ color: 0x2c323a, roughness: 0.7, metalness: 0.3 }));
    const capMat = D(new THREE.MeshStandardMaterial({ color: 0xffc21a, roughness: 0.5, emissive: 0x3a2800, emissiveIntensity: 0.4 }));
    const boxGeo = D(new THREE.BoxGeometry(1, 1, 1));
    const wain = [], cap = [];
    for (const [x, z, ry] of walls) {
      const along = ry === 0 || ry === Math.PI;
      const sx = along ? half * 2 : 0.4, sz = along ? 0.4 : half * 2;
      const ox = x === 0 ? 0 : x - Math.sign(x) * 0.2, oz = z === 0 ? 0 : z - Math.sign(z) * 0.2;
      wain.push({ p: [ox, 1.3, oz], s: [sx, 2.6, sz] });
      cap.push({ p: [ox - (x ? Math.sign(x) * 0.05 : 0), 2.65, oz - (z ? Math.sign(z) * 0.05 : 0)], s: [along ? half * 2 : 0.45, 0.12, along ? 0.45 : half * 2] });
    }
    g.add(instanced(boxGeo, wainMat, wain));
    g.add(instanced(boxGeo, capMat, cap));
    // Pillars & girders
    const steel = D(new THREE.MeshStandardMaterial({ color: 0x3c434d, roughness: 0.45, metalness: 0.7 }));
    this.steel = steel;
    const pillars = [], girders = [];
    for (let t = -half + 6; t <= half - 6; t += 12) {
      pillars.push({ p: [t, height / 2, -half + 0.8], s: [1.4, height, 1.4] }, { p: [t, height / 2, half - 0.8], s: [1.4, height, 1.4] });
      pillars.push({ p: [-half + 0.8, height / 2, t], s: [1.4, height, 1.4] }, { p: [half - 0.8, height / 2, t], s: [1.4, height, 1.4] });
    }
    for (const y of [22, 44]) {
      girders.push({ p: [0, y, -half + 1], s: [half * 2, 1.2, 1] }, { p: [0, y, half - 1], s: [half * 2, 1.2, 1] });
      girders.push({ p: [-half + 1, y, 0], s: [1, 1.2, half * 2] }, { p: [half - 1, y, 0], s: [1, 1.2, half * 2] });
    }
    // Roof trusses
    for (let z = -half + 10; z <= half - 10; z += 10) {
      girders.push({ p: [0, height - 3, z], s: [half * 2, 1.6, 0.8] });
      girders.push({ p: [0, height - 6.5, z], s: [half * 2, 0.4, 0.4] });
    }
    for (let x = -half + 10; x <= half - 10; x += 10) girders.push({ p: [x, height - 1.2, 0], s: [0.6, 0.8, half * 2] });
    g.add(instanced(boxGeo, steel, pillars));
    g.add(instanced(boxGeo, steel, girders));
    // Ceiling
    const ceilMat = D(new THREE.MeshStandardMaterial({ color: 0x252b33, roughness: 0.9, metalness: 0.2 }));
    const ceil = new THREE.Mesh(D(new THREE.PlaneGeometry(half * 2, half * 2)), ceilMat);
    ceil.rotation.x = Math.PI / 2; ceil.position.y = height;
    g.add(ceil);
    // Light strips (emissive) along the walls under each girder and on the roof trusses
    const stripMat = D(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xd9ecff, emissiveIntensity: 2.4, roughness: 0.4 }));
    const strips = [];
    for (const y of [20.9, 42.9]) {
      strips.push({ p: [0, y, -half + 1.6], s: [half * 1.7, 0.3, 0.25] }, { p: [0, y, half - 1.6], s: [half * 1.7, 0.3, 0.25] });
      strips.push({ p: [-half + 1.6, y, 0], s: [0.25, 0.3, half * 1.7] }, { p: [half - 1.6, y, 0], s: [0.25, 0.3, half * 1.7] });
    }
    for (let z = -half + 10; z <= half - 10; z += 10) strips.push({ p: [0, height - 6.85, z], s: [half * 1.6, 0.2, 0.3] });
    g.add(instanced(boxGeo, stripMat, strips));
    // Lamp fixtures
    const lampMat = D(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dc, emissiveIntensity: 3.2 }));
    const lampGeo = D(new THREE.CylinderGeometry(1.1, 1.4, 0.5, 24));
    const lamps = [];
    for (let x = -40; x <= 40; x += 20) for (let z = -40; z <= 40; z += 20) lamps.push({ p: [x, height - 4.2, z] });
    g.add(instanced(lampGeo, lampMat, lamps));
    // Door (back wall, −Z)
    const dt = D(doorTexture(aniso));
    const doorMat = D(new THREE.MeshStandardMaterial({ map: dt, roughness: 0.55, metalness: 0.45 }));
    const dw = 38, dh = 50;
    const doorGeo = D(new THREE.BoxGeometry(dw / 2, dh, 0.8));
    // two halves, UV-split so the painted roundel spans both
    const uvL = doorGeo.clone(); const uvR = doorGeo.clone();
    D(uvL); D(uvR);
    for (const [geo, off] of [[uvL, 0], [uvR, 0.5]]) {
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + off);
      uv.needsUpdate = true;
    }
    const gap = 1.4;
    const left = new THREE.Mesh(uvL, doorMat);
    left.position.set(-dw / 4 - gap / 2, dh / 2, -half + 0.9);
    const right = new THREE.Mesh(uvR, doorMat);
    right.position.set(dw / 4 + gap / 2, dh / 2, -half + 0.9);
    left.receiveShadow = right.receiveShadow = true;
    g.add(left, right);
    // daylight through the gap
    const skyTex = D(canvasTexture(8, 256, (c, W, H) => {
      const gr = c.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, '#9fd0ff'); gr.addColorStop(0.75, '#e8f4ff'); gr.addColorStop(0.92, '#fff4dc'); gr.addColorStop(1, '#8a9a7a');
      c.fillStyle = gr; c.fillRect(0, 0, W, H);
    }));
    const sky = new THREE.Mesh(D(new THREE.PlaneGeometry(gap + 0.6, dh)), D(new THREE.MeshBasicMaterial({ map: skyTex, toneMapped: false, fog: false })));
    sky.position.set(0, dh / 2, -half + 0.35);
    g.add(sky);
    // door frame lintel with hazard stripes
    const hz = D(hazardTexture(aniso, 12));
    const lintelMat = D(new THREE.MeshStandardMaterial({ map: hz, roughness: 0.55, metalness: 0.3 }));
    const lintel = new THREE.Mesh(boxGeo, lintelMat);
    lintel.scale.set(dw + 6, 2.2, 1.6); lintel.position.set(0, dh + 1.1, -half + 1);
    g.add(lintel);
    for (const x of [-(dw / 2 + 2), dw / 2 + 2]) {
      const jamb = new THREE.Mesh(boxGeo, steel);
      jamb.scale.set(2, dh, 1.8); jamb.position.set(x, dh / 2, -half + 1);
      g.add(jamb);
    }
    // warm spill of daylight on the floor in front of the gap
    const spillTex = D(canvasTexture(64, 256, (c, W, H) => {
      const gr = c.createLinearGradient(0, H, 0, 0);
      gr.addColorStop(0, 'rgba(255,244,220,0.55)'); gr.addColorStop(1, 'rgba(255,244,220,0)');
      c.fillStyle = gr; c.fillRect(0, 0, W, H);
      const gx = c.createLinearGradient(0, 0, W, 0);
      gx.addColorStop(0, 'rgba(0,0,0,1)'); gx.addColorStop(0.5, 'rgba(0,0,0,0)'); gx.addColorStop(1, 'rgba(0,0,0,1)');
      c.globalCompositeOperation = 'destination-out'; c.fillStyle = gx; c.fillRect(0, 0, W, H);
    }));
    const spill = new THREE.Mesh(D(new THREE.PlaneGeometry(4, 22)), D(new THREE.MeshBasicMaterial({ map: spillTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
    spill.rotation.x = -Math.PI / 2; spill.position.set(0, 0.02, -half + 11.5);
    g.add(spill);
    // Signage
    const banner = new THREE.Mesh(D(new THREE.PlaneGeometry(18, 5.6)), D(new THREE.MeshStandardMaterial({ map: D(bannerTexture(aniso)), roughness: 0.7, emissive: 0xffffff, emissiveIntensity: 0.06 })));
    banner.position.set(half - 0.3, 14, -14); banner.rotation.y = -Math.PI / 2;
    g.add(banner);
    const logo = new THREE.Mesh(D(new THREE.PlaneGeometry(24, 12)), D(new THREE.MeshStandardMaterial({ map: D(logoTexture(aniso)), transparent: true, roughness: 0.6, depthWrite: false })));
    logo.position.set(-half + 0.3, 32, 8); logo.rotation.y = Math.PI / 2;
    g.add(logo);
  }

  _buildPlatform(D, aniso) {
    const g = this.group;
    const side = D(hazardTexture(aniso, 16));
    const sideMat = D(new THREE.MeshStandardMaterial({ map: side, roughness: 0.55, metalness: 0.25 }));
    const topMat = D(new THREE.MeshStandardMaterial({ map: D(plateTexture(aniso)), roughness: 0.42, metalness: 0.75, envMapIntensity: 0.8 }));
    const plat = new THREE.Mesh(D(new THREE.CylinderGeometry(5, 5.2, STAND_TOP, 72)), [sideMat, topMat, topMat]);
    plat.position.y = STAND_TOP / 2;
    plat.receiveShadow = true; plat.castShadow = true;
    g.add(plat);
    // glowing rim + ring of marker lights
    const rimMat = D(new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffb45a, emissiveIntensity: 1.8 }));
    const rim = new THREE.Mesh(D(new THREE.TorusGeometry(5.02, 0.035, 8, 128)), rimMat);
    rim.rotation.x = Math.PI / 2; rim.position.y = STAND_TOP + 0.005;
    g.add(rim);
    const bulbMat = D(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x7fd0ff, emissiveIntensity: 2.4 }));
    const bulbs = [];
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      bulbs.push({ p: [Math.cos(a) * 5.55, 0.05, Math.sin(a) * 5.55], s: [0.16, 0.08, 0.16] });
    }
    this.bulbs = instanced(D(new THREE.CylinderGeometry(1, 1, 1, 12)), bulbMat, bulbs);
    g.add(this.bulbs);
  }

  _buildGantry(D) {
    const g = this.group;
    const red = D(new THREE.MeshStandardMaterial({ color: 0xc8452a, roughness: 0.5, metalness: 0.45 }));
    const yellow = D(new THREE.MeshStandardMaterial({ color: 0xf2b21a, roughness: 0.5, metalness: 0.3 }));
    const grate = D(new THREE.MeshStandardMaterial({ color: 0x4a5059, roughness: 0.5, metalness: 0.7 }));
    const box = D(new THREE.BoxGeometry(1, 1, 1));
    const cx = -9.5, cz = -4.5, w = 3.2, H = 38, seg = 3.4;
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - w / 2, z1 = cz + w / 2;
    const members = [];
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) members.push({ p: [x, H / 2, z], s: [0.32, H, 0.32] });
    for (let y = 0; y < H - 0.1; y += seg) {
      const ya = y, yb = Math.min(H, y + seg);
      for (const [a, b] of [[[x0, z0], [x1, z0]], [[x1, z0], [x1, z1]], [[x1, z1], [x0, z1]], [[x0, z1], [x0, z0]]]) {
        members.push(beam([a[0], yb, a[1]], [b[0], yb, b[1]], 0.18));
        members.push(beam([a[0], ya, a[1]], [b[0], yb, b[1]], 0.12));
      }
    }
    g.add(instanced(box, red, members, { cast: true }));
    // Service arms toward the craft (+X)
    const arms = [], rails = [];
    for (const y of [7, 14, 21, 28]) {
      const ax0 = x1, ax1 = -4.6;
      arms.push({ p: [(ax0 + ax1) / 2, y, cz + 1.2], s: [ax1 - ax0, 0.16, 1.5] });
      arms.push({ p: [(ax0 + ax1) / 2, y - 0.35, cz + 1.2], s: [ax1 - ax0, 0.5, 0.2] });
      for (const dz of [-0.72, 0.72]) {
        rails.push({ p: [(ax0 + ax1) / 2, y + 1.0, cz + 1.2 + dz], s: [ax1 - ax0, 0.06, 0.06] });
        rails.push({ p: [(ax0 + ax1) / 2, y + 0.5, cz + 1.2 + dz], s: [ax1 - ax0, 0.04, 0.04] });
        for (let x = ax0 + 0.2; x <= ax1; x += 1.1) rails.push({ p: [x, y + 0.5, cz + 1.2 + dz], s: [0.05, 1.0, 0.05] });
      }
      rails.push({ p: [ax1, y + 0.5, cz + 1.2], s: [0.05, 1.0, 1.5] });
    }
    // Platforms inside the tower
    for (let y = seg; y < H; y += seg * 2) arms.push({ p: [cx, y + 0.08, cz], s: [w - 0.1, 0.12, w - 0.1] });
    g.add(instanced(box, grate, arms, { cast: true }));
    g.add(instanced(box, yellow, rails, { cast: true }));
    // Beacons on top
    this.beaconMat = D(new THREE.MeshStandardMaterial({ color: 0xff3a2a, emissive: 0xff2a1a, emissiveIntensity: 3 }));
    const bgeo = D(new THREE.SphereGeometry(0.22, 12, 8));
    this.beacons = [];
    for (const [x, z] of [[x0, z0], [x1, z1]]) {
      const b = new THREE.Mesh(bgeo, this.beaconMat);
      b.position.set(x, H + 0.3, z);
      g.add(b); this.beacons.push(b);
    }
  }

  _buildCrane(D) {
    const g = this.group;
    const { half } = HANGAR;
    const yellow = D(new THREE.MeshStandardMaterial({ color: 0xe8a818, roughness: 0.5, metalness: 0.4 }));
    const dark = this.steel;
    const box = D(new THREE.BoxGeometry(1, 1, 1));
    const parts = [];
    const y = 52;
    for (const z of [-1.4, 1.4]) parts.push({ p: [0, y, z], s: [half * 2 - 4, 1.4, 0.7] });
    for (let x = -half + 4; x <= half - 4; x += 4) parts.push({ p: [x, y, 0], s: [0.3, 1.2, 2.8] });
    g.add(instanced(box, yellow, parts));
    // end trucks on rails
    const rails = [{ p: [-half + 2, y + 1, 0], s: [1.5, 1.4, half * 2 - 2] }, { p: [half - 2, y + 1, 0], s: [1.5, 1.4, half * 2 - 2] }];
    g.add(instanced(box, dark, rails));
    // trolley + cable + hook, hung slightly off-axis so it never hides the craft
    this.hook = new THREE.Group();
    this.hook.position.set(6, y - 0.8, 0);
    const trolley = new THREE.Mesh(box, dark); trolley.scale.set(2.4, 1.2, 3.4);
    const cable = new THREE.Mesh(D(new THREE.CylinderGeometry(0.035, 0.035, 9, 6)), dark);
    cable.position.y = -5.1;
    const block = new THREE.Mesh(box, yellow); block.scale.set(0.9, 1.1, 0.5); block.position.y = -10;
    const hookGeo = D(new THREE.TorusGeometry(0.45, 0.11, 8, 20, Math.PI * 1.5));
    const hk = new THREE.Mesh(hookGeo, dark); hk.position.y = -11.1; hk.rotation.z = Math.PI * 0.75;
    this.hook.add(trolley, cable, block, hk);
    this.hookSwing = new THREE.Group();
    this.hookSwing.add(cable, block, hk);
    this.hook.add(this.hookSwing);
    g.add(this.hook);
  }

  _buildProps(D, aniso) {
    const g = this.group;
    const { half } = HANGAR;
    const R = rng(42);
    const crateMat = D(new THREE.MeshStandardMaterial({ map: D(crateTexture(aniso)), roughness: 0.85 }));
    const box = D(new THREE.BoxGeometry(1, 1, 1));
    const crates = [];
    const pile = (x, z, n) => {
      for (let i = 0; i < n; i++) {
        const s = 1.2 + R() * 0.6;
        const level = i < 3 ? 0 : 1;
        crates.push({ p: [x + (i % 3) * 1.9 - 1.9 + R() * 0.2, s / 2 + level * 1.5, z + R() * 0.4], s: [s, s, s], r: [0, R() * 0.3 - 0.15, 0] });
      }
    };
    pile(half - 6, half - 5, 5); pile(-half + 7, half - 6, 4); pile(half - 8, -half + 18, 3);
    g.add(instanced(box, crateMat, crates, { cast: false }));
    const barrelGeo = D(new THREE.CylinderGeometry(0.45, 0.45, 1.25, 18));
    const blue = D(new THREE.MeshStandardMaterial({ color: 0x2c6fd6, roughness: 0.45, metalness: 0.3 }));
    const orng = D(new THREE.MeshStandardMaterial({ color: 0xf2862a, roughness: 0.45, metalness: 0.3 }));
    const b1 = [], b2 = [];
    for (let i = 0; i < 6; i++) b1.push({ p: [-half + 3 + (i % 3) * 1.0, 0.63, -half + 20 + Math.floor(i / 3) * 1.0] });
    for (let i = 0; i < 5; i++) b2.push({ p: [half - 3 - (i % 3) * 1.0, 0.63, 10 + Math.floor(i / 3) * 1.0] });
    g.add(instanced(barrelGeo, blue, b1), instanced(barrelGeo, orng, b2));
    // traffic cones around the bay
    const coneGeo = D(new THREE.ConeGeometry(0.22, 0.7, 16));
    coneGeo.translate(0, 0.35, 0);
    const coneMat = D(new THREE.MeshStandardMaterial({ color: 0xff5a1a, roughness: 0.55, emissive: 0x220800 }));
    const cones = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      cones.push({ p: [Math.cos(a) * 9.4, 0, Math.sin(a) * 9.4] });
    }
    g.add(instanced(coneGeo, coneMat, cones));
    // tool cart & workbench
    const bench = D(new THREE.MeshStandardMaterial({ color: 0x3d5a80, roughness: 0.5, metalness: 0.4 }));
    const items = [
      { p: [11, 0.5, 6], s: [2.4, 1.0, 1.0] }, { p: [11, 1.05, 6], s: [2.5, 0.1, 1.1] },
      { p: [12.8, 0.45, 8.4], s: [1.0, 0.9, 0.7] },
    ];
    g.add(instanced(box, bench, items, { cast: true }));
  }

  _buildLights(shadows) {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight(0xe2ecff, 0x3a3028, 0.55);
    s.add(this.hemi);
    const key = new THREE.DirectionalLight(0xfff0dc, 2.3);
    key.position.set(14, 30, 18);
    key.target.position.set(0, 4, 0);
    key.castShadow = !!shadows;
    const sz = this.quality === 'high' ? 2048 : 1024;
    key.shadow.mapSize.set(sz, sz);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.camera.near = 1; key.shadow.camera.far = 120;
    s.add(key, key.target);
    this.key = key;
    this.keyDir = key.position.clone().sub(key.target.position).normalize();
    const fill = new THREE.DirectionalLight(0x9ec2ff, 0.6);
    fill.position.set(-20, 14, -8);
    s.add(fill);
    const rim = new THREE.DirectionalLight(0xcfe3ff, 0.9);
    rim.position.set(-6, 22, -30);
    s.add(rim);
    this.lights = [this.hemi, key, key.target, fill, rim];
    this.fitShadow(new THREE.Vector3(0, 4, 0), 8);
  }

  /** Fit the key light's shadow frustum around the craft (scene coords). */
  fitShadow(center, radius) {
    const key = this.key;
    const r = Math.max(4, radius * 1.25);
    key.target.position.copy(center);
    key.position.copy(center).addScaledVector(this.keyDir, r + 40);
    const cam = key.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = r * 2 + 80;
    cam.updateProjectionMatrix();
    key.target.updateMatrixWorld();
  }

  update(dt) {
    this.time += dt;
    const blink = (Math.sin(this.time * 3.2) > 0.2) ? 3.2 : 0.25;
    if (this.beaconMat) this.beaconMat.emissiveIntensity = blink;
    if (this.hookSwing) {
      this.hookSwing.rotation.z = Math.sin(this.time * 0.6) * 0.012;
      this.hookSwing.rotation.x = Math.sin(this.time * 0.43 + 1) * 0.01;
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const l of this.lights) l.removeFromParent();
    this.key.shadow.map?.dispose();
    for (const d of this.disposables) d.dispose?.();
    this.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    if (this.scene.environment === this.envMap) this.scene.environment = null;
    this.disposables.length = 0;
  }
}
