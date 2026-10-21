import assert from 'node:assert/strict';
import test from 'node:test';
import {OriginalWallArt} from '../author_senate_facade_charts.ts';
import {renderPengerkujaAnnex} from '../author_delivery_anonymous_annex.ts';
test('observed low white annex upper lights retain a roof datum without garage/floor claims',()=>{
  const w=new OriginalWallArt(29,4.99,11.85);renderPengerkujaAnnex(w);const svg=w.svg([0,0,1024,1024]);assert.equal((svg.match(/pengerkuja-upper-light-/g)??[]).length,14);assert.ok(svg.includes('pengerkuja-white-render'));assert.ok(!svg.includes('door')&&!svg.includes('garage')&&!svg.includes('ground'));
});
test('annex interpretation refuses unrelated roof-height and facade-width domains',()=>{
  assert.throws(()=>renderPengerkujaAnnex(new OriginalWallArt(5,0,7)));assert.throws(()=>renderPengerkujaAnnex(new OriginalWallArt(29,0,25)));
});
