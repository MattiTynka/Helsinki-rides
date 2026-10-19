// Explicit offline registration of an OSM shoreline against reviewed municipal terrestrial geometry.
// This never edits a raw source, buffers a coastline, or turns individual tree footprints into land.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import {clipCoastalGround,type CoastalMask,type CoastalClipGeometry} from './coastal-mask.ts';
import {bbox,cleanRing,ensureCcw,signedArea,loadGeoJsonPolygons,pointInPolygon,type LocalPolygon,type Pt} from './geometry.ts';
import {parseAppendRectangle,type AppendRectangle} from './append-city-cells.ts';
import {prepareNativeFrontier,frontierTriangleKey,type FrontierMesh} from './frontier-ground.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';
import type {TerrainGrid} from '../../../packages/world-schema/src/index.ts';
import type {GroundPiece} from './ground.ts';
import {sourceShoreSegments,qualifyCoastalShoreSeals} from './coastal-shore-seals.ts';
import {meshVerticalSeals} from './vertical-seal-mesh.ts';
export interface CoastalSourceRef {file:string;sha256:string}
export interface CoastalRegistrationPlan {
 schemaVersion:1;kind:'municipal-terrestrial-coastal-registration';
 sources:{streetParts:CoastalSourceRef;osm:CoastalSourceRef;origin:CoastalSourceRef;diagnosis:CoastalSourceRef;reference:CoastalSourceRef};
 sourceMaskSha256:string;newStrip:AppendRectangle;acceptedBounds:AppendRectangle;
 /** Full scope requires an explicitly reviewed exact conflict geometry, never a rectangular exception. */
 scope?:'complete-source-conflict';approvedCorrectionSha256?:string;
 terrestrialPart:'527816';waterVetoParts:readonly ['527803','527804'];coastlineWay:24629633;
}
export const coastalSha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])):value;
export const coastalMaskSha=(mask:CoastalMask)=>coastalSha(JSON.stringify(canonical(mask)));
export const coastalGeometry=(polygons:readonly LocalPolygon[]):CoastalClipGeometry=>polygons.map(p=>p.rings.map(r=>r.map(p=>[...p]as Pt)));
export const coastalArea=(g:CoastalClipGeometry)=>g.reduce((n,p)=>n+Math.abs(signedArea(p[0]!))-p.slice(1).reduce((s,r)=>s+Math.abs(signedArea(r)),0),0);
export const coastalRectangle=(r:AppendRectangle):CoastalClipGeometry=>[[[[r[0],-r[3]],[r[2],-r[3]],[r[2],-r[1]],[r[0],-r[1]]]]];
const polygons=(g:CoastalClipGeometry,prefix:string,properties:Record<string,unknown>):LocalPolygon[]=>g.map((p,i)=>{const rings=p.map((r,j)=>j?cleanRing(r):ensureCcw(cleanRing(r)));return{id:`${prefix}-${i}`,rings,bbox:bbox(rings),properties};});
const rectangle=(value:unknown,name:string):AppendRectangle=>{assert.ok(Array.isArray(value)&&value.length===4&&value.every(v=>typeof v==='number'&&Number.isFinite(v)),`${name} must contain finite coordinates`);return parseAppendRectangle(value.join(','));};
export function registerCoastalMask(mask:CoastalMask,parts:readonly LocalPolygon[],plan:CoastalRegistrationPlan){
 assert.equal(plan.schemaVersion,1);assert.equal(plan.kind,'municipal-terrestrial-coastal-registration');assert.equal(plan.terrestrialPart,'527816');assert.deepEqual(plan.waterVetoParts,['527803','527804']);assert.equal(plan.coastlineWay,24629633);assert.equal(coastalMaskSha(mask),plan.sourceMaskSha256,'Registration belongs to another original coastal mask');assert.ok(mask.sources.coastlineWays.includes(plan.coastlineWay),'Reviewed source coastline is absent');
 const strip=rectangle(plan.newStrip,'New strip'),accepted=rectangle(plan.acceptedBounds,'Accepted bounds');assert.ok(strip[0]===accepted[0]&&strip[2]===accepted[2]&&strip[3]===accepted[1]&&strip[1]<accepted[1],'Registration must be confined to the new full northern strip');
 assert.ok(strip[0]>=mask.area.minX&&strip[2]<=mask.area.maxX&&strip[1]>=mask.area.minZ&&strip[3]<=mask.area.maxZ,'Registration strip escapes its original mask');
 const select=(id:string)=>{const matches=parts.filter(p=>p.id===id);assert.equal(matches.length,1,`Municipal part ${id} must resolve uniquely`);return matches[0]!;},dry=select(plan.terrestrialPart),veto=plan.waterVetoParts.map(select);
 assert.equal(dry.properties.paatyyppi,'Nurmikot ja niityt','Terrestrial feature classification changed');assert.equal(dry.properties.alatyyppi,'C, niitto 2 x, jätettä ei poisteta','Terrestrial feature subtype changed');
 for(const p of veto){assert.equal(p.properties.paatyyppi,'Muut alueet','Water veto classification changed');assert.equal(p.properties.alatyyppi,'Merivesi-alue','Water veto subtype changed');}
 assert.ok(plan.scope===undefined||plan.scope==='complete-source-conflict','Unsupported coastal registration scope');const full=plan.scope==='complete-source-conflict';
 const boundedDry=full?coastalGeometry([dry]):polygonClipping.intersection(coastalGeometry([dry]),coastalRectangle(strip))as CoastalClipGeometry,vetoGeometry=coastalGeometry(veto),eligible=polygonClipping.difference(boundedDry,vetoGeometry)as CoastalClipGeometry,correctionGeometry=polygonClipping.intersection(coastalGeometry(mask.water),eligible)as CoastalClipGeometry,acceptedCorrection=polygonClipping.intersection(correctionGeometry,coastalRectangle(accepted))as CoastalClipGeometry;
 assert.ok(coastalArea(correctionGeometry)>1e-8,'Registration has no source water/terrestrial conflict');assert.ok(coastalArea(polygonClipping.intersection(correctionGeometry,vetoGeometry)as CoastalClipGeometry)<1e-8,'Registration changes explicit municipal water');
 if(full)assert.equal(coastalSha(JSON.stringify(correctionGeometry)),plan.approvedCorrectionSha256,'Full false-water correction differs from its reviewed exact component');else assert.ok(coastalArea(acceptedCorrection)<1e-8,'Registration changes accepted water classifications');
 const water=mask.water.flatMap(p=>{const original=coastalGeometry([p]),hit=polygonClipping.intersection(original,correctionGeometry)as CoastalClipGeometry;if(coastalArea(hit)<1e-10)return[p];return polygons(polygonClipping.difference(original,correctionGeometry)as CoastalClipGeometry,`${p.id}-municipal-527816`,{...p.properties,registration:'Exact municipal terrestrial part 527816; explicit municipal water vetoes retained'});});
 const corrected:CoastalMask={...mask,water,stats:{...mask.stats,waterArea:coastalArea(coastalGeometry(water))}};
 const acceptedBefore=polygonClipping.intersection(coastalGeometry(mask.water),coastalRectangle(accepted))as CoastalClipGeometry,acceptedAfter=polygonClipping.intersection(coastalGeometry(water),coastalRectangle(accepted))as CoastalClipGeometry,acceptedDifference=polygonClipping.xor(acceptedBefore,acceptedAfter)as CoastalClipGeometry;assert.ok(coastalArea(polygonClipping.xor(acceptedDifference,acceptedCorrection)as CoastalClipGeometry)<1e-8,'Accepted mask changed outside the exact reviewed false-water component');
 const correction=polygons(correctionGeometry,'registered-municipal-land-527816',{source:'City of Helsinki municipal terrestrial part',part:'527816'}),bounds=bbox(correction.flatMap(p=>p.rings)),affectedBounds:[number,number,number,number]=[bounds[0],-bounds[3],bounds[2],-bounds[1]],scopeBounds:AppendRectangle=full?[mask.area.minX,mask.area.minZ,mask.area.maxX,mask.area.maxZ]:strip,patchRegion:AppendRectangle=[Math.max(scopeBounds[0],Math.floor(affectedBounds[0])),Math.max(scopeBounds[1],Math.floor(affectedBounds[1])),Math.min(scopeBounds[2],Math.ceil(affectedBounds[2])),Math.min(scopeBounds[3],Math.ceil(affectedBounds[3]))];
 return{mask:corrected,correction,patchRegion,audit:{method:'OSM water intersected with exact municipal terrestrial 527816, minus explicit municipal water 527803/527804; no coast buffer or tree disks',scope:full?'complete-source-conflict':'new-strip',sourceMaskSha256:coastalMaskSha(mask),correctedMaskSha256:coastalMaskSha(corrected),correctionGeometrySha256:coastalSha(JSON.stringify(correctionGeometry)),correctedAreaSquareMetres:coastalArea(correctionGeometry),acceptedFalseWaterCorrectionAreaSquareMetres:coastalArea(acceptedCorrection),affectedBounds,patchRegion,acceptedClassificationsAreaExact:!full,acceptedClassificationsUnchangedOutsideQualifiedFalseWater:true,municipalWaterVetoAreaExact:true,terrestrialPart:dry.id,waterVetoParts:veto.map(p=>p.id)}};
}
export function loadCoastalRegistration(file:string,mask:CoastalMask,originProjected:readonly number[],context?:{streetPartsSha256?:string;osmSha256?:string}){
 const planBytes=fs.readFileSync(file),plan=JSON.parse(planBytes.toString())as CoastalRegistrationPlan;assert.ok(plan.sources&&Object.keys(plan.sources).sort().join(',')==='diagnosis,origin,osm,reference,streetParts','Complete coastal registration source bindings required');
 const sourceBytes=Object.fromEntries(Object.entries(plan.sources).map(([name,ref])=>{assert.ok(typeof ref.file==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256),'Invalid coastal source receipt');const bytes=fs.readFileSync(ref.file);assert.equal(coastalSha(bytes),ref.sha256,`Coastal source changed: ${ref.file}`);return[name,bytes];}));
 if(context?.streetPartsSha256)assert.equal(plan.sources.streetParts.sha256,context.streetPartsSha256,'Registration uses another municipal register');if(context?.osmSha256)assert.equal(plan.sources.osm.sha256,context.osmSha256,'Registration uses another OSM snapshot');
 const origin=JSON.parse(sourceBytes.origin!.toString());assert.deepEqual(origin.originProjected,Array.from(originProjected),'Registration uses another coordinate origin');const osm=JSON.parse(sourceBytes.osm!.toString());assert.ok(osm.elements.some((e:{type:string;id:number;tags?:Record<string,string>})=>e.type==='way'&&e.id===plan.coastlineWay&&e.tags?.natural==='coastline'),'Registered coastline identity changed');
 const parts=loadGeoJsonPolygons(plan.sources.streetParts.file,originProjected[0]!,originProjected[1]!,p=>String(p.osan_id)),result=registerCoastalMask(mask,parts,plan);
 return{...result,plan,receipt:{file,sha256:coastalSha(planBytes)},sources:plan.sources};
}

