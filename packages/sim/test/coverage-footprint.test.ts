import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsSupportedArea, type GameplayBundle, type Vec2 } from '@helsinki/world-schema';
import { supportsVehiclePose, supportsVehicleTransition, supportedVehicleMotionFraction, vehicleCoverageFootprint, vehicleCoverageRadius, interpolateVehicleCoveragePose, type VehicleCoverageDefinition, type VehicleCoveragePose } from '../src/coverage-footprint.ts';
import { quatYaw, quatMul, rotate, type Quat, type V3 } from '../src/math.ts';

const car: VehicleCoverageDefinition = { collider: { centre: [0,1,0], halfExtents: [.8,.6,2], skid: {centre:[0,.4,0],halfExtents:[.7,.3,1]} },
  wheelRadius:.3,wheelWidth:.3,suspension:{restLength:.4,maxTravel:.3,stiffness:32,compression:4,damping:4},
  wheels:[-1,1].flatMap(x=>[-1,1].map(z=>({position:[x*.8,.3,z*1.4] as V3,steer:z===1,drive:z===-1,handbrake:z===-1,socket:`${x}/${z}`}))) };
const pose=(x=0,z=0,yaw=0):VehicleCoveragePose=>({position:[x,0,z],rotation:quatYaw(yaw)});
function land(halfWidth=20,holes:Vec2[][]=[]):Pick<GameplayBundle,'playArea'|'supportedArea'>{return {playArea:{minX:-20,minZ:-20,maxX:20,maxZ:20},supportedArea:{schemaVersion:1,regions:[{id:'land',outer:[[-halfWidth,-20],[halfWidth,-20],[halfWidth,20],[-halfWidth,20]],holes}]}};}
const square=(x:number,z:number,r=.005):Vec2[]=>[[x-r,z-r],[x+r,z-r],[x+r,z+r],[x-r,z+r]];
test('upright oriented car fits a narrow road that its circumcircle rejects, with all directions using the same guard',()=>{
  const coverage=land(1.1),a=pose(0,-8),b=pose(0,8);
  assert.equal(containsSupportedArea(coverage,0,0,vehicleCoverageRadius(car)),false);
  assert.equal(supportsVehiclePose(coverage,car,a.position,a.rotation),true);
  assert.equal(supportsVehicleTransition(coverage,car,a,b),true);
  assert.equal(supportsVehiclePose(coverage,car,[0,0,0],quatYaw(Math.PI/2)),false);
  assert.equal(supportsVehiclePose(coverage,car,[.051,0,0],quatYaw(0)),false,'full tyre plus 10 cm clearance reaches the edge');
});
test('safe translated endpoints cannot bridge a thin canal, and tiny holes fully inside a body reject',()=>{
  const coverage=land(20,[[[-.01,-20],[.01,-20],[.01,20],[-.01,20]]]),a=pose(-6),b=pose(6);
  assert.equal(supportsVehiclePose(coverage,car,a.position,a.rotation),true);
  assert.equal(supportsVehiclePose(coverage,car,b.position,b.rotation),true);
  assert.equal(supportsVehicleTransition(coverage,car,a,b),false);
  const f=supportedVehicleMotionFraction(coverage,car,a,b),stop=interpolateVehicleCoveragePose(a,b,f);
  assert.ok(f>0&&f<.42);assert.equal(supportsVehicleTransition(coverage,car,a,stop),true);
  assert.equal(supportsVehiclePose(land(20,[square(0,0)]),car,[0,0,0],quatYaw(0)),false);
});
test('translation plus rotation rejects a swept wing over a hole even when both endpoint footprints fit',()=>{
  const coverage=land(20,[square(1.5,.8)]),a=pose(),b=pose(.2,0,Math.PI);
  assert.equal(supportsVehiclePose(coverage,car,a.position,a.rotation),true);assert.equal(supportsVehiclePose(coverage,car,b.position,b.rotation),true);
  assert.equal(supportsVehicleTransition(coverage,car,a,b),false);
  const narrow=land(1.1);assert.equal(supportsVehicleTransition(narrow,car,pose(),pose(0,0,Math.PI)),false,'180 degree turn swings broadside between identical endpoint footprints');
  assert.equal(supportsVehicleTransition(land(),car,a,b),true,'safe rotation is not rejected merely because it turns');
});
test('roll, pitch, tyres, skid and suspension extremes remain enclosed by the projected hull',()=>{
  const q=quatMul(quatYaw(.73),quatMul([Math.sin(.4),0,0,Math.cos(.4)],[0,0,Math.sin(.6),Math.cos(.6)])),p:VehicleCoveragePose={position:[2,3,4],rotation:q,steerAngle:.6};
  const polygon=vehicleCoverageFootprint(car,p),inside=(point:V3)=>{const r=rotate(q,point),x=p.position[0]+r[0],z=p.position[2]+r[2];return polygon.every((a,i)=>{const b=polygon[(i+1)%polygon.length]!;return(b[0]-a[0])*(z-a[1])-(b[1]-a[1])*(x-a[0])>=-1e-10;});};
  for(const box of [car.collider,car.collider.skid!])for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])assert.ok(inside([box.centre[0]+x*box.halfExtents[0],box.centre[1]+y*box.halfExtents[1],box.centre[2]+z*box.halfExtents[2]]));
  for(const wheel of car.wheels)for(const length of [car.suspension.restLength-car.suspension.maxTravel,car.suspension.restLength+car.suspension.maxTravel])for(const side of [-1,1])for(let i=0;i<64;i++){
    const theta=i*Math.PI/32,x=side*car.wheelWidth/2,z=Math.sin(theta)*car.wheelRadius,angle=wheel.steer?.6:0;
    assert.ok(inside([wheel.position[0]+x*Math.cos(angle)+z*Math.sin(angle),wheel.position[1]+car.suspension.restLength-9.81/(car.wheels.length*car.suspension.stiffness)-length+Math.cos(theta)*car.wheelRadius,wheel.position[2]+z*Math.cos(angle)-x*Math.sin(angle)]));
  }
  const rolled:Quat=[0,0,Math.SQRT1_2,Math.SQRT1_2];assert.equal(supportsVehiclePose(land(1.1),car,[0,0,0],rolled),false,'sideways chassis height projects beyond the narrow road');
  assert.equal(supportsVehicleTransition(land(1.1),car,pose(),{position:[0,0,0],rotation:[0,0,1,0]}),false,'roll sweep remains bounded when upright and inverted endpoints fit');
  assert.equal(supportsVehiclePose(land(),car,[0,0,0],[0,0,0,0]),false);
});
test('steering sweep protects curved tyre corners between safe wheel-angle endpoints',()=>{
  const thin={...car,collider:{centre:[0,.3,0] as V3,halfExtents:[.1,.1,.1] as V3}},coverage=land(1.225),a={...pose(),steerAngle:0},b={...pose(),steerAngle:Math.PI/2};
  assert.equal(supportsVehiclePose(coverage,thin,a.position,a.rotation,a.steerAngle),true);assert.equal(supportsVehiclePose(coverage,thin,b.position,b.rotation,b.steerAngle),true);
  assert.equal(supportsVehicleTransition(coverage,thin,a,b),false);
});
