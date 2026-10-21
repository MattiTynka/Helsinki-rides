import assert from 'node:assert/strict';
import {pointInPolygon,ringDistance,type LocalPolygon} from './geometry.ts';
import {sourcePartsForTriangle,type LayeredSourcePart} from './layered-bridge-source.ts';
import {supportHeight,supportNormal,type SupportTriangle} from './tram-support-repair.ts';
import {deliverySha} from './delivery-city-payloads.ts';
import {geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import {isSupportedSurfaceWay} from './surface-way.ts';

export type ExtraBridgeRole='road'|'walk'|'cycle'|'median';
export interface ExtraBridgeFrame {origin:[number,number];direction:[number,number]}
export interface ExtraBridgeBankSegment {t0:number;t1:number;y0:number;y1:number;role:ExtraBridgeRole;sourcePartIds:number[];source:{cell:string;collider:string;triangle:number;sha256:string}}
export interface ExtraBridgeNativeFace {points:SupportTriangle;cell:string;collider:string;triangle:number;tag:string;group:string}
export interface ExtraBridgeUpperPart {id:number;role:ExtraBridgeRole;tag:string;rings:[number,number][][];sha256:string;boundsS?:[number,number]}

export function extraBridgeLocal(frame:ExtraBridgeFrame,p:readonly number[]):[number,number]{
  assert.ok(Math.abs(Math.hypot(...frame.direction)-1)<1e-10,'Bridge axis must be a unit source direction');
  const x=p[0]!-frame.origin[0],z=p[1]!-frame.origin[1],[dx,dz]=frame.direction;
  return[x*dx+z*dz,-x*dz+z*dx];
}
export function extraBridgeWorld(frame:ExtraBridgeFrame,s:number,t:number):[number,number]{
  const[dx,dz]=frame.direction;return[frame.origin[0]+dx*s-dz*t,frame.origin[1]+dz*s+dx*t];
}
export function extraBridgeRole(properties:Record<string,unknown>):ExtraBridgeRole{
  const sub=String(properties.alatyyppi);if(sub.startsWith('Ajorata'))return'road';
  if(/pyör|Pyör/.test(sub))return'cycle';if(/Koroke|Erotus/.test(sub))return'median';
  assert.ok(/Jalan|jalkakäyt|Kevyt|jk/.test(sub),`Unsupported upper bridge surface:${sub}`);return'walk';
}
/** Exact source polygons only. Neither a road axis nor a guessed lane width can grow this authority. */
export function extraBridgeUpperParts(parts:readonly LocalPolygon[],ids:readonly number[],name:string):ExtraBridgeUpperPart[]{
  assert.equal(new Set(ids).size,ids.length);return ids.map(id=>{
    const part=parts.find(p=>p.id===String(id));assert.ok(part,`Missing upper source part${id}`);
    assert.equal(part.properties.alueen_nimi,name,'Upper source street identity changed');
    assert.ok(['Silta','Ajorata','Kevyt liikenne','Muu rakenneosa'].includes(String(part.properties.paatyyppi)));
    const role=extraBridgeRole(part.properties),material=String(part.properties.materiaali).toLowerCase(),finish=material.includes('asfaltti')?'asphalt':material.includes('nupukivi')?'setts':material.includes('noppakivi')?'cobble':'slabs';
    return{id,role,tag:`${role==='road'?'road':'raised'}:${finish}`,rings:part.rings.map(r=>r.map(([x,n])=>[x,-n])),sha256:deliverySha(JSON.stringify(part))};
  });
}
/** A source-owned native triangle intersects a full bank line. The exact linear
 * cross-section, including every native diagonal/curb break, is retained. */
export function extraBridgeBankSegments(frame:ExtraBridgeFrame,s:number,faces:readonly ExtraBridgeNativeFace[],upper:readonly ExtraBridgeUpperPart[]):ExtraBridgeBankSegment[]{
  const sourceParts:LayeredSourcePart[]=upper.map(p=>({id:p.id,name:'pinned-upper-bank',tag:p.tag,rings:p.rings})),byId=new Map(upper.map(p=>[p.id,p])),out:ExtraBridgeBankSegment[]=[];
  for(const face of faces){
    if(!['ground','kerbs'].includes(face.group))continue;try{if(supportNormal(face.points)[1]<=.3)continue;}catch{continue;}
    const partIds=sourcePartsForTriangle(face.points,sourceParts,face.tag);if(!partIds.length)continue;
    const points=face.points.map(p=>extraBridgeLocal(frame,[p[0],p[2]])),hits:number[]=[];
    for(let i=0;i<3;i++){
      const a=points[i]!,b=points[(i+1)%3]!;if(Math.abs(a[0]-s)<1e-9)hits.push(a[1]);
      if((a[0]-s)*(b[0]-s)<0)hits.push(a[1]+(b[1]-a[1])*(s-a[0])/(b[0]-a[0]));
    }
    if(hits.length<2)continue;const t0=Math.min(...hits),t1=Math.max(...hits);if(t1-t0<1e-8)continue;
    const roles=[...new Set(partIds.map(id=>byId.get(id)!.role))];assert.equal(roles.length,1,'Ambiguous bank source roles');
    const y=(t:number)=>supportHeight(face.points,extraBridgeWorld(frame,s,t));
    out.push({t0,t1,y0:y(t0),y1:y(t1),role:roles[0]!,sourcePartIds:partIds,source:{cell:face.cell,collider:face.collider,triangle:face.triangle,sha256:deliverySha(JSON.stringify(face.points))}});
  }return out.sort((a,b)=>a.t0-b.t0||a.t1-b.t1);
}
export function extraBridgeBankHeight(segments:readonly ExtraBridgeBankSegment[],t:number,role:ExtraBridgeRole):number{
  const matches=segments.filter(p=>p.role===role&&t>=p.t0-1e-6&&t<=p.t1+1e-6);
  assert.ok(matches.length,`No source-owned ${role} bank support at cross-coordinate${t}`);
  const values=matches.map(p=>p.y0+(p.y1-p.y0)*Math.max(0,Math.min(1,(t-p.t0)/(p.t1-p.t0))));
  assert.ok(Math.max(...values)-Math.min(...values)<.0001,'Distinct stacked floors cannot become one upper bank');
  return values[0]!;
}
export function extraBridgeBankCoverage(segments:readonly ExtraBridgeBankSegment[],required:readonly{role:ExtraBridgeRole;t0:number;t1:number}[]){
  for(const range of required){assert.ok(range.t1>range.t0);const cuts=[range.t0,range.t1,...segments.filter(s=>s.role===range.role).flatMap(s=>[s.t0,s.t1]).filter(t=>t>range.t0&&t<range.t1)].sort((a,b)=>a-b);
    for(let i=1;i<cuts.length;i++){extraBridgeBankHeight(segments,(cuts[i-1]!+cuts[i]!)/2,range.role);extraBridgeBankHeight(segments,cuts[i-1]!+Math.min(.00001,(cuts[i]!-cuts[i-1]!)/4),range.role);extraBridgeBankHeight(segments,cuts[i]!-Math.min(.00001,(cuts[i]!-cuts[i-1]!)/4),range.role);}
  }return{fullWidthSourceSupport:true,requiredRanges:required,segments:segments.length};
}
/** Source boundary membership has the same native Float32 tolerance as the
 * triangle ownership classifier; it does not enlarge the emitted footprint. */
export function insideExtraUpper(p:[number,number],part:ExtraBridgeUpperPart){return pointInPolygon(p,part.rings)||part.rings.some(r=>ringDistance(p,r)<=.00025);}

/** Exact segment/polygon intervals distinguish a lower public path from an
 * upper road axis which merely overlaps the same municipal structure in X/Z. */
export function extraBridgeSourceAxes(osm:any,rings:[number,number][][]){
  const nodes=new Map<number,[number,number]>(osm.elements.filter((e:any)=>e.type==='node').map((e:any)=>{const[E,N]=geodeticToGk25(e.lat,e.lon);return[e.id,[E-25497350,6672960-N]];})),cross=(a:readonly number[],b:readonly number[])=>a[0]!*b[1]!-a[1]!*b[0]!,axes=[];
  for(const way of osm.elements.filter((e:any)=>e.type==='way'&&e.tags?.highway&&isSupportedSurfaceWay(e.tags))){let lengthMetres=0;
    for(let i=1;i<way.nodes.length;i++){const a=nodes.get(way.nodes[i-1]),b=nodes.get(way.nodes[i]);if(!a||!b)continue;const D=[b[0]-a[0],b[1]-a[1]],cuts=[0,1];for(const ring of rings)for(let j=1;j<ring.length;j++){const c=ring[j-1]!,d=ring[j]!,E=[d[0]-c[0],d[1]-c[1]],C=[c[0]-a[0],c[1]-a[1]],det=cross(D,E);if(Math.abs(det)<1e-12)continue;const t=cross(C,E)/det,u=cross(C,D)/det;if(t>=0&&t<=1&&u>=0&&u<=1)cuts.push(t);}cuts.sort((a,b)=>a-b);for(let j=1;j<cuts.length;j++){const lo=cuts[j-1]!,hi=cuts[j]!,t=(lo+hi)/2;if(hi-lo>1e-8&&pointInPolygon([a[0]+D[0]!*t,a[1]+D[1]!*t],rings))lengthMetres+=Math.hypot(...D)*(hi-lo);}
    }if(lengthMetres>.00001)axes.push({wayId:way.id,tags:way.tags as Record<string,string>,lengthMetres});
  }return axes;
}
