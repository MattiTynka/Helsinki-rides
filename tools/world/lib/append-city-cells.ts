// Bounded cell extension: frozen resources remain literal prefixes; additions use fresh references.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {encodeCollisionBundle,parseCollisionBundle,parseTerrain,type CellDescriptor,type TriMeshCollider} from '../../../packages/world-schema/src/index.ts';
import type {GroundPiece} from './ground.ts';
import {readFacadeGlb} from './facade-glb.ts';
import {planCityFrontier,frontierRuntimeLoweringAllowed,type FrontierPlan} from './frontier-ground.ts';

export type AppendRectangle=readonly [number,number,number,number];
export function parseAppendRectangle(value:string):AppendRectangle {
  const parts=value.split(','),a=parts.map(Number);assert.ok(parts.every(v=>v.trim().length>0)&&a.length===4&&a.every(Number.isFinite)&&a[0]!<a[2]!&&a[1]!<a[3]!,'region must be finite minX,minZ,maxX,maxZ with positive area');return a as unknown as AppendRectangle;
}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const align4=(n:number)=>(n+3)&~3;
function safe(root:string,relative:string){const file=path.resolve(root,relative),local=path.relative(path.resolve(root),file);assert.ok(local&&!path.isAbsolute(local)&&local!=='..'&&!local.startsWith(`..${path.sep}`),'payload path escapes source');return file;}
type Vertex=number[];
function halfPlane(polygon:Vertex[],distance:(v:Vertex)=>number,positive=true):Vertex[]{
  const next:Vertex[]=[];
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!,da=distance(a)*(positive?1:-1),db=distance(b)*(positive?1:-1);
    if(da>=0)next.push(a);
    if((da>=0)!==(db>=0)){const t=da/(da-db);next.push(a.map((v,k)=>v+(b[k]!-v)*t));}
  }
  return next;
}
const polygonArea3=(a:Vertex,b:Vertex,c:Vertex)=>{const u=b.map((v,k)=>v-a[k]!),v=c.map((n,k)=>n-a[k]!);return Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!);};
const bounds=(vertices:Vertex[])=>[Math.min(...vertices.map(v=>v[0]!)),Math.min(...vertices.map(v=>v[2]!)),Math.max(...vertices.map(v=>v[0]!)),Math.max(...vertices.map(v=>v[2]!))] as const;
const overlaps=(a:readonly number[],b:readonly number[])=>a[0]!<=b[2]!&&a[2]!>=b[0]!&&a[1]!<=b[3]!&&a[3]!>=b[1]!;
type Vec3=[number,number,number];
const subtract3=(a:Vertex,b:Vertex):Vec3=>[a[0]!-b[0]!,a[1]!-b[1]!,a[2]!-b[2]!];
const cross3=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot3=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
// HCOL stores Float32 coordinates. Compare planes within their rounding uncertainty, not a world-scale
// epsilon that could erase a distinct wall. The final term covers the subsequent Float64 arithmetic.
const coordinateRoundoff=(v:number)=>Math.max(2**-150,2**(Math.floor(Math.log2(Math.abs(v)))-24))+Number.EPSILON*Math.max(1,Math.abs(v))*4;
interface WallPlane {origin:Vertex;normal:Vec3;normalRoundoff:number;coordinateRoundoff:number;along:Vec3}
function wallPlane(polygon:Vertex[]):WallPlane|null {
  const a=polygon[0]!;let best:Vec3|null=null,b:Vertex|undefined,c:Vertex|undefined,length=0;
  // Rectangle clipping can leave collinear vertices at the beginning of the polygon.
  for(let i=1;i+1<polygon.length;i++){const n=cross3(subtract3(polygon[i]!,a),subtract3(polygon[i+1]!,a)),size=Math.hypot(...n);if(size>length){best=n;b=polygon[i]!;c=polygon[i+1]!;length=size;}}
  if(!best||!b||!c||length<1e-10)return null;
  const normal=best.map(v=>v/length) as Vec3;if(Math.abs(normal[1])>=1e-4)return null;
  let normalRoundoff:number;
  if(Math.abs(normal[1])<1e-12){
    // The two endpoints of an authored vertical extrusion share XZ for every height. Treating those
    // repeated values as independently rounded would make a short curb or tapered wall top appear to
    // have an unreliable plane. Its direction is established by its longest horizontal baseline.
    if(polygon.every(p=>p[0]===a[0])||polygon.every(p=>p[2]===a[2]))normalRoundoff=Number.EPSILON*16;
    else{let horizontalLength=0,p=a,q=a;for(let i=0;i<polygon.length;i++)for(let j=i+1;j<polygon.length;j++){const x=polygon[i]!,y=polygon[j]!,distance=Math.hypot(x[0]!-y[0]!,x[2]!-y[2]!);if(distance>horizontalLength){horizontalLength=distance;p=x;q=y;}}
      const endpointError=Math.hypot(coordinateRoundoff(p[0]!)+coordinateRoundoff(q[0]!),coordinateRoundoff(p[2]!)+coordinateRoundoff(q[2]!));normalRoundoff=2*endpointError/(horizontalLength-endpointError);
    }
  }else{
    const u=subtract3(b,a),v=subtract3(c,a),du=a.slice(0,3).map((x,k)=>coordinateRoundoff(x)+coordinateRoundoff(b![k]!)),dv=a.slice(0,3).map((x,k)=>coordinateRoundoff(x)+coordinateRoundoff(c![k]!));
    const productError=(i:number,j:number)=>Math.abs(u[i]!)*dv[j]!+Math.abs(v[j]!)*du[i]!+du[i]!*dv[j]!;
    const crossError=Math.hypot(productError(1,2)+productError(2,1),productError(2,0)+productError(0,2),productError(0,1)+productError(1,0));normalRoundoff=2*crossError/(length-crossError);
  }
  // A face narrower than its own coordinate precision cannot establish a matching plane.
  if(!Number.isFinite(normalRoundoff)||normalRoundoff<0||normalRoundoff>=1)return null;
  const horizontal=Math.hypot(normal[0],normal[2]);
  return{origin:a,normal,normalRoundoff,coordinateRoundoff:Math.max(...polygon.flatMap(p=>p.slice(0,3).map(coordinateRoundoff))),along:[normal[2]/horizontal,0,-normal[0]/horizontal]};
}
function sameWallPlane(a:WallPlane,aVertices:Vertex[],b:WallPlane,bVertices:Vertex[]){
  // The fixed angular guard is only a rejection limit. Acceptance still requires the tighter derived
  // Float32 direction uncertainty and mutual vertex-to-plane distances below their rounding bounds.
  if(Math.hypot(...cross3(a.normal,b.normal))>Math.min(.00045,a.normalRoundoff+b.normalRoundoff+Number.EPSILON*16))return false;
  const onPlane=(plane:WallPlane,vertices:Vertex[])=>vertices.every(p=>{
    const delta=subtract3(p,plane.origin),distance=Math.abs(dot3(delta,plane.normal));
    const uncertainty=plane.normal.reduce((sum,n,k)=>sum+Math.abs(n)*(coordinateRoundoff(p[k]!)+coordinateRoundoff(plane.origin[k]!)),0)+plane.normalRoundoff*Math.hypot(...delta);
    return distance<=uncertainty;
  });
  return onPlane(a,bVertices)&&onPlane(b,aVertices);
}
const expandedBounds=(polygon:Vertex[],epsilon:number)=>{const b=bounds(polygon);return[b[0]-epsilon,b[1]-epsilon,b[2]+epsilon,b[3]+epsilon] as const;};

