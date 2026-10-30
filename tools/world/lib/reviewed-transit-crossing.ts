import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {pointAlong, type RoadConnector, type RoadLane, type Vec3} from '../../../packages/world-schema/src/index.ts';
import type {LocalPolygon} from './geometry.ts';
import type {RoadSourceElement, RoadSupportTriangle} from './expansion-road-merge.ts';
import {sourceSha256} from './source-files.ts';

const ALLOWED_RECORDS = ['176821966:0:b0', '176821966:0:f0'] as const;
export const SELKAMERENKATU_TRANSIT_APPROVAL_SHA256 = 'bfb0f25c1f3430d889d389012863bb4c6964d1d2ecf06b8a7bda5561e0f14900';
export const SELKAMERENKATU_TURN_APPROVAL_SHA256 = '40b232d16f5c3bfe410d13ffd9874e730f4531c647176f114aaf7fa2c5bfa5ad';
export const SELKAMERENKATU_CONTINUATION_APPROVAL_SHA256 = '8e258d69d8cb117851df3b0c2e9fecbbdb4af192a3803adf7de4e1e88e5421df';
interface CrossingSourcePins {osmSha256: string; streetPartsSha256: string; candidateRoadsSha256: string}
interface CrossingCellPin {cell: string; storedSha256: string; decodedSha256: string}
export interface ReviewedTransitCrossing {
  schemaVersion: 1;
  kind: 'source-bound-public-transit-crossing';
  approvedProposalSha256: string;
  sourcePins: CrossingSourcePins;
  world: {manifestSha256: string; cells: CrossingCellPin[]};
  records: {id: string; sourceRecordSha256: string; horizontalSha256: string; sourceWaySha256: string}[];
}
export interface TransitCrossingInputs {
  review: ReviewedTransitCrossing;
  /** Raw bytes of the independently approved proposal, never reconstructed JSON. */
  approvedProposalBytes: Uint8Array;
  sourcePins: CrossingSourcePins;
  floor: {manifestSha256: string; cells: CrossingCellPin[]; triangles: readonly RoadSupportTriangle[]};
  parts: readonly LocalPolygon[];
  ways: ReadonlyMap<number, RoadSourceElement>;
  records: readonly RoadLane[];
}
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
const exactKeys = (value: object, keys: string[]) => assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'Unexpected transit review field');
const digest = (value: string) => assert.match(value, /^[a-f0-9]{64}$/);
export const transitHorizontalSha256 = (points: readonly Vec3[]) => hash(points.map(p => [p[0], p[2]]));

/** Per-record source eligibility only. The caller must substitute these CLIPPED
 * polygons for this record's source checks and still run final vehicle/floor gates.
 * Original municipal subtype and source hashes are retained. No global part-ID
 * permission is returned. The optional authority pin supports isolated fixtures;
 * production callers use the exported reviewed approval pin. */
