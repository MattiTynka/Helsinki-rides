// Exact observed Kasarmikatu elevation of the municipal Ullanlinnankatu1 building.
import assert from 'node:assert/strict';
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
import type {ReferenceFacadeArt} from './delivery-new-area-facades-reference-art.ts';

const scopes={
 'ullanlinnankatu-1-kasarmikatu-main-east-20261021':{triangles:[499,500],maxY:25.743934631347656,floors:[8.557571464620576,8.37327312531439,8.110969300463287,7.891733689723078,7.678180524792582,7.424544583495978,7.100790107488814,6.861199504900773,6.697105804321257]},
 'ullanlinnankatu-1-south-20261021':{triangles:[333,334,335,336,337,338,339,340,341],maxY:31.637012481689453,floors:[9.512109487107585,9.483229708764568,9.48222126937216,9.477561438557604,9.451151313132778,9.411617709792612,9.352376393373046,9.299747877969379,9.29585135643007]},
 'ullanlinnankatu-1-east-corner-20261021':{triangles:[494,495,496,497,498],maxY:31.627222061157227,floors:[9.121036015506043,9.07087020647985,9.005608108744948,8.94115275613187,8.869170455287364,8.797201357543491,8.725808988898187,8.653465237935983,8.58752052005536]},
} as const;
const sharedDatum=8.557571464620576;
export function qualifyUllanlinnankatuGround(p:{id:string;building:{id:string;vtj:string};triangles:number[];observedGroundProfile:{kind:string;manifestSha256:string;sampleHeights:number[];mainNativeRoofY:number;horizontalDatumFromMainNativeRoof:number}},expected:string,maxY:number,samples:readonly{collision:{height:number}}[]){
 assert.ok(Object.hasOwn(scopes,p.id));const scope=scopes[p.id as keyof typeof scopes];
 assert.deepEqual(p.building,{id:'BID_55bf0fcd-8aad-4096-b661-ef1502b76486',vtj:'103046315N',owner:'c_m03_p05'});
 assert.deepEqual(p.triangles,[...scope.triangles]);assert.equal(maxY,scope.maxY);
 assert.equal(p.observedGroundProfile.kind,'source-measured-sloped-shop-base-horizontal-upper-bands');
 assert.equal(p.observedGroundProfile.manifestSha256,expected);
 assert.deepEqual(p.observedGroundProfile.sampleHeights,[...scope.floors]);
 assert.equal(p.observedGroundProfile.mainNativeRoofY,25.743934631347656);
 assert.equal(p.observedGroundProfile.horizontalDatumFromMainNativeRoof,-17.18636316672708);
 assert.equal(samples.length,9);
 samples.forEach((s,i)=>assert.ok(Number.isFinite(s.collision.height)&&Math.abs(s.collision.height-scope.floors[i]!)<1e-6,'Requalify changed Ullanlinnankatu source street floor'));
 return sharedDatum;
}

export function renderUllanlinnankatuMainGround(w:OriginalWallArt,datum:number,art:ReferenceFacadeArt,samples:readonly{u:number;collision:{height:number}}[]){
 assert.ok(Math.abs(w.width-37.97661897934095)<1e-7);
 assert.equal(art.rows.length,4);assert.equal(samples.length,9);
 renderUllanlinnankatuShopGround(w,datum,art,samples);
}

