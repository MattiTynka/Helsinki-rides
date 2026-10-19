import{test}from'node:test';import assert from'node:assert/strict';
import{RoadIndex,type RoadGraph,type RoadLane,type RoadConnector,type Vec3}from'../../../packages/world-schema/src/index.ts';
import{buildDrivingRouteHints,previewDrivingRoute,DRIVING_PREVIEW_DISTANCE,DRIVING_BEND_LOOKAHEAD}from'../lib/driving-route-preview.ts';
import{keyboardDriveLookahead,keyboardDriveControl}from'../lib/keyboard-driving.ts';
function graph(points:Vec3[],connectors:RoadConnector[]=[]){const lane={id:'ordinary-lane',wayId:1,name:'Ordinary street',highway:'service',surface:'asphalt',speedLimit:10,width:3,from:'a',to:'b',points,length:40,index:0,count:1}as RoadLane;return new RoadIndex({lanes:[lane],connectors,nodes:[],parking:[],footways:[]}as unknown as RoadGraph);}
const source:Vec3[]=[[0,0,0],[0,0,20],[20,0,20]];
const dense:Vec3[]=[...Array.from({length:21},(_,z)=>[0,0,z]as Vec3),...Array.from({length:20},(_,x)=>[x+1,0,20]as Vec3)];
function connector(id:string,turn:RoadConnector['turn'],points:Vec3[],length:number):RoadConnector{return{id,node:'b',from:'ordinary-lane',to:'ordinary-lane',turn,points,length};}

test('lane-interior preview brakes before a tight bend and shortens its lookahead',()=>{
 const hints=buildDrivingRouteHints(graph(source),['ordinary-lane'],dense,10),p=previewDrivingRoute(hints,5,[0,0,5],10,10);
 assert.equal(hints.bends.length,1);assert.ok(p.maxSpeed<8&&p.maxSpeed>2.4);assert.equal(p.lookahead,DRIVING_BEND_LOOKAHEAD);
 const control=keyboardDriveControl({headingError:0,lookahead:p.lookahead,forwardSpeed:10,steerAngle:0,yawRate:0,maxSpeed:p.maxSpeed,distanceToGoal:100});assert.equal(control.throttle,-1);
});
test('straight or distant road keeps the existing10m/s controller and lookahead',()=>{
 const points:Vec3[]=[[0,0,0],[0,0,100],[100,0,100]],hints=buildDrivingRouteHints(graph(points),['ordinary-lane'],points,10),p=previewDrivingRoute(hints,0,[0,0,0],10,10);
 assert.equal(p.maxSpeed,10);assert.equal(p.lookahead,keyboardDriveLookahead(10));assert.equal(p.maneuver,false);
 assert.deepEqual(previewDrivingRoute(null,0,[0,0,0],0,10),{maxSpeed:10,lookahead:4,maneuver:false});
});
test('connector-only curvature does not become a normal interior lane bend',()=>{
 const turn=connector('junction','right',source,40),index=graph([[0,0,-10],[0,0,0]], [turn]);
 const hints=buildDrivingRouteHints(index,['junction'],dense,10);assert.equal(hints.bends.length,0);
 assert.equal(previewDrivingRoute(hints,5,[0,0,5],10,10).maxSpeed,10);
});
test('explicit short reversing maneuvers retain baseline steering throughout the preview horizon',()=>{
 const end=connector('end-turn','u-turn',[[0,0,20],[.1,0,20.3],[.1,0,20.3],[0,0,20]],.667),hints=buildDrivingRouteHints(graph(source,[end]),['ordinary-lane','end-turn'],dense,10);
 assert.equal(hints.maneuvers[0]!.radius,DRIVING_PREVIEW_DISTANCE);
 const p=previewDrivingRoute(hints,5,[0,0,5],10,10);assert.equal(p.maneuver,true);assert.equal(p.maxSpeed,10);assert.equal(p.lookahead,9);
 const args={headingError:.8,lookahead:9,forwardSpeed:8,steerAngle:.2,yawRate:0,maxSpeed:10,distanceToGoal:100};
 assert.deepEqual(keyboardDriveControl({...args,maxSpeed:p.maxSpeed,lookahead:p.lookahead}),keyboardDriveControl(args));
});
test('microconnector guard follows vehicle lookahead and does not disable a distant normal bend',()=>{
 const micro=connector('seam','straight',[[0,0,0],[0,0,.2],[0,0,0]],.4),hints=buildDrivingRouteHints(graph(source,[micro]),['seam','ordinary-lane'],dense,10);
 assert.ok(hints.maneuvers[0]!.radius>9&&hints.maneuvers[0]!.radius<12);
 assert.equal(previewDrivingRoute(hints,0,[0,0,0],10,10).maneuver,true);
 const p=previewDrivingRoute(hints,15,[0,0,15],8,10);assert.equal(p.maneuver,false);assert.equal(p.lookahead,2.5);assert.ok(p.maxSpeed<8);
});
test('hints preserve exact source/dense coordinates and ignore excluded endpoint corners',()=>{
 const original=JSON.stringify({source,dense}),hints=buildDrivingRouteHints(graph(source),['ordinary-lane'],dense,10);
 previewDrivingRoute(hints,15,[0,0,15],8,10);assert.equal(JSON.stringify({source,dense}),original);
 const clipped:Vec3[]=[[10,0,20],[20,0,20]],clippedHints=buildDrivingRouteHints(graph(source),['ordinary-lane'],clipped,10);assert.equal(clippedHints.bends.length,0);
});
