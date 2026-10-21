// Reference-led bridge geometry in the native east/up/south frame. All rendered
// load-bearing faces are also the physical faces; no invisible water floor.
import assert from 'node:assert/strict';
import earcut from 'earcut';
import {buildBridgeLandClosure,type BridgeShoreClosure} from './bridge-shore-closure.ts';
import {buildBridgeBankQuay,quayReplacementZones,type BridgeBankQuay} from './bridge-bank-quay.ts';
import type {TramPoint,TramMesh} from './tram-visuals.ts';
import type {SupportTriangle, SupportVertex, TramSupportPatch} from './tram-support-repair.ts';
import {supportNormal,supportHeight} from './tram-support-repair.ts';
import {encodeCollisionBundle,parseCollisionBundle,type TriMeshCollider} from '../../../packages/world-schema/src/index.ts';
import {retainOutsideBridge,type BridgeReplacementPatch} from './bridge-ground-replacement.ts';

export type BridgeMaterial = 'asphalt' | 'granite' | 'concrete' | 'steel' | 'glass' | 'marking' | 'revetment';
export type BridgeRole = 'road' | 'footway' | 'curb' | 'parapet' | 'soffit' | 'pier' | 'railing' | 'glass' | 'marking' | 'bank';
export interface BridgeStation {
  x:number; z:number; roadY:number;
  leftOuter:number; rightOuter:number; roadHalfWidth:number;
  /** Zero for ordinary raised walks. Hakaniemi's walks are below its road deck. */
  lowerWalkDrop:number;
}
export interface ReconstructedBridge {
  id:string; name:string;
  kind:'granite-three-arch' | 'concrete-girder' | 'two-level-composite';
  stations:BridgeStation[];
  sourcePartIds:number[];
  sourceRoadWayIds?:number[];
  waterY:number;
  curbHeight:number;
  crossfall:number;
  parapet:{kind:'granite' | 'steel';height:number;thickness:number;lattice?:boolean;postMaterial?:'granite'|'steel'};
  architectureStartMetres:number;
  architectureEndMetres:number;
  approachMetres:number;
  arch?:{spans:3;piers:2;pierWidth:number;abutmentWidth:number;springHeightAboveWater:number;crownDepth:number};
  supports?:{atMetres:number;width:number;bottomY:number}[];
  deckThickness:number;
  references:string[];
  qualifications:string[];
  quays?:BridgeBankQuay[];
  shoreClosure?:BridgeShoreClosure;
  sourceRemovals?:{id:string;sourcePartId?:number;sourceNode?:string;polygon:TramPoint[];maximumSourceY:number;replaceBoundaryWalls?:boolean;replaceBoundarySegments?:[TramPoint,TramPoint][];observation:string}[];
  underpass?:{
    sourceWayId:number;
    stations:{x:number;z:number;floorY:number}[];
    halfWidth:number;
    leftWidth?:number;
    rightWidth?:number;
    wallThickness?:number;
    wallTopY?:number;
    leftApron?:number;
    rightApron?:number;
    publicFloorRange?:[number,number];
    bankBlendMetres:number;
    observation:string;
  };
}
export interface BridgeFace {
  points:SupportTriangle;
  material:BridgeMaterial;
  role:BridgeRole;
  uvs:[TramPoint,TramPoint,TramPoint];
  collision:boolean;
}
export interface BridgeFloorSource {
  height:(x:number,z:number)=>number;
  /** Optional exact transverse breaks at each bank's outer joining cut. */
  bankCrossBreaks?:readonly number[];
  underpassBankCrossBreaks?:readonly number[];
  underpassAlongBreaks?:readonly number[];
  triangles?:readonly SupportTriangle[];
}
export const BRIDGE_COLOURS:Readonly<Record<BridgeMaterial,[number,number,number]>>={
  asphalt:[.055,.057,.059],granite:[.25,.24,.22],concrete:[.36,.36,.33],steel:[.075,.085,.08],glass:[.38,.57,.47],marking:[.87,.86,.78],revetment:[.51,.46,.43],
};
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const f32=(p:readonly number[]):SupportVertex=>[Math.fround(p[0]!),Math.fround(p[1]!),Math.fround(p[2]!)];
export function bridgeLengths(bridge:ReconstructedBridge):number[]{
  const lengths=[0];for(let i=1;i<bridge.stations.length;i++){const a=bridge.stations[i-1]!,b=bridge.stations[i]!;lengths.push(lengths.at(-1)!+Math.hypot(b.x-a.x,b.z-a.z));}return lengths;
}
export function validateReconstructedBridge(b:ReconstructedBridge):void {
  assert.match(b.id,/^[a-z][a-z0-9-]{2,63}$/);assert.ok(b.stations.length>=2&&b.stations.length<=100);
  for(const s of b.stations){assert.ok(Object.values(s).every(Number.isFinite));assert.ok(s.roadHalfWidth>=3&&s.roadHalfWidth<=12);assert.ok(s.leftOuter>s.roadHalfWidth+.5&&s.rightOuter>s.roadHalfWidth+.5);assert.ok(s.lowerWalkDrop>=0&&s.lowerWalkDrop<=6);}
  const lengths=bridgeLengths(b);assert.ok(lengths.at(-1)!>5&&lengths.at(-1)!<350);assert.ok(lengths.every((s,i)=>i===0||s-lengths[i-1]!>.01),'Bridge stations must have distinct X/Z and positive segment length');
  assert.ok(b.architectureStartMetres>=0&&b.architectureEndMetres<=lengths.at(-1)!&&b.architectureEndMetres>b.architectureStartMetres);
  assert.ok(b.approachMetres>=0&&b.approachMetres<=80);assert.ok(b.crossfall>=0&&b.crossfall<=.04);
  assert.ok(b.curbHeight>=.08&&b.curbHeight<=.2&&b.deckThickness>=.25&&b.deckThickness<=1.2);
  assert.ok(b.parapet.height>=.9&&b.parapet.height<=1.4&&b.parapet.thickness>=.04&&b.parapet.thickness<=.6);
  assert.ok(b.sourcePartIds.length&&b.references.length&&b.qualifications.length);
  if(b.kind==='granite-three-arch')assert.ok(b.arch?.spans===3&&b.arch.piers===2&&b.arch.pierWidth>1);
}
export function bridgeSection(b:ReconstructedBridge,s:number){
  const lengths=bridgeLengths(b),end=lengths.at(-1)!;s=Math.max(0,Math.min(end,s));let i=0;while(i<lengths.length-2&&lengths[i+1]!<s)i++;
  const a=b.stations[i]!,c=b.stations[i+1]!,t=(s-lengths[i]!)/(lengths[i+1]!-lengths[i]!);
  const tangent=(j:number):TramPoint=>{const before=b.stations[Math.max(0,j-1)]!,after=b.stations[Math.min(b.stations.length-1,j+1)]!,dx=after.x-before.x,dz=after.z-before.z,L=Math.hypot(dx,dz);return[dx/L,dz/L];},A=tangent(i),C=tangent(i+1),d:TramPoint=[mix(A[0],C[0],t),mix(A[1],C[1],t)];
  // The transverse frame is continuous at a station. Segment-constant normals
  // create an actual gap at every bend of a curved bridge.
  return{x:mix(a.x,c.x,t),z:mix(a.z,c.z,t),roadY:mix(a.roadY,c.roadY,t),leftOuter:mix(a.leftOuter,c.leftOuter,t),rightOuter:mix(a.rightOuter,c.rightOuter,t),roadHalfWidth:mix(a.roadHalfWidth,c.roadHalfWidth,t),lowerWalkDrop:mix(a.lowerWalkDrop,c.lowerWalkDrop,t),d,n:[d[1],-d[0]] as TramPoint};
}
export function bridgeWorldPoint(b:ReconstructedBridge,s:number,t:number,y:number):SupportVertex{const q=bridgeSection(b,s);return f32([q.x+q.n[0]*t,y,q.z+q.n[1]*t]);}
export function bridgeDeckHeight(b:ReconstructedBridge,s:number,t:number,walk=false):number{
  const q=bridgeSection(b,s),roadEdge=q.roadY-b.crossfall*q.roadHalfWidth;
  return walk?roadEdge+b.curbHeight-q.lowerWalkDrop:q.roadY-b.crossfall*Math.min(Math.abs(t),q.roadHalfWidth);
}

