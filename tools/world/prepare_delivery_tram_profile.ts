// Publishable ODbL extraction of actual mapped tram axes; no road-offset tracks.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {geodeticToGk25,type WorldManifest} from '../../packages/world-schema/src/index.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export function prepareDeliveryTramProfile(options:{world:string;osm:string;ledger:string;existingProfiles:string[];scope:string;out:string;existingTailWayIds?:number[]}){
 const read=(file:string)=>fs.readFileSync(file),json=(file:string)=>JSON.parse(read(file).toString());
 const out=path.resolve(options.out);assert.ok(!fs.existsSync(out),'Fresh public tram profile required');
 const manifestBytes=read(path.join(options.world,'manifest.json')),m=JSON.parse(manifestBytes.toString()) as WorldManifest,rawBytes=read(options.osm),raw=JSON.parse(rawBytes.toString()),ledger=json(options.ledger),scopeBytes=read(options.scope),scope=JSON.parse(scopeBytes.toString()).playArea;
 assert.ok(Object.values(ledger.snapshots??{}).some((s:any)=>s.sha256===sha(rawBytes)),'OSM extraction lacks pinned acquisition ledger');
 assert.ok(scope&&[scope.minX,scope.minZ,scope.maxX,scope.maxZ].every(Number.isFinite));
 const sourceRoot=fileURLToPath(new URL('../../',import.meta.url)),publicSourcePath=(file:string)=>{const relative=path.relative(sourceRoot,path.resolve(file));return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)?relative.split(path.sep).join('/'):path.basename(file);};
 const prior=options.existingProfiles.map(file=>({file:publicSourcePath(file),sha256:sha(read(file)),profile:json(file)}));
 const existing=new Set<number>(prior.flatMap(p=>p.profile.tracks.map((t:any)=>t.wayId))),nodes=new Map<number,any>(raw.elements.filter((e:any)=>e.type==='node').map((e:any)=>[e.id,e]));
 const existingTails=new Set(options.existingTailWayIds??[]);assert.equal(existingTails.size,(options.existingTailWayIds??[]).length,'Duplicate existing-ribbon target');for(const id of existingTails)assert.ok(Number.isSafeInteger(id)&&existing.has(id),'Existing-ribbon target is not an accepted source way');
 const project=(n:any)=>{const [e,north]=geodeticToGk25(n.lat,n.lon);return{nodeId:n.id,x:e-m.origin.originProjected[0],z:-(north-m.origin.originProjected[1])};};
 const clippedLength=(a:any,b:any)=>{let lo=0,hi=1;for(const [p,q]of[[-(b.x-a.x),a.x-scope.minX],[b.x-a.x,scope.maxX-a.x],[-(b.z-a.z),a.z-scope.minZ],[b.z-a.z,scope.maxZ-a.z]]){if(p===0){if(q!<0)return 0;}else{const t=q!/p!;if(p!<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);}}return lo<hi?(hi-lo)*Math.hypot(b.x-a.x,b.z-a.z):0;};
 const selected:any[]=[],context:any[]=[],excluded:any[]=[],ways:any[]=[];
 for(const way of raw.elements.filter((e:any)=>e.type==='way'&&e.tags?.railway==='tram')){
  const points=way.nodes.map((id:number)=>{const n=nodes.get(id);assert.ok(n,`Missing source tram node${id}`);return project(n);});
  const renderedAxisMetres=points.slice(1).reduce((sum:number,p:any,i:number)=>sum+clippedLength(points[i],p),0),track={wayId:way.id,tags:way.tags,points,renderedAxisMetres},inside=renderedAxisMetres>0;
  let reason=existing.has(way.id)&&!existingTails.has(way.id)?'EXISTING_WAY_PRESERVED':!inside?'OUTSIDE_PLAYABLE_SCOPE':way.tags.tunnel&&way.tags.tunnel!=='no'?'TUNNEL_NOT_SURFACE':way.tags.gauge&&way.tags.gauge!=='1000'?'UNQUALIFIED_GAUGE':way.tags.tracks&&way.tags.tracks!=='1'?'MULTITRACK_AXIS':null;
  if(reason){excluded.push({wayId:way.id,reason});if(existing.has(way.id)){context.push(track);ways.push(way);}continue;}
  assert.ok(!way.tags.layer||['0','1'].includes(way.tags.layer),'Unqualified vertical track layer');
  selected.push({...track,role:existingTails.has(way.id)?'uncovered-existing-ribbon':'new-source-way',...(way.tags.bridge==='yes'||way.tags.layer==='1'?{deckAuthority:{method:'matching-rendered-and-collision-ground',maximumJoinDiscontinuityMetres:.02,bankProbeMetres:.001,denseProfileSpacingMetres:.25,straightBankPlaneIsNotAuthority:true}}:{})});ways.push(way);
 }
 assert.ok(selected.length,'No new source tram tracks');
 assert.equal(selected.filter(t=>t.role==='uncovered-existing-ribbon').length,existingTails.size,'An existing-ribbon target is absent or outside the playable surface scope');
 const nodeIds=new Set<number>(ways.flatMap(w=>w.nodes)),extract={version:0.6,generator:'Helsinki-rides source-bound tram extraction',copyright:'Copyright OpenStreetMap contributors',license:'https://opendatacommons.org/licenses/odbl/1-0/',
  elements:[...nodeIds].sort((a,b)=>a-b).map(id=>{const n=nodes.get(id);return{type:'node',id,lat:n.lat,lon:n.lon};}).concat(ways.sort((a,b)=>a.id-b.id).map(w=>({type:'way',id:w.id,nodes:w.nodes,tags:w.tags})) as any)};
 const extractBytes=Buffer.from(JSON.stringify(extract)+'\n');
 const profile={schemaVersion:1,id:'city-tram-coverage-20261020-v1',baselineManifestSha256:sha(manifestBytes),origin:m.origin,
  scope:{renderBoundsRuntimeXZ:[scope.minX,scope.minZ,scope.maxX,scope.maxZ],sourceScopeSha256:sha(scopeBytes),clipToPlayableBounds:true},
  osm:{path:'osm-tracks.json',sha256:sha(extractBytes),license:'ODbL-1.0',attribution:'Copyright OpenStreetMap contributors'},
  existingProfiles:prior.map(p=>({file:p.file,sha256:p.sha256,wayIds:p.profile.tracks.map((t:any)=>t.wayId)})),tracks:selected,contextTracks:context,excluded,
  existingTailWayIds:[...existingTails].sort((a,b)=>a-b),existingRibbonPolicy:'Subtract actual decoded delivered rail footprints before supporting or emitting any existing-way repair ribbon.',
  coverage:{targetWays:selected.length,newWays:selected.length-existingTails.size,existingRibbonRepairWays:existingTails.size,existingContextWays:context.length,existingUniqueWayIds:existing.size,existingProfileEntries:prior.reduce((s,p)=>s+p.profile.tracks.length,0),newAxisMetresInPlayableScope:selected.filter(t=>t.role==='new-source-way').reduce((s,t)=>s+t.renderedAxisMetres,0),excludedByReason:Object.fromEntries([...new Set(excluded.map(e=>e.reason))].sort().map(reason=>[reason,excluded.filter(e=>e.reason===reason).length]))},
  gaugeMetres:1,existingRailClearanceMetres:.0005,
  budgets:{detailedTriangles:250000,coarseTriangles:150000,perCellDetailedTriangles:10000,perCellCoarseTriangles:6000,perCellDetailedDrawCalls:24,perCellCoarseDrawCalls:16,perCellAddedTextureBytes:32768},
  references:[
   {title:'HSL tram network, 31 August to 31 December 2026',url:'https://staticfiles.hsl.fi/globalassets/matkustaminen/tulostettavat-aikataulut-ja-kartat/reittikartat/liikennevalineittain/ratikka_pysakkijuliste_810x1210_3108-31122026.pdf',sourcePage:'https://www.hsl.fi/matkustaminen/reitti_ja_asemakartat',sha256:'52350bc1ad7ca0db75a331497bad759d2a04599c2e8ba88e56dd9d63516d0649',role:'network-reference-only',redistributed:false},
   {title:'Aleksanterinkatu, Google Street View, August 2024',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=BuvcPILQ9NFQkdsZIJHe4A&heading=90&pitch=-18',role:'appearance-reference-only',observation:'Two mapped track axes, four flush grooved rails embedded in rectangular granite setts; no sleepers or ballast.',redistributed:false},
   {title:'Kaivokatu, Google Street View, September 2025',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=IZXXT2j3tsbhLS9OrqmNQQ&heading=90&pitch=-15',role:'appearance-reference-only',observation:'Two flush tracks in a central asphalt or gray paved strip beside Ateneum; raised platforms and kerbs remain distinct.',redistributed:false},
   {title:'Kaisaniemenkatu, Google Street View, September 2025',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=a7StkX2mLx01_A73bxLc-Q&heading=35&pitch=-15',role:'layout-reference-only',observation:'Separately mapped pair curves beside raised stop platforms; embedded rails without ballast. Panorama rendering artifact makes surface color unsuitable as an authority.',redistributed:false},
   {title:'Bulevardi 3, Google Street View, August 2024',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=5fMHX8mJq6tcClltjj1aoQ&heading=65&pitch=-15',role:'appearance-reference-only',observation:'Two track axes and four flush grooved rails in gray granite setts; no exposed sleepers or ballast, with curbed walks and parking outside tracks.',redistributed:false},
   {title:'Kanavakatu 1, Google Street View, August 2024',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=M-LcrRvRjAQaVShx37Zqow&heading=160&pitch=-25',role:'layout-reference-only',observation:'Two mapped axes and four flush grooved rails in paved roadway. Pale gray concrete strips within each track and dark asphalt between them; no ballast or sleepers.',redistributed:false},
   {title:'Pitkäsilta, Google Street View, September 2020',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=ZMjYUy324aoywQ07GMnQ3g&heading=180&pitch=-20',role:'appearance-reference-only',observation:'Two flush paired grooved tracks in asphalt carriageway with double white center line and raised kerbed sidewalks; no rail step at the bank.',redistributed:false},
   {title:'Fredrikinkatu bridge, Google Street View, August 2024',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=GB22GxhSyL-oQDwr5sJWRQ&heading=325&pitch=-15',role:'appearance-reference-only',observation:'Two tracks embedded in asphalt carriageway with pale gray strips within each pair, raised kerbed sidewalks and metal railings. No floating tracks or sleepers.',redistributed:false},
   {title:'Katajanokka canal bridge, Google Street View, August 2024',url:'https://www.google.com/maps/@?api=1&map_action=pano&pano=iAjYgeSwlL6J0BaMB2I60A&heading=125&pitch=-25',role:'appearance-reference-only',observation:'Four rails flush with paved track strips and asphalt roadway; raised footway, stone posts and metal canal-edge railing. No visible deck seam gap or step.',redistributed:false},
  ],
  limitations:['OSM describes physical axes, not an engineering rail survey or a guarantee of current service.','Google/HSL references establish recognizable corridors; only licensed OSM coordinates author placement.','Bridge tracks require decoded deck/bank qualification before application; no rail elevation is inferred from OSM layer.']};
 const acquisition=Object.values(ledger.snapshots).find((s:any)=>s.sha256===sha(rawBytes)) as any;
 const provenance={schemaVersion:1,source:{id:'openstreetmap-tram-axes',url:'https://www.openstreetmap.org/',retrievedAt:acquisition.retrievedAt,originalSha256:sha(rawBytes),acquisitionLedgerSha256:sha(read(options.ledger)),license:'ODbL-1.0',licenseUrl:extract.license,attribution:extract.copyright,
   compilation:{method:acquisition.acquisition,lastAcquisitionUrl:acquisition.url,cachedAcceptedDataset:acquisition.cached??null,parts:(acquisition.parts??[]).map((p:any)=>({url:p.url,sha256:p.sha256,bytes:p.bytes}))}},
  extraction:{file:'osm-tracks.json',sha256:sha(extractBytes),ways:ways.length,nodes:nodeIds.size,removed:'OSM contributor user names/UIDs/timestamps and unrelated data; geometry and way tags retain original values.'},
  visualArt:{source:'Original procedural 44x4 rail head/groove/guard stripe',license:'CC0-1.0'},references:profile.references,
  publication:{files:['profile.json','osm-tracks.json','source-ledger.json'],databaseLicense:'ODbL-1.0',notice:'This extract and the source-bound tram axis database are OpenStreetMap-derived data, available under the Open Database License 1.0. Contains information from OpenStreetMap, made available under the Open Database License (ODbL).',source:'https://www.openstreetmap.org/copyright'},
  preservation:`Existing ${existing.size} unique Mannerheim source way IDs in ${prior.reduce((s,p)=>s+p.profile.tracks.length,0)} accepted profile entries remain unchanged. New ribbons are cut against their actual delivered footprints.`};
 fs.mkdirSync(out,{recursive:true});for(const [name,value]of [['profile.json',profile],['source-ledger.json',provenance]] as const)fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(path.join(out,'osm-tracks.json'),extractBytes,{flag:'wx'});return profile;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const{values}=parseArgs({options:{world:{type:'string'},osm:{type:'string'},ledger:{type:'string'},existing:{type:'string',multiple:true},scope:{type:'string'},out:{type:'string'},'existing-tail-way':{type:'string',multiple:true}}});
 assert.ok(values.world&&values.osm&&values.ledger&&values.existing?.length&&values.scope&&values.out,'--world --osm --ledger --existing(repeatable) --scope --out required');
 const p=prepareDeliveryTramProfile({world:values.world,osm:values.osm,ledger:values.ledger,existingProfiles:values.existing,scope:values.scope,out:values.out,existingTailWayIds:values['existing-tail-way']?.map(Number)});console.log(JSON.stringify({selected:p.tracks.length,context:p.contextTracks.length,bridges:p.tracks.filter(t=>t.deckAuthority).map(t=>t.wayId),excluded:p.excluded.length}));
}
