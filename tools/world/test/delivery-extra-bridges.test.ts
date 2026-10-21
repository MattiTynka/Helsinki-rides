import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extraBridgeBankCoverage,extraBridgeBankHeight,extraBridgeBankSegments,extraBridgeSourceAxes,type ExtraBridgeBankSegment,type ExtraBridgeNativeFace} from '../lib/delivery-extra-bridges-source.ts';
import {gk25ToGeodetic} from '../../../packages/world-schema/src/index.ts';
import {buildExtraBridgeDeck,extraBridgeDeckHeight,type ExtraBridgeDeckProfile} from '../lib/delivery-extra-bridges-mesh.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';
import {qualifyExtraBridgePierBearing,qualifyExtraBridgePierKeepOut,qualifyExtraBridgePierAxes,type ExtraBridgePier} from '../lib/delivery-extra-bridges-piers.ts';
const source={cell:'native',collider:'g:native',triangle:0,sha256:'0'.repeat(64)};
function fixture():ExtraBridgeDeckProfile{
  const segments=(offset:number):ExtraBridgeBankSegment[]=>[{t0:-6,t1:0,y0:1+offset,y1:2+offset,role:'road',sourcePartIds:[1],source},{t0:0,t1:6,y0:2+offset,y1:1+offset,role:'road',sourcePartIds:[1],source}];
  return{surfaceMethod:'native-bank-piecewise-planar-ruled-sections-v1',frame:{origin:[0,0],direction:[1,0]},banks:[{s:0,segments:segments(0)},{s:20,segments:segments(1)}],upperParts:[{id:1,role:'road',tag:'road:asphalt',rings:[[[0,-6],[20,-6],[20,6],[0,6],[0,-6]]],sha256:'1'.repeat(64)}],crownMetres:0,deckThicknessMetres:.6,maximumGrade:.1};
}
test('full native piecewise bank rows and exact source footprint are shared by visible and physical floors',()=>{
  const profile=fixture(),result=buildExtraBridgeDeck(profile),floors=result.faces.filter(f=>f.role==='road');assert.ok(floors.length>0);assert.ok(result.proof.maximumGrade<.051);
  for(const f of floors){assert.deepEqual(f.sourcePartIds,[1]);assert.equal(f.collision,true);for(const p of f.points){assert.ok(p[0]>=0&&p[0]<=20&&p[2]>=-6&&p[2]<=6);assert.ok(Math.abs(p[1]-extraBridgeDeckHeight(profile,p[0],p[2],'road'))<.000001);}}
  for(const bank of profile.banks)for(const p of floors.flatMap(f=>f.points).filter(p=>p[0]===bank.s))assert.ok(Math.abs(p[1]-extraBridgeBankHeight(bank.segments,p[2],'road'))<.000001);
  assert.ok(result.faces.some(f=>f.role==='soffit'&&f.collision),'A supported floor also needs physical architecture below it');
});
test('a missing or stacked source bank and an unbounded deck grade fail instead of interpolating invented support',()=>{
  const profile=fixture(),segments=profile.banks[0].segments;assert.throws(()=>extraBridgeBankHeight(segments,6.01,'road'),/No source-owned/);
  assert.throws(()=>extraBridgeBankHeight([...segments,{...segments[0]!,y0:10,y1:11}],-3,'road'),/Distinct stacked/);
  assert.throws(()=>extraBridgeBankCoverage([segments[0]!],[{role:'road',t0:-6,t1:6}]),/No source-owned/);
  profile.banks[1].segments.forEach(s=>{s.y0+=10;s.y1+=10;});assert.throws(()=>buildExtraBridgeDeck(profile),/grade/);
});
test('bank authority comes only from exact named source-owned physical ground, never a roof or an unrelated lower sheet',()=>{
  const points:[number,number,number][]=[[0,1,-6],[20,1,6],[20,1,-6]],face={points,cell:'native',collider:'g:native',triangle:2,tag:'road:asphalt',group:'ground'}as ExtraBridgeNativeFace;
  const part=fixture().upperParts[0]!,frame=fixture().frame,good=extraBridgeBankSegments(frame,10,[face],[part]);assert.ok(good.length>0);assert.equal(good[0]!.source.sha256,deliverySha(JSON.stringify(points)));
  assert.deepEqual(extraBridgeBankSegments(frame,10,[{...face,group:'buildings'}],[part]),[]);assert.deepEqual(extraBridgeBankSegments(frame,10,[{...face,tag:'raised:grass'}],[part]),[]);
  assert.deepEqual(extraBridgeBankSegments(frame,10,[face],[{...part,rings:[[[100,100],[120,100],[120,120],[100,120]]]}]),[]);
});
test('raised source walks have real curb and underside closures, with the same load-bearing faces in both tiers',()=>{
  const p=fixture();p.upperParts.push({id:2,role:'walk',tag:'raised:asphalt',rings:[[[0,6],[20,6],[20,8],[0,8],[0,6]]],sha256:'2'.repeat(64)});p.banks.forEach((bank,i)=>bank.segments.push({t0:6,t1:8,y0:1.12+i,y1:1.12+i,role:'walk',sourcePartIds:[2],source}));
  const near=buildExtraBridgeDeck(p).faces,far=buildExtraBridgeDeck(p,{coarse:true}).faces,curbs=near.filter(f=>f.role==='curb');assert.ok(curbs.length>=2);assert.ok(curbs.every(f=>f.collision&&f.points.every(v=>v[2]===6)));assert.deepEqual(near,far);assert.ok(near.some(f=>f.role==='soffit'&&f.sourcePartIds.length===2));
});
test('curved cycle sides remain source-bound when their footprint crosses the arbitrary frame centre line',()=>{
  const p=fixture();p.upperParts.push({id:2,role:'cycle',tag:'raised:asphalt',rings:[[[0,6],[10,-2],[20,6],[20,8],[10,0],[0,8],[0,6]]],sha256:'2'.repeat(64)});p.sideByPartId={'2':1};p.banks.forEach((bank,i)=>bank.segments.push({t0:6,t1:8,y0:1.12+i,y1:1.12+i,role:'cycle',sourcePartIds:[2],source}));
  assert.ok(Number.isFinite(extraBridgeDeckHeight(p,10,-1,'cycle',2)));const faces=buildExtraBridgeDeck(p).faces.filter(f=>f.sourcePartIds.includes(2)&&f.role==='footway');assert.ok(faces.some(f=>f.points.some(v=>v[2]<0)));assert.ok(faces.every(f=>f.points.every(v=>v[1]>1)));
});
test('an explicit authored median follows the common road field but cannot replace a real native bank',()=>{
  const p=fixture();p.authoredMedianAboveRoadMetres=.12;p.upperParts.push({id:3,role:'median',tag:'raised:cobble',rings:[[[2,-1],[18,-1],[18,1],[2,1],[2,-1]]],sha256:'3'.repeat(64)});
  assert.ok(Math.abs(extraBridgeDeckHeight(p,10,0,'median')-extraBridgeDeckHeight(p,10,0,'road')-.12)<1e-8);assert.ok(buildExtraBridgeDeck(p).faces.some(f=>f.sourcePartIds.includes(3)));
  p.upperParts[1]!.rings[0]![0]![0]=0;assert.throws(()=>buildExtraBridgeDeck(p),/cannot replace a real bank/);
});
test('the exact lower-axis audit catches a public path crossing between outside endpoints and respects an actual polygon hole',()=>{
  const node=(id:number,x:number,z:number)=>{const[lat,lon]=gk25ToGeodetic(25497350+x,6672960-z);return{type:'node',id,lat,lon};},osm={elements:[node(1,-10,0),node(2,10,0),{type:'way',id:4,nodes:[1,2],tags:{highway:'footway'}}]},ring:[number,number][]=[[-5,-5],[5,-5],[5,5],[-5,5],[-5,-5]];
  const audit=extraBridgeSourceAxes(osm,[ring]);assert.equal(audit.length,1);assert.equal(audit[0]!.wayId,4);assert.ok(Math.abs(audit[0]!.lengthMetres-10)<.000001);
  const hole:[number,number][]=[[-5,-1],[5,-1],[5,1],[-5,1],[-5,-1]];assert.deepEqual(extraBridgeSourceAxes(osm,[ring,hole]),[]);
});
test('an oblique source deck exit stays open while its longitudinal barrier remains physical',()=>{
  const p=fixture();p.upperParts[0]!.rings=[[[0,-6],[20,-6],[20,6],[5,6],[0,-2],[0,-6]]];
  p.barriers=[{kind:'picket',sourcePartIds:[1],startS:0,endS:20,heightMetres:1.1,thicknessMetres:.05}];
  const rails=buildExtraBridgeDeck(p).faces.filter(f=>f.role==='railing');assert.ok(rails.length>0&&rails.every(f=>f.collision));
  // The former .25 threshold also fenced this diagonal public exit. A real
  // longitudinal edge is predominantly parallel to the source frame axis.
  assert.ok(rails.every(f=>{const z=f.points.map(v=>v[2]);return Math.min(...z)<-5.8||Math.max(...z)>5.8;}));
});
test('source-bearing supports require whole native floor coverage and keep every lower public footprint clear',()=>{
  const p=fixture(),part={id:42,name:'native separator',tag:'raised:asphalt',rings:[[[8,-2],[12,-2],[12,2],[8,2],[8,-2]]]as[number,number][][]},face=(points:[number,number,number][],triangle:number)=>({points,cell:'native',collider:'g:native',triangle,tag:part.tag,group:'ground'}as ExtraBridgeNativeFace),soil=[face([[8,-4,-2],[12,-4,2],[12,-4,-2]],0),face([[8,-4,-2],[8,-4,2],[12,-4,2]],1)],feet:[number,number][]=[[9,0],[11,0]],bearing=feet.map(st=>qualifyExtraBridgePierBearing(p.frame,st,.3,.4,part,soil));
  assert.ok(bearing.every(b=>b.minimumY===-4&&b.maximumY===-4));assert.throws(()=>qualifyExtraBridgePierBearing(p.frame,[9,0],.3,.4,part,[soil[0]!]),/complete footing needs actual native/);
  const pier:ExtraBridgePier={id:'source-v',kind:'concrete-inverted-v',sourcePartId:42,upperPartId:1,feetST:feet,topST:[10,0],widthS:.3,widthT:.4,topWidthS:.5,topWidthT:.6,bearing};p.piers=[pier];
  assert.deepEqual(qualifyExtraBridgePierKeepOut(p.frame,pier,[part]).excludedLowerPartIds,[]);assert.throws(()=>qualifyExtraBridgePierKeepOut(p.frame,pier,[{...part,id:43}]),/overlaps retained lower public part/);
  const near=buildExtraBridgeDeck(p).faces.filter(f=>f.role==='pier'),far=buildExtraBridgeDeck(p,{coarse:true}).faces.filter(f=>f.role==='pier');assert.equal(near.length,24);assert.deepEqual(near,far);assert.ok(near.every(f=>f.collision&&f.sourcePartIds.includes(42)));
});
test('a lower mapped path crossing a structural hull is caught between distant axis endpoints',()=>{
  const node=(id:number,x:number,z:number)=>{const[lat,lon]=gk25ToGeodetic(25497350+x,6672960-z);return{type:'node',id,lat,lon};},osm={elements:[node(1,10,-10),node(2,10,10),{type:'way',id:123,nodes:[1,2],tags:{highway:'footway'}}]},pier:ExtraBridgePier={id:'source-v',kind:'concrete-inverted-v',sourcePartId:42,upperPartId:1,feetST:[[9,0],[11,0]],topST:[10,0],widthS:.3,widthT:.4,topWidthS:.5,topWidthT:.6,bearing:[]};
  assert.throws(()=>qualifyExtraBridgePierAxes(osm,fixture().frame,pier,[]),/blocks mapped lower public axis 123/);
  assert.equal(qualifyExtraBridgePierAxes(osm,fixture().frame,pier,[123]).nearLowerAxes.length,0);
});
