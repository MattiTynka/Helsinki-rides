import assert from 'node:assert/strict';
import {retainOutsideBridge} from './bridge-ground-replacement.ts';
import {layeredLocal,layeredRectangle,layeredTriangleHash,type LayeredLowerFieldSpec} from './layered-bridge-field.ts';
import type {FrontierMesh} from './frontier-ground.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';
import {supportNormal,type SupportTriangle,type SupportVertex,type TramSupportPatch} from './tram-support-repair.ts';

interface Vertex {attributes:Record<string,number[]>}
function clip(ring:Vertex[],value:(v:Vertex)=>number):Vertex[]{const out:Vertex[]=[];for(let i=0;i<ring.length;i++){const a=ring[i]!,b=ring[(i+1)%ring.length]!,u=value(a),v=value(b);if(u>=-1e-12)out.push(a);if((u>=0)!==(v>=0)){const t=u/(u-v);out.push({attributes:Object.fromEntries(Object.keys(a.attributes).map(k=>[k,a.attributes[k]!.map((n,j)=>n+(b.attributes[k]![j]!-n)*t)]))});}}return out;}
const pos=(v:Vertex)=>v.attributes.POSITION!;
function cleanMask(footprint:[number,number][]){let p=footprint.filter((v,i)=>{const a=footprint[(i+footprint.length-1)%footprint.length]!;return Math.hypot(v[0]-a[0],v[1]-a[1])>1e-9;});let changed=true;while(changed&&p.length>3){changed=false;for(let i=0;i<p.length;i++){const a=p[(i+p.length-1)%p.length]!,b=p[i]!,c=p[(i+1)%p.length]!;if(Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))<1e-10){p.splice(i,1);changed=true;break;}}}return p;}
export function layeredMaskPatches(spec:LayeredLowerFieldSpec,masks:readonly [number,number][][]):TramSupportPatch[]{const[s0,t0,s1,t1]=spec.boundsST,result:TramSupportPatch[]=[];for(const [i,mask]of masks.entries()){let ring:Vertex[]=mask.map(([x,z])=>({attributes:{POSITION:[x,0,z]}}));for(const[axis,edge,sign]of[[0,s0,1],[0,s1,-1],[1,t0,1],[1,t1,-1]])ring=clip(ring,v=>(layeredLocal(spec,pos(v))[axis!]!-edge!)*sign!);const footprint=cleanMask(ring.map(v=>[pos(v)[0]!,pos(v)[2]!]));if(footprint.length<3)continue;result.push({id:`exact-lower-mask-${i}`,cell:'c_p00_p00',footprint,boundsXZ:[Math.min(...footprint.map(p=>p[0])),Math.min(...footprint.map(p=>p[1])),Math.max(...footprint.map(p=>p[0])),Math.max(...footprint.map(p=>p[1]))],triangles:[],sourceNode:'qualified-lower-source',sourcePrimitive:0,observations:[]});}return result;}
/** Upper-only fragments have separate named-source masks. Restrict them to the
 * actual reconstructed span and footprint; no lower or architectural surface
 * gains deletion authority merely by sharing its height or projected column. */
export function layeredUpperMaskPatches(spec:LayeredLowerFieldSpec,masks:readonly [number,number][][],zones:readonly TramSupportPatch[]):TramSupportPatch[]{
 const span={...spec,boundsST:[0,spec.boundsST[1],31,spec.boundsST[3]] as [number,number,number,number]},result:TramSupportPatch[]=[];
 for(const mask of layeredMaskPatches(span,masks))for(const zone of zones){if(mask.boundsXZ[0]>zone.boundsXZ[2]||mask.boundsXZ[2]<zone.boundsXZ[0]||mask.boundsXZ[1]>zone.boundsXZ[3]||mask.boundsXZ[3]<zone.boundsXZ[1])continue;const p=zone.footprint!;let r:Vertex[]=mask.footprint!.map(([x,z])=>({attributes:{POSITION:[x,0,z]}}));const sign=Math.sign((p[1]![0]-p[0]![0])*(p[2]![1]-p[0]![1])-(p[1]![1]-p[0]![1])*(p[2]![0]-p[0]![0]));for(let i=0;i<p.length;i++){const a=p[i]!,b=p[(i+1)%p.length]!;r=clip(r,v=>((b[0]-a[0])*(pos(v)[2]!-a[1])-(b[1]-a[1])*(pos(v)[0]!-a[0]))*sign);}const footprint=cleanMask(r.map(v=>[pos(v)[0]!,pos(v)[2]!]));if(footprint.length<3)continue;result.push({...mask,id:`exact-upper-mask-${result.length}`,footprint,boundsXZ:[Math.min(...footprint.map(p=>p[0])),Math.min(...footprint.map(p=>p[1])),Math.max(...footprint.map(p=>p[0])),Math.max(...footprint.map(p=>p[1]))]});}return result;
}
/** Per-triangle source masks keep distant coarse ground outside the qualified
 * lower intersection literal; one global projected rectangle is insufficient. */
