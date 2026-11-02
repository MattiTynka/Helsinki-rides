import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph } from '@helsinki/world-schema';
import { AIRCRAFT_DEFINITIONS, Aircraft, Button, GROUP, MALMI_AIRFIELD, MALMI_DROP_IN, NEUTRAL, RAPIER, Simulation, StaticWorld, encodeCommand, decodeCommand, groups, initPhysics, rotate, type Command } from '../src/index.ts';

before(initPhysics);
const { x, z } = MALMI_AIRFIELD;
const terrain = encodeTerrain({ x0: x - 2000, z0: z - 2000, resolution: 100, nx: 41, nz: 41, heights: new Float32Array(41 * 41) });
const ground = encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: 'flat', surfaceTags: ['runway'] }, [{
  id: 'g', group: 'ground', ref: null,
  positions: new Float32Array([x-2000,0,z-2000,x+2000,0,z-2000,x+2000,0,z+2000,x-2000,0,z+2000]),
  indices: new Uint32Array([0,2,1,0,3,2]), triangleTags: new Uint16Array([0,0]),
}]);
const roads: RoadGraph = { schemaVersion: 2, originId: 't', source: { id: 'fixture', sha256: 'x', attribution: 'fixture', license: 'CC0' }, nodes: [], lanes: [], connectors: [], parking: [], footways: [] };
const gameplay: GameplayBundle = {
  schemaVersion: 2, originId: 't', killHeight: -25, playArea: { minX: x-2000,maxX:x+2000,minZ:z-2000,maxZ:z+2000 },
  player: { spawn: { position: [MALMI_DROP_IN.x,MALMI_DROP_IN.z], headingDeg: 0 }, health: 100, armour: 0 },
  vehicleDefinitions: [], vehicles: [], anchors: [], weapons: [],
  wanted: { starWeights: {}, starThresholds: [1,2,3,4,5], decaySeconds: [1,2,3,4,5], unitCaps: [0,0,0,0,0], witnessReportSeconds: [0,0], arrest: { footRadius:3,footSeconds:2,boxedSeconds:3 }, searchRadius: 60 },
  police: { initialPatrols:0,spawnMinDistance:150,patrolSpawns:[] }, addresses:[],landmarks:[],district:{name:'fixture',boundary:[]},playerStart:{weapons:[]},
};
function makeSim(): Simulation { const world=StaticWorld.fromBytes(terrain,roads,gameplay);world.addCell('flat',ground);return new Simulation(world,{seed:17}); }
function advance(sim: Simulation, n: number, partial: Partial<Command> = {}): void { for(let i=0;i<n;i++)sim.step(decodeCommand(encodeCommand({...NEUTRAL,...partial}))); }
function board(sim: Simulation, kind: 'plane'|'helicopter'): Aircraft {
  advance(sim,20);
  const aircraft=[...sim.aircraft.values()].find(a=>a.def.kind===kind)!;
  assert.ok(aircraft);
  if(kind==='helicopter') { sim.player.teleport([aircraft.position[0]+2.6,0,aircraft.position[2]],Math.PI);advance(sim,15); }
  sim.step({...NEUTRAL,buttons:Button.interact});
  assert.equal(sim.mode,'flying');assert.equal(sim.playerAircraftId,aircraft.id);return aircraft;
}

test('Malmi aircraft are lazy and need queryable static ground before spawning',()=>{
  const sim=makeSim(),queryable=sim.world.queryable.bind(sim.world);
  sim.world.queryable=()=>false;advance(sim,15);assert.equal(sim.aircraft.size,0);
  sim.world.queryable=queryable;advance(sim,1);assert.equal(sim.aircraft.size,2);
  assert.equal(sim.state().player.nearAircraft,'malmi-plane');
  const far=new Simulation(StaticWorld.fromBytes(terrain,roads,{...gameplay,player:{...gameplay.player,spawn:{position:[x-1500,z],headingDeg:0}}}),{seed:17});
  advance(far,1);assert.equal(far.aircraft.size,0);
});

test('Snow enters a plane, needs takeoff speed, flies and cannot dismount in the air',()=>{
  const sim=makeSim(),plane=board(sim,'plane');
  advance(sim,30,{buttons:Button.ascend});assert.equal(plane.grounded,true);assert.equal(plane.position[1],0);
  advance(sim,240,{moveZ:1,buttons:Button.ascend});
  assert.ok(plane.position[1]>5);assert.ok(plane.position[2]<z-20);assert.equal(plane.grounded,false);
  const yaw=plane.yaw;advance(sim,50,{moveX:0.7});assert.notEqual(plane.yaw,yaw);
  sim.step({...NEUTRAL,buttons:Button.interact});assert.equal(sim.mode,'flying');assert.ok(sim.events.some(e=>e.type==='aircraftExitBlocked'));
  assert.equal(sim.state().player.weapon,null);assert.equal(sim.state().player.inVehicle,null);
  assert.ok(sim.player.body.translation().y < -900,'walking capsule hidden during flight');
});

test('helicopter hovers, descends onto real ground and leaves Snow at an unobstructed exit',()=>{
  const sim=makeSim(),heli=board(sim,'helicopter');
  advance(sim,180,{buttons:Button.ascend});assert.ok(heli.position[1]>15);
  advance(sim,120);assert.ok(Math.abs(heli.verticalSpeed)<0.001);assert.ok(Math.abs(heli.speed)<0.001);
  advance(sim,360,{buttons:Button.descend});assert.equal(heli.grounded,true);assert.ok(Math.abs(heli.position[1])<0.001);
  sim.step({...NEUTRAL,buttons:Button.interact});assert.equal(sim.mode,'onFoot');assert.equal(sim.playerAircraftId,null);
  advance(sim,3);assert.ok(sim.player.body.translation().y>0);assert.equal(heli.occupied,false);
});

