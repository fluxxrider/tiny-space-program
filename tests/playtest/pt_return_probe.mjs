// Probe: dump orbiter_1 stages & parts
export default async function (page, { sleep, shot, log, evalJS }) {
  const waitFor = async (expr, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch {} await sleep(250); } return false; };
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())');
  return await evalJS(`(() => { const v = TSP.flightScene.vessel();
    return { stage: v.currentStage, maxStage: v.maxStage, crew: v.crew.map(c=>c.name),
      parts: v.parts.map(p => ({ uid: p.uid, id: p.id, stage: p.stage, y: +p.pos.y.toFixed(2), res: Object.fromEntries(Object.entries(p.resources).map(([k,r])=>[k,r.max])), maxTemp: p.def.maxTemp, crash: p.def.crashTolerance })),
      stages: v.getStages().map(s => ({ stage: s.stage, parts: s.parts.map(p=>p.id), dv: Math.round(s.deltaV) })) }; })()`);
}
