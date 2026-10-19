// Former Bank of Finland printing works, Unioninkatu side of Rauhankatu19 (VTJ103036709T).
// April2023 Street View confirms12 tall hall-window axes above12 short basement windows, no west door.
// Source glass and stone come solely from the clear centre of the SAME licensed west wall, page5.
import type { FacadeRestorationModule, FacadeSourceImage } from './facade-restoration-types.ts';
type Point = readonly [number,number];
export const RAUHANKATU19_PAGE = 5;
export const RAUHANKATU19_MASTER_SHA256 = '9acd7df710c215e0f865aded3d4ddd30b8ddc80d7a80bacca3f83b7870b0337a';
export const RAUHANKATU19_WEST = [
  { uv: [[.4173581898212433,.5654692053794861],[.4052734375,.7218737602233887],[.9015452265739441,.7218737602233887]], world: [[231.94100952148438,5.85007905960083],[231.9409942626953,16.09008026123047],[257.6159973144531,16.090078353881836]] },
  { uv: [[.4173581898212433,.5654692053794861],[.9015452265739441,.7218737602233887],[.911473274230957,.5654296875]], world: [[231.94100952148438,5.85007905960083],[257.6159973144531,16.090078353881836],[257.6159973144531,5.850079536437988]] }
] as const;
const MIN_NORTH = 231.94101, MAX_NORTH = 257.61599, BAY_COUNT = 12, BAY = (MAX_NORTH - MIN_NORTH) / BAY_COUNT;
function weights(p:Point, tri:readonly Point[]):number[]|null {
  const [a,b,c]=tri as [Point,Point,Point],d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  if(Math.abs(d)<1e-12)return null;
  const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/d,v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/d;
  return u < -1e-8 || v < -1e-8 || u+v > 1.00000001 ? null : [u,v,1-u-v];
}
function source(master:FacadeSourceImage,n:number,h:number):number[] {
  for(const t of RAUHANKATU19_WEST){const q=weights([n,h],t.world);if(!q)continue;const uv=[0,1].map(k=>q.reduce((a,b,i)=>a+b*t.uv[i]![k]!,0));
    const x=Math.max(0,Math.min(master.width-1,uv[0]!*master.width-.5)),y=Math.max(0,Math.min(master.height-1,uv[1]!*master.height-.5)),ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;
    return [0,1,2].map(ch=>{const at=(xx:number,yy:number)=>master.data[(Math.min(master.height-1,yy)*master.width+Math.min(master.width-1,xx))*4+ch]!;return(at(ix,iy)*(1-tx)+at(ix+1,iy)*tx)*(1-ty)+(at(ix,iy+1)*(1-tx)+at(ix+1,iy+1)*tx)*ty;});
  }
  throw new Error(`Rauhankatu19 donor outside west chart: ${n},${h}`);
}
const modulo=(x:number,p:number)=>((x%p)+p)%p;
export const rauhankatu19Restoration:FacadeRestorationModule={
  id:'rauhankatu19-west-printing-hall',targetPages:[5],sourcePages:[5],
  apply(page,rgba,w,h,sources){
    if(page!==5)return[];
    const master=sources.get(5);if(master?.pngSha256!==RAUHANKATU19_MASTER_SHA256)throw new Error('Rauhankatu19 master changed; west facade requires review');
    if(master.width!==1024||master.height!==1024||master.data.length!==1024*1024*4||rgba.length!==w*h*4)throw new Error('Rauhankatu19 dimensions invalid');
    const color=(n:number,z:number):number[]=>{
      const u=modulo(n-MIN_NORTH,BAY)/BAY;
      // Unoccluded west-hall glass has the correct blinds and horizontal mullion; lower crop excludes leaves.
      if(u>.16&&u<.84&&z>9.05&&z<14.98){const v=(z-9.05)/(14.98-9.05);return source(master,243.02+(u-.16)/.68*1.08,10.8+v*4.06);}
      // The basement is not recovered from behind the tree. Its aligned short frames are authored from
      // this building's glass/stone, with the aspect and floor bands observed in the leafless reference.
      if(u>.12&&u<.88&&z>6.35&&z<7.78){const v=(z-6.35)/1.43,frame=Math.min(u-.12,.88-u)*BAY<.07||Math.min(z-6.35,7.78-z)<.07||Math.abs(u-.5)*BAY<.04;
        const glass=source(master,243.06+(u-.12)/.76*1.25,13.38+v*1.42);return frame?glass.map(v=>v*.52):glass;}
      if(z>15.25)return source(master,242.8+u*1.6,Math.min(16.07,z));
      // Horizontal panel courses and vertical pier joints keep a coherent elevation, not crown-shaped fills.
      const stone=source(master,242.66+modulo(n-MIN_NORTH,.18),13.6+modulo(z,.6));
      const joint=[6.0,7.95,8.85,12.85,15.2].some(course=>Math.abs(z-course)<.026)||(Math.abs(u-.5)*BAY<.02&&!(z>9&&z<15));
      return joint?stone.map(v=>v*.78):stone;
    };
    let changed=0;
    for(const t of RAUHANKATU19_WEST){const x0=Math.max(0,Math.floor(Math.min(...t.uv.map(p=>p[0]))*w)),x1=Math.min(w-1,Math.ceil(Math.max(...t.uv.map(p=>p[0]))*w)),y0=Math.max(0,Math.floor(Math.min(...t.uv.map(p=>p[1]))*h)),y1=Math.min(h-1,Math.ceil(Math.max(...t.uv.map(p=>p[1]))*h));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const q=weights([(x+.5)/w,(y+.5)/h],t.uv);if(!q)continue;const p=[0,1].map(k=>q.reduce((a,b,i)=>a+b*t.world[i]![k]!,0)),c=color(p[0]!,p[1]!);for(let ch=0;ch<3;ch++)rgba[(y*w+x)*4+ch]=Math.round(Math.max(0,Math.min(255,c[ch]!)));changed++;}
    }
    return[{id:'rauhankatu19-west-twelve-hall-axes',page,changedTexels:changed,bays:BAY_COUNT,tallGlassHeight:[9.05,14.98],basementGlassHeight:[6.35,7.78],sourceTallGlass:{north:[243.02,244.10],height:[10.80,14.86]},sourcePierStone:{north:[242.66,242.84],height:[13.6,14.2]},method:'Same-west hall glazing, explicit12-axis world-coordinate projection, authored basement frames and panel courses from the same licensed source stone/glass',limits:'Occluded pixels are reconstructed, not recovered. Basement framing is authored from reference observations using same-building source pixels. South unique entrance and every other chart remain original; external reference pixels are not used.'}];
  }
};
