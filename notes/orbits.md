# Orbits area — `src/physics/orbit.js`, `src/physics/universe.js`

This area is the maths core: Kepler propagation for every kind of conic, patched-conic trajectory prediction with
SOI encounters, maneuver frames, planning helpers, and the solar-system ephemerides and frame helpers.
Both modules are pure ES modules that node can import (they only import `three` and `src/data/bodies.js`). They
never touch `window`.

## What was built

* **One propagator for every regime.** Orbits are propagated with the universal-variable Kepler equation measured
  from periapsis: `√μ·Δt = e·χ³·S(αχ²) + q·χ`, where q is the periapsis radius, α = 1/a and e = 1 − αq.
  Circular, elliptic, near-parabolic (including exactly e = 1), hyperbolic and fully radial (h = 0) trajectories all go
  through the same code. The function is odd, strictly increasing (its derivative is r > 0) and convex for χ > 0, so a
  bracketed Halley iteration always converges, with Newton and then bisection as fallbacks.
  * Starting guesses: a closed-form root of the parabolic comparison cubic (a proven lower bound for elliptic orbits
    and an upper bound for hyperbolic ones), refined with Danby-style guesses. It never takes more than 4 iterations
    in any regime (measured). The Stumpff functions use a 9-term series for |z| ≤ 1 and trig/hyperbolic forms written
    to avoid cancellation elsewhere.
  * The internal parameters are (μ, q, α, tPe, P̂, Q̂). The classical elements are derived from them for display.
    Nothing ever divides by (1 − e), and sma and the mean motion stay finite because α is floored at 1e-15/r.
* **`fromStateVectors` handles degenerate input without NaN.** Its conventions:
  * Circular orbits (|e-vector| < 1e-11) use argPe = 0, with periapsis at the ascending node.
  * Equatorial orbits (sin inc < 1e-11) use lan = 0.
  * Radial or zero-velocity states (|r×v| < 1e-13·|r||v|, where the cross product is pure rounding noise) are treated
    as exactly radial. They get the orbital plane that contains r̂ and has its normal closest to +Y, and the plane
    normal is always Gram-Schmidt'd against r̂.
  * The anomaly at epoch is measured geometrically relative to P̂ when e < 0.1, and from (r, r·v) otherwise. This keeps
    near-circular orbits consistent even though their periapsis direction is noisy.
* **Frames** follow ARCHITECTURE.md exactly. Keplerian angles are defined in the internal Z-up frame and mapped with
  world = (xi, zi, −yi). With inc = 0 the normal is +Y, and the LAN is measured from +X toward −Z.
* **Patched conics.** SOI exit and impact times are analytic: a closed form for χ at a given radius, which also works
  for radial orbits. SOI entry into moving child bodies uses conservative advancement on
  d(t) = |x_v − x_c| − soi. Because d'' ≥ −a_max, the step (ḋ + √(ḋ² + 2·a_max·d))/a_max provably cannot jump over a
  crossing. Each crossing is then bisected to 1e-4 s. Children are pruned by radius range, and receding unbound
  trajectories stop the search early.
* **universe.js** provides cached body orbits, hierarchy sums, rotation, body-fixed ↔ inertial transforms,
  surface frames (with poles handled), lat/lon/alt, sun direction, cylindrical shadows (optionally eclipses), frame
  conversion between SOIs, and launch-site helpers.

## Public API

### orbit.js (ARCHITECTURE.md §4, plus the extensions marked ✚)

