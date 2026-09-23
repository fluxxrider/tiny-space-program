// snap.mjs --script: KSP-grade radial building, the Engineer's staging checks and the first-rocket guide, driven with
// the real mouse/keyboard wherever the player would use them.
// node tools/snap.mjs "index.html?scene=vab&debug=1" --wait 7000 --script tests/vab_scenario_radial.mjs --out shots/vab_radial_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const wait = async (cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJS(cond)) return true; await sleep(200); } return false; };
  const results = [];
  const check = async (label, cond) => { const ok = !!(await evalJS(cond)); results.push({ label, ok }); log(`${ok ? 'OK  ' : 'FAIL'} ${label}`); return ok; };
  const move = async (x, y, steps = 6) => { await page.mouse.move(x, y, { steps }); await sleep(500); };
  const clickAt = async (x, y) => { await move(x, y); await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(600); };
  const tab = async (cat) => { await page.click(`.vab-tab[data-cat="${cat}"]`); await sleep(200); };
  const card = async (id) => { await page.click(`.vab-card[data-id="${id}"]`); await sleep(1100); };
  // let the scene run a couple of frames (SwiftShader frames can be slow: never trust a fixed sleep)
  const frames = (n = 3) => evalJS(`new Promise(r => { let k = ${n}; const f = () => (--k <= 0 ? r(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
  const key = async (code, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(code); await sleep(60); await frames(2); } await frames(3); };
  const uid = async (part, i = 0) => evalJS(`TSP.vab.partUids('${part}')[${i}]`);
  const count = (part) => evalJS(`TSP.vab.partUids('${part}').length`);
  const held = () => evalJS('TSP.vab.held()');
  const setSym = async (n) => { for (let i = 0; i < 8 && (await evalJS('TSP.vab.scene.symMode')) !== n; i++) await key('KeyX'); };
  const noErrors = async (label) => check(`${label}: no page errors`, '!(TSP.app && TSP.app.errors && TSP.app.errors.length)');

  await wait('!!(window.TSP && window.TSP.vab)');
  await sleep(1500);

  // 0) empty hangar: neutral Engineer badge, guide on, readable hint pill, short category labels
  await check('empty hangar: Engineer badge is neutral', "document.querySelector('.vab-eng-sum').textContent === 'Empty' && document.querySelector('.vab-eng-sum').classList.contains('idle')");
  await check('empty hangar: guide card waits behind the empty-state card, but the pod card glows', "!document.querySelector('.vab-guide.show') && document.querySelector('.vab-card.guide')?.dataset.id === 'pod_mk1'");
  await check('Aerodynamics tab label fits', "(() => { const l = document.querySelector('.vab-tab[data-cat=\"aero\"] .vab-tab-label'); return l.textContent === 'Aero' && l.scrollWidth <= l.clientWidth + 1; })()");
  await check('hint bar has a backing pill', "getComputedStyle(document.querySelector('.vab-hints')).backgroundColor !== 'rgba(0, 0, 0, 0)'");
  await shot('shots/vab_radial_0_empty.png');

  // 1) pod → FT-800 → Reliant (real mouse)
  await card('pod_mk1');
  await check('guide appears once the pod is picked (step 1 current)', "document.querySelector('.vab-guide.show .vab-guide-step.current .vab-guide-label')?.textContent === 'Pick a command pod'");
  await clickAt(660, 380);
  const pod = await uid('pod_mk1');
  await tab('fuel'); await card('tank_t800');
  let n = await evalJS(`TSP.vab.nodeScreen(${pod}, 'bottom')`);
  await clickAt(n.x + 4, n.y + 14);
  const tank = await uid('tank_t800');
  await check('tank stacked', `!!${tank}`);
  await check('guide moved on to the parachute (tank done out of order is fine)', "document.querySelector('.vab-guide-step.current .vab-guide-label')?.textContent === 'Parachute on top' && document.querySelectorAll('.vab-guide-step.done').length === 2");
  await evalJS('TSP.vab.frame(true)'); await sleep(700);
  await tab('engine'); await card('eng_reliant');
  n = await evalJS(`TSP.vab.nodeScreen(${tank}, 'bottom')`);
  await clickAt(n.x - 3, n.y + 12);
  await check('engine stacked', "TSP.vab.partUids('eng_reliant').length === 1");
  await evalJS('TSP.vab.frame(true)'); await sleep(900);
  await shot('shots/vab_radial_1_guide_progress.png');

  // 2) fins: Q/E roll about the surface normal (stays outside), A/D turns it into the tank → red, refused
  await tab('aero'); await card('fin_basic');
  await setSym(1);
  let s = await evalJS(`TSP.vab.surfaceScreen(${tank}, -1.3)`);
  await move(s.x, s.y);
  const span = () => evalJS("(() => { const h = TSP.vab.scene.held; if (!h || !h.cand) return null; const x = new TSP.THREE.Vector3(1,0,0).applyQuaternion(h.cand.rot); const c = h.cand.pos; const out = new TSP.THREE.Vector3(c.x, 0, c.z).normalize(); return { kind: h.cand.kind, outward: +x.dot(out).toFixed(2), clip: !!h.clip }; })()");
  log('fin initial', JSON.stringify(await span()));
  await key('KeyE', 2);
  const afterE = await span();
  log('fin after E ×2', JSON.stringify(afterE));
  await check('E rolls the fin about the surface normal: still outward, still placeable', `(() => { const r = ${JSON.stringify(afterE)}; return r && r.kind === 'surface' && r.outward > 0.97 && !r.clip; })()`);
  await key('KeyA', 2);
  const afterA = await span();
  log('fin after A ×2', JSON.stringify(afterA));
  await check('A ×2 turns it into the tank: flagged as clipping', `(() => { const r = ${JSON.stringify(afterA)}; return r && r.outward < -0.97 && r.clip; })()`);
  await check('clipping ghost has a red cursor label', "document.querySelector('.vab-cursor-label.bad') && /Clips into/.test(document.querySelector('.vab-cursor-label').textContent)");
  await shot('shots/vab_radial_2_fin_clipping.png');
  const fins0 = await count('fin_basic');
  await clickAt(s.x, s.y);
  await check('clicking a clipping ghost does not place it', `TSP.vab.partUids('fin_basic').length === ${fins0} && !!TSP.vab.held()`);
  await key('KeyA', 2);
  await check('turned back out: placeable again', '(() => { const h = TSP.vab.held(); return h && h.cand === "surface" && !h.clip; })()');
  await key('Escape');

  // 3) two radial decouplers (×2), then a Hammer on one of them with symmetry STILL at ×2
  await tab('coupling'); await card('decoupler_radial');
  await setSym(2);
  s = await evalJS(`TSP.vab.surfaceScreen(${tank}, -0.3)`);
  await clickAt(s.x, s.y);
  await check('2 radial decouplers', "TSP.vab.partUids('decoupler_radial').length === 2");
  const dec = await uid('decoupler_radial');
  await tab('engine'); await card('srb_hammer');
  await check('symmetry still ×2 in the toolbar', 'TSP.vab.scene.symMode === 2');
  const dp = await evalJS(`TSP.vab.partScreen(${dec})`);
  await move(dp.x, dp.y);
  let h = await held();
  log('held booster on the decoupler (centre)', JSON.stringify(h));
  await check('ghost: one booster per decoupler (inherited ×2), not four', `(() => { const h = TSP.vab.held(); return h && h.cand === 'surface' && h.placements === 2 && h.plan.inherited && !h.clip; })()`);
  await check('cursor label explains the inherited symmetry', "/symmetry from the Radial Decoupler/.test(document.querySelector('.vab-cursor-label')?.textContent || '')");
  await shot('shots/vab_radial_3_booster_ghost.png');
  // aim at the decoupler's front / side faces: the attach point never moves off the outer face centre
  const radii = [];
  for (const [ox, oy] of [[-5, 0], [5, 0], [0, -9], [0, 9]]) {
    await move(dp.x + ox, dp.y + oy, 3);
    radii.push(await evalJS("(() => { const c = TSP.vab.scene.held.cand; return c.kind === 'surface' && c.parentUid === " + dec + " ? +Math.hypot(c.pos.x, c.pos.z).toFixed(3) : c.kind + ':' + c.parentUid; })()"));
  }
  log('booster axis distance for aim points around the decoupler', JSON.stringify(radii));
  await check('every aim point on the decoupler gives the outer-face centre (r = 1.45 m)', `${JSON.stringify(radii)}.filter(r => typeof r === 'number').every(r => Math.abs(r - 1.45) < 0.0015)`);
  await move(dp.x, dp.y, 3);
  await clickAt(dp.x, dp.y);
  await check('exactly 2 boosters placed, 1.45 m from the core axis, outward', "(() => { const b = TSP.vab.getCraft().parts.filter(p => p.part === 'srb_hammer'); return b.length === 2 && b.every(p => Math.abs(Math.hypot(p.pos[0], p.pos[2]) - 1.45) < 1e-4); })()");
  await check('staging shows Hammer ×2', "[...document.querySelectorAll('.vab-sicon')].some(c => /Hammer Solid Booster ×2/.test(c.title))");
  await evalJS('TSP.vab.frame(true)'); await sleep(900);

  // 4) the classic staging mistake: radial decouplers dragged into the launch stage
  const decUids = await evalJS("TSP.vab.partUids('decoupler_radial')");
  const launch = await evalJS('Math.max(...TSP.vab.getCraft().parts.map(p => p.stage))');
  const chip = await evalJS(`(() => { const c = [...document.querySelectorAll('.vab-sicon')].find(c => /Radial Decoupler/.test(c.title)); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const target = await evalJS(`(() => { const s = document.querySelector('.vab-stage[data-stage="${launch}"] .vab-stage-icons'); const r = s.getBoundingClientRect(); return { x: r.right - 20, y: r.y + r.height / 2 }; })()`);
  await page.mouse.move(chip.x, chip.y, { steps: 3 }); await page.mouse.down(); await sleep(100);
  await page.mouse.move(target.x, target.y, { steps: 10 }); await sleep(300); await page.mouse.up(); await sleep(900);
  await check('decouplers now in the launch stage', `TSP.vab.getCraft().parts.filter(p => p.part === 'decoupler_radial').every(p => p.stage === ${launch})`);
  await check('Engineer: boosters jettisoned at ignition', "/jettisoned the moment it ignites/.test(document.querySelector('.vab-eng-list').textContent)");
  await check('Engineer offers Fix staging', "!!document.querySelector('.vab-eng-fix')");
  // hovering the warning highlights the offending parts
  const warnEl = await evalJS("(() => { const e = [...document.querySelectorAll('.vab-eng-item.has-parts')].find(e => /jettisoned/.test(e.textContent)); const r = e.getBoundingClientRect(); return { x: r.x + 30, y: r.y + 10 }; })()");
  await move(warnEl.x, warnEl.y);
  await check('hovering the warning highlights decouplers + boosters', `TSP.vab.scene.stageHighlight && TSP.vab.scene.stageHighlight.size === 4`);
  await shot('shots/vab_radial_4_engineer_staging.png');
  await page.click('.vab-eng-fix'); await sleep(900);
  await check('Fix staging: decouplers fire after the boosters again, warning gone', `TSP.vab.getCraft().parts.filter(p => p.part === 'decoupler_radial').every(p => p.stage === ${launch} - 1) && !/jettisoned/.test(document.querySelector('.vab-eng-list').textContent)`);
  // staging preview: hover the booster-separation stage card → decouplers fire (orange), boosters fall away (red)
  const sepCard = await evalJS(`(() => { const c = document.querySelector('.vab-stage[data-stage="${launch - 1}"] .vab-stage-head'); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await move(sepCard.x, sepCard.y);
  await check('stage preview: the separation stage drops both boosters', "(() => { const p = TSP.vab.scene.stagePreview; const b = TSP.vab.partUids('srb_hammer'); return !!p && b.every(u => p.drop.includes(u)) && p.fire.length === 2; })()");
  await shot('shots/vab_radial_4b_stage_preview.png');
  await move(700, 200);
  await check('stage preview cleared when leaving the panel', '!TSP.vab.scene.stagePreview');

  // 5) carrying the boosters: the launch stage keeps its ΔV (no 0 m/s launch stage)
  const ham = await uid('srb_hammer');
  const hp = await evalJS(`TSP.vab.partScreen(${ham})`);
  await clickAt(hp.x, hp.y + 25);
  await check('carrying a booster pair', "TSP.vab.held() && TSP.vab.held().part === 'srb_hammer'");
  await check('launch stage still shows its ΔV while the boosters are carried', `(() => { const s = document.querySelector('.vab-stage.launch .vab-stage-dv'); return !!s && parseInt(s.textContent.replace(/\\D/g, '')) > 1000; })()`);
  await shot('shots/vab_radial_5_carry_booster.png');
  await key('Escape');
  await check('Esc restores both boosters', "TSP.vab.partUids('srb_hammer').length === 2");
  await noErrors('radial building');

  // 6) 5- and 6-stage stock rockets fit the staging panel at this size without scrolling
  await evalJS("TSP.vab.loadStock('heavy_lifter')"); await sleep(1500);
  await check('Big Bertha: every stage card visible', "(() => { const l = document.querySelector('.vab-stage-list'); return l.scrollHeight <= l.clientHeight + 2; })()");
  await check('stats pill labels on one line', "[...document.querySelectorAll('.vab-stat-k')].every(k => k.getBoundingClientRect().height < 16)");
  await check('guide hidden for stock crafts', "!document.querySelector('.vab-guide.show')");
  await shot('shots/vab_radial_6_bertha_staging.png');
  await evalJS("TSP.vab.loadStock('lune_lander')"); await sleep(1500);
  await check('Lune Lander (6 stages): every stage card visible', "(() => { const l = document.querySelector('.vab-stage-list'); return document.querySelectorAll('.vab-stage').length === 6 && l.scrollHeight <= l.clientHeight + 2; })()");
  await check('Lune Lander: 6 legs, Engineer nominal', "TSP.vab.partUids('legs_lt1').length === 6 && TSP.vab.stats().valid.warnings.length === 0");
  await shot('shots/vab_radial_6b_lander_staging.png');

  // 7) corrupt saved-craft storage never breaks the Load dialog
  await evalJS(`(() => {
    const alien = TSP.vab.getCraft(); alien.name = 'Alien Parts';
    alien.parts.find(p => p.part === 'solar_panel').part = 'no_such_part';
    localStorage.setItem('tsp.crafts', JSON.stringify({ Bad: null, Odd: 7, Broken: { updated: 1, craft: '{nope' },
      'Alien Parts': { updated: Date.now(), craft: JSON.stringify(alien) } }));
    return true; })()`);
  await page.click('.vab-top button[title="Load a stock or saved craft"]'); await sleep(900);
  await check('Load dialog opens on corrupt storage', "!!document.querySelector('.vab-load') && document.querySelectorAll('.vab-load-row').length === 2");
  await shot('shots/vab_radial_7_load_corrupt.png');
  await page.evaluate(() => [...document.querySelectorAll('.vab-load-row')].find(r => /Alien Parts/.test(r.textContent)).click());
  await sleep(1500);
  await check('a save with an unknown part loads without it (and says so)', "TSP.vab.getCraft().name === 'Alien Parts' && TSP.vab.partUids('solar_panel').length === 1 && [...document.querySelectorAll('.tsp-toast')].some(t => /could not be rebuilt/.test(t.textContent))");
  await noErrors('unknown-part load');
  await noErrors('end');
  const failed = results.filter(r => !r.ok).map(r => r.label);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  return { passed: results.length - failed.length, failed };
}
