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
  assert.equal(blocked,true);assert.ok(plane.position[2]>z-66);
  assert.equal(plane.crashed,true);assert.equal(plane.body.isDynamic(),true);
  assert.ok(Math.hypot(...plane.velocity)>5,'impact retains incoming momentum');
  const q=plane.rotation;advance(sim,90,{buttons:Button.ascend,moveZ:1});
  assert.ok(q.some((v,i)=>Math.abs(v-plane.rotation[i]!)>0.05),'off-centre wing impact tumbles');
  assert.equal(plane.throttle,0);
});

test('banking a high wing toward a beam hands the full visual orientation to physics',()=>{
  const sim=makeSim(),plane=board(sim,'plane');
  plane.position=[x,10,z];plane.yaw=0;plane.speed=25;plane.throttle=0.5;plane.grounded=false;
  const beam=sim.world.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x-5,11.2,z+20));
  sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(1,0.1,40).setCollisionGroups(groups(GROUP.static,GROUP.all)),beam);
  sim.world.physics.step();sim.world.markStepped();
  let blocked=false,handoff:readonly number[]=[];
  const crash=plane.crash.bind(plane);plane.crash=(velocity,angular)=>{handoff=angular??[];crash(velocity,angular);};
  for(let i=0;i<20;i++){
    sim.step({...NEUTRAL,moveX:1});blocked ||= plane.blocked;
    if(plane.crashed)break;
  }
  assert.equal(blocked,true);
  assert.equal(plane.crashed,true);assert.equal(plane.body.isDynamic(),true);
  assert.ok(Math.hypot(...handoff)>0.9,'translation retry retains the incoming world bank rate');
});

test('streaming holds preserve an intact aircraft, but a hard sink crashes and recovery restores it',()=>{
  const sim=makeSim(),heli=board(sim,'helicopter'),queryable=sim.world.queryable.bind(sim.world);
  sim.world.queryable=()=>false;advance(sim,10,{moveZ:1});assert.equal(heli.state().crashed,false);assert.equal(heli.health,1);
  sim.world.queryable=queryable;
  heli.position=[x,0.2,z];heli.grounded=false;heli.verticalSpeed=-18;
  sim.step(NEUTRAL);assert.equal(heli.crashed,true);assert.ok(heli.health<1);
  assert.ok(heli.velocityBefore[1]<-5,'hard landing gives the solver incoming downward momentum');
  advance(sim,60,{buttons:Button.recover});assert.equal(heli.crashed,false);assert.equal(heli.health,1);assert.equal(heli.damage,'intact');
  assert.equal(heli.body.isKinematic(),true);assert.deepEqual(heli.angularVelocity,[0,0,0]);
});

test('hard touchdown preserves the prior bank momentum in world axes',()=>{
  const sim=makeSim(),heli=board(sim,'helicopter');
  heli.position=[heli.position[0],20,heli.position[2]];heli.yaw=Math.PI/2;heli.grounded=false;
  heli.step({...NEUTRAL,moveX:1});const incoming=heli.angularVelocity;
  assert.ok(Math.abs(incoming[0])>0.9&&Math.abs(incoming[2])<0.05,'local bank is world X at an eastward heading');
  heli.position=[heli.position[0],0.2,heli.position[2]];heli.verticalSpeed=-18;
  heli.step(NEUTRAL);assert.equal(heli.crashed,true);
  assert.ok(heli.angularVelocity.every((v,i)=>Math.abs(v-incoming[i]!)<1e-6),'handoff retains the previous bank momentum before the solver runs');
});

test('a fast thin-wall crash uses CCD and continues while unoccupied with a distant collision lease',()=>{
  const sim=makeSim(),plane=board(sim,'plane');
  plane.position=[x,12,z];plane.yaw=0;plane.speed=80;plane.throttle=1;plane.grounded=false;
  const wall=sim.world.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x,18,z+8));
  sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(30,18,0.025).setCollisionGroups(groups(GROUP.static,GROUP.all)),wall);
  sim.world.physics.step();sim.world.markStepped();
  advance(sim,10);assert.equal(plane.crashed,true);assert.ok(plane.position[2]<z+8);
  plane.occupied=false;sim.playerAircraftId=null;sim.mode='onFoot';sim.player.teleport([x+700,0,z],0);
  const before=[...plane.position];advance(sim,5);assert.notDeepEqual(plane.position,before);
  assert.ok(sim.collisionSources().some(s=>Math.hypot(s.x-plane.position[0],s.z-plane.position[2])<1));
  assert.equal(plane.near(plane.position),false);
  plane.body.sleep();assert.ok(sim.collisionSources().some(s=>Math.hypot(s.x-plane.position[0],s.z-plane.position[2])<1),'a sleeping distant wreck retains its support lease');
});

test('a settled overturned helicopter offers a clear ground exit and cannot resume flight',()=>{
  const sim=makeSim(),heli=board(sim,'helicopter');heli.crash([0,0,0]);
  heli.body.setTranslation({x:heli.position[0],y:6,z:heli.position[2]},true);heli.body.setRotation({x:0,y:0,z:1,w:0},true);
  advance(sim,360);assert.equal(heli.crashed,true);assert.ok(Math.hypot(...heli.angularVelocity)<0.3);
  sim.step({...NEUTRAL,buttons:Button.interact});assert.equal(sim.mode,'onFoot',JSON.stringify(heli.state()));
  assert.equal(heli.occupied,false);assert.equal(heli.near(sim.player.position),false);
});

