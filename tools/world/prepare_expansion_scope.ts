// Produce an explicit grid delta and projected source envelopes from a pinned accepted manifest.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {cellId} from '../../packages/world-schema/src/index.ts';
const {values}=parseArgs({options:{scope:{type:'string'},manifest:{type:'string'},out:{type:'string'}}});
assert.ok(values.scope&&values.manifest&&values.out,'--scope, --manifest, --out required');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const scopeBytes=fs.readFileSync(values.scope),scope=JSON.parse(scopeBytes.toString('utf8'));
const manifestBytes=fs.readFileSync(values.manifest),manifest=JSON.parse(manifestBytes.toString('utf8'));
assert.equal(sha(manifestBytes),scope.acceptedManifestSha256,'accepted manifest drift');
assert.equal(scope.cellSize,manifest.cellSize);assert.equal(scope.originId,manifest.origin.id);
assert.equal(scope.cellSize,128);assert.ok(!fs.existsSync(values.out),'fresh output required');
const old=new Set(manifest.cells.map((c:any)=>c.id));assert.equal(old.size,manifest.cells.length);
const selected=new Set<string>(),features:any[]=[],regions:any[]=[];
const [E0,N0]=scope.originProjected;
const polygon=(b:number[])=>[[E0+b[0]!,N0-b[1]!],[E0+b[2]!,N0-b[1]!],[E0+b[2]!,N0-b[3]!],[E0+b[0]!,N0-b[3]!],[E0+b[0]!,N0-b[1]!]];
for(const region of scope.regions){
 const b=region.boundsXZ;assert.ok(b.length===4&&b.every((n:number)=>Number.isSafeInteger(n)&&n%128===0)&&b[0]<b[2]&&b[1]<b[3]);
 const cells:any[]=[],retained:string[]=[];
 for(let x=b[0];x<b[2];x+=128)for(let z=b[1];z<b[3];z+=128){const id=cellId(x/128,z/128);if(old.has(id)){retained.push(id);continue;}assert.ok(!selected.has(id),'regions overlap: '+id);selected.add(id);const boundsXZ=[x,z,x+128,z+128];cells.push({id,cx:x/128,cz:z/128,boundsXZ});features.push({type:'Feature',properties:{id,stage:region.stage,classification:'new-source-envelope-not-qualified-land'},geometry:{type:'Polygon',coordinates:[polygon(boundsXZ)]}});}
 regions.push({...region,newCells:cells,acceptedCellsRetained:retained,gridAreaSquareMetres:cells.length*128*128,polygonEN:polygon(b)});
}
const t=scope.terrainExtent,nx=t[2]-t[0]+1,nz=t[3]-t[1]+1,terrainDecodedBytes=32+4*nx*nz;
assert.ok(terrainDecodedBytes<=64*1024*1024,'proposed terrain exceeds unchanged decoded simulation cap');
const report={schemaVersion:1,status:'SCOPE_BOUND_NOT_PLAYABLE_ACCEPTANCE',sourceManifestSha256:sha(manifestBytes),scopeSha256:sha(scopeBytes),acceptedCells:old.size,newGridCells:selected.size,regions,terrain:{boundsXZ:t,resolution:1,nx,nz,decodedBytes:terrainDecodedBytes,capBytes:64*1024*1024},remainingGates:['source ownership and conflicts','named water/private/crossing exclusions','supported pedestrian and vehicle connections','native runtime acceptance']};
fs.mkdirSync(values.out,{recursive:true});
const put=(name:string,value:unknown)=>fs.writeFileSync(path.join(values.out!,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
put('scope-receipt.json',report);put('new-cells.epsg3879.geojson',{type:'FeatureCollection',crs:{type:'name',properties:{name:'urn:ogc:def:crs:EPSG::3879'}},features});
for(const region of regions)put(region.id+'.cells.json',region.newCells);
const colours:Record<string,string>={A:'#ffba49',B:'#68c5b4',C:'#b69de8',D:'#ed8597'},svg:string[]=[];
svg.push('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1120" viewBox="-3050 -2650 4200 4900"><rect x="-3050" y="-2650" width="4200" height="4900" fill="#172333"/><g stroke="#172333" stroke-width="3">');
for(const cell of manifest.cells)svg.push(`<rect x="${cell.cx*128}" y="${cell.cz*128}" width="128" height="128" fill="#60758a"/>`);
for(const region of regions)for(const cell of region.newCells)svg.push(`<rect x="${cell.cx*128}" y="${cell.cz*128}" width="128" height="128" fill="${colours[region.stage]}"/>`);
svg.push('</g><g fill="white" font-family="sans-serif" font-size="62"><text x="-2900" y="-2470">Southwest source envelopes • 128 m grid</text><text x="-2900" y="2010">Grey: accepted 515 cells • A24 / B40 / C104 / D68 new</text><text x="-2900" y="2120">Grid cells include water; playable routes require qualification.</text></g><circle cx="0" cy="0" r="22" fill="white"/><text x="50" y="20" font-family="sans-serif" font-size="45" fill="white">Senate Square</text></svg>');
fs.writeFileSync(path.join(values.out,'coverage.svg'),svg.join('\n'),{flag:'wx'});
console.log(JSON.stringify({status:report.status,acceptedCells:old.size,newGridCells:selected.size,terrainDecodedBytes}));
