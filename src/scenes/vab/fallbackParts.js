// Fallback part meshes & icons for the VAB, used when src/render/partMeshes.js (parts3d) is unavailable or throws.
// Simple but faithful shapes: dimensions match def.radius/height/nodes and the srfAttach conventions.
import * as THREE from 'three';

let mats = null;
function materials() {
  if (mats) return mats;
  const std = (color, roughness = 0.5, metalness = 0.1, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  mats = {
    white: std(0xeeeeea, 0.45, 0.05),
    grey: std(0x8b919a, 0.4, 0.5),
    dark: std(0x2d3238, 0.5, 0.4),
    orange: std(0xff7a1f, 0.45, 0.05),
    yellow: std(0xffc21a, 0.45, 0.05),
    gold: std(0xd9a441, 0.3, 0.9),
    bell: std(0x3a3430, 0.6, 0.6, { side: THREE.DoubleSide }),
    glass: std(0x1d3550, 0.1, 0.2, { emissive: 0x0b2440, emissiveIntensity: 0.6 }),
    brown: std(0x5a3a28, 0.8, 0.0),
    solar: std(0x1f3c8a, 0.25, 0.6, { emissive: 0x06112a }),
    green: std(0x3fa04a, 0.5, 0.1),
  };
  mats.all = Object.values(mats);
  return mats;
}

const geoCache = new Map();
function geo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

function mesh(g, m, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true; o.receiveShadow = true;
  return o;
}

/** Build a fallback mesh group for a part definition. */
export function buildFallbackPart(def) {
  const M = materials();
  const g = new THREE.Group();
  const h = def.height, r = def.radius, rt = def.topRadius ?? r;
  const style = def.mesh?.style || '';
  const id = def.id;
  const band = (y, rr, hh, m = M.dark) => g.add(mesh(geo(`band${rr}:${hh}`, () => new THREE.CylinderGeometry(rr * 1.01, rr * 1.01, hh, 40)), m, 0, y));

  switch (style) {
    case 'capsule': case 'capsule3': case 'lander': {
      const top = style === 'lander' ? r * 0.8 : rt;
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(top, r, h, 40)), style === 'lander' ? M.grey : M.white));
      g.add(mesh(geo(id + 'w', () => new THREE.CylinderGeometry(top * 0.98 + (r - top) * 0.32, top * 0.98 + (r - top) * 0.5, h * 0.18, 40, 1, true, -0.5, 1.0)), M.glass, 0, h * 0.12));
      band(-h / 2 + 0.04, r, 0.08);
      break;
    }
    case 'probe': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r, r, h, 8)), M.gold));
      band(h / 2 - 0.03, r * 0.95, 0.06, M.dark); band(-h / 2 + 0.03, r * 0.95, 0.06, M.dark);
      break;
    }
    case 'tank': case 'tank_small': case 'tank_big': case 'tank_mono': {
      const body = style === 'tank_big' ? M.orange : style === 'tank_mono' ? M.yellow : M.white;
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r, r, h, 40)), body));
      band(h / 2 - 0.05, r, 0.1); band(-h / 2 + 0.05, r, 0.1);
      if (h > 1) band(0, r, 0.06, M.grey);
      break;
    }
    case 'srb': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r, r, h * 0.9, 32)), M.white, 0, h * 0.05));
      g.add(mesh(geo(id + 'n', () => new THREE.CylinderGeometry(r * 0.5, r * 0.62, h * 0.1, 24, 1, true)), M.bell, 0, -h * 0.45));
      band(h / 2 - 0.08, r, 0.16, M.orange); band(h * 0.05, r, 0.12, M.dark);
      break;
    }
    case 'engine': case 'nuclear': {
      const e = def.modules.engine;
      const nr = e?.nozzle?.radius ?? r * 0.7;
      const mountH = h * 0.38;
      g.add(mesh(geo(id + 'm', () => new THREE.CylinderGeometry(r, r * 0.85, mountH, 32)), style === 'nuclear' ? M.green : M.grey, 0, h / 2 - mountH / 2));
      g.add(mesh(geo(id + 'b', () => new THREE.CylinderGeometry(nr * 0.35, nr, h - mountH, 32, 1, true)), M.bell, 0, -mountH / 2));
      break;
    }
    case 'decoupler': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r, r, h, 40)), M.dark));
      band(0, r, h * 0.35, M.yellow);
      break;
    }
    case 'adapter': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(rt, r, h, 40)), M.white));
      break;
    }
    case 'nosecone': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r * 0.08, r, h, 40)), M.white));
      band(-h / 2 + 0.05, r, 0.1, M.orange);
      break;
    }
    case 'heatshield': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r * 0.96, r, h, 40)), M.brown));
      break;
    }
    case 'chute': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r * 0.55, r, h, 32)), M.orange));
      g.add(mesh(geo(id + 'c', () => new THREE.SphereGeometry(r * 0.55, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2)), M.white, 0, h / 2));
      break;
    }
    case 'fin': case 'fin_control': {
      const f = def.modules.fin;
      g.add(mesh(geo(id, () => {
        const s = new THREE.Shape();
        const rc = f.rootChord, tc = f.tipChord, sp = f.span;
        s.moveTo(0, -rc / 2); s.lineTo(0, rc / 2); s.lineTo(sp, -rc / 2 + tc); s.lineTo(sp, -rc / 2); s.closePath();
        const e = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false });
        e.translate(0, 0, -0.02);
        return e;
      }), style === 'fin_control' ? M.grey : M.white));
      break;
    }
    case 'radial_decoupler': {
      const t = def.mesh.thickness ?? 0.2, w = def.mesh.width ?? 0.35;
      g.add(mesh(geo(id, () => { const b = new THREE.BoxGeometry(t, h, w); b.translate(t / 2, 0, 0); return b; }), M.dark));
      g.add(mesh(geo(id + 's', () => { const b = new THREE.BoxGeometry(t * 1.02, h * 0.2, w * 1.02); b.translate(t / 2, 0, 0); return b; }), M.yellow));
      break;
    }
    case 'chute_radial': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(0.13, 0.13, h, 20)), M.white, 0.15, 0));
      g.add(mesh(geo(id + 'c', () => new THREE.CylinderGeometry(0.135, 0.135, h * 0.3, 20)), M.orange, 0.15, h * 0.3));
      break;
    }
    case 'leg': {
      g.add(mesh(geo(id + 'm', () => new THREE.BoxGeometry(0.12, 0.3, 0.2)), M.dark, 0.06, 0.4));
      g.add(mesh(geo(id + 's', () => new THREE.CylinderGeometry(0.045, 0.045, 1.0, 10)), M.grey, 0.13, -0.05));
      g.add(mesh(geo(id + 'f', () => new THREE.CylinderGeometry(0.16, 0.18, 0.06, 16)), M.dark, 0.15, -0.57));
      break;
    }
    case 'rcs': {
      g.add(mesh(geo(id, () => { const b = new THREE.BoxGeometry(0.12, 0.2, 0.16); b.translate(0.06, 0, 0); return b; }), M.white));
      g.add(mesh(geo(id + 'n', () => new THREE.SphereGeometry(0.05, 10, 8)), M.dark, 0.12, 0, 0));
      break;
    }
    case 'battery': {
      g.add(mesh(geo(id, () => { const b = new THREE.BoxGeometry(0.1, h, 0.2); b.translate(0.05, 0, 0); return b; }), M.dark));
      g.add(mesh(geo(id + 's', () => { const b = new THREE.BoxGeometry(0.102, h * 0.2, 0.202); b.translate(0.05, 0, 0); return b; }), M.yellow, 0, h * 0.25));
      break;
    }
    case 'solar': {
      g.add(mesh(geo(id + 'st', () => { const b = new THREE.BoxGeometry(0.12, 0.05, 0.05); b.translate(0.06, 0, 0); return b; }), M.grey));
      g.add(mesh(geo(id, () => { const b = new THREE.BoxGeometry(0.02, h, 0.4); b.translate(0.13, 0, 0); return b; }), M.solar));
      break;
    }
    case 'antenna': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(0.01, 0.02, h, 6)), M.grey, 0.03, 0));
      g.add(mesh(geo(id + 'b', () => new THREE.BoxGeometry(0.06, 0.1, 0.06)), M.dark, 0.03, -h / 2 + 0.05));
      break;
    }
    case 'girder': {
      const s = r * 0.8;
      for (const [x, z] of [[s, s], [-s, s], [s, -s], [-s, -s]]) g.add(mesh(geo(id + 'c', () => new THREE.BoxGeometry(0.06, h, 0.06)), M.grey, x, 0, z));
      for (const y of [-h / 2 + 0.03, 0, h / 2 - 0.03]) g.add(mesh(geo(id + 'r', () => new THREE.BoxGeometry(s * 2, 0.06, s * 2)), M.dark, 0, y, 0));
      break;
    }
    case 'reaction_wheel': {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(r, r, h, 40)), M.grey));
      band(0, r, h * 0.3, M.dark);
      break;
    }
    default: {
      g.add(mesh(geo(id, () => new THREE.CylinderGeometry(rt, r, h, 32)), M.white));
    }
  }
  g.userData.partId = def.id;
  g.userData.fallback = true;
  return g;
}