test('physical crash replay includes full rotation, health and unoccupied motion deterministically',()=>{
  const a=makeSim(),b=makeSim();
  for(const sim of[a,b]){
    const heli=board(sim,'helicopter');heli.position=[x,0.2,z];heli.verticalSpeed=-18;heli.grounded=false;
  }
  for(let i=0;i<180;i++){
    a.step(NEUTRAL);b.step(NEUTRAL);assert.equal(a.hash(),b.hash(),`physical crash tick ${i}`);
    assert.deepEqual(a.state().aircraft,b.state().aircraft);
  }
  assert.equal(a.playerAircraft!.crashed,true);
});

test('an aircraft hits a dynamic vehicle body and multi-hull contacts bill damage once per tick',()=>{
  const sim=makeSim(),plane=board(sim,'plane');
  plane.position=[x,1,z];plane.yaw=0;plane.speed=40;plane.throttle=1;plane.grounded=false;
  const car=sim.world.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x,1,z+10));
  sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(2,1,3).setMass(1650).setCollisionGroups(groups(GROUP.vehicle,GROUP.all)),car);
  sim.world.physics.step();sim.world.markStepped();
  let crashEvents=0;
  for(let i=0;i<120;i++){
    const before=plane.health;sim.step(NEUTRAL);
    crashEvents+=sim.events.filter(e=>e.type==='aircraftCrash').length;
    if(i>15)assert.ok(before-plane.health<=0.650001,'one body impact has a bounded damage bill');
  }
  assert.equal(plane.crashed,true);assert.equal(crashEvents,1);
  assert.ok(car.translation().z>z+10.5,'the dynamic contact transfers momentum to the vehicle');
  const health=plane.health;advance(sim,300);const resting=plane.health;advance(sim,60);
  assert.ok(resting<=health);assert.equal(plane.health,resting,'resting contact does not repeatedly charge damage');
});

test('stationary taxi turns on the captured Malmi runway do not turn terrain skin into a crash',()=>{
  // A small public live-ground patch captured at the actual aircraft spawn. Heights are centimetres;
  // its two-metre lattice and triangle diagonal match the source collision, including the cell seam.
  const heights=[
    707,703,701,700,702,704,706,708,710,711,
    706,703,700,702,703,705,707,709,711,713,
    705,702,700,700,702,704,706,708,710,712,
    704,702,700,699,700,701,703,705,707,709,
    704,702,700,699,699,699,701,703,705,707,
    704,702,700,699,698,698,699,700,702,704,
    704,702,700,699,698,697,697,698,700,702,
    704,702,700,699,698,697,696,696,698,700,
    704,702,700,699,698,697,696,696,697,699,
    704,702,700,699,698,697,696,696,696,698,
  ];
  const positions=new Float32Array(300),indices:number[]=[];
  for(let iz=0;iz<10;iz++)for(let ix=0;ix<10;ix++){
    const i=iz*10+ix;positions.set([4978+ix*2,heights[i]!/100,-8960+iz*2],i*3);
    if(ix<9&&iz<9)indices.push(i,i+10,i+1,i+1,i+10,i+11);
  }
  const world=StaticWorld.fromBytes(terrain,roads,gameplay);
  world.addCell('malmi-runway-patch',encodeCollisionBundle({originId:'t',frame:'X-east,Y-up,Z-south',cell:'malmi-runway-patch',surfaceTags:['road:asphalt']},[{
    id:'ground',group:'ground',ref:null,positions,indices:new Uint32Array(indices),triangleTags:new Uint16Array(indices.length/3),
  }]));
  world.physics.step();world.markStepped();
  const plane=new Aircraft(world,AIRCRAFT_DEFINITIONS[0]!,7.0103807);plane.occupied=true;
  for(let i=0;i<1800;i++){
    plane.step({...NEUTRAL,moveX:i<900?1:-1});plane.beforePhysics();world.physics.step();plane.afterPhysics();
    assert.equal(plane.crashed,false,`captured runway turn tick ${i}`);
  }
  assert.equal(plane.health,1);assert.equal(plane.speed,0);assert.equal(plane.grounded,true);
});

test('a stationary yaw turn still strikes a real obstacle with the high wing',()=>{
  const sim=makeSim(),plane=board(sim,'plane');
  const beam=sim.world.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x+4.5,2.2,z+2.5));
  sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(0.1,0.1,0.1).setCollisionGroups(groups(GROUP.static,GROUP.all)),beam);
  sim.world.physics.step();sim.world.markStepped();
  for(let i=0;i<180&&!plane.crashed;i++)sim.step({...NEUTRAL,moveX:1});
  assert.equal(plane.crashed,true);assert.equal(plane.body.isDynamic(),true);
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
    for(let i=0;i<900;i++){
      sim.step({...NEUTRAL,moveX:1});
      assert.equal(plane.crashed,false,`stationary graded-runway turn grade ${grade}, tick ${i}: ${JSON.stringify(plane.state())}`);
    }
    assert.equal(plane.grounded,true);assert.equal(plane.speed,0);assert.equal(plane.health,1);
    assert.equal(plane.recover(),true);
    advance(sim,240,{moveZ:1,buttons:Button.ascend});
    assert.ok(plane.position[1]-height(plane.position[0],plane.position[2])>8,`takeoff on grade ${grade}: ${JSON.stringify(plane.state())}`);
    assert.ok(Math.hypot(plane.position[0]-x,plane.position[2]-z)>20);
    advance(sim,700,{moveZ:-1,buttons:Button.descend});
    assert.equal(plane.grounded,true,`landed on grade ${grade}`);assert.ok(Math.abs(plane.speed)<2);
    sim.step({...NEUTRAL,buttons:Button.interact});assert.equal(sim.mode,'onFoot',`grounded exit on grade ${grade}: ${JSON.stringify(plane.state())}`);
    assert.ok(Math.abs(sim.player.position[1]-height(sim.player.position[0],sim.player.position[2]))<0.05);
  }
});
