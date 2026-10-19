import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import {registeredBridgeDecks,sourceCoastalDecks,type CoastalOsm} from '../lib/coastal-mask.ts';
import {bbox,pointInPolygon,signedArea,type LocalPolygon,type Ring} from '../lib/geometry.ts';

const source=JSON.parse(readFileSync(new URL('./fixtures/coastal-decks-source.json',import.meta.url),'utf8')) as {originProjected:number[];osm:CoastalOsm;parts:LocalPolygon[]};
const polygon=(id:string,ring:Ring,main='Ajorata',sub='Ajorata',name='Bridge'):LocalPolygon=>({id,rings:[ring],bbox:bbox([ring]),properties:{paatyyppi:main,alatyyppi:sub,alueen_nimi:name,aluetieto:'Katu'}});
const rectangle=(id:string,x0:number,x1:number,y0:number,y1:number,main='Ajorata',sub='Ajorata',name='Bridge')=>polygon(id,[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],main,sub,name);
function syntheticBridge(){
  const origin=geodeticToGk25(60.17,24.95);
  const osm:CoastalOsm={elements:[{type:'node',id:1,lat:60.17,lon:24.94982},{type:'node',id:2,lat:60.17,lon:24.95018},{type:'way',id:10,nodes:[1,2],tags:{bridge:'yes',highway:'residential',name:'Bridge'}}]};
  const p=osm.elements.filter(e=>e.type==='node').map(e=>{const xy=geodeticToGk25(e.lat!,e.lon!);return[xy[0]-origin[0],xy[1]-origin[1]];});
  return {origin:[...origin,7.5],osm,west:p[0]!,east:p[1]!};
}

test('frozen source retains Halkolaituri pier and the measured Pitkäsilta/Kanavakatu gaps exactly',()=>{
  const before=structuredClone(source),old=registeredBridgeDecks(source.osm,source.parts,source.originProjected),result=sourceCoastalDecks(source.osm,source.parts,source.originProjected);
  assert.deepEqual(result.matches,old.matches,'existing axis evidence stays unchanged');
  for(const id of ['67546','648431','481790'])assert.ok(result.bridgeEndPartIds.includes(id),`missing source approach/median ${id}`);
  assert.ok(result.polygons.some(p=>p.id==='481791'));
  assert.ok(result.separateDeckPartIds.includes('350599'));
  assert.ok(result.pierWays.includes(24480974));
  for(const id of result.bridgeEndPartIds.concat(result.separateDeckPartIds))assert.equal(result.polygons.find(p=>p.id===id),source.parts.find(p=>p.id===id),'source footprint and object retained');
  for(const[x,z]of [[-115,-793],[-116,-736],[318.65,121.04]])assert.ok(result.polygons.some(p=>pointInPolygon([x!,-z!],p.rings)),`unsupported reported point ${x},${z}`);
  const pier=result.polygons.find(p=>p.id==='osm-pier-24480974')!,nodes=new Map(source.osm.elements.filter(e=>e.type==='node').map(e=>[e.id,e]));
  const way=source.osm.elements.find(e=>e.type==='way'&&e.id===24480974)!;
  const exact=way.nodes!.slice(0,-1).map(id=>{const n=nodes.get(id)!,[e,north]=geodeticToGk25(n.lat!,n.lon!);return[e-source.originProjected[0]!,north-source.originProjected[1]!] as [number,number];});
  assert.deepEqual(new Set(pier.rings[0]!.map(p=>JSON.stringify(p))),new Set(exact.map(p=>JSON.stringify(p))));
  assert.ok(Math.abs(Math.abs(signedArea(pier.rings[0]!))-Math.abs(signedArea(exact)))<1e-8);
  const road=source.osm.elements.find(e=>e.type==='way'&&e.id===51335028)!;
  for(let i=0;i+1<road.nodes!.length;i++) {
    const a=nodes.get(road.nodes![i]!)!,b=nodes.get(road.nodes![i+1]!)!;
    const aa=geodeticToGk25(a.lat!,a.lon!),bb=geodeticToGk25(b.lat!,b.lon!);
    for(let j=1;j<10;j++){const p:[number,number]=[aa[0]+(bb[0]-aa[0])*j/10-source.originProjected[0]!,aa[1]+(bb[1]-aa[1])*j/10-source.originProjected[1]!];assert.ok(pointInPolygon(p,pier.rings));}
  }
  assert.deepEqual(source,before,'raw fixture state is unchanged');
});

