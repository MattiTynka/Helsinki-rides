import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeCollisionBundle,parseCollisionBundle,encodeTerrain,parseTerrain,sampleTerrain} from '../../../packages/world-schema/src/index.ts';
import {buildReconstructedBridge,splitBridgeFaces,appendBridgeCollision,bridgeReplacementZones,bridgeDeckHeight,conformBridgeRailBoundary,type ReconstructedBridge} from '../lib/bridge-reconstruction.ts';
import {supportNormal} from '../lib/tram-support-repair.ts';
import {bridgeCoarseFloorMatches,partitionBridgeReplacementGeometry,bridgeFragmentNodeName} from '../lib/bridge-glb.ts';
import {lowerBridgeTerrain} from '../lib/bridge-terrain.ts';
import {retainOutsideBridge} from '../lib/bridge-ground-replacement.ts';
import {Document} from '@gltf-transform/core';
import {readExactBridgeRoadGround} from '../lib/bridge-glb.ts';
import {buildBridgeLandClosure,triangulateBridgeShoreMask} from '../lib/bridge-shore-closure.ts';
import {buildBridgeBankQuay,quayReplacementZones} from '../lib/bridge-bank-quay.ts';
const base:ReconstructedBridge={id:'test-bridge',name:'Test',kind:'granite-three-arch',stations:[{x:120,z:0,roadY:0,leftOuter:10,rightOuter:10,roadHalfWidth:6,lowerWalkDrop:0},{x:120,z:66,roadY:.2,leftOuter:10,rightOuter:10,roadHalfWidth:6,lowerWalkDrop:0}],sourcePartIds:[1],waterY:-7.5,curbHeight:.12,crossfall:.02,parapet:{kind:'granite',height:1.1,thickness:.48},architectureStartMetres:3,architectureEndMetres:63,approachMetres:3,arch:{spans:3,piers:2,pierWidth:2.4,abutmentWidth:2.5,springHeightAboveWater:1,crownDepth:.8},deckThickness:.45,references:['https://example.invalid/reference'],qualifications:['Unit fixture']};
const area=(p:readonly number[][])=>{const a=p[1]!.map((v,i)=>v-p[0]![i]!),b=p[2]!.map((v,i)=>v-p[0]![i]!);return Math.hypot(a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!)/2;};

test('granite bridge has three real open arch crowns and only two interior piers',()=>{
 const faces=buildReconstructedBridge(base),piers=faces.filter(f=>f.role==='pier'),innerPierRanges=new Set(piers.filter(f=>Math.min(...f.points.map(p=>p[2]))>5.5&&Math.max(...f.points.map(p=>p[2]))<60.5).map(f=>{const z=f.points.map(p=>p[2]);return Math.round(z.reduce((a,b)=>a+b)/3/10);}));assert.ok(innerPierRanges.size>=2);
 const lower=faces.filter(f=>f.role==='soffit'&&supportNormal(f.points)[1]<-.0001),roofMin=Math.min(...lower.flatMap(f=>f.points.map(p=>p[1])));assert.ok(roofMin<=-6.49);assert.ok(lower.some(f=>Math.max(...f.points.map(p=>p[1]))>-1.1));
 assert.ok(faces.filter(f=>f.role==='parapet').every(f=>f.material==='granite'&&f.collision));
});

test('coarse tier retains every exact road and footway triangle',()=>{
 const source={height:(x:number,z:number)=>.01*x+.02*z},near=buildReconstructedBridge(base,{source}),far=buildReconstructedBridge(base,{source,coarse:true}),floors=(f:typeof near)=>f.filter(t=>['road','footway','curb'].includes(t.role));assert.deepEqual(floors(far),floors(near));assert.ok(far.length<near.length);
});

