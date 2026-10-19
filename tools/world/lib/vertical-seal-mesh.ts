// Triangulate an already qualified vertical section without allowing Float32
// rounding to turn three nearly collinear stations into a horizontal sliver.
// Every triangle uses only two XZ stations and contains a vertical vertex pair.
import assert from 'node:assert/strict';

type Point = readonly [number,number,number];
type SectionPoint = readonly [number,number];
export interface VerticalSeal {
  readonly top: readonly [Point,Point];
  readonly bottom: readonly [Point,Point];
  readonly polygon: readonly (readonly Point[])[];
  readonly section: readonly (readonly SectionPoint[])[];
}
type Edge = {a:SectionPoint;b:SectionPoint;min:number;max:number;ring:number};
function ringArea(r:readonly SectionPoint[]):number {
  const origin=r[0]!;let area=0;
  for(let i=0;i<r.length;i++){const a=r[i]!,b=r[(i+1)%r.length]!;area+=(a[0]-origin[0])*(b[1]-origin[1])-(b[0]-origin[0])*(a[1]-origin[1]);}
  return Math.abs(area)/2;
}
const height=(edge:Edge,t:number)=>t===edge.a[0]?edge.a[1]:t===edge.b[0]?edge.b[1]:edge.a[1]+(edge.b[1]-edge.a[1])*(t-edge.a[0])/(edge.b[0]-edge.a[0]);

