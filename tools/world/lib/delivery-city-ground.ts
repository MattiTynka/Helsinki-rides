// New-area source exclusions are applied before meshing, by municipal identity.
// Other registered surfaces at the same XZ (including underpasses) remain intact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {LocalPolygon,Ring} from './geometry.ts';
export interface ExcludedGroundSource {id:string;rings:Ring[]}
export function readDeliveryGroundExclusions(file:string,streetParts:string,parts:readonly LocalPolygon[]){
  const bytes=fs.readFileSync(file),document=JSON.parse(bytes.toString()),sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
  assert.equal(document.schemaVersion,1);assert.equal(document.kind,'source-bound-unqualified-new-bridge-polygons');
  assert.equal(document.source.sha256,sha(fs.readFileSync(streetParts)),'Bridge masks must bind actual street-part source');
  const result:ExcludedGroundSource[]=[],ids=new Set<string>();
  for(const item of document.parts){
    assert.equal(typeof item.partId,'string');assert.ok(!ids.has(item.partId),'Duplicate bridge exclusion');ids.add(item.partId);
    const matches=parts.filter(p=>p.id===item.partId);assert.ok(matches.length,'Missing bridge exclusion source part');
    assert.equal(item.main,'Silta');
    const recorded=item.polygonsRuntimeXZ.map((polygon:number[][][])=>polygon.map(ring=>{const points=ring.map(p=>[p[0]!,-p[1]!]);if(points.length>1&&points[0]![0]===points.at(-1)![0]&&points[0]![1]===points.at(-1)![1])points.pop();return points;}));
    assert.deepEqual(recorded,matches.map(p=>p.rings),'Bridge mask rings must retain exact municipal coordinates');
    for(const p of matches){assert.equal(p.properties['paatyyppi'],'Silta','Only actual Silta parts can be excluded');result.push({id:p.id,rings:p.rings});}
  }
  return{sources:result,receipt:{schemaVersion:1,sha256:sha(bytes),sourceSha256:document.source.sha256,partIds:[...ids],method:'Exclude only named municipal Silta surfaces and their fallback footprints; retain all other source identities at the same XZ'}};
}
