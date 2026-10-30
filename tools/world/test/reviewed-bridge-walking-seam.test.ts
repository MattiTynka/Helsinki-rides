import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readBridgeWalkingSeamProfile, qualifyBridgeWalkingSeamGeometry, reviewedBridgeWalkingSeamFaces, type ReviewedBridgeWalkingSeam} from '../lib/reviewed-bridge-walking-seam.ts';
const seam = fs.readFileSync(new URL('../../../content/helsinki/southwest-20261029/ruoholahti-east-walk-seam.json', import.meta.url));
const base = fs.readFileSync(new URL('../../../content/helsinki/southwest-20261029/ruoholahti-bridge.json', import.meta.url));
const fixture = () => ({profile: readBridgeWalkingSeamProfile(seam, base), base: JSON.parse(base.toString())});
test('reviewed literal sixty-face walking seam retains complete native affine certificates', () => {
  const f = fixture(), before = structuredClone(f), proof = qualifyBridgeWalkingSeamGeometry(f.profile, f.base, structuredClone(f.profile.literalFlanks));
  assert.equal(proof.continuous.length, 60); assert.ok(proof.maximumDistance < .000224);
  assert.ok(proof.maximumHeightError < .0000014); assert.ok(proof.minimumNormal > .9978); assert.deepEqual(f, before);
});
test('rehashing different geometry, level or parent does not grant a walking seam profile', () => {
  for (const mutate of [(p: any) => p.role = 'upperRoad', (p: any) => p.faces[0].points[0][1] += .01, (p: any) => p.faces.pop()]) {
    const p = JSON.parse(seam.toString()); mutate(p); assert.throws(() => readBridgeWalkingSeamProfile(Buffer.from(JSON.stringify(p)), base), /Unapproved/);
  }
  assert.throws(() => readBridgeWalkingSeamProfile(seam, Buffer.from(base.toString() + ' ')), /parent profile changed/);
});
test('stale or missing literal upper floors fail before any role authority is issued', () => {
  const f = fixture(), stale = structuredClone(f.profile.literalFlanks); stale[0]!.points[0][1] += .01;
  assert.throws(() => qualifyBridgeWalkingSeamGeometry(f.profile, f.base, stale), /flank changed/);
  assert.throws(() => qualifyBridgeWalkingSeamGeometry(f.profile, f.base, f.profile.literalFlanks.slice(1)), /flank changed/);
});
test('geometry certificate rejects displaced proposed floors and synthetic authority objects', () => {
  const f = fixture(); f.profile.faces[0]!.points[0][1] += .1;
  assert.throws(() => qualifyBridgeWalkingSeamGeometry(f.profile, f.base, f.profile.literalFlanks));
  assert.throws(() => reviewedBridgeWalkingSeamFaces({} as ReviewedBridgeWalkingSeam), /opaque/);
});
