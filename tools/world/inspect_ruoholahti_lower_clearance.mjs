import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';
import {buildExtraBridgeDeck} from './lib/delivery-extra-bridges-mesh.ts';
import {sourceLowerBridgeAxis,bridgePassageBodyCorridor} from './lib/delivery-bridge-passages.ts';
import {readLayeredSourceParts,sourcePartsForTriangle} from './lib/layered-bridge-source.ts';
import {supportNormal,supportHeight} from './lib/tram-support-repair.ts';
import {sourceSha256,writeSourceJson} from './lib/source-files.ts';
const root='../evidence/ruoholahti-bridges/west-native-banks-v4';
const read=file=>{const bytes=fs.readFileSync(file);return{file,sha256:sourceSha256(bytes),value:JSON.parse(bytes)};};
const profileFile=read(root+'/native-bank-profile.json'),profile=profileFile.value.fit.profile;
const nativeFile=read(root+'/native-bridge-ground-faces.json'),native=nativeFile.value.faces;
const streetsFile=read('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson'),streets=streetsFile.value;
const osmFile=read('../sources/raw-v2/osm/southwest-cumulative-20261029.json'),originFile=read('content/helsinki/world-origin.json');
const axis=sourceLowerBridgeAxis(osmFile.value,739516012,1064603309,11737797449,originFile.value);
const parts=[162839,162853].flatMap(id=>readLayeredSourceParts(streets,[id],streets.features.find(f=>f.properties.osan_id===id).properties.alueen_nimi));
const upper=buildExtraBridgeDeck(profile).faces.filter(f=>f.role==='road'||f.role==='footway').map(f=>f.points);
const polygon=t=>[t.map(v=>[v[0],v[2]])];
const area=polygons=>polygons.reduce((total,poly)=>total+poly.reduce((sum,ring,index)=>sum+(index?-1:1)*Math.abs(ring.reduce((a,p,i)=>{const q=ring[(i+1)%ring.length];return a+p[0]*q[1]-p[1]*q[0];},0))/2,0),0);
const up=native.filter(f=>{try{return supportNormal(f.points)[1]>0&&sourcePartsForTriangle(f.points,parts,f.tag).length;}catch{return false;}});
const coverage=polygonClipping.union(polygon(up[0].points),...up.slice(1).map(f=>polygon(f.points)));
const source=polygonClipping.union(parts[0].rings,...parts.slice(1).map(p=>p.rings));
const results=[];
for(const offsetZ of[1,1.5]){
  const corridor=bridgePassageBodyCorridor(axis.axis.map(([x,z])=>[x,z+offsetZ]),.47);
  let minimumClearance=Infinity,witness,intersections=0;
  for(const face of up){
    const clipped=polygonClipping.intersection(polygon(face.points),corridor);
    if(!clipped.length)continue;
    for(const floor of upper){
      const overlap=polygonClipping.intersection(clipped,polygon(floor));
      for(const poly of overlap)for(const ring of poly)for(const point of ring){
        intersections++;
        const clearance=supportHeight(floor,point)-profile.deckThicknessMetres-supportHeight(face.points,point);
        if(clearance<minimumClearance){minimumClearance=clearance;witness={point,cell:face.cell,triangle:face.triangle,floorN2000:supportHeight(face.points,point)+7.5,deckN2000:supportHeight(floor,point)+7.5};}
      }
    }
  }
  results.push({offsetZ,bodyRadiusMetres:.47,missingNativeArea:area(polygonClipping.difference(corridor,coverage)),outsideSourceArea:area(polygonClipping.difference(corridor,source)),minimumClearance,witness,intersections});
}
const out='../evidence/ruoholahti-bridges/north-lower-clearance-v1';fs.mkdirSync(out,{recursive:false});
const ref=writeSourceJson(out,'clearance-diagnostic.json',{schemaVersion:1,status:'UPWARD_NATIVE_GEOMETRY_DIAGNOSTIC_NOT_WALKABILITY_ACCEPTANCE',inputs:[profileFile,nativeFile,streetsFile,osmFile,originFile].map(({file,sha256})=>({file,sha256})),sourceAxis:axis.proof,producerSha256:sourceSha256(fs.readFileSync(new URL(import.meta.url))),results});
console.log(JSON.stringify({sha256:ref.sha256,results}));