export function qualifyReviewedTransitCrossing(input: TransitCrossingInputs, approvedProposalSha256 = SELKAMERENKATU_TRANSIT_APPROVAL_SHA256) {
  const {review, sourcePins, floor, records, parts, ways} = input;
  exactKeys(review, ['schemaVersion','kind','approvedProposalSha256','sourcePins','world','records']);
  assert.equal(review.schemaVersion, 1); assert.equal(review.kind, 'source-bound-public-transit-crossing');
  digest(approvedProposalSha256); assert.equal(review.approvedProposalSha256, approvedProposalSha256);
  assert.ok(input.approvedProposalBytes.length > 0 && input.approvedProposalBytes.length < 2_000_000);
  assert.equal(sourceSha256(input.approvedProposalBytes), approvedProposalSha256, 'Approved crossing proposal bytes changed');
  const proposal = JSON.parse(Buffer.from(input.approvedProposalBytes).toString()) as any;
  exactKeys(review.sourcePins, ['osmSha256','streetPartsSha256','candidateRoadsSha256']);
  for (const value of Object.values(review.sourcePins)) digest(value);
  assert.deepEqual(review.sourcePins, sourcePins, 'Current crossing source/graph pins differ');
  assert.equal(proposal.osmPin.sha256, sourcePins.osmSha256); assert.equal(proposal.source.sha256, sourcePins.streetPartsSha256);
  exactKeys(review.world, ['manifestSha256','cells']); digest(review.world.manifestSha256);
  assert.equal(review.world.manifestSha256, floor.manifestSha256, 'Crossing final-world binding differs');
  assert.ok(review.world.cells.length > 0 && review.world.cells.length <= 16 && new Set(review.world.cells.map(c => c.cell)).size === review.world.cells.length);
  for (const c of review.world.cells) {exactKeys(c, ['cell','storedSha256','decodedSha256']); digest(c.storedSha256); digest(c.decodedSha256);}
  assert.deepEqual(review.world.cells, floor.cells, 'Crossing final HCOL payload pins differ');
  assert.deepEqual(review.records.map(r => r.id).sort(), [...ALLOWED_RECORDS], 'Only the two reviewed crossing lanes are eligible');
  const part = parts.find(p => p.id === '41731'); assert.ok(part);
  assert.equal(hash(part), proposal.crossedPart.sha256, 'Reviewed municipal transit polygon changed');
  assert.equal(part.properties.paatyyppi, 'Ajorata'); assert.equal(part.properties.alatyyppi, 'Ajorata, muu');
  assert.ok(String(part.properties.rakenteellinen_kunnossapito).includes('HKL'));
  const way = ways.get(176821966); assert.ok(way?.nodes && way.tags && way.type === 'way');
  assert.deepEqual(way.nodes, [1519889202,318467444,318467446,1519889237]);
  assert.equal(way.tags.highway, 'residential'); assert.equal(Number(way.tags.layer ?? 0), 0);
  for (const key of ['bridge','tunnel','indoor']) assert.ok(!way.tags[key] || way.tags[key] === 'no');
  for (const key of ['access','vehicle','motor_vehicle']) {
    assert.ok(way.tags[key] === undefined || ['yes','designated','permissive'].includes(way.tags[key]!));
    assert.ok(!Object.keys(way.tags).some(k => k.startsWith(key) && k.endsWith(':conditional')));
  }
  for (const ref of proposal.sourceWays) assert.equal(hash(ways.get(ref.id)), ref.sha256, `Crossing approach source way ${ref.id} changed`);
  assert.equal(proposal.restrictionWitnesses.length, 0, 'A source turn restriction needs a new review');
  assert.equal(proposal.entry.node, 'n1519889237'); assert.equal(proposal.entry.from, '928817678:0:f1'); assert.equal(proposal.entry.to, '176821966:0:b0');
  assert.ok(Array.isArray(proposal.corridor) && proposal.corridor.length >= 3 && proposal.corridor.length <= 512 && proposal.corridor.every((p: number[]) => p.length === 2 && p.every(Number.isFinite)));
  const transitGeometry = part.rings.map(r => r.map(([x, n]) => [x, -n] as [number, number]));
  const crossing = polygonClipping.intersection([proposal.corridor], transitGeometry);
  assert.equal(crossing.length, 1, 'This reviewed crossing has one connected source component'); assert.equal(hash(crossing), hash(proposal.crossing), 'Crossing must be the literal approved JSON corridor/source intersection');
  const actualFaces = new Map(floor.triangles.map(t => [t.id, t]));
  assert.ok(proposal.selectedFaces.length > 0 && proposal.selectedFaces.length <= 20_000);
  for (const face of proposal.selectedFaces) {
    assert.ok(face.tag.startsWith('road:') && floor.cells.some(c => face.id.startsWith(`serialized:${c.cell}:`)), 'Crossing floor lacks a current road HCOL cell pin');
    assert.deepEqual(actualFaces.get(face.id), face, `Approved crossing floor changed: ${face.id}`);
  }
  const clippedParts: LocalPolygon[] = crossing.map(polygon => {
    const rings = polygon.map(r => r.slice(0, -1).map(([x, z]) => [x, -z] as [number, number]));
    const points = rings.flat();
    return {id: part.id, properties: {...part.properties}, rings, bbox: [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]};
  });
  const qualified = new Map<string, {parts: LocalPolygon[]; sourceWitnesses: object}>();
  for (const ref of review.records) {
    exactKeys(ref, ['id','sourceRecordSha256','horizontalSha256','sourceWaySha256']);
    for (const value of [ref.sourceRecordSha256,ref.horizontalSha256,ref.sourceWaySha256]) digest(value);
    const record = records.find(r => r.id === ref.id); assert.ok(record && record.wayId === 176821966);
    assert.equal(hash(record), ref.sourceRecordSha256, 'Reviewed crossing graph record changed');
    assert.equal(hash(way), ref.sourceWaySha256, 'Reviewed crossing source way changed');
    const approved = proposal.audits.find((a: any) => a.id === record.id); assert.ok(approved);
    assert.equal(approved.newEndpointTrimMetres, .6); assert.equal(approved.projectFailures.length, 0); assert.equal(approved.admission.closedIntervals.length, 0); assert.equal(approved.bodyFloor.failures.length, 0);
    assert.equal(transitHorizontalSha256(record.points), ref.horizontalSha256);
    assert.equal(ref.horizontalSha256, transitHorizontalSha256(approved.projected), 'Crossing horizontal geometry differs from the reviewed trim');
    const original = approved.original;
    for (const key of ['from','to','index','count','width','wayId','highway','name','speedLimit','surface'] as const) assert.deepEqual(record[key], original[key], `Crossing source metadata ${key} changed`);
    qualified.set(record.id, {parts: structuredClone(clippedParts), sourceWitnesses: {kind: review.kind, approvedProposalSha256, recordId: record.id, sourceRecordSha256: ref.sourceRecordSha256, horizontalSha256: ref.horizontalSha256, sourceWaySha256: ref.sourceWaySha256, sourcePartId: part.id, sourcePartSha256: proposal.crossedPart.sha256, originalSubtype: part.properties.alatyyppi, clippedGeometrySha256: hash(clippedParts), sourcePins, finalWorld: review.world, literalFloorFaces: proposal.selectedFaces.map((f: any) => ({id: f.id, sha256: hash(f)})), pendingFinalFullBodyAndTravel: true}});
  }
  return qualified;
}