function bankFloorHeight(faces:readonly BridgeFace[],x:number,z:number):number|undefined{
 let highest=-Infinity;for(const f of faces){const[a,c,e]=f.points,den=(c[2]-e[2])*(a[0]-e[0])+(e[0]-c[0])*(a[2]-e[2]);if(Math.abs(den)<1e-12)continue;const u=((c[2]-e[2])*(x-e[0])+(e[0]-c[0])*(z-e[2]))/den,v=((e[2]-a[2])*(x-e[0])+(a[0]-e[0])*(z-e[2]))/den;if(Math.min(u,v,1-u-v)>=-1e-7)highest=Math.max(highest,supportHeight(f.points,[x,z]));}return Number.isFinite(highest)?highest:undefined;
}

export function buildReconstructedBridge(b:ReconstructedBridge,options:{coarse?:boolean;source?:BridgeFloorSource}={}):BridgeFace[]{
  validateReconstructedBridge(b);const sourceBanks=options.source?(b.quays??[]).flatMap(q=>buildBridgeBankQuay(q,options.source!.height,()=>undefined,options.source!.triangles)).filter(f=>f.role==='bank'):[],faces:BridgeFace[]=[],length=bridgeLengths(b).at(-1)!,coarse=options.coarse??false;
  const emit=(points:readonly SupportVertex[],material:BridgeMaterial,role:BridgeRole,outward:readonly number[],collision=true)=>{
    for(let k=1;k<points.length-1;k++){
      let p=[points[0]!,points[k]!,points[k+1]!] as SupportTriangle;let normal:SupportVertex;try{normal=supportNormal(p);}catch{continue;}
      if(normal.reduce((sum,v,i)=>sum+v*outward[i]!,0)<0){p=[p[0],p[2],p[1]];normal=supportNormal(p);}
      // Wall courses are horizontal, independent of roof/road mapping. No
      // world-XZ-plus-Y diagonal paving projection on vertical granite.
      const wall=Math.abs(normal[1])<.6,uvs=p.map(v=>wall?[Math.hypot(v[0]-b.stations[0]!.x,v[2]-b.stations[0]!.z)/4,v[1]/2]:[v[0]/4,v[2]/4]) as [TramPoint,TramPoint,TramPoint];
      faces.push({points:p,material,role,uvs,collision});
    }
  };
  const quad=(a:SupportVertex,c:SupportVertex,d:SupportVertex,e:SupportVertex,m:BridgeMaterial,r:BridgeRole,n:readonly number[],collision=true)=>emit([a,c,d,e],m,r,n,collision);
  function box(s0:number,s1:number,t0:number,t1:number,y00:number,y01:number,y10:number,y11:number,height:number,m:BridgeMaterial,role:BridgeRole){
    const a=bridgeWorldPoint(b,s0,t0,y00),c=bridgeWorldPoint(b,s0,t1,y01),d=bridgeWorldPoint(b,s1,t1,y11),e=bridgeWorldPoint(b,s1,t0,y10),A=f32([a[0],a[1]+height,a[2]]),C=f32([c[0],c[1]+height,c[2]]),D=f32([d[0],d[1]+height,d[2]]),E=f32([e[0],e[1]+height,e[2]]),q=bridgeSection(b,(s0+s1)/2);
    const continuousCoarseBar=coarse&&(role==='railing'||role==='glass')&&s1-s0>.1;
    if(!coarse||role!=='glass'){quad(A,C,D,E,m,role,[0,1,0]);quad(e,d,c,a,m,role,[0,-1,0]);}
    if(!continuousCoarseBar||s0===b.architectureStartMetres)quad(a,c,C,A,m,role,[-q.d[0],0,-q.d[1]]);
    if(!continuousCoarseBar||s1===b.architectureEndMetres)quad(e,E,D,d,m,role,[q.d[0],0,q.d[1]]);
    quad(a,A,E,e,m,role,[-q.n[0],0,-q.n[1]]);quad(c,d,D,C,m,role,[q.n[0],0,q.n[1]]);
  }
  const lengths=bridgeLengths(b),cuts=new Set<number>([...lengths,b.architectureStartMetres,b.architectureEndMetres]);if(b.approachMetres){cuts.add(b.approachMetres);cuts.add(length-b.approachMetres);}
  // The road/footway tessellation remains identical in every tier: reducing
  // architecture must never change the surface under the embedded rails.
  for(let s=0;s<length;s+=1)cuts.add(s);cuts.add(length);
  const steps=[...cuts].sort((a,c)=>a-c),rows=new Map<number,number[]>();
  for(const s of steps){const q=bridgeSection(b,s),v=[-q.leftOuter,-q.roadHalfWidth,0,q.roadHalfWidth,q.rightOuter];if(b.kind==='two-level-composite')v.push(-q.roadHalfWidth-.45,q.roadHalfWidth+.45);if(s<=b.approachMetres+1e-8||s>=length-b.approachMetres-1e-8)v.push(...(options.source?.bankCrossBreaks??[]).filter(t=>t>-q.leftOuter&&t<q.rightOuter));const pinned=new Set([-q.leftOuter,-q.roadHalfWidth,0,q.roadHalfWidth,q.rightOuter,...(b.kind==='two-level-composite'?[-q.roadHalfWidth-.45,q.roadHalfWidth+.45]:[])]),sorted=[...new Set(v)].sort((a,c)=>a-c),merged:number[]=[];for(const t of sorted){const p=bridgeWorldPoint(b,s,t,0),last=merged.length?bridgeWorldPoint(b,s,merged.at(-1)!,0):undefined;if(!last||p[0]!==last[0]||p[2]!==last[2])merged.push(t);else if(pinned.has(t))merged[merged.length-1]=t;}rows.set(s,merged);}
  const bankWeight=(s:number)=>b.approachMetres?Math.min(1,s/b.approachMetres,(length-s)/b.approachMetres):1;
  const height=(s:number,t:number,walk:boolean)=>{const authored=bridgeDeckHeight(b,s,t,walk),w=bankWeight(s);if(w>=1-1e-8||!options.source)return authored;const bank=s<length/2?0:length,p=bridgeWorldPoint(b,bank,t,authored),old=options.source.height(p[0],p[2]);assert.ok(Number.isFinite(old),`Bridge bank has no source support: ${b.id} ${p}`);return mix(old,authored,w);};
  const lowestSoffits=new Map(steps.map(s=>{const q=bridgeSection(b,s),ys=rows.get(s)!.map(t=>Math.fround(height(s,t,Math.abs(t)>q.roadHalfWidth)));return[s,Math.min(...ys)-b.deckThickness] as const;})),roofPoints=new Map<string,number>(),landRoof:SupportTriangle[]=[];
  for(let i=0;i<steps.length-1;i++){
    const s0=steps[i]!,s1=steps[i+1]!,q0=bridgeSection(b,s0),q1=bridgeSection(b,s1),cross=[...new Set([...rows.get(s0)!,...rows.get(s1)!])].sort((a,c)=>a-c);
    const bandBounds=(q:ReturnType<typeof bridgeSection>,band:number):[number,number]=>band===0?[-q.leftOuter,-q.roadHalfWidth]:band===1?[-q.roadHalfWidth,0]:band===2?[0,q.roadHalfWidth]:[q.roadHalfWidth,q.rightOuter];
    for(let band=0;band<4;band++){
      const road=band===1||band===2,role:BridgeRole=road?'road':'footway',bounds0=bandBounds(q0,band),bounds1=bandBounds(q1,band);
      const row=(s:number,bounds:[number,number])=>[bounds[0],...rows.get(s)!.filter(t=>t>bounds[0]+1e-9&&t<bounds[1]-1e-9),bounds[1]].map(t=>{const p=bridgeWorldPoint(b,s,t,height(s,t,!road));roofPoints.set(p.join(','),lowestSoffits.get(s)!);return{u:(t-bounds[0])/(bounds[1]-bounds[0]),p};});
      const A=row(s0,bounds0),B=row(s1,bounds1),architecture=s0>=b.architectureStartMetres&&s1<=b.architectureEndMetres&&b.kind!=='granite-three-arch';
      const floorTriangle=(p:SupportVertex[])=>{if(b.shoreClosure)landRoof.push(p.map(v=>f32([v[0],roofPoints.get(v.join(','))!,v[2]])) as SupportTriangle);emit(p,'asphalt',role,[0,1,0]);if(architecture)emit(p.map(v=>f32([v[0],v[1]-b.deckThickness,v[2]])),'concrete','soffit',[0,-1,0]);};
      let j=0,k=0;
      // Zipper the two explicit row polylines. Bank detail need not propagate
      // through the entire bridge; every shared row still has identical vertices.
      while(j<A.length-1||k<B.length-1){const nextA=A[j+1]?.u??Infinity,nextB=B[k+1]?.u??Infinity;
        if(Math.abs(nextA-nextB)<1e-10){floorTriangle([A[j]!.p,A[j+1]!.p,B[k+1]!.p]);floorTriangle([A[j]!.p,B[k+1]!.p,B[k]!.p]);j++;k++;}
        else if(nextA<nextB){floorTriangle([A[j]!.p,A[j+1]!.p,B[k]!.p]);j++;}
        else{floorTriangle([A[j]!.p,B[k+1]!.p,B[k]!.p]);k++;}
      }
      if(architecture)for(const row of[s0===b.architectureStartMetres?A:null,s1===b.architectureEndMetres?B:null])if(row)for(let j=0;j<row.length-1;j++){const a=row[j]!.p,c=row[j+1]!.p;quad(f32([a[0],a[1]-b.deckThickness,a[2]]),f32([c[0],c[1]-b.deckThickness,c[2]]),c,a,'concrete','soffit',[q0.d[0],0,q0.d[1]]);}
    }
    for(const sign of [-1,1]){
      const r0=q0.roadHalfWidth*sign,r1=q1.roadHalfWidth*sign,walk0=height(s0,r0,true),walk1=height(s1,r1,true),road0=height(s0,r0,false),road1=height(s1,r1,false),normal=[q0.n[0]*-sign*(walk0+walk1>=road0+road1?1:-1),0,q0.n[1]*-sign*(walk0+walk1>=road0+road1?1:-1)];
      quad(bridgeWorldPoint(b,s0,r0,road0),bridgeWorldPoint(b,s1,r1,road1),bridgeWorldPoint(b,s1,r1,walk1),bridgeWorldPoint(b,s0,r0,walk0),b.kind==='granite-three-arch'?'granite':'concrete','curb',normal);
      if(b.kind!=='granite-three-arch'&&s0>=b.architectureStartMetres&&s1<=b.architectureEndMetres){quad(bridgeWorldPoint(b,s0,r0,road0-b.deckThickness),bridgeWorldPoint(b,s1,r1,road1-b.deckThickness),bridgeWorldPoint(b,s1,r1,walk1-b.deckThickness),bridgeWorldPoint(b,s0,r0,walk0-b.deckThickness),'concrete','soffit',normal.map(v=>-v));}
      const outer0=sign<0?-q0.leftOuter:q0.rightOuter,outer1=sign<0?-q1.leftOuter:q1.rightOuter;
      if(b.kind!=='granite-three-arch'&&s0>=b.architectureStartMetres&&s1<=b.architectureEndMetres)quad(bridgeWorldPoint(b,s0,outer0,height(s0,outer0,true)-b.deckThickness),bridgeWorldPoint(b,s1,outer1,height(s1,outer1,true)-b.deckThickness),bridgeWorldPoint(b,s1,outer1,height(s1,outer1,true)),bridgeWorldPoint(b,s0,outer0,height(s0,outer0,true)),'concrete','soffit',[q0.n[0]*sign,0,q0.n[1]*sign]);
      if(options.source&&(s1<=b.architectureStartMetres||s0>=b.architectureEndMetres)){
        const a=bridgeWorldPoint(b,s0,outer0,0),c=bridgeWorldPoint(b,s1,outer1,0),y0=height(s0,outer0,true),y1=height(s1,outer1,true),raw0=b.quays?.length?Math.min(bankFloorHeight(sourceBanks,a[0],a[2])??y0-b.deckThickness,y0-b.deckThickness):options.source.height(a[0],a[2]),raw1=b.quays?.length?Math.min(bankFloorHeight(sourceBanks,c[0],c[2])??y1-b.deckThickness,y1-b.deckThickness):options.source.height(c[0],c[2]),old0=Number.isFinite(raw0)?raw0:b.waterY,old1=Number.isFinite(raw1)?raw1:b.waterY;
        quad(bridgeWorldPoint(b,s0,outer0,Math.min(y0,old0,...(b.kind==='two-level-composite'?[b.waterY-.5]:[]))),bridgeWorldPoint(b,s1,outer1,Math.min(y1,old1,...(b.kind==='two-level-composite'?[b.waterY-.5]:[]))),bridgeWorldPoint(b,s1,outer1,Math.max(y1,old1)),bridgeWorldPoint(b,s0,outer0,Math.max(y0,old0)),b.kind==='granite-three-arch'?'granite':'concrete','soffit',[q0.n[0]*sign,0,q0.n[1]*sign]);
      }
      if(s0>=b.architectureStartMetres&&s1<=b.architectureEndMetres){
        const bottom0=b.kind==='granite-three-arch'?walk0-.7:walk0-b.deckThickness,bottom1=b.kind==='granite-three-arch'?walk1-.7:walk1-b.deckThickness;
        quad(bridgeWorldPoint(b,s0,outer0,bottom0),bridgeWorldPoint(b,s1,outer1,bottom1),bridgeWorldPoint(b,s1,outer1,walk1),bridgeWorldPoint(b,s0,outer0,walk0),b.kind==='granite-three-arch'?'granite':'concrete','soffit',[q0.n[0]*sign,0,q0.n[1]*sign]);
        const t=(outer0+outer1)/2-sign*b.parapet.thickness/2;
        if(b.parapet.kind==='granite')box(s0,s1,t-b.parapet.thickness/2,t+b.parapet.thickness/2,walk0,walk0,walk1,walk1,b.parapet.height,'granite','parapet');
        else for(const h of [b.parapet.height*.45,b.parapet.height])box(s0,s1,t-.035,t+.035,walk0+h-.035,walk0+h-.035,walk1+h-.035,walk1+h-.035,.07,'steel','railing');
        if(b.kind==='two-level-composite'){
          const edge=(r0+r1)/2;box(s0,s1,edge-.025,edge+.025,road0+.16,road0+.16,road1+.16,road1+.16,1.05,'glass','glass');
          box(s0,s1,edge-.035,edge+.035,road0+1.21,road0+1.21,road1+1.21,road1+1.21,.055,'steel','railing');
        }
      }
    }
    if(s0>=b.architectureStartMetres&&s1<=b.architectureEndMetres){
      if(b.kind==='granite-three-arch')for(const t of [-.13,.13])quad(bridgeWorldPoint(b,s0,t-.04,height(s0,t,false)+.002),bridgeWorldPoint(b,s0,t+.04,height(s0,t,false)+.002),bridgeWorldPoint(b,s1,t+.04,height(s1,t,false)+.002),bridgeWorldPoint(b,s1,t-.04,height(s1,t,false)+.002),'marking','marking',[0,1,0],false);
      if(b.kind==='two-level-composite')for(const sign of [-1,1])box(s0,s1,sign*.45-.04,sign*.45+.04,q0.roadY+.5,q0.roadY+.5,q1.roadY+.5,q1.roadY+.5,.12,'steel','railing');
      if(b.kind==='concrete-girder')for(const t of [-q0.roadHalfWidth*.65,0,q0.roadHalfWidth*.65]){
        const y0=height(s0,t,false)-b.deckThickness-.8,y1=height(s1,t,false)-b.deckThickness-.8;box(s0,s1,t-.2,t+.2,y0,y0,y1,y1,.8,'concrete','soffit');
      }
    }
  }
  // Discrete posts remain in the coarse silhouette at a lower frequency.
  for(let s=b.architectureStartMetres;s<=b.architectureEndMetres;s+=coarse?12:2){const q=bridgeSection(b,s),s1=Math.min(b.architectureEndMetres,s+.075);if(s1<=s)continue;
    for(const sign of [-1,1]){const t=(sign<0?-q.leftOuter:q.rightOuter)-sign*.1,y=height(s,t,true);if(b.parapet.kind==='steel'){const stone=b.parapet.postMaterial==='granite',radius=stone?.13:.04;box(s,s1+(stone?.185:0),t-radius,t+radius,y,y,y,y,b.parapet.height,stone?'granite':'steel','railing');}if(b.kind==='two-level-composite'){const r=q.roadHalfWidth*sign,h=height(s,r,false);box(s,s1,r-.045,r+.045,h+.1,h+.1,h+.1,h+.1,1.15,'steel','railing');}}
  }
  if(b.parapet.lattice&&!coarse)for(let s=b.architectureStartMetres;s<b.architectureEndMetres;s+=2){const end=Math.min(b.architectureEndMetres,s+2),a=bridgeSection(b,s),c=bridgeSection(b,end);for(const sign of[-1,1]){const t=(sign<0?-(a.leftOuter+c.leftOuter)/2:(a.rightOuter+c.rightOuter)/2)-sign*.1,low0=height(s,t,true)+.12,low1=height(end,t,true)+.12,high0=height(s,t,true)+b.parapet.height-.08,high1=height(end,t,true)+b.parapet.height-.08;box(s,end,t-.025,t+.025,low0,low0,high1,high1,.05,'steel','railing');box(s,end,t-.025,t+.025,high0,high0,low1,low1,.05,'steel','railing');}}
  if(b.kind==='granite-three-arch'){
    const arch=b.arch!,start=b.architectureStartMetres,end=b.architectureEndMetres,pier=arch.pierWidth,abut=arch.abutmentWidth,span=(end-start-2*abut-2*pier)/3,spring=b.waterY+arch.springHeightAboveWater;
    assert.ok(span>5);
    for(let i=0;i<3;i++){
      const a=start+abut+i*(span+pier),c=a+span,N=coarse?12:32;
      for(let k=0;k<N;k++){
        const s0=a+span*k/N,s1=a+span*(k+1)/N,q0=bridgeSection(b,s0),q1=bridgeSection(b,s1),roof=(s:number)=>bridgeSection(b,s).roadY-.25,soffit=(s:number)=>spring+(roof(s)-arch.crownDepth-spring)*Math.sqrt(Math.max(0,1-((s-(a+c)/2)/(span/2))**2)),y0=soffit(s0),y1=soffit(s1),L0=-q0.leftOuter,R0=q0.rightOuter,L1=-q1.leftOuter,R1=q1.rightOuter;
        quad(bridgeWorldPoint(b,s0,L0,y0),bridgeWorldPoint(b,s1,L1,y1),bridgeWorldPoint(b,s1,R1,y1),bridgeWorldPoint(b,s0,R0,y0),'granite','soffit',[0,-1,0]);
        quad(bridgeWorldPoint(b,s0,L0,roof(s0)),bridgeWorldPoint(b,s0,R0,roof(s0)),bridgeWorldPoint(b,s1,R1,roof(s1)),bridgeWorldPoint(b,s1,L1,roof(s1)),'granite','soffit',[0,1,0]);
        for(const sign of [-1,1]){const t0=sign<0?L0:R0,t1=sign<0?L1:R1;quad(bridgeWorldPoint(b,s0,t0,y0),bridgeWorldPoint(b,s1,t1,y1),bridgeWorldPoint(b,s1,t1,roof(s1)),bridgeWorldPoint(b,s0,t0,roof(s0)),'granite','soffit',[q0.n[0]*sign,0,q0.n[1]*sign]);}
        if(k===0)quad(bridgeWorldPoint(b,s0,L0,y0),bridgeWorldPoint(b,s0,R0,y0),bridgeWorldPoint(b,s0,R0,roof(s0)),bridgeWorldPoint(b,s0,L0,roof(s0)),'granite','soffit',[-q0.d[0],0,-q0.d[1]]);
        if(k===N-1)quad(bridgeWorldPoint(b,s1,L1,y1),bridgeWorldPoint(b,s1,R1,y1),bridgeWorldPoint(b,s1,R1,roof(s1)),bridgeWorldPoint(b,s1,L1,roof(s1)),'granite','soffit',[q1.d[0],0,q1.d[1]]);
      }
    }
    const blocks:[number,number][]=[[start,start+abut],[start+abut+span,start+abut+span+pier],[start+abut+2*span+pier,start+abut+2*span+2*pier],[end-abut,end]];
    for(const[a,c]of blocks){const q=bridgeSection(b,(a+c)/2),bottom=b.waterY-1;box(a,c,-q.leftOuter,q.rightOuter,bottom,bottom,bottom,bottom,q.roadY-.25-bottom,'granite','pier');}
  }else{
    for(const support of b.supports??[]){const q=bridgeSection(b,support.atMetres),a=support.atMetres-support.width/2,c=support.atMetres+support.width/2,top=q.roadY-b.deckThickness-.15;box(a,c,-q.roadHalfWidth+.4,q.roadHalfWidth-.4,support.bottomY,support.bottomY,support.bottomY,support.bottomY,top-support.bottomY,'concrete','pier');}
  }
  if(b.underpass)faces.push(...buildBridgeUnderpass(b,options.source,faces));
  if(b.quays?.length){assert.ok(options.source,'Quay reconstruction requires actual source floors');const upper=[...faces],zones=bridgeReplacementZones({...b,quays:undefined}),floorHeight=(x:number,z:number)=>{for(const f of upper.filter(f=>f.role==='road'||f.role==='footway')){const[a,c,e]=f.points,den=(c[2]-e[2])*(a[0]-e[0])+(e[0]-c[0])*(a[2]-e[2]);if(Math.abs(den)<1e-12)continue;const u=((c[2]-e[2])*(x-e[0])+(e[0]-c[0])*(z-e[2]))/den,v=((e[2]-a[2])*(x-e[0])+(a[0]-e[0])*(z-e[2]))/den;if(Math.min(u,v,1-u-v)>=-.00001)return supportHeight(f.points,[x,z])-b.deckThickness;}return undefined;};
    for(const q of b.quays){const raw=buildBridgeBankQuay(q,options.source.height,floorHeight,options.source.triangles),top=raw.filter(f=>f.role==='footway'),walls=raw.filter(f=>f.role!=='footway');faces.push(...clipBridgeAuxiliaryFloor(top,zones,upper),...walls);}
  }
  if(b.shoreClosure)faces.push(...buildBridgeLandClosure(b.shoreClosure.land,landRoof,b.waterY));
  assert.ok(faces.length>0&&faces.length<60000,`${b.id} ${coarse?'coarse':'detailed'} has${faces.length}triangles`);
  return faces;
}

