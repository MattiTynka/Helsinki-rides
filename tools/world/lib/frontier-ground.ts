// Exact attribute-preserving clipping for the explicitly reviewed city frontier.
import assert from 'node:assert/strict';
import {encodeCollisionBundle,parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import type {GroundPiece} from './ground.ts';
import {flatNormals} from './gltf.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';

export interface FrontierMesh {
  attributes:Record<string,GroundAttributeArray>;
  components:Record<string,number>;
  normalized:Record<string,boolean>;
  indices:Uint32Array;
}
export interface FrontierClip {
  /** cutX/cutAxis retain the historical western repair API. New callers use cut/axis. */
  cutX?:number;cutAxis?:0|2;cut?:number;axis?:'x'|'z';
  side:'east'|'west'|'north'|'south';selectTriangle?:(triangle:number)=>boolean;
}
export type FrontierRectangle=readonly [number,number,number,number];
export interface FrontierPlan {
  axis:'x'|'z';cut:number;protectedSide:'east'|'south'|'north';
  geographicRegion:FrontierRectangle;groundRegion:FrontierRectangle;sourceBand:FrontierRectangle;
  acceptedBounds:FrontierRectangle;
}
export interface FrontierDirection {axis:'x'|'z';side:'west'|'north'|'south'}
/** Only a full west, north or south strip can opt into this exception. Its native assembly replaces five
 * accepted metres and six external metres; callers cannot widen that protected-interior exception. */
export function planCityFrontier(acceptedBounds:FrontierRectangle,region:FrontierRectangle,direction:'x'|'z'|FrontierDirection='x'):FrontierPlan{
  for(const bounds of[acceptedBounds,region])assert.ok(bounds.length===4&&bounds.every(Number.isFinite)&&bounds[0]<bounds[2]&&bounds[1]<bounds[3],'Invalid frontier rectangle');
  const axis=typeof direction==='string'?direction:direction.axis,explicit=typeof direction!=='string';
  assert.ok(axis==='x'||axis==='z','Frontier axis must be x or z');
  if(explicit)assert.ok((axis==='x'&&direction.side==='west')||(axis==='z'&&['north','south'].includes(direction.side)),'Frontier side disagrees with axis');
  const [ax0,az0,ax1,az1]=acceptedBounds,[x0,z0,x1,z1]=region;
  if(axis==='x'){
    assert.ok(x1===ax0&&x0<ax0&&(explicit?z0<az1&&z1>az0:z0===az0&&z1===az1),'Frontier must be one full western strip or an explicit bounded western strip');assert.ok(ax0+5<ax1,'Accepted terrain is narrower than the protected frontier');
    return{axis,cut:ax0+5,protectedSide:'east',acceptedBounds,geographicRegion:region,groundRegion:[x0,z0,ax0+5,z1],sourceBand:[ax0-6,z0,ax0+5,z1]};
  }
  const tangent=explicit?x0<ax1&&x1>ax0:x0===ax0&&x1===ax1;
  const north=z1===az0&&z0<az0&&tangent&&(!explicit||direction.side==='north');
  const south=z0===az1&&z1>az1&&tangent&&(!explicit||direction.side==='south');
  assert.ok(north||south,'Frontier must be one full northern strip or one full southern strip');assert.ok(az0+5<az1,'Accepted terrain is shorter than the protected frontier');
  return north
    ?{axis,cut:az0+5,protectedSide:'south',acceptedBounds,geographicRegion:region,groundRegion:[x0,z0,x1,az0+5],sourceBand:[x0,az0-6,x1,az0+5]}
    :{axis,cut:az1-5,protectedSide:'north',acceptedBounds,geographicRegion:region,groundRegion:[x0,az1-5,x1,z1],sourceBand:[x0,az1-5,x1,az1+6]};
}
export function frontierRuntimeLoweringAllowed(plan:FrontierPlan,x:number,z:number,previous:number,next:number){
  const [x0,z0,x1,z1]=plan.acceptedBounds;
  const band=plan.sourceBand;
  return Number.isFinite(previous)&&Number.isFinite(next)&&next<previous&&x>=x0&&x<=x1&&z>=z0&&z<=z1&&x>=band[0]&&x<=band[2]&&z>=band[1]&&z<=band[3]&&(plan.axis==='x'?x<plan.cut:plan.protectedSide==='north'?z>plan.cut:z<plan.cut);
}

/** Interior-disjoint rectangles covering a minus b. Boundaries stay closed so adjacent surface
 * triangles meet; replacement ordering gives aligned vertical boundary faces one owner. */
export function subtractFrontierRectangle(a:FrontierRectangle,b:FrontierRectangle):FrontierRectangle[]{
  const x0=Math.max(a[0],b[0]),z0=Math.max(a[1],b[1]),x1=Math.min(a[2],b[2]),z1=Math.min(a[3],b[3]);
  if(x0>=x1||z0>=z1)return[a];
  return[[a[0],a[1],x0,a[3]],[x1,a[1],a[2],a[3]],[x0,a[1],x1,z0],[x0,z1,x1,a[3]]].filter(r=>r[0]!<r[2]!&&r[1]!<r[3]!)as [number,number,number,number][];
}

/** Validate the geographic union before writing a packet, then assign each shared corner once.
 * An extended end of a strip must be joined to another declared region; it cannot replace ground
 * in an unrequested quadrant. Input order is the explicit, recorded corner priority. */
export function composeCityFrontiers(acceptedBounds:FrontierRectangle,specs:readonly {region:FrontierRectangle;axis?:'x'|'z';side?:FrontierDirection['side']}[]){
  assert.ok(specs.length>0,'At least one independently produced strip is required');
  const plans=specs.map(spec=>{
    assert.equal(spec.axis===undefined,spec.side===undefined,'Explicit frontier requires both axis and side');
    return planCityFrontier(acceptedBounds,spec.region,spec.axis===undefined?'z':{axis:spec.axis,side:spec.side!});
  });
  for(let i=0;i<plans.length;i++)for(let j=0;j<i;j++){
    const a=plans[i]!.geographicRegion,b=plans[j]!.geographicRegion;
    assert.ok(Math.max(a[0],b[0])>=Math.min(a[2],b[2])||Math.max(a[1],b[1])>=Math.min(a[3],b[3]),'Geographic strips overlap; assign the corner to one strip');
  }
  const occupied=[acceptedBounds,...plans.map(p=>p.geographicRegion)];
  for(const plan of plans){
    // Only the part of the source band on the protected side needs adjoining authority.
    const a=plan.sourceBand,protectedBand:FrontierRectangle=plan.axis==='x'?[acceptedBounds[0],a[1],a[2],a[3]]:plan.protectedSide==='north'?[a[0],a[1],a[2],acceptedBounds[3]]:[a[0],acceptedBounds[1],a[2],a[3]];
    const uncovered=occupied.reduce<FrontierRectangle[]>((parts,region)=>parts.flatMap(p=>subtractFrontierRectangle(p,region)),[protectedBand]);
    assert.equal(uncovered.length,0,'Extended frontier lacks an adjoining declared region');
  }
  return plans.map((plan,i)=>({plan,regions:plans.slice(0,i).reduce<FrontierRectangle[]>((parts,prior)=>parts.flatMap(p=>subtractFrontierRectangle(p,prior.sourceBand)),[plan.sourceBand])}));
}
const area3=(a:number[],b:number[],c:number[])=>Math.hypot((b[1]!-a[1]!)*(c[2]!-a[2]!)-(b[2]!-a[2]!)*(c[1]!-a[1]!),(b[2]!-a[2]!)*(c[0]!-a[0]!)-(b[0]!-a[0]!)*(c[2]!-a[2]!),(b[0]!-a[0]!)*(c[1]!-a[1]!)-(b[1]!-a[1]!)*(c[0]!-a[0]!));
type Vertex=Record<string,number[]>;
function castLike(source:GroundAttributeArray,values:number[]):GroundAttributeArray{
  const Constructor=source.constructor as {new(values:ArrayLike<number>):GroundAttributeArray};
  return new Constructor(values);
}

/** Uncut triangles retain every raw attribute value. Intersections interpolate all semantics together;
 * only newly generated integer attributes are rounded, and normals are normalized before integer packing. */
export function clipFrontierMesh(mesh:FrontierMesh,options:FrontierClip){
  const requestedCut=options.cut??options.cutX;assert.ok(typeof requestedCut==='number'&&Number.isFinite(requestedCut));const cut=Number(requestedCut);if(options.cut!==undefined&&options.cutX!==undefined)assert.equal(options.cut,options.cutX,'Conflicting frontier cuts');
  if(options.axis!==undefined)assert.ok(options.axis==='x'||options.axis==='z','Frontier axis must be x or z');
  const axis=options.axis===undefined?(options.cutAxis??(options.side==='north'||options.side==='south'?2:0)):options.axis==='x'?0:2;
  assert.ok(axis===0||axis===2);if(options.cutAxis!==undefined)assert.equal(axis,options.cutAxis,'Conflicting frontier axes');assert.ok(['east','west','north','south'].includes(options.side));if(options.side==='north'||options.side==='south')assert.equal(axis,2,'North/south require a Z frontier');const positive=options.side==='east'||options.side==='south';
  assert.equal(mesh.components.POSITION,3);assert.ok(mesh.attributes.POSITION instanceof Float32Array,'Frontier POSITION must be native Float32');
  const semantics=Object.keys(mesh.attributes),arrays=Object.fromEntries(semantics.map(s=>[s,[] as number[]])),indices:number[]=[],sourceTriangles:number[]=[];
  assert.equal(mesh.indices.length%3,0);
  for(const s of semantics){assert.ok(Number.isInteger(mesh.components[s])&&mesh.components[s]!>0);assert.equal(mesh.attributes[s]!.length/mesh.components[s]!,mesh.attributes.POSITION.length/3,'Attribute counts must agree');assert.ok(mesh.attributes[s]!.every(Number.isFinite),'Nonfinite frontier attribute');}
  assert.ok(mesh.indices.every(i=>i<mesh.attributes.POSITION!.length/3),'Frontier index out of range');let changedTriangles=0,removedTriangles=0;
  function intersection(a:Vertex,b:Vertex,t:number){const result:Vertex={};for(const s of semantics)result[s]=a[s]!.map((v,k)=>v+(b[s]![k]!-v)*t);result.POSITION![axis]=cut;
    for(const s of semantics){const source=mesh.attributes[s]!;if(s==='NORMAL'){const values=result[s]!,length=Math.hypot(...values);assert.ok(length>0,'Interpolated normal is zero');const scale=mesh.normalized[s]?(source instanceof Int8Array?127:source instanceof Int16Array?32767:0):1;assert.ok(scale);result[s]=values.map(v=>v/length*scale);}
      if(!(source instanceof Float32Array))result[s]=result[s]!.map(v=>Math.round(v));}
    return result;}
  for(let i=0;i<mesh.indices.length;i+=3){let clipped=false;let polygon:Vertex[]=[0,1,2].map(k=>Object.fromEntries(semantics.map(s=>{const start=mesh.indices[i+k]!*mesh.components[s]!;return[s,Array.from(mesh.attributes[s]!.subarray(start,start+mesh.components[s]!))];})));
    const selected=options.selectTriangle?.(i/3)??true;
    if(selected){const next:Vertex[]=[],distance=(v:Vertex)=>(v.POSITION![axis]!-cut)*(positive?1:-1);let changed=false;
      for(let k=0;k<polygon.length;k++){const a=polygon[k]!,b=polygon[(k+1)%polygon.length]!,da=distance(a),db=distance(b);if(da>=0)next.push(a);else changed=true;if((da>=0)!==(db>=0))next.push(intersection(a,b,da/(da-db)));}
      if(changed)changedTriangles++;clipped=changed;polygon=next;}
    if(polygon.length<3){removedTriangles++;continue;}
    for(let k=1;k+1<polygon.length;k++){const vertices=[polygon[0]!,polygon[k]!,polygon[k+1]!];
      // Check the actual Float32 output geometry, including vertical wall fragments.
      const p=vertices.map(v=>Array.from(Float32Array.from(v.POSITION!)));
      if(clipped&&area3(p[0]!,p[1]!,p[2]!)<1e-12)continue;
      for(const v of vertices){indices.push(arrays.POSITION!.length/3);for(const s of semantics)arrays[s]!.push(...v[s]!);}sourceTriangles.push(i/3);
    }
  }
  const attributes=Object.fromEntries(semantics.map(s=>[s,castLike(mesh.attributes[s]!,arrays[s]!)]));
  return{mesh:{...mesh,attributes,indices:Uint32Array.from(indices)},sourceTriangles,stats:{inputTriangles:mesh.indices.length/3,outputTriangles:indices.length/3,changedTriangles,removedTriangles}};
}

/** Float32 exact cyclic-rotation invariant key; opposite winding remains distinct. Signed zero is geometric zero. */
export function frontierTriangleKey(points:readonly (readonly number[])[]):string{
  assert.equal(points.length,3);
  const keys=points.map(p=>{assert.equal(p.length,3);const b=Buffer.alloc(12);p.forEach((v,i)=>{assert.ok(Number.isFinite(v));b.writeFloatLE(v===0?0:v,i*4);});return b.toString('hex');});
  return[0,1,2].map(i=>[keys[i],keys[(i+1)%3],keys[(i+2)%3]].join('')).sort()[0]!;
}
export function frontierMeshKeys(mesh:FrontierMesh){const pos=mesh.attributes.POSITION!,keys=new Set<string>();for(let i=0;i<mesh.indices.length;i+=3)keys.add(frontierTriangleKey([0,1,2].map(k=>Array.from(pos.subarray(mesh.indices[i+k]!*3,mesh.indices[i+k]!*3+3)))));return keys;}

/** Include material/use, owner and UV identity as well as geometry. Cyclic rotation is harmless;
 * winding, duplicate faces or inconsistent cached authority at a composed corner are not. */
export function nativeFrontierKeys(pieces:readonly GroundPiece[]){
  return pieces.flatMap(piece=>{
    const result:string[]=[];
    for(let t=0;t<piece.indices.length;t+=3){
      const points=[0,1,2].map(k=>{const i=piece.indices[t+k]!;return JSON.stringify(Array.from(Float32Array.from([...piece.positions.slice(i*3,i*3+3),...piece.uvs.slice(i*2,i*2+2)])));});
      const vertices=[0,1,2].map(i=>[points[i],points[(i+1)%3],points[(i+2)%3]].join(':')).sort()[0];
      result.push(JSON.stringify([piece.cell,piece.finish,piece.level,piece.tag,piece.use??'both',vertices]));
    }
    return result;
  }).sort();
}

/** Reject only triangles with exactly zero area in the actual Float32 serialization domain. A clipped
 * sub-ulp sliver has no rendered or colliding surface, and must not introduce zero normals into a new mesh. */
export function prepareNativeFrontier(pieces:readonly GroundPiece[]){
  const discarded:{piece:number;triangle:number;cell:string;positions:number[][]}[]=[];
  const kept=pieces.flatMap((piece,i)=>{const indices:number[]=[];for(let t=0;t<piece.indices.length;t+=3){const p=[0,1,2].map(k=>Array.from(Float32Array.from(piece.positions.slice(piece.indices[t+k]!*3,piece.indices[t+k]!*3+3))));if(area3(p[0]!,p[1]!,p[2]!)===0){discarded.push({piece:i,triangle:t/3,cell:piece.cell,positions:p});continue;}indices.push(...piece.indices.slice(t,t+3));}return indices.length?[indices.length===piece.indices.length?piece:{...piece,indices}]:[];});
  return{pieces:kept,discarded};
}

/** Add native visual triangles to a matching existing finish without adding a texture or material. */
export function addNativeFrontier(mesh:FrontierMesh,pieces:readonly GroundPiece[]):FrontierMesh{
  assert.deepEqual(Object.keys(mesh.attributes).sort(),['NORMAL','POSITION','TEXCOORD_0']);assert.ok(mesh.attributes.TEXCOORD_0 instanceof Float32Array,'Native frontier requires exact Float32 UVs');
  const positions:number[]=[],uvs:number[]=[],nativeIndices:number[]=[];
  for(const p of pieces){if(p.use==='collision')continue;for(const id of p.indices){nativeIndices.push(positions.length/3);positions.push(...p.positions.slice(id*3,id*3+3));uvs.push(...p.uvs.slice(id*2,id*2+2));}}
  if(!nativeIndices.length)return mesh;
  const p=Float32Array.from(positions),idx=Uint32Array.from(nativeIndices),normal=flatNormals(p,idx),sourceNormal=mesh.attributes.NORMAL!,scale=mesh.normalized.NORMAL?(sourceNormal instanceof Int8Array?127:sourceNormal instanceof Int16Array?32767:0):1;assert.ok(scale);
  const packedNormal=castLike(sourceNormal,Array.from(normal,v=>scale===1?v:Math.round(v*scale)));
  const extra={POSITION:p,TEXCOORD_0:Float32Array.from(uvs),NORMAL:packedNormal};const attributes:Record<string,GroundAttributeArray>={};
  for(const s of Object.keys(mesh.attributes)){const a=mesh.attributes[s]!,b=extra[s as keyof typeof extra],Constructor=a.constructor as {new(size:number):GroundAttributeArray},out=new Constructor(a.length+b.length);out.set(a);out.set(b,a.length);attributes[s]=out;}
  return{...mesh,attributes,indices:Uint32Array.from([...mesh.indices,...Array.from(idx,n=>n+mesh.attributes.POSITION!.length/3)])};
}

/** Ground/kerb items retain IDs/order. Every other collider is passed through as literal typed arrays. */
export function clipFrontierCollision(bytes:Uint8Array,options:FrontierClip){
  const old=parseCollisionBundle(bytes),stats:{id:string;inputTriangles:number;outputTriangles:number;changedTriangles:number;removedTriangles:number}[]=[];
  const colliders=old.colliders.map(c=>{if(c.group!=='ground'&&c.group!=='kerbs')return c;const clipped=clipFrontierMesh({attributes:{POSITION:c.positions},components:{POSITION:3},normalized:{POSITION:false},indices:c.indices},options);stats.push({id:c.id,...clipped.stats});return{...c,positions:clipped.mesh.attributes.POSITION as Float32Array,indices:clipped.mesh.indices,triangleTags:Uint16Array.from(clipped.sourceTriangles,i=>c.triangleTags[i]!)};});
  const out=encodeCollisionBundle(old.header,colliders),decoded=parseCollisionBundle(out);
  assert.deepEqual(decoded.colliders.map(c=>[c.id,c.group,c.ref]),old.colliders.map(c=>[c.id,c.group,c.ref]));
  for(let i=0;i<old.colliders.length;i++)if(old.colliders[i]!.group!=='ground'&&old.colliders[i]!.group!=='kerbs')for(const key of['positions','indices','triangleTags']as const)assert.deepEqual(decoded.colliders[i]![key],old.colliders[i]![key],'Non-ground collider changed');
  return{bytes:out,stats};
}
