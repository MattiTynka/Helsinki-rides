import assert from 'node:assert/strict';
import {appendBridgeGlb} from './bridge-glb.ts';
import {BRIDGE_COLOURS} from './bridge-reconstruction.ts';
import {appendTramVisualGlb} from './append-tram-glb.ts';
import {readFacadeGlb} from './facade-glb.ts';
import {packGlb} from './shared-textures.ts';
import {supportNormal} from './tram-support-repair.ts';
import type {TramMesh} from './tram-visuals.ts';
import type {ExtraBridgeFace} from './delivery-extra-bridges-mesh.ts';

/** The existing safe mesh appenders preserve source BIN/image prefixes. This
 * wrapper supplies original bridge colours and unique bridge-owned names. */
export async function appendExtraBridgeGlb(bytes:Uint8Array,faces:readonly ExtraBridgeFace[],options:{cell:string;bridgeId:string;coarse:boolean;externalImages:ReadonlyMap<string,Uint8Array>}){
  if(!faces.length)return bytes;
  if(options.coarse){
    const mesh:TramMesh={positions:[],normals:[],uvs:[],colours:[],indices:[],bindings:[],stats:{expectedArea:0,coveredArea:0,missingArea:0,maximumLiftError:0,triangles:faces.length}};
    for(const f of faces){const start=mesh.positions.length/3,n=supportNormal(f.points),colour=f.colour??BRIDGE_COLOURS[f.material];for(let i=0;i<3;i++){mesh.positions.push(...f.points[i]!);mesh.normals.push(...n);mesh.uvs.push(...f.uvs[i]!);mesh.colours.push(...colour);}mesh.indices.push(start,start+1,start+2);}
    return appendTramVisualGlb(bytes,mesh,{cell:options.cell,coarse:true,externalImages:options.externalImages});
  }
  const groups=new Map<string,ExtraBridgeFace[]>();for(const face of faces){const key=face.material+'/'+JSON.stringify(face.colour??null),list=groups.get(key)??[];list.push(face);groups.set(key,list);}
  let result=bytes,ordinal=0;
  for(const group of groups.values()){
    const before=readFacadeGlb(result),appended=readFacadeGlb(await appendBridgeGlb(result,group,{cell:options.cell,coarse:false,graniteUri:'',externalImages:options.externalImages})),json=structuredClone(appended.json)as any;
    for(let i=((before.json as any).nodes??[]).length;i<json.nodes.length;i++){
      const node=json.nodes[i],mesh=json.meshes[node.mesh],name=`${options.cell}_${group.some(f=>f.role==='road'||f.role==='footway'||f.role==='bank')?'ground_extra_bridge':'extra_bridge_architecture'}_${options.bridgeId}_${ordinal++}`;
      node.name=name;mesh.name=name;node.extras={...node.extras,extraBridge:options.bridgeId,sourcePartIds:[...new Set(group.flatMap(f=>f.sourcePartIds))]};
      if(group[0]!.colour)for(const primitive of mesh.primitives){const material=json.materials[primitive.material];material.name=`extra-bridge-${options.bridgeId}-${group[0]!.material}-${ordinal}`;material.pbrMetallicRoughness.baseColorFactor=[...group[0]!.colour,group[0]!.material==='glass'?.3:1];delete material.pbrMetallicRoughness.baseColorTexture;}
    }
    assert.deepEqual(appended.bin.subarray(0,before.bin.length),before.bin);result=packGlb(json,appended.bin);
  }return result;
}
