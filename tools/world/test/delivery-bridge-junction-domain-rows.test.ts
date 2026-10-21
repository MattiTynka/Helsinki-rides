import test from 'node:test';
import assert from 'node:assert/strict';
import {buildJunctionDomainRows} from '../lib/delivery-bridge-junction-domain-rows.ts';
import {auditJunctionDomainFaces} from '../lib/delivery-bridge-junction-domain-audit.ts';
import {junctionFaceSha} from '../lib/delivery-bridge-junction-mouths.ts';
import type {JunctionBankKnot,JunctionTravelProfile} from '../lib/delivery-bridge-junction-profile.ts';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
function bank(x:number,y:number):JunctionBankKnot[]{const plane:readonly[Vec3,Vec3,Vec3]=[[x-1,y-.2,-2],[x+1,y-.2,-2],[x,y+.2,2]];return[-2,-.5,0,.5,2].map(offset=>({offset,point:[x,y+offset*.1,offset],plane,source:{cell:'native',collider:'upper',triangle:0,orderedFloat32Sha256:junctionFaceSha(plane)}}));}
const profile:JunctionTravelProfile={id:'source-domain',sourceWayIds:[1],centres:[{sourceNode:1,x:0,z:0},{sourceNode:2,x:30,z:0}],inner:bank(0,3),outer:bank(30,0),normalSigns:[1,1],velocityRampFraction:.1,maximumLongitudinalGrade:.15,transverseInterpolation:'physical-source-offset',nonAreaBankIntervals:[{bank:'outer',left:-.5,right:.5,reason:'SOURCE_MEDIAN_NO_FLOOR_AUTHORITY'}]};
test('physical-offset rows retain literal bank heights and all positive source area without filling a median',()=>{
 const result=buildJunctionDomainRows(profile,[[[[0,-2],[30,-2],[30,-.5],[0,-.5],[0,-2]]],[[[0,.5],[30,.5],[30,2],[0,2],[0,.5]]]]);
 assert.equal(result.proof.encodedPositiveArea,90);assert.equal(result.proof.emittedPositiveArea,90);assert.equal(result.proof.rows,61);assert.ok(result.proof.emittedGrade.maximumConservativeLongitudinalGrade<.112);
 for(const face of result.faces){assert.ok(face.points.every(p=>p[2]<=-.5)||face.points.every(p=>p[2]>=.5));for(const p of face.points)if(p[0]===0||p[0]===30)assert.ok(Math.abs(p[1]-((p[0]===0?3:0)+p[2]*.1))<1e-6);}
});
test('an unrelated width-sampling lattice cannot add physical-offset rows and an actual steep emitted plane fails',()=>{
 const widths=Array.from({length:301},(_,i)=>({atMetres:i/10,left:-2,right:2,sourcePartIds:[1]})),result=buildJunctionDomainRows({...profile,widths},[[[[0,-2],[30,-2],[30,2],[0,2],[0,-2]]]]);assert.equal(result.proof.rows,61);
 assert.throws(()=>auditJunctionDomainFaces(profile,[{points:[[0,0,0],[1,.2,0],[0,0,1]],uvs:[[0,0],[1,0],[0,1]],role:'road',material:'asphalt',collision:true}]),/NEW longitudinal limit/);
});
