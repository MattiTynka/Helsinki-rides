import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import sharp from 'sharp';
import {esplanadiRestoration,esplanadiMapping} from './lib/esplanadi-facade-restoration.ts';
const cityDir='data/work/expansion-20261017/citymodel';
const city=JSON.parse(readFileSync(cityDir+'/city-model.json','utf8'));
const out=process.argv[2];if(!out)throw new Error('pass a fresh evidence directory');mkdirSync(out,{recursive:false});
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const sources=new Map(),patched=new Map();
for(const p of esplanadiRestoration.sourcePages){const bytes=readFileSync(cityDir+'/'+city.textures[p].file),image=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});sources.set(p,{data:image.data,width:image.info.width,height:image.info.height,pngSha256:sha(bytes)});}
const ext=esplanadiRestoration.externalSources![0]!,bytes=readFileSync(ext.file),image=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const externals=new Map([[ext.id,{data:image.data,width:image.info.width,height:image.info.height,sha256:sha(bytes)}]]),evidence=[];
for(const p of esplanadiRestoration.targetPages){const s=sources.get(p)!,data=Uint8Array.from(s.data);evidence.push(...esplanadiRestoration.apply(p,data,s.width,s.height,sources,externals));patched.set(p,{...s,data});await sharp(data,{raw:{width:s.width,height:s.height,channels:4}}).png().toFile(out+`/page${p}-after.png`);}
for(const b of esplanadiMapping.buildings){const tris=b.charts.flatMap(c=>c.tris.map(t=>({...t,page:c.page}))),pts=tris.flatMap(t=>t.xyz),min=[Math.min(...pts.map(v=>v[0])),Math.min(...pts.map(v=>v[2]))],max=[Math.max(...pts.map(v=>v[0])),Math.max(...pts.map(v=>v[2]))],w=Math.round((max[0]!-min[0]!)*24),h=Math.round((max[1]!-min[1]!)*24);
  for(const [label,images] of [['before',sources],['after',patched]] as const){const data=Buffer.alloc(w*h*4);for(let i=3;i<data.length;i+=4)data[i]=255;
    for(const t of tris){const s=images.get(t.page);if(!s)continue;const p=t.xyz.map(v=>[(v[0]-min[0]!)/(max[0]!-min[0]!)*w,(max[1]!-v[2])/(max[1]!-min[1]!)*h]),[a,b,c]=p as [number[],number[],number[]],d=(b[1]!-c[1]!)*(a[0]!-c[0]!)+(c[0]!-b[0]!)*(a[1]!-c[1]!);
      for(let y=Math.max(0,Math.floor(Math.min(...p.map(q=>q[1]!))));y<Math.min(h,Math.ceil(Math.max(...p.map(q=>q[1]!))));y++)for(let x=Math.max(0,Math.floor(Math.min(...p.map(q=>q[0]!))));x<Math.min(w,Math.ceil(Math.max(...p.map(q=>q[0]!))));x++){
        const wa=((b[1]!-c[1]!)*(x+.5-c[0]!)+(c[0]!-b[0]!)*(y+.5-c[1]!))/d,wb=((c[1]!-a[1]!)*(x+.5-c[0]!)+(a[0]!-c[0]!)*(y+.5-c[1]!))/d,wc=1-wa-wb;if(Math.min(wa,wb,wc)<0)continue;
        const u=t.uv[0]![0]*wa+t.uv[1]![0]*wb+t.uv[2]![0]*wc,v=t.uv[0]![1]*wa+t.uv[1]![1]*wb+t.uv[2]![1]*wc,sx=Math.max(0,Math.min(s.width-1,Math.floor(u*s.width))),sy=Math.max(0,Math.min(s.height-1,Math.floor(v*s.height)));for(let ch=0;ch<4;ch++)data[(y*w+x)*4+ch]=s.data[(sy*s.width+sx)*4+ch];
      }
    }
    await sharp(data,{raw:{width:w,height:h,channels:4}}).png().toFile(out+'/'+b.name+'-'+label+'.png');
  }
}
writeFileSync(out+'/review.json',JSON.stringify({status:'CAPTURED_NOT_REVIEWED',evidence},null,2)+'\n');
