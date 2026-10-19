// Extend the existing painted navy sleeves across Rain's uncovered axillae. Base colour only.
// The supplied torso garment has no sleeve geometry; changing skin weights would not repair it.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {readFacadeGlb} from '../world/lib/facade-glb.ts';

const SOURCE_SHA256='c2aec924a23100aeae0d1ea9d006af5aea3dd6b37c76359a3bf262b679fe1e58';
const {values}=parseArgs({options:{source:{type:'string'},out:{type:'string'}}});
assert.ok(values.source&&values.out,'--source and --out required');
assert.ok(!existsSync(values.out),'Use a fresh output directory');
const sha=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(values.source);
assert.equal(sha(bytes),SOURCE_SHA256,'Unexpected Rain source revision');
const {json:doc,bin}=readFacadeGlb(bytes);
const imageIndex=doc.images.findIndex(i=>i.name==='rain_skin_basecolor');assert.ok(imageIndex>=0);
const image=doc.images[imageIndex],view=doc.bufferViews[image.bufferView];
const embedded=bin.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength);
const {data:source,info}=await sharp(embedded).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const {width,height}=info;assert.equal(width,4096);assert.equal(height,4096);
const output=Buffer.from(source),region=new Uint8Array(width*height),protectedPixels=new Uint8Array(width*height);
const faceByPixel=new Int32Array(width*height);faceByPixel.fill(-1);
function accessor(index){const a=doc.accessors[index],v=doc.bufferViews[a.bufferView];assert.ok(!a.sparse);const widths={SCALAR:1,VEC2:2,VEC3:3,VEC4:4},sizes={5121:1,5123:2,5125:4,5126:4},count=widths[a.type],size=sizes[a.componentType],dv=new DataView(bin.buffer,bin.byteOffset,bin.byteLength),offset=(v.byteOffset??0)+(a.byteOffset??0),stride=v.byteStride??size*count;return Array.from({length:a.count},(_,i)=>Array.from({length:count},(_,k)=>{const p=offset+i*stride+k*size;return a.componentType===5126?dv.getFloat32(p,true):a.componentType===5125?dv.getUint32(p,true):a.componentType===5123?dv.getUint16(p,true):dv.getUint8(p);}));}
// Source skin is already in glTF metres. Both axillae, safely below neck and well inside wrists.
const inside=p=>Math.abs(p[0])>=.085&&Math.abs(p[0])<=.33&&p[1]>=1.09&&p[1]<=1.315;
function raster(uv,visit){const p=uv.map(v=>[v[0]*width,v[1]*height]);const [a,b,c]=p;
 const den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(den)<1e-8)return;
 const x0=Math.max(0,Math.floor(Math.min(...p.map(v=>v[0])))),x1=Math.min(width-1,Math.ceil(Math.max(...p.map(v=>v[0]))));
 const y0=Math.max(0,Math.floor(Math.min(...p.map(v=>v[1])))),y1=Math.min(height-1,Math.ceil(Math.max(...p.map(v=>v[1]))));
 for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const xx=x+.5,yy=y+.5,u=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/den,v=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/den,w=1-u-v;if(Math.min(u,v,w)>=-1e-7)visit(y*width+x,[u,v,w]);}}
