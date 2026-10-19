// A grade operation may preserve an authored vertical face but displace its
// lower edge differently from the adjacent floor. Close only this evidenced
// interface; never resample terrain or move the existing top/floor geometry.
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import {pointInPolygon, ringDistance, type LocalPolygon, type Pt} from './geometry.ts';

export type SealPoint = readonly [number, number, number];
export interface GroundInterfaceSource {
  readonly id: string;
  readonly cell: string;
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly tag?: string;
  readonly triangleTags?: readonly string[];
}
export interface GroundInterfaceSeal {
  readonly cell: string;
  readonly sourceId: string;
  readonly sideTag: string;
  readonly sideTriangle: number;
  readonly groundSourceId: string;
  readonly groundTag: string;
  readonly groundTriangle: number;
  readonly top: readonly [SealPoint, SealPoint];
  readonly bottom: readonly [SealPoint, SealPoint];
  readonly gap: readonly [number, number];
  readonly length: number;
  /** Remaining vertical polygon after subtracting all existing face coverage. */
  readonly polygon: readonly SealPoint[][];
  readonly section: readonly Pt[][];
}
export interface GroundInterfaceSealOptions {
  readonly protectedArea: {minX:number;maxX:number;minZ:number;maxZ:number};
  /** Source water, unsupported decks, and any explicitly protected interface. */
  readonly excludedMasks?: readonly LocalPolygon[];
  readonly waterMasks?: readonly LocalPolygon[];
  /** Only real registered deck footprints can own a side above source water. */
  readonly registeredDecks?: readonly LocalPolygon[];
  readonly maximumGapMetres?: number;
  /** Only covers Float32 export uncertainty, never source geometry offsets. */
  readonly floatToleranceMetres?: number;
}
type V = [number,number,number];
type Triangle = {v:[V,V,V];source:string;cell:string;tag:string;triangle:number;den:number};
type Edge = {a:V;b:V;third:V;count:number;triangle:Triangle};
type Interval = {lo:number;hi:number;h0:number;dh:number;triangle:Triangle};
const xyz = (p:SealPoint)=>p.join(','), xz = (p:SealPoint)=>`${p[0]},${p[2]}`;
const key = (a:SealPoint,b:SealPoint,encode=xyz)=>[encode(a),encode(b)].sort().join('|');
const at = (a:SealPoint,b:SealPoint,t:number):V=>a.map((v,i)=>v+(b[i]!-v)*t) as V;
const sideTags = new Set(['wall','wall-join','curb']);
function addEdges(edges:Map<string,Edge>, triangle:Triangle) {
  for(let k=0;k<3;k++) {const a=triangle.v[k]!,b=triangle.v[(k+1)%3]!,third=triangle.v[(k+2)%3]!,k0=key(a,b),old=edges.get(k0);if(old)old.count++;else edges.set(k0,{a,b,third,count:1,triangle});}
}
function touchesMask(a:V,b:V,p:LocalPolygon,tol:number):boolean {
  const A:Pt=[a[0],-a[2]],B:Pt=[b[0],-b[2]],dx=B[0]-A[0],dy=B[1]-A[1];
  if(Math.max(A[0],B[0])<p.bbox[0]-tol||Math.min(A[0],B[0])>p.bbox[2]+tol||Math.max(A[1],B[1])<p.bbox[1]-tol||Math.min(A[1],B[1])>p.bbox[3]+tol)return false;
  if([A,B].some(q=>pointInPolygon(q,p.rings)||p.rings.some(r=>ringDistance(q,r)<=tol)))return true;
  for(const ring of p.rings)for(let i=0;i<ring.length;i++){const c=ring[i]!,d=ring[(i+1)%ring.length]!,ux=d[0]-c[0],uy=d[1]-c[1],den=dx*uy-dy*ux;if(Math.abs(den)<1e-12)continue;const t=((c[0]-A[0])*uy-(c[1]-A[1])*ux)/den,s=((c[0]-A[0])*dy-(c[1]-A[1])*dx)/den;if(t>=0&&t<=1&&s>=0&&s<=1)return true;}
  return false;
}
function protectedInterval(a:V,b:V,p:GroundInterfaceSealOptions['protectedArea']):boolean {
  let lo=0,hi=1;
  for(const [axis,min,max] of [[0,p.minX,p.maxX],[2,p.minZ,p.maxZ]] as const){const d=b[axis]-a[axis];if(Math.abs(d)<1e-12){if(a[axis]<min||a[axis]>max)return false;}else{const s=(min-a[axis])/d,t=(max-a[axis])/d;lo=Math.max(lo,Math.min(s,t));hi=Math.min(hi,Math.max(s,t));}}
  return hi>=lo;
}
function supportedAlong(a:V,b:V,p:LocalPolygon,tol:number):boolean {
  const A:Pt=[a[0],-a[2]],B:Pt=[b[0],-b[2]],dx=B[0]-A[0],dy=B[1]-A[1],split=[0,1];
  const inside=(t:number)=>{const q:Pt=[A[0]+dx*t,A[1]+dy*t];return pointInPolygon(q,p.rings)||p.rings.some(r=>ringDistance(q,r)<=tol);};
  if(!inside(0)||!inside(1))return false;
  for(const ring of p.rings)for(let i=0;i<ring.length;i++){const c=ring[i]!,d=ring[(i+1)%ring.length]!,ux=d[0]-c[0],uy=d[1]-c[1],den=dx*uy-dy*ux;if(Math.abs(den)<1e-12)continue;const t=((c[0]-A[0])*uy-(c[1]-A[1])*ux)/den,s=((c[0]-A[0])*dy-(c[1]-A[1])*dx)/den;if(t>0&&t<1&&s>=0&&s<=1)split.push(t);}
  split.sort((a,b)=>a-b);return split.slice(1).every((t,i)=>inside((t+split[i]!)/2));
}

