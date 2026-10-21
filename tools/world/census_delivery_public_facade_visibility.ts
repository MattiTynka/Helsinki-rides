// Representative visibility from source-public paths, actual floors and native GLBs.
// A failed bounded camera search is explicitly unresolved, never proof of absence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {geodeticToGk25,gk25ToGeodetic,validateWorldManifest,type CellDescriptor,type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {sourceBuildingFaces} from './census_delivery_new_area_facades.ts';
import {readFacadeChartTriangles} from './lib/facade-chart-glb.ts';
import {deliveryFacadeImages} from './apply_delivery_facade_charts.ts';
import {readDeliveryFile} from './lib/delivery-city.ts';
import {deliverySha as sha} from './lib/delivery-city-payloads.ts';
import {DeliveryGroundSampler} from './lib/delivery-city-ground-sampler.ts';
import {classifyFacadeTriangle,facadeRayIntersection,type CensusTriangle,type CensusPoint} from './lib/delivery-new-area-facades.ts';

type NativeFace=Awaited<ReturnType<typeof readFacadeChartTriangles>>[number];
type Axis={id:number;segment:number;name:string;highway:string;a:readonly[number,number];b:readonly[number,number]};
const binKey=(x:number,z:number)=>`${Math.floor(x/8)},${Math.floor(z/8)}`;
function sampleHeight(t:CensusTriangle,x:number,z:number) {
  const c=classifyFacadeTriangle(t);if(c.normal[1]<.5)return null;
  const[a,b,d]=t,den=(b[2]-d[2])*(a[0]-d[0])+(d[0]-b[0])*(a[2]-d[2]);if(Math.abs(den)<1e-12)return null;
  const u=((b[2]-d[2])*(x-d[0])+(d[0]-b[0])*(z-d[2]))/den,v=((d[2]-a[2])*(x-d[0])+(a[0]-d[0])*(z-d[2]))/den;
  return u< -1e-7||v< -1e-7||u+v>1+1e-7?null:u*a[1]+v*b[1]+(1-u-v)*d[1];
}
class NativeScene {
  private readonly cache=new Map<string,{faces:NativeFace[];bins:Map<string,number[]>;keys:Set<string>}>();
  private readonly world:string;private readonly manifest:WorldManifest;
  private readonly ownerBounds:{cell:CellDescriptor;bounds:number[]}[];
  constructor(world:string,manifest:WorldManifest){this.world=world;this.manifest=manifest;this.ownerBounds=manifest.cells.map(cell=>{const b=[...cell.boundsXZ];for(const building of cell.buildings){b[0]=Math.min(b[0]!,building.boundsRuntime.min[0]);b[1]=Math.min(b[1]!,building.boundsRuntime.min[2]);b[2]=Math.max(b[2]!,building.boundsRuntime.max[0]);b[3]=Math.max(b[3]!,building.boundsRuntime.max[2]);}return{cell,bounds:b};});}
  private async cell(c:CellDescriptor) {
    let result=this.cache.get(c.id);if(result){this.cache.delete(c.id);this.cache.set(c.id,result);return result;}
    const ref=c.visual.lod0,bytes=readDeliveryFile(this.world,ref),faces=await readFacadeChartTriangles(bytes,deliveryFacadeImages(this.world,ref,bytes,this.manifest.sharedTextures??[])),bins=new Map<string,number[]>();
    for(const[i,f]of faces.entries()) {
      const xs=f.points.map(p=>p[0]),zs=f.points.map(p=>p[2]);
      for(let x=Math.floor(Math.min(...xs)/8);x<=Math.floor(Math.max(...xs)/8);x++)for(let z=Math.floor(Math.min(...zs)/8);z<=Math.floor(Math.max(...zs)/8);z++) {
        const key=`${x},${z}`,rows=bins.get(key)??[];rows.push(i);bins.set(key,rows);
      }
    }
    result={faces,bins,keys:new Set(faces.map(f=>f.key))};this.cache.set(c.id,result);while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value!);return result;
  }
  async hasSourceFace(owner:string,key:string){const c=this.manifest.cells.find(c=>c.id===owner);assert.ok(c);return(await this.cell(c)).keys.has(key);}
  private owners(minX:number,minZ:number,maxX:number,maxZ:number) {
    return this.ownerBounds.filter(({bounds:b})=>b[0]!<=maxX&&b[2]!>=minX&&b[1]!<=maxZ&&b[3]!>=minZ).map(r=>r.cell);
  }
  async floor(x:number,z:number) {
    const hits:{y:number;cell:string;key:string;node:string}[]=[];
    for(const owner of this.owners(x,z,x,z)) {
      const entry=await this.cell(owner);for(const i of entry.bins.get(binKey(x,z))??[]) {
        const f=entry.faces[i]!;if(!/_ground|_kerb|_stair/.test(f.node))continue;
        const y=sampleHeight(f.points,x,z);if(y!==null)hits.push({y,cell:owner.id,key:f.key,node:f.node});
      }
    }
    return hits.sort((a,b)=>b.y-a.y);
  }
  async firstBlocker(from:CensusPoint,to:CensusPoint,targetKey:string) {
    const keys=new Set<string>();for(let t=0;t<=1.000001;t+=1/Math.max(1,Math.ceil(Math.hypot(to[0]-from[0],to[2]-from[2])/3))) {
      const x=from[0]+(to[0]-from[0])*t,z=from[2]+(to[2]-from[2])*t;
      for(const dx of[-.001,0,.001])for(const dz of[-.001,0,.001])keys.add(binKey(x+dx,z+dz));
    }
    let best:{cell:string;node:string;key:string;fraction:number}|null=null;
    for(const owner of this.owners(Math.min(from[0],to[0]),Math.min(from[2],to[2]),Math.max(from[0],to[0]),Math.max(from[2],to[2]))) {
      const entry=await this.cell(owner),ids=new Set<number>();for(const key of keys)for(const i of entry.bins.get(key)??[])ids.add(i);
      for(const i of ids){const f=entry.faces[i]!;if(f.key===targetKey)continue;const t=facadeRayIntersection(from,to,f.points);if(t!==null&&(!best||t<best.fraction))best={cell:owner.id,node:f.node,key:f.key,fraction:t};}
    }
    return best;
  }
}
function candidateCameras(target:CensusPoint,normal:readonly number[],axes:readonly Axis[],maximum:number) {
  const candidates=[];
  for(const axis of axes) {
    const dx=axis.b[0]-axis.a[0],dz=axis.b[1]-axis.a[1],len=Math.hypot(dx,dz);if(!len)continue;
    const t=Math.max(0,Math.min(1,((target[0]-axis.a[0])*dx+(target[2]-axis.a[1])*dz)/(len*len)));
    for(const along of[0,-6,6]) {
      const u=Math.max(0,Math.min(1,t+along/len)),x=axis.a[0]+u*dx,z=axis.a[1]+u*dz,distance=Math.hypot(x-target[0],z-target[2]);
      if(distance<1||distance>maximum)continue;
      const facing=(normal[0]!*(x-target[0])+normal[2]!*(z-target[2]))/distance;if(facing<.2)continue;
      candidates.push({axis:{id:axis.id,segment:axis.segment,name:axis.name,highway:axis.highway},x,z,distance,facing});
    }
  }
  const unique=new Map<string,typeof candidates[number]>();for(const c of candidates)unique.set(`${Math.round(c.x*100)},${Math.round(c.z*100)}`,c);
  return[...unique.values()].sort((a,b)=>a.distance-b.distance||b.facing-a.facing);
}
export async function censusPublicFacadeVisibility(a:{world:string;expected:string;remaining:string;remainingSha256:string;north:string;south:string;osm:string;osmSha256:string;out:string;maximumCameraDistance:number}) {
  assert.ok(!fs.existsSync(a.out));assert.ok(a.maximumCameraDistance>=45&&a.maximumCameraDistance<=100);
  const bytes=fs.readFileSync(path.join(a.world,'manifest.json'));assert.equal(sha(bytes),a.expected);const m=JSON.parse(bytes.toString())as WorldManifest;assert.deepEqual(validateWorldManifest(m),[]);
  const rb=fs.readFileSync(a.remaining);assert.equal(sha(rb),a.remainingSha256);const remaining=JSON.parse(rb.toString());assert.equal(remaining.buildings,remaining.records.length);
  const ob=fs.readFileSync(a.osm);assert.equal(sha(ob),a.osmSha256);const osm=JSON.parse(ob.toString()),nodes=new Map<number,readonly[number,number]>(osm.elements.filter((e:any)=>e.type==='node').map((e:any)=>{const[E,N]=geodeticToGk25(e.lat,e.lon);return[e.id,[E-m.origin.originProjected[0],m.origin.originProjected[1]-N]];})),axes:Axis[]=[];
  for(const w of osm.elements.filter((e:any)=>e.type==='way'&&['trunk','primary','secondary','tertiary','residential','living_street','unclassified','pedestrian','footway','cycleway','path'].includes(e.tags?.highway)&&!['private','no','customers'].includes(e.tags?.access)&&e.tags?.area!=='yes'&&e.tags?.tunnel!=='yes'))for(let i=1;i<w.nodes.length;i++) {
    const p=nodes.get(w.nodes[i-1]),q=nodes.get(w.nodes[i]);assert.ok(p&&q);axes.push({id:w.id,segment:i-1,name:w.tags.name??'',highway:w.tags.highway,a:p,b:q});
  }
  const sources=new Map<string,{city:any;binary:Buffer;citySha256:string;binarySha256:string}>();for(const[band,dir]of[['north',a.north],['south',a.south]]as const) {
    const cb=fs.readFileSync(path.join(dir,'city-model.json')),city=JSON.parse(cb.toString()),binary=fs.readFileSync(path.join(dir,city.binary.file));assert.equal(sha(binary),city.binary.sha256);assert.equal(city.originId,m.origin.id);sources.set(band,{city,binary,citySha256:sha(cb),binarySha256:sha(binary)});
  }
  const scene=new NativeScene(a.world,m),floor=new DeliveryGroundSampler(a.world,m.cells),records:any[]=[];
  const checkpoint=a.out+'.checkpoint.jsonl',header={schemaVersion:1,manifestSha256:a.expected,remainingSha256:a.remainingSha256,osmSha256:a.osmSha256,maximumCameraDistance:a.maximumCameraDistance,sourceCodeSha256:sha(fs.readFileSync(fileURLToPath(import.meta.url)))};
  fs.mkdirSync(path.dirname(a.out),{recursive:true});
  if(fs.existsSync(checkpoint)){const lines=fs.readFileSync(checkpoint,'utf8').trimEnd().split('\n');assert.deepEqual(JSON.parse(lines[0]!),header,'Checkpoint inputs or algorithm changed');for(const line of lines.slice(1))records.push(JSON.parse(line));}
  else fs.writeFileSync(checkpoint,JSON.stringify(header)+'\n',{flag:'wx'});
  assert.equal(new Set(records.map(r=>r.id)).size,records.length);const completed=new Set(records.map(r=>r.id));
  for(const r of remaining.records) {
    if(completed.has(r.id))continue;
    const source=sources.get(r.band)!;assert.equal(source.citySha256,r.sourceCitySha256);assert.equal(source.binarySha256,r.sourceBinarySha256);const buildings=source.city.buildings.filter((b:any)=>b.id===r.id&&b.vtj===r.vtj);assert.equal(buildings.length,1);
    const sourceFaces=sourceBuildingFaces(buildings[0],source.binary).filter(f=>f.texture===null&&f.kind==='wall'),faces=[];
    for(const f of sourceFaces) {
      if(!await scene.hasSourceFace(r.owner,f.key)){faces.push({part:f.part,triangle:f.triangle,key:f.key,area:f.area,normal:f.normal,centre:f.centre,height:Math.max(...f.points.map(p=>p[1]))-Math.min(...f.points.map(p=>p[1])),status:'EXACT_SOURCE_KEY_ABSENT_FROM_CURRENT_NEAR_OWNER',attemptedCameras:0,availableCameras:0,visible:null,failures:[{reason:'SOURCE_NATIVE_TIER_IDENTITY_REQUIRES_DISPOSITION',count:1,example:{owner:r.owner}}]});continue;}
      const candidates=candidateCameras(f.centre,f.normal,axes,a.maximumCameraDistance),failures:{reason:string;count:number;example:unknown}[]=[];let visible:unknown=null,attempts=0;
      function fail(reason:string,example:unknown){const old=failures.find(v=>v.reason===reason);if(old)old.count++;else failures.push({reason,count:1,example});}
      for(const c of candidates) {
        attempts++;const hits=floor.at(c.x,c.z);if(!hits.length){fail('NO_NATIVE_HCOL_PUBLIC_FLOOR',c);continue;}
        const h=hits.at(-1)!,visuals=await scene.floor(c.x,c.z),visual=visuals[0];if(!visual||Math.abs(visual.y-h.height)>.0001){fail('VISUAL_HCOL_FLOOR_MISMATCH',{camera:c,collision:h,visual:visual??null});continue;}
        const eye:[number,number,number]=[c.x,h.height+1.7,c.z],blocker=await scene.firstBlocker(eye,f.centre,f.key);
        if(blocker){fail('OCCLUDED_BY_EXACT_NATIVE_GLTF_FACE',{camera:c,eye,blocker});continue;}
        const[lat,lon]=gk25ToGeodetic(c.x+m.origin.originProjected[0],m.origin.originProjected[1]-c.z),heading=(Math.atan2(f.centre[0]-c.x,c.z-f.centre[2])*180/Math.PI+360)%360;
        visible={camera:c,eye,collision:h,visual,target:f.centre,lat,lon,heading,streetViewLookup:`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}&heading=${heading}`};break;
      }
      faces.push({part:f.part,triangle:f.triangle,key:f.key,area:f.area,normal:f.normal,centre:f.centre,height:Math.max(...f.points.map(p=>p[1]))-Math.min(...f.points.map(p=>p[1])),status:visible?'REPRESENTATIVE_WALL_POINT_VISIBLE_FROM_SOURCE_PUBLIC_PATH':'NO_VERIFIED_CAMERA_MANUAL_ROLE_DISPOSITION_REQUIRED',attemptedCameras:attempts,availableCameras:candidates.length,visible,failures});
    }
    const visible=faces.filter(f=>f.visible),large=visible.filter(f=>f.area>3&&f.height>3),record={id:r.id,vtj:r.vtj,address:r.address,band:r.band,owner:r.owner,bounds:r.boundsRuntime,sourceCitySha256:source.citySha256,sourceBinarySha256:source.binarySha256,nullWallArea:sourceFaces.reduce((s,f)=>s+f.area,0),representativeVisibleWallArea:visible.reduce((s,f)=>s+f.area,0),status:large.length?'VISIBLE_FACADE_REQUIRES_INDIVIDUAL_REFERENCE_AND_ART':visible.length?'VISIBLE_LOW_OR_SMALL_WALL_REQUIRES_PLAIN_FINISH_REFERENCE':'UNRESOLVED_BOUNDED_CAMERA_FAILURE_IS_NOT_ABSENCE',faces};
    records.push(record);fs.appendFileSync(checkpoint,JSON.stringify(record)+'\n');console.log(JSON.stringify({vtj:r.vtj,owner:r.owner,faces:faces.length,visible:visible.length,status:record.status}));
  }
  const result={schemaVersion:1,status:'COMPLETE_BOUNDED_PUBLIC_CAMERA_CENSUS_REFERENCE_DISPOSITIONS_PENDING',manifestSha256:a.expected,remainingSha256:a.remainingSha256,osmSha256:a.osmSha256,policy:{maximumCameraDistanceMetres:a.maximumCameraDistance,eyeHeightMetres:1.7,visualHcolFloorToleranceMetres:.0001,maximumCachedNativeCells:8,allNearbyPublicSegmentsConsidered:true,geometryIncludesTexturedWallsAndGround:true,vegetationExcludedFromOcclusion:true,failedSearchProvesAbsence:false,representativePointProvesWholeFace:false},counts:Object.fromEntries([...new Set(records.map(r=>r.status))].map(status=>[status,records.filter(r=>r.status===status).length])),records};
  const output=Buffer.from(JSON.stringify(result)+'\n');fs.mkdirSync(path.dirname(a.out),{recursive:true});fs.writeFileSync(a.out,output,{flag:'wx'});assert.equal(sha(fs.readFileSync(path.join(a.world,'manifest.json'))),a.expected);return{sha256:sha(output),buildings:records.length,counts:result.counts};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options:Record<string,{type:'string';default?:string}>={...Object.fromEntries(['world','expected','remaining','remaining-sha256','north','south','osm','osm-sha256','out'].map(k=>[k,{type:'string'as const}])),'maximum-camera-distance':{type:'string',default:'60'}};const{values}=parseArgs({options});
  for(const k of['world','expected','remaining','remaining-sha256','north','south','osm','osm-sha256','out'])assert.ok(values[k]);
  console.log(JSON.stringify(await censusPublicFacadeVisibility({world:values.world!,expected:values.expected!,remaining:values.remaining!,remainingSha256:values['remaining-sha256']!,north:values.north!,south:values.south!,osm:values.osm!,osmSha256:values['osm-sha256']!,out:values.out!,maximumCameraDistance:Number(values['maximum-camera-distance'])})));
}
