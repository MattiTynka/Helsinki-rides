import assert from 'node:assert/strict';
import type {GameplayBundle, RoadGraph} from '../../../packages/world-schema/src/index.ts';
import type {LocalPolygon} from './geometry.ts';
import type {RoadSourceElement, RoadSupportTriangle} from './expansion-road-merge.ts';
import {sourceSha256} from './source-files.ts';
import {qualifyReviewedEhrenstromLaneRegistration} from './reviewed-ehrenstrom-lane-registration.ts';
import {qualifyReviewedEhrenstromSourceJoin} from './reviewed-ehrenstrom-source-join.ts';

interface FileBinding {file:string;sha256:string}
export interface EhrenstromNavigationBinding {
  review:FileBinding; registration:FileBinding; projectionReceipt:FileBinding;
  authoringGraph:FileBinding; projectedGraph:FileBinding;
  joinProposal:FileBinding; joinQualification:FileBinding;
}

/** Reconstruct both opaque authorities from their literal reviewed inputs. The candidate
 * remains subject to ordinary source, floor, footprint and directed-connectivity gates. */
export function prepareEhrenstromNavigation(binding:EhrenstromNavigationBinding,input:{
  accepted:RoadGraph; acceptedCoverage:Pick<GameplayBundle,'playArea'|'supportedArea'>;
  candidate:RoadGraph; selectedLaneIds:readonly string[];
  sourcePins:{streetPartsSha256:string;osmSha256:string};vehicleDefinitionsSha256:string;
  osm:{elements:RoadSourceElement[]};parts:readonly LocalPolygon[];
  floor:{manifestSha256:string;cells:readonly {cell:string;storedSha256:string;decodedSha256:string;decodedBytes:number}[];triangles:readonly RoadSupportTriangle[]};
  read:(binding:FileBinding,cap?:number)=>Uint8Array;
}) {
  assert.deepEqual(Object.keys(binding).sort(),['review','registration','projectionReceipt','authoringGraph','projectedGraph','joinProposal','joinQualification'].sort());
  const pins:{binding:FileBinding;sha256:string;cap:number}[]=[];
  const read=(pin:FileBinding,cap:number)=>{assert.deepEqual(Object.keys(pin).sort(),['file','sha256']);assert.match(pin.sha256,/^[a-f0-9]{64}$/);const bytes=input.read(pin,cap);assert.ok(bytes.length>0&&bytes.length<=cap);assert.equal(sourceSha256(bytes),pin.sha256);pins.push({binding:pin,sha256:pin.sha256,cap});return bytes;};
  const registration=qualifyReviewedEhrenstromLaneRegistration({reviewBytes:read(binding.review,2_000_000),registrationBytes:read(binding.registration,4_000_000),projectionReceiptBytes:read(binding.projectionReceipt,16_000_000),authoringGraphBytes:read(binding.authoringGraph,64_000_000),projectedGraphBytes:read(binding.projectedGraph,64_000_000),accepted:input.accepted,acceptedCoverage:input.acceptedCoverage,sourcePins:input.sourcePins,vehicleDefinitionsSha256:input.vehicleDefinitionsSha256});
  const id=registration.registeredLane.id;
  assert.ok(input.selectedLaneIds.includes(id),'Unused reviewed Ehrenstrom registration');
  const record=input.candidate.lanes.find(lane=>lane.id===id);assert.ok(record,'Reviewed Ehrenstrom lane is absent');
  const sourceWay=input.osm.elements.find(element=>element.type==='way'&&element.id===record.wayId);assert.ok(sourceWay);
  const join=qualifyReviewedEhrenstromSourceJoin({proposalBytes:read(binding.joinProposal,4_000_000),qualificationBytes:read(binding.joinQualification,8_000_000),sourcePins:input.sourcePins,record,registrationAuthority:registration.authority,sourceWay,parts:input.parts,floor:input.floor});
  return {sourceJoins:new Map([[id,[join.authority]]]),receipt:{schemaVersion:1,kind:'literal-ehrenstrom-new-lane-and-existing-source-join',bindings:binding,registration:registration.witness,sourceJoin:join.witness},verifyInputs:()=>{for(const pin of pins)assert.equal(sourceSha256(input.read(pin.binding,pin.cap)),pin.sha256,'Ehrenstrom input changed during qualification');}};
}
