import polygonClipping from 'polygon-clipping';
import {polylineLength, pointAlong, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon,ringDistance,type Pt,type LocalPolygon} from './geometry.ts';
type Geometry=Pt[][][];
export interface SourceLaneAlignment {
  wayId:number; endpointNodeId:number; endpoint:'start'|'end'; partIds:string[]; guardPartIds?:string[];pedestrianPartIds?:string[];sharedShiftEN?:Pt;
  clearanceMetres:number; maxShiftMetres:number; blendMetres:number; reason:string;
}
export interface SourceAlignmentField {
  readonly declaration:SourceLaneAlignment;readonly geometry:Geometry;readonly guards:readonly LocalPolygon[];
  clearance(point:Pt):number;safe(point:Pt):boolean;
  nearest(point:Pt,extraClearance?:number):{point:Pt;shift:Pt;distance:number;clearance:number};
  nearestShared(points:readonly Pt[]):{shift:Pt;distance:number;clearance:number};
}
export function sourceAlignmentField(declaration:SourceLaneAlignment,parts:readonly LocalPolygon[]):SourceAlignmentField {
  if(!Number.isSafeInteger(declaration.wayId)||declaration.wayId<=0||!Number.isSafeInteger(declaration.endpointNodeId)||declaration.endpointNodeId<=0||!['start','end'].includes(declaration.endpoint)||!declaration.reason||declaration.partIds.length<1||declaration.partIds.length>20||declaration.clearanceMetres<.967||declaration.clearanceMetres>2||declaration.maxShiftMetres<=0||declaration.maxShiftMetres>8||declaration.blendMetres<4||declaration.blendMetres>20)throw new Error('Invalid source lane alignment declaration');
  const selected=declaration.partIds.map(id=>{const p=parts.find(p=>p.id===id),road=p?.properties['paatyyppi']==='Ajorata'&&['Ajorata','Tonttiliittymä'].includes(String(p.properties['alatyyppi'])),ped=declaration.pedestrianPartIds?.includes(id)&&p?.properties['paatyyppi']==='Kevyt liikenne'&&p.properties['alatyyppi']==='Jalankulkualue';if(!p||!road&&!ped)throw new Error(`Alignment${declaration.wayId} lacks reviewed surveyed driving surface ${id}`);return p;});
  const guards=(declaration.guardPartIds??[]).map(id=>{const p=parts.find(p=>p.id===id);if(!p)throw new Error(`Alignment${declaration.wayId} lacks guard ${id}`);return p;});
  const inputs=selected.map(p=>[p.rings] as Geometry);
  const geometry=polygonClipping.union(inputs[0]!,...inputs.slice(1)) as Geometry;
  const clearance=(q:Pt)=>Math.min(...geometry.flatMap(p=>p.map(r=>ringDistance(q,r))));
  const safe=(q:Pt,extra=0)=>geometry.some(p=>pointInPolygon(q,p))&&clearance(q)>=declaration.clearanceMetres+extra-1e-8&&!guards.some(p=>pointInPolygon(q,p.rings)||Math.min(...p.rings.map(r=>ringDistance(q,r)))<declaration.clearanceMetres+extra-1e-8);
  const nearest=(point:Pt,extraClearance=0)=>{if(safe(point,extraClearance))return{point:[...point] as Pt,shift:[0,0] as Pt,distance:0,clearance:clearance(point)};
    let best:{point:Pt;shift:Pt;distance:number;clearance:number}|null=null;
    for(let dx=-declaration.maxShiftMetres;dx<=declaration.maxShiftMetres+1e-8;dx+=.125)for(let dn=-declaration.maxShiftMetres;dn<=declaration.maxShiftMetres+1e-8;dn+=.125){const distance=Math.hypot(dx,dn);if(distance>declaration.maxShiftMetres+1e-8||best&&distance>best.distance+1e-8)continue;const q:Pt=[point[0]+dx,point[1]+dn];if(!safe(q,extraClearance))continue;const c=clearance(q);if(!best||distance<best.distance-1e-8||c>best.clearance)best={point:q,shift:[dx,dn],distance,clearance:c};}
    if(!best)throw new Error(`No source-safe vehicle corridor within ${declaration.maxShiftMetres}m for way ${declaration.wayId} at ${point}`);return best;
  };
  const nearestShared=(points:readonly Pt[])=>{if(!points.length)throw new Error('Shared registration requires lane endpoints');let best:{shift:Pt;distance:number;clearance:number}|null=null;
    for(let dx=-declaration.maxShiftMetres;dx<=declaration.maxShiftMetres+1e-8;dx+=.125)for(let dn=-declaration.maxShiftMetres;dn<=declaration.maxShiftMetres+1e-8;dn+=.125){const distance=Math.hypot(dx,dn);if(distance>declaration.maxShiftMetres+1e-8||best&&distance>best.distance+1e-8)continue;const qs=points.map(q=>[q[0]+dx,q[1]+dn] as Pt);if(!qs.every(q=>safe(q)))continue;const c=Math.min(...qs.map(clearance));if(!best||distance<best.distance-1e-8||c>best.clearance)best={shift:[dx,dn],distance,clearance:c};}
    if(!best)throw new Error(`No shared source-safe vehicle corridor for way ${declaration.wayId}`);return best;
  };
  return{declaration,geometry,guards,clearance,safe,nearest,nearestShared};
}

/** Change graph registration only. The ground, buildings, rock and wall meshes
 * remain untouched. Fine samples make the bounded shift join the original axis
 * with zero derivative at the unchanged end of the blend. */
export function alignLaneEndpoint(points:readonly Vec3[],endpoint:'start'|'end',field:SourceAlignmentField,heightAt:(x:number,z:number)=>number,sharedShift?:Pt){
  const anchor=endpoint==='start'?points[0]!:points.at(-1)!,q:Pt=[anchor[0],-anchor[2]],match=sharedShift?{point:[q[0]+sharedShift[0],q[1]+sharedShift[1]] as Pt,shift:sharedShift,distance:Math.hypot(...sharedShift),clearance:field.clearance([q[0]+sharedShift[0],q[1]+sharedShift[1]])}:field.nearest(q);
  if(!field.safe(match.point))throw new Error('Shared endpoint shift lacks surveyed vehicle clearance');
  return{points:blendLaneEndpoint(points,endpoint,match.shift,field.declaration.blendMetres,heightAt),match};
}
export function blendLaneEndpoint(points:readonly Vec3[],endpoint:'start'|'end',shift:Pt,blendMetres:number,heightAt:(x:number,z:number)=>number):Vec3[]{
  if(!Math.hypot(...shift))return points.map(p=>[...p] as Vec3);
  const length=polylineLength(points),blend=Math.min(blendMetres,length),distances=new Set<number>([0,length]);
  let along=0;for(let i=1;i<points.length;i++){along+=Math.hypot(points[i]![0]-points[i-1]![0],points[i]![2]-points[i-1]![2]);distances.add(along);}
  const count=Math.ceil(blend/.5);for(let i=0;i<=count;i++){const d=blend*i/count;distances.add(endpoint==='start'?d:length-d);}
  return[...distances].sort((a,b)=>a-b).map(s=>{const {point:p}=pointAlong(points,s),d=endpoint==='start'?s:length-s,t=Math.max(0,1-d/blend),factor=t*t*(3-2*t),x=p[0]+shift[0]*factor,z=p[2]-shift[1]*factor;return[x,heightAt(x,z),z] as Vec3;});
}
