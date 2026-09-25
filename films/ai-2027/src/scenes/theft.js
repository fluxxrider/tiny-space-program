// FEBRUARY 2027 — China steals Agent-2's weights: 25 servers, 100 GB chunks, under two hours.
// The US retaliates with cyberattacks that fail; warships move around Taiwan.
import { clamp, smooth, lerp, ease, win, hash1 } from '../engine/math.js';
import { getGlobe, REGION_COLORS, PLACES } from './globe.js';
import { FONT, setFont, COLORS } from '../engine/text.js';
import { label, icon } from './ui.js';

let globe;
const SF = [37.77, -122.42], TW = [34.687, 119.46], TAIPEI = [23.8, 121.0];

const LOG = [
  [2.9, '> session: insider credentials ........ ACCEPTED', COLORS.text],
  [3.3, '> privilege: admin (weights cluster)', COLORS.text],
  [3.7, '> targets: 25 servers · 4% of weights each', COLORS.text],
  [4.1, '> exfil: 100 GB chunks · throttled to avoid detection', COLORS.text],
];

export default {
  init(R) { globe = getGlobe(R.g); },
  grade(lt) {
    const alarm = win(lt, 8.0, 10.3, 0.1, 0.6);
    return { vignette: 0.8, bloom: 0.85, threshold: 0.7, grain: 0.045, fade: 1 - smooth(lt / 0.6),
      tint: [1 + alarm * 0.12, 1 - alarm * 0.05, 1 - alarm * 0.05], glitch: win(lt, 10.2, 10.5, 0.02, 0.2) * 0.4 + win(lt, 11.5, 11.8, 0.02, 0.2) * 0.3 };
  },
  render(R, t, lt) {
    // camera: Pacific view, then push toward Taiwan
    const toTw = ease.inOutCubic(clamp((lt - 13.4) / 2.6));
    const lon = lerp(lerp(-178, -168, clamp(lt / 13)), 121, toTw);
    const lat = lerp(52, 24, toTw);
    const dist = lerp(3.5, 2.1, toTw);
    const cam = globe.camera({ lat, lon, dist, fov: 36, ox: lerp(-0.62, 0.0, toTw), oy: lerp(-0.1, -0.05, toTw) });
    const sun = [-0.7, 0.2, -0.6];
    globe.draw(cam, {
      time: t, night: 1, sun, alpha: 1, dotSize: lerp(0.0105, 0.0075, toTw), lights: lerp(1, 0.55, toTw), halo: 0.8, atmo: [0.2, 0.45, 0.9],
      regions: { us: [0.5, 0.75, 1.0, 0.9], china: [1.0, 0.62, 0.3, 1.0], taiwan: [1.0, 0.9, 0.8, 1.4], other: REGION_COLORS.dim },
    });
    // exfiltration arc: SF -> Tianwan
    const arc = globe.arc('theft', SF, TW, { height: 0.35, segs: 120, col: [1.0, 0.25, 0.3, 1.0] });
    const prog = ease.inOutCubic(clamp((lt - 3.0) / 5.0));
    const fade = 1 - smooth((lt - 12.8) / 1.0);
    globe.drawArc(cam, arc, { progress: prog, alpha: fade, time: t, pulse: 2.0 });
    // retaliation arcs (blue) that fizzle
    const ra = win(lt, 10.0, 13.5, 0.3, 0.8);
    if (ra > 0) {
      for (let i = 0; i < 3; i++) {
        const src = [[38.9, -77.0], [37.4, -122.1], [47.6, -122.3]][i];
        const a2 = globe.arc('ret' + i, src, [TW[0] + (i - 1) * 1.5, TW[1] + (i - 1) * 2], { height: 0.3, segs: 100, col: [0.4, 0.75, 1.0, 1.0] });
        const p = ease.inOutCubic(clamp((lt - 10.1 - i * 0.2) / 1.6));
        globe.drawArc(cam, a2, { progress: Math.min(p, 0.93), alpha: ra * (p > 0.9 ? 0.5 + 0.5 * Math.sin(lt * 40) : 1), time: t, pulse: 1.5 });
      }
    }
    const o = R.o;
    // packet head + endpoint labels
    const head = arc.sample(prog);
    if (prog > 0 && prog < 1 && fade > 0) {
      const wp = globe.world(cam, 0, 0); // dummy to keep model
      void wp;
    }
    const sfS = globe.screen(cam, SF[0], SF[1]);
    const twS = globe.screen(cam, TW[0], TW[1]);
    const la = win(lt, 1.2, 12.8, 0.5, 0.6);
    o.save();
    if (sfS && la > 0) {
      R.ga(la * sfS.vis);
      o.fillStyle = COLORS.us; o.beginPath(); o.arc(sfS.x, sfS.y, 5, 0, 7); o.fill();
      label(o, 'OPENBRAIN', sfS.x - 14, sfS.y - 24, { align: 'right', size: 15, color: COLORS.us, tracking: 0.3, weight: 600, bg: 'rgba(3,5,9,0.66)' });
    }
    if (twS && la > 0) {
      R.ga(la * twS.vis);
      o.fillStyle = COLORS.china; o.beginPath(); o.arc(twS.x, twS.y, 5, 0, 7); o.fill();
      label(o, 'DEEPCENT · TIANWAN CDZ', twS.x + 14, twS.y - 24, { align: 'left', size: 15, color: COLORS.china, tracking: 0.3, weight: 600, bg: 'rgba(3,5,9,0.66)' });
    }
    o.restore();
    // terminal
    const ta = win(lt, 2.8, 12.6, 0.4, 0.5);
    if (ta > 0) {
      const X = 110, Y = 655; // box spans y 295–625: below the date HUD, above the captions
      o.save(); R.ga(ta);
      o.fillStyle = 'rgba(4,6,10,0.8)'; o.fillRect(X, Y - 360, 640, 330);
      o.strokeStyle = 'rgba(255,84,104,0.45)'; o.strokeRect(X, Y - 360, 640, 330);
      label(o, 'OPERATION LOG', X + 20, Y - 336, { align: 'left', size: 12, color: COLORS.danger, tracking: 0.35, weight: 600 });
      setFont(o, { weight: 400, size: 15, family: FONT.mono });
      o.textBaseline = 'middle';
      LOG.forEach(([t0, line, col], i) => {
        if (lt < t0) return;
        const n = Math.floor(clamp((lt - t0) / 0.45) * line.length);
        o.fillStyle = col;
        o.fillText(line.slice(0, n), X + 20, Y - 298 + i * 28);
      });
      // 25 shard bars
      const pr = clamp((lt - 3.0) / 5.0);
      for (let i = 0; i < 25; i++) {
        const c = i % 5, r = Math.floor(i / 5);
        const bx = X + 20 + c * 122, by = Y - 174 + r * 22;
        const p = clamp((pr * 1.35 - i * 0.014 - hash1(i) * 0.3));
        o.fillStyle = 'rgba(255,255,255,0.08)'; o.fillRect(bx, by, 110, 12);
        o.fillStyle = p >= 1 ? COLORS.danger : 'rgba(255,120,130,0.8)';
        o.fillRect(bx, by, 110 * p, 12);
      }
      // elapsed clock
      const secs = Math.floor(ease.inOutQuad(clamp((lt - 3.0) / 5.0)) * (1 * 3600 + 58 * 60 + 44));
      const hh = String(Math.floor(secs / 3600)).padStart(2, '0'), mm = String(Math.floor(secs / 60) % 60).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
      const done = lt > 8.0;
      o.fillStyle = done ? COLORS.danger : COLORS.text;
      setFont(o, { weight: 400, size: 15, family: FONT.mono });
      o.fillText(done ? `> TRANSFER COMPLETE — ELAPSED ${hh}:${mm}:${ss}` : `> elapsed ${hh}:${mm}:${ss}  ·  ${Math.floor(pr * 100)}%`, X + 20, Y - 50);
      o.restore();
    }
    // failed retaliation
    const fa = win(lt, 11.6, 13.4, 0.2, 0.5);
    if (fa > 0 && twS) {
      o.save(); R.ga(fa);
      label(o, 'US CYBERATTACK · BLOCKED · AIR-GAPPED', twS.x + 14, twS.y + 26, { align: 'left', size: 13, color: COLORS.ice, tracking: 0.2, family: FONT.mono, bg: 'rgba(3,5,9,0.66)' });
      o.restore();
    }
    // Taiwan: ships circling
    const sa = win(lt, 13.8, 17.6, 0.8, 0.3);
    const tp = globe.screen(cam, TAIPEI[0], TAIPEI[1]);
    if (sa > 0 && tp) {
      o.save(); R.ga(sa);
      o.strokeStyle = 'rgba(255,255,255,0.35)'; o.setLineDash([4, 6]);
      o.beginPath(); o.ellipse(tp.x, tp.y, 150, 110, 0, 0, Math.PI * 2); o.stroke(); o.setLineDash([]);
      for (let i = 0; i < 9; i++) {
        const a = i / 9 * Math.PI * 2 + lt * (i % 2 ? 0.12 : -0.1);
        const rr = 1 + (i % 3) * 0.12;
        const x = tp.x + Math.cos(a) * 150 * rr, y = tp.y + Math.sin(a) * 110 * rr;
        o.fillStyle = i % 2 ? COLORS.us : COLORS.china;
        icon(o, 'ship', x, y, 22, i % 2 ? COLORS.us : COLORS.china, 1, 1.5);
        o.fillStyle = i % 2 ? COLORS.us : COLORS.china;
        o.save(); o.translate(x, y); o.rotate(a + (i % 2 ? Math.PI / 2 : -Math.PI / 2));
        o.beginPath(); o.moveTo(11, 0); o.lineTo(-9, 5); o.lineTo(-6, 0); o.lineTo(-9, -5); o.closePath(); o.fill();
        o.restore();
      }
      o.fillStyle = COLORS.text; o.beginPath(); o.arc(tp.x, tp.y, 4, 0, 7); o.fill();
      label(o, 'TAIWAN', tp.x, tp.y - 22, { size: 14, color: COLORS.text, tracking: 0.35, weight: 600 });
      o.restore();
    }
  },
};
