// Stock crafts (vab area). Built with node-aligned stacking helpers so every stack joint is exact, then auto-staged.
// export const STOCK_CRAFTS = [craft…]; export function getStockCraft(id) → deep clone.
import * as THREE from 'three';
import { PARTS } from '../data/parts.js';
import {
  CRAFT_FORMAT, craftPartDef, layoutCraft, autoStage, cloneCraft, surfaceAttachTransform,
} from './craft.js';

const TAU = Math.PI * 2;
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _n = new THREE.Vector3();

/**
 * Tiny fluent builder for crafts. Every add* method returns the new craft part (or an array for symmetric groups).
 *   const b = new CraftBuilder('id', 'Name', 'desc');
 *   const pod = b.root('pod_mk1');
 *   const tank = b.below(pod, 'tank_t400');          // tank's top node on the pod's bottom node
 *   b.above(pod, 'chute_mk16');                       // chute's bottom node on the pod's top node
 *   const fins = b.surface(tank, 'fin_basic', { count: 4, y: -0.7 });
 *   const noses = b.aboveEach(boosters, 'nose_cone'); // one per symmetric parent, sharing a sym group
 */
export class CraftBuilder {
  constructor(id, name, description = '') {
    this.craft = { format: CRAFT_FORMAT, id, name, description, parts: [] };
    this.uid = 1;
    this.sym = 1;
  }

  _add(partId, parent, attach, pos, rot, sym = null) {
    if (!PARTS[partId]) throw new Error('Unknown part ' + partId);
    const p = { uid: this.uid++, part: partId, parent: parent ? parent.uid : null, attach, pos, rot, stage: -1, sym };
    this.craft.parts.push(p);
    return p;
  }

  root(partId) { return this._add(partId, null, null, [0, 0, 0], [0, 0, 0, 1]); }

  /** Stack-attach `partId` so that its `node` meets `parent`'s `parentNode` exactly. */
  stack(parent, partId, node, parentNode, sym = null) {
    const def = PARTS[partId], pdef = craftPartDef(parent);
    const cn = def.nodes?.[node], pn = pdef.nodes?.[parentNode];
    if (!cn || !pn) throw new Error(`No ${node}/${parentNode} node between ${partId} and ${parent.part}`);
    const q = _q.fromArray(parent.rot);
    const pos = _p.fromArray(pn.pos).applyQuaternion(q).add(_n.fromArray(parent.pos));
    const off = new THREE.Vector3().fromArray(cn.pos).applyQuaternion(q);
    pos.sub(off);
    return this._add(partId, parent, { kind: 'stack', node, parentNode }, [pos.x, pos.y, pos.z], parent.rot.slice(), sym);
  }

  below(parent, partId) { return this.stack(parent, partId, 'top', 'bottom'); }
  above(parent, partId) { return this.stack(parent, partId, 'bottom', 'top'); }

  /** Surface-attach `count` copies around the parent's axis at parent-local height y (symmetry group if count>1). */
  surface(parent, partId, { count = 1, y = 0, angle = 0, sym = null } = {}) {
    const def = PARTS[partId];
    const group = count > 1 ? (sym ?? this.sym++) : sym;
    const out = [];
    for (let k = 0; k < count; k++) {
      const t = surfaceAttachTransform(parent, def, y, angle + TAU * k / count);
      out.push(this._add(partId, parent, { kind: 'surface' }, t.pos, t.rot, group));
    }
    return out;
  }

  /** Same attachment on each parent of a symmetric group; the new parts share one symmetry group. */
  surfaceEach(parents, partId, opts = {}) {
    const group = parents.length > 1 ? this.sym++ : null;
    return parents.map(par => this.surface(par, partId, { ...opts, count: 1, sym: group })[0]);
  }
  aboveEach(parents, partId) {
    const group = parents.length > 1 ? this.sym++ : null;
    return parents.map(par => this.stack(par, partId, 'bottom', 'top', group));
  }
  belowEach(parents, partId) {
    const group = parents.length > 1 ? this.sym++ : null;
    return parents.map(par => this.stack(par, partId, 'top', 'bottom', group));
  }

  /** Surface parts around several symmetric parents (e.g. fins on each booster) — one symmetry group per parent. */
  surfaceOnEach(parents, partId, opts = {}) {
    return parents.flatMap(par => this.surface(par, partId, opts));
  }