/** Subtract an exact planar mask from selected triangles, carrying all raw attributes together.
 * Unselected and untouched triangles retain every raw value and their original winding. */
export function subtractCoastalLand(mesh:FrontierMesh,land:readonly LocalPolygon[],select:(triangle:number)=>boolean=()=>true){
 const semantics=Object.keys(mesh.attributes),values=Object.fromEntries(semantics.map(s=>[s,[]as number[]])),indices:number[]=[],sourceTriangles:number[]=[],cuts=coastalGeometry(land);let changedTriangles=0;
 assert.equal(mesh.components.POSITION,3);assert.ok(mesh.attributes.POSITION instanceof Float32Array);assert.equal(mesh.indices.length%3,0);
 const emit=(ids:number[],source:number)=>{for(const id of ids){indices.push(values.POSITION!.length/3);for(const s of semantics){const n=mesh.components[s]!;values[s]!.push(...mesh.attributes[s]!.subarray(id*n,(id+1)*n));}}sourceTriangles.push(source);};
 for(let t=0;t<mesh.indices.length/3;t++){
  const ids=Array.from(mesh.indices.subarray(t*3,t*3+3)),points=ids.map(i=>[mesh.attributes.POSITION![i*3]!, -mesh.attributes.POSITION![i*3+2]!]as Pt),area=signedArea(points);
  if(!select(t)||Math.abs(area)<1e-12||coastalArea(polygonClipping.intersection([[points]],cuts)as CoastalClipGeometry)<1e-10){emit(ids,t);continue;}changedTriangles++;
  const rest=polygonClipping.difference([[points]],cuts)as CoastalClipGeometry,[a,b,c]=points,den=(b![1]-c![1])*(a![0]-c![0])+(c![0]-b![0])*(a![1]-c![1]);
  for(const polygon of rest){const flat:number[]=[],holes:number[]=[];for(const[r,ring]of polygon.entries()){if(r)holes.push(flat.length/2);for(const p of cleanRing(ring))flat.push(...p);}const face=earcut(flat,holes,2);
   for(let j=0;j<face.length;j+=3){const raw=[face[j]!,face[j+1]!,face[j+2]!],cross=signedArea(raw.map(i=>[flat[i*2]!,flat[i*2+1]!]));if((cross<0)!==(area<0))[raw[1],raw[2]]=[raw[2]!,raw[1]!];
    for(const id of raw){const x=flat[id*2]!,n=flat[id*2+1]!,u=((b![1]-c![1])*(x-c![0])+(c![0]-b![0])*(n-c![1]))/den,v=((c![1]-a![1])*(x-c![0])+(a![0]-c![0])*(n-c![1]))/den,weights=[u,v,1-u-v];indices.push(values.POSITION!.length/3);
     for(const s of semantics){const count=mesh.components[s]!,source=mesh.attributes[s]!;for(let k=0;k<count;k++){let value=ids.reduce((sum,index,j)=>sum+weights[j]!*source[index*count+k]!,0);if(s==='POSITION'&&k===0)value=x;if(s==='POSITION'&&k===2)value=-n;if(!(source instanceof Float32Array))value=Math.round(value);values[s]!.push(value);}}
    }sourceTriangles.push(t);
   }
  }
 }
 const attributes=Object.fromEntries(semantics.map(s=>{const Type=mesh.attributes[s]!.constructor as {new(values:ArrayLike<number>):GroundAttributeArray};return[s,new Type(values[s]!)];}));return{mesh:{...mesh,attributes,indices:Uint32Array.from(indices)},sourceTriangles,changedTriangles};
}