/** A separately qualified lower public path, not a projection of the road
 * above. Banks are measured source floors; the middle is an authored join. */
export function buildBridgeUnderpass(b:ReconstructedBridge,source?:BridgeFloorSource,upperFaces:readonly BridgeFace[]=[]):BridgeFace[]{
  const u=b.underpass;if(!u)return[];
  assert.ok(u.stations.length===2&&u.halfWidth>1&&u.halfWidth<6);
  const a=u.stations[0]!,c=u.stations[1]!,dx=c.x-a.x,dz=c.z-a.z,L=Math.hypot(dx,dz),d:TramPoint=[dx/L,dz/L],n:TramPoint=[d[1],-d[0]],faces:BridgeFace[]=[];
  const left=u.leftWidth??u.halfWidth,right=u.rightWidth??u.halfWidth,thickness=u.wallThickness??0,leftInner=-left+thickness/2,rightInner=right-thickness/2,leftOuter=-left-(u.leftApron??thickness/2),rightOuter=right+(u.rightApron??thickness/2);
  assert.ok(left>1&&right>1&&left<15&&right<15&&leftInner<rightInner&&thickness>=0&&thickness<=1);
  const cross=[leftInner,rightInner,...(source?.underpassBankCrossBreaks??[]).filter(t=>t>leftInner&&t<rightInner)].sort((x,y)=>x-y),point=(s:number,t:number,y:number)=>f32([a.x+d[0]*s+n[0]*t,y,a.z+d[1]*s+n[1]*t]);
  const floor=(s:number,t:number)=>{const authored=mix(a.floorY,c.floorY,s/L),weight=Math.min(1,s/u.bankBlendMetres,(L-s)/u.bankBlendMetres);if(!source||weight>=1)return authored;const bank=s<L/2?0:L,publicT=u.publicFloorRange?Math.max(u.publicFloorRange[0],Math.min(u.publicFloorRange[1],t)):t,p=point(bank,publicT,0),old=source.height(p[0],p[2]);assert.ok(Number.isFinite(old),`Underpass public bank missing source floor${p}`);return mix(old,authored,weight);};
  const emit=(p:SupportVertex[],role:BridgeRole,material:BridgeMaterial,outward:number[])=>{for(let k=1;k<p.length-1;k++){let points=[p[0]!,p[k]!,p[k+1]!] as SupportTriangle;let normal:SupportVertex;try{normal=supportNormal(points);}catch{continue;}if(normal.reduce((s,v,i)=>s+v*outward[i]!,0)<0)points=[points[0],points[2],points[1]];faces.push({points,role,material,collision:true,uvs:points.map(v=>role==='footway'?[v[0]/4,v[2]/4]:[Math.hypot(v[0]-a.x,v[2]-a.z)/4,v[1]/2]) as BridgeFace['uvs']});}};
  const apronFaces:BridgeFace[]=[],upperZones=bridgeReplacementZones({...b,underpass:undefined});
  const upperTop=(s:number,t:number)=>{const P=point(s,t,0),lengths=bridgeLengths(b);let closest={distance:Infinity,s:0,t:0};for(let i=1;i<b.stations.length;i++){const A=b.stations[i-1]!,C=b.stations[i]!,dx=C.x-A.x,dz=C.z-A.z,v=Math.max(0,Math.min(1,((P[0]-A.x)*dx+(P[2]-A.z)*dz)/(dx*dx+dz*dz))),x=A.x+dx*v,z=A.z+dz*v,distance=Math.hypot(P[0]-x,P[2]-z);if(distance<closest.distance){const S=lengths[i-1]!+Math.hypot(dx,dz)*v,q=bridgeSection(b,S);closest={distance,s:S,t:(P[0]-x)*q.n[0]+(P[2]-z)*q.n[1]};}}const q=bridgeSection(b,closest.s);if(closest.t>=-q.leftOuter&&closest.t<=q.rightOuter){const road=bridgeDeckHeight(b,closest.s,closest.t,Math.abs(closest.t)>q.roadHalfWidth),underside=closest.s>=b.architectureStartMetres&&closest.s<=b.architectureEndMetres?road-b.deckThickness:road;return Math.min(u.wallTopY??Infinity,underside);}return u.wallTopY;};
  const cuts=new Set([0,L,...(source?.underpassAlongBreaks??[])]);for(let s=0;s<L;s+=1)cuts.add(s);const steps=[...cuts].filter(s=>s>=0&&s<=L).sort((a,c)=>a-c);
  const floorRow=(S:number)=>{const detailed=S<u.bankBlendMetres||S>L-u.bankBlendMetres,range=u.publicFloorRange??[leftInner,rightInner],values=detailed?cross.filter(t=>t>=range[0]&&t<=range[1]):[0];return[...new Set([leftInner,rightInner,range[0],range[1],...values])].sort((a,c)=>a-c).map(t=>({t,p:point(S,t,floor(S,t))}));};
  for(let step=0;step<steps.length-1;step++){const s0=steps[step]!,s1=steps[step+1]!,A=floorRow(s0),B=floorRow(s1);let i=0,j=0;while(i<A.length-1||j<B.length-1){const a=A[i+1]?.t??Infinity,c=B[j+1]?.t??Infinity;if(Math.abs(a-c)<1e-10){emit([A[i]!.p,A[i+1]!.p,B[j+1]!.p],'footway','asphalt',[0,1,0]);emit([A[i]!.p,B[j+1]!.p,B[j]!.p],'footway','asphalt',[0,1,0]);i++;j++;}else if(a<c){emit([A[i]!.p,A[i+1]!.p,B[j]!.p],'footway','asphalt',[0,1,0]);i++;}else{emit([A[i]!.p,B[j+1]!.p,B[j]!.p],'footway','asphalt',[0,1,0]);j++;}}

    for(const sign of[-1,1]){const t=sign<0?leftInner:rightInner,outer=sign<0?leftOuter:rightOuter,back=t+sign*thickness,p0=point(s0,outer,0),p1=point(s1,outer,0),bottom0=floor(s0,t),bottom1=floor(s1,t),old0=source?.height(p0[0],p0[2]),old1=source?.height(p1[0],p1[2]),rawTop=(S:number)=>upperTop(S,t)??source?.height(...[point(S,back,0)[0],point(S,back,0)[2]] as [number,number])??floor(S,t),cap=(S:number)=>{const desired=rawTop(S),weight=Math.min(1,S/u.bankBlendMetres,(L-S)/u.bankBlendMetres);if(!source||weight>=1)return desired;const bank=S<L/2?0:L,p=point(bank,back,0),old=source.height(p[0],p[2]);assert.ok(Number.isFinite(old),'Upper street wall bank missing');return mix(old,desired,weight);},top0=Math.max(bottom0,cap(s0)),top1=Math.max(bottom1,cap(s1));emit([point(s0,t,bottom0),point(s1,t,bottom1),point(s1,t,top1),point(s0,t,top0)],'soffit','granite',[n[0]*-sign,0,n[1]*-sign]);
      if(thickness){emit([point(s0,back,bottom0),point(s0,back,top0),point(s1,back,top1),point(s1,back,bottom1)],'soffit','granite',[n[0]*sign,0,n[1]*sign]);emit([point(s0,t,top0),point(s1,t,top1),point(s1,back,top1),point(s0,back,top0)],'soffit','granite',[0,1,0]);for(const S of[s0===0?s0:null,s1===L?s1:null])if(S!==null){const y=S===s0?bottom0:bottom1,top=S===s0?top0:top1;emit([point(S,t,y),point(S,back,y),point(S,back,top),point(S,t,top)],'soffit','granite',[d[0],0,d[1]]);}}
      if(Math.abs(outer-back)>.00001){assert.ok(Number.isFinite(old0)&&Number.isFinite(old1),'Upper Baana apron needs actual source street support');const row=(S:number,oldOuter:number)=>{
        const weight=Math.min(1,S/u.bankBlendMetres,(L-S)/u.bankBlendMetres),bank=S<L/2?0:L,bankOuter=point(bank,outer,0),oldBankOuter=source!.height(bankOuter[0],bankOuter[2]),detailed=weight<1,knots=[0,1,...(detailed?source?.underpassBankCrossBreaks??[]:[]).map(T=>(T-back)/(outer-back)).filter(v=>v>0&&v<1)].sort((a,c)=>a-c);
        return knots.map(v=>{const T=mix(back,outer,v),authored=mix(rawTop(S),oldOuter,v),p=point(bank,T,0),old=source!.height(p[0],p[2]);assert.ok(!detailed||Number.isFinite(old),'Upper apron end requires its actual source cross-section');const bankShape=old+(oldOuter-oldBankOuter)*v;return{v,p:point(S,T,detailed?mix(bankShape,authored,weight):authored)};});
      },A=row(s0,old0!),B=row(s1,old1!),start=faces.length;let i=0,j=0;while(i<A.length-1||j<B.length-1){const a=A[i+1]?.v??Infinity,c=B[j+1]?.v??Infinity;if(Math.abs(a-c)<1e-10){emit([A[i]!.p,A[i+1]!.p,B[j+1]!.p],'road','asphalt',[0,1,0]);emit([A[i]!.p,B[j+1]!.p,B[j]!.p],'road','asphalt',[0,1,0]);i++;j++;}else if(a<c){emit([A[i]!.p,A[i+1]!.p,B[j]!.p],'road','asphalt',[0,1,0]);i++;}else{emit([A[i]!.p,B[j+1]!.p,B[j]!.p],'road','asphalt',[0,1,0]);j++;}}apronFaces.push(...faces.splice(start));}
    }
  }
  // Aprons behind the retaining walls meet the original street, but must not
  // add a second coplanar floor over the independently authored upper deck.
  faces.push(...clipBridgeAuxiliaryFloor(apronFaces,upperZones,upperFaces));
  // Close the nonpublic wall-footing ends. The source has missing triangles at
  // these toes; only the separately measured walking/cycle opening stays open.
  if(u.publicFloorRange&&u.wallTopY!==undefined)for(const S of[0,L])for(const[t0,t1]of[[leftInner,u.publicFloorRange[0]],[u.publicFloorRange[1],rightInner]]){const y0=floor(S,t0!),y1=floor(S,t1!),normal=S===0?[-d[0],0,-d[1]]:[d[0],0,d[1]];emit([point(S,t0!,y0),point(S,t1!,y1),point(S,t1!,u.wallTopY),point(S,t0!,u.wallTopY)],'soffit','granite',normal);}
  return faces;
}