export function retainLayeredSourceFragments(mesh:FrontierMesh,patches:ReadonlyMap<number,readonly TramSupportPatch[]>){const extras:Record<string,number[]>=Object.fromEntries(Object.keys(mesh.attributes).map(k=>[k,[]])),indices:number[]=[],sourceTriangles:number[]=[],removed:number[]=[],clipped:number[]=[];
 for(let t=0;t<mesh.indices.length/3;t++){const ids=Array.from(mesh.indices.subarray(t*3,t*3+3)),zones=patches.get(t);if(!zones?.length){indices.push(...ids);sourceTriangles.push(t);continue;}const attributes=Object.fromEntries(Object.entries(mesh.attributes).map(([k,a])=>{const C=a.constructor as new(v:Iterable<number>)=>GroundAttributeArray;return[k,new C(ids.flatMap(id=>Array.from(a.subarray(id*mesh.components[k]!,(id+1)*mesh.components[k]!))))];})),mini:FrontierMesh={...mesh,attributes,indices:Uint32Array.from([0,1,2])},kept=retainOutsideBridge(mini,zones);if(!kept.proof.removedSourceTriangles.length){indices.push(...ids);sourceTriangles.push(t);continue;}removed.push(t);if(kept.mesh.indices.length)clipped.push(t);for(let i=0;i<kept.mesh.indices.length/3;i++){for(const id of kept.mesh.indices.subarray(i*3,i*3+3)){indices.push(mesh.attributes.POSITION!.length/3+extras.POSITION!.length/3);for(const semantic of Object.keys(extras))extras[semantic]!.push(...kept.mesh.attributes[semantic]!.subarray(id*mesh.components[semantic]!,(id+1)*mesh.components[semantic]!));}sourceTriangles.push(t);}}
 const attributes=Object.fromEntries(Object.entries(mesh.attributes).map(([k,a])=>{const C=a.constructor as new(v:Iterable<number>)=>GroundAttributeArray;return[k,new C([...a,...extras[k]!])];}));return{mesh:{...mesh,attributes,indices:Uint32Array.from(indices)},sourceTriangles,proof:{removedSourceTriangles:removed,clippedSourceTriangles:clipped,retainedTriangles:indices.length/3}};
}
/** Source triangle identities, not heights or material names, grant mutation.
 * Every unselected source triangle retains its literal original index triple. */
