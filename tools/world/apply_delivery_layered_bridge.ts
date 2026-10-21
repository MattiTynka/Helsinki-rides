// Qualification and bounded application entry point for Hämeentie/Junatie.
// A profile never authorizes a blanket XZ-only cut across stacked surfaces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {decodeSimulationPayload,parseCollisionBundle,type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {buildLayeredLowerField,layeredFloorSampler,layeredAxisAt,layeredRectangle,layeredWorld,correspondingBankS,type LayeredLowerFieldSpec} from './lib/layered-bridge-field.ts';
import {readLayeredSourceParts,qualifyLayeredPhysicalTriangle,triangleMeetsLayeredDomain} from './lib/layered-bridge-source.ts';
import type {ReconstructedBridge} from './lib/bridge-reconstruction.ts';
import {validateReconstructedBridge} from './lib/bridge-reconstruction.ts';
import type {SupportTriangle} from './lib/tram-support-repair.ts';
import {supportNormal} from './lib/tram-support-repair.ts';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
export interface LayeredBridgeProfile {
  schemaVersion:1;id:string;status:string;sourceManifestSha256:string;
  sources:{streetParts:{path:string;sha256:string};osm:{path:string;sha256:string}};
  bridge:ReconstructedBridge;lowerField:LayeredLowerFieldSpec;lowerSourcePartIds:number[];projectedUpperWalkPartIds:number[];projectedUpperRetainingWayIds?:number[];publicationPrefix:string;
}
function checked(root:string,ref:{path:string;bytes?:number;sha256:string}):Uint8Array {
  assert.ok(ref.path&&!path.isAbsolute(ref.path)&&!ref.path.split(/[\\/]/).includes('..'));const p=path.resolve(root,ref.path);assert.ok(p.startsWith(root+path.sep));const bytes=fs.readFileSync(p);if(ref.bytes!==undefined)assert.equal(bytes.length,ref.bytes,'Source payload byte drift');assert.equal(sha(bytes),ref.sha256,'Source payload hash drift');return bytes;
}
export async function qualifyLayeredBridge(world:string,profile:LayeredBridgeProfile,sourceRoot:string){
  world=path.resolve(world);sourceRoot=path.resolve(sourceRoot);const manifestBytes=fs.readFileSync(path.join(world,'manifest.json')),manifest=JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
  assert.equal(profile.schemaVersion,1);assert.equal(sha(manifestBytes),profile.sourceManifestSha256,'Layered bridge source manifest drift');assert.match(profile.publicationPrefix,/^publication\/hameentie-[a-z0-9-]*$/);validateReconstructedBridge(profile.bridge);
  const streets=JSON.parse(Buffer.from(checked(sourceRoot,profile.sources.streetParts)).toString('utf8'));checked(sourceRoot,profile.sources.osm);
  const lowerParts=readLayeredSourceParts(streets,profile.lowerSourcePartIds,'Junatie'),upperParts=readLayeredSourceParts(streets,profile.projectedUpperWalkPartIds,'Hämeentie');
  const rectangle=layeredRectangle(profile.lowerField),bounds=[Math.min(...rectangle.map(p=>p[0]))-20,Math.min(...rectangle.map(p=>p[1]))-20,Math.max(...rectangle.map(p=>p[0]))+20,Math.max(...rectangle.map(p=>p[1]))+20];
  const cells=manifest.cells.filter(c=>{const b=c.collision.boundsXZ??c.boundsXZ;return b[0]<=bounds[2]!&&b[2]>=bounds[0]!&&b[1]<=bounds[3]!&&b[3]>=bounds[1]!;});
  const inventory:any[]=[],allFloors:SupportTriangle[]=[],qualifiedLowerFloors:SupportTriangle[]=[],physicalFiles:any[]=[];
  for(const cell of cells){const stored=checked(world,cell.collision),bytes=await decodeSimulationPayload(stored,cell.collision),bundle=parseCollisionBundle(bytes);physicalFiles.push({cell:cell.id,...cell.collision,actualDecodedSha256:sha(bytes)});
    for(const c of bundle.colliders)for(let i=0;i<c.indices.length/3;i++){
      const points=[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[i*3+k]!*3,c.indices[i*3+k]!*3+3))) as SupportTriangle,tag=bundle.header.surfaceTags[c.triangleTags[i]!]!;
      const q=qualifyLayeredPhysicalTriangle(points,{collider:c.id,triangle:i,group:c.group,tag},profile.lowerField,lowerParts,upperParts);
      if(c.group==='ground'||c.group==='kerbs'){allFloors.push(points);let up=false;try{up=supportNormal(points)[1]>.3;}catch{/* Never treat a degenerate or structural face as a lower floor. */}if(q.sourcePartIds.length&&up)qualifiedLowerFloors.push(points);}
      if(triangleMeetsLayeredDomain(points,profile.lowerField))inventory.push({cell:cell.id,...q});
    }
  }
  const lowerFloor=layeredFloorSampler(qualifiedLowerFloors),upperBankFloor=layeredFloorSampler(allFloors),field=buildLayeredLowerField(profile.lowerField,lowerFloor);
  const bankSamples:any[]=[],bankMissing:any[]=[];
  const first=layeredAxisAt(profile.lowerField.axes[0]!,0)+.001,last=layeredAxisAt(profile.lowerField.axes.at(-1)!,0)-.001;
  for(let s=first;s<=last;s+=.1)for(const t of [profile.lowerField.boundsST[1],profile.lowerField.boundsST[3]]){const mapped=correspondingBankS(profile.lowerField,s,0,t),p=layeredWorld(profile.lowerField,mapped,t),y=lowerFloor(...p),sample={sAtUpperAxis:s,s:mapped,t,x:p[0],z:p[1],y};if(Number.isFinite(y))bankSamples.push(sample);else bankMissing.push({...sample,y:null});}
  const upperBankSamples:any[]=[];for(const s of [-18,42])for(let t=-15.3;t<=16+.0001;t+=.1){const p=layeredWorld(profile.lowerField,s,t),y=upperBankFloor(...p);assert.ok(Number.isFinite(y),'Missing native upper full-width bank');upperBankSamples.push({s,t,x:p[0],z:p[1],y});}
  const witnesses:any[]=[],witnessMissing:any[]=[];for(const axis of profile.lowerField.axes.filter(a=>a.sourceWayIds.length)){const s=layeredAxisAt(axis,0),p=layeredWorld(profile.lowerField,s,0),y=lowerFloor(...p);try{witnesses.push({sourceWayIds:axis.sourceWayIds,x:p[0],z:p[1],oldY:y,targetY:field.target(s,0),newY:field.map([p[0],y,p[1]])[1]});}catch(e){witnessMissing.push({sourceWayIds:axis.sourceWayIds,error:String(e)});}}
  const ambiguous=inventory.filter(q=>q.ambiguity),selected=inventory.filter(q=>q.selected),protectedEntries=inventory.filter(q=>!q.selected);
  return{schemaVersion:1,status:'SOURCE_PROFILE_NOT_APPLIED',sourceManifestSha256:sha(manifestBytes),profileSemanticSha256:sha(JSON.stringify(profile)),physicalFiles,sourcePartAuthority:{lower:lowerParts.map(p=>({id:p.id,name:p.name,tag:p.tag})),projectedUpper:upperParts.map(p=>({id:p.id,name:p.name,tag:p.tag}))},counts:{selected:selected.length,protected:protectedEntries.length,ambiguous:ambiguous.length,qualifiedLowerFloors:qualifiedLowerFloors.length,bankSamples:bankSamples.length,bankMissing:bankMissing.length,upperBankSamples:upperBankSamples.length},lowerBanks:{samples:bankSamples,missing:bankMissing},upperBanks:{samples:upperBankSamples},humpWitnesses:witnesses,witnessMissing,ambiguities:ambiguous,inventory,applicationReady:false,requiredBeforeApplication:['Resolve every overlapping projected-upper/lower source sheet by exact source inventory and canonical lower-surface retention.','Compile exact visual selectors matching the qualified physical source geometry at every LOD; protect architecture and all unselected lower floors.','Numerically prove all repaired full-width bank joins, physical deck/underpass clearance, and fallback-field outside-bit identity.']};
}
async function main(){const {values}=parseArgs({options:{source:{type:'string'},profile:{type:'string'},out:{type:'string'},'source-root':{type:'string',default:'.'},qualify:{type:'boolean'},apply:{type:'boolean'},release:{type:'string'}}});assert.ok(values.source&&values.profile&&values.out&&Boolean(values.qualify)!==Boolean(values.apply),'Use exactly one of --qualify/--apply with --source WORLD --profile PROFILE --out FRESH [--source-root EXPORT].');assert.ok(!fs.existsSync(values.out),'Output must be new');if(values.apply){assert.ok(values.release,'--apply requires --release');const {applyLayeredBridgeWorld}=await import('./lib/layered-bridge-apply.ts');console.log(JSON.stringify(await applyLayeredBridgeWorld({world:values.source,profileFile:values.profile,sourceRoot:values['source-root']!,out:values.out,release:values.release})));return;}const profileBytes=fs.readFileSync(values.profile),profile=JSON.parse(profileBytes.toString('utf8')) as LayeredBridgeProfile,result={...await qualifyLayeredBridge(values.source,profile,values['source-root']!),profileSha256:sha(profileBytes)};fs.mkdirSync(path.dirname(values.out),{recursive:true});fs.writeFileSync(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,applicationReady:result.applicationReady,counts:result.counts,humpWitnesses:result.humpWitnesses,witnessMissing:result.witnessMissing}));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
