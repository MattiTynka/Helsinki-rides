// Bounded municipal metadata discovery. No world or previous source snapshot is modified.
// node tools/world/inspect_expansion_sources.ts --scope SCOPE --cache RAW_ROOT --out FRESH_OR_RESUMABLE_DIR
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gk25ToGeodetic} from '../../packages/world-schema/src/index.ts';
import {tileRange} from './lib/quantized-mesh.ts';

const {values}=parseArgs({options:{scope:{type:'string'},cache:{type:'string'},out:{type:'string'}}});
assert.ok(values.scope&&values.cache&&values.out,'--scope, --cache and --out required');
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const scopeBytes=fs.readFileSync(values.scope),scope=JSON.parse(scopeBytes.toString('utf8'));
const out=path.resolve(values.out),cache=path.resolve(values.cache),scopeSha256=sha(scopeBytes);
assert.equal(scope.schemaVersion,1);assert.equal(scope.crs,'EPSG:3879');assert.equal(scope.heightDatum,'N2000');
assert.equal(scope.originId,'senate-square-statue-v2');assert.deepEqual(scope.originProjected,[25497350,6672960,7.5]);
assert.equal(scope.cellSize,128);assert.ok(scope.sourceHaloMetres>=0&&scope.sourceHaloMetres<=256);
type Rect=[number,number,number,number];
const valid=(r:unknown):r is Rect=>Array.isArray(r)&&r.length===4&&r.every(Number.isFinite)&&r[0]<r[2]&&r[1]<r[3];
assert.ok(Array.isArray(scope.regions)&&scope.regions.length>0&&scope.regions.length<=16);
assert.ok(scope.regions.every((r:any)=>valid(r.boundsXZ)));assert.ok(valid(scope.terrainExtent));
assert.ok(Number.isSafeInteger(scope.metadataBudgetBytes)&&scope.metadataBudgetBytes>0&&scope.metadataBudgetBytes<=32_000_000);
assert.ok(!fs.existsSync(path.join(out,'selection.json')),'completed discovery must not be overwritten');
fs.mkdirSync(out,{recursive:true});
const progressPath=path.join(out,'metadata-ledger.json');
const progress=fs.existsSync(progressPath)?read(progressPath):{schemaVersion:1,scopeSha256,networkBytes:0,metadata:[]};
assert.equal(progress.scopeSha256,scopeSha256,'resumed scope differs');
assert.ok(Number.isSafeInteger(progress.networkBytes)&&progress.networkBytes>=0&&progress.networkBytes<=scope.metadataBudgetBytes);
const save=()=>{const tmp=progressPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify(progress,null,2)+'\n');fs.renameSync(tmp,progressPath);};
function permitted(value:string){const u=new URL(value);assert.ok(u.protocol==='https:'&&u.hostname==='kartta.hel.fi'&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname.startsWith('/3d/datasource-data/'),'unapproved source URL');return u.href;}
async function meta(value:string):Promise<any>{
 const url=permitted(value),file=sha(url)+'.json',previous=progress.metadata.find((m:any)=>m.url===url);
 if(previous){assert.equal(previous.file,file);const b=fs.readFileSync(path.join(out,file));assert.equal(b.length,previous.bytes);assert.equal(sha(b),previous.sha256);return JSON.parse(b.toString('utf8'));}
 assert.ok(!fs.existsSync(path.join(out,file)),'unledgered metadata exists');
 for(let attempt=0;attempt<3;attempt++){
  try{
   const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000),headers:{'User-Agent':'helsinki-world-bounded-source-inspection/1.0'}});
   assert.ok(response.ok,`source HTTP ${response.status}`);assert.ok(response.body);
   const chunks:Buffer[]=[];let bytes=0;
   for await(const chunk of response.body){bytes+=chunk.length;progress.networkBytes+=chunk.length;save();assert.ok(bytes<=8_000_000&&progress.networkBytes<=scope.metadataBudgetBytes,'metadata byte budget exceeded');chunks.push(Buffer.from(chunk));}
   const b=Buffer.concat(chunks),parsed=JSON.parse(b.toString('utf8'));fs.writeFileSync(path.join(out,file),b,{flag:'wx'});
   progress.metadata.push({url,file,bytes:b.length,sha256:sha(b),retrievedAt:new Date().toISOString()});save();return parsed;
  }catch(error){save();if(attempt===2||progress.networkBytes>=scope.metadataBudgetBytes||!(error instanceof TypeError))throw error;}
 }
 throw new Error('metadata request failed');
}
const D=Math.PI/180,I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function projected(r:Rect,halo:number):Rect{return[25497350+r[0]-halo,6672960-r[3]-halo,25497350+r[2]+halo,6672960-r[1]+halo];}
function angular(b:Rect):Rect{const p=[[b[0],b[1]],[b[2],b[1]],[b[0],b[3]],[b[2],b[3]]].map(p=>gk25ToGeodetic(p[0]!,p[1]!));return[Math.min(...p.map(p=>p[1]))*D,Math.min(...p.map(p=>p[0]))*D,Math.max(...p.map(p=>p[1]))*D,Math.max(...p.map(p=>p[0]))*D];}
const regionsEN:Rect[]=scope.regions.map((r:any)=>projected(r.boundsXZ,scope.sourceHaloMetres)),regions=regionsEN.map(angular);
const bboxEN:Rect=[Math.min(...regionsEN.map(r=>r[0])),Math.min(...regionsEN.map(r=>r[1])),Math.max(...regionsEN.map(r=>r[2])),Math.max(...regionsEN.map(r=>r[3]))];
function ecef(lat:number,lon:number,h:number){const a=6378137,f=1/298.257222101,e2=f*(2-f),la=lat*D,lo=lon*D,n=a/Math.sqrt(1-e2*Math.sin(la)**2);return[(n+h)*Math.cos(la)*Math.cos(lo),(n+h)*Math.cos(la)*Math.sin(lo),(n*(1-e2)+h)*Math.sin(la)];}
const circles=regionsEN.map(b=>({centre:ecef(...gk25ToGeodetic((b[0]+b[2])/2,(b[1]+b[3])/2),50),radius:Math.hypot(b[2]-b[0],b[3]-b[1])/2+150}));
function multiply(a:number[],b:number[]){const r=Array<number>(16).fill(0);for(let c=0;c<4;c++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)r[c*4+row]!+=a[k*4+row]!*b[c*4+k]!;return r;}
function meets(tile:any,matrix:number[],trees:boolean){const{region:r,sphere:s}=tile.boundingVolume;
 if(r){assert.ok(r.length===6&&r.every(Number.isFinite));return regions.some(g=>!(r[2]<g[0]||r[0]>g[2]||r[3]<g[1]||r[1]>g[3]));}
 if(s&&trees){assert.ok(s.length===4&&s.every(Number.isFinite)&&s[3]>=0);const[x,y,z,r]=s,scale=Math.max(Math.hypot(matrix[0]!,matrix[1]!,matrix[2]!),Math.hypot(matrix[4]!,matrix[5]!,matrix[6]!),Math.hypot(matrix[8]!,matrix[9]!,matrix[10]!));const c=[matrix[0]!*x+matrix[4]!*y+matrix[8]!*z+matrix[12]!,matrix[1]!*x+matrix[5]!*y+matrix[9]!*z+matrix[13]!,matrix[2]!*x+matrix[6]!*y+matrix[10]!*z+matrix[14]!];return circles.some(g=>Math.hypot(c[0]!-g.centre[0]!,c[1]!-g.centre[1]!,c[2]!-g.centre[2]!)<=r*scale+g.radius);}
 throw new Error('unsupported source bounding volume');
}
function cached(layer:string){const root=path.join(cache,layer),ledger=read(path.join(root,'ledger.json')),entries=Object.values(ledger.snapshots) as any[];assert.equal(entries.length,1,'select a single-vintage cache');const snapshot=entries[0],indexFile=path.join(root,snapshot.path),b=fs.readFileSync(indexFile);assert.equal(sha(b),snapshot.sha256,'cache index drift');return{ledger,snapshot,index:JSON.parse(b.toString('utf8')),root:path.dirname(indexFile)};}
const selections:Record<string,any>={};
for(const[layer,id,trees]of[['lod2','e5e7158a-52df-45a1-9be0-1be8f2828abd',false],['trees/street','7afdc4b9-9a23-4a6f-a1ae-cf71495a731e',true],['trees/plot','561e9651-878a-45a6-99e3-e4e4704d8001',true]] as const){
 const url=`https://kartta.hel.fi/3d/datasource-data/${id}/tileset.json`,root=await meta(url);assert.equal(root.asset?.version,'1.1');assert.ok(typeof root.asset.tilesetVersion==='string');
 const prior=cached(layer),tiles:any[]=[],seen=new Set<string>(),externalSeen=new Set<string>();let visited=0;
 async function walk(tile:any,base:string,parent:number[],depth:number):Promise<void>{
  assert.ok(depth<64&&++visited<100000,'source tree traversal limit');const transform=tile.transform?multiply(parent,tile.transform):parent;
  assert.ok(transform.length===16&&transform.every(Number.isFinite));if(!meets(tile,transform,trees))return;
  const uri=tile.content?.uri??tile.content?.url,children=tile.children??[];
  if(uri){const target=permitted(new URL(uri,base).href);if(new URL(target).pathname.endsWith('.json')){assert.ok(!externalSeen.has(target),'recursive or duplicate tileset');externalSeen.add(target);const sub=await meta(target);await walk(sub.root,target,transform,depth+1);return;}
   if(!children.length){assert.ok(!seen.has(target),'duplicate leaf URL');seen.add(target);tiles.push({url:target,geometricError:tile.geometricError,transform});}}
  for(const child of children)await walk(child,base,transform,depth+1);
 }
 await walk(root.root,url,I,0);assert.ok(tiles.length>0);const sameVersion=root.asset.tilesetVersion===prior.snapshot.tilesetVersion,old=new Map(prior.index.tiles.map((t:any)=>[t.url,t]));
 for(const t of tiles){const entry:any=old.get(t.url);if(sameVersion&&entry){assert.deepEqual(t.transform,entry.transform,'same-vintage transform changed');t.cache={root:prior.root,path:entry.file,bytes:entry.bytes,sha256:entry.sha256};}}
 selections[layer]={version:root.asset.tilesetVersion,url,source:prior.ledger.source,tiles,cachedTiles:tiles.filter(t=>t.cache).length,indexMetadata:{schemaVersion:1,tileset:url,tilesetVersion:root.asset.tilesetVersion,bboxEN}};
 console.log(JSON.stringify({layer,version:root.asset.tilesetVersion,tiles:tiles.length,cached:selections[layer].cachedTiles}));
}
{
 const url='https://kartta.hel.fi/3d/datasource-data/4383570b-33a3-4a9f-ae16-93373aff5ffa/',layer=await meta(url+'layer.json'),prior=cached('terrain');
 assert.equal(layer.format,'quantized-mesh-1.0');assert.equal(layer.scheme,'tms');assert.equal(layer.projection,'EPSG:4326');assert.equal(layer.version,prior.snapshot.layerVersion,'terrain vintage changed; explicit requalification required');
 const extent=projected(scope.terrainExtent,scope.sourceHaloMetres),region=angular(extent),range=tileRange(18,region[1]/D,region[0]/D,region[3]/D,region[2]/D),tiles:any[]=[],old=new Map(prior.index.tiles.map((t:any)=>[t.url,t]));
 assert.ok((range.x1-range.x0+1)*(range.y1-range.y0+1)<10000,'terrain tile count exceeds bound');
 for(let x=range.x0;x<=range.x1;x++)for(let y=range.y0;y<=range.y1;y++){
  assert.ok(layer.available[18].some((a:any)=>x>=a.startX&&x<=a.endX&&y>=a.startY&&y<=a.endY),'terrain unavailable');const target=permitted(new URL(layer.tiles[0].replace('{z}','18').replace('{x}',String(x)).replace('{y}',String(y)).replace('{version}',layer.version),url).href),entry:any=old.get(target);
  tiles.push({z:18,x,y,url:target,...(entry?{cache:{root:prior.root,path:entry.file,bytes:entry.bytes,sha256:entry.sha256}}:{})});
 }
 selections.terrain={version:layer.version,url,source:prior.ledger.source,tiles,cachedTiles:tiles.filter(t=>t.cache).length,indexMetadata:{schemaVersion:1,zoom:18,layer:url,layerVersion:layer.version,bboxEN:extent}};
 console.log(JSON.stringify({layer:'terrain',version:layer.version,tiles:tiles.length,cached:selections.terrain.cachedTiles}));
}
const result={schemaVersion:1,status:'METADATA_SELECTED_NOT_ACQUIRED',scopeSha256,bboxEN,regionsEN,metadata:progress.metadata,metadataBytes:progress.networkBytes,selections};
fs.writeFileSync(path.join(out,'selection.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,metadataBytes:progress.networkBytes}));
