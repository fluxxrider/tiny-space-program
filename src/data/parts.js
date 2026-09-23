// Part catalog. Units follow KSP conventions: mass in TONNES (dry, without resources), thrust in kN, Isp in seconds,
// torque in kN·m, lengths in meters, resource amounts in UNITS (see RESOURCES in core/constants.js for tonnes/unit).
//
// Part-local frame: origin at the part's geometric center, +Y = "up the stack" (toward the nose of a normal rocket).
// Stack nodes: { pos:[x,y,z], dir:[x,y,z] (outward), size: 0|1|2 }. Stack parts have nodes.top at +height/2 and
// nodes.bottom at -height/2. A child attaches by aligning one of its nodes to a parent node (dirs opposite).
// srfAttach: the local point that touches the parent when surface-attached; the part is oriented so its local +X axis
// points AWAY from the parent (along the parent's surface normal) and local +Y stays parallel to the parent's +Y
// unless rotated by the player. null = cannot be surface attached.
// allowSrfAttach: other parts may be surface-attached onto this part.
// dragCd/dragArea: drag coefficient & reference area (m²) for the part in open airflow (physics handles occlusion).
// See ARCHITECTURE.md §Parts for the semantics of every module.

import { SIZE_RADIUS } from '../core/constants.js';

const PI = Math.PI;
const circ = (r) => PI * r * r;

/** Standard top+bottom stack nodes for a part of the given height. */
function stack(h, topSize, bottomSize = topSize) {
  const n = {};
  if (topSize != null) n.top = { pos: [0, h / 2, 0], dir: [0, 1, 0], size: topSize };
  if (bottomSize != null) n.bottom = { pos: [0, -h / 2, 0], dir: [0, -1, 0], size: bottomSize };
  return n;
}

const LFOX = { LiquidFuel: 0.9, Oxidizer: 1.1 };

function tank(id, name, size, height, dry, lf, cost, description, style = 'tank') {
  const r = SIZE_RADIUS[size];
  return {
    id, name, category: 'fuel', description, cost,
    mass: dry, radius: r, height, size,
    nodes: stack(height, size), srfAttach: [-r, 0, 0], allowSrfAttach: true,
    resources: { LiquidFuel: lf, Oxidizer: Math.round(lf * 11 / 9) },
    dragCd: 0.2, dragArea: circ(r), maxTemp: 2000, crashTolerance: 6,
    modules: {}, mesh: { style },
  };
}

function srb(id, name, height, dry, sf, thrustVac, ispVac, ispASL, cost, description) {
  const r = SIZE_RADIUS[1];
  return {
    id, name, category: 'engine', description, cost,
    mass: dry, radius: r, height, size: 1,
    nodes: stack(height, 1), srfAttach: [-r, 0, 0], allowSrfAttach: true,
    resources: { SolidFuel: sf },
    dragCd: 0.2, dragArea: circ(r), maxTemp: 2000, crashTolerance: 7,
    modules: {
      engine: { type: 'solid', thrustVac, ispVac, ispASL, propellants: { SolidFuel: 1 }, gimbal: 0,
        throttleLocked: true, spool: 0.05,
        nozzle: { y: -height / 2, radius: r * 0.55 },
        plume: { color: '#ffb866', core: '#fff3d6', length: 10 + thrustVac / 40, smoke: 1.0 } },
    },
    mesh: { style: 'srb' },
  };
}

function liquidEngine(id, name, size, height, mass, thrustVac, ispVac, ispASL, gimbal, cost, description, extra = {}) {
  const r = SIZE_RADIUS[size];
  const nozzleR = extra.nozzleRadius ?? r * 0.7;
  return {
    id, name, category: 'engine', description, cost,
    mass, radius: r, height, size,
    nodes: stack(height, size), srfAttach: null, allowSrfAttach: false,
    resources: {},
    dragCd: 0.2, dragArea: circ(r), maxTemp: 2000, crashTolerance: 7,
    modules: {
      engine: { type: extra.type ?? 'liquid', thrustVac, ispVac, ispASL, propellants: extra.propellants ?? LFOX, gimbal,
        throttleLocked: false, spool: extra.spool ?? 0.35,
        nozzle: { y: -height / 2, radius: nozzleR },
        plume: { color: extra.plumeColor ?? '#9fc7ff', core: extra.plumeCore ?? '#ffffff', length: 6 + thrustVac / 60, smoke: extra.smoke ?? 0.35 } },
    },
    mesh: { style: extra.style ?? 'engine', bell: extra.bell ?? 'standard' },
  };
}

