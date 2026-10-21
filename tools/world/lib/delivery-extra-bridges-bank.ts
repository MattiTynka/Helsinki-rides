// A source-buffer bank is distinct from the runtime heightfield. Its exact
// quantized source samples are retained for independent replay; no edge clamp
// or interpolation across a missing source tile is permitted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {buildGround} from './ground.ts';
import {loadGeoJsonPolygons} from './geometry.ts';
import {loadTerrainSnapshot} from './quantized-mesh.ts';
import {deliverySha} from './delivery-city-payloads.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './delivery-city-provenance.ts';
import type {ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
export interface ExtraBridgeBankSource {
  schemaVersion:1;kind:'quantized-source-municipal-outside-bank-v1';
  originProjected:[number,number,number];
  terrain:{indexSha256:string;layer:string;version:string;zoom:number;tiles:{url:string;sha256:string}[]};
  streetParts:{path:string;sha256:string};partIds:number[];
  grid:{x0:number;z0:number;nx:number;nz:number;resolution:1;sourceN2000:number[]};
  area:{minX:number;maxX:number;minZ:number;maxZ:number};curbHeightMetres:number;
  piecesSha256:string;producer:ReturnType<typeof publicDeliveryProducer>;
}
function bankGround(source:ExtraBridgeBankSource,root:string){
  assert.equal(source.schemaVersion,1);assert.equal(source.kind,'quantized-source-municipal-outside-bank-v1');
  assert.deepEqual(source.originProjected,[25497350,6672960,7.5]);
  assert.match(source.terrain.indexSha256,/^[a-f0-9]{64}$/);assert.equal(source.terrain.layer,'https://kartta.hel.fi/3d/datasource-data/4383570b-33a3-4a9f-ae16-93373aff5ffa/');assert.equal(source.terrain.version,'1.1708423032937557');assert.equal(source.terrain.zoom,18);assert.ok(source.terrain.tiles.length);
  for(const tile of source.terrain.tiles){assert.match(tile.url,/^https:\/\/kartta\.hel\.fi\/3d\/datasource-data\/4383570b-33a3-4a9f-ae16-93373aff5ffa\/18\/\d+\/\d+\.terrain\?v=1\.1708423032937557$/);assert.match(tile.sha256,/^[a-f0-9]{64}$/);}
  const g=source.grid;assert.equal(g.resolution,1);assert.ok(Number.isInteger(g.nx)&&Number.isInteger(g.nz)&&g.nx>=8&&g.nz>=8&&g.nx*g.nz<=100000);assert.equal(g.sourceN2000.length,g.nx*g.nz);assert.ok(g.sourceN2000.every(n=>Number.isFinite(n)&&n>-20&&n<100));
  const area=source.area;assert.ok(area.minX>=g.x0+4&&area.maxX<=g.x0+g.nx-5&&area.minZ>=g.z0+4&&area.maxZ<=g.z0+g.nz-5,'Ground source sampling needs a real halo');assert.ok(source.curbHeightMetres>=0&&source.curbHeightMetres<=.2);
  assert.ok(!path.isAbsolute(source.streetParts.path)&&!source.streetParts.path.split(/[\\/]/).includes('..'));const file=path.resolve(root,source.streetParts.path);assert.equal(deliverySha(fs.readFileSync(file)),source.streetParts.sha256);
  const parts=loadGeoJsonPolygons(file,source.originProjected[0],source.originProjected[1],p=>String(p.osan_id)).filter(p=>source.partIds.includes(Number(p.id)));assert.equal(parts.length,source.partIds.length);assert.ok(parts.every(p=>['Ajorata','Kevyt liikenne','Muu rakenneosa'].includes(String(p.properties.paatyyppi))),'Only explicit non-bridge bank source parts are allowed');
  const terrain={...g,heights:Float32Array.from(g.sourceN2000,y=>y-source.originProjected[2])};return buildGround(parts,terrain,[],area,source.curbHeightMetres,128);
}
export function readExtraBridgeSourceBank(ref:{path:string;sha256:string},root:string):{source:ExtraBridgeBankSource;faces:ExtraBridgeNativeFace[]}{
  assert.ok(!path.isAbsolute(ref.path)&&!ref.path.split(/[\\/]/).includes('..'));const bytes=fs.readFileSync(path.resolve(root,ref.path));assert.equal(deliverySha(bytes),ref.sha256);const source=JSON.parse(bytes.toString())as ExtraBridgeBankSource,ground=bankGround(source,root);assert.equal(deliverySha(JSON.stringify(ground)),source.piecesSha256,'Source bank cannot be reproduced from its pinned grid and municipal parts');
  const faces:ExtraBridgeNativeFace[]=[];for(const[group,pieces]of[['ground',ground.pieces],['kerbs',ground.kerbs]]as const)for(const[pieceIndex,piece]of pieces.entries()){
    if(piece.tag==='raised:yard')continue;for(let triangle=0;triangle<piece.indices.length/3;triangle++)faces.push({points:[0,1,2].map(k=>piece.positions.slice(piece.indices[triangle*3+k]!*3,piece.indices[triangle*3+k]!*3+3).map(Math.fround))as ExtraBridgeNativeFace['points'],cell:`source-buffer:${piece.cell}`,collider:`source-buffer:${group}:${pieceIndex}`,triangle,tag:piece.tag,group});
  }return{source,faces};
}
export function prepareExtraBridgeSourceBank(options:{terrainDirectory:string;expectedTerrainIndexSha256:string;sourceRoot:string;streetParts:{path:string;sha256:string};partIds:number[];area:ExtraBridgeBankSource['area'];out:string}){
  assert.ok(!fs.existsSync(options.out),'Source bank output must be fresh');const producer=bindDeliveryProducer(new URL('./delivery-extra-bridges-bank.ts',import.meta.url)),indexBytes=fs.readFileSync(path.join(options.terrainDirectory,'tiles.json'));assert.equal(deliverySha(indexBytes),options.expectedTerrainIndexSha256);const index=JSON.parse(indexBytes.toString()),snapshot=loadTerrainSnapshot(options.terrainDirectory,deliverySha),a=options.area,x0=Math.floor(a.minX)-8,z0=Math.floor(a.minZ)-8,nx=Math.ceil(a.maxX)+8-x0+1,nz=Math.ceil(a.maxZ)+8-z0+1,sourceN2000:number[]=[];
  assert.ok([a.minX,a.minZ,a.maxX,a.maxZ].every(Number.isFinite)&&a.minX<a.maxX&&a.minZ<a.maxZ&&nx>=8&&nz>=8&&nx*nz<=100000,'Outside-bank replay must use a finite bounded source grid');
  for(let z=0;z<nz;z++)for(let x=0;x<nx;x++){const y=snapshot.heightAtEN(25497350+x0+x,6672960-z0-z);assert.ok(y!==null,`No source-buffer terrain at ${x0+x},${z0+z}`);sourceN2000.push(y);}
  const source:ExtraBridgeBankSource={schemaVersion:1,kind:'quantized-source-municipal-outside-bank-v1',originProjected:[25497350,6672960,7.5],terrain:{indexSha256:options.expectedTerrainIndexSha256,layer:index.layer,version:index.version,zoom:index.zoom,tiles:index.tiles.map((t:any)=>({url:t.url,sha256:t.sha256}))},streetParts:options.streetParts,partIds:options.partIds,grid:{x0,z0,nx,nz,resolution:1,sourceN2000},area:a,curbHeightMetres:.12,piecesSha256:'',producer:publicDeliveryProducer(producer)};source.piecesSha256=deliverySha(JSON.stringify(bankGround(source,options.sourceRoot)));verifyDeliveryProducer(producer);assert.equal(deliverySha(fs.readFileSync(path.join(options.terrainDirectory,'tiles.json'))),options.expectedTerrainIndexSha256);const bytes=Buffer.from(JSON.stringify(source)+'\n');fs.mkdirSync(path.dirname(options.out),{recursive:true});fs.writeFileSync(options.out,bytes,{flag:'wx'});return{bytes:bytes.length,sha256:deliverySha(bytes),samples:nx*nz,piecesSha256:source.piecesSha256};
}