  build() {
    layoutCraft(this.craft);
    autoStage(this.craft);
    return this.craft;
  }
}

// ───────────────────────────────────── designs ─────────────────────────────────────

function fleaHopper() {
  const b = new CraftBuilder('flea_hopper', 'Flea Hopper',
    'Your very first rocket: a capsule, a parachute and a Flea booster. Light the Flea, pop the decoupler at the top, open the chute. Easy!');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16');
  const dec = b.below(pod, 'decoupler_s1');
  const flea = b.below(dec, 'srb_flea');
  b.surface(flea, 'fin_basic', { count: 3, y: -0.3 });
  return b.build();
}

/** Solid fuel loaded into the sounding rocket's Hammer (of 375): tuned for an apogee of ≈30 km. */
export const SOUNDING_ROCKET_SOLID_FUEL = 150;

function soundingRocket() {
  const b = new CraftBuilder('sounding_rocket', 'Sounding Rocket',
    'A science probe riding a Hammer booster with a carefully measured fuel load. Screams up to about 30 km, then floats home under its parachute.');
  const core = b.root('probe_core');
  b.above(core, 'chute_mk16');
  b.surface(core, 'antenna', { y: 0, angle: Math.PI / 4 });
  const adapter = b.below(core, 'adapter_s1s0');
  b.surface(adapter, 'battery', { count: 2, y: -0.02, angle: Math.PI / 2 });
  const dec = b.below(adapter, 'decoupler_s1');
  const srb = b.below(dec, 'srb_hammer');
  srb.resources = { SolidFuel: SOUNDING_ROCKET_SOLID_FUEL };
  b.surface(srb, 'fin_basic', { count: 3, y: -1.25 });
  return b.build();
}

function orbiter() {
  const b = new CraftBuilder('orbiter_1', 'Orbiter I',
    'Two stages and a pair of Hammer boosters: enough to reach orbit, circle Verda a few times and come home. Pitch east gently after 1 km!');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16');
  const shield = b.below(pod, 'heatshield_s1');
  const dec0 = b.below(shield, 'decoupler_s1');
  const upper = b.below(dec0, 'tank_t400');
  const terrier = b.below(upper, 'eng_terrier');
  const dec1 = b.below(terrier, 'decoupler_s1');
  const t1 = b.below(dec1, 'tank_t800');
  const t2 = b.below(t1, 'tank_t200');
  b.below(t2, 'eng_swivel');
  b.surface(t2, 'fin_basic', { count: 4, y: -0.2, angle: Math.PI / 4 });
  const radials = b.surface(t1, 'decoupler_radial', { count: 2, y: -0.2 });
  const boosters = b.surfaceEach(radials, 'srb_hammer', { y: 0 });
  b.aboveEach(boosters, 'nose_cone');
  return b.build();
}

function luneLander() {
  const b = new CraftBuilder('lune_lander', 'Lune Lander',
    'A one-Tinynaut round trip to Lune: a 2.5 m launcher with Thumper boosters, a transfer stage, and a legged lander that flies the capsule home.');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16');
  const shield = b.below(pod, 'heatshield_s1');
  const dec0 = b.below(shield, 'decoupler_s1');
  // Lander / return stage. Six legs mounted low (feet 0.38 m below the Terrier bell) and a reaction wheel so SAS can
  // hold the lander level while the legs settle: it stays upright on Lune slopes up to ~20° (the old 4-leg stance
  // tipped over on anything steeper than ~12°, i.e. on 15 % of Lune's surface).
  const rw = b.below(dec0, 'rw_s1');
  const lt = b.below(rw, 'tank_t800');
  const lengine = b.below(lt, 'eng_terrier');
  b.surface(lt, 'legs_lt1', { count: 6, y: -1.7, angle: Math.PI / 6 });
  b.surface(lt, 'solar_panel', { count: 2, y: 1.2 });
  b.surface(lt, 'rcs_block', { count: 4, y: 1.55, angle: Math.PI / 4 });
  // Transfer / upper launch stage
  const dec1 = b.below(lengine, 'decoupler_s1');
  const ut1 = b.below(dec1, 'tank_t800');
  const ut2 = b.below(ut1, 'tank_t400');
  const uengine = b.below(ut2, 'eng_swivel');
  // First stage (2.5 m)
  const dec2 = b.below(uengine, 'decoupler_s1');
  const adapter = b.below(dec2, 'adapter_s2s1');
  const big = b.below(adapter, 'tank_l32');
  const big2 = b.below(big, 'tank_l16');
  b.below(big2, 'eng_skipper');
  b.surface(big2, 'fin_basic', { count: 4, y: -0.5, angle: Math.PI / 4 });
  const radials = b.surface(big, 'decoupler_radial', { count: 2, y: -0.6 });
  const boosters = b.surfaceEach(radials, 'srb_thumper', { y: 0 });
  b.aboveEach(boosters, 'nose_cone');
  return b.build();
}

