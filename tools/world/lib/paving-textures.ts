// Original granite albedo only. No reference photograph is sampled and no
// displacement, dark baked directional shadow or normal map is introduced.
import type {RgbaImage} from './gltf.ts';
import type {ResurfacingPlan,PavingPattern} from './ground-resurfacing.ts';
export function fanRadialCourseMetres(tileMetres:number,stonesPerSide:number):number{return tileMetres/(2*stonesPerSide);}
export function pavingPatternCoordinates(u:number,v:number,n:number,pattern:PavingPattern){
  const mod=(a:number,m:number)=>(a%m+m)%m;u=mod(u,1);v=mod(v,1);
  const fy=v*n,row=Math.floor(fy),fx=u*n+(row%2)*.5,col=Math.floor(fx);
  let sx=mod(col,n),sy=mod(row,n),ex=Math.min(fx-col,1-(fx-col)),ey=Math.min(fy-row,1-(fy-row));
  if(pattern==='fan-cobble'){
    const px=u*2,py=v*2;let choice:{dx:number;dy:number;r:number;row:number;col:number}|null=null;
    for(let cy=Math.floor(py)-2;cy<=Math.floor(py);cy++)for(let cx=Math.floor(px)-2;cx<=Math.floor(px)+2;cx++){
      const dx=px-(cx+(mod(cy,2)? .5:0)),dy=py-cy,r=Math.hypot(dx,dy);
      if(dy>=0&&Math.abs(dx)<=dy+.000001&&(!choice||r<choice.r))choice={dx,dy,r,row:cy,col:cx};
    }
    const q=choice!,radial=q.r*n,course=Math.floor(radial),theta=Math.atan2(q.dx,q.dy),angular=theta*Math.max(1,course+.5);
    ex=Math.min(radial-course,1-(radial-course));const segment=Math.floor(angular);ey=Math.min(angular-segment,1-(angular-segment));
    sx=mod(segment+mod(q.col,2)*n,n);sy=mod(course+mod(q.row,2)*n,n);
  }
  return {sx,sy,ex,ey};
}
export function originalPavingTexture(options:ResurfacingPlan['texture'],pattern:PavingPattern='setts'):RgbaImage {
  const {size,seed,stonesPerSide:n}=options,data=new Uint8Array(size*size*4);
  const hash=(a:number,b:number,c:number)=>{let x=(seed^Math.imul(a+1,374761393)^Math.imul(b+1,668265263)^Math.imul(c+1,1274126177))>>>0;x=Math.imul(x^(x>>>13),1274126177);return ((x^(x>>>16))>>>0)/4294967296;};
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const {sx,sy,ex,ey}=pavingPatternCoordinates(x/size,y/size,n,pattern);
    const edge=Math.min(ex,ey);
    // The repeating tile is nominally 2 m; final UV scaling records each region's
    // actual block dimensions. The joint is a thin recessed separation.
    const joint=Math.min(.08,Math.max(.008,options.jointMetres*n/2));
    const tint=(hash(sx,sy,0)-.5)*29,grain=(hash(x,y,1)-.5)*10,speck=hash(x,y,2)>.976?11:0;
    const boundary=edge<joint?.62+.38*edge/joint:edge<joint*2?.94+.06*(edge-joint)/joint:1;
    const warm=(hash(sx,sy,3)-.5)*(pattern==='fan-cobble'?17:7);
    const base=[133+tint+warm,132+tint,129+tint-warm];
    const i=(y*size+x)*4;for(let c=0;c<3;c++)data[i+c]=Math.round(Math.min(255,Math.max(0,(base[c]!+grain+speck)*boundary)));data[i+3]=255;
  }
  return {width:size,height:size,data};
}
export function pavingRgbaMipBytes(size:number):number {let total=0;for(let n=size;n>=1;n=Math.floor(n/2))total+=n*n*4;return total;}
export function pavingBc7MipBytes(size:number):number {let total=0;for(let n=size;n>=1;n=Math.floor(n/2))total+=Math.ceil(n/4)**2*16;return total;}
