import test from 'node:test';
import assert from 'node:assert/strict';
import {correctMeasuredGroundVertices, type MeasuredGroundCorrectionOptions} from '../lib/measured-ground-correction.ts';
import type {GroundPiece} from '../lib/ground.ts';
const piece = (tag = 'road:asphalt', y = -1): GroundPiece => ({cell: 'c_p00_p00', finish: 'asphalt', level: tag.startsWith('road:') ? 'road' : 'raised', tag, positions: [2,y,2,4,y,2,2,y,4], indices: [0,1,2], uvs: [0,0,1,0,0,1]});
const options = (): MeasuredGroundCorrectionOptions => ({patchRegion: [0,0,8,8], correctionRegion: [1,1,5,5], maximumCorrectionMetres: 1.5, sourceAt: () => ({height: 0, anchor: 'road', sourceTriangleIds: [42], sourcePartIds: ['58981']})});
test('moves coincident public floor, raised edge and existing underlay by one measured delta', () => {
  const original = {pieces: [piece(),piece('raised:asphalt',-.88),piece('raised:yard',-1.03)], kerbs: [piece('curb',-.94)]};
  original.pieces[1]!.positions[0] = 2 + 1e-10;
  const before = structuredClone(original), result = correctMeasuredGroundVertices(original, options());
  assert.deepEqual(original,before); assert.equal(result.witnesses.length,3); assert.equal(result.affectedTriangles,4);
  assert.ok(Math.abs(result.pieces[1]!.positions[1]!-.12)<1e-12); assert.ok(Math.abs(result.pieces[2]!.positions[1]!+.03)<1e-12);
  assert.deepEqual(result.pieces[0]!.indices, before.pieces[0]!.indices); assert.deepEqual(result.pieces[0]!.uvs, before.pieces[0]!.uvs);
});
test('does not alter unreviewed geometry or create a missing road floor', () => {
  const p = piece(), o = options(); o.sourceAt = (x,z) => x===2&&z===2 ? {height:0,anchor:'road',sourceTriangleIds:[42],sourcePartIds:['58981']} : null;
  const result = correctMeasuredGroundVertices({pieces:[p],kerbs:[]},o); assert.deepEqual(result.pieces[0]!.positions,[2,0,2,4,-1,2,2,-1,4]);
  assert.throws(()=>correctMeasuredGroundVertices({pieces:[piece('raised:yard')],kerbs:[]},options()),/No native road/);
});
test('rejects another level, an unbounded correction, or altered exterior boundary', () => {
  assert.throws(()=>correctMeasuredGroundVertices({pieces:[piece(),piece('road:asphalt',1)],kerbs:[]},options()),/distinct physical levels/);
  const o=options();o.maximumCorrectionMetres=.5;assert.throws(()=>correctMeasuredGroundVertices({pieces:[piece()],kerbs:[]},o),/explicit bound/);
  const p=piece();p.positions[3]=12;assert.throws(()=>correctMeasuredGroundVertices({pieces:[p],kerbs:[]},options()),/crosses preserved patch boundary/);
});
test('an explicit border transition preserves the original boundary exactly', () => {
  const p={...piece(),positions:[1,-1,2,1.5,-1,2,3,-1,3]};const o=options();o.boundaryBlendMetres=1;
  const result=correctMeasuredGroundVertices({pieces:[p],kerbs:[]},o);
  assert.equal(result.pieces[0]!.positions[1],-1);assert.equal(result.pieces[0]!.positions[4],-.5);assert.equal(result.pieces[0]!.positions[7],0);
  assert.deepEqual(result.witnesses.map(w=>w.blendWeight),[.5,1]);
});
test('calibrated source agreement preserves an already matching height', () => {
  const p=piece();p.positions[1]=-.04;const o=options();o.sourceAgreementMetres=.075;
  const result=correctMeasuredGroundVertices({pieces:[p],kerbs:[]},o);
  assert.equal(result.pieces[0]!.positions[1],-.04);assert.ok(Math.abs(result.pieces[0]!.positions[4]!+.075)<1e-12);
  assert.equal(result.witnesses.length,2);
});
