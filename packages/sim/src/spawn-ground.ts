import type{SurfaceInfo}from'./world.ts';
export interface SpawnGroundHit{readonly y:number;readonly surface:SurfaceInfo|null}
export interface SpawnGroundNormalHit extends SpawnGroundHit{readonly normalY:number}
/** A Float32 clipping seam can miss one exact spawn ray. Accept only a
 * complete1mm neighborhood on one actual walkable native level. Ordinary
 * native hits, true edges, empty space and mixed bridge levels stay literal. */
export function supportedSpawnGround(central:SpawnGroundHit|null,x:number,z:number,probe:(x:number,z:number)=>SpawnGroundNormalHit|null):SpawnGroundHit|null{
 if(central?.surface?.group!=='terrain')return central;
 const neighbors:SpawnGroundNormalHit[]=[];
 for(const dx of[-.001,0,.001])for(const dz of[-.001,0,.001]){
  if(dx===0&&dz===0)continue;const hit=probe(x+dx,z+dz);
  if(!hit||!Number.isFinite(hit.y)||!Number.isFinite(hit.normalY)||hit.normalY<.75||!hit.surface||!['ground','kerbs'].includes(hit.surface.group)||/water|sea|ocean/i.test(hit.surface.tag))return central;
  neighbors.push(hit);
 }
 const low=Math.min(...neighbors.map(h=>h.y)),high=Math.max(...neighbors.map(h=>h.y));
 if(high-low>.005)return central;
 return neighbors.reduce((a,b)=>a.y>=b.y?a:b);
}