export function meshVerticalSeals(seals:readonly VerticalSeal[]) {
  const positions:number[]=[],uvs:number[]=[],indices:number[]=[];
  const stats={polygons:0,stationIntervals:0,intersectionStations:0,trapezoids:0,emittedTriangles:0,collapsedStationIntervals:0,collapsedTriangles:0,sectionAreaBefore:0,sectionAreaAfter:0,holeAreaInsideOuter:0,holeAreaOutsideOuter:0,maximumSectionAreaError:0,maximumStationConflictMetres:0,maximumNormalY:0,actualFrontFaceAreaMetres2:0};
  for(const seal of seals){
    assert.equal(seal.polygon.length,seal.section.length,'Section/ring correspondence required');assert.ok(seal.section.length>0);
    const stations=new Map<number,{x:number;z:number}>(),edges:Edge[]=[];
    for(let ri=0;ri<seal.section.length;ri++){
      const ring=seal.section[ri]!,world=seal.polygon[ri]!;assert.equal(ring.length,world.length);assert.ok(ring.length>=3);
      for(let k=0;k<ring.length;k++){
        const p=ring[k]!,v=world[k]!;assert.ok([...p,...v].every(Number.isFinite));assert.ok(Math.abs(v[1]-p[1])<=0.0001,'World and section heights disagree');
        const q={x:Math.fround(v[0]),z:Math.fround(v[2])},old=stations.get(p[0]);
        if(old){const error=Math.hypot(old.x-q.x,old.z-q.z);stats.maximumStationConflictMetres=Math.max(stats.maximumStationConflictMetres,error);assert.ok(error<=0.0002,'One section station has inconsistent source XZ');}
        else stations.set(p[0],q);
        const b=ring[(k+1)%ring.length]!;if(p[0]!==b[0])edges.push({a:p,b,min:Math.min(p[0],b[0]),max:Math.max(p[0],b[0]),ring:ri});
      }
    }
    // Holes are subtraction domains, including when an upstream numerical
    // boolean left a hole partly outside its outer ring. Crossing events make
    // the same outer-minus-hole-union semantics work for overlapping holes.
    const originalTs=[...stations.keys()].sort((a,b)=>a-b);
    for(let i=0;i<edges.length;i++)for(let j=0;j<i;j++){const a=edges[i]!,b=edges[j]!,lo=Math.max(a.min,b.min),hi=Math.min(a.max,b.max);if(hi<=lo)continue;const d0=height(a,lo)-height(b,lo),d1=height(a,hi)-height(b,hi);if(d0*d1>=0)continue;const t=lo+(hi-lo)*d0/(d0-d1);if(!(t>lo&&t<hi)||stations.has(t))continue;
      const upper=originalTs.findIndex(s=>s>t);assert.ok(upper>0);const left=originalTs[upper-1]!,right=originalTs[upper]!,A=stations.get(left)!,B=stations.get(right)!,u=(t-left)/(right-left);stations.set(t,{x:Math.fround(A.x+(B.x-A.x)*u),z:Math.fround(A.z+(B.z-A.z)*u)});stats.intersectionStations++;
    }
    const ts=[...stations.keys()].sort((a,b)=>a-b),outerArea=ringArea(seal.section[0]!);let decomposed=0,holeInside=0,holeOutside=0;
    for(let k=0;k+1<ts.length;k++){
      const t0=ts[k]!,t1=ts[k+1]!;if(t1===t0)continue;stats.stationIntervals++;
      // Consecutive stations contain no ring vertex. An edge spanning this
      // entire open interval crosses every interior scanline exactly once.
      const crossing=edges.filter(e=>e.min<=t0&&e.max>=t1).map(e=>{const h0=height(e,t0),h1=height(e,t1);return{h0,h1,mid:h0+(h1-h0)/2,ring:e.ring};}).sort((a,b)=>a.mid-b.mid||a.h0-b.h0||a.h1-b.h1);
      assert.equal(crossing.length%2,0,'Invalid even-odd vertical section');const X0=stations.get(t0)!,X1=stations.get(t1)!,inside=Array(seal.section.length).fill(false);
      for(let j=0;j+1<crossing.length;j++){
        const low=crossing[j]!,high=crossing[j+1]!;inside[low.ring]=!inside[low.ring];const d0=high.h0-low.h0,d1=high.h1-low.h1;assert.ok(d0>=-1e-10&&d1>=-1e-10,'Section edges cross between stations');
        const area=(d0+d1)*(t1-t0)/2;if(area===0)continue;const hole=inside.slice(1).some(Boolean);if(hole){if(inside[0])holeInside+=area;else holeOutside+=area;}
        if(!inside[0]||hole)continue;decomposed+=area;stats.trapezoids++;
        if(X0.x===X1.x&&X0.z===X1.z){stats.collapsedStationIntervals++;stats.collapsedTriangles+=2;continue;}
        const points:Point[]=[[X0.x,Math.fround(high.h0),X0.z],[X1.x,Math.fround(high.h1),X1.z],[X1.x,Math.fround(low.h1),X1.z],[X0.x,Math.fround(low.h0),X0.z]];
        for(const ids of [[0,1,2],[0,2,3]]){
          const [a,b,c]=ids.map(i=>points[i]!) as [Point,Point,Point],u=b.map((x,i)=>x-a[i]!),v=c.map((x,i)=>x-a[i]!),normal=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],length=Math.hypot(...normal);
          assert.ok(normal[1]===0,'An emitted Float32 triangle must be exactly vertical');if(length===0){stats.collapsedTriangles++;continue;}
          assert.ok(Number.isFinite(length));const first=positions.length/3;positions.push(...a,...b,...c);for(const p of [a,b,c])uvs.push(p[0]/3,p[1]/3);indices.push(first,first+1,first+2,first,first+2,first+1);stats.emittedTriangles+=2;stats.actualFrontFaceAreaMetres2+=length/2;
        }
      }
    }
    const expected=outerArea-holeInside,error=Math.abs(expected-decomposed);stats.maximumSectionAreaError=Math.max(stats.maximumSectionAreaError,error);assert.ok(error<=Math.max(1e-10,Math.abs(expected)*1e-8),'Vertical decomposition changed the selected section area');stats.sectionAreaBefore+=expected;stats.sectionAreaAfter+=decomposed;stats.holeAreaInsideOuter+=holeInside;stats.holeAreaOutsideOuter+=holeOutside;stats.polygons++;
  }
  return{positions,uvs,indices,stats};
}