```js
new Orbit({ mu, sma, ecc, inc, lan, argPe, meanAnomalyAtEpoch, epoch /*, periapsis ✚ (only for sma = ±Infinity) */ })
Orbit.fromBodyElements(bodyOrbitDeg, mu)      Orbit.fromStateVectors(pos, vel, mu, ut)
✚ orbit.setFromStateVectors(pos, vel, mu, ut) → this      // in place: use this for per-frame osculating orbits
✚ orbit.setElements(params) → this   ✚ orbit.copy(o)   orbit.clone()   ✚ orbit.toJSON()   ✚ Orbit.fromJSON(json)
// fields: mu sma ecc inc lan argPe meanAnomalyAtEpoch epoch meanMotion period semiLatusRectum apoapsis periapsis energy
//         normal (Vector3)  ✚ timeOfPeriapsis (UT of a Pe passage)  ✚ isBound (getter)  ✚ periapsisDir(out)
getStateAtUT(ut, outPos?, outVel?) → { pos, vel }        ✚ stateInto(ut, outPos, outVel)   // no allocation at all
getPositionAtUT(ut, out?)   ✚ getVelocityAtUT(ut, out?)   ✚ radiusAtUT(ut)   ✚ speedAtRadius(r)
meanAnomalyAtUT(ut)  trueAnomalyAtUT(ut)  ✚ eccentricAnomalyAtUT(ut)
radiusAtTrueAnomaly(nu)  positionAtTrueAnomaly(nu, out?)  ✚ velocityAtTrueAnomaly(nu, out?)
timeToApoapsis(ut)  timeToPeriapsis(ut)  UTAtTrueAnomaly(nu, afterUT)  trueAnomalyAtRadius(r)
✚ nextRadiusCrossing(R, outbound, fromUT) → ut | null     // robust for radial orbits too
getOrbitPoints(n, { maxRadius, fromNu, toNu, ✚fromUT, ✚toUT } = {}, ✚out = []) → Vector3[]

burnFrame(pos, vel, ✚out?) → { prograde, normal, radial }   dvToWorld(pos, vel, dv, out?)   worldToDv(pos, vel, vec, ✚out?)
predictTrajectory({ bodyId, pos, vel, ut, maneuvers = [], maxPatches = 4, maxTime = DEFAULT_MAX_TIME })
findNextSOITransition(orbit, bodyId, fromUT, toUT) → { ut, toBodyId, kind: 'exit'|'enter' } | null
findImpactUT(orbit, body /* BODIES entry | id | radius (m) */, fromUT, toUT = Infinity) → ut | null
✚ DEFAULT_MAX_TIME = 20 Verda years (20 · 426 · 21600 s)
```

**Planning helpers (✚, for the map and HUD):**

| Function | Returns |
|---|---|
| `hohmann(r1, r2, mu)` | `{ dv1, dv2 (signed, + = prograde), dvTotal, transferTime, sma, phaseAngle }`. phaseAngle ∈ (−π, π] is how far the target must lead at departure. |
| `phaseAngle(posA, posB, normal = +Y)` | Angle from A to B in the prograde sense, in [0, 2π). |
| `phaseAngleAtUT(orbitA, orbitB, ut)` | The same, for two orbits around the same body. |
| `timeToPhaseAngle(orbitA, orbitB, angle, fromUT, maxSpan?)` | The next UT with that phase, or null. Searches 1.5 synodic periods by default. |
| `transferWindow(orbitA, orbitB, fromUT)` | `{ ut, ...hohmann }` for the next Hohmann window, using the semi-major axes. It is a good estimate. Eccentric targets such as Rusta (e = 0.051, whose radius swings ±1 Gm, far more than its 48 Mm SOI) need tuning: in the test, scanning ±12 days and −8…+20 % Δv found the encounter. |
| `closestApproach(orbitA, orbitB, fromUT, toUT)` | `{ ut, distance, relativeSpeed }`. Samples the separation, then golden-section refines the 6 best local minima. |
| `relativeNodes(orbitA, orbitB, fromUT = orbitA.epoch)` | `{ anUT, dnUT, relInc, anTrueAnomaly, dnTrueAnomaly }` for A's nodes on B's plane. |
| `equatorialNodes(orbit, fromUT)` | The same result shape, measured against the equator. |
| `circularSpeed(mu, r)`, `escapeSpeed(mu, r)`, `visViva(mu, r, sma)` | Speeds. |

### universe.js (ARCHITECTURE.md §4, plus the extensions marked ✚)

