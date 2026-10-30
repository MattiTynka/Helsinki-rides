import assert from 'node:assert/strict';
import {readReviewedUdenmaankatuCrossing,type UdenmaankatuCrossingContext,type ReviewedUdenmaankatuSourceAuthority,type ReviewedUdenmaankatuFloorAuthority} from './reviewed-udenmaankatu-crossing.ts';
import type {InheritedHeightPin} from './reviewed-inherited-road-height.ts';

export interface UdenmaankatuCrossingBinding {approval:InheritedHeightPin;provenanceArchive:InheritedHeightPin;sourceMask:InheritedHeightPin}
export interface UdenmaankatuRoadRoles {sourceAuthority:ReviewedUdenmaankatuSourceAuthority;floorAuthority:ReviewedUdenmaankatuFloorAuthority}
/** Source and floor capabilities only. This role never enters a height baseline. */
export function prepareUdenmaankatuCrossing(binding:UdenmaankatuCrossingBinding,context:Omit<UdenmaankatuCrossingContext,'provenanceArchive'|'sourceMask'>){
 assert.deepEqual(Object.keys(binding).sort(),['approval','provenanceArchive','sourceMask']);
 const prepared=readReviewedUdenmaankatuCrossing(binding.approval,{...context,provenanceArchive:binding.provenanceArchive,sourceMask:binding.sourceMask});
 return{...prepared,roles:new Map<string,UdenmaankatuRoadRoles>(prepared.reviewedRecords.map(r=>[r.id,{sourceAuthority:prepared.sourceAuthority,floorAuthority:prepared.floorAuthority}]))};
}
