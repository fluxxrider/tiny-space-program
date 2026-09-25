// PROLOGUE — a timeline from 2021 to 2025, then the scenario's opening line.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4 } from '../engine/math.js';
import { FONT, setFont, COLORS, roundRect, drawTracked, measureTracked } from '../engine/text.js';

const YPX = 380; // pixels per year
const LINE_Y = 590;

function camYear(lt) {
  // keyframes: [time, year]
  const K = [[0, 2021.25], [8.6, 2021.75], [10.2, 2024.2], [13.4, 2024.45], [14.6, 2025.2], [17.6, 2025.4], [25, 2025.9]];
  for (let i = 0; i < K.length - 1; i++) {
    const [t0, y0] = K[i], [t1, y1] = K[i + 1];
    if (lt <= t1) return lerp(y0, y1, ease.inOutCubic((lt - t0) / (t1 - t0)));
  }
  return K[K.length - 1][1];
}

function card(o, R, x, y, w, h, a, draw) {
  if (a <= 0.001) return;
  o.save();
  R.ga(a);
  roundRect(o, x, y, w, h, 10);
  o.fillStyle = 'rgba(12,16,24,0.82)'; o.fill();
  o.strokeStyle = 'rgba(160,190,220,0.35)'; o.lineWidth = 1.2; o.stroke();
  draw(o);
  o.restore();
}

