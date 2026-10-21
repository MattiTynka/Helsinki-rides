// Explicit author-reviewed slope cases only. This never changes the ordinary <1m gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';
import {deliverySha}from'./delivery-city-payloads.ts';
import type {OriginalWallArt}from'../author_senate_facade_charts.ts';
import type {ReferenceFacadeArt}from'./delivery-new-area-facades-reference-art.ts';

export interface RegisteredFloorSample{u:number;x:number;z:number;collision:{height:number;cell:string;collider:string;group:string;tag:string};visual:{y:number;cell:string;key:string;node:string}}
interface Frame{origin:readonly[number,number];axis:readonly[number,number];width:number;minY:number;maxY:number}
interface Source{cityJsonSha256:string;cityBinSha256:string;originId:string}
interface SourceFacet{part:number;triangle:number;key:string}
interface RegisteredPlan{id:string;building:{id:string;vtj:string|null;owner:string};source:Source;triangles:number[];art:ReferenceFacadeArt;references:unknown[];observedGroundProfile:{kind:string;path:string;sha256:string}}
export interface FacadeGroundRegistryEntry{
 schemaVersion:1;id:string;building:RegisteredPlan['building'];source:Source;
 sourceFacets:SourceFacet[];frame:Frame;manifestSha256:string;
 datum:{nativeRoofY:number;offset:number};nineFloorSamples:RegisteredFloorSample[];
 qualification:{artSha256:string;referencesSha256:string;observations:string[]};
 finish:{plinthHeight:number;plinthColour:string;floorFollowingGlazingIndices:number[]};
}
function keys(v:object,expected:readonly string[]){assert.deepEqual(Object.keys(v).sort(),[...expected].sort(),'Unknown/missing named ground registry field');}
function finite(n:number){assert.ok(Number.isFinite(n));}
function digest(v:string){assert.match(v,/^[a-f0-9]{64}$/);}
export function qualifyRegisteredFacadeGround(entry:FacadeGroundRegistryEntry,p:RegisteredPlan,expected:string,frame:Frame,facets:readonly SourceFacet[],samples:readonly RegisteredFloorSample[]){
 assert.ok(entry&&typeof entry==='object'&&!Array.isArray(entry));
 keys(entry,['schemaVersion','id','building','source','sourceFacets','frame','manifestSha256','datum','nineFloorSamples','qualification','finish']);assert.equal(entry.schemaVersion,1);
 assert.equal(p.observedGroundProfile.kind,'named-source-floor-profile');assert.equal(entry.id,p.id,'Unknown named floor case');
 assert.deepEqual(entry.building,p.building);assert.deepEqual(entry.source,p.source);assert.deepEqual(entry.frame,frame);
 assert.deepEqual(entry.sourceFacets,facets.map(f=>({part:f.part,triangle:f.triangle,key:f.key})));assert.deepEqual(entry.sourceFacets.map(f=>f.triangle),p.triangles);
 assert.equal(new Set(entry.sourceFacets.map(f=>f.key)).size,entry.sourceFacets.length);assert.equal(entry.manifestSha256,expected);digest(expected);
 keys(entry.datum,['nativeRoofY','offset']);finite(entry.datum.nativeRoofY);finite(entry.datum.offset);assert.equal(entry.datum.nativeRoofY,frame.maxY);
 const datum=entry.datum.nativeRoofY+entry.datum.offset;finite(datum);assert.ok(datum>=frame.minY-10&&datum<frame.maxY);
 assert.equal(entry.nineFloorSamples.length,9);assert.equal(samples.length,9);
 // Rebinding to a changed floor, source triangle or actual sampling position requires new author review.
 assert.deepEqual(entry.nineFloorSamples,samples,'Requalify changed native visual/HCOL floor pairs');
 samples.forEach((s,i)=>{for(const n of[s.u,s.x,s.z,s.collision.height,s.visual.y])finite(n);assert.ok(Math.abs(s.collision.height-s.visual.y)<.0001);assert.ok(s.u>=0&&s.u<=frame.width);if(i)assert.ok(s.u>samples[i-1]!.u);});
 keys(entry.qualification,['artSha256','referencesSha256','observations']);digest(entry.qualification.artSha256);digest(entry.qualification.referencesSha256);
 assert.equal(entry.qualification.artSha256,deliverySha(Buffer.from(JSON.stringify(p.art))));assert.equal(entry.qualification.referencesSha256,deliverySha(Buffer.from(JSON.stringify(p.references))));
 assert.ok(Array.isArray(entry.qualification.observations)&&entry.qualification.observations.length&&entry.qualification.observations.every(s=>typeof s==='string'&&s.length>0&&s.length<=2000));
 keys(entry.finish,['plinthHeight','plinthColour','floorFollowingGlazingIndices']);finite(entry.finish.plinthHeight);assert.ok(entry.finish.plinthHeight>=0&&entry.finish.plinthHeight<=2);assert.match(entry.finish.plinthColour,/^#[0-9a-f]{6}$/i);
 assert.ok(Array.isArray(entry.finish.floorFollowingGlazingIndices));assert.equal(new Set(entry.finish.floorFollowingGlazingIndices).size,entry.finish.floorFollowingGlazingIndices.length);
 for(const index of entry.finish.floorFollowingGlazingIndices)assert.ok(Number.isSafeInteger(index)&&index>=0&&p.art.groundOpenings[index]?.kind==='glazing','Only observed storefront glazing may follow the street floor');
 return{datum,entry};
}
export function readRegisteredFacadeGround(planFile:string,p:RegisteredPlan,expected:string,frame:Frame,facets:readonly SourceFacet[],samples:readonly RegisteredFloorSample[]){
 keys(p.observedGroundProfile,['kind','path','sha256']);assert.equal(p.observedGroundProfile.kind,'named-source-floor-profile');digest(p.observedGroundProfile.sha256);
 const root=fileURLToPath(new URL('../../../content/assets/facades/new-area/',import.meta.url)),file=path.resolve(path.dirname(planFile),p.observedGroundProfile.path),relative=path.relative(root,file);
 assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.extname(file)==='.json','Named floor registry must be an original source asset in new-area');
 const realRelative=path.relative(fs.realpathSync(root),fs.realpathSync(file));assert.ok(realRelative&&!realRelative.startsWith('..')&&!path.isAbsolute(realRelative),'Named floor registry symlink leaves original source assets');
 const stat=fs.statSync(file);assert.ok(stat.isFile()&&stat.size>0&&stat.size<=262144);const bytes=fs.readFileSync(file);assert.equal(deliverySha(bytes),p.observedGroundProfile.sha256);
 return qualifyRegisteredFacadeGround(JSON.parse(bytes.toString()),p,expected,frame,facets,samples);
}

