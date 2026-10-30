import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {repairNewStraightConnectorOvershoot} from './road-connector-repair.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {sourceSha256} from './source-files.ts';
import {carryCurrentNavigation,assertCurrentNavigationCarry,currentCarryIds,type CurrentNavigationCarry} from './current-navigation-carry.ts';

type RepairWitness = ReturnType<typeof repairNewStraightConnectorOvershoot>['witness'];
const hash = (v: unknown) => sourceSha256(JSON.stringify(v));
/** Recover the pre-trim projection from exact reversible records, prove it is
 * source-identical, then rerun the existing bounded repair on current floors.
 * A plain receipt never grants permission to shorten a reviewed source line. */
export function verifyConnectorProjectionRepair(input: {
  accepted: RoadGraph; original: RoadGraph; projected: RoadGraph; witness: RepairWitness;
  newLaneIds: readonly string[]; connectorIds: readonly string[]; newFootwayIds: readonly string[];
  project: (x:number,z:number)=>{height:number}|null;
  projectConnector?: (id:string,x:number,z:number)=>{height:number}|null;
  currentCarry?:{authority:CurrentNavigationCarry;original:RoadGraph;current:RoadGraph};
}) {
  const {accepted,original,projected,witness,newLaneIds,connectorIds,newFootwayIds} = input;
  assert.ok(witness && Array.isArray(witness.changes) && witness.changes.length <= 10000);
  const before = structuredClone(projected), selected = {lanes:new Set(newLaneIds),connectors:new Set(connectorIds),footways:new Set(newFootwayIds)};
  const comparisonSource=input.currentCarry?carryCurrentNavigation(input.currentCarry.authority,input.currentCarry.original,original):original;
  if(input.currentCarry){assertCurrentNavigationCarry(input.currentCarry.authority,input.currentCarry.original,input.currentCarry.current,projected);for(const kind of['lanes','connectors','footways']as const)for(const id of currentCarryIds(input.currentCarry.authority,kind))assert.ok(!selected[kind].has(id),'Current carried record cannot enter connector projection or trim');}
  for(const change of [...witness.changes].reverse()) {
    assert.ok(change.kind==='lanes'||change.kind==='connectors');assert.ok(selected[change.kind].has(change.id),'Repair changes an unselected source record');
    assert.ok(!accepted[change.kind].some(r=>r.id===change.id),'Connector repair cannot replace accepted records');
    assert.equal(hash(change.before),change.beforeSha256);assert.equal(hash(change.after),change.afterSha256);
    const index=before[change.kind].findIndex(r=>r.id===change.id);assert.ok(index>=0);assert.equal(hash(before[change.kind][index]),change.afterSha256,'Connector repair final record drift');
    assert.equal((change.before as {id:string}).id,change.id);assert.equal((change.after as {id:string}).id,change.id);
    (before[change.kind] as unknown[])[index]=structuredClone(change.before);
  }
  const {lanes:ol,connectors:oc,footways:of,...om}=comparisonSource,{lanes:bl,connectors:bc,footways:bf,...bm}=before;assert.deepEqual(bm,om);
  for(const[kind,oldRecords,newRecords]of [['lanes',ol,bl],['connectors',oc,bc],['footways',of,bf]]as const){
    assert.equal(oldRecords.length,newRecords.length);
    for(let i=0;i<oldRecords.length;i++){const old=oldRecords[i]!,fresh=newRecords[i]!;if(isDeepStrictEqual(old,fresh))continue;
      assert.ok(selected[kind].has(old.id),'Projection changes an unselected source record');
      const metadata=(r:typeof old)=>{const value={...r}as Record<string,unknown>;delete value.points;delete value.length;return value;};assert.deepEqual(metadata(fresh),metadata(old));assertHorizontalSubdivision(old.points,fresh.points);
    }
  }
  const curves=witness.reviewedCurves??[];
  for(const value of curves){const review=value as typeof value&{connectorSha256:string;fromLaneSha256:string;toLaneSha256:string;sourceNode:string},connector=original.connectors.find(c=>c.id===review.id);assert.ok(connector);const from=original.lanes.find(l=>l.id===connector.from),to=original.lanes.find(l=>l.id===connector.to);assert.ok(from&&to);assert.equal(hash(connector),review.connectorSha256);assert.equal(hash(from),review.fromLaneSha256);assert.equal(hash(to),review.toLaneSha256);assert.equal(connector.node,review.sourceNode);}
  const repeated=repairNewStraightConnectorOvershoot(accepted,before,newLaneIds,connectorIds,input.project,curves,input.projectConnector);
  assert.deepEqual(repeated.witness,witness,'Bounded connector repair does not reproduce its receipt');assert.deepEqual(repeated.graph,projected,'Bounded connector repair does not reproduce final projected graph');
  return {beforeRepair:before,receipt:{kind:'recomputed-source-identical-connector-projection',originalGraphSha256:hash(original),preRepairGraphSha256:hash(before),projectedGraphSha256:hash(projected),repairSha256:hash(witness),changes:witness.changes.length,junctions:witness.junctions.length}};
}
