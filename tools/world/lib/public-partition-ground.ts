import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import type {RoadSupportTriangle,RoadSourceElement} from './expansion-road-merge.ts';
import type {LocalPolygon} from './geometry.ts';
import type {GroundPiece,Finish} from './ground.ts';
import {sourceSha256} from './source-files.ts';
import {qualifyReviewedPublicPartitionPair, type ReviewedPublicPartitionPair} from './reviewed-public-partition-pair.ts';

type Point=[number,number];
export interface PublicPartitionPatch {lane:string;sourcePartIds:string[];sourceDelta:polygonClipping.MultiPolygon;physicalDomain:Point[];triangles:{cell:string;points:Vec3[]}[]}
const cross=(a:Point,b:Point,p:Point)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
const ringArea=(r:readonly Point[])=>Math.abs(r.slice(1,-1).reduce((s,p,i)=>s+cross(r[0]!,p,r[i+2]!),0))/2;
const area=(g:polygonClipping.MultiPolygon)=>g.reduce((s,p)=>s+ringArea(p[0]!)-p.slice(1).reduce((s,h)=>s+ringArea(h),0),0);
function distance(t:readonly Vec3[],q:Point){const p=t.map(v=>[v[0],v[2]]as Point),sign=Math.sign(cross(p[0]!,p[1]!,p[2]!));if(!sign)return Infinity;if(p.every((a,i)=>sign*cross(a,p[(i+1)%3]!,q)>=0))return 0;return Math.min(...p.map((a,i)=>{const b=p[(i+1)%3]!,dx=b[0]-a[0],dz=b[1]-a[1],l=dx*dx+dz*dz,t=l?Math.max(0,Math.min(1,((q[0]-a[0])*dx+(q[1]-a[1])*dz)/l)):0;return Math.hypot(q[0]-a[0]-dx*t,q[1]-a[1]-dz*t);}));}
function height(t:readonly Vec3[],q:Point){const[a,b,c]=t,d=(b![0]-a![0])*(c![2]-a![2])-(c![0]-a![0])*(b![2]-a![2]);assert.ok(Math.abs(d)>1e-12);const A=((b![0]-q[0])*(c![2]-q[1])-(c![0]-q[0])*(b![2]-q[1]))/d,B=((c![0]-q[0])*(a![2]-q[1])-(a![0]-q[0])*(c![2]-q[1]))/d;return A*a![1]+B*b![1]+(1-A-B)*c![1];}
function normal(t:readonly Vec3[]){const[a,b,c]=t,u=b!.map((v,i)=>v-a![i]!),v=c!.map((n,i)=>n-a![i]!),n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];return n[1]!/Math.hypot(...n);}
function boundaryDistance(p:Point,part:LocalPolygon){return Math.min(...part.rings.flatMap(r=>r.map((a,i)=>{const b=r[(i+1)%r.length]!,dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(-p[1]-a[1])*dy)/length)):0;return Math.hypot(p[0]-a[0]-t*dx,-p[1]-a[1]-t*dy);})));}
function finish(part:LocalPolygon):Finish{const mat=String(part.properties.materiaali).toLowerCase();if(mat.includes('nupukivi'))return'setts';if(/noppakivi|kenttäkivi|mukulakivi/.test(mat))return'cobble';if(/laatta|betonikivi|graniitti/.test(mat))return'slabs';if(/asfaltti/.test(mat))return'asphalt';throw new Error('Partition join finish needs explicit public source material');}

/** Narrow authored joins between individually reviewed public carriageway partitions.
 * No caller may use this to fill ordinary holes, change old faces, or select a stacked level. */
