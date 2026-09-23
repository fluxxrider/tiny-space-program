// More helpers for the lune playtest: loading a saved universe, map projection, clicking DOM elements.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export async function loadSave(page, h, saveModule, { scene = 'tracking' } = {}) {
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), saveModule);
  const save = (await import(pathToFileURL(file).href + '?t=' + Date.now())).default;
  // we start on a static page of the same origin (tests/_webgl_probe.html) so no autosave can overwrite the injected save
  // (leaving a live game page fires its pagehide autosave, which would clobber tsp.persistent)
  if (!/_webgl_probe\.html/.test(page.url())) {
    const o = new URL(page.url()).origin;
    await page.goto(`${o}/tests/_webgl_probe.html`, { waitUntil: 'load', timeout: 60000 });
  }
  await page.evaluate((json) => { localStorage.clear(); localStorage.setItem('tsp.persistent', json); }, JSON.stringify(save));
  const origin = new URL(page.url()).origin;
  page.on('error', (e) => h.log('PAGE CRASH ' + (e?.message || e)));
  await page.goto(`${origin}/index.html?scene=${scene}&debug=1`, { waitUntil: 'load', timeout: 60000 });
  await h.waitFor('!!(window.TSP && window.TSP.ready)', 90000);
  return save;
}

export function writeSave(snapJson, name) {
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), name);
  fs.writeFileSync(file, 'export default ' + snapJson + ';\n');
}

export async function saveUniverseTo(h, name) {
  const snap = await h.evalJS(`import('/src/game/persistence.js').then(m => JSON.stringify(m.snapshotUniverse()))`);
  writeSave(snap, name);
  h.log('saved ' + name + ' bytes ' + snap.length);
}

// click the first element matching selector whose text includes `text`
export async function clickText(page, h, selector, text) {
  const box = await page.evaluate((sel, txt) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => !txt || e.textContent.includes(txt));
    const e = els.find((x) => x.getBoundingClientRect().width > 0);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, selector, text || '');
  if (!box) { h.log(`clickText: no ${selector} "${text}"`); return false; }
  await page.mouse.move(box.x, box.y);
  await h.sleep(80);
  await page.mouse.down();
  await h.sleep(60);
  await page.mouse.up();
  return true;
}

// screen position of a body in the map
export const BODY_SCREEN = (id) => `(() => { const m = TSP.map; const b = m.bodies.get('${id}'); const s = m._project(b.scene, {x:0,y:0,front:false}); return { x: s.x, y: s.y, front: s.front, px: b.pxRadius }; })()`;