export interface ReviewedTransitTurn {
  schemaVersion: 1;
  kind: 'source-bound-public-transit-turn';
  approvedProposalSha256: string;
  baseCrossingProposalSha256: string;
  sourcePins: CrossingSourcePins;
  world: {manifestSha256: string; cells: CrossingCellPin[]};
  record: {id: string; sourceRecordSha256: string; horizontalSha256: string};
  approach: {id: string; sourceRecordSha256: string; horizontalSha256: string};
  crossingLane: {id: string; sourceRecordSha256: string; horizontalSha256: string};
}
export interface TransitTurnInputs {
  review: ReviewedTransitTurn;
  approvedProposalBytes: Uint8Array;
  baseCrossingProposalBytes: Uint8Array;
  sourcePins: CrossingSourcePins;
  floor: TransitCrossingInputs['floor'];
  parts: readonly LocalPolygon[];
  ways: ReadonlyMap<number, RoadSourceElement>;
  record: RoadConnector;
  approach: RoadLane;
  crossingLane: RoadLane;
}

export interface ReviewedTransitContinuation {
  schemaVersion: 1;
  kind: 'source-bound-public-transit-continuation';
  approvedProposalSha256: string;
  baseCrossingProposalSha256: string;
  sourcePins: CrossingSourcePins;
  world: {manifestSha256: string; cells: CrossingCellPin[]};
  record: {id: string; sourceRecordSha256: string; horizontalSha256: string};
  crossingLane: {id: string; sourceRecordSha256: string; horizontalSha256: string};
  ordinaryLane: {id: string; sourceRecordSha256: string; horizontalSha256: string};
}
export interface TransitContinuationInputs {
  review: ReviewedTransitContinuation;
  approvedProposalBytes: Uint8Array;
  baseCrossingProposalBytes: Uint8Array;
  sourcePins: CrossingSourcePins;
  floor: TransitCrossingInputs['floor'];
  parts: readonly LocalPolygon[];
  ways: ReadonlyMap<number, RoadSourceElement>;
  record: RoadConnector;
  crossingLane: RoadLane;
  ordinaryLane: RoadLane;
}

