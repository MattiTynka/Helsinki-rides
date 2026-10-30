/** Individually bound native-face reviews. Ordinary tree-soil limits stay unchanged. */
import assert from 'node:assert/strict';
import {barkTriangleIntersections, transformedTreeBark, type TreeBarkModel, type TreeBarkProfile} from './tree-bark-registration.ts';
import {registrationSha256 as sha, type RegistrationTree, type GroundRegistrationSupport, type TreeSoilContext} from './tree-ground-registration.ts';
import {type LocalPolygon} from './geometry.ts';
import {type readRetainedShoreBarkNative} from './tree-retained-shore-registration.ts';

type Native = Awaited<ReturnType<typeof readRetainedShoreBarkNative>>;
type Support = GroundRegistrationSupport | null;
export interface ReviewedNativeTreeBinding {
  kind: 'retain-source-wall' | 'retain-curved-soil' | 'omit-native-ground-conflict';
  sourceTreeSha256: string;
  barkModelSha256: string;
  profileSha256: string;
  walls: {id: string; sha256: string}[];
  native: {cells: Native['cells']; candidateInventorySha256: string};
}
const ids = (values: string[]) => new Set(values.map(id => 'TREE_SUMMER_' + id));
const allowed = {
  'retain-curved-soil': ids(['79446d38-44fa-4033-883b-6fdfa5f7189a']),
  'retain-source-wall': ids(['500e6ff1-8d7e-47dc-a56c-c078651c42b7', '39b52228-7641-423b-ae6d-3f612ea95817', 'a2b241fc-1769-48b0-a14e-362190cdb623', 'dde28dda-7b1b-455e-9faf-0d45a2b18ac3', '28c2ce26-8916-48a4-b4c2-44b082ae6a66', 'aac2b34e-aac7-4cc2-9565-96bf1951b559']),
  'omit-native-ground-conflict': ids(['60bce681-1893-4efc-af61-b2c8023d7c60', 'c96b1e59-cb4e-4891-86c2-8a60bd9c6979', 'f77235b4-266c-468c-9257-468378d95206', 'd4eaf2fc-8ca9-48c5-91ae-bee5f95e7c08']),
};
function vertical(points: readonly (readonly number[])[]) {
  const a = points[1]!.map((v, k) => v - points[0]![k]!), b = points[2]!.map((v, k) => v - points[0]![k]!);
  const normal = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  return Math.hypot(...normal) > 1e-12 && Math.abs(normal[1]!) / Math.hypot(...normal) <= .3;
}
export function qualifyReviewedNativeTree(tree: RegistrationTree, model: TreeBarkModel, binding: ReviewedNativeTreeBinding, evidence: {
  profile: TreeBarkProfile; context: TreeSoilContext; parts: readonly LocalPolygon[];
  collision: readonly Support[]; visual: readonly Support[]; denseVisual: readonly Support[]; native: Native;
}) {
  assert.ok(allowed[binding.kind]?.has(tree.id), 'Native tree review is limited to individually reviewed placements');
  assert.equal(sha(JSON.stringify(tree)), binding.sourceTreeSha256, 'Reviewed tree identity changed');
  assert.equal(sha(JSON.stringify(model)), binding.barkModelSha256, 'Reviewed bark model changed');
  const {profile, context, native} = evidence;
  assert.equal(profile.sha256, binding.profileSha256, 'Reviewed actual soil profile changed');
  const {sha256: recordedProfileSha256, ...profileBody} = profile;
  assert.equal(sha(JSON.stringify(profileBody)), recordedProfileSha256, 'Actual measured profile bytes changed');
  assert.ok(profile.range && profile.plane, 'Native review needs actual ground support');
  assert.ok(!context.buildingIds.length && !context.waterPointIndices.length, 'Native ground review cannot hide building or water conflicts');
  assert.deepEqual([...context.retainingWallIds].sort(), binding.walls.map(w => w.id).sort(), 'Source wall context changed');
  for (const wall of binding.walls) {
    const part = evidence.parts.find(p => p.id === wall.id); assert.ok(part);
    assert.equal(part.properties['paatyyppi'], 'Varusteet'); assert.equal(part.properties['alatyyppi'], 'Tukimuuri');
    assert.equal(sha(JSON.stringify(part)), wall.sha256, 'Reviewed municipal wall changed');
  }
  const compare = (a: readonly Support[], b: readonly Support[]) => {
    assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) {
      assert.equal(!!a[i], !!b[i], 'Native tree review cannot hide visual/collision support disagreement');
      if (a[i]) assert.ok(Math.abs(a[i]!.height - b[i]!.height) <= .02, 'Native tree support heights disagree');
    }
  };
  compare(evidence.collision, evidence.visual); compare(profile.gridSamples, evidence.denseVisual);
  assert.deepEqual(native.cells, binding.native.cells, 'Reviewed native payloads changed');
  assert.equal(native.candidateInventorySha256, binding.native.candidateInventorySha256);
  assert.equal(sha(JSON.stringify(native.faces)), native.candidateInventorySha256, 'Reviewed native face inventory changed');
  assert.ok(native.cells.length && native.faces.some(f => f.kind === 'visual') && native.faces.some(f => f.kind === 'collision'), 'Native review needs both actual representations');
  const target = Math.abs(profile.range[0] - .3 - tree.position[1]) > .15 ? profile.range[0] - .3 : tree.position[1];
  const omission = binding.kind === 'omit-native-ground-conflict';
  if (omission) {
    assert.ok(!binding.walls.length && profile.missing <= 4 && profile.maximumAdjacentStep > .1 && profile.range[1] - profile.range[0] <= 1.6,
      'Ground-conflict omission requires the measured abrupt root discontinuity');
  } else {
    assert.ok(profile.missing === 0 && evidence.collision.every(Boolean), 'Retention requires complete actual soil support');
    if (binding.kind === 'retain-source-wall') assert.ok(binding.walls.length > 0 && profile.range[1] - profile.range[0] <= .3 && profile.maximumAdjacentStep <= .02 && profile.plane.maximumResidual <= .04 && profile.plane.slope <= 1.5,
      'Source-wall retention needs a continuous flat root footprint');
    else assert.ok(!binding.walls.length && profile.range[1] - profile.range[0] <= 1.5 && profile.maximumAdjacentStep <= .04 && profile.plane.maximumResidual <= .24 && profile.plane.slope <= 1.2,
      'Individually measured curved root surface changed');
    const highestBark = Math.max(...model.triangles.flat().map(p => p[1] * tree.scale[1]));
    assert.ok(target <= profile.range[0] - .01 && target + highestBark - profile.range[1] >= 1, 'Retained bark must remain planted and visible');
  }
  const gate = omission ? profile.range[0] + .01 : profile.range[1] + .01;
  const rows = [tree.position[1], target].map(y => {
    const bark = transformedTreeBark(model, tree, y);
    const hits = native.faces.flatMap(face => {
      const intersections = bark.flatMap(triangle => barkTriangleIntersections(triangle, face.points)).filter(p => p[1] > gate);
      if (!intersections.length) return [];
      return [{kind: face.kind, cell: face.cell, name: face.name, primitive: face.primitive, triangle: face.triangle,
        faceSha256: sha(JSON.stringify(face.points)), vertical: vertical(face.points), maximumIntersectionY: Math.max(...intersections.map(p => p[1]))}];
    });
    if (omission) {
      for (const kind of ['visual', 'collision']) assert.ok(hits.some(h => h.kind === kind && h.vertical && (h.name.includes('_ground_') || h.name.startsWith('g:'))),
        'Actual vertical native ground must intersect bark at source and intended Y in both representations');
    } else assert.equal(hits.length, 0, 'Full-height above-soil native bark obstruction blocks retention');
    return {y, hits};
  });
  return {kind: binding.kind, id: tree.id, target, anchor: profile.range[0], profileSha256: profile.sha256, sourceTreeSha256: binding.sourceTreeSha256,
    barkModelSha256: binding.barkModelSha256, walls: binding.walls, native: binding.native, aboveSoilGate: gate, rows,
    interpretation: omission ? 'This new model straddles an actual native vertical ground discontinuity at source and intended height; only this model placement is omitted.' : 'The exact model remains planted on measured native soil and has no full-height above-soil obstruction. A two-dimensional wall flag is not extruded into a fictitious wall.'};
}
