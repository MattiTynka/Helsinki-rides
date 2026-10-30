import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyPublicParkingAisleParts, type PublicParkingAisleReview} from '../lib/reviewed-vehicle-surfaces.ts';
import {sourceSha256} from '../lib/source-files.ts';
import type {LocalPolygon} from '../lib/geometry.ts';
import type {RoadSourceElement} from '../lib/expansion-road-merge.ts';
const part: LocalPolygon = {id: '1', rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], bbox: [0, 0, 10, 10], properties: {paatyyppi: 'Ajorata', alatyyppi: 'Pys\u00e4k\u00f6intialue', aluetieto: 'Katu', alueen_nimi: 'Reviewed square'}};
const way: RoadSourceElement = {type: 'way', id: 2, nodes: [3, 4], tags: {highway: 'service', service: 'parking_aisle'}};
const review = (p = part, w = way): PublicParkingAisleReview => ({kind: 'municipal-public-parking-aisle', partId: p.id, partSha256: sourceSha256(JSON.stringify(p)), streetName: 'Reviewed square', ways: [{id: w.id, sha256: sourceSha256(JSON.stringify(w))}], reason: 'Municipal street parking aisle with explicit source identity and public access'});
test('named municipal parking surface qualifies only for its bound public aisle', () => {
  assert.equal(qualifyPublicParkingAisleParts([review()], [part], new Map([[2, way]]), [2])[0]!.partId, '1');
  assert.throws(() => qualifyPublicParkingAisleParts([review()], [part], new Map([[2, way]]), [5]), /unrelated/);
  assert.throws(() => qualifyPublicParkingAisleParts([review()], [{...part, rings: []}], new Map([[2, way]]), [2]), /polygon changed/);
});
test('grass, private parking and conditional or stacked routes never inherit the exception', () => {
  for (const properties of [{...part.properties, alatyyppi: 'Nurmikko'}, {...part.properties, aluetieto: 'Tontti'}]) {
    const p = {...part, properties}; assert.throws(() => qualifyPublicParkingAisleParts([review(p)], [p], new Map([[2, way]]), [2]));
  }
  for (const tags of [{...way.tags, access: 'private'}, {...way.tags, 'motor_vehicle:conditional': 'yes @ (delivery)'}, {...way.tags, layer: '1'}, {...way.tags, bridge: 'yes'}]) {
    const w = {...way, tags}; assert.throws(() => qualifyPublicParkingAisleParts([review(part, w)], [part], new Map([[2, w]]), [2]));
  }
});
