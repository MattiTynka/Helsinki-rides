import assert from 'node:assert/strict';
import type {RoadGraph,RoadLane} from '../../../packages/world-schema/src/index.ts';
import {sourceSha256} from './source-files.ts';

interface SourceWay {type:string;id:number;nodes?:number[];tags?:Record<string,string>}
export interface QualifiedRouteBridge {
  wayId:number;sourceWaySha256:string;profileSha256:string;serializedManifestSha256:string;
  transitions:{nodeId:number;otherWayId:number}[];
}
export interface RuoholahtiRoutePlan {
  boundsXZ:readonly[number,number,number,number];
  routes:{id:string;laneGoals:string[]}[];
  bridges:QualifiedRouteBridge[];
  withheldLanes?:{id:string;recordSha256:string;reason:string}[];
}
const publicAccess=(value:string|undefined)=>value===undefined||['yes','designated','permissive'].includes(value);
const hash=(value:unknown)=>sourceSha256(JSON.stringify(value));

/** Source topology only. No candidate can be published before exact serialized
 * floor projection, source mask, all vehicle footprints and real-control gates. */
export function prepareRuoholahtiRouteCandidates(accepted:RoadGraph,candidate:RoadGraph,source:readonly SourceWay[],plan:RuoholahtiRoutePlan){
  const r=plan.boundsXZ;assert.ok(r.length===4&&r.every(Number.isFinite)&&r[0]<r[2]&&r[1]<r[3]);
  assert.ok(plan.routes.length>0&&plan.routes.length<=10&&new Set(plan.routes.map(v=>v.id)).size===plan.routes.length);
  const ways=new Map(source.filter(e=>e.type==='way').map(e=>[e.id,e])),old=new Map(accepted.lanes.map(l=>[l.id,l])),bridges=new Map(plan.bridges.map(b=>[b.wayId,b]));
  const withheld=new Map((plan.withheldLanes??[]).map(r=>[r.id,r]));assert.ok(withheld.size<512&&withheld.size===(plan.withheldLanes??[]).length);
  for(const ref of withheld.values()){const lane=candidate.lanes.find(l=>l.id===ref.id);assert.ok(lane,'Withheld source lane is missing');assert.equal(hash(lane),ref.recordSha256,'Withheld source lane changed');assert.ok(ref.reason.length>=20&&ref.reason.length<=2000);}
  assert.equal(bridges.size,plan.bridges.length);
  for(const b of bridges.values()){
    assert.equal(hash(ways.get(b.wayId)),b.sourceWaySha256,'Bridge source identity differs');
    assert.match(b.profileSha256,/^[a-f0-9]{64}$/);assert.match(b.serializedManifestSha256,/^[a-f0-9]{64}$/);
    const w=ways.get(b.wayId)!;assert.ok(w.nodes&&w.tags&&w.tags.bridge&&w.tags.bridge!=='no'&&Number(w.tags.layer)===1);
    assert.equal(b.transitions.length,2);assert.deepEqual(b.transitions.map(t=>t.nodeId).sort((a,b)=>a-b),[w.nodes[0]!,w.nodes.at(-1)!].sort((a,b)=>a-b));
    for(const t of b.transitions)assert.ok(ways.get(t.otherWayId)?.nodes?.includes(t.nodeId),'Bridge transition lacks shared source node');
  }
  const allowed=new Map<string,RoadLane>(),witnesses=new Map<string,unknown>(),rejected:{id:string;wayId:number;name:string|null;reason:string}[]=[];
  const inside=(p:readonly number[])=>p[0]!>=r[0]&&p[0]!<=r[2]&&p[2]!>=r[1]&&p[2]!<=r[3];
  for(const lane of candidate.lanes)try{
    assert.ok(!withheld.has(lane.id),withheld.get(lane.id)?.reason);
    assert.ok(lane.points.every(inside),'outside bounded route area');
    const w=ways.get(lane.wayId);assert.ok(w?.nodes?.length&&w.tags,'missing complete source way');const t=w.tags,access=t.motor_vehicle??t.vehicle??t.access;
    assert.ok(publicAccess(access),'non-public vehicle access');
    assert.ok(!['service','motorway','motorway_link','trunk','trunk_link'].includes(t.highway??''),'unselected service or highway class');
    assert.ok(!['Länsiväylä','Porkkalankatu'].includes(t.name??''),'unselected highway corridor');
    assert.ok((!t.tunnel||t.tunnel==='no')&&(!t.indoor||t.indoor==='no')&&t.area!=='yes','unqualified tunnel/indoor/area');
    const bridge=bridges.get(w.id);assert.ok(bridge||((!t.bridge||t.bridge==='no')&&Number(t.layer??0)===0),'unqualified bridge or level');
    assert.ok(!Object.keys(t).some(k=>/^(motor_vehicle|vehicle|access).*:conditional$/.test(k)),'conditional access needs separate review');
    const direction=/:[fb]\d+$/.exec(lane.id)?.[0][1];assert.ok(direction==='f'||direction==='b');const directional=direction==='f'?'forward':'backward',oneway=['yes','1','-1'].includes(t.oneway??'')||t.junction==='roundabout',laneAccess=[];
    for(const key of ['access','vehicle','motor_vehicle']){const field=t[`${key}:lanes:${directional}`]!==undefined?`${key}:lanes:${directional}`:t[`${key}:lanes`]!==undefined?`${key}:lanes`:null;if(!field)continue;
      assert.ok(field.endsWith(directional)||oneway,'undirected two-way lane access needs explicit mapping');const slots=t[field]!.split('|');assert.equal(slots.length,lane.count,'lane-access count differs');const value=slots[lane.index];assert.ok(value!==undefined&&publicAccess(value),'non-public lane access');laneAccess.push({field,index:lane.index,value});}
    const prior=old.get(lane.id);if(prior)assert.ok(prior.from===lane.from&&prior.to===lane.to&&prior.index===lane.index&&prior.count===lane.count,'accepted source segmentation changed');
    else {const a=w.nodes.indexOf(Number(lane.from.slice(1))),b=w.nodes.indexOf(Number(lane.to.slice(1)));assert.ok(a>=0&&b>=0&&a!==b,'missing source endpoint');for(const p of accepted.lanes.filter(p=>p.wayId===lane.wayId&&p.index===lane.index)){const c=w.nodes.indexOf(Number(p.from.slice(1))),d=w.nodes.indexOf(Number(p.to.slice(1)));assert.ok(c>=0&&d>=0,'accepted source interval missing');if(Math.sign(d-c)===Math.sign(b-a))assert.ok(Math.max(Math.min(a,b),Math.min(c,d))>=Math.min(Math.max(a,b),Math.max(c,d)),'new lane overlaps accepted interval');}}
    allowed.set(lane.id,lane);witnesses.set(lane.id,{id:lane.id,wayId:w.id,recordSha256:hash(lane),sourceWaySha256:hash(w),generalAccess:access??'public-default',laneAccess,acceptedIdentity:!!prior,bridge:bridge??null});
  }catch(error){rejected.push({id:lane.id,wayId:lane.wayId,name:lane.name,reason:(error as Error).message.split('\n')[0]!});}
  const edges=new Map<string,{id:string;to:string;length:number}[]>(),transitionWitnesses=new Map<string,unknown>();
  for(const c of candidate.connectors){const a=allowed.get(c.from),b=allowed.get(c.to);if(!a||!b||a.to!==c.node||b.from!==c.node||!c.points.every(inside))continue;
    const structure=bridges.get(a.wayId)??bridges.get(b.wayId);if(structure&&a.wayId!==b.wayId){const other=a.wayId===structure.wayId?b.wayId:a.wayId;const transition=structure.transitions.find(t=>`n${t.nodeId}`===c.node&&t.otherWayId===other);if(!transition)continue;transitionWitnesses.set(c.id,{id:c.id,recordSha256:hash(c),...transition,bridgeWayId:structure.wayId,profileSha256:structure.profileSha256});}
    const list=edges.get(c.from)??[];list.push({id:c.id,to:c.to,length:c.length});edges.set(c.from,list);
  }
  function leg(start:string,end:string){assert.ok(allowed.has(start),`Rejected start ${start}: ${rejected.find(l=>l.id===start)?.reason}`);assert.ok(allowed.has(end),`Rejected goal ${end}: ${rejected.find(l=>l.id===end)?.reason}`);
    const distances=new Map([[start,0]]),previous=new Map<string,{lane:string;connector:string}>(),queue=[start];
    while(queue.length){queue.sort((a,b)=>distances.get(a)!-distances.get(b)!);const current=queue.shift()!;if(current===end)break;for(const edge of edges.get(current)??[]){const distance=distances.get(current)!+edge.length+allowed.get(edge.to)!.length;if(distance>=(distances.get(edge.to)??Infinity))continue;distances.set(edge.to,distance);previous.set(edge.to,{lane:current,connector:edge.id});if(!queue.includes(edge.to))queue.push(edge.to);}}
    assert.ok(start===end||previous.has(end),`No source-connected public route ${start} -> ${end}`);const laneIds=[end],connectorIds:string[]=[];for(let id=end;id!==start;){const p=previous.get(id)!;laneIds.push(p.lane);connectorIds.push(p.connector);id=p.lane;}return{laneIds:laneIds.reverse(),connectorIds:connectorIds.reverse(),lengthMetres:distances.get(end)!};
  }
  const routes=plan.routes.map(entry=>{assert.ok(entry.id.length&&entry.laneGoals.length>=2&&entry.laneGoals.length<=12);assert.ok(old.has(entry.laneGoals[0]!)&&old.has(entry.laneGoals.at(-1)!), 'Routes must start and finish on accepted lane identities');const laneIds:string[]=[],connectorIds:string[]=[];let lengthMetres=0;
    for(let i=1;i<entry.laneGoals.length;i++){const part=leg(entry.laneGoals[i-1]!,entry.laneGoals[i]!);laneIds.push(...part.laneIds.slice(i===1?0:1));connectorIds.push(...part.connectorIds);lengthMetres+=part.lengthMetres;}return{...entry,laneIds,connectorIds,lengthMetres,names:[...new Set(laneIds.map(id=>allowed.get(id)!.name))]};});
  const laneIds=[...new Set(routes.flatMap(r=>r.laneIds))],connectorIds=[...new Set(routes.flatMap(r=>r.connectorIds))];
  return{schemaVersion:1,status:'PUBLIC_SOURCE_CONNECTED_CANDIDATE_PENDING_SERIALIZED_LEVEL_PROJECTION_MASK_COLLISION_AND_TRAVEL',boundsXZ:r,routes,retainedLaneIds:laneIds.filter(id=>old.has(id)),newLaneIds:laneIds.filter(id=>!old.has(id)),connectorIds,sourceAccessWitnesses:laneIds.map(id=>witnesses.get(id)),levelTransitions:connectorIds.flatMap(id=>transitionWitnesses.has(id)?[transitionWitnesses.get(id)]:[]),rejectedLanes:rejected};
}