/** Retry only diagnosed sweep-line failures. The section uses along-edge fractions and metre heights. */
export function groundInterfaceBoolean(operation:'intersection'|'difference',input:Pt[][][],length:number,onRetry:(maximumDisplacementMetres:number)=>void) {
  assert.ok(Number.isFinite(length)&&length>0);
  try{return polygonClipping[operation](input[0]!,...input.slice(1)) as Pt[][][];}
  catch(error){
    const sweepFailure=error instanceof Error&&(/Unable to complete output ring|Unable to find segment/.test(error.message)||
      (error instanceof TypeError&&error.message==="Cannot read properties of null (reading 'length')"&&/Segment\.afterState/.test(error.stack??'')));
    if(!sweepFailure)throw error;
    const tStep=1e-9/Math.max(1,length),fixed=input.map(poly=>poly.map(r=>r.map(([t,h])=>[Math.round(t/tStep)*tStep,Math.round(h*1e9)/1e9] as Pt)));
    onRetry(Math.SQRT2*0.5e-9);
    return polygonClipping[operation](fixed[0]!,...fixed.slice(1)) as Pt[][][];
  }
}

/** Find conservative, append-only vertical repairs one cell at a time.
 * Exact endpoint correspondence is deliberately required. Partial-overlap or
 * independently offset source boundaries are reported as unmatched, not paved.
 * Callers must pass only actual ground groups, never buildings or safety fields. */
