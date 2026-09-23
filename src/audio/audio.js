// Audio manager for Tiny Space Program (fx area) — ARCHITECTURE.md §5. Everything is synthesized with WebAudio.
//
//   import { audio } from './audio/audio.js';
//   audio.init();                         // idempotent; call from a user gesture (also auto-called on the first gesture)
//   audio.setScene('vab');                // 'spacecenter'|'vab'|'flight'|'map'|'tracking'|'menu' → music mood
//   audio.updateFlight(dt, { thrustFrac, solidFrac, dynPressure, mach, pressure, reentry, warpRate, paused, cameraDist });
//   audio.play('click');  audio.play('explosion', { size: 3, distance: 120 });
//   audio.setVolumes({ master, music, sfx });  audio.pauseAll(true);
//   audio.toggleMute() / audio.setMuted(bool) / audio.muted   — also Ctrl+M anywhere; remembered across sessions,
//                                                               the volume sliders keep their values
//
// Graph:  music ─┐
//         world ─┼→ sfx ─┤→ master → limiter → destination
//         ui ────┘       │
// The module is importable in node and every method is a safe no-op before init() / without WebAudio.
// It subscribes itself to bus events (staging, decouple, explosions, chutes, milestones, warp, toggles, flameouts,
// ui:click, scene:change, splashdown) and adds subtle click/hover sounds to every <button>/.tsp-btn automatically.
import * as THREE from 'three';
import { bus, toast } from '../core/events.js';
import { game, storage } from '../core/state.js';
import { HAS_WINDOW, getAudioContextClass, audioLib, gainNode, clamp } from './synth.js';
import { SFX, SFX_NAMES, WORLD_SFX } from './sfx.js';
import { FlightSoundscape } from './flightSound.js';
import { MusicDirector, moodForScene } from './music.js';

export { SFX_NAMES };

// Minimum seconds between two plays of the same sound (chain reactions / double events).
const MIN_GAP = {
  click: 0.035, hover: 0.05, toggle: 0.04, sas_on: 0.15, sas_off: 0.15, error: 0.25, countdown: 0.1, milestone: 1.5,
  warp: 0.12, place: 0.04, pickup: 0.04, delete: 0.06, stage: 0.12, decouple: 0.06, chute: 0.15, flameout: 0.15,
  ignite: 0.2, launch: 1.0, gear: 0.3, splash: 0.4, explosion: 0, touchdown: 0.5, sonic_boom: 3, quindar: 0.8, space: 5, static: 0.5,
};

const vol = (v) => { const x = clamp(Number.isFinite(v) ? v : 0, 0, 1); return Math.pow(x, 1.7); }; // perceptual-ish curve

