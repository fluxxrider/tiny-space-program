// Worlds playtest: how other bodies look in the sky (narrow FOV "telescope" views), and whether stars show through a
// planet's dark disc.
// Usage: node tools/snap.mjs "index.html?scene=flight&craft=pip_probe&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_skybodies.mjs --out shots/pt_worlds_skybodies_end.png
// PT_VIEWS="from:alt:target:fov,..." (default: a tour).
import { install, settle, waitReady } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const views = (process.env.PT_VIEWS || 'pip:30000:verda:6,lune:30000:verda:12,verda:200000:lune:3,nib:30000:rusta:25,rusta:100000:nib:4,verda:200000:pip:0.5')
    .split(',').map((s) => { const [from, alt, target, fov] = s.split(':'); return { from, alt: +alt, target, fov: +fov }; });
  const out = { views: [] };
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  for (const v of views) {
    // put the vessel on the side of `from` facing `target`, so the target is overhead
    await evalJS(`(() => {
      const U = PT.U, V = PT.THREE.Vector3, ut = TSP.game.ut;
      TSP.physics.orbit('${v.from}', ${v.alt}, 0);
      const vs = TSP.physics.sim.active, b = PT.B.BODIES['${v.from}'];
      const d = U.bodyPosition('${v.target}', ut, new V()).sub(U.bodyPosition('${v.from}', ut, new V())).normalize();
      const r = b.radius + ${v.alt};
      vs.pos.copy(d).multiplyScalar(r);
      const t = new V(0, 1, 0).cross(d).normalize();
      vs.vel.copy(t).multiplyScalar(Math.sqrt(b.mu / r));
      TSP.physics.sim._refreshOrbit(vs);
      return true;
    })()`);
    await evalJS(`(PT.setCam({ pos: [0, 0, 3], body: '${v.target}', fov: ${v.fov} }), PT.hideUI(true), true)`);
    await settle(page, sleep, { maxMs: 30000 });
    const info = await evalJS(`(() => {
      const U = PT.U, V = PT.THREE.Vector3, ut = TSP.game.ut, vs = TSP.flightScene.vessel();
      const cam = U.bodyPosition(vs.bodyId, ut, new V()).add(vs.pos);
      const tp = U.bodyPosition('${v.target}', ut, new V());
      const sun = U.bodyPosition('sola', ut, new V());
      const toT = tp.clone().sub(cam), dist = toT.length();
      const phase = toT.clone().normalize().negate().dot(sun.clone().sub(tp).normalize());   // 1 = full, -1 = new
      const R = PT.B.BODIES['${v.target}'].radius;
      const pl = TSP.flightScene.scene.planets, bv = pl.bodies.get('${v.target}');
      return { dist: Math.round(dist), angDiamDeg: +(2 * Math.atan(R / dist) * 180 / Math.PI).toFixed(3), phaseCos: +phase.toFixed(3),
        angPx: Math.round(bv.angPx), meshVisible: bv.group.visible, lod: pl.stats().bodies['${v.target}'] || null };
    })()`);
    const file = `shots/pt_worlds_skybodies_${v.from}_${v.target}.png`;
    await shot(file);
    // optional: repeat the same view over time (is a defect transient LOD streaming or persistent?)
    const rep = Number(process.env.PT_REPEAT || 0);
    info.repeats = [];
    for (let i = 1; i <= rep; i++) {
      await sleep(6000);
      const f = `shots/pt_worlds_skybodies_${v.from}_${v.target}_r${i}.png`;
      await shot(f);
      info.repeats.push({ f, lod: await evalJS(`(() => { const pl = TSP.flightScene.scene.planets; const bv = pl.bodies.get('${v.target}'); let shown = 0, meshes = 0; bv.lod.group.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) shown++; } }); return { stats: pl.stats().bodies['${v.target}'] || null, building: pl.service.busy, meshes, shown }; })()`) });
    }
    out.views.push({ ...v, ...info, file });
    log(v.from, '->', v.target, JSON.stringify(info));
  }
  return out;
}
