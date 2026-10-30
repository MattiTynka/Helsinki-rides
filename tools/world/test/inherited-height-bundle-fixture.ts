import fs from 'node:fs';
import assert from 'node:assert/strict';
import {decodeRoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {sourceFile,readSourceFile,sourceSha256} from '../lib/source-files.ts';
import type {InheritedHeightContext} from '../lib/reviewed-inherited-road-height.ts';
export function bundleFixture(role:'driving-eight'|'walking-seven'){
  const file=`../evidence/inherited-${role}-root-approval-v1.json`,bytes=fs.readFileSync(file),approval=JSON.parse(bytes.toString());
  const graph=(world:{directory:string})=>{const m=JSON.parse(fs.readFileSync(sourceFile(world.directory,'manifest.json'),'utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(world.directory,m.roads),m.roads));};
  const context:InheritedHeightContext={original:graph(approval.originalWorld),current:graph(approval.currentWorld),originalWorld:approval.originalWorld,currentWorld:approval.currentWorld,sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},provenanceArchive:approval.provenanceArchive,otherRegistrationIds:[]};
  return{pin:{file,sha256:sourceSha256(bytes)},context,approval,packet:JSON.parse(fs.readFileSync(approval.packet.file,'utf8'))};
}
/** Corrupt only a returned test read, never the underlying immutable asset. */
export function withCorruptedRead(file:string,operation:()=>void){
  const real=fs.realpathSync(file),open=fs.openSync,read=fs.readSync,close=fs.closeSync,fds=new Set<number>();let changed=false;
  try{
    (fs as any).openSync=(input:any,...args:any[])=>{const fd=(open as any)(input,...args);if(fs.realpathSync(input)===real)fds.add(fd);return fd;};
    (fs as any).readSync=(fd:number,buffer:Buffer,offset:number,length:number,position:any)=>{const n=(read as any)(fd,buffer,offset,length,position);if(fds.has(fd)&&n&&!changed){buffer[offset]=buffer[offset]!^1;changed=true;}return n;};
    (fs as any).closeSync=(fd:number)=>{fds.delete(fd);return close(fd);};operation();assert.equal(changed,true,'Negative control must reach its bound input');
  }finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
}
