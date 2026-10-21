import assert from'node:assert/strict';
import{bindDeliveryWitnessSource,reconstructDeliveryWitnessPoints,deliveryWitnessCoordinateStream,type DeliveryWitnessSourceContext}from'./delivery-city-road-witness-source.ts';
/** Lossless publication table. Dictionary encoding removes repeated field names
 * and source/support identities; every original numeric witness stays literal.
 * This changes proof representation, never graph precision or a qualification. */
export function encodeDeliveryRoadCensus(rows:readonly Record<string,any>[],context?:DeliveryWitnessSourceContext){
 const source=context?bindDeliveryWitnessSource(context):null,points=context?reconstructDeliveryWitnessPoints(context):null;
 if(points)for(const row of rows){const reconstructed:readonly number[]|undefined=points.get(row.kind+'/'+row.id)?.[row.index];assert.ok(reconstructed,'Witness source reference missing');assert.deepEqual(reconstructed,row.before,'Deterministic source witness changed an F64 coordinate');}
 const fields=[...new Set(rows.flatMap(r=>Object.keys(r)))].filter(f=>!context||f!=='before'),dictionaries:Record<string,unknown[]>={},maps=new Map<string,Map<string,number>>();
 for(const field of ['kind','id','sourceWayIds','status','authorities']){dictionaries[field]=[];maps.set(field,new Map());}
 dictionaries.chosenSupport=[];const supports=new Map<string,number>();
 const table=rows.map(row=>fields.map(field=>{if(!Object.hasOwn(row,field))return null;const value=row[field];if(field==='chosen'&&value!==null){const{height,...support}=value,key=JSON.stringify(support);let index=supports.get(key);if(index===undefined){index=dictionaries.chosenSupport!.length;supports.set(key,index);dictionaries.chosenSupport!.push(support);}return[context&&Object.is(height,row.afterY)?null:height,index];}const dictionary=dictionaries[field];if(!dictionary)return value;const key=JSON.stringify(value),map=maps.get(field)!;let index=map.get(key);if(index===undefined){index=dictionary.length;map.set(key,index);dictionary.push(value);}return index;}));
 const presence=rows.map(row=>fields.reduce((mask,f,i)=>Object.hasOwn(row,f)?mask+2**i:mask,0));assert.ok(fields.length<=32,'Census field presence bitset exceeded');
 return{encoding:context?'lossless-source-knot-field-table-v2':'lossless-field-table-v1',fields,dictionaries,presence,rows:table,...(source?{coordinateSource:{...source,stream:deliveryWitnessCoordinateStream(rows.map(row=>row.before))}}:{})};
}
export function decodeDeliveryRoadCensus(encoded:ReturnType<typeof encodeDeliveryRoadCensus>,context?:DeliveryWitnessSourceContext){
 assert.ok(encoded.encoding==='lossless-field-table-v1'||encoded.encoding==='lossless-source-knot-field-table-v2');
 const rows=encoded.rows.map((row,i)=>Object.fromEntries(encoded.fields.flatMap((field,k)=>{if(!(Math.floor(encoded.presence[i]!/2**k)%2))return[];const value=row[k],decoded=field==='chosen'&&value!==null?{...encoded.dictionaries.chosenSupport![(value as number[])[1]!]as object,height:(value as number[])[0]}:encoded.dictionaries[field]?encoded.dictionaries[field]![value as number]:value;return[[field,decoded]];})));
 if(encoded.encoding==='lossless-source-knot-field-table-v2'){
  assert.ok(context&&encoded.coordinateSource,'Pinned source context required for witness reconstruction');const{stream,...binding}=encoded.coordinateSource;assert.deepEqual(bindDeliveryWitnessSource(context),binding,'Witness source, masks or reconstruction algorithm changed');const points=reconstructDeliveryWitnessPoints(context);
  for(const row of rows){if(row.chosen?.height===null){assert.ok(Number.isFinite(row.afterY),'Chosen native height reference has no literal afterY');row.chosen.height=row.afterY;}assert.ok(!Object.hasOwn(row,'before'));assert.ok(Number.isSafeInteger(row.index)&&row.index>=0,'Corrupt witness index');const point=points.get(row.kind+'/'+row.id)?.[row.index];assert.ok(point,'Corrupt source witness reference');row.before=[...point];}
  assert.deepEqual(deliveryWitnessCoordinateStream(rows.map(row=>row.before)),stream,'Reconstructed full F64 witness stream differs');
 }
 return rows;
}