function clipBridgeAuxiliaryFloor(apronFaces:readonly BridgeFace[],upperZones:TramSupportPatch[],upperFaces:readonly BridgeFace[]):BridgeFace[]{
  const faces:BridgeFace[]=[],upperFloors=upperFaces.filter(f=>f.role==='road'||f.role==='footway');
  const onBoundary=(p:SupportVertex,zone:TramSupportPatch)=>zone.footprint!.some((a,i)=>{const c=zone.footprint![(i+1)%zone.footprint!.length]!,dx=c[0]-a[0],dz=c[1]-a[1],L2=dx*dx+dz*dz,u=((p[0]-a[0])*dx+(p[2]-a[1])*dz)/L2;return u>=-.00001&&u<=1.00001&&Math.abs(dx*(p[2]-a[1])-dz*(p[0]-a[0]))/Math.sqrt(L2)<.00008;});
  for(const zone of upperZones)zone.boundary=upperFloors.flatMap(f=>f.points).filter(p=>onBoundary(p,zone));
  const apronTop=(p:SupportVertex):SupportVertex=>{
    if(!upperZones.some(zone=>onBoundary(p,zone)))return p;
    for(const f of upperFloors){const[a,c,e]=f.points,den=(c[2]-e[2])*(a[0]-e[0])+(e[0]-c[0])*(a[2]-e[2]);if(Math.abs(den)<1e-12)continue;const u=((c[2]-e[2])*(p[0]-e[0])+(e[0]-c[0])*(p[2]-e[2]))/den,v=((e[2]-a[2])*(p[0]-e[0])+(a[0]-e[0])*(p[2]-e[2]))/den;if(Math.min(u,v,1-u-v)<-.0002)continue;return f32([p[0],supportHeight(f.points,[p[0],p[2]]),p[2]]);}
    return p;
  };
  if(apronFaces.length){const mesh={attributes:{POSITION:Float32Array.from(apronFaces.flatMap(f=>f.points.flat())),TEXCOORD_0:Float32Array.from(apronFaces.flatMap(f=>f.uvs.flat()))},components:{POSITION:3,TEXCOORD_0:2},normalized:{POSITION:false,TEXCOORD_0:false},indices:Uint32Array.from({length:apronFaces.length*3},(_,i)=>i)},kept=retainOutsideBridge(mesh,upperZones);for(let i=0;i<kept.mesh.indices.length;i+=3){const original=apronFaces[kept.sourceTriangles[i/3]!]!,ids=[0,1,2].map(k=>kept.mesh.indices[i+k]!),points=ids.map(id=>apronTop(Array.from(kept.mesh.attributes.POSITION!.slice(id*3,id*3+3)) as SupportVertex)) as SupportTriangle,uvs=ids.map(id=>Array.from(kept.mesh.attributes.TEXCOORD_0!.slice(id*2,id*2+2))) as BridgeFace['uvs'];faces.push({...original,points,uvs});}}
  return faces;
}

