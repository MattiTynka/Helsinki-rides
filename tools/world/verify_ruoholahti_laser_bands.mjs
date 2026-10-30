// Independent streaming recomputation of every classified bridge measurement band.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {pointInPolygon} from './lib/geometry.ts';
import {sourceSha256,writeSourceJson} from './lib/source-files.ts';
const output=process.argv[2];assert.ok(output&&!fs.existsSync(output),'Fresh evidence output required');
const root='../evidence/ruoholahti-bridges',read=file=>{const bytes=fs.readFileSync(file);return{file,sha256:sourceSha256(bytes),value:JSON.parse(bytes)};};
const bands=read(root+'/lidar-2021-v1/deck-profile-diagnostic.json'),roi=read(root+'/lidar-2021-v1/roi-report-v2.json'),streets=read('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson');
assert.equal(streets.sha256,bands.value.inputs.streetPartsSha256);assert.equal(roi.value.csv.sha256,bands.value.inputs.roiSha256);assert.equal(roi.value.horizontalCRS,'EPSG:3879');assert.equal(roi.value.verticalDatum,'N2000');assert.deepEqual(roi.value.originProjected,[25497350,6672960,7.5]);
const roles={41050:'road',97745:'road',41061:'east-walk',97746:'east-walk',41063:'west-walk',97747:'west-walk',162846:'west-cycle',97748:'west-cycle'},parts=[];
for(const f of streets.value.features){const id=f.properties.osan_id;if(!roles[id])continue;const polygons=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;for(const polygon of polygons)parts.push({id,role:roles[id],rings:polygon.map(r=>r.map(([e,n])=>[e-25497350,6672960-n]))});}
const file=path.join(root,'lidar-2021-v1',roi.value.csv.file),stream=fs.createReadStream(file),hash=createHash('sha256');stream.on('data',chunk=>hash.update(chunk));let header,rows=0,classified=0;const bins=new Map(),frame=bands.value.frame;
for await(const line of readline.createInterface({input:stream,crlfDelay:Infinity})){
  if(!header){header=line.split(',');continue;}if(!line)continue;rows++;const values=line.split(','),at=name=>Number(values[header.indexOf(name)]);if(at('classification')!==17)continue;classified++;
  const x=at('x'),z=at('z'),h=at('heightN2000'),s=(x-frame.origin[0])*frame.direction[0]+(z-frame.origin[1])*frame.direction[1],t=-(x-frame.origin[0])*frame.direction[1]+(z-frame.origin[1])*frame.direction[0];
  assert.equal(x,at('X')*.001+25000000-25497350);assert.equal(z,6672960-(at('Y')*.001+6680000));assert.equal(h,at('Z')*.001);
  for(const part of parts)if(pointInPolygon([x,z],part.rings)){
    const point={pointIndex:at('sourcePointIndex'),runtimeXZ:[x,z],heightN2000:h,station:s,lateral:t,partId:part.id,class:17,pointSourceId:at('pointSourceId'),returnNumber:at('returnNumber'),numberOfReturns:at('numberOfReturns')};
    for(const role of[part.role,...(part.role==='road'&&Math.abs(t)<=1?['road-centre']:[])]){const key=role+':'+Math.floor(s/2)*2;let bin=bins.get(key);if(!bin){bin={role,stationBin:Math.floor(s/2)*2,points:[]};bins.set(key,bin);}bin.points.push(point);}
  }
}
assert.equal(hash.digest('hex'),roi.value.csv.sha256);assert.equal(fs.statSync(file).size,roi.value.csv.bytes);assert.equal(classified,roi.value.roiClassCounts['17']);
const rebuilt=[...bins.values()].sort((a,b)=>a.role.localeCompare(b.role,'en')||a.stationBin-b.stationBin).map(({role,stationBin,points})=>{points.sort((a,b)=>a.heightN2000-b.heightN2000);const n=points.length;return{role,stationBin,count:n,min:points[0],p10:points[Math.floor((n-1)*.1)],median:points[Math.floor((n-1)/2)],p90:points[Math.floor((n-1)*.9)],max:points[n-1]};});
assert.deepEqual(rebuilt,bands.value.sourceBands,'Independent class-17 bins/quantiles/witnesses differ');
const lidarFile=path.join(root,'lidar-2021-v1/rgb_672495a.laz'),lidarHash=createHash('sha256');for await(const chunk of fs.createReadStream(lidarFile))lidarHash.update(chunk);assert.equal(lidarHash.digest('hex'),roi.value.sourceSha256);
fs.mkdirSync(output,{recursive:false});const ref=writeSourceJson(output,'laser-band-verification.json',{schemaVersion:1,status:'PASS_INDEPENDENT_SOURCE_CLASS17_BANDS_AND_INTEGER_DATUM',inputs:[bands,roi,streets].map(({file,sha256})=>({file,sha256})),rawLidar:{file:lidarFile,bytes:fs.statSync(lidarFile).size,sha256:roi.value.sourceSha256},roi:{file,bytes:roi.value.csv.bytes,sha256:roi.value.csv.sha256},producerSha256:sourceSha256(fs.readFileSync(new URL(import.meta.url))),rows,classifiedBridgeDeckPoints:classified,bands:rebuilt.length,allCountsQuantilesMedianWitnessesExact:true,integerXyzDatumReconstructionExact:true,limitations:['The source LAS coordinate scale is storage precision, not measured accuracy.','This independently recomputes the CSV-derived measurements and verifies the original LAZ hash; it does not rerun LAZ decompression.']});console.log(JSON.stringify({sha256:ref.sha256,rows,classified,bands:rebuilt.length}));