export function findGroundInterfaceSeals(sources:readonly GroundInterfaceSource[], options:GroundInterfaceSealOptions) {
  const tol=options.floatToleranceMetres??0.0001,maxGap=options.maximumGapMetres??0.15;
  assert.ok(tol>0&&tol<=0.0002,'Float32 tolerance must stay at or below 0.2mm');
  assert.ok(maxGap>0&&maxGap<=0.15,'The proven grade-offset gap is at most 0.15m');
  const seals:GroundInterfaceSeal[]=[],seenSeals=new Set<string>(),rejections:{cell:string;sourceId:string;triangle:number;reason:string;top:readonly [V,V]}[]=[],counts:Record<string,number>={},precisionRetries:{cell:string;triangle:number;operation:string;maximumDisplacementMetres:number}[]=[];
  const reject=(e:Edge,reason:string,a=e.a,b=e.b)=>{counts[reason]=(counts[reason]??0)+1;rejections.push({cell:e.triangle.cell,sourceId:e.triangle.source,triangle:e.triangle.triangle,reason,top:[a,b]});};
  for(const cell of [...new Set(sources.map(s=>s.cell))]) {
    const topEdges=new Map<string,Edge>(),sideEdges=new Map<string,Edge>(),seen=new Set<string>();
    const sideBuckets=new Map<string,Triangle[]>();
    const keys=(points:readonly SealPoint[])=>{const out:string[]=[];for(let x=Math.floor(Math.min(...points.map(p=>p[0]))/4);x<=Math.floor(Math.max(...points.map(p=>p[0]))/4);x++)for(let z=Math.floor(Math.min(...points.map(p=>p[2]))/4);z<=Math.floor(Math.max(...points.map(p=>p[2]))/4);z++)out.push(`${x}:${z}`);return out;};
    for(const s of sources.filter(s=>s.cell===cell))for(let j=0;j<s.indices.length;j+=3){const tag=s.triangleTags?.[j/3]??s.tag??'',v=[0,1,2].map(k=>[0,1,2].map(a=>Math.fround(s.positions[s.indices[j+k]!*3+a]!)) as V) as [V,V,V],a=v[0],b=v[1],c=v[2],ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,L=Math.hypot(nx,ny,nz);if(L<1e-10)continue;
      const side=sideTags.has(tag),top=(tag.startsWith('raised:')||tag.startsWith('road:'))&&ny/L>.3;if(!side&&!top)continue;
      const k=`${side?'side':'top'}:${v.map(xyz).sort().join('|')}`;if(seen.has(k))continue;seen.add(k);
      const t:Triangle={v,source:s.id,cell,tag,triangle:j/3,den:(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2])};
      addEdges(side?sideEdges:topEdges,t);if(side)for(const k of keys(v)){const list=sideBuckets.get(k)??[];list.push(t);sideBuckets.set(k,list);}
    }
    const topPairs=new Map<string,Edge[]>();for(const e of topEdges.values())if(e.count===1){const k=key(e.a,e.b,xz),list=topPairs.get(k)??[];list.push(e);topPairs.set(k,list);}
    for(const e of sideEdges.values())if(e.count===1){const dx=e.b[0]-e.a[0],dz=e.b[2]-e.a[2],length=Math.hypot(dx,dz);if(length<0.001)continue;
      const thirdT=((e.third[0]-e.a[0])*dx+(e.third[2]-e.a[2])*dz)/(length*length),relative=e.third[1]-(e.a[1]+(e.b[1]-e.a[1])*thirdT);if(relative< -0.002)continue;
      const boolean=(operation:'intersection'|'difference',...input:Pt[][][])=>groundInterfaceBoolean(operation,input,length,
        maximumDisplacementMetres=>precisionRetries.push({cell,triangle:e.triangle.triangle,operation,maximumDisplacementMetres}));
      const pairs=topPairs.get(key(e.a,e.b,xz));if(!pairs){counts.unmatched=(counts.unmatched??0)+1;continue;}
      // A floor behind the wall cannot hide an opening on its other side. Use
      // the highest actual floor separately on each evidenced exterior side.
      const sideOf=(p:V)=>((p[0]-e.a[0])*dz-(p[2]-e.a[2])*dx)/length;
      const directions=[...new Set(pairs.map(p=>Math.sign(sideOf(p.third))).filter(s=>s!==0))];
      for(const direction of directions){
      // Only an exposed, coincident ground boundary owns the bottom of this
      // interface. A triangle behind/above the gap is not a face-plane mask.
      const intervals:Interval[]=pairs.filter(p=>sideOf(p.third)*direction>1e-9).map(p=>{const a=xz(p.a)===xz(e.a)?p.a:p.b,b=xz(p.b)===xz(e.b)?p.b:p.a;return{lo:0,hi:1,h0:a[1],dh:b[1]-a[1],triangle:p.triangle};}),split=[0,1];
      for(let i=0;i<intervals.length;i++){const p=intervals[i]!,den=e.b[1]-e.a[1]-p.dh;if(Math.abs(den)>1e-12){const t=(p.h0-e.a[1])/den;if(t>p.lo&&t<p.hi)split.push(t);}for(let j=0;j<i;j++){const q=intervals[j]!;if(Math.abs(p.dh-q.dh)<1e-12)continue;const t=(q.h0-p.h0)/(p.dh-q.dh);if(t>Math.max(p.lo,q.lo)&&t<Math.min(p.hi,q.hi))split.push(t);}}
      split.sort((a,b)=>a-b);const sides=[...new Set(keys([e.a,e.b]).flatMap(k=>sideBuckets.get(k)??[]))];
      for(let i=0;i+1<split.length;i++){const lo=split[i]!,hi=split[i+1]!,mid=(lo+hi)/2;if((hi-lo)*length<0.001)continue;const edgeHeight=e.a[1]+(e.b[1]-e.a[1])*mid;
        // A slab above the lower edge does not close the space underneath it.
        // This occurs at the measured bridge-curb wedge: retain that slab and
        // select the highest real coincident support below the exposed edge.
        const q=intervals.filter(q=>mid>=q.lo-1e-9&&mid<=q.hi+1e-9&&q.h0+q.dh*mid<=edgeHeight+tol).sort((p,q)=>(q.h0+q.dh*mid)-(p.h0+p.dh*mid))[0];if(!q)continue;
        const A=at(e.a,e.b,lo),B=at(e.a,e.b,hi),C:[number,number,number]=[A[0],q.h0+q.dh*lo,A[2]],D:[number,number,number]=[B[0],q.h0+q.dh*hi,B[2]],gap:[number,number]=[A[1]-C[1],B[1]-D[1]];
        if(Math.max(...gap)<=tol||Math.min(...gap)< -tol){counts.hiddenOrJoined=(counts.hiddenOrJoined??0)+1;continue;}
        if(Math.max(...gap)>maxGap+tol){reject(e,'above-offset-bound',A,B);continue;}
        if(protectedInterval(A,B,options.protectedArea)){reject(e,'accepted-area',A,B);continue;}
        const mask=options.excludedMasks?.find(p=>touchesMask(A,B,p,tol));if(mask){reject(e,`source-mask:${mask.id}`,A,B);continue;}
        const water=options.waterMasks?.find(p=>touchesMask(A,B,p,tol));
        if(water&&!options.registeredDecks?.some(p=>supportedAlong(A,B,p,tol))){reject(e,`source-water:${water.id}`,A,B);continue;}
        // A pre-existing collinear vertical triangle could already close this
        // interface even when its edge uses a different subdivision. Reject any
        // positive-area overlap instead of adding coplanar duplicate surfaces.
        const quad:Pt[]=[[lo,A[1]],[hi,B[1]],[hi,D[1]],[lo,C[1]]],covers:Pt[][][]=[];
        for(const t of sides){if(t.v.some(p=>Math.abs((p[0]-e.a[0])*dz-(p[2]-e.a[2])*dx)/length>tol))continue;const tri=t.v.map(p=>[((p[0]-e.a[0])*dx+(p[2]-e.a[2])*dz)/(length*length),p[1]] as Pt),area=Math.abs(tri.reduce((sum,p,k)=>{const q=tri[(k+1)%3]!;return sum+p[0]*q[1]-q[0]*p[1];},0))/2;if(area<1e-12)continue;
          const overlap=boolean('intersection',[quad],[tri]);let overlapArea=0;for(const p of overlap)for(const r of p)overlapArea+=Math.abs(r.reduce((s,a,k)=>{const b=r[(k+1)%r.length]!;return s+a[0]*b[1]-b[0]*a[1];},0))/2;
          if(overlapArea*length>tol*tol)covers.push([tri]);
        }
        const uncovered=covers.length?boolean('difference',[quad],...covers):[[quad]];
        if(!uncovered.length){reject(e,'existing-face-coverage',A,B);continue;}
        if(covers.length)counts.partialExistingFace=(counts.partialExistingFace??0)+1;
        for(const poly of uncovered){const section=poly.map(r=>r.length>1&&r[0]![0]===r.at(-1)![0]&&r[0]![1]===r.at(-1)![1]?r.slice(0,-1):r),polygon=section.map(r=>r.map(([t,h])=>{const p=at(e.a,e.b,t);p[1]=h;return p;})),sealKey=polygon.map(r=>r.map(xyz).join('|')).join(';');if(seenSeals.has(sealKey))continue;seenSeals.add(sealKey);
          seals.push({cell,sourceId:e.triangle.source,sideTag:e.triangle.tag,sideTriangle:e.triangle.triangle,groundSourceId:q.triangle.source,groundTag:q.triangle.tag,groundTriangle:q.triangle.triangle,top:[A,B],bottom:[C,D],gap,length:(hi-lo)*length,polygon,section});
        }
      }
      }
    }
  }
  return{seals,rejections,counts,precisionRetries};
}

/** Double-sided vertical faces with the existing slabs UV rule. The caller
 * appends these arrays to an existing primitive/collider; no old arrays mutate. */
export function meshGroundInterfaceSeals(seals:readonly GroundInterfaceSeal[]) {
  const positions:number[]=[],uvs:number[]=[],indices:number[]=[];
  for(const s of seals){const first=positions.length/3,points=s.polygon.flat(),flat=s.section.flat().flat(),holes:number[]=[];let count=0;for(let i=0;i<s.section.length;i++){if(i)holes.push(count);count+=s.section[i]!.length;}const tris=earcut(flat,holes,2);positions.push(...points.flat());for(const p of points)uvs.push(p[0]/3,p[1]/3);for(let i=0;i<tris.length;i+=3){const a=first+tris[i]!,b=first+tris[i+1]!,c=first+tris[i+2]!;indices.push(a,b,c,a,c,b);}}
  return{positions,uvs,indices};
}
