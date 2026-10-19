// Exact convex partitioning of numerical rail-fringe authority. The source
// floors are never expanded: the allowance only qualifies missing visual rail
// fragments whose complete width and source distance fit coordinate precision.
import earcut from 'earcut';
import type {Polygon,MultiPolygon} from 'polygon-clipping';
import type {TramPoint,TramGroundTriangle,TramCoverageFringe} from './tram-visuals.ts';

const GRID=.000001;
const cross=(a:TramPoint,b:TramPoint,c:TramPoint)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const area=(r:readonly TramPoint[])=>{const a=r[0]!;let sum=0;for(let i=1;i<r.length-1;i++)sum+=cross(a,r[i]!,r[i+1]!);return Math.abs(sum)/2;};
const halfUlp=(n:number)=>n===0?2**-150:2**(Math.max(-126,Math.floor(Math.log2(Math.abs(n))))-24);
const box=(r:readonly TramPoint[])=>[Math.min(...r.map(p=>p[0])),Math.min(...r.map(p=>p[1])),Math.max(...r.map(p=>p[0])),Math.max(...r.map(p=>p[1]))];
const touches=(a:number[],b:number[])=>a[0]!<=b[2]!&&a[2]!>=b[0]!&&a[1]!<=b[3]!&&a[3]!>=b[1]!;
function halfPlane(r:readonly TramPoint[],value:(p:TramPoint)=>number){const result:TramPoint[]=[];for(let i=0;i<r.length;i++){const a=r[i]!,b=r[(i+1)%r.length]!,va=value(a),vb=value(b);if(va>=0)result.push(a);if((va>=0)!==(vb>=0)){const t=va/(va-vb);result.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}return result;}
function subtractTriangle(p:TramPoint[],triangle:TramPoint[]):TramPoint[][]{
  const outside:TramPoint[][]=[],sign=Math.sign(cross(triangle[0]!,triangle[1]!,triangle[2]!));let rest=p;
  for(let edge=0;edge<3&&rest.length>=3;edge++){
    const a=triangle[edge]!,b=triangle[(edge+1)%3]!,value=(p:TramPoint)=>cross(a,b,p)*sign;
    const piece=halfPlane(rest,p=>-value(p));if(piece.length>=3&&area(piece)>0)outside.push(piece);rest=halfPlane(rest,value);
  }
  return outside;
}
function distance(p:TramPoint,t:TramPoint[]){const signs=t.map((a,i)=>cross(a,t[(i+1)%3]!,p));if(signs.every(x=>x>=0)||signs.every(x=>x<=0))return 0;return Math.min(...t.map((a,i)=>{const b=t[(i+1)%3]!,dx=b[0]-a[0],dz=b[1]-a[1],u=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz)));return Math.hypot(p[0]-a[0]-u*dx,p[1]-a[1]-u*dz);}));}
function width(points:TramPoint[]){let result=Infinity;for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!,dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);if(!length)continue;const values=points.map(p=>(-dz*(p[0]-a[0])+dx*(p[1]-a[1]))/length);result=Math.min(result,Math.max(...values)-Math.min(...values));}return result;}
function triangulate(polygon:Polygon){const coordinates:number[]=[],holes:number[]=[];polygon.forEach((ring,i)=>{if(i)holes.push(coordinates.length/2);for(const p of ring.slice(0,-1))coordinates.push(...p);});const indices=earcut(coordinates,holes,2),triangles:TramPoint[][]=[];for(let i=0;i<indices.length;i+=3)triangles.push(indices.slice(i,i+3).map(n=>[coordinates[n*2]!,coordinates[n*2+1]!] as TramPoint));return triangles;}

export function certifyTramCoverageFringes(missing:MultiPolygon,ground:readonly TramGroundTriangle[]):(TramCoverageFringe&{maximumPieceWidth:number;exactSourcePartition:boolean;outsideGroundArea:number})[]{
  const allSource=ground.map(t=>t.vertices.map(p=>[p[0],p[2]] as TramPoint));
  return missing.map(polygon=>{
    const points=polygon.flat(),f32HalfUlpXZ:[number,number]=[Math.max(...points.map(p=>halfUlp(p[0]))),Math.max(...points.map(p=>halfUlp(p[1])))],booleanAllowance=2*Math.SQRT2*GRID,allowedDistance=Math.hypot(...f32HalfUlpXZ)+booleanAllowance;
    const bounds=box(points),source=allSource.filter(t=>touches(box(t),[bounds[0]!-allowedDistance,bounds[1]!-allowedDistance,bounds[2]!+allowedDistance,bounds[3]!+allowedDistance]));
    const triangles=triangulate(polygon),maximumPieceWidth=Math.max(0,...triangles.map(width));let pieces=triangles;
    // Subtract exact, unbuffered source floor triangles. Every surviving convex
    // piece lies outside actual ground; its distance certificate cannot be
    // loosened by a coarse subdivision straddling several source faces.
    for(const triangle of source){const tb=box(triangle);pieces=pieces.flatMap(piece=>touches(box(piece),tb)?subtractTriangle(piece,triangle):[piece]);if(!pieces.length)break;}
    let bound=0;for(const piece of pieces){const upper=source.length?Math.min(...source.map(t=>Math.max(...piece.map(p=>distance(p,t))))):Infinity;bound=Math.max(bound,upper);}
    const polygonArea=polygon.reduce((n,r,i)=>n+(i? -1:1)*area(r.slice(0,-1)),0),outsideGroundArea=pieces.reduce((n,p)=>n+area(p),0);
    return{polygon,area:polygonArea,minimumContainingWidth:width(points),maximumPieceWidth,maximumDistanceToGroundUpperBound:bound,f32HalfUlpXZ,booleanAllowance,allowedDistance,qualified:bound<=allowedDistance&&maximumPieceWidth<=allowedDistance,exactSourcePartition:true,outsideGroundArea};
  });
}