export function qualifyPublicPartitionGround(patch:PublicPartitionPatch,parts:readonly LocalPolygon[],ways:ReadonlyMap<number,RoadSourceElement>,floor:readonly RoadSupportTriangle[],accepted:readonly[number,number,number,number],reviewed?:{review:ReviewedPublicPartitionPair;sourcePins:{streetPartsSha256:string;osmSha256:string}}){
  const reviewedSourcePair=reviewed?qualifyReviewedPublicPartitionPair(patch,parts,ways,floor,accepted,reviewed.review,reviewed.sourcePins):undefined;
  assert.match(patch.lane,/^\d+:\d+:[fb]\d+$/);assert.equal(patch.sourcePartIds.length,2);assert.equal(new Set(patch.sourcePartIds).size,2);const wayId=Number(patch.lane.split(':')[0]),way=ways.get(wayId);assert.ok(way?.tags);const tags=way.tags;
  assert.ok(['residential','secondary','tertiary','unclassified','living_street'].includes(tags.highway??''),'Partition join requires an explicitly public local road');assert.ok((!tags.bridge||tags.bridge==='no')&&(!tags.tunnel||tags.tunnel==='no')&&Number(tags.layer??0)===0);
  for(const key of ['access','vehicle','motor_vehicle'])assert.ok(tags[key]===undefined||['yes','designated','permissive'].includes(tags[key]!));
  const selected=patch.sourcePartIds.map(id=>{const p=parts.find(p=>p.id===id);assert.ok(p&&p.properties.paatyyppi==='Ajorata'&&p.properties.alatyyppi==='Ajorata'&&p.properties.aluetieto==='Katu','Join requires exact municipal street carriageways');return p;});
  assert.ok(patch.physicalDomain.length>=3&&patch.physicalDomain.length<=24&&patch.physicalDomain.every(p=>p.length===2&&p.every(Number.isFinite)&&p.every(v=>v===Math.fround(v))));
  const domain=[patch.physicalDomain]as polygonClipping.Polygon,b=[Math.min(...patch.physicalDomain.map(p=>p[0])),Math.min(...patch.physicalDomain.map(p=>p[1])),Math.max(...patch.physicalDomain.map(p=>p[0])),Math.max(...patch.physicalDomain.map(p=>p[1]))];assert.ok(b[2]!-b[0]!<32&&b[3]!-b[1]!<32);assert.ok(b[2]!<accepted[0]||b[0]!>accepted[2]||b[3]!<accepted[1]||b[1]!>accepted[3],'Entire join domain must avoid accepted authority');
  const gapArea=area(patch.sourceDelta);assert.ok(gapArea>0&&(reviewedSourcePair||gapArea<.01));assert.ok(ringArea(patch.physicalDomain)<.05,'Partition seam is too wide');
  if(!reviewedSourcePair)for(const p of patch.physicalDomain)assert.ok(selected.every(part=>boundaryDistance(p,part)<=.006),'Join must stay within6mm of both exact public source flanks');
  const source=polygonClipping.union(...selected.map(p=>p.rings.map(r=>r.map(([x,y])=>[x,-y]as Point)))as[polygonClipping.Polygon,polygonClipping.Polygon]);
  assert.ok(area(polygonClipping.intersection(patch.sourceDelta,source))<1e-9,'Declared partition gap overlaps the public source polygons');assert.ok(area(polygonClipping.difference(patch.sourceDelta,domain))<1e-10);
  assert.ok(patch.triangles.length>0&&patch.triangles.length<=1000);const geometry=patch.triangles.map(t=>[t.points.map(p=>[p[0],p[2]]as Point)]as polygonClipping.Polygon),union=polygonClipping.union(...geometry as[polygonClipping.Polygon,...polygonClipping.Polygon[]]);assert.ok(area(polygonClipping.difference(patch.sourceDelta,union))<1e-10,'Serialized triangles fail to close the entire reviewed gap');
  const road=floor.filter(t=>t.tag.startsWith('road:')&&normal(t.points)>.98&&Math.min(...t.points.map(p=>p[0]))<=b[2]!+.01&&Math.max(...t.points.map(p=>p[0]))>=b[0]!-.01&&Math.min(...t.points.map(p=>p[2]))<=b[3]!+.01&&Math.max(...t.points.map(p=>p[2]))>=b[1]!-.01),vertexProofs=[],overlapProofs=[],continuousFlankProofs=[];let maximumExtrapolation=0,maximumHeightError=0,minimumNormal=1;
  for(const tri of patch.triangles){assert.match(tri.cell,/^c_[mp]\d{2}_[mp]\d{2}$/);assert.ok(tri.points.length===3&&tri.points.every(p=>p.length===3&&p.every(Number.isFinite)&&p.every(v=>Math.fround(v)===v)));const n=normal(tri.points);assert.ok(n>.98,'Join must preserve the low-slope public road grade');minimumNormal=Math.min(minimumNormal,n);
    const face=[tri.points.map(p=>[p[0],p[2]]as Point)]as polygonClipping.Polygon;assert.ok(area(polygonClipping.difference(face,domain))<1e-8,'Added ground leaves its reviewed Float32 domain');
    // Distance to one convex native triangle is convex; affine plane error is
    // bounded by its vertex extrema. One common witness therefore covers the
    // complete added face, including its interior, without station sampling.
    const continuous=road.map(t=>({triangle:t.id,maximumDistance:Math.max(...tri.points.map(p=>distance(t.points,[p[0],p[2]]))),maximumHeightError:Math.max(...tri.points.map(p=>Math.abs(p[1]-height(t.points,[p[0],p[2]]))))})).filter(p=>p.maximumDistance<=.005&&p.maximumHeightError<.002).sort((a,b)=>a.maximumDistance-b.maximumDistance)[0];
    assert.ok(continuous,'Every whole added face requires one continuous native flank within5mm');continuousFlankProofs.push(continuous);
    for(const p of tri.points){const q:[number,number]=[p[0],p[2]],near=road.map(t=>({t,d:distance(t.points,q)})).filter(h=>h.d<=.005).sort((a,b)=>a.d-b.d);assert.ok(near.length,'Join has no literal native flank within5mm');const chosen=near[0]!,heights=near.map(h=>height(h.t.points,q)),spread=Math.max(...heights)-Math.min(...heights),error=Math.abs(p[1]-height(chosen.t.points,q));assert.ok(spread<.002&&error<.002,'Join crosses distinct native levels or alters grade');maximumExtrapolation=Math.max(maximumExtrapolation,chosen.d);maximumHeightError=Math.max(maximumHeightError,error);vertexProofs.push({point:p,triangle:chosen.t.id,distance:chosen.d,heightError:error,nearbyHeightSpread:spread});}
    // Two affine planes attain their largest difference at an intersection vertex.
    for(const t of road){const intersection=polygonClipping.intersection(face,[t.points.map(p=>[p[0],p[2]]as Point)]);if(!intersection.length)continue;const error=Math.max(...intersection.flatMap(p=>p.flat()).map(q=>Math.abs(height(tri.points,q)-height(t.points,q))));assert.ok(error<.002,'Join differs from an overlapped native road plane: '+JSON.stringify({lane:patch.lane,triangle:t.id,error,added:tri.points,source:t.points,intersection}));maximumHeightError=Math.max(maximumHeightError,error);overlapProofs.push({triangle:t.id,maximumHeightError:error});}
  }
  const material=finish(selected[0]!),scale={asphalt:6,setts:2,cobble:2,slabs:3,gravel:4,grass:5,yard:6}[material],pieces:GroundPiece[]=patch.triangles.map(t=>({cell:t.cell,finish:material,level:'road',tag:'road:'+material,positions:t.points.flat(),uvs:t.points.flatMap(p=>[Math.fround(p[0]/scale),Math.fround(-p[2]/scale)]),indices:[0,1,2]}));
  return{pieces,proof:{lane:patch.lane,wayId,sourceWaySha256:sourceSha256(JSON.stringify(way)),parts:selected.map(p=>({id:p.id,sha256:sourceSha256(JSON.stringify(p)),name:p.properties.alueen_nimi,material:p.properties.materiaali})),physicalDomain:patch.physicalDomain,sourceDelta:patch.sourceDelta,sourceGapArea:gapArea,minimumNormal,maximumExtrapolation,maximumHeightError,vertexProofs,continuousFlankProofs,overlapProofs,triangles:patch.triangles,...(reviewedSourcePair?{reviewedSourcePair}:{} )}};
}