/** Ordinary windows stay level. Only observed storefront sills follow the slope; doors retain their observed local-floor height. */
export function renderRegisteredSlopedFacadeBase(w:OriginalWallArt,datum:number,a:ReferenceFacadeArt,samples:readonly RegisteredFloorSample[],finish:FacadeGroundRegistryEntry['finish']){
 assert.equal(samples.length,9);
 const profile=[{u:0,collision:samples[0]!.collision},...samples,{u:w.width,collision:samples.at(-1)!.collision}];
 const floorAt=(u:number)=>{for(let i=1;i<profile.length;i++){const l=profile[i-1]!,r=profile[i]!;if(u<=r.u)return l.collision.height+(r.collision.height-l.collision.height)*(u-l.u)/Math.max(1e-12,r.u-l.u);}throw Error('Observed opening outside source floor profile');};
 if(finish.plinthHeight){const edge=profile.map(s=>`${s.u},${w.maxY-s.collision.height-finish.plinthHeight}`).join(' ');w.pieces.push(`<polygon data-feature="registry-source-floor-plinth" points="0,${w.maxY-w.minY} ${edge} ${w.width},${w.maxY-w.minY}" fill="${finish.plinthColour}"/>`);}
 for(const[i,o]of a.groundOpenings.entries()){
  const localFloor=floorAt(o.x),following=o.kind!=='glazing'||finish.floorFollowingGlazingIndices.includes(i),bottom=(following?localFloor:datum)+o.bottom,top=o.kind==='door'?bottom+o.height:datum+o.bottom+o.height,left=o.x-o.width/2,height=top-bottom;
  assert.ok(height>.4&&height<9&&left>=0&&left+o.width<=w.width,'Requalify observed opening against sloping floor');
  assert.ok(bottom>=localFloor-.05,'Observed ground opening is below the actual source street floor');
  w.rect(left-.10,bottom-.10,o.width+.20,height+.20,a.surroundColour,`registry-ground-${i}-surround`);
  w.rect(left,bottom,o.width,height,o.kind==='passage'?'#353c3c':o.kind==='door'?'#70513e':a.glassColour,`registry-ground-${i}`);
  if(o.kind==='glazing')w.line(o.x,bottom,o.x,top,a.frameColour,.09);
  if(o.kind==='door'){w.rect(left+.16,bottom+.25,Math.max(.1,o.width-.32),Math.max(.1,height-.5),a.glassColour);w.line(o.x,bottom,o.x,top,'#96734e',.07);}
 }
}