function renderUllanlinnankatuShopGround(w:OriginalWallArt,datum:number,art:ReferenceFacadeArt,samples:readonly{u:number;collision:{height:number}}[]){
 // The historic floor bands are level. Only shop sills and the stone plinth follow the measured street.
 w.rect(0,w.minY,w.width,datum+3.5-w.minY,art.groundColour,'ullan-main-ground-clear');
 for(let y=datum+.1;y<datum+3.5;y+=.45)w.line(0,y,w.width,y,'#ac8776',.035);
 const floorAt=(x:number)=>{const a=[{u:0,collision:samples[0]!.collision},...samples,{u:w.width,collision:samples.at(-1)!.collision}];for(let i=1;i<a.length;i++){const left=a[i-1]!,right=a[i]!;if(x<=right.u)return left.collision.height+(right.collision.height-left.collision.height)*(x-left.u)/Math.max(1e-9,right.u-left.u);}throw Error('Opening outside qualified street profile');};
 for(const [i,opening]of art.groundOpenings.entries()){
  const bottom=floorAt(opening.x)+(opening.kind==='door'?.18:.65),top=opening.kind==='door'?bottom+opening.height:datum+3.05,left=opening.x-opening.width/2,height=top-bottom;
  assert.ok(height>.5&&height<5);
  w.rect(left-.12,bottom-.12,opening.width+.24,height+.24,art.surroundColour,`ullan-shop-${i}-surround`);
  w.rect(left,bottom,opening.width,height,opening.kind==='door'?'#7e6048':art.glassColour,`ullan-shop-${i}`);
  if(opening.kind==='door'){
   w.rect(left+.15,bottom+.35,opening.width-.3,height-.7,'#8c9b93');
   w.line(opening.x,bottom,opening.x,top,'#6b553d',.07);
  }else w.line(opening.x,bottom,opening.x,top,art.frameColour,.07);
 }
 const edge=[[0,samples[0]!.collision.height+.25],...samples.map(s=>[s.u,s.collision.height+.25]),[w.width,samples.at(-1)!.collision.height+.25]];
 w.pieces.push(`<polygon data-feature="ullan-source-floor-plinth" points="0,${w.maxY-w.minY} ${edge.map(([x,y])=>`${x},${w.maxY-y!}`).join(' ')} ${w.width},${w.maxY-w.minY}" fill="#8b877d"/>`);
 for(const row of art.rows)for(let i=0;i<row.axes.length-1;i++){
  const x=(row.axes[i]!+row.axes[i+1]!)/2;
  w.rect(x-.10,datum+row.bottom+.3,.20,row.height*.65,'#b57d70','ullan-observed-narrow-pink-panels');
 }
}

export function renderUllanlinnankatuPavilion(w:OriginalWallArt,ground:number,side:'south'|'east-corner',art:ReferenceFacadeArt,samples:readonly{u:number;collision:{height:number}}[]){
 const expectedWidth=side==='south'?30.423173317677197:9.044678053717758;
 assert.ok(Math.abs(w.width-expectedWidth)<1e-7,'Pavilion art only belongs to its measured source elevation');
 renderUllanlinnankatuShopGround(w,ground,art,samples);
 const left=side==='south'?w.width-9.222692:0,width=w.width-left,bottom=26.027222061157226;
 w.rect(left,bottom,width,w.maxY-bottom,'#d5d0c3','ullan-observed-pale-attic-pavilion');
 w.rect(left,bottom,width,.22,'#b3ac9e','ullan-pavilion-lower-belt');
 for(const fraction of[.17,.5,.83]){
  const x=left+width*fraction,y=bottom+.9,windowWidth=1.22,windowHeight=2.65;
  w.rect(x-windowWidth/2-.13,y-.13,windowWidth+.26,windowHeight+.26,'#e6dfd2','ullan-attic-surround');
  w.rect(x-windowWidth/2,y,windowWidth,windowHeight,'#7c8177','ullan-attic-frame');
  w.rect(x-windowWidth/2+.09,y+.09,windowWidth-.18,windowHeight-.18,'#9da9a1','ullan-attic-glass');
  w.line(x,y,x,y+windowHeight,'#6e756b',.08);
  const top=w.maxY-y-windowHeight-.15;
  w.pieces.push(`<path data-feature="ullan-attic-arched-header" d="M ${x-windowWidth/2-.18} ${top} Q ${x} ${top-.5} ${x+windowWidth/2+.18} ${top}" fill="none" stroke="#e7e1d5" stroke-width=".17"/>`);
 }
 for(const x of[left+.18,left+width-.35])w.rect(x,bottom+.3,.17,w.maxY-bottom-.6,'#b6b0a4','ullan-attic-end-pilaster');
 w.rect(left,w.maxY-.27,width,.23,'#a29e95','ullan-attic-cap');
 assert.ok(ground+15.6<bottom+.3,'Upper residential windows must remain below the source pavilion');
}
