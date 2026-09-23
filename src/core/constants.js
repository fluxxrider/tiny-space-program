// Global physical & gameplay constants. Units are SI unless stated otherwise.

export const G0 = 9.80665;                 // standard gravity (m/s²) used for Isp
export const PHYSICS_DT = 0.02;            // fixed physics step (s) — 50 Hz
export const PHYSICS_RANGE = 2500;         // m — vessels closer than this to the active vessel are simulated with full physics
export const RENDER_RANGE = 25000;         // m — vessels closer than this get a VesselRenderer
export const ATM_PRESSURE_REF = 101.325;   // kPa — pressure at which ispASL/thrustASL is defined (1 atm)

// Time-warp levels. Index 0 is real time.
export const WARP_RATES = [1, 5, 10, 50, 100, 1000, 10000, 100000];
export const PHYSICS_WARP_RATES = [1, 2, 3, 4];

// Stack size classes → radius in meters (0.625 m, 1.25 m, 2.5 m diameters).
export const SIZE_RADIUS = [0.3125, 0.625, 1.25];

// Resource definitions. density is tonnes per unit (KSP convention).
export const RESOURCES = {
  LiquidFuel:      { label: 'Liquid Fuel',   short: 'LF',  density: 0.005,  color: '#7fd4ff' },
  Oxidizer:        { label: 'Oxidizer',      short: 'OX',  density: 0.005,  color: '#6aa8ff' },
  SolidFuel:       { label: 'Solid Fuel',    short: 'SF',  density: 0.0075, color: '#ffb35c' },
  MonoPropellant:  { label: 'Monopropellant',short: 'MP',  density: 0.004,  color: '#f4e36b' },
  ElectricCharge:  { label: 'Electric Charge', short: 'EC', density: 0,     color: '#8cf58c' },
  Ablator:         { label: 'Ablator',       short: 'AB',  density: 0.001,  color: '#c98a5a' },
};

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const GAME_TITLE = 'Tiny Space Program';
export const CREW_SURNAME = 'Tinyman';
export const STORAGE_PREFIX = 'tsp.';
