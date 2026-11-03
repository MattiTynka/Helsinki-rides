import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CellDescriptor} from '../../../packages/world-schema/src/index.ts';
import {CellVisualStream, selectVisualCells, type CellStreamOptions} from '../../../apps/game/src/world/cell-streaming.ts';
import {flightSectorHalfAngle,flightStreamingProfile} from '../../../apps/game/src/render/flight-streaming.ts';
import {tierParameters,type QualityTier} from '../../../apps/game/src/render/quality-tiers.ts';
import {LiveVisuals} from '../../../apps/game/src/world/live/live-visuals.ts';
import {LiveGrid} from '../../../packages/sim/src/live-grid.ts';
import type {CellView} from '../../../apps/game/src/render/scene.ts';

const cell=(id:string,x:number,z=0):CellDescriptor=>({id,cx:x/128,cz:z/128,boundsXZ:[x,z,x+128,z+128],buildings:[],buildingIds:[],sourceTiles:[],
  visual:{lod0:{path:id+'.glb',bytes:1,sha256:'fixture',triangles:10000,drawCalls:1,atlases:0,textureBytesEstimate:0},
    lod2:{path:id+'-far.glb',bytes:1,sha256:'fixture',triangles:10000,drawCalls:1,atlases:0,textureBytesEstimate:0}},
  collision:{path:id+'.hcol',bytes:1,sha256:'fixture',triangles:1}});
const cells=[cell('near',0),cell('near-behind',-128),cell('far-ahead',768),cell('far-behind',-896),cell('far-side',0,768)];
const opts={radius:900,maxCells:96,geometryBudgetBytes:128*2**20,textureBudgetBytes:4*2**20,
  lookaheadSeconds:8,maxLookahead:600,level:'lod2',sector:{nearRadius:300,halfAngle:Math.PI/3}} as CellStreamOptions & {sector:{nearRadius:number;halfAngle:number}};
const at={x:0,z:0,velocityX:0,velocityZ:0,viewX:1,viewZ:0};

test('flight hover reveals actual far cells in the camera sector while retaining ground around the aircraft',()=>{
  const selected=selectVisualCells(cells,at,opts,new Map(),new Set()).map(c=>c.id);
  assert.ok(selected.includes('far-ahead'),'A cell over 750m ahead is requested');
  assert.ok(selected.includes('near-behind'),'The nearby ground ring stays resident behind the pilot');
  assert.ok(!selected.includes('far-behind'),'Far cells behind the view do not consume the forward budget');
  assert.ok(!selected.includes('far-side'));
  const turned=selectVisualCells(cells,{...at,viewX:-1},opts,new Map(),new Set()).map(c=>c.id);
  assert.ok(turned.includes('far-behind'));assert.ok(!turned.includes('far-ahead'));
});

test('flight near coverage wins a hard cap and farther resources really become resident, then leave on ground restore',async()=>{
  const capped=selectVisualCells(cells,at,{...opts,maxCells:2},new Map(),new Set()).map(c=>c.id);
  assert.deepEqual(new Set(capped),new Set(['near','near-behind']));
  const stream=new CellVisualStream(cells,{load:async()=>({textureBytes:0,geometryBytes:10000*108,lod:'lod2' as const}),show:()=>{},dispose:()=>{}},opts);
  stream.update(at);await stream.settle();assert.ok(stream.residentIds().includes('far-ahead'));
  stream.setOptions({radius:300,maxCells:28,sector:null} as Parameters<typeof stream.setOptions>[0]);
  await stream.settle();assert.ok(!stream.residentIds().includes('far-ahead'));
  assert.ok(stream.stats().residentGeometryMiB<=128);stream.dispose();
});