test('explicit supported Silta decks survive without a bridge axis, while structural/water/park parts do not',()=>{
  const deck=rectangle('explicit',50,60,50,60,'Silta','Kevyt liikenne (Silta)'),road=rectangle('road',60,70,50,60,'Silta','Ajorata (Silta)'),wall=rectangle('wall',70,80,50,60,'Silta','Reunapalkki');
  const park=rectangle('park',80,90,50,60,'Puisto','Puisto'),water=rectangle('water',90,100,50,60,'Vesialue','Vesialue');
  const result=sourceCoastalDecks({elements:[]},[deck,road,wall,park,water],[25497350,6672960,7.5]);
  assert.deepEqual(result.polygons,[deck,road]);assert.deepEqual(result.separateDeckPartIds,['explicit','road']);assert.deepEqual(result.matches,[]);
});

test('bridge companions require original-seed adjacency, matching source block and a nearby endpoint',()=>{
  const {osm,origin,west,east}=syntheticBridge();
  const seed=rectangle('seed',west[0]!-1,east[0]!+1,-1,1);
  const direct=rectangle('direct',east[0]!,east[0]!+2,1,2);
  const second=rectangle('second',east[0]!,east[0]!+2,2,3);
  const gap=rectangle('gap',east[0]!-3,east[0]!-2,1.003,2);
  const tolerated=rectangle('survey-rounding',west[0]!,west[0]!+1,1.001,2);
  const wrongName=rectangle('wrong-name',west[0]!,west[0]!+1,-2,-1,'Ajorata','Ajorata','Other street');
  const midpoint=rectangle('far-from-endpoint',-1,1,1,2);
  const park={...rectangle('park',east[0]!,east[0]!+1,-2,-1),properties:{...direct.properties,aluetieto:'Viheralue'}};
  const water=rectangle('water',east[0]!,east[0]!+1,-2,-1,'Vesialue','Vesialue');
  const result=sourceCoastalDecks(osm,[seed,direct,second,gap,tolerated,wrongName,midpoint,park,water],origin);
  assert.deepEqual(result.bridgeEndPartIds,['direct','survey-rounding']);
  assert.deepEqual(result.polygons.map(p=>p.id),['seed','direct','survey-rounding']);
  const reverse=sourceCoastalDecks(osm,[water,park,midpoint,wrongName,tolerated,gap,second,direct,seed],origin);
  assert.deepEqual(reverse.bridgeEndPartIds,result.bridgeEndPartIds,'selection never propagates through second-hop candidates or iteration order');
});

test('an endpoint touch cannot retain a large source road or an unbounded transverse polygon',()=>{
  const{osm,origin,west,east}=syntheticBridge(),seed=rectangle('seed',west[0]!-1,east[0]!+1,-1,1);
  const long=rectangle('long',east[0]!,east[0]!+50,1,2),wide=rectangle('wide',east[0]!,east[0]!+2,1,10),large=rectangle('large',west[0]!,east[0]!,1,15);
  const result=sourceCoastalDecks(osm,[seed,long,wide,large],origin);
  assert.deepEqual(result.polygons,[seed]);assert.deepEqual(result.bridgeEndPartIds,[]);
});

test('only complete simple closed pier areas qualify; open, area=no, missing and degenerate ways do not',()=>{
  const nodes=[{type:'node',id:1,lat:60.17,lon:24.95},{type:'node',id:2,lat:60.17,lon:24.9502},{type:'node',id:3,lat:60.1702,lon:24.9502},{type:'node',id:4,lat:60.1702,lon:24.95}];
  const way=(id:number,ids:number[],tags:Record<string,string>={})=>({type:'way',id,nodes:ids,tags:{man_made:'pier',...tags}});
  const osm:CoastalOsm={elements:[...nodes,way(10,[1,2,3,4,1]),way(11,[1,2,3,4]),way(12,[1,2,3,4,1],{area:'no'}),way(13,[1,2,99,4,1]),way(14,[1,2,1,1]),way(15,[1,3,2,4,1])]};
  const before=structuredClone(osm),result=sourceCoastalDecks(osm,[],[25497350,6672960,7.5]);
  assert.deepEqual(result.pierWays,[10]);assert.equal(result.polygons.length,1);assert.deepEqual(osm,before);
});
