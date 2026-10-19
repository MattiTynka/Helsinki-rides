// Textureless, single-draw distant cells, derived from the exact detailed geometry.
// Vertex colours sample the licensed atlases; no downloaded images are introduced.
// Both levels are spatially streamed. The distant level guarantees ground coverage
// while a nearby detailed cell decodes, without retaining its textures.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { reorder, weld, weldPrimitive, simplifyPrimitive } from '@gltf-transform/functions';
import sharp from 'sharp';

const {values}=parseArgs({options:{cells:{type:'string'}}});
if(!values.cells) throw new Error('--cells required (new working build only)');
const dir=values.cells, index=JSON.parse(readFileSync(path.join(dir,'cells.json'),'utf8'));
if(index.cells.some(c=>c.visual.lod2))throw new Error('distant levels already exist');
const sha=b=>createHash('sha256').update(b).digest('hex');
const threeRequire=createRequire(new URL('../../apps/game/package.json',import.meta.url));
const basisDir=path.resolve(path.dirname(threeRequire.resolve('three')),'../examples/jsm/libs/basis');
const temp=mkdtempSync(path.join(tmpdir(),'helsinki-distant-'));
const vendor=path.join(temp,'basis.cjs');
// Ordinary loading of the installed trusted vendor module, not string evaluation.
writeFileSync(vendor,readFileSync(path.join(basisDir,'basis_transcoder.js'),'utf8')+'\nmodule.exports = BASIS;\n');
let basis;
try { basis=await createRequire(import.meta.url)(vendor)({wasmBinary:readFileSync(path.join(basisDir,'basis_transcoder.wasm'))}); }
finally {unlinkSync(vendor);rmdirSync(temp);}
basis.initializeBasis();
await Promise.all([MeshoptDecoder.ready,MeshoptEncoder.ready,MeshoptSimplifier.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder,'meshopt.encoder':MeshoptEncoder});
const cache=new Map();
async function image(texture){
  if(!texture)return null;
  const bytes=texture.getImage(),key=sha(bytes); if(cache.has(key))return cache.get(key);
  let result;
  if(texture.getMimeType()==='image/ktx2'){
    const f=new basis.KTX2File(bytes);
    try {if(!f.isValid()||!f.startTranscoding())throw new Error('invalid KTX2');
      const width=f.getWidth(),height=f.getHeight(),data=new Uint8Array(f.getImageTranscodedSizeInBytes(0,0,0,13));
      if(!f.transcodeImage(data,0,0,0,13,0,-1,-1))throw new Error('transcode failed'); result={width,height,data};
    }finally{f.close();f.delete();}
  }else {const x=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});result={width:x.info.width,height:x.info.height,data:x.data};}
  cache.set(key,result);return result;
}
const linear=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
const report=[];
for(const c of index.cells){
  const source=readFileSync(path.join(dir,c.visual.lod0.path));if(sha(source)!==c.visual.lod0.sha256)throw new Error(`hash mismatch ${c.id}`);
  const src=await io.readBinary(source),dst=new Document(),buffer=dst.createBuffer(),scene=dst.createScene();
  const positions=[],colors=[],simplified=[];
  for(const n of src.getRoot().listNodes()){
    if(!n.getMesh())continue; const m=n.getWorldMatrix();
    for(const p of n.getMesh().listPrimitives()){
      if(p.getMode()!==4)throw new Error('only triangle cells supported');
      const before=(p.getIndices()?.getCount()??p.getAttribute('POSITION').getCount())/3;
      // Ground and stairs retain exact vertices across cells. Complex above-ground
      // architecture can lose sub-10 cm detail in this textureless distant tier.
      if(!n.getName().includes('_ground_')&&!n.getMesh().getName().includes('_ground_')&&before>2000){
        weldPrimitive(p);
        const size=MeshoptSimplifier.getScale(p.getAttribute('POSITION').getArray(),3)*Math.max(...n.getWorldScale().map(Math.abs));
        simplifyPrimitive(p,{simplifier:MeshoptSimplifier,ratio:.12,error:.1/size,lockBorder:true});
        simplified.push({node:n.getName(),before,after:p.getIndices().getCount()/3,maxErrorMetres:.1});
      }
      const a=p.getAttribute('POSITION'),uv=p.getAttribute('TEXCOORD_0'),colour=p.getAttribute('COLOR_0'),idx=p.getIndices(),mat=p.getMaterial();
      const tex=await image(mat?.getBaseColorTexture()),factor=mat?.getBaseColorFactor()??[1,1,1,1];
      const count=idx?.getCount()??a.getCount();
      for(let k=0;k<count;k++){
        const i=idx?idx.getScalar(k):k,v=a.getElement(i,[]);
        positions.push(m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12],m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13],m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]);
        let rgb=[...factor];
        if(tex&&uv){const t=uv.getElement(i,[]),x=Math.min(tex.width-1,Math.max(0,Math.floor(t[0]*tex.width))),y=Math.min(tex.height-1,Math.max(0,Math.floor(t[1]*tex.height))),offset=(y*tex.width+x)*4;
          rgb=rgb.map((v,j)=>j<3?v*linear(tex.data[offset+j]/255):v);
        }
        if(colour){const cc=colour.getElement(i,[]);rgb=rgb.map((v,j)=>v*(cc[j]??1));}
        colors.push(...rgb.slice(0,3));
      }
    }
  }
  const mat=dst.createMaterial('distant vertex colours').setDoubleSided(true);
  mat.setExtension('KHR_materials_unlit',dst.createExtension(KHRMaterialsUnlit).createUnlit());
  const p=dst.createPrimitive().setAttribute('POSITION',dst.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array(positions)))
    .setAttribute('COLOR_0',dst.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array(colors))).setMaterial(mat);
  scene.addChild(dst.createNode(c.id).setMesh(dst.createMesh(c.id).addPrimitive(p)));
  dst.getRoot().getAsset().copyright=src.getRoot().getAsset().copyright;
  dst.getRoot().setExtras({cell:c.id,level:'distant',sourceSha256:c.visual.lod0.sha256,geometry:'exact ground; complex architecture simplified with 0.1 m error limit; vertex-colour approximation'});
  await dst.transform(weld(),reorder({encoder:MeshoptEncoder}));
  dst.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.FILTER});
  const bytes=await io.writeBinary(dst),file=`visual/${c.id}.lod2.glb`;
  writeFileSync(path.join(dir,file),bytes);
  c.visual.lod2={path:file,sha256:sha(bytes),bytes:bytes.byteLength,triangles:positions.length/9,drawCalls:1,atlases:0,textureBytesEstimate:0};
  report.push({cell:c.id,...c.visual.lod2,simplified});cache.clear();
  console.log(`${c.id}: distant ${positions.length/9} triangles, ${bytes.byteLength} bytes, 0 textures`);
}
writeFileSync(path.join(dir,'cells.json'),JSON.stringify(index,null,1)+'\n');
writeFileSync(path.join(dir,'distant-report.json'),JSON.stringify({schemaVersion:1,toolSha256:sha(readFileSync(new URL(import.meta.url))),cells:report,textureBytes:0},null,1)+'\n');
