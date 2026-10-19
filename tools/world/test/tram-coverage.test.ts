import {test} from 'node:test';
import assert from 'node:assert/strict';
import {certifyTramCoverageFringes} from '../lib/tram-coverage.ts';
import type {TramGroundTriangle} from '../lib/tram-visuals.ts';
function source():TramGroundTriangle[]{const out:TramGroundTriangle[]=[];for(let i=0;i<10;i++)for(const vertices of [[[i,0,0],[i+1,0,1],[i+1,0,0]],[[i,0,0],[i,0,1],[i+1,0,1]]])out.push({id:String(out.length),vertices:vertices as TramGroundTriangle['vertices'],visual:{node:'ground',primitive:0,triangle:out.length},collision:{collider:'g',triangles:[out.length]},tag:'road'});return out;}
test('a complete micron fringe crossing many exact ground faces has a whole-polygon coverage certificate',()=>{
 const proof=certifyTramCoverageFringes([[[[0,.5],[10,.5],[10,.500001],[0,.500001],[0,.5]]]],source())[0]!;assert.equal(proof.qualified,true);assert.ok(proof.maximumDistanceToGroundUpperBound<1e-12);assert.ok(proof.maximumPieceWidth<=proof.allowedDistance);
});
test('a centimetre-width missing visual ribbon cannot be waived merely because ground exists below it',()=>{
 const proof=certifyTramCoverageFringes([[[[0,.5],[10,.5],[10,.55],[0,.55],[0,.5]]]],source())[0]!;assert.ok(proof.maximumDistanceToGroundUpperBound<1e-12);assert.equal(proof.qualified,false);
});