/** The short south continuation inherits ONLY the literal reviewed crossing
 * polygon, with its own exact record/geometry approval. It grants no permission
 * to the adjacent ordinary lane, which is independently trimmed by one metre. */
export function qualifyReviewedTransitContinuation(input: TransitContinuationInputs, authoritySha256 = SELKAMERENKATU_CONTINUATION_APPROVAL_SHA256, baseSha256 = SELKAMERENKATU_TRANSIT_APPROVAL_SHA256) {
  const {review, sourcePins, floor, record, crossingLane, ordinaryLane} = input;
  exactKeys(review, ['schemaVersion','kind','approvedProposalSha256','baseCrossingProposalSha256','sourcePins','world','record','crossingLane','ordinaryLane']);
  assert.equal(review.schemaVersion,1); assert.equal(review.kind,'source-bound-public-transit-continuation');
  digest(authoritySha256); digest(baseSha256); assert.equal(review.approvedProposalSha256,authoritySha256); assert.equal(review.baseCrossingProposalSha256,baseSha256);
  for (const bytes of [input.approvedProposalBytes,input.baseCrossingProposalBytes]) assert.ok(bytes.length>0 && bytes.length<2_000_000);
  assert.equal(sourceSha256(input.approvedProposalBytes),authoritySha256,'Approved continuation proposal changed');
  assert.equal(sourceSha256(input.baseCrossingProposalBytes),baseSha256,'Base crossing approval changed');
  const proposal=JSON.parse(Buffer.from(input.approvedProposalBytes).toString()) as any,base=JSON.parse(Buffer.from(input.baseCrossingProposalBytes).toString()) as any;
  assert.equal(proposal.kind,'public-crossing-south-continuation-proposal'); assert.equal(proposal.basePin.sha256,baseSha256);
  exactKeys(review.sourcePins,['osmSha256','streetPartsSha256','candidateRoadsSha256']); for(const value of Object.values(review.sourcePins))digest(value);
  assert.deepEqual(review.sourcePins,sourcePins); assert.equal(proposal.osmPin.sha256,sourcePins.osmSha256); assert.equal(base.osmPin.sha256,sourcePins.osmSha256);
  assert.equal(proposal.sourcePin.sha256,sourcePins.streetPartsSha256); assert.equal(base.source.sha256,sourcePins.streetPartsSha256);
  exactKeys(review.world,['manifestSha256','cells']); digest(review.world.manifestSha256); assert.equal(review.world.manifestSha256,floor.manifestSha256); assert.deepEqual(review.world.cells,floor.cells);
  assert.ok(floor.cells.length>0 && floor.cells.length<=16 && new Set(floor.cells.map(c=>c.cell)).size===floor.cells.length);
  for(const c of floor.cells){exactKeys(c,['cell','storedSha256','decodedSha256']);digest(c.storedSha256);digest(c.decodedSha256);}
  assert.equal(record.id,'176821966:0:b0>8013666:0:b0','Other connectors have no continuation eligibility');
  assert.equal(record.from,'176821966:0:b0'); assert.equal(record.to,'8013666:0:b0'); assert.equal(record.node,'n1519889202');
  assert.equal(crossingLane.id,record.from); assert.equal(crossingLane.to,record.node); assert.equal(ordinaryLane.id,record.to); assert.equal(ordinaryLane.from,record.node);
  for(const [ref,actual,approved] of [[review.record,record,proposal.selected.after.connector],[review.crossingLane,crossingLane,proposal.original.from],[review.ordinaryLane,ordinaryLane,proposal.selected.after.to]] as const){
    exactKeys(ref,['id','sourceRecordSha256','horizontalSha256']);digest(ref.sourceRecordSha256);digest(ref.horizontalSha256);assert.equal(ref.id,actual.id);assert.equal(ref.sourceRecordSha256,hash(actual));
    assert.equal(ref.horizontalSha256,transitHorizontalSha256(actual.points));assert.equal(ref.horizontalSha256,transitHorizontalSha256(approved.points),'Continuation horizontal geometry changed');
    const {points:_p,length:_l,...metadata}=actual,{points:_q,length:_k,...expected}=approved;assert.deepEqual(metadata,expected,'Continuation source metadata changed');
  }
  assert.equal(proposal.selected.trim,1); assert.deepEqual(proposal.selected.after.to.points[0],pointAlong(proposal.original.to.points,1).point);
  assert.deepEqual(proposal.selected.after.to.points.slice(1),proposal.original.to.points.slice(1));
  assert.equal(transitHorizontalSha256([record.points[0]!]),transitHorizontalSha256([crossingLane.points.at(-1)!]));
  assert.equal(transitHorizontalSha256([record.points.at(-1)!]),transitHorizontalSha256([ordinaryLane.points[0]!]));
  const part=input.parts.find(p=>p.id==='41731');assert.ok(part);assert.equal(hash(part),proposal.sourcePart.sha256);assert.equal(hash(part),base.crossedPart.sha256);
  assert.equal(part.properties.paatyyppi,'Ajorata');assert.equal(part.properties.alatyyppi,'Ajorata, muu');assert.ok(String(part.properties.rakenteellinen_kunnossapito).includes('HKL'));
  for(const source of proposal.sourceWays){const way=input.ways.get(source.id);assert.ok(way?.nodes?.includes(1519889202));assert.equal(hash(way),source.sha256,'Continuation source way changed');}
  assert.deepEqual(proposal.sourceWays.map((w:any)=>w.id).sort((a:number,b:number)=>a-b),[8013666,176821966]);assert.equal(proposal.restrictions.length,0);
  assert.deepEqual(proposal.additionalTransitArea,[]);assert.equal(hash(proposal.crossing),hash(base.crossing),'Continuation cannot enlarge transit eligibility');
  for(const proof of [proposal.selected.admission,proposal.selected.toAdmission])assert.equal(proof.closedIntervals.length,0);
  for(const proof of [proposal.selected.physical,proposal.selected.toPhysical])assert.equal(proof.failureCount,0);
  const actual=new Map(floor.triangles.map(t=>[t.id,t]));assert.ok(proposal.selectedFaces.length>0&&proposal.selectedFaces.length<=20000);
  for(const face of proposal.selectedFaces){assert.ok(face.tag.startsWith('road:')&&floor.cells.some(c=>face.id.startsWith(`serialized:${c.cell}:`)));assert.deepEqual(actual.get(face.id),face,'Continuation literal HCOL changed');}
  const clipped:LocalPolygon[]=base.crossing.map((polygon:number[][][])=>{const rings=polygon.map(r=>r.slice(0,-1).map(([x,z])=>[x!,-z!] as [number,number])),points=rings.flat();return{id:part.id,properties:{...part.properties},rings,bbox:[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]};});
  return new Map([[record.id,{parts:clipped,sourceWitnesses:{kind:review.kind,approvedProposalSha256:authoritySha256,baseCrossingProposalSha256:baseSha256,recordId:record.id,sourceRecordSha256:review.record.sourceRecordSha256,sourcePartSha256:hash(part),originalSubtype:part.properties.alatyyppi,clippedGeometrySha256:hash(clipped),additionalTransitArea:[],sourcePins,finalWorld:review.world,pendingFinalFullBodyAndTravel:true}}]]);
}