export function disposeFallbackParts() {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
  if (mats) { for (const m of mats.all) m.dispose(); mats = null; }
}

// ───────────────────────── 2D icons ─────────────────────────

const iconCache = new Map();
const CATEGORY_TINT = { command: '#8fd0ff', fuel: '#f2f2ec', engine: '#ffb35c', coupling: '#ffd24a', aero: '#e9edf5', utility: '#9ff0b0', structural: '#b9c3d2' };

/** A shaded 2D silhouette icon (data URL) for a part, used until/unless a 3D thumbnail is available. */
export function fallbackIcon(def, size = 96) {
  const key = def.id + ':' + size;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const s = size / 100;
  g.scale(s, s);
  const style = def.mesh?.style || '';
  const tint = CATEGORY_TINT[def.category] || '#ddd';
  const shade = (x0, x1, base) => {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, '#2a3140'); gr.addColorStop(0.25, base); gr.addColorStop(0.55, '#ffffff'); gr.addColorStop(1, '#3a4252');
    return gr;
  };
  // Fit the part's aspect into the icon
  const H = def.height || 1, R = Math.max(def.radius || 0.3, def.topRadius || 0);
  const k = Math.min(70 / H, 36 / Math.max(R, 0.15));
  const w = R * k, hh = H * k;
  const top = 50 - hh / 2, bot = 50 + hh / 2;
  g.lineJoin = 'round';
  const body = (rb, rtop, color, y0 = top, y1 = bot) => {
    g.fillStyle = shade(50 - rb, 50 + rb, color);
    g.beginPath(); g.moveTo(50 - rtop, y0); g.lineTo(50 + rtop, y0); g.lineTo(50 + rb, y1); g.lineTo(50 - rb, y1); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.2; g.stroke();
  };
  const rt = (def.topRadius ?? def.radius) * k;
  switch (style) {
    case 'engine': case 'nuclear': {
      const nr = (def.modules.engine.nozzle?.radius ?? def.radius * 0.7) * k;
      const my = top + hh * 0.38;
      body(w * 0.85, w, style === 'nuclear' ? '#7ccf87' : '#9aa3ad', top, my);
      body(nr, nr * 0.35, '#5a4a40', my, bot);
      break;
    }
    case 'srb': body(w, w, '#f4f4f0', top, bot - hh * 0.1); body(w * 0.62, w * 0.5, '#4a403a', bot - hh * 0.1, bot);
      g.fillStyle = '#ff8a2a'; g.fillRect(50 - w, top, 2 * w, hh * 0.06); break;
    case 'nosecone': body(w, w * 0.08, '#f4f4f0'); break;
    case 'capsule': case 'capsule3': body(w, rt, '#f2f2ee');
      g.fillStyle = '#28486a'; g.fillRect(50 - w * 0.25, top + hh * 0.3, w * 0.5, hh * 0.18); break;
    case 'fin': case 'fin_control': {
      const f = def.modules.fin;
      const kk = 70 / Math.max(f.rootChord, f.span);
      g.fillStyle = shade(30, 30 + f.span * kk, '#e9edf5');
      g.beginPath(); g.moveTo(30, 50 - f.rootChord * kk / 2); g.lineTo(30, 50 + f.rootChord * kk / 2);
      g.lineTo(30 + f.span * kk, 50 + f.rootChord * kk / 2); g.lineTo(30 + f.span * kk, 50 + f.rootChord * kk / 2 - f.tipChord * kk); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.stroke();
      break;
    }
    case 'chute': body(w, w * 0.55, '#ff8a1f'); break;
    case 'decoupler': body(w, w, '#3a4048'); g.fillStyle = '#ffc21a'; g.fillRect(50 - w, 50 - hh * 0.18, 2 * w, hh * 0.36); break;
    case 'radial_decoupler': body(12, 12, '#3a4048', 20, 80); g.fillStyle = '#ffc21a'; g.fillRect(38, 44, 24, 12); break;
    case 'tank_big': body(w, w, '#ff7a1f'); break;
    case 'tank_mono': body(w, w, '#ffd54a'); break;
    case 'heatshield': body(w, w * 0.96, '#6a4630'); break;
    case 'probe': body(w, w, '#d9a441'); break;
    default:
      if (def.nodes?.top || def.nodes?.bottom) body(w, rt, tint);
      else {
        g.fillStyle = shade(35, 65, tint);
        g.beginPath(); g.roundRect ? g.roundRect(38, 22, 24, 56, 6) : g.rect(38, 22, 24, 56); g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.stroke();
      }
  }
  const url = c.toDataURL('image/png');
  iconCache.set(key, url);
  return url;
}