/** Cell clipping shares the exact Float32 intersection vertices on both sides.
 * A bridge can span cells without its collider being owned by a distant centre. */
export function splitBridgeFaces(faces:readonly BridgeFace[],size=128):Map<string,BridgeFace[]>{
  const result=new Map<string,BridgeFace[]>(),name=(x:number,z:number)=>`c_${x<0?'m':'p'}${String(Math.abs(x)).padStart(2,'0')}_${z<0?'m':'p'}${String(Math.abs(z)).padStart(2,'0')}`;
  type V={p:SupportVertex;uv:TramPoint};
  const cut=(ring:V[],axis:0|2,value:number,sign:number)=>{const out:V[]=[];for(let i=0;i<ring.length;i++){const a=ring[i]!,b=ring[(i+1)%ring.length]!,va=(a.p[axis]-value)*sign,vb=(b.p[axis]-value)*sign;if(va>=0)out.push(a);if((va>=0)!==(vb>=0)){const t=va/(va-vb),p=f32(a.p.map((v,k)=>mix(v,b.p[k]!,t)));p[axis]=value;out.push({p,uv:[mix(a.uv[0],b.uv[0],t),mix(a.uv[1],b.uv[1],t)]});}}return out;};
  for(const face of faces){const loX=Math.floor(Math.min(...face.points.map(p=>p[0]))/size),hiX=Math.floor(Math.max(...face.points.map(p=>p[0]))/size),loZ=Math.floor(Math.min(...face.points.map(p=>p[2]))/size),hiZ=Math.floor(Math.max(...face.points.map(p=>p[2]))/size);
    for(let x=loX;x<=hiX;x++)for(let z=loZ;z<=hiZ;z++){let ring=face.points.map((p,i)=>({p,uv:face.uvs[i]!}));for(const[axis,value,sign]of[[0,x*size,1],[0,(x+1)*size,-1],[2,z*size,1],[2,(z+1)*size,-1]] as const)ring=cut(ring,axis,value,sign);for(let i=1;i<ring.length-1;i++){const r=[ring[0]!,ring[i]!,ring[i+1]!] as const,points=r.map(v=>v.p) as SupportTriangle;try{supportNormal(points);}catch{continue;}const id=name(x,z),a=result.get(id)??[];a.push({...face,points,uvs:r.map(v=>v.uv) as BridgeFace['uvs']});result.set(id,a);}}
  }return result;
}