/** Accepted floors own their XZ coverage. Accepted near-vertical faces own only the coplanar area of their
 *  actual 3D wall plane, so an old retaining wall cannot erase new wall heights or a lower path behind it. */
export class AcceptedGroundCoverage {
  readonly triangles:Vertex[][]=[];
  readonly verticalTriangles:Vertex[][]=[];
  private readonly buckets=new Map<string,number[]>();
  private readonly verticalBuckets=new Map<string,number[]>();
  private readonly verticalPlanes:WallPlane[]=[];
  constructor(triangles:readonly (readonly (readonly number[])[])[]){
    for(const raw of triangles){let p=raw.map(v=>[...v]);assert.equal(p.length,3);
      const plane=wallPlane(p);if(plane){const id=this.verticalTriangles.length;this.verticalTriangles.push(p);this.verticalPlanes.push(plane);for(const key of this.keys(expandedBounds(p,plane.coordinateRoundoff*2))){const list=this.verticalBuckets.get(key)??[];list.push(id);this.verticalBuckets.set(key,list);}continue;}
      const area=(p[1]![0]!-p[0]![0]!)*(p[2]![2]!-p[0]![2]!)-(p[1]![2]!-p[0]![2]!)*(p[2]![0]!-p[0]![0]!);if(Math.abs(area)<1e-8)continue;if(area<0)p=[p[0]!,p[2]!,p[1]!];const id=this.triangles.length;this.triangles.push(p);for(const key of this.keys(bounds(p))){const list=this.buckets.get(key)??[];list.push(id);this.buckets.set(key,list);}}
  }
  private *keys(b:readonly number[]){for(let z=Math.floor(b[1]!/8);z<=Math.floor(b[3]!/8);z++)for(let x=Math.floor(b[0]!/8);x<=Math.floor(b[2]!/8);x++)yield `${x},${z}`;}
  subtract(polygon:Vertex[]):Vertex[][]{
    let fragments=[polygon];const box=bounds(polygon),candidates=new Set<number>();for(const key of this.keys(box))for(const id of this.buckets.get(key)??[])candidates.add(id);
    for(const id of candidates){const mask=this.triangles[id]!;if(!overlaps(box,bounds(mask)))continue;const outside:Vertex[][]=[];
      for(let fragment of fragments){for(let e=0;e<3&&fragment.length;e++){const a=mask[e]!,b=mask[(e+1)%3]!,distance=(p:Vertex)=>(b[0]!-a[0]!)*(p[2]!-a[2]!)-(b[2]!-a[2]!)*(p[0]!-a[0]!);const rejected=halfPlane(fragment,distance,false);if(rejected.length>=3&&fragment.some(p=>distance(p)<-1e-9))outside.push(rejected);fragment=halfPlane(fragment,distance,true);}}
      fragments=outside;if(!fragments.length)break;
    }
    return this.subtractWalls(fragments,polygon);
  }
  private subtractWalls(fragments:Vertex[][],source:Vertex[]):Vertex[][] {
    if(!fragments.length)return fragments;const plane=wallPlane(source);if(!plane)return fragments;
    const box=expandedBounds(source,plane.coordinateRoundoff*2),candidates=new Set<number>();for(const key of this.keys(box))for(const id of this.verticalBuckets.get(key)??[])candidates.add(id);
    // Project onto the new face's own (horizontal along-wall, Y) plane. Intersections interpolate all
    // original XYZ/UV attributes; accepted Float32 vertices never displace the new surface off its plane.
    const project=(p:Vertex)=>[dot3(subtract3(p,plane.origin),plane.along),p[1]!-plane.origin[1]!] as const;
    for(const id of candidates){const mask=this.verticalTriangles[id]!,oldPlane=this.verticalPlanes[id]!;
      if(!overlaps(box,expandedBounds(mask,oldPlane.coordinateRoundoff*2))||!sameWallPlane(plane,source,oldPlane,mask))continue;
      const projected=mask.map(project),[a,b,c]=projected,area=(b![0]-a![0])*(c![1]-a![1])-(b![1]-a![1])*(c![0]-a![0]);if(Math.abs(area)<1e-10)continue;const sign=area>0?1:-1,outside:Vertex[][]=[];
      const distances=projected.map((a,i)=>{const b=projected[(i+1)%3]!;return(p:Vertex)=>{const q=project(p);return sign*((b[0]-a[0])*(q[1]-a[1])-(b[1]-a[1])*(q[0]-a[0]));};});
      for(let fragment of fragments)for(const distance of distances){if(!fragment.length)break;const rejected=halfPlane(fragment,distance,false);if(rejected.length>=3&&fragment.some(p=>distance(p)<-1e-9))outside.push(rejected);fragment=halfPlane(fragment,distance,true);}
      fragments=outside;if(!fragments.length)break;
    }
    return fragments;
  }
}

