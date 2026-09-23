// Shared helpers for the "worlds" playtest scripts (tests/playtest/pt_worlds_*.mjs).
// Installs window.PT in the page: sun geometry helpers, a camera override (look anywhere, e.g. up at the sky),
// a settle() that waits for the terrain LOD to finish streaming, and lander staging helpers.

export async function install(page, evalJS) {
  await page.evaluate(async () => {
    if (window.PT) return true;
    const U = await import('/src/physics/universe.js');
    const T = await import('/src/world/terrain.js');
    const B = await import('/src/data/bodies.js');
    const THREE = window.TSP.THREE || await import('three');
    const PT = (window.PT = { U, T, B, THREE, camOverride: null });
    const sc = () => window.TSP.flightScene.scene;

    /** Sun direction in the body-fixed frame at the body centre → subsolar lat/lon. */
    PT.subsolar = (bodyId, ut = window.TSP.game.ut) => {
      const s = U.sunDirection(bodyId, new THREE.Vector3(), ut, new THREE.Vector3());
      const f = U.inertialToFixed(bodyId, s, ut, new THREE.Vector3());
      return B.dirToLatLon(f.x, f.y, f.z);
    };
    /** Longitude (equator-ish, at lat) where the sun stands at elevDeg; side 'pm' = evening (east of subsolar), 'am' = morning. */
    PT.lonForSun = (bodyId, elevDeg, side = 'pm', ut) => {
      const ss = PT.subsolar(bodyId, ut);
      const d = 90 - elevDeg;
      let lon = ss.lon + (side === 'pm' ? d : -d);
      lon = ((lon + 540) % 360) - 180;
      return lon;
    };
    PT.sunAngles = () => {
      const v = window.TSP.flightScene.vessel();
      return U.sunAngles(v.bodyId, v.pos, window.TSP.game.ut);
    };
    /** Local ENU frame at the vessel (scene axes). */
    PT.enu = () => {
      const v = window.TSP.flightScene.vessel();
      const up = v.pos.clone().normalize();
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y);
      if (north.lengthSq() < 1e-8) north.set(1, 0, 0);
      north.normalize();
      const east = new THREE.Vector3().crossVectors(north, up).normalize();
      return { up, north, east };
    };
    const enuVec = (a, f) => new THREE.Vector3().addScaledVector(f.east, a[0]).addScaledVector(f.north, a[1]).addScaledVector(f.up, a[2]);
    /**
     * Camera override: { pos:[e,n,u] metres from the vessel CoM, look:[e,n,u] direction } in local ENU, or
     * { pos, target:[e,n,u] } to look at a point; { sun:true } looks at the sun; { body:'lune' } looks at a body.
     * Pass null to give the camera back.
     */
    PT.setCam = (o) => { PT.camOverride = o; };
    const cam = sc().cam;
    if (!cam._ptWrapped) {
      const orig = cam.update;
      cam.update = function (dt, p) {
        orig.call(this, dt, p);
        const o = PT.camOverride;
        if (!o) return;
        const c = this.camera;
        const f = PT.enu();
        const pos = enuVec(o.pos || [0, 0, 0], f);
        c.position.copy(pos);
        let dir;
        if (o.sun) dir = sc().planets.sunDirection.clone();
        else if (o.body) {
          const v = window.TSP.flightScene.vessel();
          const ut = window.TSP.game.ut;
          const bp = U.bodyPosition(o.body, ut, new THREE.Vector3());
          const vp = U.bodyPosition(v.bodyId, ut, new THREE.Vector3()).add(v.pos);
          dir = bp.sub(vp).normalize();
        } else if (o.target) dir = enuVec(o.target, f).sub(pos).normalize();
        else dir = enuVec(o.look || [0, 1, 0], f).normalize();
        c.up.copy(Math.abs(dir.dot(f.up)) > 0.98 ? f.north : f.up);
        c.lookAt(pos.clone().add(dir));
        if (o.fov && c.fov !== o.fov) { c.fov = o.fov; c.updateProjectionMatrix(); }
        c.updateMatrixWorld();
      };
      cam._ptWrapped = true;
    }
    /**
     * Circular equatorial orbit at `alt` with the vessel `angleDeg` east of the subsolar meridian
     * (0 = noon, 90 = evening terminator, 180 = midnight, -90 = morning terminator).
     */
    PT.orbitAt = (bodyId, alt, angleDeg = 0, incDeg = 0) => {
      const sim = window.TSP.physics.sim;
      window.TSP.physics.orbit(bodyId, alt, incDeg);
      const v = sim.active, b = B.BODIES[bodyId], ut = window.TSP.game.ut;
      const s = U.sunDirection(bodyId, new THREE.Vector3(), ut, new THREE.Vector3());
      s.y = 0; s.normalize();
      s.applyAxisAngle(new THREE.Vector3(0, 1, 0), angleDeg * Math.PI / 180);
      const r = b.radius + alt, sp = Math.sqrt(b.mu / r);
      v.pos.copy(s).multiplyScalar(r);
      v.vel.set(s.z, 0, -s.x).multiplyScalar(sp);
      v.rot.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.vel.clone().normalize());
      v.angVel.set(0, 0, 0);
      sim._refreshOrbit(v);
      return v.orbit;
    };
    /** Terrain height (m, natural surface incl. sea floor) under lat/lon. */
    PT.hAt = (bodyId, lat, lon) => { const d = B.latLonToDir(lat, lon); return T.terrainHeight(bodyId, d.x, d.y, d.z); };
    // keep a CPU copy of every chunk's vertex positions (the LOD releases them after the GPU upload) so we can raycast
    for (const bv of sc().planets.bodies.values()) {
      if (!bv.lod || bv.lod._ptPatched) continue;
      const lod = bv.lod, orig = lod._apply;
      lod._apply = function (node, data) {
        const pos = data.pos ? data.pos.slice() : null, opos = data.ocean ? data.ocean.pos.slice() : null;
        orig.call(this, node, data);
        if (node.mesh && pos) node.mesh.userData.ptPos = pos;
        if (node.ocean && opos) node.ocean.userData.ptPos = opos;
      };
      lod._ptPatched = true;
    }
    const rayMesh = (m) => {
      if (!m.userData.ptPos) return null;
      if (!m.userData.ptMesh) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.userData.ptPos, 3));
        g.setIndex(m.geometry.index);
        m.userData.ptMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      }
      const r = m.userData.ptMesh;
      r.matrixWorld.copy(m.matrixWorld);
      return r;
    };
    /** Distance from the vessel CoM straight down to the rendered terrain (and ocean) meshes (chunks built after install). */
    PT.groundRay = (offsetE = 0, offsetN = 0) => {
      const s = sc(), v = window.TSP.flightScene.vessel();
      const bv = s.planets.bodies.get(v.bodyId);
      const f = PT.enu();
      const land = [], sea = [];
      let noCopy = 0;
      bv.lod.group.updateMatrixWorld(true);
      bv.lod.group.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const r = rayMesh(o);
        if (!r) { noCopy++; return; }
        (o.material === bv.oceanMat ? sea : land).push(r);
      });
      const o = f.up.clone().multiplyScalar(300).addScaledVector(f.east, offsetE).addScaledVector(f.north, offsetN);
      const rc = new THREE.Raycaster(o, f.up.clone().negate(), 0, 1e7);
      const hl = rc.intersectObjects(land, false)[0];
      const hs = sea.length ? rc.intersectObjects(sea, false)[0] : null;
      const t = v.telemetry;
      // physics terrain under the same point
      const pRoot = o.clone().addScaledVector(f.up, -300);             // scene point (origin = vessel CoM)
      const posRel = v.pos.clone().add(pRoot);                          // body-relative inertial
      const ll = U.latLonAlt ? U.latLonAlt(v.bodyId, posRel, window.TSP.game.ut) : null;
      let hPhys = null;
      if (ll) { const d = B.latLonToDir(ll.lat, ll.lon); hPhys = T.terrainHeight(v.bodyId, d.x, d.y, d.z); }
      const comAlt = posRel.length() - B.BODIES[v.bodyId].radius;
      return {
        visLand: hl ? +(hl.distance - 300).toFixed(3) : null, visSea: hs ? +(hs.distance - 300).toFixed(3) : null,
        physLand: hPhys == null ? null : +(comAlt - hPhys).toFixed(3),
        mismatch: hl && hPhys != null ? +((hl.distance - 300) - (comAlt - hPhys)).toFixed(3) : null,
        chunk: hl?.object ? null : null, radar: +t.radarAltitude.toFixed(3), situation: v.situation, nLand: land.length, noCopy,
      };
    };
    PT.hideUI = (hide = true) => { if (!!sc().uiHidden !== hide) sc()._toggleUI(); };
    PT.lod = () => sc().planets.stats();
    PT.frames = 0;
    const tick = () => { PT.frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    /** Stage until the vessel's lowest remaining engine is `engineId` (throttle 0 first). */
    PT.stageTo = (engineId, max = 8) => {
      const fs = window.TSP.flightScene;
      for (let i = 0; i < max; i++) {
        const v = fs.vessel();
        v.setControl('throttle', 0);
        const engines = v.parts.filter((p) => p.engine);
        if (engines.length && engines.every((p) => p.id === engineId) && engines.some((p) => p.engine.active)) return true;
        if (!fs.stage()) return false;
        fs.fastForward(1.5);
      }
      return false;
    };
    PT.radar = () => {
      const v = window.TSP.flightScene.vessel();
      const t = v.telemetry;
      return { alt: t.altitude, radar: t.radarAltitude, vs: t.verticalSpeed, hs: t.surfaceSpeed, situation: v.situation };
    };
    return true;
  });
}

