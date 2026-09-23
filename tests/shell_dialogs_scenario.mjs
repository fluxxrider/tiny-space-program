// Shell regression: Launch Pad dialog (header must not jump between crafts, stat tiles on one line), Astronaut Complex
// (no repeated flavour lines), label hover (description below the pill, pill does not move).
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/shell_dialogs_scenario.mjs --out shots/shell_dialogs_end.png [--size 1920x1080]
export default async function (page, { sleep, shot, log, evalJS }) {
  const W = page.viewport().width, H = page.viewport().height;
  const waitFor = async (expr, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* retry */ } await sleep(250); } log('TIMEOUT ' + expr); return false; };
  await waitFor('!!(window.TSP && TSP.ready && TSP.shell && TSP.shell.scene.titleCard)');
  await evalJS(`(TSP.shell.scene._dismissTitle(), document.querySelectorAll('.sh-hint').forEach((h) => h.remove()), true)`);
  await sleep(4000);
  const out = {};
  // label hover: the pill must stay where it was
  const pill = (id) => evalJS(`(() => { const r = document.querySelector('.sc-label[data-id="${id}"] .sc-label-pill').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  const p0 = await pill('vab');
  await page.mouse.move(p0[0], p0[1], { steps: 4 }); await sleep(1200);
  const p1 = await pill('vab');
  out.hover = { before: p0, after: p1, hover: await evalJS('TSP.shell.scene.hover'), under: await evalJS(`document.elementFromPoint(${p0[0]}, ${p0[1]})?.closest('.sc-label')?.dataset.id`) };
  await shot(`shots/shell_dialogs_${W}_1_label_hover.png`);
  await page.mouse.move(W - 4, 100); await sleep(400);
  // launch pad dialog
  await evalJS(`(TSP.shell.open('pad'), true)`);
  await waitFor(`!!document.querySelector('.sc-pad-modal .sc-craft-item')`);
  await sleep(1000);
  const head = () => evalJS(`Math.round(document.querySelector('.sc-pad-modal .sh-modal-head').getBoundingClientRect().top)`);
  const tiles = () => evalJS(`[...document.querySelectorAll('.sc-craft-stats .sh-stat-value')].map((e) => [e.textContent, e.getClientRects().length, Math.round(e.getBoundingClientRect().height)])`);
  const pick = async (name) => { await evalJS(`([...document.querySelectorAll('.sc-craft-item')].find((b) => b.textContent.includes(${JSON.stringify(name)}))?.click(), true)`); await sleep(700); return { head: await head(), tiles: await tiles() }; };
  out.pad = { flea: await pick('Flea'), lune: await pick('Lune'), bertha: await pick('Bertha') };
  await shot(`shots/shell_dialogs_${W}_2_pad_lune.png`);
  await page.keyboard.press('Escape'); await sleep(900);
  // astronaut complex
  await evalJS(`(TSP.shell.open('astronaut'), true)`);
  await waitFor(`!!document.querySelector('.sc-ac-modal .sc-crew-card')`);
  await sleep(1000);
  out.ac = await evalJS(`[...document.querySelectorAll('.sc-crew-card .sc-crew-quote')].map((e) => e.textContent)`);
  await shot(`shots/shell_dialogs_${W}_3_astronauts.png`);
  await page.keyboard.press('Escape'); await sleep(600);
  log(JSON.stringify(out));
  return { ...out, errors: await evalJS('TSP.app.errors.length') };
}
