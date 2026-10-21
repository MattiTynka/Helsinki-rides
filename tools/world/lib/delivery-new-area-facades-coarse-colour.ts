// A separately qualified colour repair for an explicitly enumerated simplified
// wall. It never supplies image UVs or guesses an image-to-mesh correspondence.
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {MeshoptDecoder,MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';
import {decodeDeliveryCityGlb,deliverySha} from './delivery-city-payloads.ts';
import {packGlb} from './shared-textures.ts';
import {classifyFacadeTriangle} from './delivery-new-area-facades.ts';
import {facadeTriangleKey,proveFacadeCoverage,projectFacadePoint,type FacadeTriangle,type FacadePoint,type FacadeChart} from './facade-charts.ts';

export interface CoarseColourFace {node:string;primitive:number;triangle:number;key:string;points:FacadeTriangle;colours:readonly(readonly[number,number,number])[]}
const vertexKey=(p:readonly number[])=>{const b=Buffer.alloc(12);p.forEach((v,i)=>b.writeFloatLE(v,i*4));return b.toString('hex');};
function coarseColourQualificationGeometry(target:FacadeTriangle,authority:readonly FacadeTriangle[],frame:{origin:readonly[number,number];axis:readonly[number,number]}) {
  assert.ok(authority.length>0);const vertices=new Set(authority.flatMap(t=>t.map(vertexKey))),normal=classifyFacadeTriangle(target).normal;
  assert.equal(classifyFacadeTriangle(target).kind,'wall');
  for(const p of target)assert.ok(vertices.has(vertexKey(p)),'Coarse colour vertex is not an exact selected native wall vertex');
  for(const face of authority){const n=classifyFacadeTriangle(face).normal;assert.ok(n.reduce((s,v,i)=>s+v*normal[i]!,0)>.999,'Coarse colour target belongs to another plane or winding');}
  const project=(p:FacadePoint):FacadePoint=>[(p[0]-frame.origin[0])*frame.axis[0]+(p[2]-frame.origin[1])*frame.axis[1],p[1],0];
  const a=authority.map(t=>t.map(project)as unknown as FacadeTriangle),t=target.map(project)as unknown as FacadeTriangle,points=a.flat(),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const chart:FacadeChart={id:'exact-enumerated-coarse-wall-colour-qualification',building:'selected-building',origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,1,0],bounds:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],pixels:[1,1,100,100],planeToleranceMetres:0};
  for(const point of t)projectFacadePoint(point,chart);return{target:t,authority:a,chart};
}
export function qualifyCoarseColourFace(target:FacadeTriangle,authority:readonly FacadeTriangle[],frame:{origin:readonly[number,number];axis:readonly[number,number]}){const q=coarseColourQualificationGeometry(target,authority,frame);return{...proveFacadeCoverage(q.target,q.authority,q.chart),nativeExactVertices:true,projectionForColourQualificationOnly:true};}
/** This exception describes one recorded municipal simplification chord. It is
 * bound to the exact 3 detailed triangles, 2 coarse triangles and difference
 * polygon. There is no generic area tolerance and no image/UV correspondence. */