test('two-level bridge keeps lower paths separate from the upper roadway',()=>{
 const b={...base,kind:'two-level-composite' as const,stations:base.stations.map(s=>({...s,lowerWalkDrop:2})),parapet:{kind:'steel' as const,height:1.1,thickness:.08},arch:undefined},faces=buildReconstructedBridge(b);assert.ok(bridgeDeckHeight(b,30,8,true)<bridgeDeckHeight(b,30,0)-1.8);assert.ok(faces.some(f=>f.material==='glass'&&f.collision));assert.ok(faces.some(f=>f.role==='railing'&&f.material==='steel'));assert.equal(faces.filter(f=>f.role==='pier').length,0);
 const exterior=faces.filter(f=>f.role==='curb'&&f.points.every(p=>p[0]===126&&p[2]>5&&p[2]<60));assert.ok(exterior.length);assert.ok(exterior.every(f=>supportNormal(f.points)[0]>.99),'The upper deck web faces the lower public walkway');
});

test('concrete road and raised walk undersides have a closed vertical slab edge',()=>{
 const b:ReconstructedBridge={...base,kind:'concrete-girder',arch:undefined},faces=buildReconstructedBridge(b),edge=faces.filter(f=>f.role==='soffit'&&f.points.every(p=>p[0]===126&&p[2]>=20&&p[2]<=21));assert.ok(edge.every(f=>supportNormal(f.points)[0]>.99),'The underside step faces the air below the higher walk, opposite the curb');assert.ok(edge.some(f=>Math.max(...f.points.map(p=>p[1]))>-.4&&Math.min(...f.points.map(p=>p[1]))<-.49));
});

test('cell clipping preserves triangle area and produces identical shared boundary vertices',()=>{
 const faces=buildReconstructedBridge(base),cells=splitBridgeFaces(faces),sum=[...cells.values()].flat().reduce((s,f)=>s+area(f.points),0),before=faces.reduce((s,f)=>s+area(f.points),0);assert.ok(Math.abs(sum-before)<.002,`${sum-before}`);assert.ok(cells.has('c_p00_p00')&&cells.has('c_p01_p00'));
 const boundary=(id:string)=>new Set(cells.get(id)!.flatMap(f=>f.points).filter(p=>p[0]===128).map(p=>p.join(','))),a=boundary('c_p00_p00'),b=boundary('c_p01_p00');assert.deepEqual(a,b);
});

test('new HCOL uses exact visual coordinates and preserves unrelated source collider arrays',()=>{
 const original={id:'unrelated-building',group:'buildings' as const,ref:'source-building',positions:Float32Array.from([1,2,3,4,2,3,1,2,6]),indices:Uint32Array.from([0,1,2]),triangleTags:Uint16Array.from([0])},old=encodeCollisionBundle({originId:'test',frame:'X-east,Y-up,Z-south',cell:'c_p00_p00',surfaceTags:['wall']},[original]),faces=splitBridgeFaces(buildReconstructedBridge(base)).get('c_p00_p00')!,next=parseCollisionBundle(appendBridgeCollision(old,faces,'c_p00_p00'));assert.deepEqual(next.colliders[0],original);
 const added=next.colliders.slice(1).flatMap(c=>Array.from({length:c.indices.length/3},(_,i)=>[0,1,2].map(k=>Array.from(c.positions.slice(c.indices[i*3+k]!*3,c.indices[i*3+k]!*3+3))).map(p=>p.join(',')).join('|'))).sort(),visual=faces.filter(f=>f.collision).map(f=>f.points.map(p=>p.join(',')).join('|')).sort();assert.deepEqual(added,visual);assert.ok(next.header.surfaceTags.includes('road:asphalt:bridge-reconstruction'));
});

test('source bridge footprints are bounded and invalid geometry fails fast',()=>{
 const zones=bridgeReplacementZones(base);assert.equal(zones.length,1);assert.equal(zones[0]!.footprint!.length,4);assert.throws(()=>buildReconstructedBridge({...base,crossfall:.2}),/assert/i);assert.throws(()=>buildReconstructedBridge({...base,stations:[base.stations[0]!]}),/assert/i);
 assert.throws(()=>buildReconstructedBridge({...base,stations:[base.stations[0]!,{...base.stations[0]!,roadY:1},base.stations[1]!]}),/positive segment length/);
});

