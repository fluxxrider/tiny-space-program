// Tinynaut crew roster: stats, assignment to launches, return/loss bookkeeping and the memorial wall.
// Node-importable (no DOM). Persisted in storage key "roster" (localStorage "tsp.roster") and mirrored in game.roster.
//
// Member = { id, name, first, role:'Pilot'|'Engineer'|'Scientist', courage (0..1), stupidity (0..1), badass (bool),
//            color ('#rrggbb' suit accent), status:'available'|'assigned'|'lost', flights, missionTime (s),
//            hiredUT, lastFlightUT, portrait (int seed), vesselName?, lostUT?, cause? }
// Vessel crew entry (what FlightSim.launch(craft, {crew}) receives) = { id, name, role, courage, stupidity, badass, color }.
import { game, storage } from '../core/state.js';
import { bus } from '../core/events.js';
import { CREW_SURNAME } from '../core/constants.js';
import { PARTS } from '../data/parts.js';
import { BODIES } from '../data/bodies.js';

export const ROSTER_KEY = 'roster';
export const ROSTER_VERSION = 1;
export const MAX_ROSTER = 16;
export const ROLES = ['Pilot', 'Engineer', 'Scientist'];
export const CREW_COLORS = ['#ff8a3d', '#ffd23f', '#3fd1c7', '#b184f0', '#ff5d8f', '#6cc3ff', '#8be07a', '#f0a868', '#e0e36b', '#7ad7ff'];

export const STARTING_CREW = [
  { first: 'Zeb',    role: 'Pilot',     courage: 0.50, stupidity: 0.00, badass: true,  color: '#ff8a3d' },
  { first: 'Wendle', role: 'Engineer',  courage: 0.50, stupidity: 0.80, badass: false, color: '#ffd23f' },
  { first: 'Bobbi',  role: 'Scientist', courage: 0.30, stupidity: 0.10, badass: false, color: '#3fd1c7' },
  { first: 'Nova',   role: 'Pilot',     courage: 0.55, stupidity: 0.40, badass: true,  color: '#b184f0' },
];

const NAME_START = ['Bil', 'Bob', 'Mil', 'Ger', 'Dun', 'Lod', 'Ted', 'Sam', 'Hal', 'Mor', 'Nel', 'Rod', 'Zel', 'Tam', 'Fen',
  'Wal', 'Kip', 'Pim', 'Lu', 'Ga', 'Ro', 'Vi', 'Mi', 'Ol', 'Ar', 'Fi', 'Tri', 'Qui', 'Bo', 'Jo', 'Ma', 'Ed', 'Si', 'Ber', 'Cal',
  'Dag', 'Em', 'Gus', 'Hel', 'Ib', 'Jas', 'Lin', 'Nor', 'Os', 'Pe', 'Ru', 'Sto', 'Ul', 'Wil', 'Yan'];
const NAME_END = ['by', 'bo', 'ton', 'ly', 'wig', 'nie', 'ric', 'dun', 'ford', 'vin', 'ley', 'ster', 'mo', 'ra', 'ella', 'ina',
  'lie', 'rick', 'gan', 'zo', 'bert', 'dred', 'fin', 'kin', 'mund', 'nard', 'pip', 'sy', 'tha', 'wen', 'da', 'ric', 'go', 'lo'];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round2 = (x) => Math.round(x * 100) / 100;