```js
bodyOrbit(id)  bodyStateRelParent(id, ut, outPos?, outVel?)  bodyPosition(id, ut, out?)  bodyVelocity(id, ut, out?)
children(id) (fresh array)  soiBodyAt(rootPos, ut)  rotationAngle(id, ut) ∈ [0, 2π)  rotationQuat(id, ut, out?)
inertialToFixed(id, vec, ut, out?)  fixedToInertial(id, vec, ut, out?)  surfaceVelocity(id, relPos, out?)
latLonAlt(id, relPos, ut) → { lat, lon (DEGREES), alt, ✚latRad, ✚lonRad }
sunDirection(bodyId, relPos, ut, out?)  isInShadow(bodyId, relPos, ut, ✚{ eclipses: false })  surfaceFrame(id, relPos, out?)
✚ bodyRootState(id, ut, outPos?, outVel?)   ✚ convertState(pos, vel, fromId, toId, ut, outPos?, outVel?)   ✚ ancestors(id)
✚ angularVelocity(id, out?)   ✚ surfacePosition(id, latDeg, lonDeg, alt, ut, out?)   ✚ launchSitePosition(ut, out?)
✚ sunAngles(bodyId, relPos, ut) → { elevation, azimuth } (degrees; azimuth 0 = north, 90 = east)
✚ _childIds(id)   // internal frozen list used by orbit.js; do not mutate
```

### Semantics worth knowing: small deviations and clarifications of the contract

1. **`latLonAlt` returns degrees**, matching `LAUNCH_SITE`, `latLonToDir` and `dirToLatLon` in bodies.js. It also
   returns `latRad` and `lonRad`. lon ∈ (−180, 180].
2. **`trueAnomalyAtUT`** returns [0, 2π) for elliptic orbits and (−ν∞, ν∞) for hyperbolic ones.
   **`meanAnomalyAtUT`** is wrapped to [0, 2π) only for elliptic orbits.
3. **`UTAtTrueAnomaly`** returns `Infinity` when it never happens: an unbound orbit already past that anomaly, or a ν
   beyond the asymptote. **`relativeNodes`** returns `NaN` times when the planes coincide (no nodes). Its `fromUT`
   argument is optional.
4. **`getOrbitPoints`** samples adaptively. Half the points are spaced evenly in flight-path turning angle, which keeps
   periapsis and apoapsis tips crisp even at e = 0.99, and half evenly in the universal anomaly, which covers long arcs.
   * A full closed ellipse returns n points with the first equal to the last, so it can be drawn with `THREE.Line`.
   * Unbound orbits without `maxRadius` are clipped at max(50·Pe, 4·|a|). **Pass `maxRadius: body.soi`.**
   * `fromUT`/`toUT` draws exactly a patch's arc: `p.orbit.getOrbitPoints(n, { fromUT: p.startUT, toUT: p.endUT })`.
     Arcs are capped at one revolution.
   * `out` lets you reuse Vector3s from frame to frame.
5. **`predictTrajectory`**:
   * Patch 0 is always the current orbit.
   * Maneuvers are sorted by `ut` and applied in order, with Δv in the burn frame at the node on the then-current patch.
     A maneuver whose `ut` is before the start is applied at the start, which gives a zero-length first patch.
   * Patches with `endReason: 'maneuver'` carry ✚`maneuver` (the node object) and ✚`maneuverIndex` (its index in the
     input array).
   * A closed orbit with no events is one patch lasting exactly one period ('end'). **Encounters are searched only
     within that first revolution**, as in KSP. With a pending maneuver the patch extends to the node, and encounter
     search is capped at 12 revolutions.
   * Impact is at sea level (`body.radius`). Terrain is the physics area's job.
   * 'soi_enter' times are just *inside* the child SOI. 'soi_exit' times are just *outside* the current SOI, so a frame
     switch at the patch boundary is always unambiguous and never ping-pongs.
6. **`findImpactUT`**: if the orbit is below R at `fromUT` and descending, it returns `fromUT`. If it is below R but
   climbing (for example out of a crater on an airless moon whose terrain dips below the reference radius), it returns
   the time it comes back down through R.
7. **`getStateAtUT`** allocates a small `{pos, vel}` wrapper, plus two Vector3s if you pass no out vectors. Hot loops
   should use `stateInto(ut, pos, vel)`.
8. **`isInShadow`** tests only the body's own shadow by default, exactly as the contract says. Pass `{ eclipses: true }`
   to also test the parent and sibling bodies (solar panels during a Lune eclipse, for example).