export default {
  grade(lt) {
    return { vignette: 0.7, grain: 0.04, bloom: 0.55, tint: [0.97, 0.99, 1.04], fade: 1 - smooth(lt / 0.8) };
  },
  render(R, t, lt) {
    // warp toward the end
    const warp = ease.inCubic(clamp((lt - 18) / 7));
    const cam = camera(R.g, { eye: [0, 0, 0], target: [0.05, 0.01, -1], fov: 55, far: 3000 });
    R.nebula.draw({ time: t, alpha: 0.55 + warp * 0.4, drift: [lt * 0.01, 0] });
    R.stars.draw(cam, { time: t, twinkle: 0.35, model: m4.translate(0, 0, warp * 260), size: 1 + warp * 1.5, alpha: 0.9 });

    const o = R.o;
    const cy = camYear(lt);
    const X = (year) => 960 + (year - cy) * YPX;
    const la = win(lt, 0.2, 17.8, 1.0, 1.0);
    if (la > 0) {
      o.save();
      // timeline line with glow
      R.ga(la * 0.9);
      const grad = o.createLinearGradient(0, 0, 1920, 0);
      grad.addColorStop(0, 'rgba(158,216,255,0)'); grad.addColorStop(0.2, 'rgba(158,216,255,0.55)');
      grad.addColorStop(0.8, 'rgba(158,216,255,0.55)'); grad.addColorStop(1, 'rgba(158,216,255,0)');
      o.fillStyle = grad;
      o.fillRect(0, LINE_Y - 0.75, 1920, 1.5);
      // ticks + year labels
      setFont(o, { weight: 400, size: 17, family: FONT.mono });
      o.textBaseline = 'top';
      for (let y = 2019; y <= 2029; y++) {
        for (let m = 0; m < 12; m++) {
          const x = X(y + m / 12);
          if (x < -20 || x > 1940) continue;
          const edge = Math.min(1, x / 300, (1920 - x) / 300);
          R.ga(la * Math.max(0, edge) * (m === 0 ? 0.9 : 0.35));
          o.fillStyle = COLORS.text;
          o.fillRect(x - 0.5, LINE_Y - (m === 0 ? 12 : 5), 1, m === 0 ? 24 : 10);
          if (m === 0) {
            const lbl = String(y);
            const future = y >= 2026;
            o.fillStyle = future ? COLORS.dim : COLORS.text;
            const w = measureTracked(o, lbl, 4);
            drawTracked(o, lbl, x - w / 2, LINE_Y + 22, 4);
          }
        }
      }
      // cursor
      R.ga(la);
      o.fillStyle = COLORS.ice;
      o.shadowColor = COLORS.ice; o.shadowBlur = 16;
      o.beginPath(); o.arc(960, LINE_Y, 5, 0, Math.PI * 2); o.fill();
      o.shadowBlur = 0;
      o.restore();

      // event markers
      const marker = (year, label, a, color = COLORS.ice) => {
        const x = X(year);
        if (a <= 0 || x < -200 || x > 2120) return;
        o.save();
        R.ga(a * la);
        o.strokeStyle = color; o.lineWidth = 1.5;
        o.beginPath(); o.arc(x, LINE_Y, 9, 0, Math.PI * 2); o.stroke();
        o.fillStyle = color;
        setFont(o, { weight: 500, size: 14, family: FONT.sans });
        o.textBaseline = 'bottom';
        const w = measureTracked(o, label, 3);
        drawTracked(o, label, x - w / 2, LINE_Y - 22, 3);
        o.restore();
      };
      marker(2021 + 7 / 12, 'AUG 2021 · “WHAT 2026 LOOKS LIKE”', win(lt, 0.9, 30, 0.8, 1));
      marker(2024 + 3 / 12, 'APR 2024 · LEAVES OPENAI', win(lt, 9.4, 30, 0.8, 1));
      marker(2025 + 3 / 12, 'APR 2025 · “AI 2027”', win(lt, 14.0, 30, 0.8, 1), COLORS.gold);

      // 2021 essay card with predictions being checked off
      const x21 = X(2021 + 7 / 12);
      const ca = win(lt, 1.4, 9.6, 0.9, 0.7);
      card(o, R, x21 + 150, 640, 380, 150, ca * la, (o) => {
        setFont(o, { weight: 600, size: 15, family: FONT.sans });
        o.fillStyle = COLORS.text; o.textBaseline = 'top';
        drawTracked(o, 'WHAT 2026 LOOKS LIKE', x21 + 172, 660, 2.5);
        setFont(o, { weight: 400, size: 12, family: FONT.mono });
        o.fillStyle = COLORS.dim;
        o.fillText('D. KOKOTAJLO · AUGUST 2021', x21 + 172, 684);
        for (let i = 0; i < 4; i++) {
          const yy = 712 + i * 18;
          o.fillStyle = 'rgba(200,210,225,0.28)';
          o.fillRect(x21 + 200, yy + 3, 240 - (i * 37) % 90, 5);
          const ck = clamp((lt - 6.8 - i * 0.3) / 0.25);
          if (ck > 0) {
            o.save();
            o.globalAlpha *= ck;
            o.strokeStyle = COLORS.green; o.lineWidth = 2.2;
            o.beginPath(); o.moveTo(x21 + 174, yy + 6); o.lineTo(x21 + 180, yy + 12); o.lineTo(x21 + 191, yy - 1); o.stroke();
            o.restore();
          }
        }
      });
      // 2025 report card
      const x25 = X(2025 + 3 / 12);
      const ra = win(lt, 14.6, 17.8, 0.8, 0.6);
      card(o, R, x25 + 150, 630, 320, 160, ra * la, (o) => {
        setFont(o, { weight: 200, size: 44, family: FONT.wide, stretch: 'expanded' });
        o.fillStyle = COLORS.text; o.textBaseline = 'top';
        drawTracked(o, 'AI 2027', x25 + 172, 652, 10);
        setFont(o, { weight: 400, size: 12, family: FONT.mono });
        o.fillStyle = COLORS.gold;
        o.fillText('AI FUTURES PROJECT · APRIL 2025', x25 + 174, 716);
        o.fillStyle = COLORS.dim;
        o.fillText('KOKOTAJLO · ALEXANDER · LARSEN', x25 + 174, 740);
        o.fillText('LIFLAND · DEAN', x25 + 174, 758);
      });
    }
  },
};