export function bridgeReplacementZones(b:ReconstructedBridge):TramSupportPatch[]{
  const lengths=bridgeLengths(b),pieces:TramSupportPatch[]=[];
  const first=b.stations[0]!,last=b.stations.at(-1)!,dx=last.x-first.x,dz=last.z-first.z,L=Math.hypot(dx,dz),straight=b.stations.every(s=>Math.abs(dx*(s.z-first.z)-dz*(s.x-first.x))/L<.000001&&s.leftOuter===first.leftOuter&&s.rightOuter===first.rightOuter);
  const cuts=new Set([...lengths,b.architectureStartMetres,b.architectureEndMetres]);for(let s=0;s<lengths.at(-1)!;s+=1)cuts.add(s);const rowCuts=[...cuts].sort((a,c)=>a-c),sections=straight?[[0,lengths.at(-1)!]] as [number,number][]:rowCuts.slice(1).map((s,i)=>[rowCuts[i]!,s] as [number,number]);
  // Only true outer boundaries may preserve aligned original walls. Interior
  // station cuts on a straight bridge must not retain old sheets in the deck.
  for(const[i,j]of sections){
    const q0=bridgeSection(b,i),q1=bridgeSection(b,j),footprint=[bridgeWorldPoint(b,i,-q0.leftOuter,0),bridgeWorldPoint(b,i,q0.rightOuter,0),bridgeWorldPoint(b,j,q1.rightOuter,0),bridgeWorldPoint(b,j,-q1.leftOuter,0)].map(p=>[p[0],p[2]] as TramPoint);
    const all=footprint;pieces.push({id:`${b.id}-${i}`,cell:'unassigned',footprint,boundsXZ:[Math.min(...all.map(p=>p[0])),Math.min(...all.map(p=>p[1])),Math.max(...all.map(p=>p[0])),Math.max(...all.map(p=>p[1]))],triangles:[],sourceNode:'explicit_bridge_reconstruction_ground',sourcePrimitive:0,observations:['Reference-led bridge footprint and bank tie-in; removed facets must be listed by the delivery adapter.']});
  }
  if(b.underpass){const u=b.underpass,pseudo:ReconstructedBridge={...b,id:`${b.id}-lower-passage`,underpass:undefined,stations:u.stations.map(p=>({...p,roadY:p.floorY,leftOuter:(u.leftWidth??u.halfWidth)+(u.leftApron??0),rightOuter:(u.rightWidth??u.halfWidth)+(u.rightApron??0),roadHalfWidth:u.halfWidth-.6,lowerWalkDrop:0}))};pieces.push(...bridgeReplacementZones(pseudo));}
  pieces.push(...(b.quays??[]).flatMap(quayReplacementZones));
  return pieces;
}

