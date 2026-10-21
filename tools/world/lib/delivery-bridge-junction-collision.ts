import assert from 'node:assert/strict';
import {encodeCollisionBundle,parseCollisionBundle,type TriMeshCollider} from '../../../packages/world-schema/src/index.ts';
import type {BridgeFace} from './bridge-reconstruction.ts';

export interface TaggedJunctionFace {face:BridgeFace;surfaceTag?:string}
/** Append typed walking floors without changing the frozen bridge writer's
 * road/foot convention. Original collider arrays and tags remain literal. */
export function appendJunctionCollision(bytes:Uint8Array,faces:readonly TaggedJunctionFace[],cell:string){
 const old=parseCollisionBundle(bytes),tags=[...old.header.surfaceTags],colliders:TriMeshCollider[]=[...old.colliders],groups=new Map<string,BridgeFace[]>();
 for(const{face:f,surfaceTag}of faces){if(!f.collision)continue;const group=f.role==='road'||f.role==='footway'?'ground':f.role==='curb'?'kerbs':'props',tag=f.role==='road'?'road:asphalt:bridge-reconstruction':f.role==='footway'?surfaceTag??'raised:asphalt:bridge-reconstruction':'wall:bridge-reconstruction';if(surfaceTag!==undefined)assert.ok(f.role==='footway'&&['raised:asphalt:bridge-reconstruction','raised:slabs:bridge-junction'].includes(surfaceTag),'An explicit walking tag cannot reclassify ROAD or architecture');const key=group+'|'+tag,list=groups.get(key)??[];list.push(f);groups.set(key,list);}
 for(const[key,items]of groups){const[group,tag]=key.split('|')as[TriMeshCollider['group'],string];let index=tags.indexOf(tag);if(index<0){index=tags.length;tags.push(tag);}const id=`bridge-reconstruction:${cell}:${group}:${colliders.length}`;assert.ok(!colliders.some(c=>c.id===id));colliders.push({id,group,ref:null,positions:Float32Array.from(items.flatMap(f=>f.points.flat())),indices:Uint32Array.from({length:items.length*3},(_,i)=>i),triangleTags:Uint16Array.from({length:items.length},()=>index)});}
 return encodeCollisionBundle({...old.header,surfaceTags:tags},colliders);
}