function makeMember(roster, { first, role, courage, stupidity, badass, color }, ut = 0) {
  const id = 'c' + (roster.nextId++);
  return {
    id, first, name: `${first} ${CREW_SURNAME}`, role,
    courage: round2(clamp01(courage)), stupidity: round2(clamp01(stupidity)), badass: !!badass, color,
    status: 'available', flights: 0, missionTime: 0, hiredUT: ut, lastFlightUT: null,
    portrait: hashString(first) % 1000,
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A fresh roster with the four founding Tinynauts. */
export function createDefaultRoster() {
  const roster = { version: ROSTER_VERSION, nextId: 1, crew: [], memorial: [] };
  for (const c of STARTING_CREW) roster.crew.push(makeMember(roster, c, 0));
  return roster;
}

const STATUSES = ['available', 'assigned', 'lost'];
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const finiteOr = (x, d) => (Number.isFinite(x) ? x : d);
const strOr = (x, d) => (typeof x === 'string' && x.trim() ? x : d);

/**
 * Validate and repair a roster from storage / a save / another module. Returns a NEW clean roster, or null when nothing
 * usable is left (no valid member and no memorial entry). Entries that are not objects with a string name are dropped,
 * every field gets the right type (a corrupt entry must never crash listCrew / the space center / a launch).
 * `report.changed` is set when anything had to be repaired.
 */
export function sanitizeRoster(r, report = {}) {
  report.changed = false;
  if (!isObj(r)) { report.changed = true; return null; }
  const out = { version: ROSTER_VERSION, nextId: 1, crew: [], memorial: [] };
  const ids = new Set(), names = new Set();
  let maxId = 0;
  const idNum = (id) => { const m = /^c(\d+)$/.exec(id); return m ? Number(m[1]) : 0; };
  const rawCrew = Array.isArray(r.crew) ? r.crew : [];
  if (!Array.isArray(r.crew) || !Array.isArray(r.memorial) || !Number.isFinite(r.nextId)) report.changed = true;
  for (const m of rawCrew) {
    const name = isObj(m) ? strOr(m.name, null) : null;
    if (!name || names.has(name)) { report.changed = true; continue; }
    let id = strOr(m.id, null);
    if (!id || ids.has(id)) { id = null; report.changed = true; }
    const first = strOr(m.first, name.split(' ')[0]);
    const clean = {
      ...m,
      id, name, first,
      role: ROLES.includes(m.role) ? m.role : 'Pilot',
      courage: round2(clamp01(finiteOr(m.courage, 0.5))),
      stupidity: round2(clamp01(finiteOr(m.stupidity, 0.5))),
      badass: m.badass === true,
      color: typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : CREW_COLORS[hashString(name) % CREW_COLORS.length],
      status: STATUSES.includes(m.status) ? m.status : 'available',
      flights: Math.max(0, Math.floor(finiteOr(m.flights, 0))),
      missionTime: Math.max(0, finiteOr(m.missionTime, 0)),
      hiredUT: finiteOr(m.hiredUT, 0),
      lastFlightUT: Number.isFinite(m.lastFlightUT) ? m.lastFlightUT : null,
      portrait: finiteOr(m.portrait, hashString(first) % 1000),
    };
    for (const k of ['vesselName', 'cause', 'mission']) if (k in clean && typeof clean[k] !== 'string') delete clean[k];
    for (const k of ['assignedUT', 'lostUT']) if (k in clean && !Number.isFinite(clean[k])) delete clean[k];
    for (const k of Object.keys(clean)) if (clean[k] !== m[k] && !(k === 'id' && clean.id === null)) report.changed = true;
    if (id) { ids.add(id); maxId = Math.max(maxId, idNum(id)); }
    names.add(name);
    out.crew.push(clean);
  }
  for (const e of Array.isArray(r.memorial) ? r.memorial : []) {
    const name = isObj(e) ? strOr(e.name, null) : null;
    if (!name) { report.changed = true; continue; }
    out.memorial.push({
      ...e, name,
      cause: strOr(e.cause, 'Lost in the line of duty'),
      lostUT: finiteOr(e.lostUT, 0),
      flights: Math.max(0, Math.floor(finiteOr(e.flights, 0))),
      color: typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : '#8a93a6',
      vesselName: typeof e.vesselName === 'string' ? e.vesselName : null,
    });
    if (typeof e.id === 'string') maxId = Math.max(maxId, idNum(e.id));
  }
  if (!out.crew.length && !out.memorial.length) { report.changed = true; return null; }
  out.nextId = Math.max(Math.floor(finiteOr(r.nextId, 1)), maxId + 1, 1);
  if (Number.isFinite(r.nextMission)) out.nextMission = Math.max(0, Math.floor(r.nextMission));
  for (const m of out.crew) if (!m.id) { m.id = 'c' + (out.nextId++); report.changed = true; }
  return out;
}

// Rosters that went through sanitizeRoster (getRoster is called constantly; only re-validate a new object).
const cleanRosters = new WeakSet();

function adopt(r) { cleanRosters.add(r); game.roster = r; return r; }

/** The roster (game.roster). Loads it from storage, or creates the default one, on first use. Always valid. */
export function getRoster() {
  const cur = game.roster;
  if (cur && cleanRosters.has(cur)) return cur;
  const rep = {};
  let r = cur != null ? sanitizeRoster(cur, rep) : null;
  if (r) {                       // someone assigned game.roster directly: keep it (repaired if it had to be)
    if (!rep.changed) return adopt(cur);
    console.warn('[crew] repaired an invalid roster in memory');
    adopt(r); saveRoster(); return r;
  }
  const stored = storage.get(ROSTER_KEY, null);
  r = stored != null ? sanitizeRoster(stored, rep) : null;
  if (stored != null && (!r || rep.changed)) console.warn('[crew] the stored roster was damaged; ' + (r ? 'repaired it' : 'starting a fresh one'));
  adopt(r || createDefaultRoster());
  if (!r || rep.changed) saveRoster();
  return game.roster;
}

/** Replace the roster (quickload / tests). Invalid input resets to the default roster; damaged entries are dropped. */
export function setRoster(roster, { save = true } = {}) {
  adopt(sanitizeRoster(roster) || createDefaultRoster());
  if (save) saveRoster();
  return game.roster;
}

export function saveRoster() { if (game.roster) storage.set(ROSTER_KEY, game.roster); }

export function resetRoster() { return setRoster(createDefaultRoster()); }

/** All members, optionally filtered by status ('available'|'assigned'|'lost') or a predicate. */
export function listCrew(filter = null) {
  const crew = getRoster().crew;
  if (!filter) return crew.slice();
  if (typeof filter === 'function') return crew.filter(filter);
  return crew.filter((m) => m.status === filter);
}

/** Find a member by id, full name or first name. */
export function getMember(key) {
  if (!key) return null;
  const k = typeof key === 'object' ? (key.id || key.name) : key;
  return getRoster().crew.find((m) => m.id === k || m.name === k || m.first === k) || null;
}

/** Number of crew seats a craft offers (sum of command-part crew capacity; craft part `crewSeats` may lower it). */
export function crewSeats(craft) {
  if (!craft || !Array.isArray(craft.parts)) return 0;
  let n = 0;
  for (const p of craft.parts) {
    const def = PARTS[p.part] || PARTS[p.id];
    if (!def) continue;
    const cap = def.crew ?? def.modules?.command?.crew ?? 0;
    if (cap <= 0) continue;
    n += Number.isFinite(p.crewSeats) ? Math.max(0, Math.min(cap, p.crewSeats)) : cap;
  }
  return n;
}

/**
 * Crew sitting in a vessel that is still on the launch pad (PRELAUNCH in game.flight). FlightSim.launch() clears the
 * pad before the next rocket goes up, so these Tinynauts can simply climb across instead of the program hiring
 * volunteers (re-rolling a full-crew craft used to hire a whole new crew every time).
 */
function padCrew() {
  const f = game.flight;
  const out = [];
  if (!f || !Array.isArray(f.vessels)) return out;
  for (const v of f.vessels) {
    if (!v || v.destroyed || v.situation !== 'PRELAUNCH' || !Array.isArray(v.crew)) continue;
    for (const c of v.crew) { const m = getMember(nameOf(c)); if (m && m.status === 'assigned' && !out.includes(m)) out.push(m); }
  }
  return out;
}

/**
 * Deterministic pick order: least recently flown first (never-flown in roster order), a Pilot in the first seat.
 * Crew waiting in a rocket on the pad come after everyone who is really available.
 */
function pickAvailable(count) {
  const byRecency = (list) => list.map((m, i) => ({ m, i })).sort((a, b) => {
    const la = a.m.lastFlightUT ?? -Infinity, lb = b.m.lastFlightUT ?? -Infinity;
    return la === lb ? a.i - b.i : la - lb;
  }).map((x) => x.m);
  const order = byRecency(listCrew('available'));
  if (order.length < count) order.push(...byRecency(padCrew()));
  const picked = order.slice(0, count);
  if (picked.length && picked[0].role !== 'Pilot') {
    const pilotIdx = picked.findIndex((m) => m.role === 'Pilot');
    if (pilotIdx > 0) { const [p] = picked.splice(pilotIdx, 1); picked.unshift(p); }
    else {
      const extPilot = order.slice(count).find((m) => m.role === 'Pilot');
      if (extPilot) { picked.pop(); picked.unshift(extPilot); }
    }
  }
  return picked;
}

/** Who would fly this craft right now (no state change). { crew: Member[], seats, missing } */
export function previewCrew(craft) {
  const seats = crewSeats(craft);
  const crew = pickAvailable(seats);
  return { crew, seats, missing: Math.max(0, seats - crew.length) };
}

/** Vessel crew entry. `mission` is the assignment token: a member re-assigned to a newer rocket has a different one. */
export function toVesselCrew(m) {
  const c = { id: m.id, name: m.name, role: m.role, courage: m.courage, stupidity: m.stupidity, badass: m.badass, color: m.color };
  if (m.mission) c.mission = m.mission;
  return c;
}

/** Is this vessel crew entry still the member's current assignment? (old saves have no tokens → yes) */
function stillAboard(entry, m) {
  return !!m && m.status === 'assigned' && (!entry?.mission || !m.mission || entry.mission === m.mission);
}

/**
 * Assign crew to every crewed seat of `craft` and mark them 'assigned'. Hires recruits if the roster runs dry.
 * opts.names: preferred members (names or ids) — used first when available.
 * Returns vessel crew entries [{ id, name, role, courage, stupidity, badass, color }].
 */
export function assignCrew(craft, { names = null, ut = game.ut, vesselName = craft?.name, rng = Math.random } = {}) {
  const seats = crewSeats(craft);
  if (seats <= 0) return [];
  const chosen = [];
  if (Array.isArray(names)) {
    for (const n of names) {
      const m = getMember(n);
      if (m && (m.status === 'available' || padCrew().includes(m)) && !chosen.includes(m) && chosen.length < seats) chosen.push(m);
    }
  }
  if (chosen.length < seats) {
    for (const m of pickAvailable(seats + chosen.length)) {
      if (chosen.length >= seats) break;
      if (!chosen.includes(m)) chosen.push(m);
    }
  }
  while (chosen.length < seats) {
    const recruit = hireRecruit({ rng, ut, force: true, silent: true });
    chosen.push(recruit);
    bus.emit('toast', { text: `${recruit.name} volunteered to fill an empty seat!`, kind: 'info', duration: 4000 });
  }
  const roster = getRoster();
  roster.nextMission = (Number.isFinite(roster.nextMission) ? roster.nextMission : 0) + 1;
  const mission = 'm' + roster.nextMission;
  for (const m of chosen) { m.status = 'assigned'; m.vesselName = vesselName || null; m.assignedUT = ut; m.mission = mission; }
  saveRoster();
  bus.emit('crew:assigned', { names: chosen.map((m) => m.name) });
  return chosen.map(toVesselCrew);
}

const nameOf = (x) => (typeof x === 'string' ? x : x?.name || x?.id);

/**
 * Crew died (vessel/pod destroyed). Adds them to the memorial. opts: { cause, vesselName, ut, bodyId }.
 * Returns the new memorial entries.
 */
export function markLost(names, { cause = 'Lost in the line of duty', vesselName = null, ut = game.ut, bodyId = null } = {}) {
  const roster = getRoster();
  const entries = [];
  for (const n of names || []) {
    const m = getMember(nameOf(n));
    if (!m || m.status === 'lost') continue;
    m.status = 'lost';
    m.lostUT = ut;
    m.cause = cause;
    if (m.assignedUT != null) m.missionTime += Math.max(0, ut - m.assignedUT);
    const entry = {
      id: m.id, name: m.name, role: m.role, color: m.color, flights: m.flights + 1, lostUT: ut,
      date: new Date().toISOString(), cause, vesselName: vesselName || m.vesselName || null, bodyId,
    };
    roster.memorial.push(entry);
    entries.push(entry);
  }
  if (entries.length) {
    saveRoster();
    bus.emit('crew:lost', { names: entries.map((e) => e.name), cause, vesselName });
  }
  return entries;
}

/** Crew came home safely (vessel recovered). opts: { missionTime (s), ut }. Returns the updated members. */
export function markReturned(names, { missionTime = null, ut = game.ut } = {}) {
  const out = [];
  for (const n of names || []) {
    const m = getMember(nameOf(n));
    if (!m || m.status === 'lost') continue;
    const dt = missionTime ?? (m.assignedUT != null ? Math.max(0, ut - m.assignedUT) : 0);
    m.status = 'available';
    m.flights += 1;
    m.missionTime += dt;
    m.lastFlightUT = ut;
    delete m.vesselName; delete m.assignedUT; delete m.mission;
    out.push(m);
  }
  if (out.length) {
    saveRoster();
    cancelReleaseNotice(out.map((m) => m.name));
    bus.emit('crew:returned', { names: out.map((m) => m.name) });
  }
  return out;
}

/** Undo an assignment without counting a flight (revert to launch / VAB, aborted launch). */
export function releaseCrew(names) {
  const out = [];
  for (const n of names || []) {
    const m = getMember(nameOf(n));
    if (!m || m.status !== 'assigned') continue;
    m.status = 'available';
    delete m.vesselName; delete m.assignedUT; delete m.mission;
    out.push(m);
  }
  if (out.length) saveRoster();
  return out;
}

/** Everyone still marked 'assigned' whose vessel no longer exists becomes available again (call after loading a save). */
export function reconcileAssignments(activeNames) {
  const keep = new Set(activeNames || []);
  const stale = listCrew('assigned').filter((m) => !keep.has(m.name)).map((m) => m.name);
  return releaseCrew(stale);
}

/** Generate an unused first name. */
export function generateName(rng = Math.random) {
  const taken = new Set(getRoster().crew.map((m) => m.first));
  for (let tries = 0; tries < 200; tries++) {
    const a = NAME_START[Math.floor(rng() * NAME_START.length)];
    const b = NAME_END[Math.floor(rng() * NAME_END.length)];
    const first = a + b;
    if (!taken.has(first)) return first;
  }
  return 'Recruit' + (getRoster().nextId);
}

/** Hire a new Tinynaut with random stats. Returns the member, or null if the roster is full (unless force). */
export function hireRecruit({ rng = Math.random, ut = game.ut, force = false, silent = false, role = null } = {}) {
  const roster = getRoster();
  const living = roster.crew.filter((m) => m.status !== 'lost').length;
  if (!force && living >= MAX_ROSTER) return null;
  const courage = rng(), stupidity = rng();
  const m = makeMember(roster, {
    first: generateName(rng),
    role: role || ROLES[Math.floor(rng() * ROLES.length)],
    courage, stupidity,
    badass: rng() < 0.18,
    color: CREW_COLORS[Math.floor(rng() * CREW_COLORS.length)],
  }, ut);
  roster.crew.push(m);
  saveRoster();
  if (!silent) bus.emit('crew:hired', { name: m.name });
  return m;
}

/** Remove a living, available member from the program (they retire to a quiet farm). */
export function dismissCrew(name) {
  const roster = getRoster();
  const i = roster.crew.findIndex((m) => (m.name === name || m.id === name) && m.status === 'available');
  if (i < 0) return false;
  roster.crew.splice(i, 1);
  saveRoster();
  return true;
}

/** The memorial wall (newest last). */
export function memorial() { return getRoster().memorial.slice(); }

// Personality blurbs, most specific trait first. Each bucket has several lines so a roster never repeats itself.
const FLAVOUR = [
  [(m) => m.badass && m.courage > 0.6, ['Fearless. Possibly too fearless.', 'Asks for the pointy end. Every time.', 'Once napped through a staging event.']],
  [(m) => m.badass, ['Cool as a cucumber in a centrifuge.', 'Unflappable, even at 9 g.', 'Wears sunglasses in the simulator.', 'Treats explosions as constructive feedback.']],
  [(m) => m.stupidity > 0.7, ['Enthusiastically presses every button.', 'Thinks the abort switch is a "fun" switch.', 'Brought a fork to the fuel test.']],
  [(m) => m.courage < 0.25, ['Brings a lucky sock on every flight.', 'Double-checks the parachute. Then triple-checks it.', 'Prefers rockets with extra seatbelts.']],
  [(m) => m.stupidity < 0.2 && m.courage > 0.5, ['The one who actually read the manual.', 'Can recite the staging order backwards.', 'Calculates Δv for fun.']],
  [(m) => m.role === 'Scientist', ['Would like to lick a rock on another world.', 'Has a sample jar for every occasion.', 'Keeps a notebook of interesting smells.']],
  [(m) => m.role === 'Engineer', ['Has a wrench for that.', 'Fixed the coffee machine with duct tape.', 'Can hear a loose bolt at 50 m.']],
  [() => true, ['Ready for anything. Mostly.', 'Practises the victory wave every morning.', 'Dreams in orbital mechanics.',
    'Knows every constellation by nickname.', 'Has named every rivet on the launch tower.', 'Packs snacks for a three-year mission.',
    'Waves at satellites. Some of them wave back.', 'Keeps a scrapbook of launch-day weather.', 'Hums the countdown in the shower.',
    'Once reached orbit in a dream. Twice, actually.', 'Believes the Lune is made of excellent cheese.', 'Collects mission patches, even the rejected ones.']],
];
const flavourHash = (m) => hashString(String(m?.name || m?.first || ''));

/** A short personality blurb for UI cards (deterministic per member). */
export function describeMember(m) {
  for (const [test, lines] of FLAVOUR) if (test(m)) return lines[flavourHash(m) % lines.length];
  return 'Ready for anything. Mostly.';
}

/**
 * Blurbs for a whole roster card wall without repeats: Map(member → line). Each member keeps its own trait bucket when a
 * line is left there; otherwise it borrows an unused line from the next matching bucket (and finally the generic one).
 */
export function describeMembers(list) {
  const used = new Set(), out = new Map();
  for (const m of list || []) {
    let pick = null;
    const h = flavourHash(m);
    for (const [test, lines] of FLAVOUR) {           // the generic bucket (last) always matches
      if (!test(m)) continue;
      for (let i = 0; i < lines.length && !pick; i++) { const l = lines[(h + i) % lines.length]; if (!used.has(l)) pick = l; }
      if (pick) break;
    }
    pick = pick || describeMember(m);
    used.add(pick);
    out.set(m, pick);
  }
  return out;
}

// ───────────────────────────── flight integration helpers ─────────────────────────────

/** Deep copy of the roster (take one at launch; restore it on "revert to launch/VAB" so reverted deaths never happened). */
export function snapshotRoster() { return JSON.parse(JSON.stringify(getRoster())); }
export function restoreRoster(snap) { if (snap) setRoster(snap); return getRoster(); }

/**
 * Call after FlightSim.recover(vessel) succeeded: marks the crew returned (flight counted) and emits
 * 'vessel:recovered' { vessel, crew, funds } (Missions counts recoveries & awards "Welcome Home").
 */
export function recoverCrew(vessel, result = null, { ut = game.ut } = {}) {
  const list = result?.crew || vessel?.crew || [];
  const launchUT = vessel?.history?.launchUT;
  const missionTime = Number.isFinite(launchUT) ? Math.max(0, ut - launchUT) : null;
  const back = markReturned(list.map(nameOf), { missionTime, ut });
  bus.emit('vessel:recovered', { vessel, crew: list, funds: result?.funds ?? 0 });
  return back;
}

const CAUSES = {
  impact: (b) => `Lithobraked on ${b}`,
  heat: () => 'Burned up during reentry',
  aero: () => 'Torn apart by aerodynamic forces',
  chute: () => 'Parachute failure',
};

const listNames = (names) => (names.length <= 1 ? names[0] || ''
  : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// Crew released because their vessel left the universe (pad cleared by a new rollout, Terminate in the tracking station).
// The toast is deferred one microtask: FlightSim.recover() also removes the vessel, and recoverCrew() — called right
// after it — marks the same crew returned; those get the "Welcome home" report instead of a "back at the complex" toast.
let pendingRelease = null;
function noteReleased(members, vesselName) {
  if (!members.length) return;
  if (!pendingRelease) {
    pendingRelease = [];
    const flush = () => {
      const list = pendingRelease; pendingRelease = null;
      const names = list.filter((x) => !x.returned).map((x) => x.name);
      if (!names.length) return;
      const vn = list.find((x) => !x.returned)?.vesselName;
      bus.emit('crew:released', { names, vesselName: vn || null });
      bus.emit('toast', {
        title: 'Astronaut Complex',
        text: `${listNames(names)} ${names.length > 1 ? 'are' : 'is'} back at the Astronaut Complex${vn ? ` (${vn} is no longer tracked)` : ''}.`,
        kind: 'info', duration: 4500,
      });
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(flush); else Promise.resolve().then(flush);
  }
  for (const m of members) pendingRelease.push({ name: m.name, vesselName, returned: false });
}
function cancelReleaseNotice(names) {
  if (!pendingRelease) return;
  for (const x of pendingRelease) if (names.includes(x.name)) x.returned = true;
}

let tracking = false;
/**
 * Keep the roster in step with the universe (installed automatically on import; idempotent):
 *  · part:destroyed with payload.crew (FlightSim: the Tinynauts seated in that part) → markLost (memorial);
 *  · vessel:removed (pad cleared by a new rollout, Terminate, recovery) → the crew still aboard go back to 'available';
 *  · vessel:destroyed with crew still aboard (an unattended vessel lost on rails: no part events) → markLost.
 */
export function trackCrewEvents(eventBus = bus) {
  if (tracking) return;
  tracking = true;
  eventBus.on('part:destroyed', (e = {}) => {
    const lost = Array.isArray(e.crew) ? e.crew : [];
    if (!lost.length) return;
    const bodyName = BODY_NAMES[e.bodyId] || e.bodyId || 'the ground';
    const cause = (CAUSES[e.reason] || (() => 'Lost in the line of duty'))(bodyName);
    markLost(lost.map(nameOf), { cause, vesselName: e.vessel?.name || null, bodyId: e.bodyId || null });
  });
  // (only crew whose current assignment is still this vessel: someone who climbed across into the next rocket on the
  //  pad keeps flying that one)
  const aboardNames = (vessel) => (Array.isArray(vessel?.crew) ? vessel.crew : [])
    .filter((c) => stillAboard(c, getMember(nameOf(c)))).map(nameOf).filter(Boolean);
  eventBus.on('vessel:removed', ({ vessel } = {}) => {
    if (!vessel || vessel.destroyed) return;
    const aboard = aboardNames(vessel);
    if (!aboard.length) return;
    noteReleased(releaseCrew(aboard), vessel.name || null);
  });
  eventBus.on('vessel:destroyed', ({ vessel } = {}) => {
    const aboard = aboardNames(vessel);
    if (!aboard.length) return;
    const b = BODIES[vessel.bodyId];
    const bodyName = b?.name || vessel.bodyId || 'the void';
    const cause = b?.atmosphere ? `Lost in ${bodyName}'s atmosphere` : `Crashed on ${bodyName}`;
    const entries = markLost(aboard, { cause, vesselName: vessel.name || null, bodyId: vessel.bodyId || null });
    if (entries.length) {
      bus.emit('toast', {
        title: 'Memorial Wall',
        text: `${listNames(entries.map((e) => e.name))} ${entries.length > 1 ? 'were' : 'was'} aboard ${vessel.name || 'the vessel'}. They will be remembered.`,
        kind: 'warn', duration: 6500,
      });
    }
  });
}
const BODY_NAMES = Object.fromEntries(Object.values(BODIES).map((b) => [b.id, b.name]));
trackCrewEvents();