export type CoastalFloorTriangle=readonly [readonly number[],readonly number[],readonly number[]];
/** Additive native soil, exactly intersected with the reviewed former-water polygon. Existing dry
 * geometry is never selected. Only the new bank's real canonical shore receives vertical closures. */
export function buildRegisteredBank(pieces:readonly GroundPiece[],registration:ReturnType<typeof registerCoastalMask>,waterY:number){
 const area=registration.mask.area,extent:AppendRectangle=[area.minX,area.minZ,area.maxX,area.maxZ],outside=polygonClipping.difference(coastalRectangle(extent),coastalGeometry(registration.correction))as CoastalClipGeometry,mask:CoastalMask={...registration.mask,water:polygons(outside,'outside-registered-bank',{})};
 const floors=pieces.flatMap(p=>{const indices:number[]=[];for(let i=0;i<p.indices.length;i+=3){const points=[0,1,2].map(k=>{const id=p.indices[i+k]!;return[p.positions[id*3]!,p.positions[id*3+2]!]as Pt;});if(Math.abs(signedArea(points))>1e-10)indices.push(...p.indices.slice(i,i+3));}return indices.length?[{...p,indices}]:[];}),clipped=clipCoastalGround(floors,mask),prepared=prepareNativeFrontier(clipped.pieces),bank=prepared.pieces,colliding=new Set<string>();
 for(const p of bank)if(p.use!=='visual')for(let i=0;i<p.indices.length;i+=3)colliding.add(frontierTriangleKey([0,1,2].map(k=>Array.from(Float32Array.from(p.positions.slice(p.indices[i+k]!*3,p.indices[i+k]!*3+3))))));
 const meshes=bank.flatMap((p,i)=>p.use==='collision'?[]:[{cell:p.cell,primitiveName:`${p.cell}_registered_bank_ground_${p.finish}_${i}`,primitiveIndex:0,positions:Float32Array.from(p.positions),indices:Uint32Array.from(p.indices)}]),segments=sourceShoreSegments(registration.mask.water,area),qualified=qualifyCoastalShoreSeals(meshes,segments,[],waterY),shores:GroundPiece[]=[];
 for(const seal of qualified.seals){const m=meshes.find(m=>m.primitiveName===seal.primitiveName)!;for(const t of seal.source.visualTriangles)assert.ok(colliding.has(frontierTriangleKey([0,1,2].map(k=>Array.from(m.positions.subarray(m.indices[t*3+k]!*3,m.indices[t*3+k]!*3+3))))),'Bank shoreline is not bound to an exact native collision floor');
  const length=Math.hypot(seal.top[1][0]-seal.top[0][0],seal.top[1][2]-seal.top[0][2]),face=meshVerticalSeals([{top:seal.top,bottom:seal.bottom,polygon:[[seal.top[0],seal.top[1],seal.bottom[1],seal.bottom[0]]],section:[[[0,seal.top[0][1]],[length,seal.top[1][1]],[length,seal.bottom[1][1]],[0,seal.bottom[0][1]]]]}]),positions:number[]=[],uvs:number[]=[],indices:number[]=[];for(const id of face.indices){indices.push(positions.length/3);positions.push(...face.positions.slice(id*3,id*3+3));uvs.push(...face.uvs.slice(id*2,id*2+2));}if(indices.length)shores.push({cell:seal.cell,finish:'yard',level:'raised',tag:'registered-bank-shore',positions,uvs,indices});
 }
 return{pieces:[...bank,...shores],floorPieces:bank,shorePieces:shores,proof:{sourceCorrection:registration.audit.correctionGeometrySha256,clipped:clipped.clipped,precisionRetries:clipped.precisionRetryWitnesses,discardedFloat32ZeroArea:prepared.discarded,shoreQualification:{...qualified,method:'Existing canonical shore qualification over ONLY additive source-corrected native bank meshes; no accepted-coast protection disabled and no artificial expansion-boundary wall'},nativeFloorTriangles:bank.reduce((n,p)=>n+p.indices.length/3,0),shoreTriangles:shores.reduce((n,p)=>n+p.indices.length/3,0)}};
}
/** Restore only new, source-corrected dry safety samples. Every adjacent 1m field cell must be dry and
 * covered by BOTH actual serialized visual and HCOL floors. Caps use the lowest intersecting floor,
 * so every possible heightfield diagonal stays below that floor after the native -0.4m translation. */
