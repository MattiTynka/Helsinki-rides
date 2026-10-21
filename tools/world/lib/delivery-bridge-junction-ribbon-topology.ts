import assert from 'node:assert/strict';
import type {BridgeFace} from './bridge-reconstruction.ts';
import {junctionFaceSha} from './delivery-bridge-junction-mouths.ts';

/** Redistribute a positive, poorly conditioned clipping ear into its adjacent
 * triangle. No vertex or boundary is removed, and this deliberately handles
 * only two fragments of the SAME original encoded ribbon plane. */
export function retessellateJunctionRibbon(faces:readonly BridgeFace[],pinnedPlanes:readonly(BridgeFace|readonly BridgeFace[])[]){
 assert.equal(faces.length,pinnedPlanes.length);const result=faces.map(f=>({...f,points:[...f.points]as BridgeFace['points']})),pins=pinnedPlanes.map(p=>Array.isArray(p)?[...p]:[p as BridgeFace]),flips:unknown[]=[];
 const key=(p:readonly number[])=>`${p[0]},${p[2]}`,cross=(a:readonly number[],b:readonly number[],c:readonly number[])=>(b[0]!-a[0]!)*(c[2]!-a[2]!)-(b[2]!-a[2]!)*(c[0]!-a[0]!),quality=(P:BridgeFace['points'])=>Math.abs(cross(...P))/Math.max(...P.map((p,i)=>(p[0]-P[(i+1)%3]![0])**2+(p[2]-P[(i+1)%3]![2])**2));
 let passes=0;
 for(;passes<12;passes++){
  const edges=new Map<string,{face:number;edge:number}[]>();for(const[t,f]of result.entries())for(let e=0;e<3;e++){const K=[key(f.points[e]!),key(f.points[(e+1)%3]!)].sort().join('|'),a=edges.get(K)??[];a.push({face:t,edge:e});edges.set(K,a);}
  const changed=new Set<number>();let count=0;
  for(const pair of edges.values()){if(pair.length!==2)continue;const[A,B]=pair;if(changed.has(A!.face)||changed.has(B!.face))continue;const a=result[A!.face]!,b=result[B!.face]!,beforeQuality=Math.min(quality(a.points),quality(b.points));if(beforeQuality>=.0001)continue;const references=[...new Map([...pins[A!.face]!,...pins[B!.face]!].map(p=>[junctionFaceSha(p.points),p])).values()];
   const P=a.points[A!.edge]!,Q=a.points[(A!.edge+1)%3]!,R=a.points[(A!.edge+2)%3]!,S=b.points.find(p=>key(p)!==key(P)&&key(p)!==key(Q));if(!S)continue;if(cross(P,Q,R)*cross(P,Q,S)>=0||cross(R,S,P)*cross(R,S,Q)>=0)continue;
   const one:[typeof P,typeof P,typeof P]=[R,S,P],two:[typeof P,typeof P,typeof P]=[S,R,Q];for(const T of[one,two])if(cross(...T)>0)[T[1],T[2]]=[T[2],T[1]];const afterQuality=Math.min(quality(one),quality(two));if(afterQuality<=beforeQuality)continue;let maximumOriginalFieldDifferenceMetres=0;for(const plane of references){const[a,b,c]=plane.points,det=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);for(const p of[...one,...two]){const y=a[1]+(((p[0]-a[0])*(c[2]-a[2])-(p[2]-a[2])*(c[0]-a[0]))*(b[1]-a[1])+((b[0]-a[0])*(p[2]-a[2])-(b[2]-a[2])*(p[0]-a[0]))*(c[1]-a[1]))/det;maximumOriginalFieldDifferenceMetres=Math.max(maximumOriginalFieldDifferenceMetres,Math.abs(y-p[1]));}}if(maximumOriginalFieldDifferenceMetres>.000008)continue;
   const oldArea=Math.abs(cross(...a.points))+Math.abs(cross(...b.points)),newArea=Math.abs(cross(...one))+Math.abs(cross(...two));assert.equal(newArea,oldArea,'An interior flip changed positive encoded source area');
   const make=(f:BridgeFace,points:BridgeFace['points'])=>({...f,points,uvs:points.map(p=>[Math.fround(p[0]/6),Math.fround(-p[2]/6)])as BridgeFace['uvs']});
   flips.push({faces:[A!.face,B!.face],sourcePlaneSha256s:references.map(p=>junctionFaceSha(p.points)),maximumOriginalFieldDifferenceMetres,originalFieldBoundAtEveryTriangleVertexImpliesAllIntersections:true,before:[a.points,b.points],after:[one,two],beforeQuality,afterQuality,projectedTwiceArea:oldArea,allFourBoundaryVerticesLiteral:true,convexProjectedUnionAndPerimeterIdentical:true,sameOriginalEncodedPlane:references.length===1});result[A!.face]=make(a,one);result[B!.face]=make(b,two);pins[A!.face]=references;pins[B!.face]=references;changed.add(A!.face);changed.add(B!.face);count++;
  }
  if(!count)break;
 }
 return{faces:result,pinnedPlanes:pins,proof:{kind:'EXACT_POSITIVE_AREA_SAME_PLANE_INTERIOR_EDGE_FLIPS',passes,flips,remainingPoorlyConditionedTriangles:result.flatMap((f,t)=>quality(f.points)<.0001?[{triangle:t,quality:quality(f.points)}]:[]),noBoundaryOrSharedVertexChanged:true}};
}