const body=doc.meshes.find(m=>m.name==='RAIN-body_game');assert.ok(body);
let testedFaces=0,regionFaces=0;
for(const mesh of doc.meshes)for(const primitive of mesh.primitives){
 const material=doc.materials[primitive.material],texture=doc.textures[material.pbrMetallicRoughness?.baseColorTexture?.index];
 if((texture?.extensions?.EXT_texture_webp?.source??texture?.source)!==imageIndex)continue;
 const positions=accessor(primitive.attributes.POSITION),uv=accessor(primitive.attributes.TEXCOORD_0),indices=accessor(primitive.indices).flat();
 for(let i=0;i<indices.length;i+=3){const ids=indices.slice(i,i+3),points=ids.map(j=>positions[j]);let touched=false;
  raster(ids.map(j=>uv[j]),(pixel,weights)=>{const p=[0,1,2].map(k=>points.reduce((sum,v,j)=>sum+v[k]*weights[j],0));
   if(mesh===body&&inside(p)){region[pixel]=1;faceByPixel[pixel]=i/3;touched=true;}else protectedPixels[pixel]=1;});
  if(mesh===body){testedFaces++;if(touched)regionFaces++;}
 }
}
// Match the existing sleeve colour sampled from nearby blue fabric, retaining small luminance detail.
const channels=[[],[],[]],skinLuma=[];
for(let p=0;p<region.length;p++)if(region[p]&&!protectedPixels[p]){const i=p*4,r=source[i],g=source[i+1],b=source[i+2];if(b>r*1.25&&b>g*1.08&&b>20&&b<110){channels[0].push(r);channels[1].push(g);channels[2].push(b);}if(r>70&&r>b*1.35&&g>b*1.15)skinLuma.push(.2126*r+.7152*g+.0722*b);}
const median=a=>{assert.ok(a.length);a.sort((a,b)=>a-b);return a[a.length>>1];};
const navy=channels.map(median),skinMedian=median(skinLuma);assert.ok(navy[2]>navy[0]&&navy[0]<35);
const mask=Buffer.alloc(width*height),affectedFaces=new Set();let changed=0,regionPixels=0,protectedOverlap=0;
for(let p=0;p<region.length;p++)if(region[p]){regionPixels++;if(protectedPixels[p]){protectedOverlap++;continue;}const i=p*4,r=source[i],g=source[i+1],b=source[i+2];
 if(!(r>70&&r>b*1.35&&g>b*1.15))continue;
 const detail=Math.max(.85,Math.min(1.15,(.2126*r+.7152*g+.0722*b)/skinMedian));
 for(let k=0;k<3;k++)output[i+k]=Math.round(navy[k]*detail);
 mask[p]=255;changed++;affectedFaces.add(faceByPixel[p]);
}
assert.ok(changed>100&&changed<width*height*.02,'Unexpected repair coverage');
let changedOutsideMask=0,alphaChanges=0;
for(let p=0;p<mask.length;p++){for(let k=0;k<3;k++)if(!mask[p]&&output[p*4+k]!==source[p*4+k])changedOutsideMask++;if(output[p*4+3]!==source[p*4+3])alphaChanges++;}
assert.equal(changedOutsideMask,0);assert.equal(alphaChanges,0);
const out=path.resolve(values.out);mkdirSync(out,{recursive:true});
const png=await sharp(output,{raw:{width,height,channels:4}}).png().toBuffer(),maskPng=await sharp(mask,{raw:{width,height,channels:1}}).png().toBuffer();
const replacementPath=path.join(out,'rain_skin_basecolor.png'),maskPath=path.join(out,'mask.png');writeFileSync(replacementPath,png,{flag:'wx'});writeFileSync(maskPath,maskPng,{flag:'wx'});
const report={schemaVersion:1,status:'BASECOLOUR_PATCH_REQUIRES_VISUAL_REVIEW',sourceSha256:SOURCE_SHA256,
 image:{index:imageIndex,name:image.name,sourceImageSha256:sha(embedded),width,height},
 replacement:{path:replacementPath,sha256:sha(png)},mask:{path:maskPath,sha256:sha(maskPng)},
 affectedMesh:'RAIN-body_game',affectedFaces:[...affectedFaces].sort((a,b)=>a-b),changedPixels:changed,changedFraction:changed/(width*height),regionPixels,protectedOverlap,testedFaces,regionFaces,
 predicate:{absoluteX:[.085,.33],y:[1.09,1.315],space:'unchanged source glTF bind metres',skinColour:'r>70 && r>b*1.35 && g>b*1.15'},
 sampledNavyRgb:navy,sourceSkinMedianLuma:skinMedian,unchangedOutsideMask:changedOutsideMask===0,alphaUnchanged:alphaChanges===0,
 preservation:'Only decoded RGB pixels in exact mask change; alpha, geometry, UVs, weights, bones, animations and every other image remain unchanged. Non-axillary UV owners are protected.',
 scriptSha256:sha(readFileSync(import.meta.filename))};
writeFileSync(path.join(out,'patch.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({out,changedPixels:changed,changedFraction:report.changedFraction,affectedFaces:affectedFaces.size,sampledNavyRgb:navy}));