test('simplified coarse floor accepts alternate diagonals and excludes elevated or partial architecture',()=>{
 const A:[number,number,number]=[0,0,0],B:[number,number,number]=[4,0,0],C:[number,number,number]=[4,0,4],D:[number,number,number]=[0,0,4],floors:[typeof A,typeof A,typeof A][]=[[A,D,B],[B,D,C]];
 assert.equal(bridgeCoarseFloorMatches([A,D,C],floors),true);assert.equal(bridgeCoarseFloorMatches([A,C,B],floors),true);
 assert.equal(bridgeCoarseFloorMatches([[0,1,0],[0,1,4],[4,1,4]],floors),false);assert.equal(bridgeCoarseFloorMatches([[0,0,0],[0,0,8],[4,0,4]],floors),false);assert.equal(bridgeCoarseFloorMatches([A,A,A],floors),false);
});

test('lower passage stays independent of upper deck and joins its actual source banks',()=>{
 const b:ReconstructedBridge={...base,kind:'concrete-girder',arch:undefined,underpass:{sourceWayId:42,stations:[{x:100,z:33,floorY:0},{x:140,z:33,floorY:.2}],halfWidth:3.5,bankBlendMetres:2,observation:'Fixture source bank'}};
 const faces=buildReconstructedBridge(b,{source:{height:(x,z)=>.03*x+.01*z}}),lower=faces.filter(f=>f.role==='footway'&&f.points.every(p=>p[1]<4));assert.ok(lower.length>70);assert.ok(lower.some(f=>f.points.some(p=>p[0]===100&&Math.abs(p[1]-(.03*p[0]+.01*p[2]))<1e-6)));assert.ok(faces.some(f=>f.role==='road'&&f.points.some(p=>Math.abs(p[2]-33)<1)));
 const zones=bridgeReplacementZones(b);assert.equal(zones.length,2);assert.match(zones[1]!.id,/lower-passage/);
});

test('fallback terrain lowering covers interpolation influence and preserves every outside bit',()=>{
 const terrain={x0:0,z0:0,resolution:1,nx:12,nz:12,heights:Float32Array.from({length:144},(_,i)=>5+i/100)},before=encodeTerrain(terrain),result=lowerBridgeTerrain(before,[{id:'bounded',polygon:[[4.2,4.2],[6.8,4.2],[6.8,6.8],[4.2,6.8]],maximumTerrainY:-1}]),after=parseTerrain(result.bytes);
 assert.equal(result.proof.changedSamples,16);assert.equal(result.proof.unchangedSamples,128);assert.equal(sampleTerrain(after,4.2,4.2),-1);assert.equal(sampleTerrain(after,6.8,6.8),-1);
 const oldBits=new Uint32Array(terrain.heights.buffer),newBits=new Uint32Array(after.heights.buffer);for(let z=0;z<12;z++)for(let x=0;x<12;x++){if(x>=4&&x<=7&&z>=4&&z<=7)assert.equal(after.heights[z*12+x],-1);else assert.equal(newBits[z*12+x],oldBits[z*12+x]);}
});

test('curved deck union removes old vertical walls on internal cuts and preserves exterior walls',()=>{
 const zone=(x0:number,x1:number)=>({id:'fixture',cell:'c_p00_p00',footprint:[[x0,0],[x1,0],[x1,2],[x0,2]] as [number,number][],boundsXZ:[x0,0,x1,2] as [number,number,number,number],triangles:[],sourceNode:'ground',sourcePrimitive:0,observations:[]});
 const positions=Float32Array.from([1,0,.3,1,3,.3,1,0,1.7,0,0,.3,0,3,.3,0,0,1.7]),mesh={attributes:{POSITION:positions},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.from([0,1,2,3,4,5])},out=retainOutsideBridge(mesh,[zone(0,1),zone(1,2)]);
 assert.deepEqual(out.proof.removedSourceTriangles,[0]);assert.equal(out.mesh.indices.length,3);assert.deepEqual(Array.from(out.mesh.indices),[3,4,5]);assert.deepEqual(out.mesh.attributes.POSITION!.slice(0,positions.length),positions);
});

