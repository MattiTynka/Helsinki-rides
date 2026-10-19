// Holy Trinity Church, VTJ103027191S: south nave and south tower base only.
// Google May2018 panorama CIHM0ogKEICAgIDEy6uvbg and clear winter references show
// five tall nave windows, triangular hoods on1/3/5 and circular ornaments on2/4.
// The native nave bays are entirely behind photographed crowns. Architecture is
// authored from those observations using only this church's licensed plaster/glass.
// The unresolved apse, its service door, west entrance, roof and upper towers stay original.
import type { FacadeRestorationModule, FacadeSourceImage } from './facade-restoration-types.ts';

type Point = readonly [number, number];
interface ChartTriangle { readonly uv: readonly Point[]; readonly world: readonly Point[] }
export const CHURCH_MASTER_HASHES = new Map([
  [23, '39d1a2587a5630829733b64bd7cdbeb00c8421ee25336e4132518ab75044c296'],
  [24, '2fcce158ffaba2f0646d5a7c685101ad8316d04ec02e96534bc2c7dd9c6180cc'],
]);
// Original page24 triangle34/35 and58/59. world = east/up metres; UV is image-top-left.
export const CHURCH_SOUTH_CHARTS: readonly ChartTriangle[] = [
  { uv: [[.8674819469451904,.9832627773284912],[.7568359375,.972679853439331],[.7568359375,.5751953125]], world: [[-62.06299591064453,15.300004005432129],[-62.06299591064453,7.920079231262207],[-43.39399719238281,7.920078754425049]] },
  { uv: [[.8674819469451904,.9832627773284912],[.7568359375,.5751953125],[.8673823475837708,.584353506565094]], world: [[-62.06299591064453,15.300004005432129],[-43.39399719238281,7.920078754425049],[-43.39399719238281,15.295905113220215]] },
  { uv: [[.5077725052833557,.8529931902885437],[.6191381812095642,.7344443798065186],[.6191381812095642,.9956628680229187]], world: [[-62.288997650146484,16.549999237060547],[-67.40999603271484,24.83991050720215],[-67.40999603271484,7.920079231262207]] },
  { uv: [[.5077725052833557,.8529931902885437],[.6191381812095642,.9956628680229187],[.508232831954956,.9857242107391357]], world: [[-62.288997650146484,16.549999237060547],[-67.40999603271484,7.920079231262207],[-62.288997650146484,7.920079231262207]] },
];
// Same-church south cupola chart114/115, used only as native material samples.
const MATERIAL_DONOR: readonly ChartTriangle[] = [
  { uv: [[.7466425895690918,.61328125],[.74609375,.6850190162658691],[.8397859334945679,.6848875880241394]], world: [[-51.759849548339844,17.15007972717285],[-51.759849548339844,22.140077590942383],[-55.21814727783203,22.140079498291016]] },
  { uv: [[.7466425895690918,.61328125],[.8397859334945679,.6848875880241394],[.8400530219078064,.61328125]], world: [[-51.759849548339844,17.15007972717285],[-55.21814727783203,22.140079498291016],[-55.21814727783203,17.159345626831055]] },
];
export const CHURCH_NAVE_WINDOW_AXES = [-59.82,-56.27,-52.73,-49.18,-45.63] as const;
export const CHURCH_TOWER_WINDOW_AXIS = -64.85;
export const CHURCH_TOWER_KEEP_ABOVE = 16.55;
function weights(point: Point, triangle: readonly Point[]): number[] | null {
  const [a,b,c] = triangle as [Point,Point,Point];
  const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  if(Math.abs(d)<1e-12)return null;
  const u=((b[1]-c[1])*(point[0]-c[0])+(c[0]-b[0])*(point[1]-c[1]))/d;
  const v=((c[1]-a[1])*(point[0]-c[0])+(a[0]-c[0])*(point[1]-c[1]))/d;
  return u<0||v<0||u+v>1 ? null : [u,v,1-u-v];
}
function sample(source: FacadeSourceImage, east: number, height: number): number[] {
  for(const triangle of MATERIAL_DONOR){
    const q=weights([east,height],triangle.world);if(!q)continue;
    const uv=[0,1].map(k=>q.reduce((sum,w,i)=>sum+w*triangle.uv[i]![k]!,0));
    const x=Math.max(0,Math.min(source.width-1,uv[0]!*source.width-.5)),y=Math.max(0,Math.min(source.height-1,uv[1]!*source.height-.5));
    const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;
    return [0,1,2].map(ch=>{const at=(xx:number,yy:number)=>source.data[(Math.min(source.height-1,yy)*source.width+Math.min(source.width-1,xx))*4+ch]!;return(at(ix,iy)*(1-tx)+at(ix+1,iy)*tx)*(1-ty)+(at(ix,iy+1)*(1-tx)+at(ix+1,iy+1)*tx)*ty;});
  }
  throw new Error('Church material donor sample outside pinned chart');
}
const fraction=(v:number)=>v-Math.floor(v);
function southPixel(source: FacadeSourceImage, plasterBase: readonly number[], east: number, z: number, tower: boolean): number[] {
  const grain=sample(source,-53.0+fraction(east*.71)*.35,18.88+fraction(z*.93)*.15);
  // The tiny native patch contains baked cupola shading. Keep its material colour and
  // low-amplitude grain, without repeating that shading as stripes over a flat wall.
  const plaster=plasterBase.map((value,ch)=>value+(grain[ch]!-value)*.10);
  const light=(gain:number)=>plaster.map(v=>Math.min(255,v*gain));
  if(z<8.55){
    const stone=plaster.map((v,ch)=>v*[.44,.40,.37][ch]!);
    if(Math.abs(z-8.03)<.035||Math.abs(z-8.51)<.035||fraction((east+68)/1.7)<.025)return stone.map(v=>v*.73);
    if(!tower&&[CHURCH_NAVE_WINDOW_AXES[1],CHURCH_NAVE_WINDOW_AXES[3]].some(x=>Math.abs(east-x)<.28)&&z>8.12&&z<8.38)return stone.map(v=>v*.34);
    return stone;
  }
  if(z>14.96){
    if(z<15.06)return light(.66);
    if(z<15.25)return light(1.10);
    if(tower&&z>16.22&&z<16.42)return light(1.09);
    return plaster;
  }
  const axes=tower?[CHURCH_TOWER_WINDOW_AXIS]:CHURCH_NAVE_WINDOW_AXES;
  for(const [index,axis]of axes.entries()){
    const dx=east-axis,half=.59,bottom=10.38,top=13.58;
    if(Math.abs(dx)<half&&z>bottom&&z<top){
      const u=(dx+half)/(half*2),v=(z-bottom)/(top-bottom);
      const glass=sample(source,-55.05+u*.25,19.5+v*.8);
      const wood=Math.abs(dx)<.043||Math.abs(dx)>.52||z<bottom+.09||z>top-.09||[.25,.5,.75].some(row=>Math.abs(v-row)<.014);
      // Fine glazing bars are authored at the observed tall rectangular aspect; no arched cupola silhouette transfers.
      const fine=[.2,.4,.6,.8].some(col=>Math.abs(u-col)<.012);
      return glass.map(value=>value*(wood?.46:fine?.65:1));
    }
    if(Math.abs(dx)<.70&&z>10.28&&z<10.39)return light(.65);
    if(tower||index%2===0){
      if(Math.abs(dx)<.84&&z>13.63&&z<13.94)return light(z<13.72?.72:1.07);
      const edge=14.66-Math.abs(dx)*.70;
      if(Math.abs(dx)<.95&&z>14.0&&z<edge)return light(edge-z<.07?1.12:.91);
      if(Math.abs(dx)<.97&&z>13.96&&z<14.05)return light(1.1);
    }else{
      const radius=Math.hypot(dx,z-14.25);
      if(radius>.19&&radius<.28)return light(radius<.23?.77:1.10);
      if(Math.abs(dx)>.26&&Math.abs(dx)<.61&&Math.abs(z-(14.08+.08*Math.cos(dx*12)))<.04)return light(1.08);
    }
  }
  return plaster;
}

