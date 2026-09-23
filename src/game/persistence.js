// Save/load of the persistent universe (FlightSim + UT + crew roster). Node-importable (no DOM at import time).
//
//   saveUniverse()                 → bool    writes storage "persistent" (localStorage "tsp.persistent")
//   loadUniverse(FlightSimClass)   → FlightSim | null   (restores game.ut; caller assigns game.flight)
//   quicksave() / quickload(FlightSimClass) / hasQuicksave()
//   lastLoadReport() / hasBackup() / restoreBackup(FlightSimClass) / validateStoredData()
//
// Save format: { format:'tsp-universe-1', ut, savedAt (ms epoch), flight: FlightSim.serialize() | null, roster, meta }
//
// Robustness: a save is only applied when its flight could be restored — a quicksave whose vessels all fail to load is
// rejected (the running flight is kept), a partial restore is reported (toast + lastLoadReport()). The first save of a
// session copies the save found on disk to "persistent.bak" (last known good), unless that save was found damaged, in
// which case it is parked in "persistent.damaged" and the older backup is kept.
import { game, storage, saveSettings, DEFAULT_SETTINGS } from '../core/state.js';
import { bus } from '../core/events.js';
import { getRoster, setRoster, sanitizeRoster } from './crew.js';

export const SAVE_FORMAT = 'tsp-universe-1';
export const PERSISTENT_KEY = 'persistent';
export const QUICKSAVE_KEY = 'quicksave';
export const BACKUP_KEY = 'persistent.bak';
export const DAMAGED_KEY = 'persistent.damaged';

function vesselSummary(flight) {
  try {
    const vs = Array.isArray(flight?.vessels) ? flight.vessels : [];
    return {
      vessels: vs.length,
      active: flight?.active?.name ?? null,
      names: vs.filter((v) => v && v.type !== 'debris').slice(0, 12).map((v) => v.name),
    };
  } catch { return { vessels: 0, active: null, names: [] }; }
}

/** Build a save snapshot of the current universe (does not write it). Throws if FlightSim.serialize throws. */
export function snapshotUniverse() {
  const flight = game.flight;
  let flightData = null;
  if (flight && typeof flight.serialize === 'function') flightData = flight.serialize();
  return {
    format: SAVE_FORMAT,
    ut: Number.isFinite(game.ut) ? game.ut : 0,
    savedAt: Date.now(),
    flight: flightData,
    roster: getRoster(),
    meta: vesselSummary(flight),
  };
}

let backupDone = false;            // the first persistent save of a session rotates the previous save into the backup
let persistentDamaged = false;     // the persistent save loaded this session lost vessels → never make it the backup

/** Test hook: forget this session's backup / damage state (as after a page reload). */
export function _resetPersistenceSession() { backupDone = false; persistentDamaged = false; lastReport = null; }

function rotateBackup() {
  if (backupDone) return;
  backupDone = true;
  const prev = storage.get(PERSISTENT_KEY, null);
  if (!isValid(prev)) return;
  if (persistentDamaged) storage.set(DAMAGED_KEY, prev);
  else if (prev.flight || !isValid(storage.get(BACKUP_KEY, null))) storage.set(BACKUP_KEY, prev);
}

function write(key, { silent = true } = {}) {
  try {
    const snap = snapshotUniverse();
    if (key === PERSISTENT_KEY) { try { rotateBackup(); } catch (e) { console.warn('[persistence] backup failed', e); } }
    const ok = storage.set(key, snap);
    if (!ok && !silent) bus.emit('toast', { text: 'Could not save: storage is full or unavailable.', kind: 'error' });
    return ok;
  } catch (e) {
    console.error('[persistence] save failed', e);
    if (!silent) bus.emit('toast', { text: 'Save failed: ' + (e?.message || e), kind: 'error' });
    return false;
  }
}

/** Save the universe to "persistent". Call on scene exit / page hide. Returns true on success. */
export function saveUniverse() { return write(PERSISTENT_KEY); }

function isValid(data) { return !!data && typeof data === 'object' && !Array.isArray(data) && data.format === SAVE_FORMAT; }

let lastReport = null;
/**
 * What the last load (loadUniverse / quickload / restoreBackup) found:
 * { key, ok, saved (vessels in the file), restored, lost, error?, rejected (nothing was applied) } | null.
 */
export function lastLoadReport() { return lastReport; }

/**
 * Read a save slot. The flight is deserialized FIRST and checked (number of vessels in the file vs restored) before
 * anything is applied: a save that had vessels but restores none (or throws) is rejected when `rejectEmpty` — game.ut,
 * the roster and the caller's flight stay untouched. Returns { sim, report } (sim null when nothing to restore).
 */
