import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {loadGeoJsonPolygons} from '../lib/geometry.ts';
import {qualifyPreciseLakeTreeSource,qualifyPreciseLakeWaterMask,type PreciseLakeTreeBinding} from '../lib/tree-precise-water-registration.ts';
import {registrationSha256 as sha,type RegistrationTree} from '../lib/tree-ground-registration.ts';
import type {TreeBarkModel} from '../lib/tree-bark-registration.ts';

// Exact decoded original CC0 procedural birch geometry, not photograph content.
const model=JSON.parse(readFileSync(new URL('./fixtures/reviewed-native-birch-bark.json',import.meta.url),'utf8'))as TreeBarkModel;
const trees=JSON.parse(readFileSync(new URL('./fixtures/reviewed-precise-lake-trees.json',import.meta.url),'utf8'))as RegistrationTree[];
const file=fileURLToPath(new URL('../../../content/helsinki/city-expansion-20261021/native-shore/municipal-water-bank-v1.geojson',import.meta.url));
const source={sha256:sha(readFileSync(file)),polygons:loadGeoJsonPolygons(file,25497350,6672960,p=>String(p.sourceFeatureId))};
const lake=source.polygons.find(p=>p.id==='Maavesi_muut_vesialueet.1631')!;
function binding():PreciseLakeTreeBinding{return{kind:'reviewed-precise-lake-source',path:file,sha256:source.sha256,featureId:lake.id,featureSha256:sha(JSON.stringify(lake)),barkModelSha256:sha(JSON.stringify(model)),retainedWaterReport:{path:"reviewed-classification.json",sha256:"b12184d66b27f70c6ed388aa2037b611e245612ac474fbaa8cb87e3a6a4bdfa9"}};}
const root=(t:RegistrationTree):[number,number][]=>model.root.map(([u,,v])=>[t.position[0]+Math.cos(t.yaw)*u*t.scale[0]+Math.sin(t.yaw)*v*t.scale[2],t.position[2]-Math.sin(t.yaw)*u*t.scale[0]+Math.cos(t.yaw)*v*t.scale[2]]);

test('all seven exact original woody root rings are wholly inside the independently pinned municipal lake',()=>{
 for(const tree of trees)assert.equal(qualifyPreciseLakeTreeSource(tree,model,binding(),source,root(tree)),lake);
});
test('a dry-bank tree or the partly supported eighth placement cannot inherit the complete-lake review',()=>{
 const t=trees[0]!;
 assert.throws(()=>qualifyPreciseLakeTreeSource({...t,id:'a-valid-dry-bank-tree'},model,binding(),source,root(t)),/seven individually/);
 assert.throws(()=>qualifyPreciseLakeTreeSource({...t,id:'TREE_SUMMER_0f319ac7-6ecb-4525-9c85-a38a3454c999'},model,binding(),source,root(t)),/seven individually/);
});
test('source position, orientation and scale cannot drift even if the new point would remain in water',()=>{
 const t=trees[0]!;
 for(const changed of[{...t,position:[t.position[0]+.01,t.position[1],t.position[2]]as[number,number,number]},{...t,yaw:t.yaw+.01},{...t,scale:[1,1,1]as[number,number,number]}])
  assert.throws(()=>qualifyPreciseLakeTreeSource(changed,model,binding(),source,root(changed)),/placement changed/);
});
test('independent file, full lake boundary, classification and feature identity fail closed on drift',()=>{
 const t=trees[0]!,b=binding();
 assert.throws(()=>qualifyPreciseLakeTreeSource(t,model,b,{...source,sha256:'0'.repeat(64)},root(t)),/source bytes changed/);
 assert.throws(()=>qualifyPreciseLakeTreeSource(t,model,{...b,featureId:'another-water'},source,root(t)));
 const changed=structuredClone(lake);changed.rings[0]![0]![0]+=.01;
 assert.throws(()=>qualifyPreciseLakeTreeSource(t,model,b,{...source,polygons:[changed]},root(t)),/shape or classification changed/);
 assert.throws(()=>qualifyPreciseLakeTreeSource(t,model,b,{...source,polygons:[{...lake,properties:{...lake.properties,tyyppi:'dry land'}}]},root(t)),/shape or classification changed/);
});
test('a point sample or leaf-only/altered model cannot substitute for the exact complete woody root ring',()=>{
 const t=trees[0]!;
 assert.throws(()=>qualifyPreciseLakeTreeSource(t,model,binding(),source,root(t).slice(0,3)),/actual full woody root ring/);
 const changed=structuredClone(model);changed.triangles.pop();
 assert.throws(()=>qualifyPreciseLakeTreeSource(t,changed,binding(),source,root(t)),/Actual bark model changed/);
});

test('a derived water mask retains its exact pinned lineage rather than being relabelled raw OSM',()=>{
 const b=binding(),classification={sha256:b.retainedWaterReport.sha256,report:{nativeShore:{profileSha256:'772a9c509fe3a40b67dd5bda04fafb9d72654aa228663d7861ccac7d5648596f',preciseMunicipalWaterSha256:source.sha256},nativeMetadataSha256:'38442ad1254e59fa21b99d1adf3d750a1f65065f9407139bbab38c8625dd3c56',coastal:{mask:{water:[lake]}}}};
 qualifyPreciseLakeWaterMask(b,classification,[lake]);
 assert.throws(()=>qualifyPreciseLakeWaterMask(b,{...classification,sha256:'f'.repeat(64)},[lake]),/classification changed/);
 assert.throws(()=>qualifyPreciseLakeWaterMask(b,classification,[]),/water union differs/);
 const changed=structuredClone(classification);changed.report.nativeShore.preciseMunicipalWaterSha256='f'.repeat(64);assert.throws(()=>qualifyPreciseLakeWaterMask(b,changed,[lake]));
});