/** Wait until the terrain LOD stopped building and at least `minFrames` frames were rendered. */
export async function settle(page, sleep, { minFrames = 4, maxMs = 45000, quietMs = 600 } = {}) {
  const t0 = Date.now();
  const f0 = await page.evaluate(() => window.PT.frames);
  let quietSince = null;
  while (Date.now() - t0 < maxMs) {
    const s = await page.evaluate(() => ({ b: window.PT.lod().building, f: window.PT.frames }));
    if (s.b === 0 && s.f - f0 >= minFrames) {
      if (quietSince == null) quietSince = Date.now();
      if (Date.now() - quietSince > quietMs) break;
    } else quietSince = null;
    await sleep(250);
  }
  // a few more frames so the last uploads are drawn
  const f1 = await page.evaluate(() => window.PT.frames);
  while ((await page.evaluate(() => window.PT.frames)) - f1 < 3 && Date.now() - t0 < maxMs + 20000) await sleep(150);
  return Date.now() - t0;
}

export async function waitReady(evalJS, sleep, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await evalJS('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())')) return true; } catch { /* busy */ }
    await sleep(300);
  }
  return false;
}

/**
 * Powered-descent autopilot (onStep). Points the nose at local up tilted against the horizontal surface drift
 * (SAS 'direction' mode), throttle via a vertical-speed target (-max(0.8, radar/6) m/s). Keeps SAS holding "up"
 * after touchdown (throttle 0).
 */
