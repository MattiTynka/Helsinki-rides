import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildDistrictGround,groundAssemblyArea,boundCarriagewayMeshCells,type DistrictGroundConfig} from '../lib/district-ground.ts';
import {buildCarriagewayGrade,createGroundSupportSampler} from '../lib/carriageway-grade.ts';
import {clipGroundToRectangle} from '../lib/append-city-cells.ts';
import {gk25ToGeodetic,type TerrainGrid} from '../../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons,type LocalPolygon} from '../lib/geometry.ts';
import type {GroundPiece} from '../lib/ground.ts';

test('ground work area uses a 32m clamped margin and default returns the original full area',()=>{
 const full={minX:-1792,maxX:800,minZ:-950,maxZ:450};assert.equal(groundAssemblyArea(full),full);
 assert.deepEqual(groundAssemblyArea(full,{minX:-1792,maxX:-1350,minZ:-950,maxZ:450}),{minX:-1792,maxX:-1318,minZ:-950,maxZ:450});
 assert.throws(()=>groundAssemblyArea(full,{minX:-1800,maxX:-1350,minZ:-950,maxZ:450}),/inside/);
 assert.throws(()=>groundAssemblyArea(full,{minX:-1700,maxX:-1700,minZ:-950,maxZ:450}),/invalid/);
});

test('bounded road meshing retains full field nodes, masks, raw-deck interpolation and sampling closures',()=>{
 const area={minX:-96,maxX:96,minZ:-16,maxZ:16},terrain:TerrainGrid={x0:-96,z0:-16,nx:193,nz:33,resolution:1,heights:new Float32Array(193*33)};
 for(let z=0;z<33;z++)for(let x=0;x<193;x++)terrain.heights[z*193+x]=Math.abs(x-144)<2?-20:x/100;
 const p=(id:string,x0:number,x1:number,deck=false):LocalPolygon=>({id,rings:[[[x0,-4],[x1,-4],[x1,4],[x0,4]]],bbox:[x0,-4,x1,4],properties:{paatyyppi:deck?'Silta':'Ajorata',alatyyppi:deck?'Ajorata (Silta)':'Ajorata'}});
 const full=buildCarriagewayGrade([p('a',-96,0),p('deck',0,4,true),p('b',4,96)],terrain,{area,protectedArea:{minX:200,maxX:210,minZ:200,maxZ:210},gridMetres:4,maxAxisGrade:.35,rawSourceDeckPartIds:['deck'],rawDeckTieInMetres:8}),bound=boundCarriagewayMeshCells(full,{minX:-96,maxX:-32,minZ:-16,maxZ:16});
 assert.ok(bound.cells.length<full.cells.length/2);for(const key of['nodes','parts','protectedSurfaces','sample','rawDeckTieIn','options','stats']as const)assert.equal(bound[key],full[key],`${key} must stay full`);
 for(let x=-96;x<=96;x+=.5)assert.equal(bound.sample(x,1),full.sample(x,1));assert.ok(bound.sample(64,1)!==null,'sample remains available beyond generated meshes');
});

