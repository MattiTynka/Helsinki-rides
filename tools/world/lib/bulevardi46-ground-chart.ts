import assert from 'node:assert/strict';
import type {FacadeChart,FacadeTriangle} from './facade-charts.ts';

export interface GroundLinePiece {from:number;to:number;fromY:number;toY:number;witness:string}
const at=(p:GroundLinePiece,u:number)=>p.fromY+(p.toY-p.fromY)*(u-p.from)/(p.to-p.from);

/** Clip the actual XZ triangle to the exterior facade line. No floor extrapolation. */
export function groundTriangleLine(t:FacadeTriangle,chart:FacadeChart,offset:number,witness:string):GroundLinePiece|null {
 const [a,b,c]=t,ab=b.map((v,i)=>v-a[i]!),ac=c.map((v,i)=>v-a[i]!),ny=ab[2]!*ac[0]!-ab[0]!*ac[2]!,length=Math.hypot(ab[1]!*ac[2]!-ab[2]!*ac[1]!,ny,ab[0]!*ac[1]!-ab[1]!*ac[0]!);
 if(!length||ny/length<.45)return null;
 const x=chart.origin[0]-chart.uAxis[2]*offset,z=chart.origin[2]+chart.uAxis[0]*offset,dx=chart.uAxis[0],dz=chart.uAxis[2],den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);
 if(Math.abs(den)<1e-12)return null;
 const u0=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den,du=((b[2]-c[2])*dx+(c[0]-b[0])*dz)/den;
 const v0=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den,dv=((c[2]-a[2])*dx+(a[0]-c[0])*dz)/den;
 let from=chart.bounds[0],to=chart.bounds[2];
 for(const [base,slope] of [[u0,du],[v0,dv],[1-u0-v0,-du-dv]]){if(slope===0){if(base!<0)return null;}else if(slope!>0)from=Math.max(from,-base!/slope!);else to=Math.min(to,-base!/slope!);}
 if(!(to>from))return null;
 const height=(s:number)=>(u0+du*s)*a[1]+(v0+dv*s)*b[1]+(1-u0-v0-(du+dv)*s)*c[1];
 return{from,to,fromY:height(from),toY:height(to),witness};
}

/** Upper envelope of finite, source-derived line pieces, including sheet intersections. */
export function groundLineEnvelope(pieces:readonly GroundLinePiece[],min:number,max:number):GroundLinePiece[]{
 assert.ok(pieces.length&&pieces.length<=4096&&max>min);const breaks=new Set([min,max]);
 for(const p of pieces){assert.ok([p.from,p.to,p.fromY,p.toY].every(Number.isFinite)&&p.to>p.from);breaks.add(Math.max(min,p.from));breaks.add(Math.min(max,p.to));}
 for(let i=0;i<pieces.length;i++)for(let j=i+1;j<pieces.length;j++){const a=pieces[i]!,b=pieces[j]!,lo=Math.max(a.from,b.from,min),hi=Math.min(a.to,b.to,max);if(hi<=lo)continue;const d0=at(a,lo)-at(b,lo),d1=at(a,hi)-at(b,hi);if(d0*d1<0)breaks.add(lo+(hi-lo)*d0/(d0-d1));}
 const us=[...breaks].filter(u=>u>=min&&u<=max).sort((a,b)=>a-b),result:GroundLinePiece[]=[];
 for(let i=0;i+1<us.length;i++){const from=us[i]!,to=us[i+1]!;if(!(to>from))continue;const mid=(from+to)/2,candidates=pieces.filter(p=>p.from<=mid&&p.to>=mid).sort((a,b)=>at(b,mid)-at(a,mid));assert.ok(candidates.length,`Uncovered native ground interval ${from}..${to}`);const selected=candidates[0]!;result.push({from,to,fromY:at(selected,from),toY:at(selected,to),witness:selected.witness});}
 assert.ok(result.length&&result[0]!.from===min&&result.at(-1)!.to===max);return result;
}
export function measuredGroundAt(profile:readonly GroundLinePiece[],u:number){const hit=profile.filter(p=>u>=p.from-1e-12&&u<=p.to+1e-12);assert.ok(hit.length,'Ground query outside measured profile');return Math.max(...hit.map(p=>at(p,Math.max(p.from,Math.min(p.to,u)))));}

/** Preserve the upper cornice and lift the artwork's bottom to the measured pavement.
 * The source mesh remains unchanged; buried texels use the original foundation row.
 * Content uses pixel centres, matching facadeChartUv, with a replicated one-pixel gutter. */
export function warpGroundedFacade(source:{data:Uint8Array;width:number;height:number},chart:FacadeChart,profile:readonly GroundLinePiece[],width=1024,height=290){
 assert.equal(source.data.length,source.width*source.height*4);const [px,py,pw,ph]=chart.pixels;assert.ok(px>=1&&py>=1&&px+pw<width&&py+ph<height&&pw>=2&&ph>=2);
 const out=new Uint8Array(width*height*4),[minU,minY,maxU,maxY]=chart.bounds;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const fx=Math.max(0,Math.min(1,(x-px)/(pw-1))),fy=Math.max(0,Math.min(1,(y-py)/(ph-1))),u=minU+fx*(maxU-minU),floor=measuredGroundAt(profile,u);assert.ok(floor>=minY&&floor<maxY-3,'Measured floor is outside this facade');
  const worldY=maxY-fy*(maxY-minY),artY=Math.max(0,Math.min(1,(maxY-worldY)/(maxY-floor))),sx=fx*(source.width-1),sy=artY*(source.height-1),x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(source.width-1,x0+1),y1=Math.min(source.height-1,y0+1),tx=sx-x0,ty=sy-y0;
  for(let c=0;c<3;c++)out[(y*width+x)*4+c]=Math.round((1-ty)*((1-tx)*source.data[(y0*source.width+x0)*4+c]!+tx*source.data[(y0*source.width+x1)*4+c]!)+ty*((1-tx)*source.data[(y1*source.width+x0)*4+c]!+tx*source.data[(y1*source.width+x1)*4+c]!));
  out[(y*width+x)*4+3]=255;
 }
 return out;
}
