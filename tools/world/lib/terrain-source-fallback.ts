import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gk25ToGeodetic} from '../../../packages/world-schema/src/index.ts';
import {decodeQuantizedMesh,tileDegrees} from './quantized-mesh.ts';

const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
type Rectangle=readonly[number,number,number,number];
interface FilePin {path:string;bytes:number;sha256:string}
interface QualifiedSample {
  runtimeXZ:readonly[number,number];projectedEN:readonly[number,number];
  parent:{zoom:number;x:number;y:number;file:FilePin;downloadReceipt:FilePin};
  triangle:{index:number;vertices:readonly number[];uv:readonly(readonly number[])[];heightsN2000:readonly number[];barycentric:readonly number[]};
  heightN2000:number;runtimeFloat32Bits:string;
  lodComparison:{report:FilePin;maximumNearDeltaMetres:number;maximumObservedDeltaMetres:number;interpretation:string};
}
interface Qualification {
  schemaVersion:1;kind:'qualified-single-sample-parent-terrain-source';
  primary:{indexSha256:string;ledgerSha256:string;snapshot:string;zoom:number;layer:string;version:string};
  metadata:FilePin;originSha256:string;scope:FilePin;
  guardMetres:128;protectedBuildRegions:{id:string;boundsRuntimeXZ:Rectangle}[];
  sample:QualifiedSample;reason:string;
}
export interface TerrainFallbackInputs {indexBytes:Uint8Array;ledgerBytes:Uint8Array;originBytes:Uint8Array;snapshotName:string}
const rectangle=(v:unknown):v is Rectangle=>Array.isArray(v)&&v.length===4&&v.every(Number.isFinite)&&v[0]<v[2]&&v[1]<v[3];
const bits=(value:number)=>{const f=new Float32Array([value]);return new Uint32Array(f.buffer)[0]!.toString(16).padStart(8,'0');};
function checkedFile(root:string,ref:FilePin){
  assert.ok(ref&&typeof ref.path==='string'&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=2_000_000,'Invalid fallback file pin');assert.match(ref.sha256,/^[a-f0-9]{64}$/);
  const file=path.resolve(root,ref.path),stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Fallback input must be a regular file');assert.equal(stat.size,ref.bytes);
  const bytes=fs.readFileSync(file);assert.equal(sha(bytes),ref.sha256,'Fallback file changed: '+path.basename(file));return bytes;
}

/** A reviewed coarser source triangle, never a nearest-height fill. This adapter
 * has exactly one authorized coordinate and leaves every available primary
 * sample untouched. A changed source, scope or unexpected hole fails closed. */
