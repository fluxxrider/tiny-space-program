// EARLY 2026 — Coding Automation: walls of code written at machine speed by Agent-1.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, hash1, m4 } from '../engine/math.js';
import { FONT, setFont, COLORS, decodeText } from '../engine/text.js';
import { label } from './ui.js';

export const CODE = [
  'import torch', 'from agents import Sandbox, Task', '', 'class ResearchAgent:', '    def __init__(self, model, sandbox):',
  '        self.model = model', '        self.sandbox = sandbox', '', '    def run_experiment(self, idea):', '        plan = self.model.plan(idea)',
  '        for step in plan.steps:', '            result = self.sandbox.execute(step)', '            if result.failed:', '                step = self.model.debug(step, result.log)',
  '                result = self.sandbox.execute(step)', '        return self.model.summarize(plan, result)', '', 'def train_step(model, batch, opt):',
  '    logits = model(batch.inputs)', '    loss = cross_entropy(logits, batch.targets)', '    loss.backward()', '    clip_grad_norm_(model.parameters(), 1.0)',
  '    opt.step(); opt.zero_grad()', '    return loss.item()', '', '# sweep learning rates in parallel', 'for lr in [3e-4, 1e-4, 3e-5]:',
  '    jobs.submit(train, lr=lr, gpus=4096)', '', 'def evaluate(model, suite="research-bench"):', '    scores = [run(task, model) for task in suite]',
  '    return sum(scores) / len(scores)', '', 'assert evaluate(model) > baseline  # 2,184 tests passed', 'optimizer = AdamW(model.parameters(), lr=3e-4)',
  'scheduler = CosineSchedule(optimizer, warmup=2000)', 'data = stream("pretrain-mix-v9", shuffle=True)', 'ckpt.save(model, f"agent1-step{step}")',
];
const KW = /^(import|from|class|def|for|in|if|return|assert|and|or|not)$/;

export function drawCodeLine(o, line, x, y, size, alpha) {
  const toks = line.split(/(\s+|[()[\],.:=+\-*/#"<>])/).filter(s => s !== '');
  let cx = x;
  let comment = false, str = false;
  for (const tk of toks) {
    if (tk === '#') comment = true;
    let col = COLORS.text;
    if (comment) col = '#5f6b7a';
    else if (tk === '"') { str = !str; col = '#9fe6a0'; }
    else if (str) col = '#9fe6a0';
    else if (KW.test(tk)) col = '#c7a2ff';
    else if (/^[0-9.e\-,]+$/.test(tk) && /[0-9]/.test(tk)) col = '#ffc978';
    else if (/^[A-Z][A-Za-z]+$/.test(tk)) col = '#8fd0ff';
    o.globalAlpha = alpha;
    o.fillStyle = col;
    o.fillText(tk, cx, y);
    cx += o.measureText(tk).width;
  }
}

export default {
  grade(lt) { return { vignette: 0.75, bloom: 0.6, grain: 0.035, fade: 1 - smooth(lt / 0.5) }; },
  render(R, t, lt) {
    const cam = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.35, a: [0.03, 0.06, 0.1], b: [0.08, 0.04, 0.12] });
    const o = R.o;
    o.save();
    o.textBaseline = 'alphabetic';
    const cols = [
      { x: 70, d: 0.45, sp: 34, a: 0.28 }, { x: 440, d: 0.7, sp: 60, a: 0.45 }, { x: 1300, d: 0.62, sp: 52, a: 0.4 },
      { x: 1600, d: 0.42, sp: 30, a: 0.25 }, { x: 760, d: 1.0, sp: 120, a: 0.95 },
    ];
    const reveal = smooth((lt - 0.2) / 1.2);
    for (const [ci, c] of cols.entries()) {
      const size = 21 * c.d;
      const lh = size * 1.55;
      setFont(o, { weight: 400, size, family: FONT.mono });
      const scroll = (lt + 3) * c.sp * (1 + lt * 0.12);
      const first = Math.floor(scroll / lh);
      for (let k = -1; k < 1080 / lh + 2; k++) {
        const li = first + k;
        const y = k * lh - (scroll % lh) + 140;
        if (y < 120 || y > 980) continue;
        const line = CODE[(li * 7 + ci * 13) % CODE.length];
        const edge = Math.min(1, (y - 120) / 120, (980 - y) / 120);
        const isNew = ci === 4 && k > 1080 / lh - 6;
        let shown = line;
        if (ci === 4) {
          // the front column is being typed live at the bottom
          const typeP = clamp(((scroll % lh) / lh) * 1.4);
          if (k >= Math.floor(840 / lh) - 1) shown = line.slice(0, Math.floor(line.length * typeP));
        }
        drawCodeLine(o, shown, c.x, y, size, c.a * edge * reveal * R.alpha * (isNew ? 1 : 1));
        if (ci === 4 && hash1(li * 3.3) > 0.8) {
          o.globalAlpha = 0.12 * edge * reveal;
          o.fillStyle = COLORS.green;
          o.fillRect(c.x - 12, y - size, 560, lh);
        }
      }
    }
    o.restore();
    // Agent-1 badge + tests ticker
    const ba = win(lt, 3.6, 10, 0.5, 0.4);
    if (ba > 0) {
      o.save();
      R.ga(ba);
      o.fillStyle = 'rgba(6,10,16,0.85)';
      o.fillRect(1180, 200, 560, 150);
      o.strokeStyle = 'rgba(158,216,255,0.5)'; o.strokeRect(1180, 200, 560, 150);
      setFont(o, { weight: 300, size: 46, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.ice; o.textBaseline = 'alphabetic';
      o.fillText(decodeText('AGENT-1', clamp((lt - 3.6) / 0.8), 3), 1210, 268);
      const tests = Math.floor(Math.max(0, lt - 4) * 740 + 1200);
      label(o, `${tests.toLocaleString('en-US')} TESTS PASSED  ·  ${Math.floor(Math.max(0, lt - 4) * 9 + 31)} PULL REQUESTS MERGED`, 1210, 312, { align: 'left', size: 13, color: COLORS.green, tracking: 0.12, family: FONT.mono });
      o.restore();
    }
  },
};
