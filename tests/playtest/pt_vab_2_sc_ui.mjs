// Playtest (vab scenario) part 2: space center UX with real mouse clicks: hover buildings, Launch Pad / Mission Control /
// Astronaut Complex dialogs, Settings (graphics low/medium, bloom off/on), Help, then click the VAB building in 3D.
// node tools/snap.mjs "index.html" --wait 6000 --script tests/playtest/pt_vab_2_sc_ui.mjs --out shots/pt_vab_scui_end.png [--size 1920x1080]
export default async function (page, { sleep, shot, log, evalJS }) {
  const W = page.viewport().width, H = page.viewport().height;
  const tag = W >= 1900 ? '1080' : '720';
  const P = (n) => `shots/pt_vab_scui${tag}_${n}.png`;
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch {} await sleep(200); } log('TIMEOUT ' + expr); return false; };
  const rectOf = (sel, text = null) => evalJS(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null); const t = ${JSON.stringify(text)}; const e = t ? els.find(x => x.textContent.includes(t)) : els[0]; if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2, r.width, r.height]; })()`);
  const click = async (sel, text = null) => { const p = await rectOf(sel, text); if (!p) { log('NO ELEMENT ' + sel + ' ' + text); return false; } await page.mouse.move(p[0], p[1], { steps: 4 }); await sleep(150); await page.mouse.click(p[0], p[1]); return true; };
  const bscreen = (id) => evalJS(`(() => { const s = TSP.shell.scene; const THREE = TSP.THREE; const hb = s._hitBoxes.filter(h => h.id === ${JSON.stringify(id)}); if (!hb.length) return null; const c = new THREE.Vector3(); hb[0].box.getCenter(c); c.applyQuaternion(s._Q).project(s.camera); return [ (c.x*0.5+0.5)*${W}, (-c.y*0.5+0.5)*${H} ]; })()`);
  const errs = () => evalJS('TSP.app.errors.length');
  await waitFor('!!(window.TSP && TSP.ready && TSP.shell)', 90000);
  await sleep(800);
  await page.mouse.click(W / 2, H / 2); // dismiss title
  await sleep(2500);
  // close the getting started hint via its Got it button
  await click('.sh-hint .tsp-btn', 'Got it');
  await sleep(600);
  // Hover each building mesh (3D pick, not label)
  for (const id of ['vab', 'pad', 'tracking', 'mission', 'astronaut']) {
    const p = await bscreen(id);
    log('building', id, JSON.stringify(p));
    if (!p) continue;
    await page.mouse.move(p[0], p[1], { steps: 5 });
    await sleep(900);
    const hov = await evalJS('TSP.shell.scene.hover');
    const cursor = await evalJS('TSP.app.canvas.style.cursor');
    log('hover', id, '->', hov, cursor);
    if (id === 'vab' || id === 'tracking') await shot(P(`1_hover_${id}`));
  }
  // Launch Pad via 3D building click
  let p = await bscreen('pad');
  await page.mouse.move(p[0], p[1], { steps: 4 }); await sleep(300);
  await page.mouse.click(p[0], p[1]);
  await waitFor(`!!document.querySelector('.sc-pad-modal')`, 15000);
  await sleep(1200);
  await shot(P('2_pad_dialog'));
  log('pad dialog items', JSON.stringify(await evalJS(`[...document.querySelectorAll('.sc-craft-item')].map(e => e.innerText.replace(/\\n/g,' | '))`)));
  await click('.sc-craft-item', 'Lune');
  await sleep(600);
  await shot(P('2b_pad_lune'));
  log('pad detail', JSON.stringify(await evalJS(`(document.querySelector('.sc-pad-modal .sc-craft-detail, .sc-pad-modal') || {}).innerText`)));
  await page.keyboard.press('Escape'); await sleep(800);
  // Mission Control via dock
  await click('.sc-dock-btn', 'Mission');
  await sleep(1500);
  await shot(P('3_mission'));
  await page.keyboard.press('Escape'); await sleep(800);
  // Astronaut complex via label click
  await click('.sc-label-pill', 'Astronaut');
  await sleep(1500);
  await shot(P('4_astronaut'));
  const hireBtn = await rectOf('.sh-modal button', 'Hire');
  log('hire button', JSON.stringify(hireBtn));
  await page.keyboard.press('Escape'); await sleep(800);
  // Settings
  const before = await evalJS(`({ calls: TSP.app.renderer.info.render.calls, tris: TSP.app.renderer.info.render.triangles, composer: !!TSP.shell.scene.composer, planetsQ: TSP.shell.scene.planets && TSP.shell.scene.planets.quality })`);
  log('before settings', JSON.stringify(before));
  await click('.sc-dock-btn', 'Settings');
  await sleep(1200);
  await shot(P('5_settings'));
  await click('.sh-seg-btn', 'Low');
  await sleep(2500);
  const low = await evalJS(`({ setting: TSP.game.settings.graphics, calls: TSP.app.renderer.info.render.calls, tris: TSP.app.renderer.info.render.triangles, composer: !!TSP.shell.scene.composer, planetsQ: TSP.shell.scene.planets && TSP.shell.scene.planets.quality })`);
  log('after Low', JSON.stringify(low));
  await shot(P('5b_settings_low'));
  await click('.sh-seg-btn', 'Medium');
  await sleep(2500);
  const med = await evalJS(`({ setting: TSP.game.settings.graphics, calls: TSP.app.renderer.info.render.calls, tris: TSP.app.renderer.info.render.triangles, composer: !!TSP.shell.scene.composer, planetsQ: TSP.shell.scene.planets && TSP.shell.scene.planets.quality })`);
  log('after Medium', JSON.stringify(med));
  // Bloom toggle off / on (click the toggle track)
  const bloomRow = await evalJS(`(() => { const rows = [...document.querySelectorAll('.sh-set-row')]; const r = rows.find(x => /Bloom/.test(x.innerText)); const t = r.querySelector('.sh-toggle-track'); const b = t.getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })()`);
  await page.mouse.click(bloomRow[0], bloomRow[1]); await sleep(1500);
  log('bloom off', JSON.stringify(await evalJS(`({ bloom: TSP.game.settings.bloom, composer: !!TSP.shell.scene.composer })`)));
  await page.keyboard.press('Escape'); await sleep(1200);
  await shot(P('5c_bloom_off'));
  await click('.sc-dock-btn', 'Settings'); await sleep(1000);
  const bloomRow2 = await evalJS(`(() => { const rows = [...document.querySelectorAll('.sh-set-row')]; const r = rows.find(x => /Bloom/.test(x.innerText)); const t = r.querySelector('.sh-toggle-track'); const b = t.getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })()`);
  await page.mouse.click(bloomRow2[0], bloomRow2[1]); await sleep(1500);
  log('bloom on', JSON.stringify(await evalJS(`({ bloom: TSP.game.settings.bloom, composer: !!TSP.shell.scene.composer })`)));
  await click('.sh-seg-btn', 'High'); await sleep(1500);
  await page.keyboard.press('Escape'); await sleep(1200);
  await shot(P('5d_bloom_on_high'));
  // Help
  await click('.sc-dock-btn', 'Help'); await sleep(1200);
  await shot(P('6_help'));
  const helpScroll = await evalJS(`(() => { const b = document.querySelector('.sh-modal .sh-modal-body'); return b ? [b.scrollHeight, b.clientHeight] : null; })()`);
  log('help body scroll', JSON.stringify(helpScroll));
  await page.keyboard.press('Escape'); await sleep(800);
  // Click the VAB building in 3D
  p = await bscreen('vab');
  await page.mouse.move(p[0], p[1], { steps: 4 }); await sleep(400);
  await page.mouse.click(p[0], p[1]);
  await sleep(300);
  await shot(P('7_vab_swoop'));
  await waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching && !!TSP.vab`, 60000);
  await sleep(2500);
  await shot(P('8_vab_first'));
  const vhints = await evalJS(`[...document.querySelectorAll('.sh-hint, .vab-hints, .vab-onboard, [class*=onboard]')].filter(e=>e.offsetParent).map(h => h.className + ': ' + h.innerText.slice(0,200))`);
  log('vab hints', JSON.stringify(vhints));
  log('errors', await errs());
  return 'ok';
}
