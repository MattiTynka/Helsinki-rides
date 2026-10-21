import assert from'node:assert/strict';
/** A source building may extend beyond delivered streets at the map boundary.
 * Qualify only the exact in-bounds part of its outward street baseline. This
 * grants no floor, access or physical support outside the delivered world. */
export function facadeDeliveredProbeInterval(frame:{origin:readonly number[];axis:readonly number[];width:number},bounds:readonly number[],offset:number){
 assert.equal(frame.origin.length,2);assert.equal(frame.axis.length,2);assert.equal(bounds.length,4);assert.ok([...frame.origin,...frame.axis,frame.width,...bounds,offset].every(Number.isFinite));assert.ok(frame.width>0&&offset>=2&&offset<=6);assert.ok(Math.abs(Math.hypot(...frame.axis)-1)<.000001);assert.ok(bounds[0]!<bounds[2]!&&bounds[1]!<bounds[3]!);
 const origin=[frame.origin[0]!-frame.axis[1]!*offset,frame.origin[1]!+frame.axis[0]!*offset];let lo=0,hi=frame.width;
 for(let k=0;k<2;k++){const d=frame.axis[k]!,p=origin[k]!,min=bounds[k]!,max=bounds[k+2]!;if(d===0){assert.ok(p>=min&&p<=max,'Facade has no delivered exterior baseline');continue;}const a=(min-p)/d,b=(max-p)/d;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));}
 assert.ok(hi>lo,'Facade has no delivered exterior baseline');return[lo,hi]as const;
}
export function qualifyFacadeDeliveredProbeInterval(requested:unknown,frame:{origin:readonly number[];axis:readonly number[];width:number},bounds:readonly number[],offset:number,kind:unknown){
 assert.equal(kind,'named-source-floor-profile','Boundary probe requires its complete named source/floor registry');const actual=facadeDeliveredProbeInterval(frame,bounds,offset);assert.ok(actual[0]>0||actual[1]<frame.width,'An interior facade cannot crop away inconvenient floor samples');assert.deepEqual(requested,actual,'Probe interval must be the exact delivered-world intersection');return actual;
}
