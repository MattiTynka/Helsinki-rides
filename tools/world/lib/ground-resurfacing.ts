// Source-bound appearance selection. No clipping or tessellation of the world:
// partially covered triangles are reported, never cut or painted by centroid.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import type {LocalPolygon} from './geometry.ts';
import {facadeTriangleKey, type FacadePoint, type FacadeTriangle} from './facade-charts.ts';

export type PavingFinish = 'setts'|'cobble'|'asphalt'|'slabs';
export type PavingPattern = 'setts'|'cobble'|'fan-cobble';
export interface PavingRegion {
  id:string; partIds:string[]; expectedMaterials:string[]; existingFinishes:PavingFinish[];
  pattern:PavingPattern; basis:{originXZ:[number,number];alongXZ:[number,number]};
  tileMetres:[number,number]; referenceIds:string[];
  runtimeBoundsXZ?:[number,number,number,number];
}
export interface ResurfacingPlan {
  schemaVersion:1; id:string; baseCellsIndexSha256:string; streetPartsSha256:string; originSha256:string;
  regions:PavingRegion[]; texture:{size:256;seed:number;stonesPerSide:number;jointMetres:number}; minimumNormalY:number;
}
export interface NativeCoverageProof {boundMetres:number;maximumOutsideDistanceMetres:number;fragments:{sourceEdge:[[number,number],[number,number]];maximumDistanceMetres:number;diagnosticTriangle?:[number,number][]}[];maximumDiagnosticDepth:number}
export interface SurfaceTarget {node:string;primitive:number;triangle:number;key:string;region:string;nativeCoverage?:NativeCoverageProof;adjacentRegions?:string[]}
export interface SurfaceTriangle {node:string;primitive:number;triangle:number;points:FacadeTriangle;finish:string}
export const pavingSha = (bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export const pavingTriangleKey = facadeTriangleKey;
const exactKeys=(v:object,keys:string[],label:string)=>assert.deepEqual(Object.keys(v).sort(),keys.sort(),`${label} fields`);
const finiteTuple=(v:unknown,n:number)=>Array.isArray(v)&&v.length===n&&v.every(x=>typeof x==='number'&&Number.isFinite(x));
export function validateResurfacingPlan(value:unknown):asserts value is ResurfacingPlan {
  assert.ok(value&&typeof value==='object');const p=value as ResurfacingPlan;
  exactKeys(p,['schemaVersion','id','baseCellsIndexSha256','streetPartsSha256','originSha256','regions','texture','minimumNormalY'],'Resurfacing plan');
  assert.equal(p.schemaVersion,1);assert.match(p.id,/^[a-z0-9][a-z0-9-]{0,79}$/);
  for(const h of [p.baseCellsIndexSha256,p.streetPartsSha256,p.originSha256])assert.match(h,/^[a-f0-9]{64}$/);
  assert.ok(p.minimumNormalY>=.7&&p.minimumNormalY<=1);
  assert.ok(Array.isArray(p.regions)&&p.regions.length>0&&p.regions.length<=100);
  const ids=new Set<string>();
  for(const r of p.regions){
    exactKeys(r,['id','partIds','expectedMaterials','existingFinishes','pattern','basis','tileMetres','referenceIds',...(r.runtimeBoundsXZ?['runtimeBoundsXZ']:[])],'Paving region');
    assert.match(r.id,/^[a-z0-9][a-z0-9-]{0,79}$/);assert.ok(!ids.has(r.id),'Duplicate region');ids.add(r.id);
    assert.ok(r.partIds.length>0&&r.partIds.length<=2000&&new Set(r.partIds).size===r.partIds.length);
    assert.ok(r.partIds.every(id=>typeof id==='string'&&/^\d+$/.test(id)));
    assert.ok(r.expectedMaterials.length>0&&r.expectedMaterials.every(s=>typeof s==='string'&&s.length<100));
    assert.ok(r.existingFinishes.length>0&&r.existingFinishes.every(s=>['setts','cobble','asphalt','slabs'].includes(s)));
    assert.ok(['setts','cobble','fan-cobble'].includes(r.pattern));exactKeys(r.basis,['originXZ','alongXZ'],'Paving basis');
    assert.ok(finiteTuple(r.basis.originXZ,2)&&finiteTuple(r.basis.alongXZ,2));
    assert.ok(Math.abs(Math.hypot(...r.basis.alongXZ)-1)<1e-8,'Paving axis must be unit length');
    assert.ok(finiteTuple(r.tileMetres,2)&&r.tileMetres.every(x=>x>=.5&&x<=8));
    if(r.pattern==='fan-cobble')assert.equal(r.tileMetres[0],r.tileMetres[1],'Fan courses require square physical repeats');
    assert.ok(r.referenceIds.length>0&&r.referenceIds.every(s=>typeof s==='string'&&s.length>0&&s.length<=500));
    if(r.runtimeBoundsXZ){assert.ok(finiteTuple(r.runtimeBoundsXZ,4));assert.ok(r.runtimeBoundsXZ[0]<r.runtimeBoundsXZ[2]&&r.runtimeBoundsXZ[1]<r.runtimeBoundsXZ[3]);}
  }
  exactKeys(p.texture,['size','seed','stonesPerSide','jointMetres'],'Paving texture');assert.equal(p.texture.size,256);
  assert.ok(Number.isSafeInteger(p.texture.seed)&&p.texture.seed>=0&&p.texture.seed<=0xffffffff);
  assert.ok(Number.isSafeInteger(p.texture.stonesPerSide)&&p.texture.stonesPerSide>=4&&p.texture.stonesPerSide<=24&&p.texture.stonesPerSide%2===0,'Staggered repeat needs an even stone count');
  assert.ok(p.texture.jointMetres>=.001&&p.texture.jointMetres<=.015);
}
type MultiPolygon = Parameters<typeof polygonClipping.union>[0];
export function pavingPolygonArea(p:ReturnType<typeof polygonClipping.difference>):number {
  let total=0;for(const rings of p)for(let ri=0;ri<rings.length;ri++){
    const r=rings[ri]!;let a=0;for(let i=0;i<r.length;i++){const x=r[i]!,y=r[(i+1)%r.length]!;a+=x[0]*y[1]-y[0]*x[1];}
    total+=(ri? -1:1)*Math.abs(a)/2;
  }return total;
}
export function pavingUv(point:FacadePoint,region:PavingRegion):[number,number] {
  const x=point[0]-region.basis.originXZ[0],z=point[2]-region.basis.originXZ[1],[ux,uz]=region.basis.alongXZ;
  return [(x*ux+z*uz)/region.tileMetres[0],(-x*uz+z*ux)/region.tileMetres[1]];
}
export function nativeFloat32CoverageProof(points:FacadeTriangle,outside:ReturnType<typeof polygonClipping.difference>,boundary:ReturnType<typeof polygonClipping.union>):NativeCoverageProof|null {
  const halfUlp=(v:number)=>2**(Math.max(-126,Math.floor(Math.log2(Math.abs(v)||2**-126)))-24);
  const boundMetres=Math.hypot(Math.max(...points.map(p=>halfUlp(p[0]))),Math.max(...points.map(p=>halfUlp(p[2]))))+1e-8;
  const segments=boundary.flatMap(poly=>poly.flatMap(r=>r.map((a,i)=>[a,r[(i+1)%r.length]!] as const)));
  const distance=(p:readonly number[],a:readonly number[],b:readonly number[])=>{const dx=b[0]!-a[0]!,dy=b[1]!-a[1]!,d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((p[0]!-a[0]!)*dx+(p[1]!-a[1]!)*dy)/d)):0;return Math.hypot(p[0]!-a[0]!-t*dx,p[1]!-a[1]!-t*dy);};
  const fragments:NativeCoverageProof['fragments']=[];let maximumOutsideDistanceMetres=0,maximumDiagnosticDepth=0,refinementCalls=0;
  const capsule=(vertices:readonly (readonly number[])[])=>{let best=Infinity,edge:typeof segments[number]|undefined;for(const candidate of segments){let farthest=0;for(const p of vertices){farthest=Math.max(farthest,distance(p,candidate[0],candidate[1]));if(farthest>=best)break;}if(farthest<best){best=farthest;edge=candidate;}}return {best,edge};};
  function record(c:ReturnType<typeof capsule>,diagnosticTriangle?:[number,number][]){assert.ok(c.edge);fragments.push({sourceEdge:[[c.edge[0][0],c.edge[0][1]],[c.edge[1][0],c.edge[1][1]]],maximumDistanceMetres:c.best,...(diagnosticTriangle?{diagnosticTriangle}:{})});maximumOutsideDistanceMetres=Math.max(maximumOutsideDistanceMetres,c.best);}
  function refine(t:[number,number][],leaves:[number,number][][],depth=0):boolean {
    refinementCalls++;maximumDiagnosticDepth=Math.max(maximumDiagnosticDepth,depth);const c=capsule(t);if(c.edge&&c.best<=boundMetres){record(c,t);leaves.push(t);return true;}
    if(depth>=12||refinementCalls>=256||t.some(v=>!segments.some(([a,b])=>distance(v,a,b)<=boundMetres)))return false;
    const [a,b,cPoint]=t as [[number,number],[number,number],[number,number]],mid=(p:[number,number],q:[number,number]):[number,number]=>[(p[0]+q[0])/2,(p[1]+q[1])/2],ab=mid(a,b),bc=mid(b,cPoint),ca=mid(cPoint,a);
    return [[a,ab,ca],[ab,b,bc],[ca,bc,cPoint],[ab,bc,ca]].every(v=>refine(v,leaves,depth+1));
  }
  for(const polygon of outside){
    // A segment capsule is convex: if every polygon vertex lies in the SAME
    // actual boundary segment's capsule, every edge and interior point does too.
    // No sampled-midpoint inference, area ratio, centroid or buffered mask.
    const vertices=polygon.flat(),whole=capsule(vertices);if(whole.edge&&whole.best<=boundMetres){record(whole);continue;}
    // Only diagnostic outside fragments are decomposed. The actual floor face
    // is never subdivided. A non-empty exact residual fails the entire proof.
    const flat:number[]=[],holes:number[]=[];for(const ring of polygon){if(flat.length)holes.push(flat.length/2);for(const p of ring)flat.push(p[0],p[1]);}
    const I=earcut(flat,holes),leaves:[number,number][][]=[];if(!I.length)return null;
    for(let k=0;k<I.length;k+=3){const t=[0,1,2].map(i=>[flat[I[k+i]!*2]!,flat[I[k+i]!*2+1]!] as [number,number]);if(!refine(t,leaves))return null;}
    if(polygonClipping.difference([polygon],...leaves.map(t=>[t])).length!==0)return null;
  }
  return {boundMetres,maximumOutsideDistanceMetres,fragments,maximumDiagnosticDepth};
}
export function createResurfacingSelector(plan:ResurfacingPlan,parts:readonly LocalPolygon[]) {
  validateResurfacingPlan(plan);
  const regions=plan.regions.map(region=>{
    const selected=parts.filter(p=>region.partIds.includes(String(p.id).split('#')[0]!));
    assert.equal(new Set(selected.map(p=>p.id)).size,selected.length,'Duplicate source polygon identities');
    for(const id of region.partIds)assert.ok(selected.some(p=>String(p.id).split('#')[0]===id),`Missing/duplicate source part ${id}`);
    for(const p of selected){assert.ok(region.expectedMaterials.includes(String(p.properties.materiaali)),`Source material mismatch: ${p.id}`);assert.ok(!/Portaat|Tukimuuri|Nurmikko|Pensas|Rakennus/.test(String(p.properties.alatyyppi)),'Protected source part cannot be resurfaced');}
    const geometries=selected.map(p=>[p.rings.map(r=>r.map(v=>[v[0],v[1]] as [number,number]))] as MultiPolygon);
    let union=polygonClipping.union(geometries[0]!,...geometries.slice(1));
    if(region.runtimeBoundsXZ){const [x0,z0,x1,z1]=region.runtimeBoundsXZ;union=polygonClipping.intersection(union,[[[x0,-z1],[x1,-z1],[x1,-z0],[x0,-z0]]]);}
    const bounds=[Math.min(...selected.map(p=>p.bbox[0])),Math.min(...selected.map(p=>p.bbox[1])),Math.max(...selected.map(p=>p.bbox[2])),Math.max(...selected.map(p=>p.bbox[3]))];
    return {region,union,bounds};
  });
  return (t:SurfaceTriangle):{target?:SurfaceTarget;rejection?:{reason:string;regions:string[];overlapMetres2:number;outsideMetres2:number}}=>{
    const [a,b,c]=t.points,ab=b.map((v,i)=>v-a[i]!),ac=c.map((v,i)=>v-a[i]!);
    const nx=ab[1]!*ac[2]!-ab[2]!*ac[1]!,ny=ab[2]!*ac[0]!-ab[0]!*ac[2]!,nz=ab[0]!*ac[1]!-ab[1]!*ac[0]!,length=Math.hypot(nx,ny,nz);
    if(!length||ny/length<plan.minimumNormalY)return {};
    const ring=t.points.map(p=>[p[0],-p[2]] as [number,number]),tri=[ring] as MultiPolygon,total=Math.abs(ny)/2;
    const bounds=[Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))];
    const hits:{id:string;outside:number;overlap:number;proof:NativeCoverageProof|null}[]=[];
    for(const {region,union,bounds:bbox}of regions){
      if(!region.existingFinishes.includes(t.finish as PavingFinish)||bounds[2]!<bbox[0]!||bounds[0]!>bbox[2]!||bounds[3]!<bbox[1]!||bounds[1]!>bbox[3]!)continue;
      const fragments=polygonClipping.difference(tri,union),outside=pavingPolygonArea(fragments),overlap=Math.max(0,total-outside);
      const roi=region.runtimeBoundsXZ,insideRoi=!roi||t.points.every(p=>p[0]>=roi[0]&&p[0]<=roi[2]&&p[2]>=roi[1]&&p[2]<=roi[3]);
      if(overlap>Math.max(1e-10,total*1e-10))hits.push({id:region.id,outside,overlap,proof:insideRoi?nativeFloat32CoverageProof(t.points,fragments,union):null});
    }
    if(!hits.length)return {};
    const complete=hits.filter(h=>h.proof!==null);
    if(complete.length===1){const h=complete[0]!;return {target:{node:t.node,primitive:t.primitive,triangle:t.triangle,key:pavingTriangleKey(t.points),region:h.id,...(h.proof!.fragments.length?{nativeCoverage:h.proof!}:{}),...(hits.length>1?{adjacentRegions:hits.filter(q=>q.id!==h.id).map(q=>q.id)}:{})}};}
    return {rejection:{reason:hits.length>1?'ambiguous-region-overlap':'partial-source-coverage',regions:hits.map(h=>h.id),overlapMetres2:Math.max(...hits.map(h=>h.overlap)),outsideMetres2:Math.min(...hits.map(h=>h.outside))}};
  };
}
export function createPavingCoverageAudit(plan:ResurfacingPlan,parts:readonly LocalPolygon[]){
  const records=plan.regions.flatMap(region=>parts.filter(p=>region.partIds.includes(p.id.split('#')[0]!)).map(p=>{
    let polygon:ReturnType<typeof polygonClipping.intersection>=[p.rings.map(r=>r.map(v=>[v[0],v[1]] as [number,number]))];
    if(region.runtimeBoundsXZ){const [x0,z0,x1,z1]=region.runtimeBoundsXZ;polygon=polygonClipping.intersection(polygon,[[[x0,-z1],[x1,-z1],[x1,-z0],[x0,-z0]]]);}
    return {region:region.id,part:p.id,sourceMaterial:String(p.properties.materiaali),sourceAreaWithinBoundsMetres2:pavingPolygonArea(polygon),qualifiedFloorTriangleAreaMetres2:0,partiallyCoveredTriangleAreaMetres2:0,polygon,bbox:p.bbox};
  }));
  return {
    observe(t:SurfaceTriangle,result:ReturnType<ReturnType<typeof createResurfacingSelector>>){
      if(!result.target&&!result.rejection)return;const tri=[t.points.map(p=>[p[0],-p[2]] as [number,number])];
      for(const r of records){if(result.target?.region!==r.region&&!result.rejection?.regions.includes(r.region))continue;
        if(t.points.every(p=>p[0]<r.bbox[0])||t.points.every(p=>p[0]>r.bbox[2])||t.points.every(p=>-p[2]<r.bbox[1])||t.points.every(p=>-p[2]>r.bbox[3]))continue;
        const a=pavingPolygonArea(polygonClipping.intersection(tri,r.polygon));if(result.target)r.qualifiedFloorTriangleAreaMetres2+=a;else r.partiallyCoveredTriangleAreaMetres2+=a;
      }
    },
    report(){return records.map(({polygon,bbox,...row})=>({...row,unqualifiedSourceAreaMetres2:Math.max(0,row.sourceAreaWithinBoundsMetres2-row.qualifiedFloorTriangleAreaMetres2),note:'Source footprint area can include actual building/stair exclusions. Qualified area is the sum of exact selected floor-triangle intersections; overlaps are disclosed by excess rather than hidden.'}));}
  };
}
