// Flight-session state that must survive flight-scene re-entries (quickload, revert, map ↔ space center round trips).
// Module-level on purpose: a FlightScene instance lives only between enter() and exit().
//
//   session.revert  { flight (FlightSim.serialize() taken BEFORE the launch), roster (crew.snapshotRoster()), ut,
//                     progress (clone of game.progress: milestones + stats), craft (clone of the launched craft),
//                     vesselId, name } | null
//   session.camera  { vesselId, state (FlightCamera.getState()) } | null — restored when resuming the same vessel
//   session.hidden  F2 "hide UI" state (kept across reloads within one page session)

export const session = {
  revert: null,
  camera: null,
  hidden: false,
};

/** Deep clone of a plain-JSON value (crafts, snapshots). */
export function cloneJSON(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

/** A craft is launchable when it is a tsp craft-like object with at least one part. */
export function isLaunchableCraft(craft) {
  return !!craft && typeof craft === 'object' && Array.isArray(craft.parts) && craft.parts.length > 0
    && craft.parts.every((p) => p && typeof p === 'object' && (typeof p.part === 'string' || typeof p.id === 'string'));
}
