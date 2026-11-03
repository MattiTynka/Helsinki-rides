/** Analyze actual native presentation intervals and independently sampled simulation progress. */
export function summarizeFlightFrames(data,{expectedDurationMs,p99Limit=50,maxFrame=100}) {
  const frames=data.frames??[],samples=data.samples??[],elapsed=data.end-data.start;
  const finiteClock=Number.isFinite(data.start)&&Number.isFinite(data.end)&&elapsed>0;
  const validFrames=Number.isFinite(data.startFrameTime)&&frames.length>0&&frames.every((f,i)=>{
    const previous=i===0?data.startFrameTime:frames[i-1].t;
    return Number.isFinite(f.ms)&&f.ms>0&&Number.isFinite(f.t)&&f.t>previous
      &&Math.abs(f.ms-(f.t-previous))<.001&&f.t>=data.start-maxFrame&&f.t<=data.end;
  })&&data.finalFrameTime===frames.at(-1).t;
  const sorted=validFrames?frames.map(f=>f.ms).sort((a,b)=>a-b):[];
  const percent=p=>sorted[Math.ceil(sorted.length*p)-1]??null;
  const first=samples[0],last=samples.at(-1);
  const validSamples=samples.length>=2&&samples.every((s,i)=>Number.isFinite(s.t)&&Number.isFinite(s.tick)
    &&s.player?.position?.length===3&&s.player.position.every(Number.isFinite)&&(i===0||s.t>samples[i-1].t));
  const gaps=validSamples?samples.slice(1).map((s,i)=>s.t-samples[i].t):[];
  const monotonic=validSamples&&samples.every((s,i)=>i===0||s.tick>=samples[i-1].tick);
  const advancing=validSamples&&samples.slice(1).every((s,i)=>s.t-samples[i].t<100||s.tick>samples[i].tick);
  const distance=validSamples?Math.hypot(last.player.position[0]-first.player.position[0],last.player.position[2]-first.player.position[2]):0;
  const ticks=validSamples?last.tick-first.tick:0;
  const tail=finiteClock&&Number.isFinite(data.finalFrameTime)?data.end-data.finalFrameTime:Infinity;
  const maximum=sorted.length?Math.max(sorted.at(-1),tail):null;
  const gates={
    validClock:finiteClock&&!data.error&&validFrames&&elapsed>=expectedDurationMs&&elapsed<=expectedDurationMs+500,
    frameP99:percent(.99)!==null&&percent(.99)<=p99Limit,
    frameCoverage:validFrames&&data.startFrameTime<=data.start&&data.start-data.startFrameTime<=maxFrame&&tail>=0,
    maximumFrame:maximum!==null&&maximum<=maxFrame,
    progress:monotonic&&advancing&&ticks>=elapsed/1000*60*.8&&distance>expectedDurationMs/1000*30,
    sampleCoverage:validSamples&&first.t-data.start<=100&&first.t>=data.start&&data.end-last.t<=100&&last.t<=data.end&&Math.max(...gaps)<=500,
    stillFlying:validSamples&&last.player.alive&&last.player.mode==='flying'&&last.player.speed>20&&last.aircraft?.crashed===false&&last.aircraft.grounded===false,
  };
  return {status:Object.values(gates).every(Boolean)?'PASS':'FAIL',elapsedMs:elapsed,presentationFrames:sorted.length,
    p50Ms:percent(.5),p95Ms:percent(.95),p99Ms:percent(.99),maximumMs:maximum,unfinishedFrameMs:tail,
    framesOver50:sorted.filter(n=>n>50).length+(tail>50?1:0),framesOver100:sorted.filter(n=>n>100).length+(tail>100?1:0),distanceMetres:distance,ticks,gates};
}
