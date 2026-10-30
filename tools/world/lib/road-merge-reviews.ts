import assert from 'node:assert/strict';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from './geometry.ts';
import {RoadCollisionSupport, isPublicWalkingGroundTag, type RoadSupportTriangle, type RoadSourceElement, type RoadMergeSelection, type ReviewedRecordSurface} from './expansion-road-merge.ts';
import type {QualifiedFootwayAuthority} from './expansion-footway-merge.ts';
import {prepareBridgeLevelProjectors, literalLevelSupport} from './bridge-road-floor.ts';
import {prepareReviewedWalkingProjectors} from './reviewed-walking-floor.ts';
import {qualifyReviewedTransitCrossing, qualifyReviewedTransitTurn, qualifyReviewedTransitContinuation, type ReviewedTransitCrossing, type ReviewedTransitTurn, type ReviewedTransitContinuation} from './reviewed-transit-crossing.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {sourceSha256, sourceFile} from './source-files.ts';
import type {SerializedFloorWorld} from './serialized-road-floor.ts';
import {bridgePassageBodyCorridor} from './delivery-bridge-passages.ts';
import type {validateNorthernFootwayRegistration} from './northern-footway-registration.ts';
import {verifyConnectorProjectionRepair} from './connector-projection-authority.ts';
import {reviewedSheetSupport} from './reviewed-level-support.ts';
import {clipReviewedBridgeRoadSources} from './reviewed-bridge-source.ts';
import {prepareReviewedBridgeWalkingSource} from './bridge-walking-source.ts';
import {EAST_BRIDGE_WALKING_SEAM_PUBLICATION, type ReviewedBridgeWalkingSeam} from './reviewed-bridge-walking-seam.ts';

interface Pin {file: string; sha256: string}
export interface RoadMergeReviewInputs {
  bridgeLevelInventory?: Pin;
  walkingSurfaceReviews?: Pin[];
  transitCrossingReviews?: {review: Pin; approvedProposal: Pin; baseCrossingProposal?: Pin}[];
}
type Support = Pick<RoadCollisionSupport, 'at'>;
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
const inside = (rings: readonly (readonly (readonly number[])[])[], x: number, z: number) => pointInPolygon([x, z], rings as [number, number][][]);

/** Qualification may cover both directions while the connected route selects one.
 * Eligibility of an unused lane never adds that lane or any connector. */
export function selectQualifiedTransitLaneSurfaces(qualified: ReadonlyMap<string, ReviewedRecordSurface>, selectedLanes: ReadonlySet<string>) {
  const selected = new Map([...qualified].filter(([id]) => selectedLanes.has(id)));
  assert.ok(selected.size > 0, 'Unused reviewed crossing proposal');
  return {selected, unselectedEligibleIds: [...qualified.keys()].filter(id => !selectedLanes.has(id))};
}

/** All exceptions are recomputed from hash-bound original source records and
 * literal final HCOL. Projection alone cannot grant source or level eligibility. */
