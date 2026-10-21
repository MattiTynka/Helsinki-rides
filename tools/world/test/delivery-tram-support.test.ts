import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Document} from '@gltf-transform/core';
import {encodeCollisionBundle,parseCollisionBundle,geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import {readMatchingDeliveryTramGround,proveDeliveryTramTierSupport} from '../lib/tram-support.ts';
import {validateDeliveryTramTracks,qualifyDeliveryTramBridge} from '../apply_delivery_tram_visuals.ts';
import {drapeTramFootprints,tramFootprints,type TramTrack,type TramGroundTriangle} from '../lib/tram-visuals.ts';

function rectangle(a:number,b:number,y:(x:number)=>number=()=>0,z0=-2,z1=2):TramGroundTriangle[]{
 const p=(x:number,z:number)=>[x,y(x),z] as [number,number,number];
 return [[p(a,z0),p(a,z1),p(b,z1)],[p(a,z0),p(b,z1),p(b,z0)]].map((vertices,i)=>({id:`${a}:${b}:${i}`,vertices:vertices as [number,number,number][],visual:{node:'cell_ground_asphalt',primitive:0,triangle:i},collision:{collider:'g:cell',triangles:[i]},tag:'road:asphalt'})) as TramGroundTriangle[];
}
const axis=(wayId:number,points:[number,number,number][],tags:Record<string,string>={}):TramTrack=>({wayId,tags:{railway:'tram',...tags},points:points.map(([nodeId,x,z])=>({nodeId,x,z}))});
const bridge={...axis(1,[[1,0,0],[2,10,0]],{bridge:'yes',layer:'1'}),deckAuthority:{maximumJoinDiscontinuityMetres:.02}};
const continuations=[axis(2,[[3,-2,0],[1,0,0]]),axis(3,[[2,10,0],[4,12,0]])];

test('bridge authority follows measured continuous deck crowns instead of a straight bank plane',()=>{
 const g=[...rectangle(-2,0),...rectangle(0,5,x=>x*.12),...rectangle(5,10,x=>(10-x)*.12),...rectangle(10,12)];
 const proof=qualifyDeliveryTramBridge(bridge,g,[bridge,...continuations]);
 assert.equal(proof.qualified,true);assert.ok(proof.maximumBankDeviationDiagnosticOnly!>.59);
 assert.equal(proof.missingSamples,0);assert.ok(proof.maximumInteriorJoinDiscontinuity<.001);
 assert.ok(proof.samples.every(s=>s.support?.tag==='road:asphalt'));
});

test('a narrow bank discontinuity between regular samples is rejected by actual triangle-edge probes',()=>{
 const g=[...rectangle(-2,4.001),...rectangle(4.001,4.011,()=>.18),...rectangle(4.011,12)];
 const proof=qualifyDeliveryTramBridge(bridge,g,[bridge,...continuations]);
 assert.equal(proof.qualified,false);assert.ok(proof.maximumInteriorJoinDiscontinuity>.179);
 assert.ok(proof.interiorJoins.some(j=>Math.abs(j.signedHeightChange)>.179));
});

test('bridge qualification fails for water, absent deck, a source gap, or no mapped bank continuation',()=>{
 const water=rectangle(-2,12).map(t=>({...t,tag:'water'}));
 assert.equal(qualifyDeliveryTramBridge(bridge,water,[bridge,...continuations]).qualified,false);
 assert.equal(qualifyDeliveryTramBridge(bridge,[...rectangle(-2,4),...rectangle(6,12)],[bridge,...continuations]).qualified,false);
 assert.throws(()=>qualifyDeliveryTramBridge(bridge,rectangle(-2,12),[bridge]),/bank continuation/);
});

test('high inclusive bank edges cannot let a lower road stand in for an absent bridge deck',()=>{
 const floors=[...rectangle(-2,0,()=>6),...rectangle(0,10,()=>-5),...rectangle(10,12,()=>6)],proof=qualifyDeliveryTramBridge(bridge,floors,[bridge,...continuations]);
 assert.equal(proof.samples[0].topY,6);assert.equal(proof.samples.at(-1).topY,6);assert.equal(proof.missingSamples,0);
 assert.equal(proof.qualified,false);assert.ok(proof.bankJoinDiscontinuities!.every(d=>d>10));assert.equal(proof.deckEntry.y,-5);assert.equal(proof.deckExit.y,-5);
});

function surface(name='cell_ground_senate_entrance_existing-10',height=0,indices=[0,3,2,0,2,1],x1=10){
 const doc=new Document(),buffer=doc.createBuffer(),positions=new Float32Array([0,height,-2,x1,height,-2,x1,height,2,0,height,2]);
 const P=doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(positions),I=doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(Uint32Array.from(indices));
 const primitive=doc.createPrimitive().setAttribute('POSITION',P).setIndices(I),mesh=doc.createMesh().addPrimitive(primitive),node=doc.createNode(name).setMesh(mesh);doc.createScene().addChild(node);return{doc,positions};
}
function bundle(height=0,group:'ground'|'buildings'='ground'){
 const positions=surface('unused',height).positions;
 return parseCollisionBundle(encodeCollisionBundle({originId:'origin',frame:'X-east,Y-up,Z-south',cell:'cell',surfaceTags:['entrance:palace-road']},[{id:'g:cell',group,ref:null,positions,indices:new Uint32Array([0,3,1,1,3,2]),triangleTags:new Uint16Array(2)}]));
}
const bounds={minX:0,maxX:10,minZ:-2,maxZ:2};
const ribbons=tramFootprints([axis(20,[[1,0,0],[2,10,0]])]);

test('new source-ground names and opposite triangle diagonals require actual coincident HCOL coverage',()=>{
 const{doc}=surface(),before=doc.getRoot().listAccessors().map(a=>a.getArray()!.slice()),matched=readMatchingDeliveryTramGround(doc,bundle());
 assert.equal(matched.proof.exactFacets,0);assert.equal(matched.proof.intersectionFacets,4);assert.equal(matched.proof.maximumPlaneError,0);
 const rail=drapeTramFootprints(ribbons,matched.ground,bounds);assert.equal(rail.coverage!.unresolvedArea,0);assert.ok(rail.stats.triangles>0);
 assert.deepEqual(doc.getRoot().listAccessors().map(a=>a.getArray()),before);
 assert.equal(readMatchingDeliveryTramGround(doc,bundle(.00002)).ground.length,0);
 assert.equal(readMatchingDeliveryTramGround(doc,bundle(0,'buildings')).ground.length,0);
 assert.equal(readMatchingDeliveryTramGround(surface('building_roof').doc,bundle()).ground.length,0);
});

test('coarse tier support accepts the same source plane with another diagonal but rejects real gaps and offsets',()=>{
 const mesh=drapeTramFootprints(ribbons,rectangle(0,10),bounds,true),tier=surface('coarse',0,[0,3,1,1,3,2]).doc;
 assert.equal(proveDeliveryTramTierSupport(tier,mesh).qualified,true);
 const offset=proveDeliveryTramTierSupport(surface('coarse',.001).doc,mesh);assert.equal(offset.qualified,false);assert.ok(offset.missingArea>1);
 const gap=proveDeliveryTramTierSupport(surface('coarse',0,[0,3,1,1,3,2],9.95).doc,mesh);assert.equal(gap.qualified,false);assert.ok(gap.missingArea>.005);
});

test('direct convex coverage remains stable at large Float32 runtime coordinates without loosening fringe allowance',()=>{
 const shift=(x:number,z:number)=>{const s=surface('coarse'),P=s.doc.getRoot().listAccessors().find(a=>a.getType()==='VEC3')!,v=P.getArray()!;for(let i=0;i<v.length;i+=3){v[i]!+=x;v[i+2]!+=z;}return s.doc;};
 const g=rectangle(0,10).map(t=>({...t,vertices:t.vertices.map(v=>[v[0]-1024,v[1],v[2]-768]) as TramGroundTriangle['vertices']})),source=axis(20,[[1,-1024,-768],[2,-1014,-768]]),mesh=drapeTramFootprints(tramFootprints([source]),g,{minX:-1024,maxX:-1014,minZ:-770,maxZ:-766},true);
 const proof=proveDeliveryTramTierSupport(shift(-1024,-768),mesh);assert.equal(proof.qualified,true);assert.ok(proof.missingArea<1e-8);assert.equal(proof.construction,'direct-convex-source-triangle-partition');assert.equal(proof.booleanGridMetres,0);assert.equal(proof.fringeAllowanceGridMetres,.000001);
});

test('dense canal-scale Float32 retessellation remains complete while a real removed grid cell fails',()=>{
 const x0=Math.fround(315.811),z0=Math.fround(131.141),size=.05,steps=10;
 function grid(remove=false){const doc=new Document(),buffer=doc.createBuffer(),positions:number[]=[],indices:number[]=[];for(let z=0;z<=steps;z++)for(let x=0;x<=steps;x++)positions.push(Math.fround(x0+x*size/steps),0,Math.fround(z0+z*size/steps));
  for(let z=0;z<steps;z++)for(let x=0;x<steps;x++){if(remove&&z===4&&x===4)continue;const a=z*(steps+1)+x,b=a+1,c=a+steps+1,d=c+1;indices.push(a,c,b,b,c,d);}
  const p=doc.createPrimitive().setAttribute('POSITION',doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(Float32Array.from(positions))).setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(Uint32Array.from(indices)));doc.createScene().addChild(doc.createNode('coarse').setMesh(doc.createMesh().addPrimitive(p)));return doc;}
 const positions=[x0,.003,z0,x0,.003,Math.fround(z0+size),Math.fround(x0+size),.003,Math.fround(z0+size),Math.fround(x0+size),.003,z0].map(Math.fround),mesh:any={positions,indices:[0,1,2,0,2,3]},complete=proveDeliveryTramTierSupport(grid(),mesh),hole=proveDeliveryTramTierSupport(grid(true),mesh);
 assert.equal(complete.qualified,true);assert.equal(complete.missingArea,0);assert.equal(hole.qualified,false);assert.ok(hole.missingArea>.00002);assert.ok(hole.missing.length>0);
});

