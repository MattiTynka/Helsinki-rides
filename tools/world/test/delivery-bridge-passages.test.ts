import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gk25ToGeodetic} from '../../../packages/world-schema/src/index.ts';
import type {ExtraBridgeNativeFace} from '../lib/delivery-extra-bridges-source.ts';
import type {SupportTriangle} from '../lib/tram-support-repair.ts';
import {sourceLowerBridgeAxis,qualifyScopedBridgePassage} from '../lib/delivery-bridge-passages.ts';
function floor(x0:number,z0:number,x1:number,z1:number,y:number):SupportTriangle[]{return[[[x0,y,z0],[x1,y,z1],[x1,y,z0]],[[x0,y,z0],[x0,y,z1],[x1,y,z1]]];}
const native=(triangles:SupportTriangle[]):ExtraBridgeNativeFace[]=>triangles.map((points,triangle)=>({points,cell:'source',collider:'lower',triangle,tag:'raised:slabs',group:'ground'}));
function fixture(){return{axis:[[-5,0],[5,0]]as[number,number][],bodyRadiusMetres:.47,sourceParts:[{id:1,name:'lower public path',tag:'raised:slabs',rings:[[[-8,-4],[8,-4],[8,4],[-8,4],[-8,-4]]]as[number,number][][]}],native:native([...floor(-8,-4,8,1,1),...floor(-8,1,8,4,3.5)]),upperFloors:floor(-2,-4,2,4,4),deckThicknessMetres:.3,minimumClearanceMetres:2.2};}
test('scoped lower corridor certifies both banks and ignores an unrelated high abutment outside actual body travel',()=>{
  const input=fixture(),before=structuredClone(input.native),out=qualifyScopedBridgePassage(input);assert.ok(Math.abs(out.minimumClearanceMetres-2.7)<1e-12);assert.deepEqual(input.native,before);assert.ok(out.witnesses.length>0&&out.completeNativeBodyCoverage);
});
test('inside-corridor low clearance, floor gaps and incomplete external approaches fail without changing terrain',()=>{
  const input=fixture();assert.throws(()=>qualifyScopedBridgePassage({...input,native:native(floor(-8,-4,8,4,1.6))}),/clearance/);
  assert.throws(()=>qualifyScopedBridgePassage({...input,native:native([...floor(-8,-4,0,4,1),...floor(.01,-4,8,4,1)])}),/complete native floor/);
  assert.throws(()=>qualifyScopedBridgePassage({...input,axis:[[-1,0],[5,0]]}),/external approach/);
  assert.throws(()=>qualifyScopedBridgePassage({...input,axis:[[-5,3.8],[5,3.8]]}),/leaves the named/);
});
test('lower passage axes use exact OSM way membership and reject upper bridge or private paths',()=>{
  const node=(id:number,x:number)=>{const[lat,lon]=gk25ToGeodetic(25497350+x,6672960);return{type:'node',id,lat,lon};},osm={elements:[node(1,-5),node(2,0),node(3,5),{type:'way',id:7,nodes:[1,2,3],tags:{highway:'footway'}}]},origin={id:'fixture',originProjected:[25497350,6672960,7.5]as[number,number,number]};
  assert.deepEqual(sourceLowerBridgeAxis(osm,7,3,1,origin).proof.nodeIds,[3,2,1]);assert.throws(()=>sourceLowerBridgeAxis(osm,7,99,1,origin),/actual way members/);
  for(const patch of[{bridge:'yes',layer:'1'},{access:'private'}]){const changed=structuredClone(osm);Object.assign((changed.elements[3]as any).tags,patch);assert.throws(()=>sourceLowerBridgeAxis(changed,7,1,3,origin));}
});

test('exact zero-area native fragments contribute no support and cannot close a real hole',()=>{const input=fixture(),zero=native([[[0,1,0],[0,1,0],[1,1,0]]]);const okay=qualifyScopedBridgePassage({...input,native:[...input.native,...zero]});assert.equal(okay.zeroAreaFacesExcludedFromCoverage.length,1);assert.throws(()=>qualifyScopedBridgePassage({...input,native:[...native([...floor(-8,-4,0,4,1),...floor(.01,-4,8,4,1)]),...zero]}),/complete native floor/);});
