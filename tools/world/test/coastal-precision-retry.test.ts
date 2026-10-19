import assert from 'node:assert/strict';
import {test} from 'node:test';
import polygonClipping from 'polygon-clipping';
import {clipCoastalGround,CoastalClipError,type CoastalClipGeometry,type CoastalClipRetryWitness,type CoastalMask} from '../lib/coastal-mask.ts';
import {bbox,signedArea,type LocalPolygon,type Ring} from '../lib/geometry.ts';
import type {GroundPiece} from '../lib/ground.ts';

const area={minX:-10,maxX:10,minZ:-10,maxZ:10};
const polygon=(id:string,ring:Ring):LocalPolygon=>({id,rings:[ring],bbox:bbox([ring]),properties:{}});
const mask=():CoastalMask=>({area,water:[polygon('source-water',[[.000000012,-10],[10,-10],[10,10],[.000000012,10]])],sources:{coastlineWays:[42],waterWays:[],waterRelations:[]},stats:{coastlineChains:1,openChains:1,landRings:1,waterArea:200}});
const piece=():GroundPiece=>{
  const x0=-4.000000024,x1=4.000000036,y0=-4.000000018,y1=4.000000029;
  return {cell:'-1_-1',finish:'asphalt',level:'road',tag:'road:asphalt',positions:[x0,x0*.1,-y0,x1,x1*.1,-y0,x1,x1*.1,-y1,x0,x0*.1,-y1],uvs:[x0,y0,x1,y0,x1,y1,x0,y1],indices:[0,1,2,0,2,3]};
};
const geometryArea=(g:CoastalClipGeometry)=>g.reduce((n,p)=>n+Math.abs(signedArea(p[0]!))-p.slice(1).reduce((s,r)=>s+Math.abs(signedArea(r)),0),0);
const pieceArea=(p:GroundPiece)=>p.indices.reduce((sum,_id,i)=>i%3?sum:sum+Math.abs(signedArea(p.indices.slice(i,i+3).map(id=>[p.positions[id*3]!, -p.positions[id*3+2]!] as [number,number]))),0);
function checkLattice(w:CoastalClipRetryWitness){
  assert.equal(w.latticeMetres,1e-7);assert.ok(w.retryInputs);assert.ok(w.maxAxisDisplacementMetres>0&&w.maxAxisDisplacementMetres<=5.0001e-8);
  for(const g of w.retryInputs!)for(const p of g)for(const r of p)for(const xy of r)for(const v of xy)assert.ok(Math.abs(v*1e7-Math.round(v*1e7))<1e-7);
}

test('successful coastal operations keep exact coordinates, dry identity and a zero retry count',t=>{
  const original=polygonClipping.intersection,seen:CoastalClipGeometry[][]=[];
  t.mock.method(polygonClipping,'intersection',(...args:Parameters<typeof original>)=>{seen.push(structuredClone(args) as CoastalClipGeometry[]);return original(...args);});
  const source=piece(),dry={...piece(),cell:'dry',positions:[-8,1,8,-7,1,8,-7,1,7],uvs:[0,0,1,0,1,1],indices:[0,1,2]},before=structuredClone([source,dry]);
  const result=clipCoastalGround([source,dry],mask(),[],{onRetry:()=>assert.fail('successful source geometry must not retry')});
  assert.equal(result.precisionRetries,0);assert.deepEqual(result.precisionRetryWitnesses,[]);assert.equal(result.pieces.at(-1),dry);
  assert.ok(seen.some(args=>args.some(g=>g.some(p=>p.some(r=>r.some(xy=>xy[0]===.000000012))))),'the exact operands reach the library');
  assert.ok(result.pieces[0]!.positions.some((x,i)=>i%3===0&&Math.abs(x-.000000012)<1e-15),'successful output boundary was not snapped');
  assert.deepEqual([source,dry],before);
});