function read(key, FlightSimClass, { restoreRoster, rejectEmpty }) {
  const data = storage.get(key, null);
  if (!isValid(data)) return { sim: null, report: null };
  const report = { key, ok: true, saved: 0, restored: 0, lost: 0, rejected: false, error: null };
  let sim = null;
  const f = data.flight;
  if (f && FlightSimClass && typeof FlightSimClass.deserialize === 'function') {
    report.saved = Array.isArray(f.vessels) ? f.vessels.length : (f.vessels == null ? 0 : 1);
    const prevUT = game.ut;
    const w = typeof window !== 'undefined' ? window : null;
    const prevDebug = w?.TSP?.physics;
    if (Number.isFinite(data.ut)) game.ut = data.ut;      // the sim is built at the saved UT
    try {
      sim = FlightSimClass.deserialize(f, game) || null;
    } catch (e) {
      console.error('[persistence] could not restore flight', e);
      report.error = e?.message || String(e);
      sim = null;
    }
    report.restored = Array.isArray(sim?.vessels) ? sim.vessels.length : 0;
    report.lost = Math.max(0, report.saved - report.restored);
    report.ok = !report.error && report.lost === 0;
    if (rejectEmpty && (report.error || (report.saved > 0 && report.restored === 0))) {
      game.ut = prevUT;                                   // deserialize() sets game.ut: undo it
      if (w?.TSP && prevDebug) w.TSP.physics = prevDebug; // …and FlightSim's constructor re-pointed the debug hooks
      report.rejected = true;
      lastReport = report;
      return { sim: null, report };
    }
  }
  if (Number.isFinite(data.ut)) game.ut = data.ut;
  if (restoreRoster && data.roster) setRoster(data.roster);
  lastReport = report;
  return { sim, report };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Restore the persistent universe: sets game.ut and returns FlightSimClass.deserialize(saved, game) (or null when there is
 * nothing to restore). The roster is only taken from the save if no roster is stored separately.
 * The caller assigns the result to game.flight. Damage is reported via lastLoadReport() (the space center offers the
 * backup); the damaged original is kept in "persistent.damaged" before it can be overwritten.
 */
export function loadUniverse(FlightSimClass) {
  const stored = storage.get('roster', null);
  const hasRoster = stored != null && !!sanitizeRoster(stored);
  const { sim, report } = read(PERSISTENT_KEY, FlightSimClass, { restoreRoster: !hasRoster, rejectEmpty: false });
  if (report && !report.ok) {
    persistentDamaged = true;
    console.warn('[persistence] the persistent save is damaged', report);
    bus.emit('toast', {
      text: report.error ? `The saved flight could not be restored: ${report.error}`
        : `${plural(report.lost, 'vessel')} in your save could not be restored.`,
      kind: 'error', duration: 6000,
    });
  }
  return sim;
}

/** Is there a usable backup of the persistent save (with a flight)? Returns its peekSave() info or null. */
export function hasBackup() { const p = peekSave(BACKUP_KEY); return p && p.hasFlight ? p : null; }

/**
 * Load "persistent.bak" (roster included). Returns the FlightSim (caller swaps game.flight) or null when the backup is
 * missing or damaged too. The backup becomes the persistent save on the next saveUniverse().
 */
export function restoreBackup(FlightSimClass) {
  const { sim, report } = read(BACKUP_KEY, FlightSimClass, { restoreRoster: true, rejectEmpty: true });
  if (!sim) {
    bus.emit('toast', { text: 'The backup could not be restored either.', kind: 'error', duration: 5000 });
    return null;
  }
  if (report && report.lost) bus.emit('toast', { text: `${plural(report.lost, 'vessel')} in the backup could not be restored.`, kind: 'warn', duration: 5000 });
  persistentDamaged = true;          // the file on disk is the damaged one: park it, keep the backup as it is
  backupDone = false;
  bus.emit('toast', { text: 'Backup restored.', kind: 'success', duration: 2500 });
  return sim;
}

/** Quicksave the current universe (F5). Emits 'flight:quicksave' and a toast. */
export function quicksave() {
  if (!game.flight) {
    bus.emit('toast', { text: 'Nothing to quicksave — no flight in progress.', kind: 'warn' });
    return false;
  }
  const ok = write(QUICKSAVE_KEY, { silent: false });
  if (ok) {
    bus.emit('flight:quicksave', {});
    bus.emit('toast', { text: 'Quicksaved', kind: 'success', duration: 1800 });
  }
  return ok;
}

/**
 * Quickload (F9): restores UT + roster from the quicksave and returns the FlightSim (caller swaps game.flight).
 * A quicksave whose vessels cannot be restored is rejected (null, toast) and nothing changes.
 */
export function quickload(FlightSimClass) {
  if (!hasQuicksave()) {
    bus.emit('toast', { text: 'No quicksave found. Press F5 to quicksave.', kind: 'warn' });
    return null;
  }
  const { sim, report } = read(QUICKSAVE_KEY, FlightSimClass, { restoreRoster: true, rejectEmpty: true });
  if (report?.rejected) {
    bus.emit('toast', { text: 'The quicksave is damaged — nothing was loaded. Your current flight continues.', kind: 'error', duration: 6000 });
    return null;
  }
  if (sim) {
    bus.emit('flight:quickload', {});
    if (report?.lost) bus.emit('toast', { text: `Quickloaded, but ${plural(report.lost, 'vessel')} could not be restored.`, kind: 'warn', duration: 5000 });
    else bus.emit('toast', { text: 'Quickloaded', kind: 'success', duration: 1800 });
  }
  return sim;
}

export function hasQuicksave() { return isValid(storage.get(QUICKSAVE_KEY, null)); }
export function hasPersistentSave() { const d = storage.get(PERSISTENT_KEY, null); return isValid(d) && !!d.flight; }

/** Lightweight info about a save slot without deserializing it: { ut, savedAt, vessels, active, names } | null. */
export function peekSave(key = PERSISTENT_KEY) {
  const d = storage.get(key, null);
  if (!isValid(d)) return null;
  return { ut: d.ut, savedAt: d.savedAt, hasFlight: !!d.flight, ...(d.meta || {}) };
}

export function clearUniverse({ quicksaveToo = true } = {}) {
  storage.remove(PERSISTENT_KEY);
  if (quicksaveToo) storage.remove(QUICKSAVE_KEY);
}

// ───────────────────────────── other stored keys ─────────────────────────────
const SETTING_CHOICES = { graphics: ['low', 'medium', 'high'] };
const SETTING_RANGES = { masterVolume: [0, 1], musicVolume: [0, 1], sfxVolume: [0, 1], mouseSensitivity: [0.2, 3] };

/**
 * Type-check game.settings against DEFAULT_SETTINGS (a hand-edited or corrupt "tsp.settings" must not turn the camera
 * into NaN or break the settings dialog). Wrong types / out-of-range values fall back to the default; the repaired
 * settings are saved. Returns the list of repaired keys.
 */
export function sanitizeSettings(settings = game.settings) {
  const fixed = [];
  if (!settings || typeof settings !== 'object') return fixed;
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = settings[k];
    let ok = typeof v === typeof def;
    if (ok && typeof def === 'number') ok = Number.isFinite(v) && (!SETTING_RANGES[k] || (v >= SETTING_RANGES[k][0] && v <= SETTING_RANGES[k][1]));
    if (ok && SETTING_CHOICES[k]) ok = SETTING_CHOICES[k].includes(v);
    if (!ok) { settings[k] = def; fixed.push(k); }
  }
  for (const k of Object.keys(settings)) if (/^\d+$/.test(k)) { delete settings[k]; fixed.push(k); }   // a spread string
  return fixed;
}