export function qualifyBulevardi11CoarseColourFace(target:FacadeTriangle,authority:readonly{triangle:number;key:string;points:FacadeTriangle}[],frame:{origin:readonly[number,number];axis:readonly[number,number]}){
 assert.equal(deliverySha(Buffer.from(JSON.stringify(authority))),'a3e1c2730422f4dce3dddc345ed809c458654146a2534ac7186f846a78746b11');
 const allowed:Record<string,{difference:string;maximumArea:number}>={
 '5bb2cf3492f82e5f848e1dc1ce6f049a5aaf7ff00120133750e9456c73963967':{difference:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',maximumArea:0},
 'de2142fbc3fddd4976b30d9ea6a5f1347d71b39dbbfd8ef797880f217f3179a1':{difference:'7a9e2a25b51c9db61f1aadb5978addd6b6702b0d05b53a0d30a4a8f84732fa64',maximumArea:.000601537}
 };const accepted=allowed[deliverySha(Buffer.from(JSON.stringify(target)))];assert.ok(accepted,'Unqualified B11 simplified colour target');const q=coarseColourQualificationGeometry(target,authority.map(f=>f.points),frame),polygon=(t:FacadeTriangle):polygonClipping.Polygon=>{const points=t.map(p=>[p[0],p[1]]as[number,number]);return[[...points,points[0]!]];},source=polygonClipping.union(polygon(q.authority[0]!),...q.authority.slice(1).map(polygon)),difference=polygonClipping.difference(polygon(q.target),source);
 assert.equal(deliverySha(Buffer.from(JSON.stringify(difference))),accepted.difference,'Pinned simplification difference changed');let area=0;for(const p of difference)for(const[hole,ring]of p.entries()){let value=0;for(let i=0;i+1<ring.length;i++)value+=ring[i]![0]*ring[i+1]![1]-ring[i+1]![0]*ring[i]![1];area+=(hole?-1:1)*Math.abs(value)/2;for(const point of ring)assert.ok(point[0]>=2.46929&&point[0]<=3.14268&&point[1]>=31.64501&&point[1]<=31.88571,'Difference leaves the qualified upper plaster role');}
 assert.ok(area<=accepted.maximumArea);return{nativeExactVertices:true,sourceTopologySha256:'a3e1c2730422f4dce3dddc345ed809c458654146a2534ac7186f846a78746b11',projectionForColourQualificationOnly:true,difference,differenceSha256:accepted.difference,outsideAreaMetres2:area,maximumExplicitDifferenceAreaMetres2:accepted.maximumArea,upperPlasterRoleOnly:true,fullImageOrPhysicalIdentityClaimed:false};
}

export async function patchCoarseWallColours(bytes:Uint8Array,args:{expected:string;targets:readonly CoarseColourFace[]}) {
  assert.equal(deliverySha(bytes),args.expected);assert.ok(args.targets.length);assert.equal(new Set(args.targets.map(t=>t.key)).size,args.targets.length);
  const original=readFacadeGlb(bytes),json=structuredClone(original.json)as any,doc=await decodeDeliveryCityGlb(bytes),updates=new Map<number,Map<number,readonly[number,number,number]>>(),found=new Set<string>();
  for(const target of args.targets){assert.equal(facadeTriangleKey(target.points),target.key);assert.equal(target.colours.length,3);assert.ok(target.colours.flat().every(v=>Number.isFinite(v)&&v>=0&&v<=1));}
  for(const node of doc.getRoot().listNodes())for(const[pi,p]of(node.getMesh()?.listPrimitives()??[]).entries()){
    const targets=args.targets.filter(t=>t.node===node.getName()&&t.primitive===pi);if(!targets.length)continue;
    assert.ok(!/_ground|_kerb|_tram|_stair/.test(node.getName()));assert.deepEqual(node.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    assert.ok(!p.getMaterial()?.getBaseColorTexture());const I=p.getIndices()!,P=p.getAttribute('POSITION')!,C=p.getAttribute('COLOR_0')!;assert.ok(I&&P&&C&&C.getElementSize()===3);
    const selected=new Set(targets.map(t=>t.triangle)),ids=new Set<number>();for(const target of targets){assert.ok(target.triangle>=0&&target.triangle*3+2<I.getCount());const vertices=[0,1,2].map(k=>I.getScalar(target.triangle*3+k)),points=vertices.map(i=>P.getElement(i,[]))as unknown as FacadeTriangle;assert.deepEqual(points,target.points,'Fresh exact coarse geometry differs');assert.equal(facadeTriangleKey(points),target.key);assert.ok(!found.has(target.key));found.add(target.key);vertices.forEach(id=>ids.add(id));}
    // Recolouring a shared index would modify an adjacent wall. Fail rather than
    // split or reindex geometry: those are outside this narrow colour contract.
    for(let t=0;t<I.getCount()/3;t++)if(!selected.has(t))for(let k=0;k<3;k++)assert.ok(!ids.has(I.getScalar(t*3+k)),'Coarse colour vertex is shared with an unselected face');
    const rawNode=json.nodes.find((n:any)=>n.name===node.getName());assert.ok(rawNode);const accessorId=json.meshes[rawNode.mesh].primitives[pi].attributes.COLOR_0,accessor=json.accessors[accessorId],view=json.bufferViews[accessor.bufferView];assert.equal(accessor.type,'VEC3');assert.ok([5126,5121,5123].includes(accessor.componentType));assert.equal(Boolean(accessor.normalized),accessor.componentType!==5126);assert.equal(accessor.byteOffset??0,0);assert.ok(view.extensions?.EXT_meshopt_compression);assert.ok(view.extensions.EXT_meshopt_compression.byteStride>=(accessor.componentType===5126?12:accessor.componentType===5123?6:3));
    // No other accessor may alias this colour-only buffer view.
    assert.equal(json.accessors.filter((a:any)=>a.bufferView===accessor.bufferView).length,1);
    const values=updates.get(accessor.bufferView)??new Map<number,readonly[number,number,number]>();for(const target of targets)for(let k=0;k<3;k++){const index=I.getScalar(target.triangle*3+k),colour=target.colours[k]!;if(values.has(index))assert.deepEqual(values.get(index),colour);values.set(index,colour);}updates.set(accessor.bufferView,values);
  }
  assert.equal(found.size,args.targets.length,'Selected coarse colour face is absent');await MeshoptDecoder.ready;await MeshoptEncoder.ready;
  const chunks:Uint8Array[]=[original.bin];let offset=original.bin.length;
  for(const[id,vertices]of updates){const view=json.bufferViews[id],ext=view.extensions.EXT_meshopt_compression;assert.equal(ext.mode,'ATTRIBUTES');assert.ok(!ext.filter||ext.filter==='NONE');const decoded=new Uint8Array(ext.count*ext.byteStride);MeshoptDecoder.decodeGltfBuffer(decoded,ext.count,ext.byteStride,original.bin.subarray(ext.byteOffset,ext.byteOffset+ext.byteLength),ext.mode,ext.filter??'NONE');const accessor=json.accessors.find((a:any)=>a.bufferView===id),type=accessor.componentType,width=type===5126?4:type===5123?2:1,scale=type===5126?1:type===5123?65535:255,next=decoded.slice(),dv=new DataView(next.buffer,next.byteOffset,next.byteLength);for(const[index,colour]of vertices)for(let k=0;k<3;k++){const at=index*ext.byteStride+k*width,value=colour[k]!;if(type===5126)dv.setFloat32(at,value,true);else if(type===5123)dv.setUint16(at,Math.round(value*scale),true);else dv.setUint8(at,Math.round(value*scale));}
    for(let i=0;i<decoded.length;i++)if(!vertices.has(Math.floor(i/ext.byteStride)))assert.equal(next[i],decoded[i],'Unselected colour bytes changed');
    const encoded=MeshoptEncoder.encodeGltfBuffer(next,ext.count,ext.byteStride,'ATTRIBUTES'),padding=(4-offset%4)%4;if(padding){chunks.push(new Uint8Array(padding));offset+=padding;}ext.byteOffset=offset;ext.byteLength=encoded.length;chunks.push(encoded);offset+=encoded.length;
  }
  json.buffers[0].byteLength=offset;const result=packGlb(json,Buffer.concat(chunks));assert.deepEqual(readFacadeGlb(result).bin.subarray(0,original.bin.length),original.bin);assert.deepEqual(json.accessors,original.json.accessors);assert.deepEqual(json.meshes,original.json.meshes);assert.deepEqual(json.nodes,original.json.nodes);
  const after=await decodeDeliveryCityGlb(result);for(const n of doc.getRoot().listNodes())for(const[pi,p]of(n.getMesh()?.listPrimitives()??[]).entries()){const q=after.getRoot().listNodes().find(v=>v.getName()===n.getName())!.getMesh()!.listPrimitives()[pi]!;assert.deepEqual(q.getIndices()!.getArray(),p.getIndices()!.getArray());for(const semantic of p.listSemantics())if(semantic!=='COLOR_0')assert.deepEqual(q.getAttribute(semantic)!.getArray(),p.getAttribute(semantic)!.getArray());}
  return{bytes:result,proof:{sourceSha256:args.expected,outputSha256:deliverySha(result),faces:args.targets.map(t=>({node:t.node,primitive:t.primitive,triangle:t.triangle,key:t.key})),indicesAccessorsMeshesNodesUvPositionsLiteral:true,originalBinPrefix:true,unselectedColourBytesLiteral:true,newDraws:0}};
}
