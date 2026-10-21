import fs from'node:fs';
import{gunzipSync}from'node:zlib';
import{decodeRoadGraph,type RoadGraph}from'../../../packages/world-schema/src/index.ts';
/** Authoring CLIs accept either legacyJSON or the exact packed road transport.
 * World/replay consumers instead use their manifest-pinned payload readers. */
export function decodeDeliveryRoadFile(bytes:Uint8Array):RoadGraph{
 if(bytes.length>64*1024*1024)throw Error('Road authoring input exceeds64MiB');
 return decodeRoadGraph(bytes[0]===0x1f&&bytes[1]===0x8b?gunzipSync(bytes,{maxOutputLength:64*1024*1024}):bytes);
}
export function readDeliveryRoadFile(file:string){return decodeDeliveryRoadFile(fs.readFileSync(file));}
