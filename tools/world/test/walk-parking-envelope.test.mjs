import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parkingRouteObstacles,obstacleGrid} from '../lib/walk-parking-envelope.mjs';
import {cityParkingSlots} from '../../../packages/sim/src/parked-cars.ts';
import {fnv1a} from '../../../packages/sim/src/math.ts';
const definition=id=>({id,role:'civilian',collider:{centre:[0,.5,0],halfExtents:[1,.5,2]},wheels:[],wheelRadius:.3,wheelWidth:.2,suspension:{stiffness:1,maxTravel:.1}});
test('all potential parking slots use runtime stable definitions; mutable snapshots do not limit or identity-match them',()=>{
 const gameplay={vehicleDefinitions:[definition('a'),definition('b'),{...definition('police'),role:'police'}],vehicles:[]};
 const graph={parking:[{id:'public',heading:90,points:[[20,0,30],[40,0,30]]},{id:'unknown-heading',heading:null,points:[[0,0,0]]}],nodes:[],lanes:[]};
 const world={roads:{graph,nearestLane:()=>null,laneById:new Map()}};
 const observations=[{sha256:'1'.repeat(64),value:{vehicles:[{id:'city-car-130',driver:null,definition:'a',position:[100,0,100],rotation:[0,0,0,1]},{id:'city-car-7',driver:'npc',definition:'a',position:[200,0,100],rotation:[0,0,0,1]},{id:'police-1',driver:null,definition:'police',position:[300,0,100],rotation:[0,0,0,1]}]}}];
 const result=parkingRouteObstacles(gameplay,world,observations),slots=cityParkingSlots(graph);
 assert.equal(result.obstacles.length,3);assert.deepEqual(result.obstacles.slice(0,2).map(v=>v.id),slots.map(v=>v.id));
 for(const [i,slot]of slots.entries())assert.equal(result.obstacles[i].definition,gameplay.vehicleDefinitions[parseInt(fnv1a(slot.id),16)%2].id);
 assert.equal(result.obstacles.at(-1).id,'city-car-130');assert.equal(result.obstacles.at(-1).authority,'observed-unoccupied-civilian');
 const query=obstacleGrid(result.obstacles);assert.ok(query([18,29],[22,31],.8).some(v=>v.id==='parking:public:0'));assert.equal(query([-100,-100],[-90,-90],.8).length,0);
});
test('runtime immutable road overlap rejection is preserved',()=>{
 const gameplay={vehicleDefinitions:[definition('a')],vehicles:[]},graph={parking:[{id:'on-road',heading:0,points:[[0,0,0]]}],nodes:[],lanes:[]};
 const result=parkingRouteObstacles(gameplay,{roads:{graph,nearestLane:()=>({laneId:'lane',distance:0}),laneById:new Map([['lane',{width:3}]])}},[]);
 assert.equal(result.obstacles.length,0);assert.deepEqual(result.staticRoadRejectedSlotIds,['parking:on-road:0']);
});
