import { install, waitReady } from './pt_worlds_lib.mjs';
export default async function (page, { sleep, shot, log, evalJS }) {
  await waitReady(evalJS, sleep);
  await install(page, evalJS);
  return await evalJS(`(() => {
    const v = TSP.flightScene.vessel();
    const p0 = v.parts[0];
    return { keys: Object.keys(p0).slice(0,40), tele: Object.keys(v.telemetry), grav: v._localGravity(),
      stages: v.getStages().map(s => ({ stage: s.stage, parts: s.parts.map(p => p.partId || p.def?.id || p.id) })),
      engines: v.parts.filter(p => p.engine).map(p => ({ id: p.partId, stage: p.stage, eng: Object.keys(p.engine) })),
      ss: PT.subsolar('verda'), sun: PT.sunAngles(), lod: PT.lod() };
  })()`);
}