export function prepareRoadMergeReviews(input: RoadMergeReviewInputs, context: {
  world: SerializedFloorWorld;
  cells: {cell: string; storedSha256: string; decodedSha256: string}[];
  triangles: readonly RoadSupportTriangle[];
  originalCandidate: RoadGraph;
  projectedCandidate: RoadGraph;
  originalCandidatePin: Pin;
  sourcePins: {osmSha256: string; streetPartsSha256: string};
  parts: readonly LocalPolygon[];
  osm: {elements: RoadSourceElement[]};
  selection: RoadMergeSelection;
  connectorProjection?: {accepted: RoadGraph; witness: Parameters<typeof verifyConnectorProjectionRepair>[0]['witness']; newLaneIds: string[]; connectorIds: string[]; newFootwayIds: string[]; currentCarry?:Parameters<typeof verifyConnectorProjectionRepair>[0]['currentCarry']};
  read: (pin: Pin, cap?: number) => Buffer;
}) {
  const {world, cells, triangles, originalCandidate, projectedCandidate, originalCandidatePin, sourcePins, parts, osm, selection, read} = context;
  const roadDefault = new RoadCollisionSupport(triangles), walkDefault = new RoadCollisionSupport(triangles, isPublicWalkingGroundTag);
  const bridge = input.bridgeLevelInventory ? prepareBridgeLevelProjectors(input.bridgeLevelInventory, world, triangles, originalCandidate, read) : undefined;
  const baseProject=(x:number,z:number)=>roadDefault.project(x,z);
  const connectorProjection=context.connectorProjection?verifyConnectorProjectionRepair({...context.connectorProjection,original:originalCandidate,projected:projectedCandidate,project:baseProject,...(bridge?{projectConnector:(id:string,x:number,z:number)=>bridge.projectFor('connector',id,baseProject)(x,z)}:{})}):undefined;
  const reviewedRoadSupports = new Map<string, Support>(), reviewedFootways = new Map<string, QualifiedFootwayAuthority>(), reviewedSurfaces = new Map<string, ReviewedRecordSurface>();
  const ways = new Map(osm.elements.filter(e => e.type === 'way').map(e => [e.id, e]));
  const selectedLanes = new Set(selection.lanes.map(r => r.id)), selectedConnectors = new Set(selection.connectors.map(r => r.id)), selectedWalks = new Set(selection.footways?.map(r => r.id) ?? []);
  const records: unknown[] = [], unselectedTransitEligibility: {review: Pin; ids: string[]}[] = [];
  function bindProjection(kind: 'lane' | 'connector' | 'footway', id: string) {
    const key = kind === 'lane' ? 'lanes' : kind === 'connector' ? 'connectors' : 'footways';
    const before = originalCandidate[key].find(r => r.id === id), after = projectedCandidate[key].find(r => r.id === id); assert.ok(before && after);
    const metadata = (r: typeof before) => {const value = {...r} as Record<string, unknown>; delete value.points; delete value.length; return value;};
    assert.deepEqual(metadata(before), metadata(after), 'Reviewed source record metadata changed during projection');
    const checked=connectorProjection?.beforeRepair[key].find(r=>r.id===id)??after;
    assertHorizontalSubdivision(before.points, checked.points);
    records.push({kind, id, originalRecordSha256: hash(before), projectedRecordSha256: hash(after), ...(connectorProjection?{preRepairHorizontalPiecewiseGeometryPreserved:true,finalBoundedConnectorRepairRecomputed:true}:{horizontalPiecewiseGeometryPreserved:true})});
  }
  const stair = input.walkingSurfaceReviews ? prepareReviewedWalkingProjectors(input.walkingSurfaceReviews, world, triangles, originalCandidate, read) : undefined;
  for (const [id, reviewed] of stair?.records ?? []) {
    if (!selectedWalks.has(id)) continue; bindProjection('footway', id);
    const receipt = stair!.receipt.reviews.find(r => r.id === id)!;
    const support: Support = {at: (x, y, z) => inside(receipt.corridor[0]!, x, z) ? reviewed.support.at(x, y, z) : walkDefault.at(x, y, z)};
    reviewedFootways.set(id, {sourceWaySha256: receipt.sourceWaySha256, support, receipt});
  }
  if (bridge) {
    assert.equal(bridge.inventory.osm.sha256, sourcePins.osmSha256); assert.equal(bridge.inventory.sourceParts.sha256, sourcePins.streetPartsSha256);
    const levelSupports = new Map(['upperRoad', 'upperWalking', 'northernLower'].map(level => [level, literalLevelSupport(triangles, bridge.inventory[level], level !== 'upperRoad')]));
    for (const ref of bridge.inventory.records) {
      if (!(ref.kind === 'lane' ? selectedLanes : ref.kind === 'connector' ? selectedConnectors : selectedWalks).has(ref.id)) continue;
      bindProjection(ref.kind, ref.id);
      const native = levelSupports.get(ref.level)!;
      const sourcePartIds: Set<string> = new Set<string>(bridge.inventory[ref.level].flatMap((t: {sourcePartIds: number[]}) => t.sourcePartIds.map(String)));
      const domain = parts.filter(p => sourcePartIds.has(p.id)); assert.equal(domain.length, sourcePartIds.size, 'Selected level source parts missing');
      const registration: ReturnType<typeof validateNorthernFootwayRegistration> | undefined = bridge.registrations.get(ref.id);
      const registeredDocument: any = registration ? JSON.parse(read(ref.registration, 32 * 1024 * 1024).toString()) : undefined;
      const registeredCorridor = registeredDocument ? bridgePassageBodyCorridor(registeredDocument.axis, registeredDocument.proof.bodyRadiusMetres) : [];
      if (registeredDocument) assert.deepEqual(registeredCorridor, registeredDocument.proof.corridor, 'Registered lower walking corridor changed');
      const inLevelDomain = (x: number, z: number) => ref.level === 'northernLower' ? registeredCorridor.some(p => inside(p, x, z)) : domain.some(p => pointInPolygon([x, -z], p.rings));
      const existing = ref.kind === 'footway' ? reviewedFootways.get(ref.id)?.support ?? walkDefault : roadDefault;
      const support: Support = ref.level==='northernLower'?{at:(x,y,z)=>inLevelDomain(x,z)?native.at(x,y,z):existing.at(x,y,z)}:reviewedSheetSupport(native,existing);
      if (ref.kind === 'footway') {
        const way = ways.get(Number(ref.id.slice(1))); assert.ok(way?.nodes && way.tags);
        const isBridge = !!way.tags.bridge && way.tags.bridge !== 'no';
        if (isBridge) assert.equal(ref.level, 'upperWalking');
        const walkingSource = ref.level === 'upperWalking' ? prepareReviewedBridgeWalkingSource({recordId: ref.id, parts: domain, faces: bridge.inventory.upperWalking,
          additions: bridge.walkingAdditions.map((addition: {authority: ReviewedBridgeWalkingSeam; proof: {profileSha256: string}}) => ({authority: addition.authority,
            profileBytes: read({file: sourceFile(world.directory, EAST_BRIDGE_WALKING_SEAM_PUBLICATION), sha256: addition.proof.profileSha256}, 128 * 1024), baseProfileBytes: read(bridge.inventory.profile)}))}) : undefined;
        reviewedFootways.set(ref.id, {sourceWaySha256: hash(way), support,
          ...(walkingSource ? {municipalBridgeSource: walkingSource.authority} : {}),
          ...(isBridge ? {bridge: {wayId: way.id, layer: Number(way.tags.layer ?? 0)}} : {}),
          ...(registration ? {sourcePoints: registration.points, sourceNodePoints: registration.nodePoints} : {}),
          receipt: {level: ref.level, inventory: input.bridgeLevelInventory, sourceRecord: ref, registration: registration?.receipt, stairs: reviewedFootways.get(ref.id)?.receipt, municipalBridgeSource: walkingSource?.receipt, selectedNativeFaces: bridge.inventory[ref.level].map((f: RoadSupportTriangle) => f.id), fallbackOnlyOutsideReviewedSourceDomain: true}});
      } else {
        reviewedRoadSupports.set(ref.id, support);
        const bridgeParts=clipReviewedBridgeRoadSources(domain,bridge.inventory.upperRoad);
        if(bridgeParts.length){assert.ok(!reviewedSurfaces.has(ref.id));reviewedSurfaces.set(ref.id,{parts:[],bridgeParts,sourceWitnesses:{kind:'literal-source-profile-bridge-road-intersection',recordId:ref.id,inventory:input.bridgeLevelInventory,profileSha256:bridge.receipt.profileSha256,sourceParts:domain.filter(p=>p.properties.paatyyppi==='Silta').map(p=>({id:p.id,sha256:hash(p)})),clippedParts:bridgeParts.map(p=>({id:p.id,sha256:hash(p)}))}});}
      }
    }
  }
  assert.ok((input.transitCrossingReviews?.length ?? 0) <= 8);
  for (const entry of input.transitCrossingReviews ?? []) {
    const review = JSON.parse(read(entry.review, 2 * 1024 * 1024).toString()) as ReviewedTransitCrossing | ReviewedTransitTurn | ReviewedTransitContinuation;
    const currentCells = review.world.cells.map(ref => {const cell = cells.find(c => c.cell === ref.cell); assert.ok(cell, 'Reviewed crossing final cell is outside loaded authority'); return {cell: cell.cell, storedSha256: cell.storedSha256, decodedSha256: cell.decodedSha256};});
    const common = {approvedProposalBytes: read(entry.approvedProposal, 2 * 1024 * 1024), sourcePins: {...sourcePins, candidateRoadsSha256: originalCandidatePin.sha256}, floor: {manifestSha256: world.manifestSha256, cells: currentCells, triangles}, parts, ways};
    if (review.kind === 'source-bound-public-transit-turn') {
      assert.ok(entry.baseCrossingProposal);
      const record = originalCandidate.connectors.find(r => r.id === review.record.id), approach = originalCandidate.lanes.find(r => r.id === review.approach.id), crossingLane = originalCandidate.lanes.find(r => r.id === review.crossingLane.id); assert.ok(record && approach && crossingLane);
      const qualified = qualifyReviewedTransitTurn({...common, review, record, approach, crossingLane, baseCrossingProposalBytes: read(entry.baseCrossingProposal, 2 * 1024 * 1024)});
      bindProjection('lane', approach.id); bindProjection('lane', crossingLane.id);
      for (const [id, surface] of qualified) {assert.ok(selectedConnectors.has(id) && selectedLanes.has(approach.id) && selectedLanes.has(crossingLane.id) && !reviewedSurfaces.has(id), 'Unused or duplicate reviewed transit turn'); bindProjection('connector', id); reviewedSurfaces.set(id, surface);}
    } else if (review.kind === 'source-bound-public-transit-continuation') {
      assert.ok(entry.baseCrossingProposal);
      const record=originalCandidate.connectors.find(r=>r.id===review.record.id),crossingLane=originalCandidate.lanes.find(r=>r.id===review.crossingLane.id),ordinaryLane=originalCandidate.lanes.find(r=>r.id===review.ordinaryLane.id);assert.ok(record&&crossingLane&&ordinaryLane);
      const qualified=qualifyReviewedTransitContinuation({...common,review,record,crossingLane,ordinaryLane,baseCrossingProposalBytes:read(entry.baseCrossingProposal,2*1024*1024)});
      assert.ok(selectedLanes.has(crossingLane.id)&&selectedLanes.has(ordinaryLane.id),'Continuation requires both selected adjoining source lanes');
      bindProjection('lane',crossingLane.id);bindProjection('lane',ordinaryLane.id);
      for(const[id,surface]of qualified){assert.ok(selectedConnectors.has(id)&&!reviewedSurfaces.has(id),'Unused or duplicate reviewed transit continuation');bindProjection('connector',id);reviewedSurfaces.set(id,surface);}
    } else {
      assert.equal(review.kind, 'source-bound-public-transit-crossing'); assert.ok(!entry.baseCrossingProposal);
      const qualified = qualifyReviewedTransitCrossing({...common, review, records: originalCandidate.lanes});
      const subset=selectQualifiedTransitLaneSurfaces(qualified,selectedLanes);unselectedTransitEligibility.push({review:entry.review,ids:subset.unselectedEligibleIds});
      for (const [id, record] of subset.selected) {assert.ok(!reviewedSurfaces.has(id), 'Duplicate reviewed crossing lane'); bindProjection('lane', id); reviewedSurfaces.set(id, record);}
    }
  }
  return {reviewedRoadSupports, reviewedFootways, reviewedSurfaces, receipt: {schemaVersion: 1, sourceWorld: world, originalCandidateRoads: originalCandidatePin, sourcePins, records, bridge: bridge?.receipt, walkingSurfaces: stair?.receipt, ...(connectorProjection?{connectorProjection:connectorProjection.receipt}:{}), transitCrossingReviews: input.transitCrossingReviews ?? [], unselectedTransitEligibility, finalPhysicalAndTravelGatesStillRequired: true}};
}
