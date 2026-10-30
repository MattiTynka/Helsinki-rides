import assert from 'node:assert/strict';
import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';
import {validateSupportedArea,type GameplayBundle,type SupportedArea} from '../../../packages/world-schema/src/index.ts';
import {deliverySha} from './delivery-city-payloads.ts';

type Area=GameplayBundle['playArea'];
export interface SupportedAreaInput {path:string;sha256:string}
const polygons=(area:SupportedArea):polygonClipping.MultiPolygon=>area.regions.map(r=>[r.outer.map(p=>[p[0],p[1]]as [number,number]),...(r.holes??[]).map(h=>h.map(p=>[p[0],p[1]]as [number,number]))]);
export function assertSupportedAreaPreservesAccepted(next:SupportedArea,old:{playArea:Area;supportedArea?:SupportedArea},expanded:Area){
  assert.deepEqual(validateSupportedArea(next,expanded),[],'Invalid qualified supported-area geometry');
  const a=old.playArea,previous:polygonClipping.MultiPolygon=old.supportedArea?polygons(old.supportedArea):[[[[a.minX,a.minZ],[a.maxX,a.minZ],[a.maxX,a.maxZ],[a.minX,a.maxZ]]]];
  assert.deepEqual(polygonClipping.difference(previous,polygons(next)),[],'Supported-area attachment removes accepted playable geometry');
}
/** This private review input is hash-bound to the accepted world and the actual source evidence.
 * It never promotes an enlarged bounding rectangle to a claim of supported geography. */
export function readQualifiedSupportedArea(input:SupportedAreaInput,accepted:{manifestSha256:string;originId:string;gameplay:{playArea:Area;supportedArea?:SupportedArea}},expanded:Area){
  assert.match(input.sha256,/^[a-f0-9]{64}$/);const bytes=fs.readFileSync(input.path);assert.ok(bytes.length<=2_000_000,'Supported-area review document too large');assert.equal(deliverySha(bytes),input.sha256,'Supported-area review changed');const document=JSON.parse(bytes.toString());
  assert.equal(document.schemaVersion,1);assert.equal(document.kind,'qualified-expansion-supported-area');assert.equal(document.acceptedManifestSha256,accepted.manifestSha256);assert.equal(document.originId,accepted.originId);assert.equal(document.qualification?.status,'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA');
  assert.ok(Array.isArray(document.sourceFiles)&&document.sourceFiles.length>0&&document.sourceFiles.length<=128,'Supported-area qualification requires bounded source evidence');
  const witnesses=document.sourceFiles.map((ref:any)=>{assert.ok(typeof ref.path==='string'&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=256_000_000);assert.match(ref.sha256,/^[a-f0-9]{64}$/);const stat=fs.lstatSync(ref.path);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,ref.bytes);const source=fs.readFileSync(ref.path);assert.equal(deliverySha(source),ref.sha256,'Supported-area source changed');return{bytes:ref.bytes,sha256:ref.sha256};});
  assertSupportedAreaPreservesAccepted(document.supportedArea,accepted.gameplay,expanded);
  return{supportedArea:document.supportedArea as SupportedArea,proof:{reviewSha256:input.sha256,acceptedManifestSha256:accepted.manifestSha256,sourceFiles:witnesses,acceptedPlayableGeometryPreserved:true}};
}
