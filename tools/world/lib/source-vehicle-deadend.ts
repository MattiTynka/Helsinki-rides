interface SourceWay { type:string; id:number; nodes?:number[]; tags?:Record<string,string> }
export interface VehicleDeadEndTrim {
  wayId:number; endpoint:'start'|'end'; sourceEndpointNodeId:number; stopNodeId:number;
  protectedPartIds:string[]; reason:string;
}

/** A project-car feasibility limit, never an assertion about legal access.
 * Raw OSM ways and the pedestrian graph remain unchanged. A trim may only
 * remove the end of a way with pedestrian connections and no motor junction. */
export function sourceVehicleDeadEnd(elements:readonly SourceWay[],declaration:VehicleDeadEndTrim,drivable:ReadonlySet<string>){
  const way=elements.find(e=>e.type==='way'&&e.id===declaration.wayId),d=declaration;
  if(!way?.nodes||way.nodes.length<3||!way.tags?.highway||!drivable.has(way.tags.highway)||!['start','end'].includes(d.endpoint)||!d.reason||!d.protectedPartIds.length)throw new Error('Invalid project-car dead-end declaration');
  const oriented=d.endpoint==='start'?way.nodes:[...way.nodes].reverse(),stop=oriented.indexOf(d.stopNodeId);
  if(oriented[0]!==d.sourceEndpointNodeId||stop<1||stop>=oriented.length-1)throw new Error('Project-car stop does not match an interior source node');
  const removed=new Set(oriented.slice(0,stop)),connections=elements.filter(e=>e.type==='way'&&e.id!==way.id&&e.nodes?.some(n=>removed.has(n))&&e.tags?.highway);
  if(connections.some(e=>drivable.has(e.tags!.highway!)))throw new Error('Project-car trim would remove a source motor-road connection');
  if(!connections.some(e=>['footway','path','steps','pedestrian','cycleway'].includes(e.tags!.highway!)))throw new Error('Project-car dead end lacks a positive source pedestrian connection');
  if(connections.some(e=>!['footway','path','steps','pedestrian','cycleway'].includes(e.tags!.highway!)))throw new Error('Project-car trim has an unreviewed source connection');
  const kept=oriented.slice(stop),nodes=d.endpoint==='start'?kept:kept.reverse();
  return{wayId:way.id,nodes,removedNodeIds:[...removed],stopNodeId:d.stopNodeId,rawTags:{...way.tags},pedestrianConnections:connections.map(e=>({wayId:e.id,tags:e.tags,nodes:e.nodes})),protectedPartIds:d.protectedPartIds,reason:d.reason,scope:'project-car geometry feasibility only; raw legal access and pedestrian ways preserved'};
}
