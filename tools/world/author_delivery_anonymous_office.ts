import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {OriginalWallArt,chartForSourceTriangles} from './author_senate_facade_charts.ts';
import {sourceBuildingFaces} from './census_delivery_new_area_facades.ts';
import {chartInProjectedElevation} from './lib/delivery-new-area-facades-bulevardi.ts';
import {renderAnonymousOffice,renderAnonymousOfficeCorner} from './lib/delivery-anonymous-office-art.ts';
import {authorObservedFacadeFinish} from './author_delivery_observed_facade_finish.ts';
import {readObservedWallFinish} from './lib/delivery-new-area-facades-observed-finish.ts';
import {probeHameentieStreetGround} from './author_delivery_hameentie_facades.ts';
import {deliverySha as sha} from './lib/delivery-city-payloads.ts';
import {validateWorldManifest} from '../../packages/world-schema/src/index.ts';
import type {DeliveryFacadeProfile} from './apply_delivery_facade_charts.ts';

export async function authorAnonymousOffice(o:{plan:string;cityModel:string;world:string;expected:string;out:string}) {
  assert.ok(!fs.existsSync(o.out));const pb=fs.readFileSync(o.plan),p=JSON.parse(pb.toString());
  if(p.side==='corner')return authorAnonymousOfficeCorner(o,p,pb);
  assert.equal(p.schemaVersion,1);assert.equal(p.building.id,'BID_96ce40d5-24d8-4d90-a39d-58976af1a24d');assert.equal(p.building.vtj,null);assert.equal(p.building.owner,'c_m03_p04');assert.ok(p.side==='south'||p.side==='east');
  assert.ok(p.references?.length&&p.observations?.length&&p.limitations?.length);for(const r of p.references){assert.equal(r.role,'appearance-reference-only');assert.equal(new URL(r.url).protocol,'https:');}
  const cb=fs.readFileSync(path.join(o.cityModel,'city-model.json')),city=JSON.parse(cb.toString()),bin=fs.readFileSync(path.join(o.cityModel,city.binary.file));assert.equal(sha(cb),p.source.cityJsonSha256);assert.equal(sha(bin),p.source.cityBinSha256);assert.equal(sha(bin),city.binary.sha256);assert.equal(city.originId,p.source.originId);
  const buildings=city.buildings.filter((b:any)=>b.id===p.building.id&&b.vtj===null);assert.equal(buildings.length,1);const all=sourceBuildingFaces(buildings[0],bin);
  const faces=all.filter(f=>f.texture===null&&f.kind==='wall'&&(p.side==='south'?f.normal[2]>.97:f.normal[0]>.97));assert.deepEqual(faces.map(f=>({part:f.part,triangle:f.triangle})),p.faces,'Complete source-facing family changed');
  const axis=p.side==='south'?[.99875,-.05]:[-.0435,-.999053] as number[],length=Math.hypot(...axis);axis[0]!/=length;axis[1]!/=length;
  const anchor=faces[0]!.points[0],s=faces.flatMap(f=>f.points.map(q=>(q[0]-anchor[0])*axis[0]!+(q[2]-anchor[2])*axis[1]!)),min=Math.min(...s),max=Math.max(...s),frame={origin:[anchor[0]+axis[0]!*min,anchor[2]+axis[1]!*min]as const,axis:axis as unknown as readonly[number,number],width:max-min,minY:Math.min(...faces.flatMap(f=>f.points.map(q=>q[1]))),maxY:Math.max(...faces.flatMap(f=>f.points.map(q=>q[1])))};
  const charts=faces.map((f,i)=>chartInProjectedElevation(chartForSourceTriangles(p.id+'-'+i,p.building.id,[f.points],[2,2,1020,1020]),[f.points],frame));
  const mb=fs.readFileSync(path.join(o.world,'manifest.json'));assert.equal(sha(mb),o.expected);const m=JSON.parse(mb.toString());assert.deepEqual(validateWorldManifest(m),[]);const owners=m.cells.filter((c:any)=>c.buildings.some((b:any)=>b.id===p.building.id&&b.vtj===null));assert.equal(owners.length,1);assert.equal(owners[0].id,p.building.owner);assert.equal(m.origin.id,p.source.originId);
  const outward=[-axis[1]!,axis[0]!],probe={...charts[0]!,origin:[frame.origin[0]+outward[0]!*.75,0,frame.origin[1]+outward[1]!*.75]as const,uAxis:[axis[0]!,0,axis[1]!]as const,bounds:[0,frame.minY,frame.width,frame.maxY]as const},samples=await probeHameentieStreetGround(o.world,m,probe),heights=samples.map(s=>s.collision!.height);
  let ground=Math.max(...heights),datum:unknown=null;
  if(p.side==='east') {
    assert.ok(p.sharedStoreyDatum&&p.sharedStoreyDatum.path==='../south/source-ledger.json');
    const db=fs.readFileSync(path.resolve(path.dirname(o.plan),p.sharedStoreyDatum.path));assert.equal(sha(db),p.sharedStoreyDatum.sha256);const d=JSON.parse(db.toString());assert.equal(d.side,'south');assert.equal(d.building.id,p.building.id);assert.deepEqual(d.source,p.source);assert.equal(d.ground.chosen,p.sharedStoreyDatum.height);
    assert.ok(Math.max(...heights)-Math.min(...heights)<1.59,'Changed east street grade requires new reference review');
    ground=d.ground.chosen;assert.ok(Math.min(...heights)-ground>0&&Math.max(...heights)-ground<1.90,'Common office storey datum no longer matches its actual rising street');datum=p.sharedStoreyDatum;
  } else assert.ok(Math.max(...heights)-Math.min(...heights)<1,'Unqualified south street grade');
  const middlePlate=p.side==='east'?faces.filter(f=>f.triangle===13||f.triangle===14):[];
  if(p.side==='east')assert.equal(middlePlate.length,2);
  const middleCoordinates=middlePlate.flatMap(f=>f.points.map(q=>(q[0]-frame.origin[0])*axis[0]!+(q[2]-frame.origin[1])*axis[1]!));
  const mainBayRange=p.side==='east'?[Math.min(...middleCoordinates)+.10,Math.max(...middleCoordinates)-.10]as const:undefined;
  const wall=new OriginalWallArt(frame.width,frame.minY,frame.maxY);renderAnonymousOffice(wall,ground,p.side,mainBayRange);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#9b6755"/>${wall.svg([2,2,1020,1020])}</svg>`,png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9}).toBuffer();
  const profile:DeliveryFacadeProfile={schemaVersion:1,id:p.id,baselineManifestSha256:o.expected,source:p.source,art:{path:'facade.png',sha256:sha(png),width:1024,height:1024,license:'CC0-1.0',attribution:'Original observed office artwork by Helsinki Rides (2026); no reference pixels copied.',references:p.references},material:{name:p.id,unlit:true,roughness:.95,doubleSided:false},charts,cells:[{id:owners[0].id,buildings:[{id:p.building.id,vtj:null}],baselineLevels:Object.fromEntries(Object.entries(owners[0].visual).map(([k,r]:[string,any])=>[k,r.sha256])),faces:faces.map((f,i)=>({key:f.key,chart:charts[i]!.id}))}]};
  fs.mkdirSync(o.out,{recursive:true});for(const[name,bytes]of Object.entries({'profile.json':JSON.stringify(profile,null,2)+'\n','facade.svg':svg,'facade.png':png,'source-ledger.json':JSON.stringify({schemaVersion:1,status:'REFERENCE_BOUND_OFFICE_ART_RUNTIME_REVIEW_REQUIRED',source:p.source,planSha256:sha(pb),building:p.building,side:p.side,completeFacingFamily:true,sourceTriangles:faces.map(f=>({part:f.part,triangle:f.triangle,key:f.key,points:f.points,area:f.area})),frame,ground:{method:datum?'Shared measured south storey datum; nine native east visual/HCOL samples retain the actual uphill street independently':'Nine native street visual/HCOL matches outside exact facade',samples,chosen:ground,sharedStoreyDatum:datum},mainBaySourcePlate:mainBayRange?{sourceTriangles:[13,14],projectedRange:mainBayRange,openingMarginMetres:.10}:null,geometryUnchanged:true,observations:p.observations,limitations:p.limitations,references:p.references},null,2)+'\n'}))fs.writeFileSync(path.join(o.out,name),bytes,{flag:'wx'});
  return{faces:faces.length,ground,wallArea:faces.reduce((s,f)=>s+f.area,0),profileSha256:sha(fs.readFileSync(path.join(o.out,'profile.json')))};
}
async function authorAnonymousOfficeCorner(o:{plan:string;cityModel:string;world:string;expected:string;out:string},p:any,pb:Buffer) {
  assert.equal(p.building.id,'BID_96ce40d5-24d8-4d90-a39d-58976af1a24d');assert.equal(p.building.vtj,null);assert.equal(p.building.owner,'c_m03_p04');
  assert.deepEqual(p.planes.map((g:any)=>g.faces.map((f:any)=>f.triangle)),[[19,20],[33,34],[58,59],[60,61]]);
  assert.equal(p.sharedStoreyDatum.path,'../south/source-ledger.json');const db=fs.readFileSync(path.resolve(path.dirname(o.plan),p.sharedStoreyDatum.path));assert.equal(sha(db),p.sharedStoreyDatum.sha256);const datum=JSON.parse(db.toString());assert.equal(datum.side,'south');assert.equal(datum.building.id,p.building.id);assert.deepEqual(datum.source,p.source);assert.equal(datum.ground.chosen,p.sharedStoreyDatum.height);
  const finish=readObservedWallFinish(p.finish);assert.equal(finish.kind,'brick');await authorObservedFacadeFinish({...o,out:o.out+'.source-planes'});
  const base=o.out+'.source-planes',profile=JSON.parse(fs.readFileSync(path.join(base,'profile.json'),'utf8'))as DeliveryFacadeProfile;assert.equal(profile.charts.length,4);assert.equal(profile.art.width,1024);const width=profile.art.width,height=profile.art.height;
  const pieces=profile.charts.map(c=>{const w=new OriginalWallArt(c.bounds[2]-c.bounds[0],c.bounds[1],c.bounds[3]);renderAnonymousOfficeCorner(w,datum.ground.chosen,finish);return w.svg(c.pixels);});
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${finish.colour}"/>${pieces.join('')}</svg>`,png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9}).toBuffer();profile.art={...profile.art,sha256:sha(png)};
  const ledger=JSON.parse(fs.readFileSync(path.join(base,'source-ledger.json'),'utf8'));Object.assign(ledger,{planSha256:sha(pb),art:{...ledger.art,sha256:sha(png)},sourceBoundStoneBase:{datum:p.sharedStoreyDatum,heightAboveDatum:3.45,geometryChanged:false,method:'Same measured horizontal base-storey datum as exact source south/east fronts; no new floor height is inferred'}});
  fs.mkdirSync(o.out,{recursive:true});for(const[name,b]of Object.entries({'profile.json':JSON.stringify(profile,null,2)+'\n','source-ledger.json':JSON.stringify(ledger,null,2)+'\n','facade.svg':svg,'facade.png':png}))fs.writeFileSync(path.join(o.out,name),b,{flag:'wx'});
  return{profileSha256:sha(fs.readFileSync(path.join(o.out,'profile.json'))),artSha256:sha(png),sourceFaces:8,charts:4};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:Object.fromEntries(['plan','city-model','world','expected','out'].map(k=>[k,{type:'string'as const}]))});for(const k of['plan','city-model','world','expected','out'])assert.ok(values[k]);console.log(JSON.stringify(await authorAnonymousOffice({plan:values.plan!,cityModel:values['city-model']!,world:values.world!,expected:values.expected!,out:values.out!})));}