test('full and bounded district builds retain identical road, sidewalk and wall triangles and support inside the target',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-ground-area-'));try{
 const origin=[25497350,6672960,7.5],fullArea={minX:-96,maxX:96,minZ:-48,maxZ:48},target={minX:-64,maxX:-32,minZ:-16,maxZ:24},terrain:TerrainGrid={x0:-96,z0:-48,nx:193,nz:97,resolution:1,heights:new Float32Array(193*97)};
 for(let iz=0;iz<97;iz++)for(let ix=0;ix<193;ix++){const x=ix-96,z=iz-48;terrain.heights[iz*193+ix]=.01*x+.02*z+(z>16?3:0)+(Math.hypot(x+48,z)<2?-3:0);}
 const feature=(id:number,x0:number,x1:number,n0:number,n1:number,main:string,sub:string)=>({type:'Feature',properties:{osan_id:id,paatyyppi:main,alatyyppi:sub,materiaali:'Asfalttibetoni'},geometry:{type:'Polygon',coordinates:[[[x0,n0],[x1,n0],[x1,n1],[x0,n1],[x0,n0]].map(([x,n])=>[origin[0]!+x!,origin[1]!+n!])]}});
 const street=path.join(temp,'parts.geojson');fs.writeFileSync(street,JSON.stringify({type:'FeatureCollection',features:[feature(1,-96,96,-4,4,'Ajorata','Ajorata'),feature(2,-96,96,4,12,'Kevyt liikenne','Jalankulkualue'),feature(3,-96,96,-24,-18,'Kevyt liikenne','Jalankulkualue')]}));
 const node=(id:number,x:number,n:number)=>{const[lat,lon]=gk25ToGeodetic(origin[0]!+x,origin[1]!+n);return{type:'node',id,lat,lon};};
 const osm=Buffer.from(JSON.stringify({elements:[node(1,-90,-16),node(2,90,-16),{type:'way',id:3,nodes:[1,2],tags:{barrier:'retaining_wall'}}]}));fs.writeFileSync(path.join(temp,'osm.json'),osm);const ledger=path.join(temp,'ledger.json');fs.writeFileSync(ledger,JSON.stringify({snapshots:{test:{path:'osm.json',sha256:createHash('sha256').update(osm).digest('hex')}}}));
 const config=JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/district-expansion/cells.json',import.meta.url),'utf8'));config.playArea=fullArea;delete config.coastal;delete config.drivableCorridors;config.carriagewayGrade={protectedArea:{minX:200,maxX:210,minZ:200,maxZ:210},gridMetres:4,maxAxisGrade:.35};
 const options={terrain,footprints:[],originProjected:origin,config:config as DistrictGroundConfig,osmLedger:ledger,osmSnapshot:'test',streetParts:street};
 const full=buildDistrictGround(options),bounded=buildDistrictGround({...options,groundWorkArea:target});
 assert.ok(full.walls.walls.length>0,'fixture must create a real retaining wall');assert.ok(bounded.ground.pieces.length<full.ground.pieces.length*.75,'bounded generation must materially reduce meshes');
 assert.deepEqual(bounded.stairs,full.stairs);assert.deepEqual(bounded.terraces,full.terraces);assert.deepEqual(bounded.walls.collisionFloors,full.walls.collisionFloors);assert.deepEqual(bounded.walls.cuts,full.walls.cuts);
 const rect=[target.minX,target.minZ,target.maxX,target.maxZ]as const,retained=(pieces:GroundPiece[])=>clipGroundToRectangle(pieces,rect);
 const triangles=(pieces:GroundPiece[])=>pieces.flatMap(p=>Array.from({length:p.indices.length/3},(_,i)=>JSON.stringify({tag:p.tag,finish:p.finish,use:p.use??'both',vertices:[0,1,2].map(k=>{const at=p.indices[i*3+k]!;return [...p.positions.slice(at*3,at*3+3),...p.uvs.slice(at*2,at*2+2)];}).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}))).sort();
 const a=[...retained(full.ground.pieces),...retained(full.ground.kerbs)],b=[...retained(bounded.ground.pieces),...retained(bounded.ground.kerbs)];assert.deepEqual(triangles(b),triangles(a),'retained geometry and UVs must match');
 const fullSupport=createGroundSupportSampler(a),boundedSupport=createGroundSupportSampler(b);let probes=0;
 for(let x=-63.75;x<-32;x+=.5)for(let z=-15.75;z<24;z+=.5){const p=fullSupport(x,z),q=boundedSupport(x,z);assert.equal(q?.height,p?.height);probes++;}assert.ok(probes>5000);
 assert.ok(a.some(p=>p.tag==='road:asphalt'));assert.ok(a.some(p=>p.level==='raised'));assert.ok(a.some(p=>p.tag==='wall'));
 const source=loadGeoJsonPolygons(street,origin[0]!,origin[1]!,p=>String(p.osan_id));assert.equal(source.length,3);
 }finally{const absolute=path.resolve(temp);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('helsinki-ground-area-'));fs.rmSync(absolute,{recursive:true,force:true});}
});
