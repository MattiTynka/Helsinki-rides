import assert from 'node:assert/strict';
import test from 'node:test';
import {OriginalWallArt} from '../author_senate_facade_charts.ts';
import {renderAnonymousOffice,renderAnonymousOfficeCorner} from '../lib/delivery-anonymous-office-art.ts';
test('two observed modern office fronts retain distinct bay counts and isolated strip lights',()=>{
  for(const side of ['south','east']as const){const w=new OriginalWallArt(18,7,27);renderAnonymousOffice(w,7.3,side,side==='east'?[2.38,12.15]:undefined);const svg=w.svg([0,0,1024,1024]);assert.equal((svg.match(new RegExp(`office-${side}-glass-`,'g'))??[]).length,side==='south'?24:28);assert.equal((svg.match(/strip-glass-/g)??[]).length,4);assert.ok(svg.includes('office-stone-base'));assert.ok(!svg.includes('pediment')&&!svg.includes('sill'));}
});
test('office artwork refuses unrelated tiny structures and short native wall domains',()=>{
  assert.throws(()=>renderAnonymousOffice(new OriginalWallArt(3,0,20),0,'south'));
  assert.throws(()=>renderAnonymousOffice(new OriginalWallArt(18,0,12),0,'east'));
});
test('source attic lights stay above its24.4m setback instead of straddling the native step',()=>{
  const w=new OriginalWallArt(18,7.210078,27.10041);renderAnonymousOffice(w,8.018766475831665,'south');
  const top=w.pieces.filter(p=>/office-south-(?:glass|strip-glass)-3/.test(p));assert.equal(top.length,7);
  for(const rect of top){const y=Number(rect.match(/ y="([^"]+)"/)![1]),h=Number(rect.match(/ height="([^"]+)"/)![1]);const bottom=w.maxY-y-h;assert.ok(bottom>24.4,'Attic light crosses native setback');}
});

test('seven eastern bay rows remain wholly inside actual source middle plate instead of crossing its return steps',()=>{
  const w=new OriginalWallArt(16.925894333426935,7.210078239440918,27.100427627563477),range=[2.376501209609722,12.168158756674746]as const;
  renderAnonymousOffice(w,8.018766475831665,'east',range);
  const windows=w.pieces.filter(p=>/office-east-frame-/.test(p));assert.equal(windows.length,28);
  for(const rect of windows){const x=Number(rect.match(/ x="([^"]+)"/)![1]),width=Number(rect.match(/ width="([^"]+)"/)![1]);assert.ok(x>=range[0]&&x+width<=range[1]);}
  assert.throws(()=>renderAnonymousOffice(new OriginalWallArt(w.width,w.minY,w.maxY),8.018766475831665,'east'),/assert/);
});
test('corner metric planes share the measured stone base while upper attic returns stay brick',()=>{
  const finish={kind:'brick' as const,colour:'#9b6755',mortarColour:'#876350',moduleWidth:.5,moduleHeight:.24};
  for(const width of[.4,3]){const w=new OriginalWallArt(width,7.21,24.4);renderAnonymousOfficeCorner(w,8.018766475831665,finish);const base=w.pieces.find(s=>s.includes('office-corner-source-bound-stone-base'))!;assert.ok(base);const y=Number(base.match(/ y="([^"]+)"/)![1]);assert.ok(Math.abs(w.maxY-y-11.468766475831665)<1e-12);}
  const upper=new OriginalWallArt(3,24.4,27.1);renderAnonymousOfficeCorner(upper,8.018766475831665,finish);assert.ok(!upper.pieces.some(s=>s.includes('office-corner-source-bound-stone-base')));
});
