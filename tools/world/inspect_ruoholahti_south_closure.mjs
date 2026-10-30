import assert from 'node:assert/strict';
import fs from 'node:fs';
import {extraBridgeBankSegments,extraBridgeBankHeight,extraBridgeLocal,extraBridgeWorld} from './lib/delivery-extra-bridges-source.ts';
import {readLayeredSourceParts} from './lib/layered-bridge-source.ts';
import {buildExtraBridgeDeck} from './lib/delivery-extra-bridges-mesh.ts';
import {layeredFloorSampler} from './lib/layered-bridge-field.ts';
import {sourceSha256,writeSourceJson} from './lib/source-files.ts';
const out=process.argv[2];assert.ok(out&&!fs.existsSync(out));
const read=file=>{const b=fs.readFileSync(file);return{file,sha256:sourceSha256(b),value:JSON.parse(b)}};
const p=read('../evidence/ruoholahti-bridges/west-native-banks-v4/native-bank-profile.json'),n=read('../evidence/ruoholahti-bridges/west-native-banks-v4/native-bridge-ground-faces.json'),st=read('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson');
const profile=p.value.fit.profile,parts=readLayeredSourceParts(st.value,[41062],'Selkämerenkatu'),frame={origin:profile.frame.origin,direction:[profile.frame.direction[1],-profile.frame.direction[0]]},upper=buildExtraBridgeDeck(profile).faces.filter(f=>f.role==='road'||f.role==='footway').map(f=>f.points),negative=layeredFloorSampler(upper.map(t=>t.map(v=>[v[0],-v[1],v[2]])));
const sections=[];for(const s of[-8.4,-8.3,-8.2,-8,-7.8,-7.5,-7,6,6.5,6.8,7]){
 const segments=extraBridgeBankSegments(frame,s,n.value.faces,parts.map(p=>({...p,role:'walk'}))),samples=[];
 for(let t=25.4;t<=29.25;t+=.1){const[x,z]=extraBridgeWorld(frame,s,t);let native=null,error=null;try{native=extraBridgeBankHeight(segments,t,'walk');}catch(e){error=e.message;}const top=-negative(x,z);samples.push({t,x,z,nativeN2000:native===null?null:native+7.5,upperN2000:Number.isFinite(top)?top+7.5:null,clearance:native!==null&&Number.isFinite(top)?top-profile.deckThicknessMetres-native:null,error});}
 sections.push({s,segments,samples});
}
fs.mkdirSync(out);const ref=writeSourceJson(out,'south-closure-sections.json',{status:'DIAGNOSTIC_ONLY_NO_GATE_AUTHORED',inputs:[p,n,st].map(({file,sha256})=>({file,sha256})),frame,sourcePartId:41062,partLocalRings:parts.map(p=>p.rings.map(r=>r.map(v=>extraBridgeLocal(frame,v)))),sections});
console.log(JSON.stringify({sha256:ref.sha256,sections:sections.map(s=>({s:s.s,segments:s.segments.length,native: s.samples.filter(v=>v.nativeN2000!==null).length,roof:s.samples.filter(v=>v.upperN2000!==null).length,minimumClearance:Math.min(...s.samples.flatMap(v=>v.clearance===null?[]:[v.clearance])),maximumClearance:Math.max(...s.samples.flatMap(v=>v.clearance===null?[]:[v.clearance]))}))}));
