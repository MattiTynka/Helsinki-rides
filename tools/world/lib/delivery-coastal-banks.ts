// Close only actual new-strip shoreline cuts; no horizontal land is generated.
import assert from 'node:assert/strict';
import {qualifyCoastalShoreSeals,type ShoreAuthoritySegment,type ShoreMesh} from './coastal-shore-seals.ts';
import {meshVerticalSeals} from './vertical-seal-mesh.ts';
import type {LocalPolygon} from './geometry.ts';
import type {Finish,GroundPiece} from './ground.ts';
import {canonicalDeliveryShore} from './delivery-coastal-topology.ts';

export function clipDeliveryShore(s:ShoreAuthoritySegment,r:readonly[number,number,number,number]){
  let lo=0,hi=1;for(const[a,d,min,max]of[[s.a[0],s.b[0]-s.a[0],r[0],r[2]],[s.a[1],s.b[1]-s.a[1],r[1],r[3]]]){
    if(Math.abs(d!)<1e-12){if(a!<min!||a!>max!)return null;continue;}let u=(min!-a!)/d!,v=(max!-a!)/d!;if(u>v)[u,v]=[v,u];lo=Math.max(lo,u);hi=Math.min(hi,v);if(hi<=lo)return null;
  }
  if(Math.hypot(s.b[0]-s.a[0],s.b[1]-s.a[1])*(hi-lo)<.001)return null;
  const at=(t:number):[number,number]=>t===0?s.a:t===1?s.b:[s.a[0]+(s.b[0]-s.a[0])*t,s.a[1]+(s.b[1]-s.a[1])*t];
  return{...s,a:at(lo),b:at(hi),sourceSegment:s.id,sourceInterval:[lo,hi]as const};
}

export function deliveryBankPieces(meshes:readonly ShoreMesh[],authority:readonly ShoreAuthoritySegment[],waterY:number,collisionKeys:ReadonlySet<string>){
  const key=(P:readonly number[][])=>P.map(p=>p.map(Math.fround).join(',')).sort().join('|');
  const qualified=qualifyCoastalShoreSeals(meshes,authority,[],waterY),pieces:GroundPiece[]=[],unsupported:any[]=[];
  for(const seal of qualified.seals){
    const mesh=meshes.find(m=>m.primitiveName===seal.primitiveName&&m.primitiveIndex===seal.primitiveIndex)!;
    const finish=/(asphalt|setts|cobble|slabs|gravel|grass|yard)$/.exec(mesh.primitiveName)?.[1]as Finish|undefined;assert.ok(finish);
    if(!seal.source.visualTriangles.every(t=>collisionKeys.has(key([0,1,2].map(k=>Array.from(mesh.positions.subarray(mesh.indices[t*3+k]!*3,mesh.indices[t*3+k]!*3+3))))))){unsupported.push(seal);continue;}
    const L=Math.hypot(seal.top[1][0]-seal.top[0][0],seal.top[1][2]-seal.top[0][2]);
    const face=meshVerticalSeals([{top:seal.top,bottom:seal.bottom,polygon:[[seal.top[0],seal.top[1],seal.bottom[1],seal.bottom[0]]],section:[[[0,seal.top[0][1]],[L,seal.top[1][1]],[L,seal.bottom[1][1]],[0,seal.bottom[0][1]]]]}]);
    assert.equal(face.stats.maximumNormalY,0);if(!face.indices.length)continue;
    // Vertical-seal triangulation deliberately retains opposite winding faces.
    pieces.push({cell:seal.cell,finish,level:'raised',tag:'native-coastal-cut-bank',positions:face.positions,uvs:face.uvs,indices:face.indices});
  }
  return{pieces,qualified,unsupported};
}

export function deliveryCoastalAuthorityPlan(water:readonly LocalPolygon[],area:{minX:number;maxX:number;minZ:number;maxZ:number},region:readonly[number,number,number,number]){
  assert.ok(region[0]<region[2]&&region[1]<region[3]&&region[3]<=-1152,'Only the new northern strip is eligible');
  const plan=canonicalDeliveryShore(water,area);return{segments:plan.segments.flatMap(s=>{const clipped=clipDeliveryShore(s,region);return clipped?[clipped]:[];}),topology:plan.topology};
}
export function deliveryCoastalAuthority(water:readonly LocalPolygon[],area:{minX:number;maxX:number;minZ:number;maxZ:number},region:readonly[number,number,number,number]){return deliveryCoastalAuthorityPlan(water,area,region).segments;}
