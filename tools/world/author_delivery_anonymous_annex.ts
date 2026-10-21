// Source-plane qualification is delegated unchanged to the strict observed-finish author.
// This one individually observed annex has upper lights located from its native roof,
// because the historical court photograph supplies no surveyed ground datum.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {authorObservedFacadeFinish} from './author_delivery_observed_facade_finish.ts';
import {OriginalWallArt} from './author_senate_facade_charts.ts';
import {deliverySha as sha} from './lib/delivery-city-payloads.ts';
import type {DeliveryFacadeProfile} from './apply_delivery_facade_charts.ts';

export function renderPengerkujaAnnex(w:OriginalWallArt) {
  assert.ok(w.width>28&&w.width<31&&w.maxY-w.minY>6&&w.maxY-w.minY<8);
  w.rect(0,w.minY,w.width,w.maxY-w.minY,'#d7d5cb','pengerkuja-white-render');
  w.rect(0,w.maxY-.32,w.width,.2,'#b1b4af','pengerkuja-flat-roof-edge');
  const count=14,step=(w.width-1.4)/count;
  for(let i=0;i<count;i++) {
    const x=.7+step*(i+.5),y=w.maxY-2.60,width=.95,height=1.65;
    w.rect(x-width/2-.07,y-.07,width+.14,height+.14,'#b4b8af',`pengerkuja-upper-frame-${i}`);
    w.rect(x-width/2,y,width,height,'#63767b',`pengerkuja-upper-light-${i}`);
    w.line(x,y,x,y+height,'#aeb5ae',.035);
  }
}
export async function authorAnonymousAnnex(o:{plan:string;cityModel:string;world:string;expected:string;out:string}) {
  assert.ok(!fs.existsSync(o.out));const planBytes=fs.readFileSync(o.plan),p=JSON.parse(planBytes.toString());
  assert.equal(p.building.id,'BID_de9b9a73-1c8f-4f5d-adea-1b31de25beb2');
  assert.equal(p.building.vtj,null);assert.equal(p.building.owner,'c_p02_m13');
  assert.deepEqual(p.faces,[{part:0,triangle:7},{part:0,triangle:8}]);
  assert.equal(p.finish.kind,'plain');assert.equal(p.finish.colour,'#d7d5cb');
  await authorObservedFacadeFinish({...o,out:o.out+'.source-plane'});
  const base=o.out+'.source-plane',profile=JSON.parse(fs.readFileSync(path.join(base,'profile.json'),'utf8'))as DeliveryFacadeProfile;
  assert.equal(profile.charts.length,1);const chart=profile.charts[0]!,w=new OriginalWallArt(chart.bounds[2]-chart.bounds[0],chart.bounds[1],chart.bounds[3]);renderPengerkujaAnnex(w);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#d7d5cb"/>${w.svg([4,4,1016,1016])}</svg>`,png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9}).toBuffer();
  const updatedProfile={...profile,charts:[{...chart,pixels:[4,4,1016,1016]as const}],art:{...profile.art,width:1024,height:1024,sha256:sha(png),attribution:'Original observed industrial-annex artwork by Helsinki Rides (2026); historical reference pixels are not reproduced.'}};
  const ledger=JSON.parse(fs.readFileSync(path.join(base,'source-ledger.json'),'utf8'));
  Object.assign(ledger,{status:'SOURCE_BOUND_HISTORICAL_ANNEX_ART_RUNTIME_REVIEW_REQUIRED',planSha256:sha(planBytes),art:{sha256:sha(png),license:'CC0-1.0',referencePixelsCopied:false},openingDatum:{method:'Upper-light row positioned relative to exact unchanged native roof edge; no ground/garage/storey floor height inferred',nativeTop:chart.bounds[3],topOffset:2.60,height:1.65,count:14,limitation:'Repeated original interpretation of the observed upper-light rhythm; northern bays are partially tree-occluded in the historical reference'}});
  fs.mkdirSync(o.out,{recursive:true});for(const[name,b]of Object.entries({'profile.json':JSON.stringify(updatedProfile,null,2)+'\n','source-ledger.json':JSON.stringify(ledger,null,2)+'\n','facade.svg':svg,'facade.png':png}))fs.writeFileSync(path.join(o.out,name),b,{flag:'wx'});
  return{profileSha256:sha(fs.readFileSync(path.join(o.out,'profile.json'))),artSha256:sha(png),sourceFaces:p.faces.length,wallArea:ledger.sourceTriangles.reduce((s:number,f:{area:number})=>s+f.area,0)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:Object.fromEntries(['plan','city-model','world','expected','out'].map(k=>[k,{type:'string'as const}]))});for(const k of['plan','city-model','world','expected','out'])assert.ok(values[k]);console.log(JSON.stringify(await authorAnonymousAnnex({plan:values.plan!,cityModel:values['city-model']!,world:values.world!,expected:values.expected!,out:values.out!})));}