test('height-qualified source ring removes low obsolete sheets and preserves the higher real bank',()=>{
 const patch={id:'low-source-only',cell:'fixture',footprint:[[0,0],[3,0],[0,3]] as [number,number][],boundsXZ:[0,0,3,3] as [number,number,number,number],triangles:[],sourceNode:'municipal-silta-646549',sourcePrimitive:0,observations:[],maximumSourceY:-5.5};
 const p=Float32Array.from([.2,-7,.2,.2,-7,1,1,-7,.2,.2,-2,.2,.2,-2,1,1,-2,.2]),mesh={attributes:{POSITION:p},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.from([0,1,2,3,4,5])},out=retainOutsideBridge(mesh,[patch]);
 assert.deepEqual(out.proof.removedSourceTriangles,[0]);assert.deepEqual(Array.from(out.mesh.indices),[3,4,5]);assert.deepEqual(out.mesh.attributes.POSITION!.slice(0,p.length),p);
});

test('upper street apron joins the upper deck top while the lower wall stays below its soffit',()=>{
 const b:ReconstructedBridge={...base,kind:'concrete-girder',arch:undefined,underpass:{sourceWayId:42,stations:[{x:100,z:33,floorY:-5},{x:140,z:33,floorY:-5}],halfWidth:3.5,leftWidth:4,rightWidth:4,wallThickness:.2,wallTopY:-.7,leftApron:5,rightApron:5,bankBlendMetres:2,observation:'Stacked-floor fixture'}},faces=buildReconstructedBridge(b,{source:{height:()=>0}});
 const apronBoundary=faces.filter(f=>f.role==='road').flatMap(f=>f.points).filter(p=>(Math.abs(p[0]-110)<1e-6||Math.abs(p[0]-130)<1e-6)&&Math.abs(p[2]-33)>4.1&&Math.abs(p[2]-33)<9.1);
 assert.ok(apronBoundary.length>8);for(const p of apronBoundary)assert.ok(Math.abs(p[1]-bridgeDeckHeight(b,p[2],p[0]-120,true))<.00001,`apron/deck mismatch${p}`);
 const bank=faces.filter(f=>f.role==='road').flatMap(f=>f.points).filter(p=>(p[0]===100||p[0]===140)&&Math.abs(p[2]-33)>4.1&&Math.abs(p[2]-33)<9.1);assert.ok(bank.length>8);for(const p of bank)assert.equal(p[1],0,'Upper apron bank must meet its actual source street height');
});

test('new rail authority binds exact common visual and physical road faces',()=>{
 const doc=new Document(),buffer=doc.createBuffer(),positions=Float32Array.from([0,0,0,0,0,2,2,0,0]),indices=Uint32Array.from([0,1,2]),primitive=doc.createPrimitive().setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer)).setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));doc.createScene().addChild(doc.createNode('fixture_ground_bridge_asphalt').setMesh(doc.createMesh().addPrimitive(primitive)));
 const bundle=parseCollisionBundle(encodeCollisionBundle({originId:'test',frame:'X-east,Y-up,Z-south',cell:'fixture',surfaceTags:['road:asphalt:bridge-reconstruction']},[{id:'paired-road',group:'ground',ref:null,positions,indices,triangleTags:Uint16Array.from([0])}]));
 assert.equal(readExactBridgeRoadGround(doc,bundle).length,1);bundle.colliders[0]!.positions[1]=.001;assert.equal(readExactBridgeRoadGround(doc,bundle).length,0);
});

test('rail cap construction searches fine-axis Float32 neighbours without expanding its distance allowance',()=>{
 const vertices:[number,number,number][]=[[-1300.9957275390625,6.98681640625,-71.4405746459961],[-1301.136962890625,6.978445529937744,-71.3630142211914],[-1301.129150390625,6.978431224822998,-71.35125732421875]],ground={id:'measured-apron-face',vertices:vertices as [typeof vertices[0],typeof vertices[0],typeof vertices[0]],visual:{node:'fixture',primitive:0,triangle:0},collision:{collider:'fixture',triangles:[0]},tag:'road'},p=[-1301.0037841796875,6.98931,-71.43516540527344],mesh={positions:[...p,...vertices[1]!,...vertices[2]!],normals:[],uvs:[],colours:[],indices:[0,1,2],bindings:[{ground,triangles:1,wayIds:[1]}],stats:{expectedArea:1,coveredArea:1,missingArea:0,maximumLiftError:0,triangles:1}},proof=conformBridgeRailBoundary(mesh,[ground.vertices]);
 assert.equal(proof.vertices,1);assert.ok(proof.maximumTrimMetres<=.00008);assert.equal(mesh.positions[0],p[0]);assert.ok(Math.abs(mesh.positions[2]!-p[2]!)>1/131072);
});

