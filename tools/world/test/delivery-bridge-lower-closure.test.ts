import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildSourceBoundLowerClosure,type LowerBridgeClosureInput} from '../lib/delivery-bridge-lower-closure.ts';
import type {SupportTriangle} from '../lib/tram-support-repair.ts';
const floor=(y:number):SupportTriangle[]=>[[[0,y,-2],[0,y,2],[20,y,2]],[[0,y,-2],[20,y,2],[20,y,-2]]];
const input=():LowerBridgeClosureInput=>({sourcePart:{id:1,name:'source public lower path',tag:'raised:cobble',rings:[[[0,-2],[20,-2],[20,2],[0,2],[0,-2]]]},frame:{origin:[0,0],direction:[1,0]},gateStations:[2,18],native:floor(0).map((points,triangle)=>({points,cell:'native',collider:'ground',triangle,tag:'raised:cobble',group:'ground'})),upperFloors:floor(3),deckThicknessMetres:.35,gateThicknessMetres:.12});
test('lower closure uses literal native foundations and actual soffit without changing either floor',()=>{
 const value=input(),before=structuredClone(value),built=buildSourceBoundLowerClosure(value);assert.deepEqual(value,before);assert.equal(built.proof.gates.length,2);assert.ok(built.faces.length);
 assert.ok(built.faces.every(f=>f.collision&&f.role==='railing'&&f.sourcePartIds[0]===1));assert.ok(built.faces.flatMap(f=>f.points).every(p=>p.every(Number.isFinite)&&p[1]<2.661&&p[1]>=-.101));
 assert.equal(built.proof.nativeFloorsUnmodified,true);assert.equal(built.proof.upperFloorUnmodified,true);
});
test('unsupported floor and missing roof cannot become a closure, and stations must bracket source approaches',()=>{
 const absent=input();absent.native=[];assert.throws(()=>buildSourceBoundLowerClosure(absent));
 const missingRoof=input();missingRoof.upperFloors=floor(3).map(t=>t.map(v=>[v[0]+4,v[1],v[2]])as SupportTriangle);assert.throws(()=>buildSourceBoundLowerClosure(missingRoof),/upper soffit/);
 assert.throws(()=>buildSourceBoundLowerClosure({...input(),gateStations:[8,12]}));
 const hole=input();hole.native=floor(0).map((points,triangle)=>({points:points.map(v=>[v[0]+1,v[1],v[2]])as SupportTriangle,cell:'native',collider:'ground',triangle,tag:'raised:cobble',group:'ground'}));assert.throws(()=>buildSourceBoundLowerClosure(hole));
});
test('retained approach ground within the slab is left intact and closure stays below the upper walking floor',()=>{
 const value=input();value.native=floor(2.9).map((points,triangle)=>({points,cell:'native',collider:'ground',triangle,tag:'raised:cobble',group:'ground'}));const before=structuredClone(value.native),built=buildSourceBoundLowerClosure(value);assert.deepEqual(value.native,before);assert.ok(built.faces.flatMap(f=>f.points).every(p=>p[1]<3));assert.ok(built.proof.gates.every(g=>g.maximumNativeAboveSoffit>0));
});
