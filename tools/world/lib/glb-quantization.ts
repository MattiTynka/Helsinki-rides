// meshopt FILTER can encode normals as normalized integers even when POSITION
// stays float32 for crack-free ground. glTF still requires this declaration.
export function declareQuantizedAttributes(bytes: Uint8Array): Uint8Array {
  const input=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(input.readUInt32LE(0)!==0x46546c67||input.readUInt32LE(4)!==2)throw new Error('Expected GLB2');
  const length=input.readUInt32LE(12),json=JSON.parse(input.subarray(20,20+length).toString('utf8'));
  const needed=(json.meshes??[]).some((m:{primitives:{attributes:Record<string,number>}[]})=>m.primitives.some(p=>Object.entries(p.attributes).some(([key,index])=>
    ['POSITION','NORMAL','TANGENT'].includes(key)&&json.accessors[index].componentType!==5126)));
  if(!needed||(json.extensionsUsed?.includes('KHR_mesh_quantization')&&json.extensionsRequired?.includes('KHR_mesh_quantization')))return bytes;
  for(const key of ['extensionsUsed','extensionsRequired'])json[key]=[...new Set([...(json[key]??[]),'KHR_mesh_quantization'])];
  const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc((text.length+3)&~3,0x20);text.copy(padded);
  const head=Buffer.from(input.subarray(0,20)),tail=input.subarray(20+length);
  head.writeUInt32LE(20+padded.length+tail.length,8);head.writeUInt32LE(padded.length,12);
  return Buffer.concat([head,padded,tail]);
}
