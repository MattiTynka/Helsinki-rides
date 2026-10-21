// The native fallback heightfield is a physical collider, independent of HCOL.
// Lower only vertices influencing the bounded replacement footprint. This also
// keeps a real underpass open instead of retaining an invisible former deck.
import assert from 'node:assert/strict';
import {encodeTerrain,parseTerrain,type TerrainGrid} from '../../../packages/world-schema/src/index.ts';
import type {TramPoint} from './tram-visuals.ts';

export interface BridgeTerrainMask {
  id:string;
  polygon:readonly TramPoint[];
  maximumTerrainY:number;
}

function inside(p:TramPoint,polygon:readonly TramPoint[]):boolean {
  let result=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i]!,b=polygon[j]!;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
  }
  return result;
}

function intersectsCell(polygon:readonly TramPoint[],x0:number,z0:number,resolution:number):boolean {
  const x1=x0+resolution,z1=z0+resolution;
  if(polygon.some(p=>p[0]>=x0&&p[0]<=x1&&p[1]>=z0&&p[1]<=z1))return true;
  if([[x0,z0],[x1,z0],[x1,z1],[x0,z1]].some(p=>inside(p as TramPoint,polygon)))return true;
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!;
    let low=0,high=1;
    for(const[delta,distance]of[[-(b[0]-a[0]),a[0]-x0],[b[0]-a[0],x1-a[0]],[-(b[1]-a[1]),a[1]-z0],[b[1]-a[1],z1-a[1]]]){
      if(Math.abs(delta!)<1e-14){if(distance!<0){low=1;high=0;break;}continue;}
      const t=distance!/delta!;if(delta!<0)low=Math.max(low,t);else high=Math.min(high,t);
    }
    if(low<=high)return true;
  }
  return false;
}

export function lowerBridgeTerrain(bytes:Uint8Array,masks:readonly BridgeTerrainMask[]){
  const old=parseTerrain(bytes),heights=old.heights.slice(),bits=new Uint32Array(old.heights.buffer),changes=new Map<number,{index:number;before:number;after:number;maskIds:string[]}>();
  for(const mask of masks){
    assert.ok(mask.polygon.length>=3&&Number.isFinite(mask.maximumTerrainY));
    const minX=Math.max(0,Math.floor((Math.min(...mask.polygon.map(p=>p[0]))-old.x0)/old.resolution)),maxX=Math.min(old.nx-2,Math.floor((Math.max(...mask.polygon.map(p=>p[0]))-old.x0)/old.resolution));
    const minZ=Math.max(0,Math.floor((Math.min(...mask.polygon.map(p=>p[1]))-old.z0)/old.resolution)),maxZ=Math.min(old.nz-2,Math.floor((Math.max(...mask.polygon.map(p=>p[1]))-old.z0)/old.resolution));
    for(let z=minZ;z<=maxZ;z++)for(let x=minX;x<=maxX;x++){
      if(!intersectsCell(mask.polygon,old.x0+x*old.resolution,old.z0+z*old.resolution,old.resolution))continue;
      for(const index of[z*old.nx+x,z*old.nx+x+1,(z+1)*old.nx+x,(z+1)*old.nx+x+1]){
        const target=Math.fround(mask.maximumTerrainY);if(heights[index]!<=target)continue;
        heights[index]=target;const change=changes.get(index)??{index,before:old.heights[index]!,after:target,maskIds:[]};change.after=target;if(!change.maskIds.includes(mask.id))change.maskIds.push(mask.id);changes.set(index,change);
      }
    }
  }
  const next:TerrainGrid={...old,heights},encoded=encodeTerrain(next),newBits=new Uint32Array(heights.buffer);let unchanged=0;
  for(let i=0;i<bits.length;i++){if(changes.has(i)){assert.ok(heights[i]!<old.heights[i]!);continue;}assert.equal(newBits[i],bits[i],`Outside terrain bit changed at${i}`);unchanged++;}
  return{bytes:encoded,terrain:next,proof:{sampleCount:heights.length,changedSamples:changes.size,unchangedSamples:unchanged,maximumInfluenceCollarMetres:Math.SQRT2*old.resolution,rule:'Only four grid vertices of a terrain cell intersecting an explicit replacement polygon can change; all others remain Float32-bit exact.',masks,changes:[...changes.values()].sort((a,b)=>a.index-b.index)}};
}
