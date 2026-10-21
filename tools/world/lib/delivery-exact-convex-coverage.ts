import assert from 'node:assert/strict';
// This proof runs on source-local convex pieces. Rational arithmetic preserves
// every input Float64 coordinate and every positive residual, including narrow
// pieces where a floating sweep cannot assemble a closed output ring.
type Rational={n:bigint;d:bigint};type Point=readonly[Rational,Rational];
const gcd=(a:bigint,b:bigint):bigint=>{a=a<0n?-a:a;while(b){const r=a%b;a=b;b=r;}return a;};
const rational=(n:bigint,d=1n):Rational=>{assert.notEqual(d,0n);if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return{n:n/g,d:d/g};};
const add=(a:Rational,b:Rational)=>rational(a.n*b.d+b.n*a.d,a.d*b.d),sub=(a:Rational,b:Rational)=>rational(a.n*b.d-b.n*a.d,a.d*b.d),mul=(a:Rational,b:Rational)=>rational(a.n*b.n,a.d*b.d),div=(a:Rational,b:Rational)=>rational(a.n*b.d,a.d*b.n);
function exact(value:number):Rational{
 assert.ok(Number.isFinite(value));if(value===0)return rational(0n);
 const bits=new DataView(new ArrayBuffer(8));bits.setFloat64(0,value);const raw=bits.getBigUint64(0),exponent=Number((raw>>52n)&2047n),mantissa=(raw&((1n<<52n)-1n))|(exponent?1n<<52n:0n),shift=exponent?exponent-1075:-1074,sign=raw>>63n?-1n:1n;
 return shift>=0?rational(sign*(mantissa<<BigInt(shift))):rational(sign*mantissa,1n<<BigInt(-shift));
}
const point=(p:readonly number[]):Point=>[exact(p[0]!),exact(p[1]!)];
const cross=(a:Point,b:Point,p:Point)=>sub(mul(sub(b[0],a[0]),sub(p[1],a[1])),mul(sub(b[1],a[1]),sub(p[0],a[0])));
function twiceArea(p:readonly Point[]){let area=rational(0n);for(let i=1;i+1<p.length;i++)area=add(area,cross(p[0]!,p[i]!,p[i+1]!));return area;}
export const hasExactPolygonArea=(p:readonly(readonly number[])[])=>twiceArea(p.map(point)).n!==0n;
function polygon(input:readonly(readonly number[])[]):Point[]{
 const out=input.map(point);if(out.length>1&&sub(out[0]![0],out.at(-1)![0]).n===0n&&sub(out[0]![1],out.at(-1)![1]).n===0n)out.pop();
 const orientation=twiceArea(out).n;assert.notEqual(orientation,0n,'Exact coverage needs a positive convex source piece');
 for(let i=0;i<out.length;i++){const turn=cross(out[i]!,out[(i+1)%out.length]!,out[(i+2)%out.length]!).n;assert.ok(turn===0n||(turn>0n)===(orientation>0n),'Coverage source piece must be convex');}return out;
}
function clip(p:readonly Point[],a:Point,b:Point,sign:bigint){
 const out:Point[]=[];for(let i=0;i<p.length;i++){const A=p[i]!,B=p[(i+1)%p.length]!,u=cross(a,b,A),v=cross(a,b,B),inside=u.n*sign>=0n,nextInside=v.n*sign>=0n;
  if(inside)out.push(A);if(inside!==nextInside){const t=div(u,sub(u,v));out.push([add(A[0],mul(sub(B[0],A[0]),t)),add(A[1],mul(sub(B[1],A[1]),t))]);}
 }return out;
}
const compare=(a:Rational,b:Rational)=>a.n*b.d-b.n*a.d;
const boxes=new WeakMap<readonly Point[],readonly Rational[]>();
function box(p:readonly Point[]){let cached=boxes.get(p);if(!cached){let x0=p[0]![0],x1=x0,z0=p[0]![1],z1=z0;for(const v of p){if(compare(v[0],x0)<0n)x0=v[0];if(compare(v[0],x1)>0n)x1=v[0];if(compare(v[1],z0)<0n)z0=v[1];if(compare(v[1],z1)>0n)z1=v[1];}cached=[x0,z0,x1,z1];boxes.set(p,cached);}return cached;}
const positive=(p:readonly Point[])=>p.length>=3&&p.slice(1,-1).some((v,i)=>cross(p[0]!,v,p[i+2]!).n!==0n);
function subtract(subject:readonly Point[],mask:readonly Point[]){
 const aBox=box(subject),bBox=box(mask);if(compare(aBox[2]!,bBox[0]!)<=0n||compare(aBox[0]!,bBox[2]!)>=0n||compare(aBox[3]!,bBox[1]!)<=0n||compare(aBox[1]!,bBox[3]!)>=0n)return[Array.from(subject)];
 const sign=twiceArea(mask).n>0n?1n:-1n,out:Point[][]=[];let current=Array.from(subject);
 for(let i=0;i<mask.length&&current.length;i++){const a=mask[i]!,b=mask[(i+1)%mask.length]!,values=current.map(p=>cross(a,b,p).n*sign);if(values.every(v=>v>=0n))continue;if(values.every(v=>v<=0n)){out.push(current);current=[];break;}const outside=clip(current,a,b,-sign);if(positive(outside))out.push(outside);current=clip(current,a,b,sign);if(!positive(current))current=[];}
 return out;
}
function numeric(q:Rational){if(q.n===0n)return 0;const sign=q.n<0n?-1:1,n=q.n<0n?-q.n:q.n,ns=Math.max(0,n.toString(2).length-53),ds=Math.max(0,q.d.toString(2).length-53);return sign*Number(n>>BigInt(ns))/Number(q.d>>BigInt(ds))*2**(ns-ds);}
export function exactConvexCoverage(wanted:readonly(readonly(readonly number[])[])[],literalFloors:readonly(readonly(readonly number[])[])[],edgeNeighborhoods:readonly(readonly(readonly number[])[])[]){
 let remaining=wanted.map(polygon);const sourceArea=remaining.reduce((s,p)=>s+Math.abs(numeric(twiceArea(p)))/2,0);
 for(const floor of literalFloors){if(!remaining.length)break;const mask=polygon(floor);remaining=remaining.flatMap(p=>subtract(p,mask));}
 const rawMissingArea=remaining.reduce((s,p)=>s+Math.abs(numeric(twiceArea(p)))/2,0);
 for(const edge of edgeNeighborhoods){if(!remaining.length)break;const mask=polygon(edge);remaining=remaining.flatMap(p=>subtract(p,mask));}
 return{publishedMaskArea:sourceArea,rawMissingArea,unexplainedArea:remaining.reduce((s,p)=>s+Math.abs(numeric(twiceArea(p)))/2,0),unexplainedComponents:remaining.map(p=>p.map(v=>v.map(numeric))),exactPositiveResiduals:remaining.length};
}