export function readAcceptedGroundCoverage(cellsDirectory:string,region:AppendRectangle){
  const indexBytes=fs.readFileSync(path.join(cellsDirectory,'cells.json')),index=JSON.parse(indexBytes.toString()),triangles:Vertex[][]=[];
  for(const cell of index.cells as CellDescriptor[]){if(!overlaps(cell.boundsXZ,region))continue;const bytes=fs.readFileSync(safe(cellsDirectory,cell.collision.path));assert.equal(sha(bytes),cell.collision.sha256,'accepted collision hash changed');
    for(const collider of parseCollisionBundle(bytes).colliders){if(collider.group!=='ground'&&collider.group!=='kerbs')continue;for(let i=0;i<collider.indices.length;i+=3){const p=[0,1,2].map(k=>Array.from(collider.positions.subarray(collider.indices[i+k]!*3,collider.indices[i+k]!*3+3)));if(overlaps(bounds(p),region))triangles.push(p);}}
  }
  const coverage=new AcceptedGroundCoverage(triangles);return{coverage,indexSha256:sha(indexBytes),triangles:coverage.triangles.length,verticalTriangles:coverage.verticalTriangles.length};
}

/** Clip only new authored ground, after assembly and before visual/collision serialization. Heights and UVs
 *  interpolate on the original triangle plane; source pieces remain untouched, including use/finish/cell. */
export function clipGroundToRectangle(pieces:readonly GroundPiece[],region:AppendRectangle,accepted?:AcceptedGroundCoverage):GroundPiece[] {
  parseAppendRectangle(region.join(','));
  const planes=[[0,region[0],1],[0,region[2],-1],[2,region[1],1],[2,region[3],-1]] as const;
  const inside=(v:readonly number[])=>planes.every(([axis,limit,sign])=>(v[axis]!-limit)*sign>=0);
  return pieces.flatMap(piece=>{
    assert.equal(piece.positions.length%3,0);assert.equal(piece.uvs.length,piece.positions.length/3*2);assert.equal(piece.indices.length%3,0);
    assert.ok(piece.positions.every(Number.isFinite)&&piece.uvs.every(Number.isFinite),'nonfinite ground input');
    assert.ok(piece.indices.every(i=>Number.isInteger(i)&&i>=0&&i*3<piece.positions.length),'invalid ground index');
    const vertex=(i:number)=>[...piece.positions.slice(i*3,i*3+3),...piece.uvs.slice(i*2,i*2+2)];
    if(!accepted&&piece.indices.every(i=>inside(vertex(i))))return [piece];
    const positions:number[]=[],uvs:number[]=[],indices:number[]=[];
    for(let t=0;t<piece.indices.length;t+=3){
      let polygon=[0,1,2].map(k=>vertex(piece.indices[t+k]!));
      for(const [axis,limit,sign]of planes){
        const next:number[][]=[];
        for(let i=0;i<polygon.length;i++){
          const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!,da=(a[axis]!-limit)*sign,db=(b[axis]!-limit)*sign;
          if(da>=0)next.push(a);
          if((da>=0)!==(db>=0)){const u=da/(da-db),v=a.map((x,k)=>x+(b[k]!-x)*u);v[axis]=limit;next.push(v);}
        }
        polygon=next;
      }
      for(const fragment of polygon.length?(accepted?accepted.subtract(polygon):[polygon]):[])for(let i=1;i+1<fragment.length;i++){
        const a=fragment[0]!,b=fragment[i]!,c=fragment[i+1]!;
        if(polygonArea3(a,b,c)<1e-10)continue;
        for(const p of[a,b,c]){indices.push(positions.length/3);positions.push(...p.slice(0,3));uvs.push(...p.slice(3));}
      }
    }
    return indices.length?[{...piece,positions,uvs,indices}]:[];
  });
}

/** Keep source page indices and binary spans stable. Call before building the strip, never after atlasing. */
export function filterAcceptedBuildings<T extends {buildings:readonly {id:string}[]}>(model:T,accepted:ReadonlySet<string>){
  const removed=model.buildings.filter(b=>accepted.has(b.id)).map(b=>b.id),buildings=model.buildings.filter(b=>!accepted.has(b.id));
  assert.equal(new Set(buildings.map(b=>b.id)).size,buildings.length,'duplicate new building ID');
  return {model:{...model,buildings},removed};
}

