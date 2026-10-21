import{test}from'node:test';import assert from'node:assert/strict';
import{canonicalDeliveryShore}from'../lib/delivery-coastal-topology.ts';
import{sourceShoreSegments}from'../lib/coastal-shore-seals.ts';
import{bbox,type LocalPolygon}from'../lib/geometry.ts';
const area={minX:-2000,maxX:2000,minZ:-2400,maxZ:800};
function polygon(rings:number[][][]):LocalPolygon{return{id:'source',rings:rings as[number,number][][],bbox:bbox(rings as[number,number][][]),properties:{}};}
test('actual shared outer/hole source edge is split at the hole endpoint and its dry/dry interval never gains a quay',()=>{
  const a=[-860.5704856335377,1286.485875060889],b=[-867.1864662505686,1295.4057077150792],L=Math.hypot(b[0]!-a[0]!,b[1]!-a[1]!),n=[-(b[1]!-a[1]!)/L,(b[0]!-a[0]!)/L],p=polygon([[a,b,[b[0]!+n[0]!*10,b[1]!+n[1]!*10],[a[0]!+n[0]!*10,a[1]!+n[1]!*10]],[a,[-864.0849868990481,1289.841462559998],[-865.3531973995268,1292.0240782499313],[-865.3734350956906,1292.9613331870287]]]);
  assert.throws(()=>sourceShoreSegments([p],area),/Ambiguous/);const result=canonicalDeliveryShore([p],area);assert.ok(result.topology.omittedSharedIntervals.length>=2);assert.ok(result.topology.omittedSharedIntervals.every(r=>r.bothSides==='dry'));const source=result.segments.filter(s=>s.id.startsWith('source:0:0'));assert.equal(source.length,1);assert.ok(Math.hypot(source[0]!.b[0]-source[0]!.a[0],source[0]!.b[1]-source[0]!.a[1])<4);
});
test('a genuine one-micrometre wet strip is classified below its actual clearance and never treated as shared source topology',()=>{
  const p=polygon([[[0,0],[10,0],[10,.000001],[0,.000001]]]),result=canonicalDeliveryShore([p],area);assert.equal(result.segments.length,2);assert.equal(result.topology.omittedSharedIntervals.length,0);assert.ok(result.segments.every(s=>s.drySide===1));
});
test('ordinary source winding reversal preserves the same wet and dry side in space',()=>{
  const ring=[[0,0],[10,0],[10,10],[0,10]],a=canonicalDeliveryShore([polygon([ring])],area).segments,b=canonicalDeliveryShore([polygon([[...ring].reverse()])],area).segments;assert.equal(a.length,4);for(const edge of a){const other=b.find(s=>s.a.join()===edge.b.join()&&s.b.join()===edge.a.join());assert.ok(other);assert.equal(other.drySide,-edge.drySide!);}
});
