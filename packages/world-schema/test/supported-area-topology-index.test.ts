import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateSupportedArea, type SupportedArea, type Vec2} from '../src/index.ts';
import {validateSupportedArea as brute} from './fixtures/supported-area-brute-reference.ts';
const rectangle = (x: number, z: number, width: number, height: number): Vec2[] => [[x,z],[x+width,z],[x+width,z+height],[x,z+height]];
const area = {minX: -2_000_000, minZ: -2_000_000, maxX: 2_000_000, maxZ: 2_000_000};
test('indexed exact topology agrees with frozen brute predicates across random contacts and slivers', () => {
  let seed = 0x82df7132; const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 360; trial++) {
    const scale = [1, .00001, 10000][trial % 3]!, offset = trial % 4 ? 0 : 1_000_000;
    const transform = (r: Vec2[]): Vec2[] => r.map(([x,z]) => [x*scale+offset,z*scale+offset]);
    const holes: Vec2[][] = [];
    for (let i = 0; i < 4; i++) {const x = Math.round(random()*14)-7, z = Math.round(random()*14)-7, width = .2+random()*5, height = .2+random()*5; holes.push(rectangle(x,z,width,height));}
    if (trial % 6 === 0) holes[1] = rectangle(holes[0]![2]![0], holes[0]![2]![1], 2, 2);
    if (trial % 6 === 1) holes[1] = rectangle(holes[0]![1]![0], holes[0]![1]![1], 2, 2);
    if (trial % 6 === 2) holes[1] = [[0,0],[1,1e-13],[2,0]];
    const mask: SupportedArea = {schemaVersion: 1, regions: [{id:'random',outer:transform(rectangle(-10,-10,20,20)),holes:holes.map(transform)}]};
    assert.equal(validateSupportedArea(mask,area).length === 0, brute(mask,area).length === 0, `trial ${trial}`);
  }
});
test('exact contact partitioning and concave containment retain brute behavior after indexing', () => {
  const outer: Vec2[] = [[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6]];
  for (const holes of [
    [[[2,2],[4,6],[2,6]]],
    [[[0,1],[1,.5],[1,1.5]]],
    [rectangle(.5,.5,1,1),rectangle(1.5,1.5,1,1)],
    [[[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6]],[[2,2],[4,6],[6,0]]],
  ] as Vec2[][][]) {const mask: SupportedArea = {schemaVersion:1,regions:[{id:'contact',outer,holes}]}; assert.equal(validateSupportedArea(mask,area).length===0,brute(mask,area).length===0);}
});
test('validation indexes do not survive caller mutation and malformed retries', () => {
  const mask: SupportedArea = {schemaVersion:1,regions:[{id:'mutable',outer:rectangle(0,0,10,10),holes:[rectangle(1,1,1,1)]}]};
  assert.deepEqual(validateSupportedArea(mask,area),[]);
  (mask.regions[0]!.holes![0] as Vec2[])[0] = [-1,1];
  assert.ok(validateSupportedArea(mask,area).length);
  (mask.regions[0]!.holes![0] as Vec2[])[0] = [1,1];
  assert.deepEqual(validateSupportedArea(mask,area),[]);
});
test('adversarial valid comb geometry reaches explicit bounded-work rejection before unbounded scans', () => {
  const count = 700, outer: Vec2[] = [[0,0],[count*4,0],[count*4,10]], holes: Vec2[][] = [];
  for(let i=count-1;i>=0;i--) {outer.push([i*4+3,10],[i*4+3,2],[i*4+1,2],[i*4+1,10],[i*4,10]);holes.push(rectangle(i*4+.2,8,.6,1));}
  const mask: SupportedArea = {schemaVersion:1,regions:[{id:'comb',outer,holes}]};
  assert.deepEqual(validateSupportedArea(mask,area),['supportedArea topology exceeds the bounded validation work limit']);
});