test('injected numeric intersection failure retries both operands and persists a replayable triangle witness first',t=>{
  const exact=polygonClipping.intersection,persisted:CoastalClipRetryWitness[]=[];let calls=0;
  t.mock.method(polygonClipping,'intersection',(...args:Parameters<typeof exact>)=>{
    if(calls++===0)throw new Error('Infinite loop when passing sweep line over endpoints (too many sweep line segments).');
    if(calls===2){assert.equal(persisted.length,1,'witness must reach persistence before the retry');assert.deepEqual(args,persisted[0]!.retryInputs);}
    return exact(...args);
  });
  const source=piece(),water=mask(),before=structuredClone({source,water});
  const result=clipCoastalGround([source],water,[],{onRetry:w=>persisted.push(w)});
  assert.equal(result.precisionRetries,1);assert.equal(persisted[0]!.status,'retrying');
  const w=result.precisionRetryWitnesses[0]!;assert.equal(w.status,'recovered');assert.equal(w.stage,'triangle-water-intersection');assert.equal(w.cell,source.cell);assert.equal(w.pieceIndex,0);assert.equal(w.triangleIndex,0);assert.equal(w.tag,source.tag);
  assert.deepEqual(w.sourceIndices,[0,1,2]);assert.deepEqual(w.trianglePositions,[[...source.positions.slice(0,3)],[...source.positions.slice(3,6)],[...source.positions.slice(6,9)]]);assert.deepEqual(w.triangleUvs,[[...source.uvs.slice(0,2)],[...source.uvs.slice(2,4)],[...source.uvs.slice(4,6)]]);
  assert.ok(w.originalError.message.includes('too many sweep line segments'));checkLattice(w);
  const replay=JSON.parse(JSON.stringify(w)) as CoastalClipRetryWitness;
  assert.ok(geometryArea(exact(replay.retryInputs![0],replay.retryInputs![1]) as CoastalClipGeometry)>0);
  assert.ok(Math.abs(result.pieces.reduce((n,p)=>n+pieceArea(p),0)-32)<2e-6,'retry cannot omit the dry half');
  for(const p of result.pieces)for(let i=0;i<p.positions.length;i+=3){assert.ok(Math.abs(p.positions[i+1]!-p.positions[i]!*.1)<1e-8);assert.ok(Math.abs(p.uvs[i/3*2]!-p.positions[i]!)<1e-8);assert.ok(Math.abs(p.uvs[i/3*2+1]!+p.positions[i+2]!)<1e-8);}
  assert.deepEqual({source,water},before);
});

test('triangle difference and water-minus-decks each use the same audited numeric fallback',t=>{
  const exact=polygonClipping.difference;let failNext=true;
  t.mock.method(polygonClipping,'difference',(...args:Parameters<typeof exact>)=>{if(failNext){failNext=false;throw new Error('Unable to find segment #123 [0, 0] -> [1, 1] in SweepLine tree.');}return exact(...args);});
  const first=clipCoastalGround([piece()],mask());assert.equal(first.precisionRetries,1);assert.equal(first.precisionRetryWitnesses[0]!.stage,'triangle-water-difference');checkLattice(first.precisionRetryWitnesses[0]!);
  failNext=true;
  const deck=polygon('source-deck',[[-1.000000013,-2],[2.000000021,-2],[2.000000021,2],[-1.000000013,2]]),before=structuredClone(deck);
  const second=clipCoastalGround([piece()],mask(),[deck]);assert.equal(second.precisionRetries,1);const w=second.precisionRetryWitnesses[0]!;
  assert.equal(w.stage,'water-minus-decks');assert.equal(w.cell,undefined);assert.deepEqual(w.deckPolygonIds,['source-deck']);assert.deepEqual(w.waterPolygonIds,['source-water']);checkLattice(w);assert.deepEqual(deck,before);
});

test('a failed lattice retry throws both errors and complete failure inputs instead of dropping geometry',t=>{
  let calls=0;const pending:CoastalClipRetryWitness[]=[];
  t.mock.method(polygonClipping,'intersection',()=>{calls++;throw new Error(calls===1?'Infinite loop when passing sweep line over endpoints (too many sweep line segments).':'Unable to complete output ring starting at [0, 0].');});
  const source=piece(),water=mask(),before=structuredClone({source,water});
  assert.throws(()=>clipCoastalGround([source],water,[],{onRetry:w=>pending.push(w)}),(e:unknown)=>{
    assert.ok(e instanceof CoastalClipError);assert.equal(e.errors.length,2);assert.equal(e.details.status,'failed');assert.equal(e.details.retryAttempted,true);assert.ok(e.details.retryError!.message.includes('output ring'));assert.equal(e.details.triangleIndex,0);assert.ok(e.details.originalInputs.length===2);checkLattice(e.details);return true;
  });
  assert.equal(calls,2);assert.equal(pending.length,1);assert.deepEqual({source,water},before);
});

test('input/programming errors retain context but do not trigger a lattice retry',t=>{
  let calls=0;
  t.mock.method(polygonClipping,'intersection',()=>{calls++;throw new TypeError('Input geometry is not a valid Polygon or MultiPolygon');});
  assert.throws(()=>clipCoastalGround([piece()],mask(),[],{onRetry:()=>assert.fail('invalid input is not numeric recovery')}),(e:unknown)=>{
    assert.ok(e instanceof CoastalClipError);assert.equal(e.errors.length,1);assert.equal(e.details.retryAttempted,false);assert.equal(e.details.status,'failed');assert.equal(e.details.retryInputs,null);assert.equal(e.details.originalError.name,'TypeError');return true;
  });assert.equal(calls,1);
});
