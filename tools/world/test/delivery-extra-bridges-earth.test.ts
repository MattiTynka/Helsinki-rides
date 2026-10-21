import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildExtraBridgeEarth,type ExtraBridgeEarthRecovery} from '../lib/delivery-extra-bridges-earth.ts';
import type {ExtraBridgeNativeFace} from '../lib/delivery-extra-bridges-source.ts';
import type {SupportTriangle} from '../lib/tram-support-repair.ts';
import {supportNormal} from '../lib/tram-support-repair.ts';
const triangle=(a:number[],b:number[],c:number[])=>[a,b,c]as SupportTriangle;
const source=(height=0):ExtraBridgeEarthRecovery=>({schemaVersion:1,kind:'native-omitted-silta-fallback-source-v1',partIds:[10],source:{nativeMetadataSha256:'1'.repeat(64),replaySha256:'2'.repeat(64),originalStreetPartsSha256:'3'.repeat(64),sourceTerrainSha256:'4'.repeat(64),frozenProducer:{'ground.ts':'5'.repeat(64)},shadowChangedSubtypesOnly:true},triangles:[triangle([0,height,0],[4,height,0],[4,height,4]),triangle([0,height,0],[4,height,4],[0,height,4])]});
const rectangle=(x0:number,x1:number,z0:number,z1:number,y0:number,y1:number):ExtraBridgeNativeFace[]=>[triangle([x0,y0,z0],[x1,y0,z0],[x1,y1,z1]),triangle([x0,y0,z0],[x1,y1,z1],[x0,y1,z1])].map((points,i)=>({points,cell:'native',collider:'ground',triangle:i,tag:'raised:yard',group:'ground'}));
const footprints=[{id:10,rings:[[[0,0],[4,0],[4,4],[0,4]]]as[number,number][][]}];
const upperFloors=[triangle([0,5,0],[4,5,0],[4,5,4]),triangle([0,5,0],[4,5,4],[0,5,4])];
test('omitted fallback binds every native boundary knot without filling or mutating the lower street',()=>{
  const retained=[...rectangle(0,1,0,2,0,1),...rectangle(0,1,2,4,1,0),...rectangle(3,4,0,4,0,0),...rectangle(1.8,2.2,0,4,-.5,-.5)],before=structuredClone(retained),result=buildExtraBridgeEarth({source:source(),footprints,retained,upperFloors});
  assert.deepEqual(retained,before);assert.ok(result.proof.maximumC0ErrorMetres<1e-6);assert.ok(result.proof.boundaryIntervals.some(q=>q.a[0]===1&&q.a[1]===1&&q.a[2]===2));
  assert.ok(result.proof.verticalReturns.length>0,'Different actual native edge levels need a closed side return');for(const r of result.proof.verticalReturns){const n=supportNormal(r.points),x=r.points.reduce((n,p)=>n+p[0],0)/3,z=r.points.reduce((n,p)=>n+p[2],0)/3;assert.ok(n[0]*(r.lowerSide[0]-x)+n[2]*(r.lowerSide[1]-z)>0,'Bank exterior winding must face the lower adjacent fan');}
  for(const f of result.faces){const x=f.points.reduce((n,p)=>n+p[0],0)/3;assert.ok(x>=1-1e-6&&x<=3+1e-6);assert.ok(x<1.8+1e-6||x>2.2-1e-6,'Existing lower corridor is protected by footprint, not a height guess');assert.equal(f.collision,true);}
  assert.ok(Math.abs(result.proof.recoveredArea-6.4)<1e-6);
});
test('unqualified source identities and source-high deck remnants fail instead of becoming earth',()=>{
  const retained=[...rectangle(0,1,0,4,0,0),...rectangle(3,4,0,4,0,0)];
  assert.throws(()=>buildExtraBridgeEarth({source:{...source(),partIds:[11]},footprints,retained,upperFloors}),/deep-equal/);
  assert.throws(()=>buildExtraBridgeEarth({source:source(8),footprints,retained,upperFloors}),/protrudes/);
  const broken=source();broken.source.sourceTerrainSha256='unverified';assert.throws(()=>buildExtraBridgeEarth({source:broken,footprints,retained,upperFloors}),/regular expression/);
});