## How to test

```
node tools/run-tests.mjs orbit       # 23 tests
node tools/run-tests.mjs universe    # 12 tests
```

Measured results on this machine:

| What | Result |
|---|---|
| Round trips over e ∈ {0, 1e-9, 0.1, 0.7, 0.99, 1.5, 3} × inc ∈ {0, 1e-9, 30°, 90°, 179°, 180°} × lan/argPe/M₀ (18,144 comparisons) | Worst relative error **2.7e-12** (the requirement was 1e-6) |
| Save/load (fromStateVectors → toJSON → new Orbit) | 1.8e-14 |
| Agreement with RK4 over one orbit | 5e-13; energy drift 1e-15 |
| Near-parabolic, 9 cases from 0.999 to 1.001 including exactly escape speed | Match RK4 to 1e-8 and never NaN, at times from −1e7 to 1e9 s |
| Radial drop from 100 km | Fall time matches the analytic radial-Kepler formula to 1e-6 relative |
| Fuzz: 30,000 random states from 50 km to 1e10 m (radial, polar, near-circular, near-escape, near-rest) | All finite; reproduced at epoch within the double-precision floor |
| Fuzz: 400 random predictions | All well-formed |
| Escape from LEO at 3.5 km/s (e = 1.43) | SOI exit time within 1 s of an RK4 integration |
| Lune transfer: 860 m/s prograde from a 100 km orbit, burn time scanned | 40 of 210 burn times encounter Lune. Entry is inside at t and outside at t − 1 s, with no earlier crossing. |
| Chunked `findNextSOITransition` (1600 s windows, as at 100000× warp) | Same instant as a single call; 0.004 ms per call |
| Hohmann window to Lune | Actually yields an encounter |
| Verda → Rusta | Heliocentric encounter chain `sola:maneuver → sola:soi_enter → rusta:soi_exit → sola:end` |
| Distances | Lune–Verda = 12,000 km; Verda–Sola = 13,599,840,256 m |
| Surface frame | Verified at (R,0,0) and at the poles |

Performance:

| Operation | Time |
|---|---|
| 100k `getStateAtUT` calls | 12 ms circular, 26 ms e = 0.7, 28 ms hyperbolic (limit 100 ms) |
| `predictTrajectory`, LEO | 0.001 ms |
| `predictTrajectory`, Lune transfer with encounter | 0.06 ms |
| `predictTrajectory`, escape | 0.025 ms |
| `predictTrajectory`, heliocentric | about 0.02 ms |
| 100k `bodyPosition('lune')` calls | 26 ms |

`shots/orbits_trajectories.png` is a visual check of the sampler and the patched conics: ellipses at e = 0.99/0.7/0;
hyperbolas from e = 1.0000001 to 3 clipped at the SOI, plus a radial line; the Lune encounter in Verda's frame; the
Lune flyby arc; and Verda → Rusta. It was rendered from a scratch script with puppeteer, and no project file is needed
to reproduce it.

### Launch-site morning (UT 0, with `initialRotation` = 0.60318 from bodies.js)

**The sun is 50.09° above the horizon at azimuth 89.9° (due east), and rising.** The site is in daylight: the sun
reaches zenith about 40 minutes later and sets about 2h20m later, in Verda's 6-hour day. That sits right at the top of
the requested 40–50° band. **`initialRotation = 0.51429` would give exactly 45°** (the test computes this).
bodies.js was not edited.

## Known issues and limits

* **Time is an absolute double.** Near the centre of a body (r of a few km, periods of about 1 s) the ulp of the UT
  limits velocity precision. That is physically irrelevant: the smallest body radius is 60 km, where the floor is
  about 1e-6 m/s.
* **Encounters are searched only within the first revolution** of a closed orbit, like KSP. An encounter on the
  second orbit shows up once the vessel gets there.
* **Grazes shorter than the minimum search step are ignored.** A pass through the edge of a child SOI lasting less
  than max(0.2 s, window·1e-7) is skipped.
* **Only one encounter per child per patch.** After an exit the next patch starts in the parent frame, and a later
  re-entry is found there.
