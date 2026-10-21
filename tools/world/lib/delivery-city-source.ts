import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
/** Page numbers from an independently converted vintage cannot address old facade artwork. */
export function authorizeNewStripFacades(config:any,modelBytes:Uint8Array,acceptedIndexBytes:Uint8Array,acceptedManifestBytes:Uint8Array){
  const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),model=JSON.parse(Buffer.from(modelBytes).toString()),coverage=JSON.parse(Buffer.from(acceptedIndexBytes).toString()),accepted=JSON.parse(Buffer.from(acceptedManifestBytes).toString()),authority=config.continuation;
  assert.equal(config.curatedFacades,'none-new-strips');assert.equal(authority?.kind,'current-vintage-new-strips-only');
  assert.equal(authority.modelSha256,sha(modelBytes),'New-strip model authority changed');
  assert.equal(authority.acceptedCoverageIndexSha256,sha(acceptedIndexBytes),'Accepted coverage index authority changed');
  assert.equal(authority.acceptedSourceManifestSha256,sha(acceptedManifestBytes),'Accepted building manifest authority changed');
  assert.equal(authority.sourceSnapshotSha256,model.source.snapshotSha256,'New-strip source snapshot changed');
  assert.equal(authority.sourceTilesetVersion,model.source.tilesetVersion,'New-strip source vintage changed');
  assert.match(authority.sourceSnapshotSha256,/^[0-9a-f]{64}$/);assert.ok(typeof authority.sourceTilesetVersion==='string'&&authority.sourceTilesetVersion.length);
  assert.ok(Array.isArray(accepted.cells)&&Array.isArray(coverage.cells));assert.deepEqual(coverage.cells.map((c:any)=>c.id).sort(),accepted.cells.map((c:any)=>c.id).sort(),'Coverage and building authority owners differ');
  for(const cell of accepted.cells){assert.ok(Array.isArray(cell.buildingIds)&&Array.isArray(cell.buildings),'Coverage proxies cannot authorize building identity');assert.ok(cell.buildingIds.every((id:any)=>typeof id==='string'&&id.length>0));assert.equal(new Set(cell.buildingIds).size,cell.buildingIds.length);assert.ok(cell.buildings.every((b:any)=>cell.buildingIds.includes(b.id)),'Incomplete accepted building IDs');}
  const ids=new Set(accepted.cells.flatMap((c:any)=>c.buildingIds));assert.ok(model.buildings.every((b:any)=>typeof b.id==='string'&&!ids.has(b.id)),'New-strip model contains an accepted building');assert.equal(new Set(model.buildings.map((b:any)=>b.id)).size,model.buildings.length,'Duplicate new building IDs');
  const region=authority.appendRegionXZ,protectedArea=authority.protectedPlayArea;assert.ok(Array.isArray(region)&&region.length===4&&region.every(Number.isFinite)&&protectedArea);
  for(const building of model.buildings){const box=building.boundsENU;assert.ok(box&&Array.isArray(box.min)&&Array.isArray(box.max));const x=(box.min[0]+box.max[0])/2,z=-(box.min[1]+box.max[1])/2;assert.ok(x>=region[0]&&x<=region[2]&&z>=region[1]&&z<=region[3],'New building owner is outside its qualified strip');assert.ok(!(x>protectedArea.minX&&x<protectedArea.maxX&&z>protectedArea.minZ&&z<protectedArea.maxZ),'New vintage cannot refresh the protected interior');}
  return true;
}