test('flight and tier changes preserve each hard allocation and ground policy, including wide viewports',()=>{
  for(const tier of ['standard','low','minimal'] as QualityTier[])for(const mobile of [false,true]){
    const base=tierParameters(tier,mobile),flight=flightStreamingProfile(tier,mobile,true),ground=flightStreamingProfile(tier,mobile,false);
    assert.ok(flight.fallback.radius>base.fallback.radius*2);
    assert.deepEqual(flight.detail,base.detail);
    assert.equal(flight.fallback.geometryBudgetMiB,base.fallback.geometryBudgetMiB,'independent streams never borrow an in-flight GPU reservation');
    assert.deepEqual(ground.detail,base.detail);assert.deepEqual(ground.fallback,base.fallback);
    assert.equal(ground.selection.sector,null);assert.equal(ground.selection.lookaheadSeconds,3);
    assert.ok(flight.cameraFar>=flight.fog.far);
  }
  assert.equal(flightSectorHalfAngle(60,1),Math.PI/3);
  assert.ok(flightSectorHalfAngle(60,4)>Math.atan(Math.tan(Math.PI/6)*4));
});

test('live flight expands the real candidate window and mounts distant colour-only cells within texture caps',async()=>{
  const low=tierParameters('low'),flight=flightStreamingProfile('low',false,true),grid=new LiveGrid([]);
  const shown=new Map<string,CellView>();let textureAcquisitions=0;
  const requestedKinds:{error:number;kind:unknown}[]=[];
  const positions=new Float32Array([0,2,0,1,2,0,0,3,0]);
  const visual=new LiveVisuals({grid,low:true,mobile:false,detail:low.detail,fallback:low.fallback,
    detailTextureBudgetBytes:32*2**20,fallbackTextureBudgetBytes:8*2**20,
    loader:{ktx2:{parse(){textureAcquisitions++;throw new Error('unexpected texture upload');}}} as never,
    terrain:{x0:0,z0:0,resolution:128,nx:2,nz:2,heights:new Float32Array(4)} as never,
    source:{ground:()=>({positions:new Float32Array(),normals:new Float32Array(),classes:[],water:null}),
      visual:async(cx:number,_cz:number,error:number,kind:unknown)=>{requestedKinds.push({error,kind});return {parts:[{positions,normals:positions,uvs:new Float32Array(6),texture:'facade',color:[0.7,0.6,0.5]}],
        textures:cx>=5?[{key:'facade',width:1024,height:1024,share:1,bytes:new ArrayBuffer(16)}]:[],triangles:1};}} as never,
    scene:{prepareCell:async()=>{},adoptCellGroup:()=>1,showCell:(v:CellView)=>shown.set(`${v.lod}:${v.id}`,v),disposeCell:(v:CellView)=>shown.delete(`${v.lod}:${v.id}`)} as never});
  try{
    visual.update(at);
    for(let i=0;i<30&&visual.stats().fallback.pendingCells;i++)await new Promise(resolve=>setTimeout(resolve,0));
    const groundCandidates=visual.stats().fallback.totalCells;
    visual.setRanges(flight.detail,flight.fallback,flight.selection);
    for(let i=0;i<100&&visual.stats().fallback.pendingCells;i++)await new Promise(resolve=>setTimeout(resolve,0));
    assert.ok(visual.stats().fallback.totalCells>groundCandidates*2,'candidate discovery expands along with the selection radius');
    const far=visual.residentIds().fallback.filter(id=>{const [cx,cz]=grid.parse(id)!;return cx*128>=640&&Math.abs(cz*128)<256;});
    assert.ok(far.length>0,'live coarse geometry is mounted over 600m ahead under an 8MiB texture ceiling');
    for(const id of far){const v=shown.get(`lod2:${id}`)!;assert.ok(v);assert.equal(v.textureBytes,0);}
    assert.equal(textureAcquisitions,0);
    assert.ok(visual.stats().fallback.residentGeometryMiB<=low.fallback.geometryBudgetMiB);
    visual.setRanges(low.detail,low.fallback);await new Promise(resolve=>setTimeout(resolve,0));
    assert.ok(!visual.residentIds().fallback.some(id=>far.includes(id)),'ground mode retires the distant live geometry');
    assert.ok(requestedKinds.some(r=>r.kind==='coarse'));
    assert.ok(requestedKinds.some(r=>r.kind==='detail'));
    assert.ok(requestedKinds.every(r=>r.kind===(r.error===20?'coarse':'detail')),'each backend requests its fixed payload kind through flight/ground range changes');
  }finally{visual.dispose();}
});
