import type {TriMeshCollider} from '../../../packages/world-schema/src/index.ts';

export interface GroundRayHit {y:number;surface:{group:string}|null}
export interface GroundShapeHit {height:number;surface:{group:string}|null;contact?:unknown}
export const nativeGroundPoint=(x:number,z:number)=>({x:Math.fround(x),z:Math.fround(z)});

/** Query the actual Float32 HCOL triangles with strict projected containment. No barycentric epsilon
 * may fill a finite crack: neighbouring rays and a sphere can bridge one, so they are insufficient alone. */
export function exactGroundTriangles(colliders:readonly TriMeshCollider[],x:number,z:number){
  const result:{collider:string;triangle:number;vertices:number[][];barycentric:number[];height:number}[]=[];
  for(const piece of colliders)for(let t=0;t<piece.indices.length;t+=3){
    const p=piece.positions,a=piece.indices[t]!*3,b=piece.indices[t+1]!*3,c=piece.indices[t+2]!*3;
    if(x<Math.min(p[a]!,p[b]!,p[c]!)||x>Math.max(p[a]!,p[b]!,p[c]!)||z<Math.min(p[a+2]!,p[b+2]!,p[c+2]!)||z>Math.max(p[a+2]!,p[b+2]!,p[c+2]!))continue;
    const denominator=(p[b+2]!-p[c+2]!)*(p[a]!-p[c]!)+(p[c]!-p[b]!)*(p[a+2]!-p[c+2]!);if(denominator===0)continue;
    const u=((p[b+2]!-p[c+2]!)*(x-p[c]!)+(p[c]!-p[b]!)*(z-p[c+2]!))/denominator,v=((p[c+2]!-p[a+2]!)*(x-p[c]!)+(p[a]!-p[c]!)*(z-p[c+2]!))/denominator;
    if(u>=0&&v>=0&&u+v<=1)result.push({collider:piece.id,triangle:t/3,vertices:[a,b,c].map(i=>Array.from(p.subarray(i,i+3))),barycentric:[u,v,1-u-v],height:u*p[a+1]!+v*p[b+1]!+(1-u-v)*p[c+1]!});
  }return result;
}

export function proveGroundRayEdge(options:{colliders:readonly TriMeshCollider[];height:(x:number,z:number)=>number|null;ray:(x:number,y:number,z:number)=>GroundRayHit|null;sphere:(x:number,y:number,z:number,radius:number)=>GroundShapeHit|null;x:number;z:number}){
  const {x,z}=nativeGroundPoint(options.x,options.z),visual=options.height(x,z),triangles=exactGroundTriangles(options.colliders,x,z),meshHeight=triangles.length?Math.max(...triangles.map(t=>t.height)):null,origin=Math.fround((visual??0)+2);
  const center=options.ray(x,origin,z),neighbors=[[-.001,0],[.001,0],[0,-.001],[0,.001]].map(([dx,dz])=>{
    const point=nativeGroundPoint(x+dx!,z+dz!),height=options.height(point.x,point.z),hit=options.ray(point.x,origin,point.z);return{...point,visual:height,hit,aligned:height!==null&&hit?.surface?.group==='ground'&&Math.abs(hit.y-height)<.001};
  });
  const shape=options.sphere(x,origin,z,.01),pass=visual!==null&&meshHeight!==null&&Math.abs(meshHeight-visual)<1e-6&&((neighbors[0]!.aligned&&neighbors[1]!.aligned)||(neighbors[2]!.aligned&&neighbors[3]!.aligned))&&shape?.surface?.group==='ground'&&Math.abs(shape.height-visual)<.003;
  return{requested:{x:options.x,z:options.z},query:{x,z},coordinateShiftMetres:Math.hypot(x-options.x,z-options.z),pass,visual,meshHeight,triangles,center,neighbors,sphereRadius:.01,shape};
}