export function restoreCoastalFallback(current:TerrainGrid,native:TerrainGrid,registration:ReturnType<typeof registerCoastalMask>,strip:AppendRectangle,visual:readonly CoastalFloorTriangle[],collision:readonly CoastalFloorTriangle[],safetyY:number){
 for(const key of['x0','z0','resolution','nx','nz']as const)assert.equal(native[key],current[key],'Native safety grid differs');assert.ok(Number.isFinite(safetyY));assert.ok(current.heights.every(Number.isFinite)&&native.heights.every(Number.isFinite));const heights=current.heights.slice(),r=current.resolution,land=coastalGeometry(registration.correction),water=coastalGeometry(registration.mask.water),cache=new Map<string,{pass:boolean;x:number;z:number;minimumFloor:number;visualArea:number;collisionArea:number}>();
 function support(triangles:readonly CoastalFloorTriangle[],box:CoastalClipGeometry){let combined:CoastalClipGeometry=[],minimum=Infinity;const bounds=bbox(box.flatMap(p=>p));for(const p of triangles){if(Math.max(p[0][0]!,p[1][0]!,p[2][0]!)<=bounds[0]||Math.min(p[0][0]!,p[1][0]!,p[2][0]!)>=bounds[2]||Math.max(-p[0][2]!,-p[1][2]!,-p[2][2]!)<=bounds[1]||Math.min(-p[0][2]!,-p[1][2]!,-p[2][2]!)>=bounds[3])continue;const ring=p.map(v=>[v[0]!,-v[2]!]as Pt),area=signedArea(ring);if(Math.abs(area)<1e-12)continue;const hit=polygonClipping.intersection([[ring]],box)as CoastalClipGeometry;if(coastalArea(hit)<1e-12)continue;combined=combined.length?polygonClipping.union(combined,hit)as CoastalClipGeometry:hit;const[a,b,c]=ring,den=(b![1]-c![1])*(a![0]-c![0])+(c![0]-b![0])*(a![1]-c![1]);for(const polygon of hit)for(const ring of polygon)for(const[x,n]of ring){const u=((b![1]-c![1])*(x-c![0])+(c![0]-b![0])*(n-c![1]))/den,v=((c![1]-a![1])*(x-c![0])+(a![0]-c![0])*(n-c![1]))/den;minimum=Math.min(minimum,u*p[0][1]!+v*p[1][1]!+(1-u-v)*p[2][1]!);}}return{area:coastalArea(combined),minimum};}
 function cell(ix:number,iz:number){const key=`${ix}:${iz}`,old=cache.get(key);if(old)return old;const x=current.x0+ix*r,z=current.z0+iz*r,box=coastalRectangle([x,z,x+r,z+r]);let row={pass:false,x,z,minimumFloor:-Infinity,visualArea:0,collisionArea:0};
  if(ix>=0&&iz>=0&&ix+1<current.nx&&iz+1<current.nz&&x>=strip[0]&&x+r<=strip[2]&&z>=strip[1]&&z+r<strip[3]&&coastalArea(polygonClipping.intersection(box,land)as CoastalClipGeometry)>=r*r-1e-8&&coastalArea(polygonClipping.intersection(box,water)as CoastalClipGeometry)<1e-10){const a=support(visual,box),b=support(collision,box);row={...row,visualArea:a.area,collisionArea:b.area,minimumFloor:Math.min(a.minimum,b.minimum),pass:a.area>=r*r-1e-8&&b.area>=r*r-1e-8};}cache.set(key,row);return row;
 }
 const changes:{x:number;z:number;previous:number;next:number}[]=[],skipped:{x:number;z:number;reason:string}[]=[];
 const bounds=registration.audit.affectedBounds;
 for(let iz=0;iz<current.nz;iz++)for(let ix=0;ix<current.nx;ix++){const i=iz*current.nx+ix,x=current.x0+ix*r,z=current.z0+iz*r;if(x<strip[0]||x>strip[2]||z<strip[1]||z>=strip[3]||x<bounds[0]||x>bounds[2]||z<bounds[1]||z>bounds[3]||native.heights[i]!<=current.heights[i]!||!registration.correction.some(p=>pointInPolygon([x,-z],p.rings)))continue;assert.ok(current.heights[i]!<=safetyY+.00001,'Corrected source water safety sample was not below the water safety plane');const adjacent=[cell(ix-1,iz-1),cell(ix,iz-1),cell(ix-1,iz),cell(ix,iz)];if(adjacent.some(p=>!p.pass)){skipped.push({x,z,reason:'A complete adjacent grid cell is not registered dry land with exact visual and HCOL coverage'});continue;}const next=Math.fround(Math.min(native.heights[i]!,Math.min(...adjacent.map(p=>p.minimumFloor))+.35));if(next<=current.heights[i]!)continue;heights[i]=next;changes.push({x,z,previous:current.heights[i]!,next});}
 const raisedCells=new Set<string>();for(const p of changes){const ix=Math.round((p.x-current.x0)/r),iz=Math.round((p.z-current.z0)/r);for(const[x,z]of[[ix-1,iz-1],[ix,iz-1],[ix-1,iz],[ix,iz]])raisedCells.add(`${x}:${z}`);}
 const proof=[...raisedCells].map(key=>{const[ix,iz]=key.split(':').map(Number),row=cell(ix!,iz!),ids=[iz!*current.nx+ix!,iz!*current.nx+ix!+1,(iz!+1)*current.nx+ix!,(iz!+1)*current.nx+ix!+1],maximumColliderY=Math.max(...ids.map(i=>heights[i]!))-.4;assert.ok(row.pass&&maximumColliderY<=row.minimumFloor+1e-6,'Registered land safety field exceeds an actual native floor');return{...row,maximumColliderY,clearance:row.minimumFloor-maximumColliderY};});
 return{terrain:{...current,heights},changes,skipped,proof,method:'Only registered new-strip dry samples can rise; all four adjacent cells require exact source-land and actual serialized visual/HCOL coverage; heightfield corners capped below native floors with the runtime -0.4m translation'};
}
