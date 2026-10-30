import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {GameplayBundle,RoadGraph} from '@helsinki/world-schema';
import {initPhysics,StaticWorld,Vehicle} from '../src/index.ts';
import {interpolateVehicleCoveragePose,supportedVehicleMotionFraction,supportsVehiclePose,supportsVehicleTransition,vehicleCoverageFootprint,vehicleCoverageRadius,type VehicleCoveragePose} from '../src/coverage-footprint.ts';

before(async()=>{await initPhysics();});
const original=JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/central-expansion/gameplay.json',import.meta.url),'utf8'));
const def=original.vehicleDefinitions.find((v:{id:string})=>v.id==='lumi-gt');
const roads:RoadGraph={schemaVersion:2,originId:'test',source:{id:'test',sha256:'test',attribution:'test',license:'test'},nodes:[],lanes:[],connectors:[],parking:[],footways:[]};
function rig(){
  const gameplay:GameplayBundle={...original,originId:'test',addresses:[],playArea:{minX:-1300,minZ:700,maxX:-1000,maxZ:900},
    supportedArea:{schemaVersion:1,regions:[{id:'public-street',outer:[[-1300,700],[-1000,700],[-1000,900],[-1300,900]],
      holes:[[[-1145.3627000004053,782.4801998399198],[-1124.4544444218543,768],[-1124.4544583344923,768]]]}]}};
  const world=new StaticWorld({x0:-1300,z0:700,resolution:100,nx:4,nz:3,heights:new Float32Array(12)},roads,gameplay);
  return {world,vehicle:new Vehicle(world,'test-car',def,[-1200,0,800],0)};
}
const setPose=(v:Vehicle,p:VehicleCoveragePose)=>{
  v.body.setTranslation({x:p.position[0],y:p.position[1],z:p.position[2]},true);
  v.body.setRotation({x:p.rotation[0],y:p.rotation[1],z:p.rotation[2],w:p.rotation[3]},true);
  v.steerAngle=p.steerAngle??0;
};

test('real Bulevardi tangential clamp certifies actual Float32 readback instead of recovering on supported ground',()=>{
  // Exact pre/proposed poses from recorded tick11423, worldb0ca22a6 and replay02e7aeb6.
  // Only the one offending municipal partition triangle is needed to reproduce it.
  const prior:VehicleCoveragePose={position:[-1142.359130859375,-2.4465463161468506,782.1156616210938],
    rotation:[.038769081234931946,-.5412535667419434,-.007446760311722755,.8399322032928467],steerAngle:-.013723560740557191};
  const proposed:VehicleCoveragePose={position:[-1142.3585205078125,-2.452289581298828,782.1151733398438],
    rotation:[.03877556324005127,-.5412459373474121,-.007351158186793327,.839937686920166],steerAngle:.027000788472643828};
  const {world,vehicle}=rig();
  try{
    assert.equal(supportsVehiclePose(world.gameplay,def,prior.position,prior.rotation,prior.steerAngle),true);
    setPose(vehicle,proposed);const after=vehicle.coveragePose;
    const fraction=supportedVehicleMotionFraction(world.gameplay,def,prior,after);
    assert.ok(fraction>0&&fraction<1);
    const intended=interpolateVehicleCoveragePose(prior,after,fraction);
    assert.equal(supportsVehiclePose(world.gameplay,def,intended.position,intended.rotation,intended.steerAngle),true);
    setPose(vehicle,{...intended,position:[intended.position[0],after.position[1],intended.position[2]]});
    assert.equal(vehicle.supportedByCoverage(world),false,'negative control: the former double-only admission rounds outside');
    setPose(vehicle,proposed);vehicle.body.setLinvel({x:2,y:-1,z:3},true);vehicle.body.setAngvel({x:.1,y:.2,z:.3},true);
    vehicle.constrainToSupportedArea(world,prior);
    assert.equal(vehicle.supportedByCoverage(world),true);
    assert.equal(supportsVehicleTransition(world.gameplay,def,prior,vehicle.coveragePose),true);
    assert.equal(vehicle.position[1],proposed.position[1],'coverage clamp keeps physical vertical motion');
    assert.deepEqual(vehicle.velocity,[0,-1,0]);
    const angular=vehicle.body.angvel();assert.deepEqual([angular.x,angular.y,angular.z],[0,0,0]);
  }finally{world.physics.free();}
});

test('an ordinary admitted move keeps its applied pose, steering and velocities',()=>{
  const {world,vehicle}=rig();
  try{
    const prior=vehicle.coveragePose;
    setPose(vehicle,{position:[-1199,0,801],rotation:[0,0,0,1],steerAngle:.03});
    vehicle.body.setLinvel({x:2,y:0,z:3},true);
    const applied=vehicle.coveragePose,velocity=vehicle.velocity;
    vehicle.constrainToSupportedArea(world,prior);
    assert.deepEqual(vehicle.coveragePose,applied);assert.deepEqual(vehicle.velocity,velocity);
  }finally{world.physics.free();}
});

