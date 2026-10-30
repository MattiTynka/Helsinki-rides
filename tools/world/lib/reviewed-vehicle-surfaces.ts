import assert from 'node:assert/strict';
import type {LocalPolygon} from './geometry.ts';
import type {RoadSourceElement} from './expansion-road-merge.ts';
import {sourceSha256} from './source-files.ts';

export interface PublicParkingAisleReview {
  kind: 'municipal-public-parking-aisle';
  partId: string;
  partSha256: string;
  streetName: string;
  ways: {id: number; sha256: string}[];
  reason: string;
}

/** This proves only a named surface's source eligibility. Road-tagged serialized
 * floor, actual vehicle footprint, grade and connectivity remain separate gates.
 */
export function qualifyPublicParkingAisleParts(reviews: readonly PublicParkingAisleReview[], parts: readonly LocalPolygon[], ways: ReadonlyMap<number, RoadSourceElement>, recordWayIds: readonly number[]) {
  assert.ok(reviews.length <= 32 && new Set(reviews.map(r => r.partId)).size === reviews.length, 'Duplicate or unbounded parking surface reviews');
  return reviews.map(review => {
    assert.equal(review.kind, 'municipal-public-parking-aisle');
    assert.ok(review.reason.trim().length >= 20 && review.reason.length <= 2000 && review.streetName.length > 0);
    const part = parts.find(p => p.id === review.partId); assert.ok(part, 'Reviewed parking part is missing');
    assert.equal(sourceSha256(JSON.stringify(part)), review.partSha256, 'Reviewed parking polygon changed');
    assert.equal(part.properties.paatyyppi, 'Ajorata');
    assert.equal(part.properties.alatyyppi, 'Pys\u00e4k\u00f6intialue');
    assert.equal(part.properties.aluetieto, 'Katu', 'Parking part is not within the municipal public street inventory');
    assert.equal(part.properties.alueen_nimi, review.streetName);
    assert.ok(review.ways.length > 0 && review.ways.length <= 16 && new Set(review.ways.map(w => w.id)).size === review.ways.length);
    assert.ok(review.ways.some(w => recordWayIds.includes(w.id)), 'Parking review is unrelated to this lane or connector');
    for (const ref of review.ways) {
      const way = ways.get(ref.id); assert.ok(way?.tags && way.nodes?.length && way.type === 'way');
      assert.equal(sourceSha256(JSON.stringify(way)), ref.sha256, 'Reviewed parking aisle source changed');
      assert.equal(way.tags.highway, 'service'); assert.equal(way.tags.service, 'parking_aisle');
      for (const key of ['access', 'vehicle', 'motor_vehicle']) {
        assert.ok(way.tags[key] === undefined || ['yes', 'permissive', 'designated'].includes(way.tags[key]), 'Parking aisle access is restricted');
        assert.ok(way.tags[`${key}:conditional`] === undefined, 'Conditional parking access needs separate resolution');
      }
      assert.ok((!way.tags.bridge || way.tags.bridge === 'no') && (!way.tags.tunnel || way.tags.tunnel === 'no') && (!way.tags.indoor || way.tags.indoor === 'no') && Number(way.tags.layer ?? 0) === 0 && way.tags.area !== 'yes', 'Parking review does not authorize another physical level');
    }
    return {partId: part.id, partSha256: review.partSha256, streetName: review.streetName, kind: review.kind, ways: review.ways, reason: review.reason};
  });
}