test('aircraft sweep catches a suspended beam at the actual high wing, beyond the fuselage',()=>{
  const sim=makeSim(),plane=board(sim,'plane');
  const wall=sim.world.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x+4,2.32,z-65));
  sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(0.4,0.07,0.4).setCollisionGroups(groups(GROUP.static,GROUP.all)),wall);
  sim.world.physics.step();sim.world.markStepped();
  let blocked=false;
  for(let i=0;i<500;i++){sim.step({...NEUTRAL,moveZ:1});if(plane.blocked){blocked=true;break;}}
  assert.equal(blocked,true);assert.ok(plane.position[2]>z-66);assert.equal(plane.speed,0);
});

test('banking a high wing toward a beam is clipped with its full visual orientation',()=>{
  const sim=makeSim(),plane=board(sim,'plane');
  plane.position=[x,10,z];plane.yaw=0;plane.speed=25;plane.throttle=0.5;plane.grounded=false;
  const beam=sim.world.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x-5,11.2,z+20));
  sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(1,0.1,40).setCollisionGroups(groups(GROUP.static,GROUP.all)),beam);
  sim.world.physics.step();sim.world.markStepped();
  let blocked=false;
  for(let i=0;i<20;i++){
    sim.step({...NEUTRAL,moveX:1});blocked ||= plane.blocked;
    const wing=rotate(plane.rotation,[-5,2.3,0.75]);
    assert.ok(plane.position[1]+wing[1]>11.3,'visible wing stays above the beam');
  }
  assert.equal(blocked,true);
});

test('recovery waits for Malmi collision, then resets aircraft and occupancy without airborne ejection',()=>{
  const sim=makeSim(),heli=board(sim,'helicopter');advance(sim,120,{moveZ:1,buttons:Button.ascend});
  const position=[...heli.position],queryable=sim.world.queryable.bind(sim.world);
  sim.world.queryable=()=>false;advance(sim,50,{buttons:Button.recover});
  assert.deepEqual(heli.position,position);assert.equal(sim.mode,'flying');
  assert.ok(sim.collisionSources().some(s=>s.x===heli.def.position[0]&&s.z===heli.def.position[1]));
  sim.world.queryable=queryable;advance(sim,1);
  assert.deepEqual(heli.position,[heli.def.position[0],0,heli.def.position[1]]);assert.equal(heli.grounded,true);assert.equal(heli.occupied,true);
});

test('flight commands, occupancy and motion produce deterministic replay hashes',()=>{
  const a=makeSim(),b=makeSim();board(a,'plane');board(b,'plane');
  for(let tick=0;tick<380;tick++){
    const command=decodeCommand(encodeCommand({...NEUTRAL,moveZ:tick<220?1:-0.3,moveX:tick>220?0.3:0,buttons:tick<270?Button.ascend:Button.descend}));
    a.step(command);b.step(command);assert.equal(a.hash(),b.hash(),`tick ${tick}`);
  }
  assert.deepEqual(a.state().aircraft,b.state().aircraft);
  assert.equal(AIRCRAFT_DEFINITIONS.length,2);
});

test('a gently graded runway supports the complete gear footprint through taxi, takeoff, landing and exit',()=>{
  for (const grade of [0.005, 0.02]) {
    const height=(px:number,pz:number)=>-(pz-z)*grade+(px-x)*grade/2;
    const heights=new Float32Array(41*41);
    for(let iz=0;iz<41;iz++)for(let ix=0;ix<41;ix++)heights[iz*41+ix]=height(x-2000+ix*100,z-2000+iz*100);
    const bytes=encodeTerrain({x0:x-2000,z0:z-2000,resolution:100,nx:41,nz:41,heights});
    const points=new Float32Array([x-2000,0,z-2000,x+2000,0,z-2000,x+2000,0,z+2000,x-2000,0,z+2000]);
    for(let i=0;i<points.length;i+=3)points[i+1]=height(points[i]!,points[i+2]!);
    const support=encodeCollisionBundle({originId:'t',frame:'X-east,Y-up,Z-south',cell:'slope',surfaceTags:['runway']},[{
      id:'slope',group:'ground',ref:null,positions:points,indices:new Uint32Array([0,2,1,0,3,2]),triangleTags:new Uint16Array([0,0]),
    }]);
    const world=StaticWorld.fromBytes(bytes,roads,gameplay);world.addCell('slope',support);
    const sim=new Simulation(world,{seed:17}),plane=board(sim,'plane');
    assert.ok(plane.position[1]>height(x,z)+grade,'spawn uses uphill gear support, not centre alone');
    advance(sim,240,{moveZ:1,buttons:Button.ascend});
    assert.ok(plane.position[1]-height(plane.position[0],plane.position[2])>8,`takeoff on grade ${grade}: ${JSON.stringify(plane.state())}`);
    assert.ok(Math.hypot(plane.position[0]-x,plane.position[2]-z)>20);
    advance(sim,700,{moveZ:-1,buttons:Button.descend});
    assert.equal(plane.grounded,true,`landed on grade ${grade}`);assert.ok(Math.abs(plane.speed)<2);
    sim.step({...NEUTRAL,buttons:Button.interact});assert.equal(sim.mode,'onFoot',`grounded exit on grade ${grade}: ${JSON.stringify(plane.state())}`);
    assert.ok(Math.abs(sim.player.position[1]-height(sim.player.position[0],sim.player.position[2]))<0.05);
  }
});