/** The separately reviewed entry turn has its OWN clipped polygon and record pin.
 * It does not inherit eligibility from the crossing lanes or vice versa. */
export function qualifyReviewedTransitTurn(input: TransitTurnInputs, approvedProposalSha256 = SELKAMERENKATU_TURN_APPROVAL_SHA256, baseCrossingProposalSha256 = SELKAMERENKATU_TRANSIT_APPROVAL_SHA256) {
  const {review, sourcePins, floor, parts, ways, record, approach, crossingLane} = input;
  exactKeys(review, ['schemaVersion','kind','approvedProposalSha256','baseCrossingProposalSha256','sourcePins','world','record','approach','crossingLane']);
  assert.equal(review.schemaVersion, 1); assert.equal(review.kind, 'source-bound-public-transit-turn');
  for (const value of [approvedProposalSha256,baseCrossingProposalSha256]) digest(value);
  assert.equal(review.approvedProposalSha256, approvedProposalSha256); assert.equal(review.baseCrossingProposalSha256, baseCrossingProposalSha256);
  for (const bytes of [input.approvedProposalBytes,input.baseCrossingProposalBytes]) assert.ok(bytes.length > 0 && bytes.length < 2_000_000);
  assert.equal(sourceSha256(input.approvedProposalBytes), approvedProposalSha256, 'Approved turn proposal changed');
  assert.equal(sourceSha256(input.baseCrossingProposalBytes), baseCrossingProposalSha256, 'Base crossing approval changed');
  const proposal = JSON.parse(Buffer.from(input.approvedProposalBytes).toString()) as any;
  const base = JSON.parse(Buffer.from(input.baseCrossingProposalBytes).toString()) as any;
  assert.equal(proposal.originalProposalPin.sha256, baseCrossingProposalSha256);
  exactKeys(review.sourcePins, ['osmSha256','streetPartsSha256','candidateRoadsSha256']);
  for (const value of Object.values(review.sourcePins)) digest(value);
  assert.deepEqual(review.sourcePins, sourcePins); assert.equal(base.osmPin.sha256, sourcePins.osmSha256);
  assert.equal(base.source.sha256, sourcePins.streetPartsSha256); assert.equal(proposal.source.sha256, sourcePins.streetPartsSha256);
  exactKeys(review.world, ['manifestSha256','cells']); digest(review.world.manifestSha256);
  assert.equal(review.world.manifestSha256, floor.manifestSha256); assert.deepEqual(review.world.cells, floor.cells, 'Turn current HCOL pins differ');
  assert.ok(floor.cells.length > 0 && floor.cells.length <= 16 && new Set(floor.cells.map(c => c.cell)).size === floor.cells.length);
  for (const c of floor.cells) {exactKeys(c, ['cell','storedSha256','decodedSha256']); digest(c.storedSha256); digest(c.decodedSha256);}
  assert.equal(record.id, '928817678:0:f1>176821966:0:b0', 'Other connectors have no transit eligibility');
  assert.equal(record.from, '928817678:0:f1'); assert.equal(record.to, '176821966:0:b0'); assert.equal(record.node, 'n1519889237');
  assert.equal(approach.id, record.from); assert.equal(approach.wayId, 928817678); assert.equal(approach.to, record.node);
  assert.equal(crossingLane.id, record.to); assert.equal(crossingLane.wayId, 176821966); assert.equal(crossingLane.from, record.node);
  for (const [ref, actual, approved] of [[review.record,record,proposal.after.connector],[review.approach,approach,proposal.after.lane],[review.crossingLane,crossingLane,base.audits.find((a: any) => a.id === crossingLane.id)?.original]] as const) {
    assert.ok(approved); exactKeys(ref, ['id','sourceRecordSha256','horizontalSha256']); digest(ref.sourceRecordSha256); digest(ref.horizontalSha256);
    assert.equal(ref.id, actual.id); assert.equal(hash(actual), ref.sourceRecordSha256, 'Reviewed turn graph record changed');
    assert.equal(transitHorizontalSha256(actual.points), ref.horizontalSha256);
    const expectedPoints: readonly Vec3[] = actual.id === crossingLane.id ? base.audits.find((a: any) => a.id === crossingLane.id).projected : approved.points;
    assert.equal(ref.horizontalSha256, transitHorizontalSha256(expectedPoints), 'Turn/approach horizontal geometry changed');
    const {points: _actualPoints, length: _actualLength, ...actualMetadata} = actual;
    const {points: _approvedPoints, length: _approvedLength, ...approvedMetadata} = approved;
    assert.deepEqual(actualMetadata, approvedMetadata, 'Turn/approach source metadata changed');
  }
  assert.deepEqual(approach.points.at(-1)!.filter((_,i) => i !== 1), record.points[0]!.filter((_,i) => i !== 1));
  assert.deepEqual(record.points.at(-1)!.filter((_,i) => i !== 1), crossingLane.points[0]!.filter((_,i) => i !== 1));
  assert.equal(proposal.parameters.approachTrimMetres, 3); assert.equal(proposal.parameters.ordinaryLaneAuthoringReserveMetres, .275); assert.equal(proposal.parameters.crossingLaneUnchanged, true);
  for (const proof of [proposal.fromAdmission,proposal.turnAdmission]) assert.equal(proof.closedIntervals.length, 0);
  for (const proof of [proposal.fromPhysical,proposal.turnPhysical]) assert.equal(proof.failureCount, 0);
  assert.equal(proposal.restrictionWitnesses.length, 0); assert.equal(base.restrictionWitnesses.length, 0);
  assert.deepEqual(proposal.sourceWayWitnesses, base.sourceWays);
  for (const ref of proposal.sourceWayWitnesses) assert.equal(hash(ways.get(ref.id)), ref.sha256, 'Turn source way changed');
  for (const id of [928817678,176821966]) {
    const way = ways.get(id); assert.ok(way); assert.ok(way.nodes?.includes(1519889237) && way.tags);
    for (const key of ['access','vehicle','motor_vehicle']) assert.ok(way.tags[key] === undefined || ['yes','designated','permissive'].includes(way.tags[key]!));
    assert.ok(!Object.keys(way.tags).some(k => /^(access|vehicle|motor_vehicle).*:conditional$/.test(k)));
    assert.equal(Number(way.tags.layer ?? 0), 0); assert.ok(!way.tags.bridge && !way.tags.tunnel && !way.tags.indoor);
  }
  const part = parts.find(p => p.id === '41731'); assert.ok(part); assert.equal(hash(part), proposal.sourcePart.sha256); assert.equal(proposal.sourcePart.sha256, base.crossedPart.sha256);
  assert.equal(part.properties.paatyyppi, 'Ajorata'); assert.equal(part.properties.alatyyppi, 'Ajorata, muu');
  assert.ok(Array.isArray(proposal.corridor) && proposal.corridor.length >= 3 && proposal.corridor.length <= 512 && proposal.corridor.every((p: number[]) => p.length === 2 && p.every(Number.isFinite)));
  const crossing = polygonClipping.intersection([proposal.corridor], part.rings.map(r => r.map(([x,n]) => [x,-n] as [number,number])));
  assert.equal(crossing.length, 1); assert.equal(hash(crossing), hash(proposal.crossing), 'Turn source domain differs from the approved literal intersection');
  const actualFaces = new Map(floor.triangles.map(t => [t.id,t])); assert.ok(proposal.literalFaces.length > 0 && proposal.literalFaces.length <= 20_000);
  for (const face of proposal.literalFaces) {assert.ok(face.tag.startsWith('road:') && floor.cells.some(c => face.id.startsWith(`serialized:${c.cell}:`))); assert.deepEqual(actualFaces.get(face.id), face, 'Turn current literal HCOL changed');}
  const clippedParts: LocalPolygon[] = crossing.map(p => {const rings = p.map(r => r.slice(0,-1).map(([x,z]) => [x,-z] as [number,number])), points = rings.flat(); return {id: part.id, properties: {...part.properties}, rings, bbox: [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]};});
  return new Map([[record.id, {parts: clippedParts, sourceWitnesses: {kind: review.kind, approvedProposalSha256, baseCrossingProposalSha256, recordId: record.id, sourceRecordSha256: review.record.sourceRecordSha256, horizontalSha256: review.record.horizontalSha256, approach: review.approach, crossingLane: review.crossingLane, sourcePartId: part.id, sourcePartSha256: proposal.sourcePart.sha256, originalSubtype: part.properties.alatyyppi, clippedGeometrySha256: hash(clippedParts), sourcePins, finalWorld: review.world, literalFloorFaces: proposal.literalFaces.map((f: any) => ({id:f.id,sha256:hash(f)})), pendingFinalFullBodyAndTravel: true}}]]);
}