test('source-coast revetment slopes from actual paved bank grade to a short vertical waterline toe',()=>{
 const q={id:'source-bank',sourceCoastWayId:1,coast:[[0,0],[0,12]] as [number,number][],landWidth:4,waterY:-7.5,kind:'sloped-stone-revetment' as const,toeHeight:.35,observation:'Measured shore fixture'},faces=buildBridgeBankQuay(q,(x,z)=>-2+.01*z,()=>undefined),bank=faces.filter(f=>f.role==='bank');assert.ok(bank.length>=24);assert.ok(bank.every(f=>f.material==='revetment'&&f.collision));
 for(const p of bank.flatMap(f=>f.points)){if(p[0]===0)assert.ok(Math.abs(p[1]+7.15)<.000001);if(p[0]===4)assert.ok(Math.abs(p[1]-(-2+.01*p[2]))<.000001);}assert.ok(faces.some(f=>f.role==='soffit'&&f.points.some(p=>p[1]===-8)));
 for(const end of[0,12]){const returns=faces.filter(f=>f.role==='soffit'&&f.points.every(p=>p[2]===end));assert.ok(returns.length);assert.ok(returns.some(f=>f.points.some(p=>p[0]===4&&p[1]===-8)),'Bounded end return closes the earth volume below both thin surface sheets');assert.ok(returns.every(f=>supportNormal(f.points)[2]*(end===0?-1:1)>.99),'Both bank end caps face outwards');}
});

test('bridge approach cheek meets the rebuilt revetment instead of its obsolete raw ground height',()=>{
 const q={id:'actual-bank',sourceCoastWayId:1,coast:[[105,3],[135,3]] as [number,number][],landWidth:4,waterY:-7.5,kind:'sloped-stone-revetment' as const,toeHeight:.35,observation:'Source-bound bank'},b:ReconstructedBridge={...base,kind:'concrete-girder',arch:undefined,quays:[q]},faces=buildReconstructedBridge(b,{source:{height:()=>0}}),edge=faces.filter(f=>f.role==='soffit'&&f.material==='concrete').flatMap(f=>f.points).filter(p=>p[0]===110&&p[2]===1);
 assert.ok(edge.some(p=>Math.abs(p[1]+3.575)<.00001),'The wall bottom touches the actual new bank plane');
});

test('sharp surveyed shoreline jogs retain convex bank strips rather than folding the inland offsets',()=>{
 const q={id:'coast-jog',sourceCoastWayId:1,coast:[[323.516,135.046],[317.969,144.368],[318.929,145.160],[315.7,151]] as [number,number][],landWidth:4,waterY:-7.5,observation:'Real coast-jog regression'},zones=quayReplacementZones(q);
 for(const z of zones){const r=z.footprint!,cross=r.map((p,i)=>{const a=r[(i+1)%4]!,c=r[(i+2)%4]!;return(a[0]-p[0])*(c[1]-a[1])-(a[1]-p[1])*(c[0]-a[0]);});assert.ok(cross.every(v=>v>0)||cross.every(v=>v<0),`Folded bank footprint${JSON.stringify(r)}`);}
});

test('reconstructed coast edge replaces only its named old seal wall and keeps the inland boundary wall',()=>{
 const patch={id:'coast-edge',cell:'fixture',footprint:[[0,0],[2,0],[2,2],[0,2]] as [number,number][],boundsXZ:[0,0,2,2] as [number,number,number,number],triangles:[],sourceNode:'original-coast',sourcePrimitive:0,observations:[],replaceBoundaryEdges:[3]},positions=Float32Array.from([0,-7,.3,0,-3,.3,0,-7,1.7,2,-7,.3,2,-3,.3,2,-7,1.7]),mesh={attributes:{POSITION:positions},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.from([0,1,2,3,4,5])},out=retainOutsideBridge(mesh,[patch]);assert.deepEqual(out.proof.removedSourceTriangles,[0]);assert.deepEqual(Array.from(out.mesh.indices),[3,4,5]);
});