/** Rebase the appended GLB's resource references without decoding/recompressing either BIN. */
export function appendCityGlb(baseBytes:Uint8Array,extraBytes:Uint8Array):Uint8Array {
  const base=readFacadeGlb(baseBytes),extra=readFacadeGlb(extraBytes),a=structuredClone(base.json) as any,b=structuredClone(extra.json) as any;
  const supported=new Set(['EXT_meshopt_compression','KHR_mesh_quantization','KHR_texture_basisu','KHR_materials_unlit','KHR_texture_transform']);
  for(const j of[a,b]){
    for(const e of j.extensionsUsed??[])assert.ok(supported.has(e),`unsupported GLB extension ${e}`);
    assert.ok(!j.animations?.length&&!j.skins?.length&&!j.cameras?.length&&!j.extensions,'city GLB must not contain animation, skins, cameras or root extensions');
    assert.equal(j.scenes.length,1,'city GLB must have one scene');assert.ok(j.buffers.every((v:any)=>!v.uri),'external buffers unsupported');
    assert.ok((j.images??[]).every((v:any)=>!v.uri&&Number.isInteger(v.bufferView)),'images must be embedded');
  }
  const keys=['accessors','bufferViews','samplers','textures','images','materials','meshes','nodes'] as const;
  const offset=Object.fromEntries(keys.map(k=>[k,(a[k]??=[]).length])) as Record<typeof keys[number],number>;
  const physical=align4(base.bin.length),bufferOffset=a.buffers.length-1,buffer=(i:number)=>i===0?0:i+bufferOffset;
  for(const v of b.bufferViews??[]){
    if(v.buffer===0)v.byteOffset=(v.byteOffset??0)+physical;v.buffer=buffer(v.buffer);
    const c=v.extensions?.EXT_meshopt_compression;if(c){if(c.buffer===0)c.byteOffset=(c.byteOffset??0)+physical;c.buffer=buffer(c.buffer);}
  }
  for(const v of b.accessors??[]){assert.ok(!v.sparse,'sparse city accessors unsupported');if(v.bufferView!==undefined)v.bufferView+=offset.bufferViews;}
  for(const v of b.images??[])v.bufferView+=offset.bufferViews;
  for(const v of b.textures??[]){if(v.sampler!==undefined)v.sampler+=offset.samplers;if(v.source!==undefined)v.source+=offset.images;if(v.extensions?.KHR_texture_basisu)v.extensions.KHR_texture_basisu.source+=offset.images;}
  const remapTextures=(v:any)=>{if(!v||typeof v!=='object')return;for(const[k,child]of Object.entries(v)){if(k.endsWith('Texture')&&child&&typeof child==='object'&&'index'in child)(child as any).index+=offset.textures;else remapTextures(child);}};
  for(const v of b.materials??[])remapTextures(v);
  for(const m of b.meshes??[])for(const p of m.primitives){assert.ok(!p.extensions,'primitive extensions need explicit rebasing');for(const k of Object.keys(p.attributes))p.attributes[k]+=offset.accessors;if(p.indices!==undefined)p.indices+=offset.accessors;if(p.material!==undefined)p.material+=offset.materials;for(const target of p.targets??[])for(const k of Object.keys(target))target[k]+=offset.accessors;}
  const names=new Set((a.nodes??[]).map((n:any)=>n.name)),incoming=b.nodes??[],incomingNames=incoming.map((n:any)=>n.name);
  assert.equal(new Set(incomingNames).size,incomingNames.length,'Appended city node names must be unique');
  // Keep historical first-append names, including unprefixed unique nodes. Later extensions reserve a
  // fresh namespace for the whole collision set, also avoiding literal prefixed names in the input.
  let namespace='append:';
  if(incomingNames.some((name:unknown)=>names.has(name))){
    const reserved=[...names,...incomingNames];
    for(let generation=1;;generation++){
      const candidate=generation===1?'append:':`append${generation}:`;
      if(reserved.every(name=>typeof name!=='string'||!name.startsWith(candidate))){namespace=candidate;break;}
    }
  }
  const originalNames=new Set(names);
  for(const n of incoming){assert.ok(n.skin===undefined&&n.camera===undefined&&!n.extensions,'unsupported city node references');if(n.mesh!==undefined)n.mesh+=offset.meshes;if(n.children)n.children=n.children.map((i:number)=>i+offset.nodes);if(originalNames.has(n.name))n.name=`${namespace}${n.name}`;assert.ok(!names.has(n.name),'duplicate appended node name');names.add(n.name);}
  a.scenes[0].nodes??=[];a.scenes[0].nodes.push(...(b.scenes[0].nodes??[]).map((i:number)=>i+offset.nodes));
  for(const k of keys)a[k].push(...(b[k]??[]));a.buffers.push(...b.buffers.slice(1));
  const bin=Buffer.concat([base.bin,new Uint8Array(physical-base.bin.length),extra.bin]);a.buffers[0].byteLength=bin.length;
  for(const k of['extensionsUsed','extensionsRequired'])a[k]=[...new Set([...(a[k]??[]),...(b[k]??[])])];
  // glTF array properties must be omitted when empty (distant cells have no images/samplers/textures).
  for(const k of[...keys,'extensionsUsed','extensionsRequired'])if(a[k]?.length===0)delete a[k];
  const text=Buffer.from(JSON.stringify(a)),padded=Buffer.alloc(align4(text.length),0x20);text.copy(padded);
  const out=Buffer.alloc(28+padded.length+align4(bin.length));out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);out.writeUInt32LE(align4(bin.length),20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(out,28+padded.length);
  const check=readFacadeGlb(out);assert.deepEqual(check.bin.subarray(0,base.bin.length),base.bin,'base BIN changed');
  for(const k of keys)assert.deepEqual(((check.json[k]??[]) as unknown[]).slice(0,offset[k]),base.json[k]??[],`base ${k} changed`);
  return out;
}

