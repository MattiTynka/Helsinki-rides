import type {RoadCollisionSupport} from './expansion-road-merge.ts';

/** A level selector owns only its literal floor footprint. Municipal approach
 * polygons may extend far beyond the authored sheet and cannot define its level.
 * Inside the sheet a wrong height remains unsupported; never retry the lower floor. */
export function reviewedSheetSupport(sheet: Pick<RoadCollisionSupport,'at'|'project'>, fallback: Pick<RoadCollisionSupport,'at'>) {
  return {at:(x:number,y:number,z:number)=>sheet.project(x,z)===null?fallback.at(x,y,z):sheet.at(x,y,z)};
}