export const PART_CATEGORIES = [
  { id: 'command', name: 'Command', icon: '◉' },
  { id: 'fuel', name: 'Fuel Tanks', icon: '▮' },
  { id: 'engine', name: 'Engines', icon: '▼' },
  { id: 'coupling', name: 'Coupling', icon: '⇕' },
  { id: 'aero', name: 'Aerodynamics', icon: '△' },
  { id: 'utility', name: 'Utility', icon: '✚' },
  { id: 'structural', name: 'Structural', icon: '▦' },
];

const LIST = [
  // ───────────────────────────── COMMAND ─────────────────────────────
  {
    id: 'pod_mk1', name: 'Mk1 Capsule', category: 'command', cost: 600,
    description: 'A snug one-seat capsule. Comes with a window, a seat, and a very brave Tinynaut.',
    mass: 0.84, radius: 0.625, topRadius: 0.33, height: 1.1, size: 1,
    nodes: { top: { pos: [0, 0.55, 0], dir: [0, 1, 0], size: 0 }, bottom: { pos: [0, -0.55, 0], dir: [0, -1, 0], size: 1 } },
    srfAttach: null, allowSrfAttach: true, crew: 1,
    resources: { MonoPropellant: 10, ElectricCharge: 50 },
    dragCd: 0.3, dragArea: circ(0.625), maxTemp: 2400, crashTolerance: 20,
    modules: { command: { crew: 1, probe: false, ecPerSec: 0 }, reactionWheel: { torque: 5, ecPerSec: 0.2 } },
    mesh: { style: 'capsule' },
  },
  {
    id: 'pod_mk3', name: 'Trio Command Module', category: 'command', cost: 3800,
    description: 'Three seats, big windows, and enough snacks for a trip to Lune and back.',
    mass: 2.72, radius: 1.25, topRadius: 0.625, height: 1.8, size: 2,
    nodes: { top: { pos: [0, 0.9, 0], dir: [0, 1, 0], size: 1 }, bottom: { pos: [0, -0.9, 0], dir: [0, -1, 0], size: 2 } },
    srfAttach: null, allowSrfAttach: true, crew: 3,
    resources: { MonoPropellant: 30, ElectricCharge: 150 },
    dragCd: 0.3, dragArea: circ(1.25), maxTemp: 2400, crashTolerance: 20,
    modules: { command: { crew: 3, probe: false, ecPerSec: 0 }, reactionWheel: { torque: 15, ecPerSec: 0.6 } },
    mesh: { style: 'capsule3' },
  },
  {
    id: 'lander_can', name: 'Lander Can', category: 'command', cost: 1500,
    description: 'A lightweight can with a great view of the ground you are about to land on.',
    mass: 0.6, radius: 0.625, height: 1.05, size: 1,
    nodes: stack(1.05, 1), srfAttach: null, allowSrfAttach: true, crew: 1,
    resources: { ElectricCharge: 50 },
    dragCd: 0.25, dragArea: circ(0.625), maxTemp: 2000, crashTolerance: 12,
    modules: { command: { crew: 1, probe: false, ecPerSec: 0 }, reactionWheel: { torque: 3, ecPerSec: 0.15 } },
    mesh: { style: 'lander' },
  },
  {
    id: 'probe_core', name: 'Octo Probe Core', category: 'command', cost: 450,
    description: 'An uncrewed brain in an octagonal box. Needs electric charge to think.',
    mass: 0.1, radius: 0.3125, height: 0.3, size: 0,
    nodes: stack(0.3, 0), srfAttach: null, allowSrfAttach: true, crew: 0,
    resources: { ElectricCharge: 10 },
    dragCd: 0.2, dragArea: circ(0.3125), maxTemp: 1200, crashTolerance: 12,
    modules: { command: { crew: 0, probe: true, ecPerSec: 0.02 }, reactionWheel: { torque: 0.5, ecPerSec: 0.05 } },
    mesh: { style: 'probe' },
  },

  // ───────────────────────────── FUEL ─────────────────────────────
  tank('tank_s0', 'Oscar Mini Tank', 0, 0.55, 0.025, 18, 70, 'A tiny tank for tiny engines.', 'tank_small'),
  tank('tank_t100', 'FT-100 Fuel Tank', 1, 0.55, 0.0625, 45, 150, 'The smallest standard tank. Great for trimming a design.'),
  tank('tank_t200', 'FT-200 Fuel Tank', 1, 1.1, 0.125, 90, 275, 'A handy mid-size tank.'),
  tank('tank_t400', 'FT-400 Fuel Tank', 1, 1.9, 0.25, 180, 500, 'The workhorse tank of the program.'),
  tank('tank_t800', 'FT-800 Fuel Tank', 1, 3.75, 0.5, 360, 800, 'Tall, proud, and full of go-juice.'),
  tank('tank_l16', 'Jumbo-16 Tank', 2, 1.9, 1.0, 720, 1550, 'A chunky 2.5 m tank painted in safety orange.', 'tank_big'),
  tank('tank_l32', 'Jumbo-32 Tank', 2, 3.75, 2.0, 1440, 3000, 'Twice the jumbo, twice the fun.', 'tank_big'),
  tank('tank_l64', 'Jumbo-64 Tank', 2, 7.5, 4.0, 2880, 5750, 'The biggest tank we could legally weld.', 'tank_big'),
  {
    id: 'tank_mono', name: 'Mono-80 Tank', category: 'fuel', cost: 330,
    description: 'Monopropellant for RCS thrusters.',
    mass: 0.15, radius: 0.625, height: 0.45, size: 1,
    nodes: stack(0.45, 1), srfAttach: [-0.625, 0, 0], allowSrfAttach: true,
    resources: { MonoPropellant: 80 },
    dragCd: 0.2, dragArea: circ(0.625), maxTemp: 2000, crashTolerance: 6,
    modules: {}, mesh: { style: 'tank_mono' },
  },

  // ───────────────────────────── ENGINES ─────────────────────────────
  liquidEngine('eng_spark', 'Spark Engine', 0, 0.55, 0.13, 20, 320, 265, 3, 240,
    'A pocket-sized engine for probes and tiny landers.', { nozzleRadius: 0.2, bell: 'small' }),
  liquidEngine('eng_terrier', 'Terrier Engine', 1, 0.9, 0.5, 60, 345, 85, 4, 390,
    'An efficient vacuum engine. Wheezes at sea level, sings in space.', { nozzleRadius: 0.4, bell: 'vacuum' }),
  liquidEngine('eng_swivel', 'Swivel Engine', 1, 1.6, 1.5, 215, 320, 250, 3, 1200,
    'A reliable first-stage engine with a gimbal for steering.', { nozzleRadius: 0.45 }),
  liquidEngine('eng_reliant', 'Reliant Engine', 1, 1.6, 1.25, 240, 310, 265, 0, 1100,
    'More push than the Swivel, but no gimbal. Add fins!', { nozzleRadius: 0.5, bell: 'wide' }),
  liquidEngine('eng_poodle', 'Poodle Engine', 2, 1.4, 1.75, 250, 350, 90, 4.5, 1300,
    'A stubby 2.5 m vacuum engine for heavy upper stages.', { nozzleRadius: 0.85, bell: 'vacuum' }),
  liquidEngine('eng_skipper', 'Skipper Engine', 2, 2.4, 3.0, 650, 320, 280, 2, 5300,
    'A beefy 2.5 m engine for mid-weight lifters.', { nozzleRadius: 0.8 }),
  liquidEngine('eng_mainsail', 'Mainsail Engine', 2, 3.0, 6.0, 1500, 310, 285, 2, 13000,
    'Enormous thrust. Enormous noise. Enormous grins.', { nozzleRadius: 1.0, bell: 'wide' }),
  liquidEngine('eng_nerv', 'Nerva Atomic Engine', 1, 3.2, 3.0, 60, 800, 185, 0, 10000,
    'Incredible efficiency, gentle thrust. Burns liquid fuel only.',
    { type: 'nuclear', propellants: { LiquidFuel: 1 }, nozzleRadius: 0.4, plumeColor: '#9dffb0', plumeCore: '#e9fff0', style: 'nuclear', smoke: 0.1 }),
  srb('srb_flea', 'Flea Solid Booster', 1.5, 0.45, 140, 192, 165, 140, 200, 'A short, punchy solid rocket. Once lit, it will not stop.'),
  srb('srb_hammer', 'Hammer Solid Booster', 3.4, 0.75, 375, 227, 195, 170, 400, 'The classic strap-on booster.'),
  srb('srb_thumper', 'Thumper Solid Booster', 6.3, 1.5, 820, 300, 210, 175, 850, 'A long-burning booster that really thumps.'),
  srb('srb_kickback', 'Kickback Solid Booster', 9.8, 4.5, 2600, 670, 220, 195, 2700, 'A colossal booster. Stand well back. Further. Further.'),

  // ───────────────────────────── COUPLING ─────────────────────────────
  {
    id: 'decoupler_s1', name: 'Stack Decoupler S1', category: 'coupling', cost: 400,
    description: 'Separates stages with a satisfying bang. Stays attached to the part below it.',
    mass: 0.04, radius: 0.625, height: 0.2, size: 1,
    nodes: stack(0.2, 1), srfAttach: null, allowSrfAttach: true,
    resources: {}, dragCd: 0.2, dragArea: circ(0.625), maxTemp: 2000, crashTolerance: 9,
    modules: { decoupler: { ejectionForce: 250, radial: false } }, mesh: { style: 'decoupler' },
  },
  {
    id: 'decoupler_s2', name: 'Stack Decoupler S2', category: 'coupling', cost: 900,
    description: 'A 2.5 m decoupler for big stages.',
    mass: 0.16, radius: 1.25, height: 0.3, size: 2,
    nodes: stack(0.3, 2), srfAttach: null, allowSrfAttach: true,
    resources: {}, dragCd: 0.2, dragArea: circ(1.25), maxTemp: 2000, crashTolerance: 9,
    modules: { decoupler: { ejectionForce: 400, radial: false } }, mesh: { style: 'decoupler' },
  },
  {
    id: 'decoupler_radial', name: 'Radial Decoupler', category: 'coupling', cost: 600,
    description: 'Attach boosters to the side of your rocket, then kick them away when they are empty.',
    mass: 0.025, radius: 0.2, height: 0.7, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: true,
    resources: {}, dragCd: 0.2, dragArea: 0.08, maxTemp: 2000, crashTolerance: 8,
    modules: { decoupler: { ejectionForce: 250, radial: true } },
    // Box spanning local x ∈ [0, 0.2], y ∈ [-0.35, 0.35], z ∈ [-0.175, 0.175]; boosters surface-attach to its +X face.
    mesh: { style: 'radial_decoupler', thickness: 0.2, width: 0.35 },
  },
  {
    id: 'adapter_s2s1', name: 'Adapter 2.5 → 1.25', category: 'coupling', cost: 500,
    description: 'Tapers a 2.5 m stack down to 1.25 m.',
    mass: 0.1, radius: 1.25, topRadius: 0.625, height: 0.9, size: 2,
    nodes: { top: { pos: [0, 0.45, 0], dir: [0, 1, 0], size: 1 }, bottom: { pos: [0, -0.45, 0], dir: [0, -1, 0], size: 2 } },
    srfAttach: null, allowSrfAttach: true,
    resources: {}, dragCd: 0.2, dragArea: circ(1.25), maxTemp: 2000, crashTolerance: 8,
    modules: {}, mesh: { style: 'adapter' },
  },
  {
    id: 'adapter_s1s0', name: 'Adapter 1.25 → 0.625', category: 'coupling', cost: 200,
    description: 'Tapers a 1.25 m stack down to 0.625 m.',
    mass: 0.03, radius: 0.625, topRadius: 0.3125, height: 0.4, size: 1,
    nodes: { top: { pos: [0, 0.2, 0], dir: [0, 1, 0], size: 0 }, bottom: { pos: [0, -0.2, 0], dir: [0, -1, 0], size: 1 } },
    srfAttach: null, allowSrfAttach: true,
    resources: {}, dragCd: 0.2, dragArea: circ(0.625), maxTemp: 2000, crashTolerance: 8,
    modules: {}, mesh: { style: 'adapter' },
  },

  // ───────────────────────────── AERO ─────────────────────────────
  {
    id: 'nose_cone', name: 'Nose Cone S1', category: 'aero', cost: 240,
    description: 'Pointy end goes up. Reduces drag on boosters and upper stages.',
    mass: 0.03, radius: 0.625, height: 1.0, size: 1,
    nodes: { bottom: { pos: [0, -0.5, 0], dir: [0, -1, 0], size: 1 } }, srfAttach: null, allowSrfAttach: false,
    resources: {}, dragCd: 0.08, dragArea: circ(0.625), maxTemp: 2400, crashTolerance: 9,
    modules: {}, mesh: { style: 'nosecone' },
  },
  {
    id: 'nose_cone_s0', name: 'Nose Cone S0', category: 'aero', cost: 120,
    description: 'A small pointy cap for 0.625 m stacks.',
    mass: 0.01, radius: 0.3125, height: 0.5, size: 0,
    nodes: { bottom: { pos: [0, -0.25, 0], dir: [0, -1, 0], size: 0 } }, srfAttach: null, allowSrfAttach: false,
    resources: {}, dragCd: 0.08, dragArea: circ(0.3125), maxTemp: 2400, crashTolerance: 9,
    modules: {}, mesh: { style: 'nosecone' },
  },
  {
    id: 'fin_basic', name: 'Basic Fin', category: 'aero', cost: 25,
    description: 'Keeps the pointy end forward. Put them near the bottom.',
    // Planform in the local XY plane: root chord along Y at x=0 (y ∈ [-0.4, 0.4]), span along +X to x=0.6, thin in Z.
    mass: 0.01, radius: 0.3, height: 0.8, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: {}, dragCd: 0.02, dragArea: 0.02, maxTemp: 2000, crashTolerance: 8,
    modules: { fin: { area: 0.35, control: false, span: 0.6, rootChord: 0.8, tipChord: 0.35 } },
    mesh: { style: 'fin' },
  },
  {
    id: 'fin_control', name: 'Control Fin', category: 'aero', cost: 400,
    description: 'A fin with a moving flap. Steers your rocket through the atmosphere.',
    mass: 0.1, radius: 0.3, height: 0.7, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: {}, dragCd: 0.02, dragArea: 0.03, maxTemp: 2000, crashTolerance: 8,
    modules: { fin: { area: 0.4, control: true, maxDeflection: 20, span: 0.55, rootChord: 0.7, tipChord: 0.4 } },
    mesh: { style: 'fin_control' },
  },
  {
    id: 'heatshield_s1', name: 'Heat Shield S1', category: 'aero', cost: 300,
    description: 'An ablative shield that burns away so your capsule does not.',
    mass: 0.1, radius: 0.66, height: 0.25, size: 1,
    nodes: stack(0.25, 1), srfAttach: null, allowSrfAttach: false,
    resources: { Ablator: 200 },
    dragCd: 0.3, dragArea: circ(0.66), maxTemp: 3300, crashTolerance: 9,
    modules: { heatShield: { ablatorPerKW: 0.0004 } }, mesh: { style: 'heatshield' },
  },
  {
    id: 'heatshield_s2', name: 'Heat Shield S2', category: 'aero', cost: 1000,
    description: 'A 2.5 m heat shield for the Trio module.',
    mass: 0.3, radius: 1.3, height: 0.35, size: 2,
    nodes: stack(0.35, 2), srfAttach: null, allowSrfAttach: false,
    resources: { Ablator: 800 },
    dragCd: 0.3, dragArea: circ(1.3), maxTemp: 3300, crashTolerance: 9,
    modules: { heatShield: { ablatorPerKW: 0.0004 } }, mesh: { style: 'heatshield' },
  },

  // ───────────────────────────── UTILITY ─────────────────────────────
  {
    id: 'chute_mk16', name: 'Canopy Parachute', category: 'utility', cost: 422,
    description: 'Mounts on top of a capsule. Stage it once you are slow and low.',
    mass: 0.1, radius: 0.33, height: 0.3, size: 0,
    nodes: { bottom: { pos: [0, -0.15, 0], dir: [0, -1, 0], size: 0 } }, srfAttach: null, allowSrfAttach: false,
    resources: {}, dragCd: 0.25, dragArea: circ(0.33), maxTemp: 1400, crashTolerance: 12,
    // fullArea (Cd·A) 425 m²: the stock 1.28 t capsule (pod + heat shield) lands at ≈7.0 m/s, a bare 0.98 t pod at ≈6.1 m/s
    modules: { parachute: { semiArea: 12, fullArea: 425, minPressure: 0.04, deployAltitude: 1000, safeSpeed: 300, canopyDiameter: 14, canopyColor: '#ff8a1f' } },
    mesh: { style: 'chute' },
  },
  {
    id: 'chute_xl', name: 'Canopy Parachute XL', category: 'utility', cost: 850,
    description: 'A big parachute for big capsules.',
    mass: 0.3, radius: 0.6, height: 0.45, size: 1,
    nodes: { bottom: { pos: [0, -0.225, 0], dir: [0, -1, 0], size: 1 } }, srfAttach: null, allowSrfAttach: false,
    resources: {}, dragCd: 0.25, dragArea: circ(0.6), maxTemp: 1400, crashTolerance: 12,
    modules: { parachute: { semiArea: 30, fullArea: 1500, minPressure: 0.04, deployAltitude: 1000, safeSpeed: 300, canopyDiameter: 26, canopyColor: '#ff8a1f' } },
    mesh: { style: 'chute' },
  },
  {
    id: 'chute_radial', name: 'Radial Parachute', category: 'utility', cost: 500,
    description: 'A side-mounted parachute. Use in pairs for stability.',
    // Canister along local Y (height 0.5) protruding along +X by ~0.25.
    mass: 0.15, radius: 0.15, height: 0.5, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: {}, dragCd: 0.2, dragArea: 0.05, maxTemp: 1400, crashTolerance: 12,
    modules: { parachute: { semiArea: 12, fullArea: 380, minPressure: 0.04, deployAltitude: 1000, safeSpeed: 300, canopyDiameter: 14, canopyColor: '#f4f4f4' } },
    mesh: { style: 'chute_radial' },
  },
  {
    id: 'legs_lt1', name: 'Landing Leg', category: 'utility', cost: 440,
    description: 'Spring-loaded legs for touching down gently. Press G to deploy.',
    // Stowed, the leg lies along -Y hugging the parent. Deployed, the foot swings out/down to footDeployed.
    mass: 0.05, radius: 0.15, height: 1.2, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: {}, dragCd: 0.3, dragArea: 0.04, maxTemp: 2000, crashTolerance: 12,
    modules: { legs: { footStowed: [0.15, -0.55, 0], footDeployed: [0.55, -1.45, 0], stroke: 0.3, deployTime: 1.2 } },
    mesh: { style: 'leg' },
  },
  {
    id: 'rw_s1', name: 'Reaction Wheel S1', category: 'utility', cost: 600,
    description: 'Spins up internal flywheels to turn your craft. Uses electric charge.',
    mass: 0.05, radius: 0.625, height: 0.2, size: 1,
    nodes: stack(0.2, 1), srfAttach: null, allowSrfAttach: true,
    resources: {}, dragCd: 0.2, dragArea: circ(0.625), maxTemp: 2000, crashTolerance: 9,
    modules: { reactionWheel: { torque: 5, ecPerSec: 0.25 } }, mesh: { style: 'reaction_wheel' },
  },
  {
    id: 'rcs_block', name: 'RCS Quad Thruster', category: 'utility', cost: 480,
    description: 'Four tiny monopropellant thrusters for fine maneuvering. Toggle with R.',
    mass: 0.05, radius: 0.12, height: 0.25, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: {}, dragCd: 0.1, dragArea: 0.02, maxTemp: 2000, crashTolerance: 8,
    // nozzle.dir is the EXHAUST direction in part-local space (the force on the vessel is -dir).
    modules: { rcs: { thrust: 1.0, ispVac: 240, ispASL: 100, nozzles: [
      { pos: [0.12, 0.09, 0], dir: [0, 1, 0] }, { pos: [0.12, -0.09, 0], dir: [0, -1, 0] },
      { pos: [0.12, 0, 0.09], dir: [0, 0, 1] }, { pos: [0.12, 0, -0.09], dir: [0, 0, -1] } ] } },
    mesh: { style: 'rcs' },
  },
  {
    id: 'battery', name: 'Battery Pack', category: 'utility', cost: 80,
    description: 'Stores 100 units of electric charge.',
    mass: 0.005, radius: 0.12, height: 0.25, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: { ElectricCharge: 100 },
    dragCd: 0.1, dragArea: 0.01, maxTemp: 1200, crashTolerance: 8,
    modules: {}, mesh: { style: 'battery' },
  },
  {
    id: 'solar_panel', name: 'Solar Panel', category: 'utility', cost: 75,
    description: 'Turns sunlight into electric charge. Does nothing in the dark, like most of us.',
    mass: 0.005, radius: 0.2, height: 0.5, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: {}, dragCd: 0.1, dragArea: 0.02, maxTemp: 1200, crashTolerance: 8,
    modules: { solarPanel: { chargeRate: 0.35 } }, mesh: { style: 'solar' },
  },
  {
    id: 'antenna', name: 'Whip Antenna', category: 'utility', cost: 50,
    description: 'Lets Mission Control hear your screams. Purely decorative, very stylish.',
    mass: 0.005, radius: 0.05, height: 0.8, size: 0,
    nodes: {}, srfAttach: [0, 0, 0], allowSrfAttach: false,
    resources: {}, dragCd: 0.1, dragArea: 0.005, maxTemp: 1200, crashTolerance: 6,
    modules: {}, mesh: { style: 'antenna' },
  },

  // ───────────────────────────── STRUCTURAL ─────────────────────────────
  {
    id: 'girder', name: 'Structural Girder', category: 'structural', cost: 25,
    description: 'An open truss section. Light, strong, and delightfully industrial.',
    mass: 0.125, radius: 0.3, height: 1.5, size: 1,
    nodes: stack(1.5, 1), srfAttach: [-0.3, 0, 0], allowSrfAttach: true,
    resources: {}, dragCd: 0.3, dragArea: 0.3, maxTemp: 2000, crashTolerance: 10,
    modules: {}, mesh: { style: 'girder' },
  },
];

export const PARTS = Object.fromEntries(LIST.map(p => [p.id, p]));
export const PART_LIST = LIST;

export function getPart(id) {
  const p = PARTS[id];
  if (!p) throw new Error('Unknown part: ' + id);
  return p;
}

/** Wet mass (tonnes) of a part definition with full resources. */
export function partWetMass(def, RESOURCES_TABLE) {
  let m = def.mass;
  for (const [res, amt] of Object.entries(def.resources || {})) m += amt * (RESOURCES_TABLE[res]?.density ?? 0);
  return m;
}