test('actual steep Pitka source floor remains authoritative after Float32 rail rounding, with both bounds enforced',()=>{
 const source:TramGroundTriangle={id:'source-450',vertices:[[-115.07888793945312,-2.081364154815674,-800],[-115.85245513916016,-1.6485424041748047,-797.870849609375],[-115.80120849609375,-1.650292158126831,-797.8733520507812]],visual:{node:'cell_ground_asphalt',primitive:0,triangle:450},collision:{collider:'g:cell',triangles:[1433]},tag:'road:asphalt'};
 const positions=[[-115.36197662353516,-1.9094221591949463,-799.1665649414062],[-115.41650390625,-1.8894644975662231,-799.0707397460938],[-115.41328430175781,-1.8788000345230103,-799.0154418945312]].flat();
 function floor(offset=0){const doc=new Document(),b=doc.createBuffer(),p=doc.createPrimitive().setAttribute('POSITION',doc.createAccessor().setType('VEC3').setBuffer(b).setArray(Float32Array.from(source.vertices.flatMap(v=>[v[0],v[1]+offset,v[2]])))).setIndices(doc.createAccessor().setType('SCALAR').setBuffer(b).setArray(new Uint32Array([0,1,2])));doc.createScene().addChild(doc.createNode('coarse').setMesh(doc.createMesh().addPrimitive(p)));return doc;}
 const unbound:any={positions,indices:[0,1,2],bindings:[]};assert.equal(proveDeliveryTramTierSupport(floor(.000006),unbound).qualified,false,'Rounding error must not be mixed into the separate10um floor-equivalence budget');
 const bound={...unbound,bindings:[{ground:source,triangles:1,wayIds:[1]}]},proof=proveDeliveryTramTierSupport(floor(.000006),bound);assert.equal(proof.qualified,true);assert.ok(proof.maximumPlaneError<.00001);assert.ok(proof.maximumRailFloat32LiftError>.000004&&proof.maximumRailFloat32LiftError<=.0001);assert.equal(proof.sourcePlaneAuthority,'paired-rendered-and-collision-floor-bindings');
 assert.equal(proveDeliveryTramTierSupport(floor(.001),bound).qualified,false);
 assert.throws(()=>proveDeliveryTramTierSupport(floor(),{...bound,positions:positions.map((v,i)=>i%3===1?v+.001:v)}),/construction bound/);
});