/** Keep original collider IDs/order and typed arrays as prefixes. Only matching ground/kerb groups may grow. */
export function appendCityCollision(baseBytes:Uint8Array,extraBytes:Uint8Array):Uint8Array {
  const a=parseCollisionBundle(baseBytes),b=parseCollisionBundle(extraBytes);assert.equal(a.header.originId,b.header.originId);assert.equal(a.header.cell,b.header.cell);assert.equal(a.header.frame,b.header.frame);
  const tags=[...a.header.surfaceTags],tagMap=b.header.surfaceTags.map(t=>{let n=tags.indexOf(t);if(n<0){n=tags.length;tags.push(t);}assert.ok(n<=65535);return n;});
  const colliders:TriMeshCollider[]=[...a.colliders];
  for(const original of b.colliders){
    const addition={...original,triangleTags:Uint16Array.from(original.triangleTags,t=>{assert.ok(tagMap[t]!==undefined);return tagMap[t]!;})};
    const i=colliders.findIndex(c=>c.id===addition.id);
    if(i<0){colliders.push(addition);continue;}
    const old=colliders[i]!;assert.ok((old.group==='ground'||old.group==='kerbs')&&old.group===addition.group&&old.ref===addition.ref,`duplicate non-ground collider ${old.id}`);
    colliders[i]={...old,positions:Float32Array.from([...old.positions,...addition.positions]),indices:Uint32Array.from([...old.indices,...Array.from(addition.indices,n=>n+old.positions.length/3)]),triangleTags:Uint16Array.from([...old.triangleTags,...addition.triangleTags])};
  }
  const out=encodeCollisionBundle({...a.header,surfaceTags:tags},colliders),checked=parseCollisionBundle(out);
  for(let i=0;i<a.colliders.length;i++){const old=a.colliders[i]!,now=checked.colliders[i]!;assert.equal(now.id,old.id);for(const k of['positions','indices','triangleTags']as const)assert.deepEqual(now[k].subarray(0,old[k].length),old[k],`${old.id} ${k} prefix changed`);}
  return out;
}

