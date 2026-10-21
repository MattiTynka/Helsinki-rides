import assert from 'node:assert/strict';
/** Keep exact municipal geometry and only properties consumed by city/soil producers. */
export function projectPublicCitySurvey(source:any,kind:'street-parts'|'footprints'){
  assert.ok(Array.isArray(source.features));const keys=kind==='street-parts'?['osan_id','id','paatyyppi','alatyyppi','materiaali','alueen_nimi','aluetieto']:['vtj_prt','id'];
  return{type:'FeatureCollection',crs:{type:'name',properties:{name:'EPSG:3879'}},attribution:'© City of Helsinki, CC BY4.0; exact geometry with unused/editor properties removed',features:source.features.map((feature:any)=>{assert.ok(feature.geometry&&['Polygon','MultiPolygon'].includes(feature.geometry.type));return{type:'Feature',geometry:feature.geometry,properties:Object.fromEntries(keys.filter(key=>feature.properties[key]!==undefined).map(key=>[key,feature.properties[key]]))};})};
}