export function loadQualifiedTerrainFallback(file:string,inputs:TerrainFallbackInputs){
  const root=path.dirname(path.resolve(file)),raw=fs.readFileSync(file);assert.ok(raw.length<=64_000,'Fallback qualification too large');
  const q=JSON.parse(raw.toString())as Qualification;assert.equal(q.schemaVersion,1);assert.equal(q.kind,'qualified-single-sample-parent-terrain-source');
  assert.equal(q.primary.indexSha256,sha(inputs.indexBytes));assert.equal(q.primary.ledgerSha256,sha(inputs.ledgerBytes));assert.equal(q.originSha256,sha(inputs.originBytes));assert.equal(q.primary.snapshot,inputs.snapshotName);
  const index=JSON.parse(Buffer.from(inputs.indexBytes).toString()),ledger=JSON.parse(Buffer.from(inputs.ledgerBytes).toString()),origin=JSON.parse(Buffer.from(inputs.originBytes).toString());
  const snapshot=ledger.snapshots?.[inputs.snapshotName];assert.ok(snapshot);assert.equal(snapshot.sha256,q.primary.indexSha256);assert.equal(index.zoom,q.primary.zoom);assert.equal(q.primary.zoom,18);assert.equal(snapshot.layer,q.primary.layer);assert.equal(snapshot.layerVersion,q.primary.version);
  assert.equal(ledger.source.crs,'EPSG:4326');assert.equal(ledger.source.heightDatum,'N2000');
  const metadata=JSON.parse(checkedFile(root,q.metadata).toString());assert.equal(q.metadata.sha256,snapshot.layerJsonSha256);assert.equal(metadata.version,q.primary.version);assert.equal(metadata.projection,'EPSG:4326');assert.equal(metadata.scheme,'tms');assert.equal(metadata.format,'quantized-mesh-1.0');
  const scope=JSON.parse(checkedFile(root,q.scope).toString());assert.equal(scope.originId,origin.id);assert.deepEqual(scope.originProjected,origin.originProjected);assert.equal(q.guardMetres,128);
  assert.ok(Array.isArray(q.protectedBuildRegions)&&q.protectedBuildRegions.length>0&&q.protectedBuildRegions.length<=32);const ids=new Set<string>();
  for(const r of q.protectedBuildRegions){assert.ok(typeof r.id==='string'&&!ids.has(r.id)&&rectangle(r.boundsRuntimeXZ));ids.add(r.id);}
  for(const r of scope.regions){assert.ok(rectangle(r.boundsXZ));const protectedRegion=q.protectedBuildRegions.find(p=>p.id===r.id);assert.ok(protectedRegion,'Missing planned build guard');const b=protectedRegion.boundsRuntimeXZ;assert.ok(b[0]<=r.boundsXZ[0]&&b[1]<=r.boundsXZ[1]&&b[2]>=r.boundsXZ[2]&&b[3]>=r.boundsXZ[3],'Fallback guards do not cover planned region');}
  const s=q.sample;assert.ok(s&&Array.isArray(s.runtimeXZ)&&s.runtimeXZ.length===2&&s.runtimeXZ.every(Number.isSafeInteger));assert.ok(Array.isArray(s.projectedEN)&&s.projectedEN.length===2&&s.projectedEN.every(Number.isFinite));
  const [x,z]=s.runtimeXZ,[E0,N0,H0]=origin.originProjected;assert.deepEqual(s.projectedEN,[E0+x,N0-z]);assert.ok(Number.isFinite(H0));
  for(const r of q.protectedBuildRegions){const b=r.boundsRuntimeXZ,g=q.guardMetres;assert.ok(x<b[0]-g||x>b[2]+g||z<b[1]-g||z>b[3]+g,'Fallback point is inside a planned build guard');}
  const parent=s.parent;assert.equal(parent.zoom,q.primary.zoom-1);assert.ok(Number.isSafeInteger(parent.x)&&Number.isSafeInteger(parent.y));
  assert.ok(metadata.available?.[parent.zoom]?.some((a:any)=>parent.x>=a.startX&&parent.x<=a.endX&&parent.y>=a.startY&&parent.y<=a.endY),'Parent tile is not advertised by pinned metadata');
  assert.ok(Array.isArray(metadata.tiles)&&metadata.tiles.length===1&&typeof metadata.tiles[0]==='string');
  const parentUrl=new URL(metadata.tiles[0].replace('{z}',String(parent.zoom)).replace('{x}',String(parent.x)).replace('{y}',String(parent.y)).replace('{version}',q.primary.version),q.primary.layer).href,download=JSON.parse(checkedFile(root,parent.downloadReceipt).toString());
  assert.equal(download.url,parentUrl);assert.deepEqual(download.tile,{z:parent.zoom,x:parent.x,y:parent.y});assert.equal(download.sha256,parent.file.sha256);assert.equal(download.bytes,parent.file.bytes);assert.equal(download.layerVersion,q.primary.version);assert.equal(download.layerJsonSha256,q.metadata.sha256);
  const [lat,lon]=gk25ToGeodetic(s.projectedEN[0],s.projectedEN[1]),d=tileDegrees(parent.zoom),fx=(lon+180)/d,fy=(lat+90)/d;assert.equal(Math.floor(fx),parent.x);assert.equal(Math.floor(fy),parent.y);
  const primaryD=tileDegrees(q.primary.zoom),primaryX=Math.floor((lon+180)/primaryD),primaryY=Math.floor((lat+90)/primaryD);assert.equal(Math.floor(primaryX/2),parent.x);assert.equal(Math.floor(primaryY/2),parent.y);assert.ok(index.tiles.some((t:any)=>t.x===primaryX&&t.y===primaryY),'Missing primary tile is not a qualified triangle gap');
  const tile=decodeQuantizedMesh(checkedFile(root,parent.file)),triangle=s.triangle;assert.ok(Number.isSafeInteger(triangle.index)&&triangle.index>=0&&triangle.index*3+2<tile.indices.length);
  const vertices=Array.from(tile.indices.subarray(triangle.index*3,triangle.index*3+3)),uv=vertices.map(i=>[tile.u[i]!,tile.v[i]!]),heights=vertices.map(i=>tile.height[i]!);assert.deepEqual(vertices,triangle.vertices);assert.deepEqual(uv,triangle.uv);assert.deepEqual(heights,triangle.heightsN2000);
  const [[ax,ay],[bx,by],[cx,cy]]=uv as [[number,number],[number,number],[number,number]],pu=(fx-parent.x)*32767,pv=(fy-parent.y)*32767,det=(bx-ax)*(cy-ay)-(cx-ax)*(by-ay);assert.notEqual(det,0);
  const l1=((bx-pu)*(cy-pv)-(cx-pu)*(by-pv))/det,l2=((cx-pu)*(ay-pv)-(ax-pu)*(cy-pv))/det,l3=1-l1-l2;
  assert.ok([l1,l2,l3].every(v=>Number.isFinite(v)&&v>=0&&v<=1),'Parent source triangle does not strictly contain point');assert.deepEqual([l1,l2,l3],triangle.barycentric);
  const height=l1*heights[0]!+l2*heights[1]!+l3*heights[2]!;assert.equal(height,s.heightN2000);assert.equal(bits(height-H0),s.runtimeFloat32Bits);assert.ok(typeof q.reason==='string'&&q.reason.length>20);
  const comparison=JSON.parse(checkedFile(root,s.lodComparison.report).toString());assert.equal(comparison.parentTile.sha256,parent.file.sha256);assert.deepEqual(comparison.pointEN,s.projectedEN);assert.equal(comparison.comparison.maxAbsoluteNearDelta,s.lodComparison.maximumNearDeltaMetres);assert.equal(comparison.comparison.maxAbsoluteParentChildDelta,s.lodComparison.maximumObservedDeltaMetres);assert.equal(comparison.comparison.interpretation,s.lodComparison.interpretation);
  let used=false;
  return{
    sample(primaryHeight:number|null,runtimeX:number,runtimeZ:number):number|null{
      if(primaryHeight!==null)return primaryHeight;
      if(runtimeX!==x||runtimeZ!==z)return null;
      assert.ok(!used,'Qualified fallback sample used more than once');used=true;return height;
    },
    provenance(){return{kind:q.kind,qualificationSha256:sha(raw),primaryIndexSha256:q.primary.indexSha256,primaryLedgerSha256:q.primary.ledgerSha256,layer:q.primary.layer,version:q.primary.version,scopeSha256:q.scope.sha256,guardMetres:q.guardMetres,protectedBuildRegions:q.protectedBuildRegions,usedSamples:used?1:0,samples:used?[{runtimeXZ:s.runtimeXZ,projectedEN:s.projectedEN,parent:{zoom:parent.zoom,x:parent.x,y:parent.y,url:parentUrl,bytes:parent.file.bytes,sha256:parent.file.sha256,downloadReceiptSha256:parent.downloadReceipt.sha256},triangle,sourceHeightN2000:height,runtimeHeight:Math.fround(height-H0),runtimeFloat32Bits:s.runtimeFloat32Bits,lodComparison:{reportSha256:s.lodComparison.report.sha256,maximumNearDeltaMetres:s.lodComparison.maximumNearDeltaMetres,maximumObservedDeltaMetres:s.lodComparison.maximumObservedDeltaMetres,interpretation:s.lodComparison.interpretation},reason:q.reason}]:[]};},
  };
}