export const churchRestoration: FacadeRestorationModule = {
  id:'holy-trinity-confirmed-south-elevation',targetPages:[24],sourcePages:[23,24],
  apply(page,rgba,width,height,sources){
    if(page!==24)return[];
    for(const [id,hash]of CHURCH_MASTER_HASHES){const source=sources.get(id);if(source?.pngSha256!==hash)throw new Error(`Church master page${id} changed`);if(source.width!==1024||source.height!==1024||source.data.length!==1024*1024*4)throw new Error('Church source dimensions invalid');}
    if(rgba.length!==width*height*4||width<128||height<128)throw new Error('Church target dimensions invalid');
    const source=sources.get(23)!,touched=new Set<number>();
    const materialSamples=Array.from({length:25},(_,i)=>sample(source,-53.0+(i%5)/4*.35,18.88+Math.floor(i/5)/4*.15));
    const plasterBase=[0,1,2].map(ch=>materialSamples.reduce((sum,p)=>sum+p[ch]!/materialSamples.length,0));
    for(const [chartIndex,triangle]of CHURCH_SOUTH_CHARTS.entries()){
      const x0=Math.max(0,Math.floor(Math.min(...triangle.uv.map(p=>p[0]))*width)),x1=Math.min(width-1,Math.ceil(Math.max(...triangle.uv.map(p=>p[0]))*width));
      const y0=Math.max(0,Math.floor(Math.min(...triangle.uv.map(p=>p[1]))*height)),y1=Math.min(height-1,Math.ceil(Math.max(...triangle.uv.map(p=>p[1]))*height));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const q=weights([(x+.5)/width,(y+.5)/height],triangle.uv);if(!q)continue;
        const p=[0,1].map(k=>q.reduce((sum,w,i)=>sum+w*triangle.world[i]![k]!,0));
        if(chartIndex>=2&&p[1]!>=CHURCH_TOWER_KEEP_ABOVE)continue;
        const color=southPixel(source,plasterBase,p[0]!,p[1]!,chartIndex>=2),i=(y*width+x)*4;
        for(let ch=0;ch<3;ch++)rgba[i+ch]=Math.round(Math.max(0,Math.min(255,color[ch]!)));
        touched.add(i);
      }
    }
    return[{id:'holy-trinity-five-nave-windows-and-south-tower-base',page,changedTexels:touched.size,naveWindowAxes:CHURCH_NAVE_WINDOW_AXES,towerWindowAxis:CHURCH_TOWER_WINDOW_AXIS,keepTowerAbove:CHURCH_TOWER_KEEP_ABOVE,plasterBase,method:'Reference-observed authored rectangular glazing, alternating triangular/circular ornaments, cornice and stone base; native same-church material colour and low-amplitude plaster grain only',limits:'Occluded architecture is reconstructed, not recovered. Every page23 pixel including unresolved apse/service door/cupola stays exact; west entrance, upper tower and all other page24 charts are preserved. Some original photographed foliage remains on unresolved elevations. No external reference pixels are used.'}];
  },
};