const priorRotation=[.028834694996476173,.9594449400901794,.009271333925426006,-.28026455640792847] as const;
const renormalizedRotation=[.028834691271185875,.9594448208808899,.009271332994103432,-.2802645266056061] as const;
function precisionRig(x:number,z:number,tight=false,rectangleBoundary=false){
  const pose={position:[x,0,z] as const,rotation:priorRotation,steerAngle:0};
  const first=vehicleCoverageFootprint(def,pose),second=vehicleCoverageFootprint(def,{...pose,rotation:renormalizedRotation});
  const left=(Math.min(...first.map(p=>p[0]))+Math.min(...second.map(p=>p[0])))/2-.1;
  const minX=tight?Math.min(...first.map(p=>p[0]))-.1-2e-9:left,maxX=tight?Math.max(...first.map(p=>p[0]))+.1+2e-9:x+100;
  const area={minX,minZ:z-100,maxX,maxZ:z+100};
  const gameplay:GameplayBundle={...original,originId:'test',addresses:[],playArea:tight||rectangleBoundary?area:{minX:x-100,minZ:z-100,maxX:x+100,maxZ:z+100},
    supportedArea:{schemaVersion:1,regions:[{id:'precision-boundary',outer:[[minX,z-100],[maxX,z-100],[maxX,z+100],[minX,z+100]]}]}};
  const world=new StaticWorld({x0:x-100,z0:z-100,resolution:200,nx:2,nz:2,heights:new Float32Array(4)},roads,gameplay);
  const vehicle=new Vehicle(world,'precision-car',def,[x,0,z],0);
  const i=5,raw=[.05*Math.sin(i*.123),Math.sin(i*.371),.05*Math.sin(i*.591),Math.cos(i*.371)],length=Math.hypot(...raw);
  const restoreOriginal=()=>vehicle.body.setRotation({x:raw[0]!/length,y:raw[1]!/length,z:raw[2]!/length,w:raw[3]!/length},true);
  restoreOriginal();assert.deepEqual(vehicle.rotation,priorRotation);
  return{world,vehicle,restoreOriginal};
}

for(const changedRotation of [false,true])test(`zero-fraction fallback certifies ${changedRotation?'changed':'unchanged'} physical rotation`,()=>{
  const{world,vehicle,restoreOriginal}=precisionRig(-1142,782);
  try{
    const before=vehicle.coveragePose;
    assert.equal(vehicle.supportedByCoverage(world),true);
    setPose(vehicle,before);
    assert.deepEqual(vehicle.rotation,renormalizedRotation);
    assert.equal(vehicle.supportedByCoverage(world),false,'negative control: blindly restoring the prior quaternion changes its footprint');
    restoreOriginal();vehicle.body.setTranslation({x:-1142.0001220703125,y:-.025,z:782},true);
    if(changedRotation)vehicle.body.setRotation({x:before.rotation[0]+.000001,y:before.rotation[1],z:before.rotation[2],w:before.rotation[3]},true);
    const after=vehicle.coveragePose;assert.equal(supportedVehicleMotionFraction(world.gameplay,def,before,after),0);
    let rotationWrites=0,translationWrites=0;
    const setRotation=vehicle.body.setRotation.bind(vehicle.body),setTranslation=vehicle.body.setTranslation.bind(vehicle.body);
    vehicle.body.setRotation=(...args)=>{rotationWrites++;setRotation(...args);};
    vehicle.body.setTranslation=(...args)=>{translationWrites++;setTranslation(...args);};
    vehicle.body.setLinvel({x:2,y:-1,z:3},true);
    vehicle.constrainToSupportedArea(world,before);
    assert.equal(vehicle.supportedByCoverage(world),true);
    assert.equal(supportsVehicleTransition(world.gameplay,def,before,vehicle.coveragePose),true);
    assert.equal(vehicle.position[1],after.position[1]);assert.equal(vehicle.steerAngle,before.steerAngle);
    assert.deepEqual(vehicle.velocity,[0,-1,0]);assert.ok(translationWrites<=314,'at most25 prefix attempts and288 precision candidates');
    if(!changedRotation){assert.equal(rotationWrites,0);assert.deepEqual(vehicle.rotation,before.rotation);assert.equal(vehicle.position[0],before.position[0]);}
    else{assert.ok(rotationWrites>0);assert.ok(vehicle.position[0]>before.position[0]);assert.ok(Math.abs(vehicle.position[0]-before.position[0])<=8*.0001220703125);}
  }finally{world.physics.free();}
});

test('precision retreat uses body-scale Float32 resolution at the coordinate origin',()=>{
  const{world,vehicle}=precisionRig(0,0,false,true);
  try{
    const before=vehicle.coveragePose;
    assert.equal(vehicle.supportedByCoverage(world),true);
    vehicle.body.setTranslation({x:-.00001,y:-.025,z:0},true);
    vehicle.body.setRotation({x:before.rotation[0]+.000001,y:before.rotation[1],z:before.rotation[2],w:before.rotation[3]},true);
    assert.equal(supportedVehicleMotionFraction(world.gameplay,def,before,vehicle.coveragePose),0);
    vehicle.constrainToSupportedArea(world,before);
    const quantum=2**(Math.floor(Math.log2(vehicleCoverageRadius(def)))-23);
    assert.equal(vehicle.supportedByCoverage(world),true);assert.equal(supportsVehicleTransition(world.gameplay,def,before,vehicle.coveragePose),true);
    assert.ok(Math.hypot(vehicle.position[0],vehicle.position[2])<=8*Math.SQRT2*quantum);
  }finally{world.physics.free();}
});

test('unrepresentable prior orientation fails closed after a bounded search',()=>{
  const{world,vehicle}=precisionRig(0,0,true);
  try{
    const before=vehicle.coveragePose;assert.equal(vehicle.supportedByCoverage(world),true);
    vehicle.body.setTranslation({x:-.000001,y:0,z:0},true);
    vehicle.body.setRotation({x:before.rotation[0]+.000001,y:before.rotation[1],z:before.rotation[2],w:before.rotation[3]},true);
    let writes=0;const setter=vehicle.body.setTranslation.bind(vehicle.body);vehicle.body.setTranslation=(...args)=>{writes++;setter(...args);};
    assert.throws(()=>vehicle.constrainToSupportedArea(world,before),/bounded Float32 precision retreat/);
    assert.ok(writes<=314);assert.equal(vehicle.supportedByCoverage(world),false);
  }finally{world.physics.free();}
});
