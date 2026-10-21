import assert from 'node:assert/strict';
import{junctionFaceSha}from'./delivery-bridge-junction-mouths.ts';
import type{JunctionSourceSelection,JunctionSkinVertexAttachment}from'./delivery-bridge-junction-partition.ts';
import type{JunctionFloorWitness}from'./delivery-bridge-junction-surfaces.ts';
/** The original producer's curb offsets may identify an attached source skin
 * only AFTER exact face/edge/parameter identity has qualified its upper level.
 * This is not a height-threshold selector. */
export function validateJunctionSkinAttachment(selection:JunctionSourceSelection,points:readonly(readonly number[])[],floors:readonly JunctionFloorWitness[]){
 const attachment=selection.skinAttachment;assert.ok(attachment&&attachment.length===3,'A skin cut needs complete literal upper-floor attachments');const offsets:number[]=[];
 for(let i=0;i<3;i++){
  const a:JunctionSkinVertexAttachment=attachment[i]!;const f:JunctionFloorWitness|undefined=floors.find(f=>f.source.cell===a.source.cell&&f.source.collider===a.source.collider&&f.source.triangle===a.source.triangle);assert.ok(f,'Skin attachment references an unrelated or lower source floor');assert.deepEqual(f.source,a.source);assert.equal(junctionFaceSha(f.points),a.source.orderedFloat32Sha256);assert.ok(a.parameter>=0&&a.parameter<=1&&(a.edge===0||a.edge===1||a.edge===2));
  const A=f.points[a.edge]!,B=f.points[(a.edge+1)%3]!,expected=A.map((v,k)=>Math.fround(v+(B[k]!-v)*a.parameter));assert.deepEqual(a.point,expected,'Skin attachment changed literal native edge XYZ');const P=points[i]!;assert.ok(Math.hypot(P[0]!-a.point[0],P[2]!-a.point[2])<=.001,'Skin cut is not attached to the actual source floor boundary');const delta=P[1]!-a.point[1];assert.equal(delta,a.heightOffset);offsets.push(delta);
  if(selection.role==='native-upper-curb'){assert.equal(f.tag,'road:asphalt');assert.ok(delta>=-.031&&delta<=.121,'Native curb is on another level or lost its source curb offsets');}
  else if(selection.role==='authored-mouth-curb'){assert.equal(f.tag,'road:asphalt:bridge-reconstruction');assert.ok(delta>=-.001&&delta<=.121,'Authored curb is not paired with its actual parent ROAD');}
  else{assert.equal(selection.role,'authored-mouth-bottom-skin');assert.ok(f.tag==='road:asphalt:bridge-reconstruction'||f.tag==='raised:asphalt:bridge-reconstruction');assert.ok(delta<=.001,'Independent above-floor architecture cannot become a bottom skin');}
 }
 if(selection.role==='authored-mouth-bottom-skin')assert.ok(offsets.some(y=>Math.abs(y)<=.001),'An independent buried soffit is not a floor-attached side skin');
 return{sourceEdgeAttachments:attachment,sourceOffsets:offsets,sourceBoundaryRegistrationLimitMetres:.001};
}