class AudioManager {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.scene = 'menu';
    const s = game.settings || {};
    this.volumes = { master: s.masterVolume ?? 0.8, music: s.musicVolume ?? 0.5, sfx: s.sfxVolume ?? 0.9 };
    this._seen = { master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume };
    this._muted = HAS_WINDOW && storage.get('audio', null)?.muted === true;
    this._paused = false;
    this._last = Object.create(null);
    this._explosions = [];          // recent explosion start times (voice limiting)
    this._warpRate = 1;
    this._flightT = -1;             // ctx time of the last updateFlight()
    this._flightParams = { thrustFrac: 0, solidFrac: 0, dynPressure: 0, mach: 0, pressure: 0, reentry: 0, warpRate: 1, paused: false, cameraDist: 20 };
    this.flightSound = null;
    this.music = null;
    this._tmpA = new THREE.Vector3();
    this._subscribe();
    if (HAS_WINDOW) this._installDomHooks();
  }

  // ───────────────────────── public API ─────────────────────────

  /** Create/resume the AudioContext. Idempotent. Returns true when audio is available. */
  init() {
    if (!HAS_WINDOW) return false;
    const AC = getAudioContextClass();
    if (!AC) return false;
    if (!this.ctx) {
      try { this.ctx = new AC({ latencyHint: 'interactive' }); }
      catch (e) { console.warn('[audio] AudioContext failed', e); return false; }
      try { this._build(); }
      catch (e) { console.warn('[audio] graph build failed', e); this.ctx = null; return false; }
      if (window.TSP) window.TSP.audio = this;
    }
    if (this.ctx.state === 'suspended' && !this._hidden) this.ctx.resume().catch(() => {});
    return true;
  }

  get context() { return this.ctx; }
  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  setScene(name) {
    const prev = this.scene;
    this.scene = name;
    if (!this.ready) return;
    const quick = name === 'map' || prev === 'map';
    this.music.setMood(moodForScene(name), quick ? 2.5 : 4);
    if (name !== 'flight' && name !== 'map' && this.flightSound) this.flightSound.silence(0.4);
  }

  updateFlight(dt, p = {}) {
    if (!this.ready) return;
    const f = this._flightParams;
    f.thrustFrac = p.thrustFrac || 0; f.solidFrac = p.solidFrac || 0; f.dynPressure = p.dynPressure || 0; f.mach = p.mach || 0;
    f.pressure = p.pressure || 0; f.reentry = p.reentry || 0; f.warpRate = p.warpRate || 1; f.paused = !!p.paused || this._paused;
    f.cameraDist = Number.isFinite(p.cameraDist) ? p.cameraDist : 20;
    if (!this.flightSound) this.flightSound = new FlightSoundscape(this.ctx, this.worldBus, this.lib);
    this.flightSound.update(dt, f);
    this._flightT = this.ctx.currentTime;
  }

  /**
   * Convenience wrapper (fx extension): derive the updateFlight() parameters from a FlightSim and call it.
   * thrustFrac here means "engine loudness" — it scales with the absolute thrust of the running engines, so a
   * Flea hisses and a Mainsail cluster roars. No allocations.
   */
  updateFromFlight(dt, flight, { cameraDist = 20, paused = !!game.paused } = {}) {
    if (!this.ready) return;
    const s = this._derived || (this._derived = { thrustFrac: 0, solidFrac: 0, dynPressure: 0, mach: 0, pressure: 0, reentry: 0, warpRate: 1, paused: false, cameraDist: 20 });
    const v = flight?.active;
    let thrust = 0, solid = 0;
    if (v?.parts) {
      for (let i = 0; i < v.parts.length; i++) {
        const e = v.parts[i].engine;
        if (!e || !e.active || e.flameout) continue;
        const t = e.thrust > 0 ? e.thrust : 0;
        thrust += t;
        if (v.parts[i].def?.modules?.engine?.type === 'solid') solid += t;
      }
    }
    const tel = v?.telemetry || {};
    s.thrustFrac = thrust > 0 ? Math.min(1, Math.pow(thrust / 300000, 0.4)) : 0;
    s.solidFrac = thrust > 0 ? solid / thrust : 0;
    s.dynPressure = tel.dynamicPressure || 0;
    s.mach = tel.mach || 0;
    s.pressure = tel.staticPressure || 0;
    s.reentry = v?.reentryIntensity ?? tel.reentryIntensity ?? 0;
    s.warpRate = flight?.warp?.rate ?? 1;
    s.paused = paused;
    s.cameraDist = cameraDist;
    this.updateFlight(dt, s);
  }

  /** Play a named one-shot. Returns true if scheduled. */
  play(name, opts) {
    if (!this.ready) return false;
    const recipe = SFX[name];
    if (!recipe) return false;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const gap = MIN_GAP[name] ?? 0.03;
    const last = this._last[name];
    if (last !== undefined && now - last < gap) return false;
    const world = WORLD_SFX.has(name);
    if (world && this._paused) return false;
    let o = opts || {};
    if (name === 'explosion') {
      // voice limiting for chain reactions: quieter & sparser when many go off together
      const ex = this._explosions;
      while (ex.length && now - ex[0] > 0.35) ex.shift();
      if (ex.length >= 5) return false;
      if (ex.length) o = { size: (o.size ?? 2) * (ex.length >= 2 ? 0.55 : 0.8), distance: o.distance };
      ex.push(now);
    }
    this._last[name] = now;
    try {
      recipe(ctx, world ? this.worldBus : this.uiBus, now + 0.005, o, this.lib, world ? this.worldVerb : null);
    } catch (e) { console.warn('[audio] play failed', name, e); return false; }
    if (name === 'milestone') this._duckMusic(0.45, 2.6);
    return true;
  }

  setVolumes({ master, music, sfx } = {}) {
    if (Number.isFinite(master)) this.volumes.master = master;
    if (Number.isFinite(music)) this.volumes.music = music;
    if (Number.isFinite(sfx)) this.volumes.sfx = sfx;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this._muted ? 0 : vol(this.volumes.master), t, 0.05);
    this.musicBus.gain.setTargetAtTime(vol(this.volumes.music), t, 0.05);
    this.sfxBus.gain.setTargetAtTime(vol(this.volumes.sfx), t, 0.05);
  }

  /** True while all sound is muted (Ctrl+M / a speaker button). The volume settings are kept untouched. */
  get muted() { return this._muted; }

  /** Mute/unmute everything (remembered across sessions). Emits bus 'audio:mute' { muted }. */
  setMuted(on, { silent = false } = {}) {
    const m = !!on;
    if (m === this._muted) return m;
    this._muted = m;
    if (HAS_WINDOW) storage.set('audio', { muted: m });
    if (this.ready) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(m ? 0 : vol(this.volumes.master), t, 0.04);
    }
    if (!m && this.ready) this.play('toggle', { value: true });
    bus.emit('audio:mute', { muted: m });
    if (!silent) toast(m ? 'Sound muted — Ctrl+M to unmute' : 'Sound on', 'info', 1800);
    return m;
  }

  toggleMute() { return this.setMuted(!this._muted); }

  /** Pause/resume world sounds (engine, wind, explosions…). UI sounds keep working; music is ducked. */
  pauseAll(paused) {
    this._paused = !!paused;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.worldBus.gain.setTargetAtTime(this._paused ? 0 : 1, t, 0.08);
    this.musicDuck.gain.setTargetAtTime(this._paused ? 0.5 : 1, t, 0.3);
  }

  // ───────────────────────── internals ─────────────────────────

  _build() {
    const ctx = this.ctx;
    this.lib = audioLib(ctx);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6; this.limiter.knee.value = 4; this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.2;
    this.master = gainNode(ctx, this._muted ? 0 : vol(this.volumes.master));
    this.master.connect(this.limiter); this.limiter.connect(ctx.destination);
    this.musicBus = gainNode(ctx, vol(this.volumes.music));
    this.musicDuck = gainNode(ctx, 1);
    this.musicDuck.connect(this.musicBus); this.musicBus.connect(this.master);
    this.sfxBus = gainNode(ctx, vol(this.volumes.sfx)); this.sfxBus.connect(this.master);
    this.uiBus = gainNode(ctx, 1); this.uiBus.connect(this.sfxBus);
    this.worldBus = gainNode(ctx, 1); this.worldBus.connect(this.sfxBus);
    this.worldVerb = ctx.createConvolver();
    this.worldVerb.buffer = this.lib.sfxIR;
    this.worldVerbOut = gainNode(ctx, 0.55);
    this.worldVerb.connect(this.worldVerbOut); this.worldVerbOut.connect(this.worldBus);
    this.music = new MusicDirector(ctx, this.musicDuck, { lib: this.lib });
    this.music.start();
    this.ready = true;
    this.music.setMood(moodForScene(this.scene), 3);
    this._house = setInterval(() => this._housekeeping(), 250);
  }

  _housekeeping() {
    if (!this.ctx) return;
    // follow settings changes made elsewhere (menus) without fighting explicit setVolumes() calls
    const s = game.settings;
    if (s && (s.masterVolume !== this._seen.master || s.musicVolume !== this._seen.music || s.sfxVolume !== this._seen.sfx)) this._followSettings(s);
    if (this.flightSound) {
      const idle = this.ctx.currentTime - this._flightT;
      if (idle > 0.4) this.flightSound.silence(0.3);
      if (idle > 20) { this.flightSound.dispose(); this.flightSound = null; }
    }
  }

  /** Apply volume settings changed elsewhere; moving the master slider up while muted unmutes (the user wants sound). */
  _followSettings(st) {
    const masterMoved = st.masterVolume !== this._seen.master;
    this._seen = { master: st.masterVolume, music: st.musicVolume, sfx: st.sfxVolume };
    this.setVolumes({ master: st.masterVolume, music: st.musicVolume, sfx: st.sfxVolume });
    if (this._muted && masterMoved && st.masterVolume > 0) this.setMuted(false, { silent: true });
  }

  _duckMusic(level, seconds) {
    const t = this.ctx.currentTime, g = this.musicDuck.gain;
    const base = this._paused ? 0.5 : 1;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(level * base, t + 0.15);
    g.setValueAtTime(level * base, t + seconds);
    g.linearRampToValueAtTime(base, t + seconds + 1.2);
  }

  _isActive(vessel) {
    const a = game.flight?.active;
    return !vessel || !a || vessel === a;
  }

  /** Distance (m) from the active vessel to a destroyed part, plus a bit of camera distance. */
  _distanceTo(p) {
    const a = game.flight?.active;
    const cam = this._flightParams.cameraDist || 20;
    if (!a?.pos) return 40 + cam * 0.5;
    const v = p?.vessel, part = p?.part;
    try {
      if (v && part && v.bodyId === a.bodyId && typeof v.partWorldPos === 'function') {
        v.partWorldPos(part, this._tmpA);
        if (Number.isFinite(this._tmpA.x)) return this._tmpA.distanceTo(a.pos) + cam * 0.5;
      }
    } catch { /* ignore */ }
    return 60 + cam * 0.5;
  }

  _subscribe() {
    bus.on('vessel:staged', (p) => { if (this._isActive(p?.vessel)) this.play('stage'); });
    bus.on('decouple', (p) => {
      const a = game.flight?.active;
      if (!a || p?.vessel === a || p?.newVessels?.includes?.(a)) this.play('decouple');
    });
    bus.on('part:destroyed', (p) => this.play('explosion', { size: p?.size ?? 2, distance: this._distanceTo(p) }));
    bus.on('chute:deploy', (p) => { if (this._isActive(p?.vessel)) this.play('chute', { state: p?.state }); });
    bus.on('warp:change', (p) => {
      const rate = p?.rate ?? 1;
      if (rate !== this._warpRate) this.play('warp', { up: rate > this._warpRate });
      this._warpRate = rate;
    });
    bus.on('warp:denied', () => this.play('error'));
    bus.on('milestone', () => this.play('milestone'));
    bus.on('control:toggle', (p) => {
      if (!this._isActive(p?.vessel)) return;
      if (p?.what === 'sas') this.play(p.value ? 'sas_on' : 'sas_off');
      else if (p?.what === 'gear') this.play('gear');
      else this.play('toggle', { value: !!p?.value });
    });
    bus.on('engine:flameout', (p) => { if (this._isActive(p?.vessel)) this.play('flameout'); });
    bus.on('engine:ignite', (p) => { if (this._isActive(p?.vessel)) this.play('ignite'); });
    bus.on('situation:change', (p) => {
      if (p?.to === 'SPLASHED' && this._isActive(p?.vessel)) this.play('splash', { size: Math.min(1.5, (p.vessel?.telemetry?.surfaceSpeed ?? 8) / 12) });
      else if (p?.to === 'LANDED' && (p.from === 'FLYING' || p.from === 'SUB_ORBITAL') && this._isActive(p?.vessel)) {
        this.play('touchdown', { speed: Math.abs(p.vessel?.telemetry?.verticalSpeed ?? 2) });
      }
    });
    bus.on('ui:click', () => this.play('click'));
    bus.on('settings:changed', (p) => {
      const st = p?.settings || game.settings;
      if (st) this._followSettings(st);
    });
    // ascent / reentry moments detected by the effects (src/render/effects.js → 'fx:moment')
    bus.on('fx:moment', (p) => {
      if (!this.ready || !this._isActive(p?.vessel)) return;
      switch (p?.id) {
        case 'supersonic': this.play('sonic_boom'); break;
        case 'maxq': case 'meco': case 'seco': this.play('quindar'); break;
        case 'space': if (this.play('space')) this._duckMusic(0.6, 2.5); break;
        case 'blackout': this.play('static', { on: true }); break;
        case 'signal': this.play('static', { on: false }); this._last.quindar = undefined; setTimeout(() => this.play('quindar'), 350); break;
        default: break;
      }
    });
    bus.on('scene:change', (p) => { if (p?.to) this.setScene(p.to); });
  }

  _installDomHooks() {
    const gesture = () => {
      this.init();
      if (this.running) {
        window.removeEventListener('pointerdown', gesture, true);
        window.removeEventListener('keydown', gesture, true);
        window.removeEventListener('touchstart', gesture, true);
      }
    };
    window.addEventListener('pointerdown', gesture, true);
    window.addEventListener('keydown', gesture, true);
    window.addEventListener('touchstart', gesture, true);
    // Ctrl+M mutes/unmutes everywhere (M alone is the map). Captured before the game's polled input sees it, so the
    // map doesn't toggle as well.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || !e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      this.toggleMute();
    }, true);
    if (typeof document === 'undefined') return;
    const SEL = 'button, .tsp-btn, [data-sfx]';
    document.addEventListener('click', (e) => {
      const el = e.target?.closest?.(SEL);
      if (!el || el.disabled || el.dataset?.sfx === 'off') return;
      this.play('click');
    }, true);
    let hovered = null;
    document.addEventListener('pointerover', (e) => {
      const el = e.target?.closest?.(SEL);
      if (el === hovered) return;
      hovered = el;
      if (el && !el.disabled && el.dataset?.sfx !== 'off') this.play('hover');
    }, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      this._hidden = document.hidden;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else this.ctx.resume().catch(() => {});
    });
  }
}

export const audio = new AudioManager();
export default audio;
