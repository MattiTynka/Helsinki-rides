import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseCollisionBundle,validateWorldManifest,type WorldManifest,type Vec3} from '../../../packages/world-schema/src/index.ts';
import {sourceFile,readSourceFile,sourceSha256} from './source-files.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {isPublicWalkingGroundTag,type RoadSupportTriangle} from './expansion-road-merge.ts';

export interface SerializedFloorWorld {directory:string;manifestSha256:string}
export function roadTrianglesFromCollision(bytes:Uint8Array,cell:string,originId:string):RoadSupportTriangle[]{
  const bundle=parseCollisionBundle(bytes);assert.equal(bundle.header.cell,cell);assert.equal(bundle.header.originId,originId);const triangles:RoadSupportTriangle[]=[];
  for(const collider of bundle.colliders)if(collider.group==='ground')for(let t=0;t<collider.indices.length;t+=3){
    const tag=bundle.header.surfaceTags[collider.triangleTags[t/3]!]!;
    // Keep authored bridge walkway faces available to an exact per-record selector;
    // the ordinary walking projector still excludes this suffix.
    if(!tag.startsWith('road:')&&!isPublicWalkingGroundTag(tag)&&tag!=='stairs'&&!/^raised:(asphalt|slabs|setts|cobble|gravel):bridge-reconstruction$/.test(tag))continue;
    const points=Array.from(collider.indices.subarray(t,t+3),i=>Array.from(collider.positions.subarray(i*3,i*3+3))as Vec3)as[Vec3,Vec3,Vec3];
    triangles.push({id:`serialized:${cell}:${collider.id}:${t/3}`,tag,points});
  }return triangles;
}
/** Final HCOL is the vertical authority after source-bound delivery repairs. Original native
 * producer metadata remains a separate provenance input; it is never restamped as repaired. */
export function readSerializedRoadFloor(input:SerializedFloorWorld,region:readonly[number,number,number,number],originId:string){
  assert.deepEqual(Object.keys(input).sort(),['directory','manifestSha256']);assert.match(input.manifestSha256,/^[a-f0-9]{64}$/);
  assert.ok(region.every(Number.isFinite)&&region[0]<=region[2]&&region[1]<=region[3]);
  const file=sourceFile(input.directory,'manifest.json'),info=fs.lstatSync(file);assert.ok(info.isFile()&&info.size>0&&info.size<=16*1024*1024);
  const bytes=fs.readFileSync(file);assert.equal(sourceSha256(bytes),input.manifestSha256);const manifest=JSON.parse(bytes.toString())as WorldManifest;assert.deepEqual(validateWorldManifest(manifest),[]);assert.equal(manifest.origin.id,originId);
  const triangles:RoadSupportTriangle[]=[],cells:{cell:string;storedSha256:string;decodedSha256:string;decodedBytes:number}[]=[];let decodedTotal=0;
  for(const cell of manifest.cells){const b=cell.collision.boundsXZ??cell.boundsXZ;if(b[2]<region[0]||b[0]>region[2]||b[3]<region[1]||b[1]>region[3])continue;
    assert.ok(cell.collision.bytes<=64*1024*1024);const decoded=decodeDeliverySimulation(readSourceFile(input.directory,cell.collision),cell.collision);decodedTotal+=decoded.length;assert.ok(decodedTotal<=512*1024*1024,'Selected final floor exceeds the offline512MiB input budget');
    cells.push({cell:cell.id,storedSha256:cell.collision.sha256,decodedSha256:sourceSha256(decoded),decodedBytes:decoded.length});for(const t of roadTrianglesFromCollision(decoded,cell.id,originId))triangles.push(t);assert.ok(triangles.length<=2_000_000,'Selected final floor exceeds2M road triangles');
  }
  assert.ok(cells.length&&triangles.length);assert.equal(sourceSha256(fs.readFileSync(file)),input.manifestSha256);
  return{triangles,receipt:{schemaVersion:1,kind:'final-serialized-road-floor',manifestSha256:input.manifestSha256,originId,region,cells,decodedTotal}};
}