test('delivery track validation rejects source-axis/tag/node-order changes, old-way duplication, and implicit bridge heights',()=>{
 const[e,n]=geodeticToGk25(60.17,24.95),manifest:any={origin:{id:'o',originProjected:[e,n,7.5]}},nodes=[{type:'node',id:10,lat:60.17,lon:24.95},{type:'node',id:11,lat:60.17001,lon:24.95}];
 const points=nodes.map(p=>{const[x,y]=geodeticToGk25(p.lat,p.lon);return{nodeId:p.id,x:x-e,z:-(y-n)};}),tags={railway:'tram'},extract={elements:[...nodes,{type:'way',id:5,nodes:[10,11],tags}]};
 const profile:any={schemaVersion:1,origin:manifest.origin,gaugeMetres:1,existingRailClearanceMetres:.0005,tracks:[{wayId:5,points,tags}],contextTracks:[],existingProfiles:[{wayIds:[2]}],scope:{renderBoundsRuntimeXZ:[-10,-10,10,10]},budgets:{detailedTriangles:1000}};
 validateDeliveryTramTracks(profile,extract,manifest);
 const changed=()=>structuredClone(profile);
 let p=changed();p.tracks[0].points[0].x+=.01;assert.throws(()=>validateDeliveryTramTracks(p,extract,manifest),/axis differs/);
 p=changed();p.tracks[0].points.reverse();assert.throws(()=>validateDeliveryTramTracks(p,extract,manifest),/node order/);
 p=changed();p.tracks[0].tags.gauge='1435';assert.throws(()=>validateDeliveryTramTracks(p,extract,manifest),/tags changed/);
 p=changed();p.existingProfiles[0].wayIds.push(5);assert.throws(()=>validateDeliveryTramTracks(p,extract,manifest),/cannot be added again/);
 p.tracks[0].role='uncovered-existing-ribbon';p.existingTailWayIds=[5];p.existingRibbonPolicy='Subtract actual decoded delivered rail footprints before supporting or emitting any existing-way repair ribbon.';validateDeliveryTramTracks(p,extract,manifest);p.existingTailWayIds=[];assert.throws(()=>validateDeliveryTramTracks(p,extract,manifest),/explicit masked/);
 p=changed();p.tracks[0].tags={...tags,bridge:'yes',layer:'1'};const e2:any=structuredClone(extract);e2.elements.at(-1)!.tags=p.tracks[0].tags;assert.throws(()=>validateDeliveryTramTracks(p,e2,manifest),/deck qualification/);
});
