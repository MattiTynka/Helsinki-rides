// Current street reference of the former power/police building, now Lilla Roberts.
import assert from'node:assert/strict';import type{OriginalWallArt}from'../author_senate_facade_charts.ts';import type{ReferenceFacadeArt}from'./delivery-new-area-facades-reference-art.ts';
export function qualifyPieniRoobertinkatuHotelGround(p:{id:string;building:{id:string;vtj:string};triangles:number[];observedGroundProfile:{kind:string;manifestSha256:string;sampleHeights:number[];horizontalDatumFromNativeTop:number}},expected:string,maxY:number,samples:readonly{collision:{height:number}}[]){
 assert.equal(p.id,'pieni-roobertinkatu-1-3-hotel-south-20261021');assert.equal(p.building.vtj,'103046274B');assert.deepEqual(p.triangles,[268,269,801,802,803,804,805,806,807,808,904,905,906,907]);
 assert.equal(p.building.id,'BID_e21ed751-3931-4b4a-b18c-cd6273bff265');
 assert.equal(p.observedGroundProfile.kind,'source-measured-sloped-base-horizontal-opening-bands');assert.equal(p.observedGroundProfile.manifestSha256,expected);assert.equal(p.observedGroundProfile.sampleHeights.length,9);assert.equal(samples.length,9);
 samples.forEach((s,i)=>assert.ok(Number.isFinite(s.collision.height)&&Math.abs(s.collision.height-p.observedGroundProfile.sampleHeights[i]!)<1e-6,'Requalify changed hotel street floor'));assert.equal(p.observedGroundProfile.horizontalDatumFromNativeTop,-22.7);assert.ok(Number.isFinite(maxY));return maxY-22.7;
}
export function renderPieniRoobertinkatuHotel(w:OriginalWallArt,ground:number,a:ReferenceFacadeArt){
 assert.ok(w.width>46&&w.width<48&&a.rows.length===5);
 const entry=a.groundOpenings.find(o=>Math.abs(o.x-16.9)<.001);assert.ok(entry);
 w.rect(entry.x-entry.width/2,ground+entry.bottom,entry.width,entry.height,'#353b39','hotel-observed-dark-metal-entry');
 for(const side of[-1,1])w.rect(entry.x+side*.50-.39,ground+entry.bottom+.13,.78,entry.height-.26,a.glassColour,'hotel-observed-glazed-entry-leaf');
 for(const r of a.rows.slice(0,4))for(const x of r.axes.filter(x=>x>6.7&&x<40.1))for(const fraction of[1/3,2/3])w.line(x-r.width/2+r.width*fraction,ground+r.bottom,x-r.width/2+r.width*fraction,ground+r.bottom+r.height,a.frameColour,.055);
 // Original flat canopy cue, on the selected wall only; no photo signage.
 w.rect(12.9,ground+4.25,14.5,.18,'#454b4a','hotel-original-entry-canopy-edge');
 w.rect(12.9,ground+4.43,14.5,.13,'#dddacc','hotel-original-entry-canopy-fascia');
 for(let y=ground+4.55;y<w.maxY-.12;y+=3.5)w.line(6.65,y,40.1,y,'#77766a',.045);
}
