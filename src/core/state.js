// Global game state singleton + tiny localStorage wrapper.
import { STORAGE_PREFIX } from './constants.js';

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('[storage] write failed', key, e); return false; }
  },
  remove(key) { try { localStorage.removeItem(STORAGE_PREFIX + key); } catch { /* ignore */ } },
};

export const DEFAULT_SETTINGS = {
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  graphics: 'high',          // 'low' | 'medium' | 'high'
  bloom: true,
  shadows: true,
  mouseSensitivity: 1.0,
  invertY: false,
  showFPS: false,
  tutorialHints: true,
};

// Valid values for the stored settings (the settings dialog's ranges). Anything else falls back to the default.
const SETTING_RANGES = {
  masterVolume: [0, 1], musicVolume: [0, 1], sfxVolume: [0, 1], mouseSensitivity: [0.2, 3],
};
const SETTING_CHOICES = { graphics: ['low', 'medium', 'high'] };

/**
 * Merge stored settings over the defaults key by key, keeping only values of the default's type (numbers finite and
 * clamped to their slider range, enums from their list). A hand-edited / corrupted localStorage entry such as
 * mouseSensitivity: "fast" used to reach the camera (NaN pose → black view) and break the settings dialog.
 */
export function sanitizeSettings(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const def = DEFAULT_SETTINGS[key], v = stored[key];
    if (typeof v !== typeof def) continue;
    if (typeof def === 'number') {
      if (!Number.isFinite(v)) continue;
      const r = SETTING_RANGES[key];
      out[key] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
    } else if (SETTING_CHOICES[key]) {
      if (SETTING_CHOICES[key].includes(v)) out[key] = v;
    } else out[key] = v;
  }
  return out;
}

export const game = {
  ut: 0,                 // universal time (s) — the single source of truth for simulation time
  flight: null,          // FlightSim instance (src/physics/flight.js), persists across scenes
  editorCraft: null,     // craft object currently being edited in the VAB
  lastLaunchCraft: null, // craft object used for the most recent launch (for "revert")
  settings: sanitizeSettings(storage.get('settings', {})),
  progress: storage.get('progress', { milestones: {}, stats: { launches: 0, crashes: 0, recoveries: 0 } }),
  roster: null,          // managed by src/game/crew.js
  debug: false,
  paused: false,         // true while a pause menu is open in flight
};

export function saveSettings() { storage.set('settings', game.settings); }
export function saveProgress() { storage.set('progress', game.progress); }