test('coast cut rejects a backwards source spur that would expose an overlapping bank underside',()=>{
 const q={id:'source-end-reversal',sourceCoastWayId:1,coast:[[307.07523,136.74223],[307.10423,136.74043],[308.25845,137.54335],[310.26468,134.26903],[319.56537,118.20636]] as [number,number][],landWidth:4,waterY:-7.5,observation:'Actual bounded-end regression'};
 assert.throws(()=>quayReplacementZones(q),/source shoreline corner/);
 assert.ok(quayReplacementZones({...q,coast:q.coast.slice(2)}).length>0);
});

test('source attributes are reused while only clipped fragments receive compact new arrays',()=>{
 const positions=Float32Array.from([0,0,0,1,0,0,0,0,1,2,0,0,2,0,1,.5,0,.5]),colours=Uint8Array.from([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]),mesh={attributes:{POSITION:positions,COLOR_0:colours},components:{POSITION:3,COLOR_0:3},indices:Uint32Array.from([0,1,2,1,5,2])},out=partitionBridgeReplacementGeometry(mesh,5);
 assert.deepEqual(Array.from(out.originalIndices),[0,1,2]);assert.equal(out.fragmentVertexCount,3);assert.ok(out.fragments.attributes.COLOR_0 instanceof Uint8Array);assert.equal(out.fragments.attributes.POSITION!.length,9);
 const points=(attributes:Record<string,ArrayLike<number>>,indices:ArrayLike<number>)=>Array.from(indices,i=>Array.from(attributes.POSITION!).slice(i*3,i*3+3));assert.deepEqual(points(out.fragments.attributes,out.fragments.indices),points(mesh.attributes,mesh.indices.subarray(3)));assert.equal(positions.length,18);
});

test('bank curb knots retain distinct Float32 positions closer than the old0.2mm merge radius',()=>{
 const faces=buildReconstructedBridge({...base,kind:'concrete-girder',arch:undefined},{source:{height:x=>x<120.40005?0:.12,bankCrossBreaks:[.4,.4001]}}),X=new Set(faces.filter(f=>f.role==='road').flatMap(f=>f.points).filter(p=>p[2]===0).map(p=>p[0]));assert.ok(X.has(Math.fround(120.4)));assert.ok(X.has(Math.fround(120.4001)));
});


test('compacted source fragments retain native ground and old-rail mask node protocols',()=>{
 assert.match(bridgeFragmentNodeName('cell_ground_slabs',0),/_ground_slabs$/);assert.match(bridgeFragmentNodeName('cell_tram_visuals',2),/_tram_visuals$/);assert.notEqual(bridgeFragmentNodeName('cell_ground_slabs',0),'cell_ground_slabs');
});


test('source bank curb detail ends on a fully authored row before the sparse road zipper',()=>{
 const faces=buildReconstructedBridge({...base,kind:'concrete-girder',arch:undefined},{source:{height:x=>x<125?0:.12,bankCrossBreaks:[4.999,5,5.001]}}),steep=faces.filter(f=>f.role==='road'&&supportNormal(f.points)[1]<.3);assert.ok(steep.length);assert.ok(steep.every(f=>Math.max(...f.points.map(p=>p[0]))-Math.min(...f.points.map(p=>p[0]))<.002),'A source curb must not fan as a diagonal steep face across the driving lane');
});


