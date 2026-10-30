// Bounded original-art reconstruction of one municipal front elevation.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import type {FacadeRestorationModule,FacadeExternalSourceImage} from './facade-restoration-types.ts';

export const BULEVARDI46_MASTER_PNG_SHA256='c960951c8b409bb8af92db7fc9fc56a1f06bcf6814b906820fba34589059c06e';
export const BULEVARDI46_ART_SHA256='8444042810b90782554f0c6ba20215194a1a520042af2414806387c326d3efa0';
// Original source part5 triangles0/1; PNG coordinates use 1-v. No other chart is selected.
export const BULEVARDI46_FRONT_UV=[
  [.05939701199531555,1-.3198840618133545],
  [.08692052215337753,1-.013258874416351318],
  [.9977792501449585,1-.556145191192627],
  [.9771727323532104,1-.8623772263526917],
] as const;
type Point=readonly[number,number];
const artCorners:readonly Point[]=[[0,0],[0,1],[1,1],[1,0]];

function weights(p:Point,a:Point,b:Point,c:Point):readonly[number,number,number]|null{
  const det=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/det;
  const v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/det,w=1-u-v;
  return Math.min(u,v,w)>=-1e-10?[u,v,w]:null;
}
export function bulevardi46FrontArtPoint(point:Point):Point|null{
  for(const ids of [[0,1,2],[0,2,3]] as const){
    const bary=weights(point,BULEVARDI46_FRONT_UV[ids[0]],BULEVARDI46_FRONT_UV[ids[1]],BULEVARDI46_FRONT_UV[ids[2]]);
    if(bary)return [0,1].map(axis=>ids.reduce<number>((sum,id,i)=>sum+artCorners[id]![axis]!*bary[i]!,0)) as [number,number];
  }
  return null;
}
function sample(image:FacadeExternalSourceImage,u:number,v:number,channel:number):number{
  const x=Math.max(0,Math.min(image.width-1,u*(image.width-1))),y=Math.max(0,Math.min(image.height-1,v*(image.height-1)));
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const at=(xx:number,yy:number)=>image.data[(Math.min(yy,image.height-1)*image.width+Math.min(xx,image.width-1))*4+channel]!;
  return Math.round((at(ix,iy)*(1-fx)+at(ix+1,iy)*fx)*(1-fy)+(at(ix,iy+1)*(1-fx)+at(ix+1,iy+1)*fx)*fy);
}
export function createBulevardi46Restoration(page:109|866):FacadeRestorationModule{
  assert.ok(page===109||page===866,'Explicit native-subset or cumulative source-page binding required');
  const artId='bulevardi46-original-front-v1';
  return {
    id:`bulevardi46-front-original-v1-page${page}`,targetPages:[page],sourcePages:[page],
    externalSources:[{id:artId,file:fileURLToPath(new URL('../../../content/assets/facades/bulevardi46/front-v1.png',import.meta.url)),sha256:BULEVARDI46_ART_SHA256}],
    apply(selected,rgba,width,height,sources,external){
      if(selected!==page)return [];
      const source=sources.get(page);
      assert.ok(source&&source.pngSha256===BULEVARDI46_MASTER_PNG_SHA256,'Wrong Bulevardi46 raw municipal PNG master');
      assert.ok(source.width===1024&&source.height===1024,'Wrong Bulevardi46 master dimensions');
      assert.ok(Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=8192&&height<=8192&&rgba.length===width*height*4,'Invalid target page');
      const art=external?.get(artId);
      assert.ok(art&&art.sha256===BULEVARDI46_ART_SHA256&&art.width===1800&&art.height===510&&art.data.length===1800*510*4,'Missing or changed original facade artwork');
      for(let a=3;a<art.data.length;a+=4)assert.equal(art.data[a],255,'Opaque original artwork required');
      let changedTexels=0,selectedTexels=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const point=bulevardi46FrontArtPoint([(x+.5)/width,(y+.5)/height]);if(!point)continue;
        selectedTexels++;const offset=(y*width+x)*4;let changed=false;
        for(let ch=0;ch<3;ch++){const value=sample(art,point[0],point[1],ch);changed ||= rgba[offset+ch]!==value;rgba[offset+ch]=value;}
        if(changed)changedTexels++;
      }
      return [{id:this.id,page,changedTexels,selectedTexels,limits:'Only source part5 triangles0/1; original reference-led vector approximation,15bay axes/30upper windows/entrances1,7,9. Roof, return charts and alpha unchanged. Final compressed in-game review required.',
        artSha256:BULEVARDI46_ART_SHA256,license:'CC0-1.0',referencePixelsCopied:false,sourcePart:5,sourceTriangles:[0,1]}];
    },
  };
}