/** Exact municipal bridge rings can contain obsolete low source sheets just
 * outside the replacement deck. A height bound protects the real bank. */
export function bridgeSourceRemovalZones(b:ReconstructedBridge):BridgeReplacementPatch[]{
  return(b.sourceRemovals??[]).flatMap(removal=>{
    assert.ok(removal.polygon.length>=3&&Number.isFinite(removal.maximumSourceY));
    const ring=removal.polygon.at(-1)![0]===removal.polygon[0]![0]&&removal.polygon.at(-1)![1]===removal.polygon[0]![1]?removal.polygon.slice(0,-1):removal.polygon,indices=earcut(ring.flat()),out:BridgeReplacementPatch[]=[];
    for(let i=0;i<indices.length;i+=3){const footprint=indices.slice(i,i+3).map(index=>ring[index]!);out.push({id:`${b.id}-${removal.id}-${i/3}`,cell:'unassigned',footprint,boundsXZ:[Math.min(...footprint.map(p=>p[0]),...(removal.replaceBoundarySegments??[]).flat().map(p=>p[0])),Math.min(...footprint.map(p=>p[1]),...(removal.replaceBoundarySegments??[]).flat().map(p=>p[1])),Math.max(...footprint.map(p=>p[0]),...(removal.replaceBoundarySegments??[]).flat().map(p=>p[0])),Math.max(...footprint.map(p=>p[1]),...(removal.replaceBoundarySegments??[]).flat().map(p=>p[1]))],maximumSourceY:removal.maximumSourceY,...(removal.replaceBoundarySegments?{replaceBoundarySegments:removal.replaceBoundarySegments}:{}),...(removal.replaceBoundaryWalls?{replaceBoundaryEdges:[0,1,2]}:{}),triangles:[],sourceNode:removal.sourceNode??`municipal-silta-${removal.sourcePartId}`,sourcePrimitive:0,observations:[removal.observation]});}
    return out;
  });
}

