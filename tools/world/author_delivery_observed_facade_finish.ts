import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {OriginalWallArt,chartForSourceTriangles} from './author_senate_facade_charts.ts';
import {sourceBuildingFaces} from './census_delivery_new_area_facades.ts';
import {assertCompleteSelectedFacadePlane} from './lib/delivery-new-area-facades-selection.ts';
import {readObservedWallFinish,renderObservedWallFinish,observedFinishFaceGroups,observedFinishAtlasLayout} from './lib/delivery-new-area-facades-observed-finish.ts';
import {deliverySha as sha} from './lib/delivery-city-payloads.ts';
import {validateWorldManifest} from '../../packages/world-schema/src/index.ts';
import type {DeliveryFacadeProfile} from './apply_delivery_facade_charts.ts';

export async function authorObservedFacadeFinish(o:{plan:string;cityModel:string;world:string;expected:string;out:string}) {
  assert.ok(!fs.existsSync(o.out),'Fresh observed-finish output required');
  const planBytes=fs.readFileSync(o.plan),p=JSON.parse(planBytes.toString()),finish=readObservedWallFinish(p.finish);
  assert.equal(p.schemaVersion,1);assert.ok(typeof p.id==='string'&&p.id.length);assert.equal(p.completeElevationPlane,true);
  assert.ok(p.building.id&&p.building.owner&&(p.building.vtj===null||typeof p.building.vtj==='string'&&p.building.vtj.length));
  const faceGroups=observedFinishFaceGroups(p,finish);assert.ok(p.observations?.length&&p.limitations?.length&&p.references?.length);
  for(const r of p.references){assert.equal(r.role,'appearance-reference-only');assert.equal(new URL(r.url).protocol,'https:');assert.ok(r.title);}
  assert.ok(typeof p.role==='string'&&p.role.length,'Individually observed architectural material role required');
  const cityBytes=fs.readFileSync(path.join(o.cityModel,'city-model.json'));assert.equal(sha(cityBytes),p.source.cityJsonSha256);const city=JSON.parse(cityBytes.toString()),bin=fs.readFileSync(path.join(o.cityModel,city.binary.file));assert.equal(sha(bin),p.source.cityBinSha256);assert.equal(sha(bin),city.binary.sha256);assert.equal(city.originId,p.source.originId);
  const matches=city.buildings.filter((b:any)=>b.id===p.building.id&&b.vtj===p.building.vtj);assert.equal(matches.length,1);const all=sourceBuildingFaces(matches[0],bin);
  const groups=faceGroups.map(group=>{const selected=group.faces.map(s=>{const f=all.find(f=>f.part===s.part&&f.triangle===s.triangle);assert.ok(f&&f.texture===null&&f.kind==='wall');return f;});
    const chart=chartForSourceTriangles(p.faces?p.id:p.id+'-'+group.id,p.building.id,selected.map(f=>f.points),[2,2,508,508]),width=chart.bounds[2]-chart.bounds[0],frame={origin:[chart.origin[0]+chart.uAxis[0]*chart.bounds[0],chart.origin[2]+chart.uAxis[2]*chart.bounds[0]] as const,axis:[chart.uAxis[0],chart.uAxis[2]] as const,width,minY:chart.bounds[1],maxY:chart.bounds[3]};
    return{selected,chart,width,completePlane:assertCompleteSelectedFacadePlane(all,selected,frame)};});
  const selected=groups.flatMap(g=>g.selected);assert.equal(new Set(selected.map(f=>f.key)).size,selected.length);const{chart,width}=groups[0]!;
  const layout=observedFinishAtlasLayout(groups.map(g=>({id:g.chart.id,width:g.width,height:g.chart.bounds[3]-g.chart.bounds[1]})),finish);groups.forEach((g,i)=>g.chart={...g.chart,pixels:layout.pixels[i]!});
  const worldBytes=fs.readFileSync(path.join(o.world,'manifest.json'));assert.equal(sha(worldBytes),o.expected);const m=JSON.parse(worldBytes.toString());assert.deepEqual(validateWorldManifest(m),[]);assert.equal(m.origin.id,p.source.originId);const owners=m.cells.filter((c:any)=>c.buildings.some((b:any)=>b.id===p.building.id&&b.vtj===p.building.vtj));assert.equal(owners.length,1);assert.equal(owners[0].id,p.building.owner);
  const rendered=layout.sharedPlainTile||groups.length===1?[groups[0]!]:groups,pieces=rendered.map(g=>{const wall=new OriginalWallArt(g.width,g.chart.bounds[1],g.chart.bounds[3]);renderObservedWallFinish(wall,finish);return wall.svg(g.chart.pixels);});const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.size}" height="${layout.size}"><rect width="100%" height="100%" fill="${finish.colour}"/>${pieces.join('')}</svg>`,png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9}).toBuffer();
  const profile:DeliveryFacadeProfile={schemaVersion:1,id:p.id,baselineManifestSha256:o.expected,source:p.source,art:{path:'facade.png',sha256:sha(png),width:layout.size,height:layout.size,license:'CC0-1.0',attribution:'Original observed architectural material finish by Helsinki Rides (2026); reference pixels are not reproduced.',references:p.references},material:{name:p.id,unlit:true,roughness:.95,doubleSided:false},charts:groups.map(g=>g.chart),cells:[{id:owners[0].id,buildings:[{id:p.building.id,vtj:p.building.vtj}],baselineLevels:Object.fromEntries(Object.entries(owners[0].visual).map(([k,r]:[string,any])=>[k,r.sha256])),faces:groups.flatMap(g=>g.selected.map(f=>({key:f.key,chart:g.chart.id})))}]};
  const completePlane=groups.length===1?groups[0]!.completePlane:groups.map(g=>({chart:g.chart.id,...g.completePlane}));
  fs.mkdirSync(o.out,{recursive:true});for(const[name,bytes]of Object.entries({'profile.json':JSON.stringify(profile,null,2)+'\n','facade.svg':svg,'facade.png':png,'source-ledger.json':JSON.stringify({schemaVersion:1,status:'OBSERVED_SOURCE_PLANE_FINISH_RUNTIME_REVIEW_REQUIRED',source:p.source,planSha256:sha(planBytes),building:p.building,role:p.role,finish,completePlane,...(layout.texelsPerMetre!==null?{physicalPlaneAtlas:layout}:{}),sourceTriangles:selected.map(f=>({part:f.part,triangle:f.triangle,key:f.key,area:f.area,points:f.points})),geometryUnchanged:true,ground:{method:'No floor or opening placement inferred; uninterrupted observed material finish only'},art:{sha256:sha(png),license:'CC0-1.0',referencePixelsCopied:false},observations:p.observations,limitations:p.limitations,references:p.references},null,2)+'\n'}))fs.writeFileSync(path.join(o.out,name),bytes,{flag:'wx'});
  return{artSha256:sha(png),profileSha256:sha(fs.readFileSync(path.join(o.out,'profile.json'))),faces:selected.length,wallArea:selected.reduce((s,f)=>s+f.area,0)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:Object.fromEntries(['plan','city-model','world','expected','out'].map(k=>[k,{type:'string'as const}]))});for(const k of['plan','city-model','world','expected','out'])assert.ok(values[k]);console.log(JSON.stringify(await authorObservedFacadeFinish({plan:values.plan!,cityModel:values['city-model']!,world:values.world!,expected:values.expected!,out:values.out!})));}