function pipProbe() {
  const b = new CraftBuilder('pip_probe', 'Pip Pathfinder',
    'An uncrewed probe with solar panels and a Spark engine: plenty of ΔV to reach tiny Pip, orbit it and land on its glassy flats.');
  const core = b.root('probe_core');
  b.above(core, 'nose_cone_s0');
  b.surface(core, 'antenna', { y: 0, angle: Math.PI / 4 });
  const pt1 = b.below(core, 'tank_s0');
  const pt2 = b.below(pt1, 'tank_s0');
  const pt3 = b.below(pt2, 'tank_s0');
  b.surface(pt1, 'solar_panel', { count: 4 });
  b.surface(pt3, 'battery', { count: 2, y: 0, angle: Math.PI / 4 });
  const spark = b.below(pt3, 'eng_spark');
  // Kick stage (the 1.25 m decoupler doubles as the probe's interstage plate)
  const dec0 = b.below(spark, 'decoupler_s1');
  const kt = b.below(dec0, 'tank_t400');
  const kick = b.below(kt, 'eng_terrier');
  // Booster stage
  const dec1 = b.below(kick, 'decoupler_s1');
  const lt1 = b.below(dec1, 'tank_t800');
  const lt2 = b.below(lt1, 'tank_t400');
  b.below(lt2, 'eng_swivel');
  b.surface(lt2, 'fin_basic', { count: 3, y: -0.4 });
  const radials = b.surface(lt1, 'decoupler_radial', { count: 2, y: -0.4, angle: Math.PI / 2 });
  const boosters = b.surfaceEach(radials, 'srb_hammer', { y: 0 });
  b.aboveEach(boosters, 'nose_cone');
  return b.build();
}

function heavyLifter() {
  const b = new CraftBuilder('heavy_lifter', 'Big Bertha',
    'Four Kickback boosters, a Mainsail core and a Trio capsule on top. Absolutely unnecessary. Absolutely glorious.');
  const pod = b.root('pod_mk3');
  b.above(pod, 'chute_xl');
  b.surface(pod, 'chute_radial', { count: 2, y: -0.1, angle: Math.PI / 2 });
  const shield = b.below(pod, 'heatshield_s2');
  const dec0 = b.below(shield, 'decoupler_s2');
  const ut = b.below(dec0, 'tank_l32');
  const poodle = b.below(ut, 'eng_poodle');
  b.surface(ut, 'solar_panel', { count: 4, y: 1.3 });
  const dec1 = b.below(poodle, 'decoupler_s2');
  const c1 = b.below(dec1, 'tank_l64');
  const c2 = b.below(c1, 'tank_l32');
  b.below(c2, 'eng_mainsail');
  b.surface(c2, 'fin_control', { count: 4, y: -1.2, angle: Math.PI / 4 });
  const radials = b.surface(c1, 'decoupler_radial', { count: 4, y: -2.2 });
  const boosters = b.surfaceEach(radials, 'srb_kickback', { y: 0 });
  b.aboveEach(boosters, 'nose_cone');
  b.surfaceOnEach(boosters, 'fin_basic', { count: 2, y: -4.3, angle: Math.PI / 2 });
  return b.build();
}

export const STOCK_CRAFTS = [fleaHopper(), soundingRocket(), orbiter(), luneLander(), pipProbe(), heavyLifter()];

/** Deep clone of a stock craft by id (throws for unknown ids). */
export function getStockCraft(id) {
  const c = STOCK_CRAFTS.find(s => s.id === id);
  if (!c) throw new Error('Unknown stock craft: ' + id);
  return cloneCraft(c);
}
