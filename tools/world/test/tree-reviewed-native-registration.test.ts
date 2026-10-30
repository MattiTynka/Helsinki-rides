import assert from 'node:assert/strict';
import {test} from 'node:test';
import {qualifyReviewedNativeTree, type ReviewedNativeTreeBinding} from '../lib/tree-reviewed-native-registration.ts';
import {registrationSha256 as sha, type RegistrationTree} from '../lib/tree-ground-registration.ts';
import {type TreeBarkModel, type TreeBarkProfile, type BarkTriangle} from '../lib/tree-bark-registration.ts';
import {type LocalPolygon} from '../lib/geometry.ts';

function setup() {
  const tree: RegistrationTree = {id: 'TREE_SUMMER_a2b241fc-1769-48b0-a14e-362190cdb623', model: 'tree-birch', position: [0, -.3, 0], yaw: 0, scale: [1, 1, 1], trunkRadius: .2, colliderHeight: 3};
  const model: TreeBarkModel = {root: [[-.2, 0, 0], [.2, 0, 0], [0, 0, .2]], triangles: [[[-.2, 0, 0], [.2, 0, 0], [.2, 4, 0]], [[-.2, 0, 0], [.2, 4, 0], [-.2, 4, 0]]]};
  const support = {height: 0, group: 'ground', tag: 'raised:grass', collider: 'g:c', cell: 'c'};
  const body = {rootPoints: [[0, 0]] as [number, number][], rootSamples: [support], gridPoints: [[0, 0]] as [number, number][], gridSamples: [support], range: [0, .1] as [number, number], missing: 0, maximumAdjacentStep: .01, plane: {slope: .2, maximumResidual: .01}};
  const profile: TreeBarkProfile = {...body, sha256: sha(JSON.stringify(body))};
  const part: LocalPolygon = {id: 'wall', rings: [[[0, 0], [.01, 0], [.01, .1], [0, 0]]], bbox: [0, 0, .01, .1], properties: {paatyyppi: 'Varusteet', alatyyppi: 'Tukimuuri'}};
  const face = {cell: 'c', name: 'c_ground_grass', primitive: 0, triangle: 0, points: [[-1, 0, -1], [1, 0, -1], [0, 0, 1]] as BarkTriangle};
  const faces = [{...face, kind: 'visual' as const}, {...face, name: 'g:c', kind: 'collision' as const}];
  const ref = {path: 'c.glb', bytes: 1, sha256: 'a'.repeat(64)};
  const native = {cells: [{cell: 'c', visual: ref, collision: {...ref, path: 'c.hcol'}}], faces, candidateInventorySha256: sha(JSON.stringify(faces))};
  const binding: ReviewedNativeTreeBinding = {kind: 'retain-source-wall', sourceTreeSha256: sha(JSON.stringify(tree)), barkModelSha256: sha(JSON.stringify(model)), profileSha256: profile.sha256,
    walls: [{id: 'wall', sha256: sha(JSON.stringify(part))}], native: structuredClone({cells: native.cells, candidateInventorySha256: native.candidateInventorySha256})};
  return {tree, model, binding, evidence: {profile, context: {retainingWallIds: ['wall'], buildingIds: [], waterPointIndices: []}, parts: [part], collision: [support], visual: [support], denseVisual: [support], native}};
}
const qualify = (s: ReturnType<typeof setup>) => qualifyReviewedNativeTree(s.tree, s.model, s.binding, s.evidence);

test('an exact 2D wall flag can retain a planted tree with clear full-height native bark', () => {
  const s = setup(), before = structuredClone(s.tree), proof = qualify(s);
  assert.deepEqual(s.tree, before); assert.equal(proof.target, -.3); assert.ok(proof.rows.every(row => !row.hits.length));
  const changed = setup(); changed.evidence.parts[0]!.properties.alatyyppi = 'another'; assert.throws(() => qualify(changed), /Tukimuuri/);
  const unknown = setup(); unknown.tree.id = 'unreviewed'; assert.throws(() => qualify(unknown), /individually reviewed/);
});

test('an upper horizontal floor blocks retention even above the old root-only obstacle window', () => {
  const s = setup(), points: BarkTriangle = [[-1, 3, -1], [1, 3, -1], [0, 3, 1]];
  s.evidence.native.faces.push({kind: 'visual', cell: 'c', name: 'upper-floor', primitive: 0, triangle: 0, points});
  s.evidence.native.candidateInventorySha256 = s.binding.native.candidateInventorySha256 = sha(JSON.stringify(s.evidence.native.faces));
  assert.throws(() => qualify(s), /Full-height above-soil/);
});

test('missing soil, support mismatch, changed profiles, model identity and native references reject', () => {
  const missing = setup(); missing.evidence.profile.missing = 1; assert.throws(() => qualify(missing), /profile bytes changed/);
  const mismatch = setup(); mismatch.evidence.visual[0] = {...mismatch.evidence.visual[0]!, height: .03}; assert.throws(() => qualify(mismatch), /heights disagree/);
  const geometry = setup(); geometry.model.triangles.pop(); assert.throws(() => qualify(geometry), /bark model changed/);
  const reference = setup(); reference.evidence.native.cells[0]!.visual.sha256 = 'b'.repeat(64); assert.throws(() => qualify(reference), /payloads changed/);
  const inventory = setup(); inventory.evidence.native.faces.pop(); assert.throws(() => qualify(inventory), /face inventory changed/);
});
