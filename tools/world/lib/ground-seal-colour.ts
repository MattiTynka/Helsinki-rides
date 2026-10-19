import assert from 'node:assert/strict';
import type {Document,Primitive} from '@gltf-transform/core';
import {frontierTriangleKey} from './frontier-ground.ts';

const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const points=(p:Primitive,t:number)=>[0,1,2].map(k=>p.getAttribute('POSITION')!.getElement(Number(p.getIndices()!.getArray()![t*3+k]),[]));
export interface CoarseGroundCorrespondence {
  nodeName:string;primitiveIndex:number;primitive:Primitive;matchedTriangles:number;
  samples:{point:number[];colour:number[]}[];
}

/** Appended cells may keep architecture in their original first coarse node and ground in a second
 * node. Only complete, winding-preserving ground triangles establish colour provenance; a shared
 * position on an unrelated wall is insufficient. Existing COLOR_0 values are returned without mixing. */
export function selectCoarseGroundCorrespondence(source:Primitive,coarse:Document,label:string):CoarseGroundCorrespondence {
  assert.equal(source.getMode(),4);assert.ok(source.getIndices());
  const sourceKeys=new Set<string>();for(let t=0;t<source.getIndices()!.getCount()/3;t++)sourceKeys.add(frontierTriangleKey(points(source,t)));
  let selected:CoarseGroundCorrespondence|undefined;
  for(const node of coarse.getRoot().listNodes())if(node.getMesh()){
    assert.deepEqual(node.getWorldMatrix(),identity,'Coarse ground correspondence requires baked coordinates');
    for(const[primitiveIndex,primitive]of node.getMesh()!.listPrimitives().entries()){
      assert.equal(primitive.getMode(),4);assert.ok(primitive.getIndices());
      const colours=primitive.getAttribute('COLOR_0');assert.ok(colours&&colours.getComponentType()===5126&&!colours.getNormalized(),'Exact Float32 coarse colours required');
      const candidate:CoarseGroundCorrespondence={nodeName:node.getName(),primitiveIndex,primitive,matchedTriangles:0,samples:[]},seen=new Set<string>();
      for(let t=0;t<primitive.getIndices()!.getCount()/3;t++){
        const triangle=points(primitive,t);if(!sourceKeys.has(frontierTriangleKey(triangle)))continue;candidate.matchedTriangles++;
        for(let k=0;k<3;k++){const colour=colours.getElement(Number(primitive.getIndices()!.getArray()![t*3+k]),[]),point=triangle[k]!,key=JSON.stringify([point,colour]);if(!seen.has(key)){candidate.samples.push({point,colour});seen.add(key);}}
      }
      if(candidate.matchedTriangles>(selected?.matchedTriangles??0))selected=candidate;
    }
  }
  assert.ok(selected,`Exact coarse ground triangle colour correspondence required: ${label}`);
  return selected;
}
