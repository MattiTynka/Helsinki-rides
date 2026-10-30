import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import type polygonClipping from 'polygon-clipping';
import {composeExpansionSupportedArea} from './lib/expansion-supported-area.ts';
import {sourceSha256} from './lib/source-files.ts';
import {readDeliveryFile} from './lib/delivery-city.ts';
import {decodeDeliverySimulation} from './lib/delivery-city-payloads.ts';
import {loadGeoJsonPolygons,bbox} from './lib/geometry.ts';
import {bindDeliveryProducer,publicDeliveryProducer,verifyDeliveryProducer} from './lib/delivery-city-provenance.ts';

const {values}=parseArgs({options:{plan:{type:'string'},out:{type:'string'}}});
assert.ok(values.plan&&values.out,'--plan and --out required');
assert.ok(!fs.existsSync(values.out),'Fresh supported-area output required');
const producer=bindDeliveryProducer(new URL(import.meta.url));
const pin=(file:string)=>{const full=fs.realpathSync(file),bytes=fs.readFileSync(full);return {path:full,bytes:bytes.length,sha256:sourceSha256(bytes)};};
const planPin=pin(values.plan),plan=JSON.parse(fs.readFileSync(values.plan,'utf8'));
assert.equal(plan.schemaVersion,1);assert.equal(plan.kind,'municipal-public-surface-selection');
assert.ok(Array.isArray(plan.streetNames)&&plan.streetNames.length>0&&plan.streetNames.length<=150);
assert.ok(Array.isArray(plan.surfaceClasses)&&plan.surfaceClasses.length>0&&!plan.surfaceClasses.includes('Silta'));
const manifestPin=pin(path.join(plan.acceptedWorld,'manifest.json'));
assert.equal(manifestPin.sha256,plan.acceptedManifestSha256);
const manifest=JSON.parse(fs.readFileSync(manifestPin.path,'utf8'));
const gameplay=JSON.parse(decodeDeliverySimulation(readDeliveryFile(plan.acceptedWorld,manifest.gameplay),manifest.gameplay).toString());
assert.ok(!gameplay.supportedArea,'This producer starts from the original rectangular accepted world');
const partsPin=pin(plan.streetParts.path);assert.equal(partsPin.sha256,plan.streetParts.sha256);
const exclusionsPin=pin(plan.groundExclusions.path);assert.equal(exclusionsPin.sha256,plan.groundExclusions.sha256);
const exclusions=JSON.parse(fs.readFileSync(exclusionsPin.path,'utf8'));
assert.equal(exclusions.source.sha256,partsPin.sha256);assert.equal(exclusions.originId,manifest.origin.id);
const [E0,N0]=manifest.origin.originProjected;
const parts=loadGeoJsonPolygons(partsPin.path,E0,N0,(p,i)=>String(p.osan_id??p.id??i));
const names=new Set(plan.streetNames),classes=new Set(plan.surfaceClasses),r=plan.region as[number,number,number,number];
const selected=parts.filter(p=>{
  if(!names.has(p.properties.alueen_nimi)||!classes.has(p.properties.paatyyppi))return false;
  const b=bbox(p.rings);return b[0]<=r[2]&&b[2]>=r[0]&&-b[3]<=r[3]&&-b[1]>=r[1];
});
const polygons=selected.map(p=>p.rings.map(ring=>ring.map(([x,n])=>[x,-n]as[number,number])));
const omitted=exclusions.parts.flatMap((p:any)=>p.polygonsRuntimeXZ) as polygonClipping.Polygon[];
const a=gameplay.playArea;
const result=composeExpansionSupportedArea({accepted:[a.minX,a.minZ,a.maxX,a.maxZ],region:r,publicPolygons:polygons,excludedPolygons:omitted,unionBatchSize:plan.unionBatchSize});
const document={schemaVersion:1,kind:'qualified-expansion-supported-area',acceptedManifestSha256:manifestPin.sha256,originId:manifest.origin.id,
  sourceFiles:[planPin,manifestPin,partsPin,exclusionsPin],supportedArea:result.supportedArea,
  qualification:{status:'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA',method:'Exact union of explicitly named municipal public surface polygons, clipped to the build region, minus all source-bound unqualified bridge footprints. Preserve original accepted play area and retain only its connected component.',
    physicalAndGameplayStatus:'PENDING_NATIVE_SUPPORT_AND_RUNTIME_GATES',...result,supportedArea:undefined,
    selectedParts:selected.map(p=>({id:p.id,street:p.properties.alueen_nimi,main:p.properties.paatyyppi,detail:p.properties.alatyyppi})),
    excludedBridgePartIds:exclusions.parts.map((p:any)=>p.partId),producer:publicDeliveryProducer(producer)}};
verifyDeliveryProducer(producer);
fs.writeFileSync(values.out,JSON.stringify(document,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:document.qualification.status,output:values.out,sha256:pin(values.out).sha256,vertices:result.vertices,selectedParts:selected.length,excludedDisconnectedComponents:result.excludedDisconnectedComponents}));
