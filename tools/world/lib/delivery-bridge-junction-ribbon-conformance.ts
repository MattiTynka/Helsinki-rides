import polygonClipping from 'polygon-clipping';
import type {BridgeFace} from './bridge-reconstruction.ts';
type Point=[number,number];
type Edge={a:Point;b:Point;samples:Map<string,{u:number;point:Point}>};
/** Share every original-edge split with both incident faces BEFORE encoded
 * triangulation. F32 intersections bend an edge slightly; an unsplit neighbor
 * would otherwise overlap that positive sliver. All inserted vertices already
 * exist in the clipped source mesh and no footprint is padded. */
export function clipConformingRibbonDomains(faces:readonly BridgeFace[],domain:polygonClipping.MultiPolygon){
 const key=(p:Point)=>p.join(','),edges=new Map<string,Edge>(),local:Edge[][]=[],rows:polygonClipping.MultiPolygon[]=[],edgeKey=(a:Point,b:Point)=>[key(a),key(b)].sort().join('|');let maximumSourceQuantizationMetres=0,maximumRawSharedEdgeResidualMetres=0,conformingInsertions=0;
 const encoded=(p:Point):Point=>{const q:Point=[Math.fround(p[0]),Math.fround(p[1])];maximumSourceQuantizationMetres=Math.max(maximumSourceQuantizationMetres,Math.hypot(q[0]-p[0],q[1]-p[1]));return q;},onEdge=(p:Point,E:Edge)=>{const dx=E.b[0]-E.a[0],dz=E.b[1]-E.a[1],L=dx*dx+dz*dz,u=((p[0]-E.a[0])*dx+(p[1]-E.a[1])*dz)/L,distance=Math.hypot(p[0]-E.a[0]-dx*u,p[1]-E.a[1]-dz*u);return u>=-1e-12&&u<=1+1e-12&&distance<=1e-8?{u,distance}:null;};
 for(const face of faces){const points=face.points.map(p=>[p[0],p[2]]as Point),own=points.map((a,i)=>{const b=points[(i+1)%3]!,K=edgeKey(a,b);let E=edges.get(K);if(!E){E={a,b,samples:new Map()};edges.set(K,E);}return E;}),polygons=polygonClipping.intersection(domain,[points]);local.push(own);rows.push(polygons);for(const polygon of polygons)for(const ring of polygon)for(const p of ring.slice(0,-1)){const P=encoded(p);for(const E of own){const q=onEdge(p,E);if(q){maximumRawSharedEdgeResidualMetres=Math.max(maximumRawSharedEdgeResidualMetres,q.distance);E.samples.set(key(P),{u:q.u,point:P});}}}}
 const conformed=rows.map((polygons,t)=>polygons.map(polygon=>polygon.map(ring=>{const raw=ring.slice(0,-1),out:Point[]=[];for(let i=0;i<raw.length;i++){const a=raw[i]!,b=raw[(i+1)%raw.length]!,A=encoded(a),B=encoded(b);out.push(A);for(const E of local[t]!){const x=onEdge(a,E),y=onEdge(b,E);if(!x||!y||x.u===y.u)continue;const insert=[...E.samples.values()].filter(p=>p.u>Math.min(x.u,y.u)&&p.u<Math.max(x.u,y.u)&&key(p.point)!==key(A)&&key(p.point)!==key(B)).sort((a,b)=>(a.u-b.u)*Math.sign(y.u-x.u));for(const p of insert){out.push(p.point);conformingInsertions++;}break;}}return[...out,out[0]!];})));
 return{rows:conformed,rawRows:rows,proof:{maximumSourceQuantizationMetres,maximumRawSharedEdgeResidualMetres,rawEdgeClassificationBoundMetres:1e-8,conformingInsertions,sharedEdgeInventory:[...edges].filter(([,E])=>E.samples.size>2).map(([edge,E])=>({edge,original:[E.a,E.b],samples:[...E.samples.values()].sort((a,b)=>a.u-b.u)}))}};
}