export function lowerLayeredMesh(mesh:FrontierMesh,spec:LayeredLowerFieldSpec,selected:ReadonlyMap<number,string>,map:(p:SupportVertex,sourceTriangle:number)=>SupportVertex,sourceMasks:ReadonlyMap<number,[number,number][][]>=new Map(),reconstructedCapIds:ReadonlySet<number>=new Set()){
  assert.ok(mesh.attributes.POSITION instanceof Float32Array,'Layered repair requires baked Float32 positions');
  const triangle=(i:number)=>[0,1,2].map(k=>Array.from(mesh.attributes.POSITION!.subarray(mesh.indices[i*3+k]!*3,mesh.indices[i*3+k]!*3+3))) as SupportTriangle;
  for(const [i,hash]of selected){assert.ok(Number.isInteger(i)&&i>=0&&i<mesh.indices.length/3);assert.equal(layeredTriangleHash(triangle(i)),hash,'Qualified lower triangle drift');}
  const polygon=layeredRectangle(spec),patch:TramSupportPatch={id:'layered-lower-field',cell:'c_p00_p00',boundsXZ:[Math.min(...polygon.map(p=>p[0])),Math.min(...polygon.map(p=>p[1])),Math.max(...polygon.map(p=>p[0])),Math.max(...polygon.map(p=>p[1]))],footprint:polygon,triangles:[],sourceNode:'qualified-ground',sourcePrimitive:0,observations:[]};
  const prepared:{source:number;faces:{vertices:Vertex[];changed:boolean}[];changed:boolean;masks?:TramSupportPatch[]}[]=[],[s0,t0,s1,t1]=spec.boundsST;
  let emitted=0,changed=0,maxLowering=0;
  const cellClip=(r:Vertex[],sMin:number,tMin:number,sMax:number,tMax:number)=>{const local=(v:Vertex)=>layeredLocal(spec,pos(v));r=clip(r,v=>local(v)[0]-sMin);r=clip(r,v=>sMax-local(v)[0]);r=clip(r,v=>local(v)[1]-tMin);return clip(r,v=>tMax-local(v)[1]);};
  for(const i of selected.keys()){
    const ids=Array.from(mesh.indices.subarray(i*3,i*3+3)),start=ids.map((id,index)=>({index,key:Array.from(mesh.attributes.POSITION!.subarray(id*3,id*3+3)).join(',')})).sort((a,b)=>a.key.localeCompare(b.key))[0]!.index,ring=ids.map((_,k)=>ids[(start+k)%3]!).map(id=>({attributes:Object.fromEntries(Object.entries(mesh.attributes).map(([k,a])=>[k,Array.from(a.subarray(id*mesh.components[k]!,(id+1)*mesh.components[k]!))]))}));
    const sourceParts=sourceMasks.get(i)?.map(mask=>{let r=ring;const[a,b,c]=mask,sign=Math.sign((b![0]-a![0])*(c![1]-a![1])-(b![1]-a![1])*(c![0]-a![0]));for(let j=0;j<mask.length;j++){const a=mask[j]!,b=mask[(j+1)%mask.length]!;r=clip(r,v=>((b[0]-a[0])*(pos(v)[2]!-a[1])-(b[1]-a[1])*(pos(v)[0]!-a[0]))*sign);}return r;})??[ring],parts=sourceParts.map(r=>cellClip(r,s0,t0,s1,t1)).filter(p=>p.length>=3),record={source:i,faces:[] as {vertices:Vertex[];changed:boolean}[],changed:false,masks:sourceMasks.has(i)?parts.map((r,k)=>{const footprint=cleanMask(r.map(v=>[pos(v)[0]!,pos(v)[2]!] as [number,number]));return{...patch,id:`exact-source-mask-${i}-${k}`,footprint,boundsXZ:[Math.min(...footprint.map(p=>p[0])),Math.min(...footprint.map(p=>p[1])),Math.max(...footprint.map(p=>p[0])),Math.max(...footprint.map(p=>p[1]))] as [number,number,number,number]};}):undefined};if(!parts.length)continue;
    for(const part of parts){
    const st=part.map(v=>layeredLocal(spec,pos(v))),grid=spec.gridMetres;
    for(let si=Math.floor(Math.min(...st.map(p=>p[0]))/grid);si<=Math.floor(Math.max(...st.map(p=>p[0]))/grid);si++)for(let ti=Math.floor(Math.min(...st.map(p=>p[1]))/grid);ti<=Math.floor(Math.max(...st.map(p=>p[1]))/grid);ti++){
      const cell=cellClip(part,Math.max(s0,si*grid),Math.max(t0,ti*grid),Math.min(s1,(si+1)*grid),Math.min(t1,(ti+1)*grid));if(cell.length<3)continue;
      for(let j=1;j<cell.length-1;j++){
        const old=[cell[0]!,cell[j]!,cell[j+1]!],points=old.map(v=>map(pos(v).map(Math.fround) as SupportVertex,i)) as SupportTriangle;let n:SupportVertex;try{n=supportNormal(points);}catch{continue;}
        // Mapping keeps XZ and source winding. It cannot turn a legitimate
        // upward floor into an inverted surface or raise an existing floor.
        const was=old.map(v=>pos(v).map(Math.fround)) as SupportTriangle;for(let k=0;k<3;k++){assert.equal(points[k]![0],was[k]![0]);assert.equal(points[k]![2],was[k]![2]);assert.ok(points[k]![1]<=was[k]![1]+1e-6||reconstructedCapIds.has(i),'Only an exact source-qualified wall cap may rise to its existing repaired floor bank');maxLowering=Math.max(maxLowering,was[k]![1]-points[k]![1]);}
        const mapped:Vertex[]=[];
        for(let k=0;k<3;k++){const attributes:Record<string,number[]>={};for(const semantic of Object.keys(mesh.attributes)){
          let values=old[k]!.attributes[semantic]!;
          if(semantic==='POSITION')values=points[k]!;
          if(semantic==='NORMAL'){const a=mesh.attributes.NORMAL!,scale=mesh.normalized.NORMAL?(a instanceof Int8Array?127:a instanceof Int16Array?32767:0):1;assert.ok(scale);values=n.map(v=>scale===1?v:Math.round(v*scale));}
          attributes[semantic]=values;
        }mapped.push({attributes});}
        const faceChanged=points.some((p,k)=>p[1]!==was[k]![1]);record.faces.push({vertices:mapped,changed:faceChanged});if(faceChanged)record.changed=true;
      }
    }}prepared.push(record);
  }
  const changedIds=new Set(prepared.filter(r=>r.changed&&!r.masks).map(r=>r.source)),maskedIds=new Set(prepared.filter(r=>r.changed&&r.masks).map(r=>r.source)),outside=retainOutsideBridge(mesh,[patch],i=>changedIds.has(i));
  const arrays:Record<string,number[]>=Object.fromEntries(Object.entries(outside.mesh.attributes).map(([k,a])=>[k,Array.from(a)])),indices:number[]=[],sourceTriangles:number[]=[];
  for(let t=0;t<outside.sourceTriangles.length;t++)if(!maskedIds.has(outside.sourceTriangles[t]!)){indices.push(...outside.mesh.indices.subarray(t*3,t*3+3));sourceTriangles.push(outside.sourceTriangles[t]!);}
  for(const record of prepared)if(record.changed&&record.masks){const ids=Array.from(mesh.indices.subarray(record.source*3,record.source*3+3)),attributes=Object.fromEntries(Object.entries(mesh.attributes).map(([k,a])=>{const C=a.constructor as new(v:Iterable<number>)=>GroundAttributeArray;return[k,new C(ids.flatMap(id=>Array.from(a.subarray(id*mesh.components[k]!,(id+1)*mesh.components[k]!))))];})),mini:FrontierMesh={...mesh,attributes,indices:Uint32Array.from([0,1,2])},kept=retainOutsideBridge(mini,record.masks);
    for(let t=0;t<kept.mesh.indices.length/3;t++){for(const id of kept.mesh.indices.subarray(t*3,t*3+3)){indices.push(arrays.POSITION!.length/3);for(const semantic of Object.keys(arrays))arrays[semantic]!.push(...kept.mesh.attributes[semantic]!.subarray(id*mesh.components[semantic]!,(id+1)*mesh.components[semantic]!));}sourceTriangles.push(record.source);}
  }
  for(const record of prepared)if(record.changed)for(const face of record.faces){const base=arrays.POSITION!.length/3;for(const v of face.vertices)for(const semantic of Object.keys(arrays))arrays[semantic]!.push(...v.attributes[semantic]!);indices.push(base,base+1,base+2);sourceTriangles.push(record.source);emitted++;if(face.changed)changed++;}
  const attributes=Object.fromEntries(Object.entries(arrays).map(([k,a])=>{const original=mesh.attributes[k]!,Constructor=original.constructor as new(values:Iterable<number>)=>GroundAttributeArray;return[k,new Constructor(a)];}));
  const result:FrontierMesh={attributes,components:mesh.components,normalized:mesh.normalized,indices:Uint32Array.from(indices)};
  for(const [k,a]of Object.entries(mesh.attributes))assert.deepEqual(result.attributes[k]!.subarray(0,a.length),a,'Original source attribute prefix changed');
  assert.equal(sourceTriangles.length,result.indices.length/3);
  return{mesh:result,sourceTriangles,proof:{qualifiedSourceTriangles:selected.size,originalTriangles:mesh.indices.length/3,emittedLowerTriangles:emitted,changedLowerTriangles:changed,maximumLowering:maxLowering,outside:outside.proof,originalAttributePrefixes:true,selection:'Exact source triangle index and ordered Float32 position hash'}};
}