let validated = false;
/**
 * Validate shell-owned stored keys once per page (idempotent; also run on import): settings (types / ranges) and the
 * tutorial-hint map. The roster is repaired by crew.getRoster() (lazily, so a save's roster can still be adopted when
 * no usable roster is stored) and progress by the Missions constructor.
 * Returns { settings: [repaired keys], hints: bool }.
 */
export function validateStoredData({ force = false } = {}) {
  if (validated && !force) return null;
  validated = true;
  const out = { settings: [], hints: false };
  try {
    out.settings = sanitizeSettings(game.settings);
    if (out.settings.length) { console.warn('[persistence] repaired settings:', out.settings.join(', ')); saveSettings(); }
  } catch (e) { console.warn('[persistence] settings check failed', e); }
  try {
    const h = storage.get('hints', null);
    if (h != null && (typeof h !== 'object' || Array.isArray(h))) { storage.remove('hints'); out.hints = true; }
  } catch { /* ignore */ }
  return out;
}
validateStoredData();

let autosaveInstalled = false;
/** Save the universe whenever the page is hidden/closed (idempotent; browser only). */
export function installAutosave() {
  if (autosaveInstalled || typeof window === 'undefined') return;
  autosaveInstalled = true;
  const save = () => { if (game.flight || game.ut > 0) saveUniverse(); };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}