export function appendBridgeCollision(bytes:Uint8Array,faces:readonly BridgeFace[],cell:string):Uint8Array{
  const old=parseCollisionBundle(bytes),tags=[...old.header.surfaceTags],colliders:TriMeshCollider[]=[...old.colliders],groups=new Map<string,BridgeFace[]>();
  for(const f of faces.filter(f=>f.collision)){const group=f.role==='road'||f.role==='footway'?'ground':f.role==='curb'?'kerbs':'props',tag=f.role==='road'?'road:asphalt:bridge-reconstruction':f.role==='footway'?'raised:asphalt:bridge-reconstruction':'wall:bridge-reconstruction',key=`${group}|${tag}`,a=groups.get(key)??[];a.push(f);groups.set(key,a);}
  for(const[key,items]of groups){const[group,tag]=key.split('|') as [TriMeshCollider['group'],string];let index=tags.indexOf(tag);if(index<0){index=tags.length;tags.push(tag);}const id=`bridge-reconstruction:${cell}:${group}:${colliders.length}`;assert.ok(!colliders.some(c=>c.id===id));const points=items.flatMap(f=>f.points.flat());colliders.push({id,group,ref:null,positions:Float32Array.from(points),indices:Uint32Array.from({length:items.length*3},(_,i)=>i),triangleTags:Uint16Array.from({length:items.length},()=>index)});}
  return encodeCollisionBundle({...old.header,surfaceTags:tags},colliders);
}

/** A rounded rail endpoint can land one Float32 step outside the source floor
 * edge it was clipped against. Keep the mapped double-precision footprint and
 * gauge unchanged, but choose an inside representable endpoint for that cap.
 * This is bounded construction, not a larger support/proof tolerance. */
export function conformBridgeRailBoundary(mesh:TramMesh,ground:readonly SupportTriangle[]=mesh.bindings.map(b=>b.ground.vertices)):{vertices:number;maximumTrimMetres:number}{
  assert.equal(new Set(mesh.indices).size,mesh.indices.length,'Bridge boundary construction requires independent triangle vertices');
  let at=0,vertices=0,maximumTrimMetres=0;
  for(const binding of mesh.bindings)for(let j=0;j<binding.triangles;j++,at++){
    const triangle=binding.ground.vertices,[a,b,c]=triangle,den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]),weights=(x:number,z:number)=>{const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den;return[u,v,1-u-v];},centre=[(a[0]+b[0]+c[0])/3,(a[2]+b[2]+c[2])/3];
    for(let k=0;k<3;k++){
      const index=mesh.indices[at*3+k]!*3,x=Math.fround(mesh.positions[index]!),z=Math.fround(mesh.positions[index+2]!);if(weights(x,z).every(v=>v>=-1e-10))continue;
      const w=weights(x,z).map(v=>Math.max(0,v)),sum=w.reduce((n,v)=>n+v),edge=[w.reduce((n,v,i)=>n+v*triangle[i]![0],0)/sum,w.reduce((n,v,i)=>n+v*triangle[i]![2],0)/sum];let point:TramPoint|null=null;
      const options=ground.filter(t=>x>=Math.min(...t.map(p=>p[0]))-.00008&&x<=Math.max(...t.map(p=>p[0]))+.00008&&z>=Math.min(...t.map(p=>p[2]))-.00008&&z<=Math.max(...t.map(p=>p[2]))+.00008),inside=(p:TramPoint)=>options.some(t=>{const[A,B,C]=t,D=(B[2]-C[2])*(A[0]-C[0])+(C[0]-B[0])*(A[2]-C[2]);if(Math.abs(D)<1e-14)return false;const u=((B[2]-C[2])*(p[0]-C[0])+(C[0]-B[0])*(p[1]-C[2]))/D,v=((C[2]-A[2])*(p[0]-C[0])+(A[0]-C[0])*(p[1]-C[2]))/D,y=u*A[1]+v*B[1]+(1-u-v)*C[1],expected=weights(...p).reduce((n,w,i)=>n+w*triangle[i]![1],0);return Math.min(u,v,1-u-v)>=-1e-10&&Math.abs(y-expected)<=.00001;});
      const next=(v:number,sign:number)=>{if(!sign)return v;const f=new Float32Array([v]),bits=new Uint32Array(f.buffer);bits[0]=bits[0]!+((sign>0)===(v>0)?1:-1);return f[0]!;},neighbours:TramPoint[]=[];
      const lattice=(v:number)=>{const values=[v];for(const sign of[-1,1]){let at=v;for(let step=0;step<32;step++){at=next(at,sign);if(Math.abs(at-v)>.00008)break;values.push(at);}}return values;};
      // At kilometre X coordinates one X ULP can exceed the construction
      // allowance while several Z ULPs fit. Search that representable grid,
      // retaining exactly the same eighty-micrometre distance bound.
      for(const X of lattice(x))for(const Z of lattice(z))if(Math.hypot(X-x,Z-z)<=.00008)neighbours.push([X,Z]);
      for(const p of neighbours.sort((a,c)=>Math.hypot(a[0]-x,a[1]-z)-Math.hypot(c[0]-x,c[1]-z)))if(Math.hypot(p[0]-x,p[1]-z)<=.00008&&inside(p)){point=p;break;}
      if(!point)for(const u of [0,1e-8,1e-7,1e-6,1e-5,1e-4,.001,.01]){const p:TramPoint=[Math.fround(mix(edge[0]!,centre[0]!,u)),Math.fround(mix(edge[1]!,centre[1]!,u))];if(Math.hypot(p[0]-x,p[1]-z)>.00008)continue;if(weights(...p).every(v=>v>=-1e-10)){point=p;break;}}
      assert.ok(point,`No representable rail cap inside its paired floor union within80micrometres: ${JSON.stringify({x,z,triangle,source:binding.ground.id})}`);const distance=Math.hypot(point[0]-x,point[1]-z);vertices++;maximumTrimMetres=Math.max(maximumTrimMetres,distance);mesh.positions[index]=point[0];mesh.positions[index+2]=point[1];const p=weights(...point);mesh.positions[index+1]=Math.fround(p.reduce((n,v,i)=>n+v*triangle[i]![1],0)+.003);
    }
  }
  assert.equal(at,mesh.indices.length/3);return{vertices,maximumTrimMetres};
}