test('complete original coast segment removes old seal fragments at rounded internal row ends',()=>{
 const patch={id:'coast-row',cell:'fixture',footprint:[[0,0],[2,0],[2,1],[0,1]] as [number,number][],boundsXZ:[0,0,2,1] as [number,number,number,number],triangles:[],sourceNode:'coast',sourcePrimitive:0,observations:[],replaceBoundarySegments:[[[0,0],[0,2]]] as [[number,number],[number,number]][]},positions=Float32Array.from([0,-7,.3,0,-3,.3,0,-7,1.00003,2,-7,.3,2,-3,.3,2,-7,1.00003]),out=retainOutsideBridge({attributes:{POSITION:positions},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.from([0,1,2,3,4,5])},[patch]);assert.deepEqual(out.proof.removedSourceTriangles,[0]);assert.deepEqual(Array.from(out.mesh.indices),[3,4,5]);
});


test('shore abutment volume stays on the exact land mask below authored soffits',()=>{
 const land=[[[[0,0],[4,0],[4,2],[0,2],[0,0]]]] as [number,number][][][],roof=[[[0,1,0],[0,1,2],[4,1,0]],[[4,1,0],[0,1,2],[4,1,2]]] as [number,number,number][][],faces=buildBridgeLandClosure(land,roof as any,-7.5);assert.ok(faces.length>8);assert.ok(faces.every(f=>f.collision&&f.role==='bank'));assert.ok(faces.flatMap(f=>f.points).every(p=>p[0]>=0&&p[0]<=4&&p[2]>=0&&p[2]<=2&&p[1]<=1));assert.ok(faces.some(f=>f.points.some(p=>p[1]===-8)));
});

test('visual water infill triangulation preserves land holes at the existing source water level',()=>{
 const triangles=triangulateBridgeShoreMask([[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,3],[3,3],[3,1],[1,1]]]],-7.5);assert.ok(Math.abs(triangles.reduce((n,t)=>n+area(t),0)-12)<1e-6);assert.ok(triangles.flat().every(p=>p[1]===-7.5));for(const t of triangles){const x=t.reduce((n,p)=>n+p[0],0)/3,z=t.reduce((n,p)=>n+p[2],0)/3;assert.ok(!(x>1&&x<3&&z>1&&z<3));}
});


test('enumerated obsolete source sidewall is removed on its whole segment outside a municipal clip',()=>{
 const patch={id:'exact-obsolete-segment',cell:'fixture',footprint:[[0,0],[2,0],[2,2]] as [number,number][],boundsXZ:[-1,-1,2,2] as [number,number,number,number],triangles:[],sourceNode:'source-wall',sourcePrimitive:0,observations:[],maximumSourceY:-5.4,replaceBoundarySegments:[[[-1,-1],[0,0]]] as [[number,number],[number,number]][]},positions=Float32Array.from([-1,-5.5,-1,0,-5.7,0,-1,-5.8,-1,-1,-3,-1,0,-3,0,-1,-3.2,-1,3,-6,3,4,-6,3,3,-6,4]),out=retainOutsideBridge({attributes:{POSITION:positions},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.from([0,1,2,3,4,5,6,7,8])},[patch]);assert.deepEqual(out.proof.removedSourceTriangles,[0]);assert.deepEqual(Array.from(out.mesh.indices),[3,4,5,6,7,8]);
});


test('current-water seal replacement trims a crossing original wall and keeps its land fragment',()=>{
 const patch={id:'water-only-segment',cell:'fixture',footprint:[[8,8],[9,8],[8,9]] as [number,number][],boundsXZ:[0,0,9,9] as [number,number,number,number],triangles:[],sourceNode:'source-seal',sourcePrimitive:0,observations:[],maximumSourceY:-5.3,replaceBoundarySegments:[[[0,0],[0,1]]] as [[number,number],[number,number]][]},positions=Float32Array.from([0,-6,0,0,-5.4,0,0,-6,2]),out=retainOutsideBridge({attributes:{POSITION:positions},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.from([0,1,2])},[patch]);assert.deepEqual(out.proof.removedSourceTriangles,[0]);assert.deepEqual(out.proof.clippedSourceTriangles,[0]);const emitted=Array.from(out.mesh.indices,i=>Array.from(out.mesh.attributes.POSITION!.slice(i*3,i*3+3)));assert.ok(emitted.length>=3);assert.ok(emitted.every(p=>p[2]!>=1));assert.ok(emitted.some(p=>p[2]===2));
});