export interface FrontierRepairMetadata {
  schemaVersion:1|2;
  originalBaseCells:string;
  originalBaseIndexSha256:string;
  trimmedBaseIndexSha256:string;
  geographicRegion:AppendRectangle;
  groundRegion:AppendRectangle;
  sourceBand:AppendRectangle;
  /** Version 1 is the original western proof; version 2 binds an explicit axis and complete plan. */
  cutX?:number;
  protectedMinX?:number;
  axis?:'x'|'z';
  cut?:number;
  protectedSide?:'east'|'south';
  acceptedBounds?:AppendRectangle;
  protectedInteriorPreserved:true;
  evidence:{path:string;sha256:string};
}
export interface AppendCityOptions {baseCells:string;appendCells:string;region:AppendRectangle;sourceTerrain:string;runtimeTerrain:string;config:string;out:string;frontierRepair?:string}
function readFrontierRepair(options:AppendCityOptions,baseIndexBytes:Uint8Array,baseReport:any,extraReport:any):FrontierRepairMetadata|null {
  if(!options.frontierRepair)return null;
  const repair=baseReport.frontierRepair as FrontierRepairMetadata|undefined;assert.ok(repair,'Explicit frontier repair requires trimmed-base metadata');
  assert.deepEqual(extraReport.frontierRepair,repair,'Base/strip frontier repair bindings differ');assert.ok(repair.schemaVersion===1||repair.schemaVersion===2,'Unsupported frontier proof version');assert.equal(repair.protectedInteriorPreserved,true,'Frontier protected interior proof required');
  assert.equal(repair.trimmedBaseIndexSha256,sha(baseIndexBytes),'Frontier trimmed index changed');assert.deepEqual(repair.geographicRegion,options.region,'Frontier geographic strip differs');
  assert.equal(path.resolve(repair.evidence.path),path.resolve(options.frontierRepair),'Explicit frontier evidence path differs');const evidenceBytes=fs.readFileSync(options.frontierRepair);assert.equal(sha(evidenceBytes),repair.evidence.sha256,'Frontier evidence hash changed');
  const evidence=JSON.parse(evidenceBytes.toString());assert.equal(evidence.protectedInteriorPreserved,true);assert.equal(evidence.originalBaseIndexSha256,repair.originalBaseIndexSha256);assert.equal(evidence.trimmedBaseIndexSha256,repair.trimmedBaseIndexSha256);
  if(repair.schemaVersion===2){
    assert.equal(evidence.schemaVersion,2,'Explicit-axis frontier evidence version differs');
    for(const key of['axis','cut','protectedSide','acceptedBounds','geographicRegion','groundRegion','sourceBand']as const)assert.deepEqual(evidence[key],repair[key],`Frontier evidence ${key} differs`);
    assert.ok(repair.axis==='x'||repair.axis==='z','Frontier axis is required');assert.equal(repair.cutX,undefined,'Explicit-axis frontier may not carry a legacy X cut');assert.equal(repair.protectedMinX,undefined,'Explicit-axis frontier may not carry a legacy X protection');
    assert.equal(evidence.repairedStripIndexSha256,sha(fs.readFileSync(path.join(options.appendCells,'cells.json'))),'Frontier repaired strip index changed');
  }
  const originalIndexBytes=fs.readFileSync(path.join(repair.originalBaseCells,'cells.json'));assert.equal(sha(originalIndexBytes),repair.originalBaseIndexSha256,'Original accepted index changed');
  const originalIndex=JSON.parse(originalIndexBytes.toString()),trimmedIndex=JSON.parse(Buffer.from(baseIndexBytes).toString());
  assert.equal(originalIndex.originId,trimmedIndex.originId);assert.equal(originalIndex.cellSize,trimmedIndex.cellSize);assert.deepEqual(trimmedIndex.cells.map((c:CellDescriptor)=>c.id),originalIndex.cells.map((c:CellDescriptor)=>c.id),'Frontier must retain every accepted cell');
  for(let i=0;i<originalIndex.cells.length;i++)for(const key of['boundsXZ','buildings','buildingIds','sourceTiles'])assert.deepEqual(trimmedIndex.cells[i][key],originalIndex.cells[i][key],`Frontier changed accepted ${key}`);
  const originalReport=JSON.parse(fs.readFileSync(path.join(repair.originalBaseCells,'report.json'),'utf8'));assert.equal(baseReport.supportTerrain.sha256,originalReport.supportTerrain.sha256,'Trimmed base must bind original runtime field');
  return repair;
}
export function appendCityCells(options:AppendCityOptions){
  const base=path.resolve(options.baseCells),extra=path.resolve(options.appendCells),out=path.resolve(options.out);parseAppendRectangle(options.region.join(','));assert.ok(!fs.existsSync(out),'output must be fresh');
  for(const input of[base,extra]){const relative=path.relative(input,out);assert.ok(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative),'output must not be nested in source');}
  const readJson=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8')),baseIndexBytes=fs.readFileSync(path.join(base,'cells.json')),extraIndexBytes=fs.readFileSync(path.join(extra,'cells.json')),a=JSON.parse(baseIndexBytes.toString()),b=JSON.parse(extraIndexBytes.toString()),baseReport=readJson(path.join(base,'report.json')),extraReport=readJson(path.join(extra,'report.json')),config=readJson(options.config);
  const frontierRepair=readFrontierRepair(options,baseIndexBytes,baseReport,extraReport);
  assert.equal(a.originId,b.originId);assert.equal(a.cellSize,b.cellSize);assert.deepEqual(extraReport.groundRegion,frontierRepair?.groundRegion??options.region,'strip build must record exact ground clipping region');
  assert.equal(extraReport.excludedGround?.indexSha256,sha(baseIndexBytes),'strip must exclude the exact accepted ground coverage');
  const owned=new Set<string>((a.cells as CellDescriptor[]).flatMap(c=>[...c.buildingIds,...c.buildings.map(b=>b.id)])),newOwned=new Set<string>();
  for(const index of[a,b])assert.equal(new Set(index.cells.map((c:CellDescriptor)=>c.id)).size,index.cells.length,'duplicate cell ID');
  for(const cell of b.cells as CellDescriptor[])for(const building of cell.buildings){assert.ok(!owned.has(building.id),`accepted building duplicated: ${building.id}`);assert.ok(!newOwned.has(building.id),`duplicate new building: ${building.id}`);newOwned.add(building.id);}
  const terrainBytes=fs.readFileSync(options.runtimeTerrain),terrain=parseTerrain(terrainBytes),oldTerrainBytes=fs.readFileSync(safe(base,baseReport.supportTerrain.path)),oldTerrain=parseTerrain(oldTerrainBytes),sourceMeta=readJson(path.join(options.sourceTerrain,'terrain.json')),sourceBytes=fs.readFileSync(safe(options.sourceTerrain,sourceMeta.file)),source=parseTerrain(sourceBytes);
  assert.equal(sha(oldTerrainBytes),baseReport.supportTerrain.sha256,'accepted runtime field hash changed');
  assert.equal(sha(sourceBytes),sourceMeta.sha256);for(const k of['x0','z0','resolution','nx','nz']as const){assert.equal(terrain[k],source[k],`terrain dimensions ${k}`);if(sourceMeta[k]!==undefined)assert.equal(source[k],sourceMeta[k],`source metadata ${k}`);}
  assert.ok(terrain.heights.every(Number.isFinite)&&source.heights.every(Number.isFinite),'nonfinite extended terrain');
  assert.equal(terrain.resolution,oldTerrain.resolution);const dx=(oldTerrain.x0-terrain.x0)/terrain.resolution,dz=(oldTerrain.z0-terrain.z0)/terrain.resolution;assert.ok(Number.isInteger(dx)&&Number.isInteger(dz)&&dx>=0&&dz>=0&&dx+oldTerrain.nx<=terrain.nx&&dz+oldTerrain.nz<=terrain.nz,'extended runtime field must contain original grid');
  const boundsOf=(t:typeof terrain):AppendRectangle=>[t.x0,t.z0,t.x0+(t.nx-1)*t.resolution,t.z0+(t.nz-1)*t.resolution],oldBounds=boundsOf(oldTerrain),newBounds=boundsOf(terrain),[x0,z0,x1,z1]=options.region;
  const west=x1===oldBounds[0]&&x0<oldBounds[0]&&z0===oldBounds[1]&&z1===oldBounds[3],east=x0===oldBounds[2]&&x1>oldBounds[2]&&z0===oldBounds[1]&&z1===oldBounds[3],north=z1===oldBounds[1]&&z0<oldBounds[1]&&x0===oldBounds[0]&&x1===oldBounds[2],south=z0===oldBounds[3]&&z1>oldBounds[3]&&x0===oldBounds[0]&&x1===oldBounds[2];
  assert.ok(west||east||north||south,'region must be one contiguous full rectangular strip outside accepted terrain');
  assert.deepEqual(newBounds,[Math.min(x0,oldBounds[0]),Math.min(z0,oldBounds[1]),Math.max(x1,oldBounds[2]),Math.max(z1,oldBounds[3])],'terrain extent must equal accepted rectangle plus append strip');
  let frontierPlan:FrontierPlan|null=null;
  if(frontierRepair){
    assert.equal(sha(terrainBytes),extraReport.supportTerrain.sha256,'Frontier runtime must match the repaired strip proof');
    const axis=frontierRepair.schemaVersion===1?'x':frontierRepair.axis!;
    frontierPlan=planCityFrontier(oldBounds,options.region,axis);
    if(frontierRepair.schemaVersion===1){assert.ok(west,'Legacy frontier exception is restricted to the approved west strip');assert.equal(frontierRepair.cutX,frontierPlan.cut,'Frontier exception is exactly five metres');assert.equal(frontierRepair.protectedMinX,frontierRepair.cutX);}
    else{assert.equal(frontierRepair.cut,frontierPlan.cut,'Frontier exception is exactly five metres');assert.equal(frontierRepair.protectedSide,frontierPlan.protectedSide,'Frontier protected side differs');assert.deepEqual(frontierRepair.acceptedBounds,oldBounds,'Frontier accepted extent differs');}
    assert.deepEqual(frontierRepair.groundRegion,frontierPlan.groundRegion,'Frontier ground extent differs');
    assert.deepEqual(frontierRepair.sourceBand,frontierPlan.sourceBand,'Frontier source band differs');
  }
  let loweredFrontierRuntimeSamples=0;
  for(let z=0;z<oldTerrain.nz;z++)for(let x=0;x<oldTerrain.nx;x++){
    const next=terrain.heights[(z+dz)*terrain.nx+x+dx]!,previous=oldTerrain.heights[z*oldTerrain.nx+x]!;if(Object.is(next,previous))continue;
    assert.ok(frontierPlan&&frontierRuntimeLoweringAllowed(frontierPlan,oldTerrain.x0+x*oldTerrain.resolution,oldTerrain.z0+z*oldTerrain.resolution,previous,next),'accepted runtime terrain sample changed outside lower-only frontier exception');loweredFrontierRuntimeSamples++;
  }
  const verified=(root:string,ref:{path:string;sha256:string;bytes:number})=>{const file=safe(root,ref.path),bytes=fs.readFileSync(file);assert.equal(sha(bytes),ref.sha256,`input hash ${file}`);assert.equal(bytes.length,ref.bytes);return{file,bytes};};
  // Validate every frozen payload before creating the output, including cells not touched by this strip.
  for(const[root,index]of[[base,a],[extra,b]]as const)for(const cell of index.cells as CellDescriptor[])for(const ref of[...Object.values(cell.visual),cell.collision])verified(root,ref);
  fs.mkdirSync(out,{recursive:true});const checks:any[]=[],cells:CellDescriptor[]=[];
  const write=(relative:string,data:Uint8Array)=>{const file=safe(out,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data,{flag:'wx'});return{path:relative,bytes:data.length,sha256:sha(data)};};
  const link=(root:string,ref:any)=>{const src=verified(root,ref),dst=safe(out,ref.path);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.linkSync(src.file,dst);};
  const pending=new Map<string,CellDescriptor>((b.cells as CellDescriptor[]).map(c=>[c.id,c]));
  for(const old of a.cells as CellDescriptor[]){
    const patch=pending.get(old.id);pending.delete(old.id);
    if(!patch){for(const ref of[...Object.values(old.visual),old.collision])link(base,ref);cells.push(old);checks.push({cell:old.id,mode:'byte-exact-hardlink'});continue;}
    assert.deepEqual(patch.boundsXZ,old.boundsXZ);const visual:any={};
    for(const tier of['lod0','lod1','lod2']as const){const prior=old.visual[tier];if(!prior)continue;const add=patch.visual[tier]??(tier==='lod1'?patch.visual.lod0:undefined);assert.ok(add,`strip cell ${old.id} missing ${tier}`);
      const bytes=appendCityGlb(verified(base,prior).bytes,verified(extra,add).bytes);visual[tier]={...prior,...write(`visual/${old.id}.${tier}.glb`,bytes),triangles:prior.triangles+add.triangles,drawCalls:prior.drawCalls+add.drawCalls,atlases:prior.atlases+add.atlases,textureBytesEstimate:prior.textureBytesEstimate+add.textureBytesEstimate};}
    const collision=write(`collision/${old.id}.bin`,appendCityCollision(verified(base,old.collision).bytes,verified(extra,patch.collision).bytes));
    cells.push({...old,visual,collision:{...collision,triangles:old.collision.triangles+patch.collision.triangles},buildingIds:[...old.buildingIds,...patch.buildingIds.filter(id=>!old.buildingIds.includes(id))],buildings:[...old.buildings,...patch.buildings],sourceTiles:[...old.sourceTiles,...patch.sourceTiles.filter(id=>!old.sourceTiles.includes(id))]});checks.push({cell:old.id,mode:'append-only',baseVisual:old.visual,baseCollision:old.collision});
  }
  for(const cell of pending.values()){assert.ok(cell.visual.lod2,`new cell ${cell.id} missing distant tier`);for(const ref of[...Object.values(cell.visual),cell.collision])link(extra,ref);cells.push(cell);checks.push({cell:cell.id,mode:'new-cell-hardlink'});}
  const scenePaths=[path.join(base,'scenery.json'),path.join(extra,'scenery.json')];
  if(fs.existsSync(scenePaths[0]!)){
    const scenery=readJson(scenePaths[0]!);if(fs.existsSync(scenePaths[1]!)){const add=readJson(scenePaths[1]!);assert.equal(scenery.originId,add.originId);assert.deepEqual(scenery.assets,add.assets,'scenery asset binding changed');const ids=new Map(scenery.instances.map((s:any)=>[s.id,s]));for(const instance of add.instances){if(ids.has(instance.id)){assert.deepEqual(instance,ids.get(instance.id),'conflicting scenery instance');continue;}scenery.instances.push(instance);ids.set(instance.id,instance);}}
    write('scenery.json',Buffer.from(JSON.stringify(scenery,null,1)+'\n'));
  }else if(fs.existsSync(scenePaths[1]!))write('scenery.json',fs.readFileSync(scenePaths[1]!));
  const supportTerrain=write('runtime-terrain.bin',terrainBytes),drawCalls=cells.reduce((n,c)=>n+c.visual.lod0.drawCalls,0);
  const textureMiB=baseReport.totals.residentTextureMiBEstimate+extraReport.totals.residentTextureMiBEstimate;
  const pass=cells.every(c=>c.visual.lod0.drawCalls<=config.budgets.drawCallsPerCell&&(!config.streaming?.enabled||(c.visual.lod2&&c.visual.lod2.drawCalls<=3&&c.visual.lod2.textureBytesEstimate===0)))&&(config.streaming?.enabled||textureMiB<=config.budgets.lowPresetTextureMiB);
  const mergedList=(left:any[]=[],right:any[]=[],key='id')=>{const seen=new Set(left.map(v=>v[key]));return [...left,...right.filter(v=>!seen.has(v[key])&&(seen.add(v[key]),true))];};
  // Strip generation uses the full expanded source context. Downstream interface closure must see its
  // complete mask (including newly acquired inland basins), while both source contexts remain auditable.
  const coastal=extraReport.coastal??baseReport.coastal;
  const coastalContexts={selected:extraReport.coastal!=null?'append':baseReport.coastal!=null?'base':'none',base:baseReport.coastal??null,append:extraReport.coastal??null};
  const report={...baseReport,builtAt:new Date().toISOString(),inputs:{...baseReport.inputs,...extraReport.inputs,terrainSha256:sha(sourceBytes)},supportTerrain,coastal,
    stairs:{...baseReport.stairs,flights:mergedList(baseReport.stairs?.flights,extraReport.stairs?.flights),register:mergedList(baseReport.stairs?.register,extraReport.stairs?.register)},
    entranceTerraces:{...baseReport.entranceTerraces,terraces:mergedList(baseReport.entranceTerraces?.terraces,extraReport.entranceTerraces?.terraces)},
    retainingWalls:{...baseReport.retainingWalls,walls:mergedList(baseReport.retainingWalls?.walls,extraReport.retainingWalls?.walls),registerAlignment:mergedList(baseReport.retainingWalls?.registerAlignment,extraReport.retainingWalls?.registerAlignment)},
    cells:cells.map(c=>({cell:c.id,buildings:c.buildings.length,drawCalls:c.visual.lod0.drawCalls,triangles:c.visual.lod0.triangles,glbBytes:c.visual.lod0.bytes,collisionTriangles:c.collision.triangles})),
    appendCity:{base,append:extra,region:options.region,baseIndexSha256:sha(baseIndexBytes),appendIndexSha256:sha(extraIndexBytes),baseReportSha256:sha(fs.readFileSync(path.join(base,'report.json'))),appendReportSha256:sha(fs.readFileSync(path.join(extra,'report.json'))),baseInputs:baseReport.inputs,appendInputs:extraReport.inputs,coastalContexts,sourceHashes:{producer:sha(fs.readFileSync(import.meta.filename)),config:sha(fs.readFileSync(options.config))},frontierRepair,loweredFrontierRuntimeSamples,checks},
    totals:{...baseReport.totals,cells:cells.length,drawCalls,residentTextureMiBEstimate:textureMiB,textureEstimateNote:'Conservative sum of original and strip unique textures; shared pages may be counted twice.'},budgets:{...baseReport.budgets,drawCallsPerCellMax:Math.max(...cells.map(c=>c.visual.lod0.drawCalls)),pass,runtimeResidencyVerification:'REQUIRED: new candidate traversal and return'}};
  write('cells.json',Buffer.from(JSON.stringify({...a,cells},null,1)+'\n'));write('report.json',Buffer.from(JSON.stringify(report,null,1)+'\n'));
  assert.equal(sha(fs.readFileSync(path.join(base,'cells.json'))),sha(baseIndexBytes),'base index changed during merge');assert.equal(sha(fs.readFileSync(path.join(extra,'cells.json'))),sha(extraIndexBytes),'strip index changed during merge');
  return{status:pass?'PASS_APPEND_ONLY_RUNTIME_PENDING':'FAIL_BUDGET',cells:cells.length,unchanged:checks.filter(c=>c.mode==='byte-exact-hardlink').length,appended:checks.filter(c=>c.mode==='append-only').length,added:pending.size,report};
}