export const LANDER_ONSTEP = `(v) => {
  const T = PT.THREE;
  const t = v.telemetry;
  const r = t.radarAltitude;
  const up = t.up;
  const sv = t.surfaceVelocity;
  const vh = sv.clone().addScaledVector(up, -sv.dot(up));
  const tilt = Math.min(0.35, vh.length() * 0.12);
  const dir = up.clone();
  if (vh.lengthSq() > 1e-4) dir.addScaledVector(vh.normalize(), -tilt);
  if (!v.sasDirection) v.sasDirection = new T.Vector3();
  v.sasDirection.copy(dir.normalize());
  v.setControl('sas', true);
  v.setControl('sasMode', 'direction');
  const target = -Math.min(80, Math.max(0.8, r / 6));
  const g = t.localGravity || 1.6;
  const err = target - t.verticalSpeed;
  const nose = new T.Vector3(0, 1, 0).applyQuaternion(v.rot);
  const cosT = Math.max(0.5, nose.dot(up));
  const thr = Math.max(0, Math.min(1, (g + err * 1.5) * v.mass / (Math.max(1000, t.maxThrust || 60000) * cosT)));
  v.setControl('throttle', r < 0.4 || v.situation === 'LANDED' ? 0 : thr);
  if (r < 400 && !v.controls.gear) v.setControl('gear', true);
}`;
