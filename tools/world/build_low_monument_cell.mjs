// Low-preset detail retains every facade, ground vertex and texture. Only the
// supplied monument's four meshes use a 2 cm error-bounded geometry variant.
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression} from '@gltf-transform/extensions';
import {simplifyPrimitive,weldPrimitive,prune} from '@gltf-transform/functions';
import {MeshoptDecoder,MeshoptEncoder,MeshoptSimplifier} from 'meshoptimizer';
const {values}=parseArgs({options:{cells:{type:'string'},monument:{type:'string'}}});
if(!values.cells||!values.monument)throw new Error('--cells and --monument GLB required');
if(!path.resolve(values.cells).startsWith(path.resolve('data/work')+path.sep))throw new Error('Only unpublished working cells can be modified');
const sha=b=>createHash('sha256').update(b).digest('hex');
await Promise.all([MeshoptDecoder.ready,MeshoptEncoder.ready,MeshoptSimplifier.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder,'meshopt.encoder':MeshoptEncoder});
const monumentBytes=fs.readFileSync(values.monument),source=await io.readBinary(monumentBytes);
const names=new Set(source.getRoot().listNodes().filter(n=>n.getMesh()).map(n=>n.getName()));
const index=JSON.parse(fs.readFileSync(path.join(values.cells,'cells.json'))),cell=index.cells.find(c=>c.id==='c_p00_p00');
if(!cell||cell.visual.lod1)throw new Error('Expected origin cell without a low-detail variant');
const original=fs.readFileSync(path.join(values.cells,cell.visual.lod0.path));
if(sha(original)!==cell.visual.lod0.sha256)throw new Error('Detail hash mismatch');
const doc=await io.readBinary(original),changes=[];
function unchangedGeometry(d){
  const hash=createHash('sha256');
  for(const n of d.getRoot().listNodes().filter(n=>n.getMesh()&&!names.has(n.getName())).sort((a,b)=>a.getName().localeCompare(b.getName()))){
    hash.update(JSON.stringify([n.getName(),n.getWorldMatrix()]));
    for(const p of n.getMesh().listPrimitives()){
      for(const semantic of p.listSemantics().sort()){
        const a=p.getAttribute(semantic),data=a.getArray();
        hash.update(JSON.stringify([semantic,a.getType(),a.getNormalized()]));
        hash.update(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));
      }
      const data=p.getIndices()?.getArray();if(data)hash.update(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));
    }
  }
  return hash.digest('hex');
}
const retainedGeometrySha256=unchangedGeometry(doc);
const images=doc.getRoot().listTextures().map(t=>sha(t.getImage())).sort();
for(const n of doc.getRoot().listNodes())if(names.has(n.getName())){
  for(const p of n.getMesh().listPrimitives()){
    const before=p.getIndices().getCount()/3,scale=n.getWorldScale();
    if(scale.some(v=>Math.abs(v-1)>1e-5))throw new Error('Monument must have baked metre transforms');
    weldPrimitive(p);
    const size=MeshoptSimplifier.getScale(p.getAttribute('POSITION').getArray(),3);
    simplifyPrimitive(p,{simplifier:MeshoptSimplifier,ratio:.25,error:.02/size,lockBorder:true});
    changes.push({node:n.getName(),before,after:p.getIndices().getCount()/3,maxErrorMetres:.02});
  }
}
if(changes.length!==names.size)throw new Error('Not every monument mesh was found');
await doc.transform(prune());
// Normals were already filtered by the detailed export. Preserve those decoded
// values rather than applying octahedral filtering a second time.
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
const bytes=await io.writeBinary(doc),reopened=await io.readBinary(bytes);
if(unchangedGeometry(reopened)!==retainedGeometrySha256)throw new Error('Non-monument geometry changed');
if(JSON.stringify(images)!==JSON.stringify(reopened.getRoot().listTextures().map(t=>sha(t.getImage())).sort()))throw new Error('Texture bytes changed');
const triangles=doc.getRoot().listMeshes().reduce((sum,m)=>sum+m.listPrimitives().reduce((s,p)=>s+(p.getIndices()?.getCount()??p.getAttribute('POSITION').getCount())/3,0),0);
const file=`visual/${cell.id}.lod1.glb`;
fs.writeFileSync(path.join(values.cells,file),bytes);
cell.visual.lod1={...cell.visual.lod0,path:file,sha256:sha(bytes),bytes:bytes.length,triangles};
fs.writeFileSync(path.join(values.cells,'cells.json'),JSON.stringify(index,null,1)+'\n');
const report={sourceMonumentSha256:sha(monumentBytes),sourceCellSha256:sha(original),output:cell.visual.lod1,changes,texturesByteExact:true,retainedGeometrySha256,toolSha256:sha(fs.readFileSync(new URL(import.meta.url)))};
fs.writeFileSync(path.join(values.cells,'low-monument-report.json'),JSON.stringify(report,null,1)+'\n');
console.log(JSON.stringify(report,null,1));