* **Sampling a very thin orbit by true anomaly is ill-conditioned.** `positionAtTrueAnomaly`, `UTAtTrueAnomaly` and
  `trueAnomalyAtRadius` all take ν as input, so on near-radial orbits they are inherently imprecise (ν ≈ π almost
  everywhere). Use UT- or radius-based functions there: `nextRadiusCrossing`, `getOrbitPoints({fromUT, toUT})` and
  `findImpactUT` are all robust.

## Integration notes (physics, flight scene, map, HUD)

* **Per-frame osculating orbit (no garbage):**
  ```js
  vessel.orbit = vessel.orbit ? vessel.orbit.setFromStateVectors(pos, vel, body.mu, ut)
                              : Orbit.fromStateVectors(pos, vel, body.mu, ut);
  ```
  Note: if anything else keeps a reference to `vessel.orbit`, it will see the update. The map keeps its own patch
  orbits from `predictTrajectory`, so that is fine.
* **Rails propagation:** call `vessel.orbit.stateInto(ut, vessel.pos, vessel.vel)`. The orbit stays valid for any UT;
  there is no need to rebuild it while on rails.
* **Landing exactly on SOI transitions while on rails:**
  ```js
  const tr = findNextSOITransition(vessel.orbit, vessel.bodyId, ut, ut + dt);
  if (tr) {
    vessel.orbit.stateInto(tr.ut, vessel.pos, vessel.vel);
    convertState(vessel.pos, vessel.vel, vessel.bodyId, tr.toBodyId, tr.ut, vessel.pos, vessel.vel);
    const from = vessel.bodyId; vessel.bodyId = tr.toBodyId;
    vessel.orbit.setFromStateVectors(vessel.pos, vessel.vel, BODIES[tr.toBodyId].mu, tr.ut);
    game.ut = tr.ut; bus.emit('soi:change', { vessel, from, to: tr.toBodyId });   // + stop warp
  }
  ```
  `convertState` is safe with out === in (it reads everything first). A vessel handed in while already inside a child
  SOI and heading inward gets `{ kind: 'enter', ut: fromUT }` immediately. One that just left, so is still numerically
  inside but moving outward, is not re-captured.
* **Physics-mode SOI checks:** leave the SOI when `pos.length() > BODIES[bodyId].soi`. Enter child c when
  `|pos − bodyStateRelParent(c, ut).pos| < BODIES[c].soi`. Or use `soiBodyAt(rootPos, ut)`, which uses the same strict
  `<`. Then call `convertState`.
* **Launch pad:** use `launchSitePosition(ut)`, which is inertial, relative to Verda, and at the pad surface altitude.
  The pad velocity is `surfaceVelocity('verda', pos)`. The vessel's up/north/east come from `surfaceFrame('verda', pos)`,
  and at the pad east is exactly `surfaceVelocity`'s direction.
* **HUD telemetry:**
  * apoapsis altitude = `orbit.apoapsis − R` (Infinity when unbound); periapsis = `orbit.periapsis − R`.
  * `timeToAp` / `timeToPe` come from `orbit.timeToApoapsis(ut)` / `orbit.timeToPeriapsis(ut)`. The latter is negative
    for an escaping orbit already past Pe.
  * inclination in degrees = `orbit.inc * 180/π`; eccentricity = `orbit.ecc`.
* **Map:** draw each patch with `p.orbit.getOrbitPoints(n, { fromUT: max(p.startUT, ut), toUT: p.endUT, maxRadius: BODIES[p.bodyId].soi })`.
  * Skip zero-length patches.
  * For closed 'end' patches draw the full ellipse (`getOrbitPoints(n)`).
  * The encounter periapsis is `patches[k+1].orbit.periapsis − R` where `patches[k].endReason === 'soi_enter'`.
  * Use `closestApproach` for target markers and `relativeNodes` / `equatorialNodes` for AN/DN markers.
* **Lighting:** `sunDirection(bodyId, relPos, ut)` points toward Sola, and `isInShadow` drives solar panels. For a
  morning-sun test, `sunAngles('verda', launchSitePosition(0), 0)` gives about {elevation 50°, azimuth 90°}.
