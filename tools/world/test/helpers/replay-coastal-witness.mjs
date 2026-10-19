// Isolated, memory-bounded replay of the actual Pitkäsilta source failure.
import fs from 'node:fs';
import crypto from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import {clipCoastalGround} from '../../lib/coastal-mask.ts';
import {bbox} from '../../lib/geometry.ts';

const file=process.argv[2];
if(!file)throw new Error('Pass a captured coastal retry witness JSON');
const bytes=fs.readFileSync(file),w=JSON.parse(bytes),sourceBefore=JSON.stringify(w);
const helperBytes=fs.readFileSync(new URL('../../lib/coastal-mask.ts',import.meta.url));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const stableRingArea=r=>{const a=r[0];let sum=0;for(let i=1;i+1<r.length;i++)sum+=(r[i][0]-a[0])*(r[i+1][1]-a[1])-(r[i+1][0]-a[0])*(r[i][1]-a[1]);return sum/2;};
const geometryArea=g=>g.reduce((sum,p)=>sum+Math.abs(stableRingArea(p[0]))-p.slice(1).reduce((sum,r)=>sum+Math.abs(stableRingArea(r)),0),0);
const elapsed=callback=>{const start=performance.now();try{return{ok:true,geometry:callback(),milliseconds:performance.now()-start};}catch(e){return{ok:false,error:{name:e.name,message:e.message},milliseconds:performance.now()-start};}};
const exact=elapsed(()=>polygonClipping[w.operation](...w.originalInputs));
const snapped=elapsed(()=>polygonClipping[w.operation](...w.retryInputs));
const exactDifference=elapsed(()=>polygonClipping.difference(...w.originalInputs));
const snappedDifference=elapsed(()=>polygonClipping.difference(...w.retryInputs));
const piece={cell:w.cell,finish:'asphalt',level:'raised',tag:w.tag,positions:w.trianglePositions.flat(),uvs:w.triangleUvs.flat(),indices:[0,1,2]};
const mask={water:w.originalInputs[1].map((rings,i)=>({id:w.waterPolygonIds[i]??`captured-${i}`,rings,bbox:bbox(rings),properties:{source:'captured source coastal operand'}})),area:{minX:-1350,maxX:800,minZ:-950,maxZ:450},sources:{coastlineWays:[],waterWays:[],waterRelations:[]},stats:{coastlineChains:0,openChains:0,landRings:0,waterArea:geometryArea(w.originalInputs[1])}};
const before=JSON.stringify({piece,mask}),callbacks=[];
const start=performance.now(),clipped=clipCoastalGround([piece],mask,[],{onRetry:pending=>callbacks.push(pending)}),helperMilliseconds=performance.now()-start;
const source=w.trianglePositions,uvs=w.triangleUvs,tri=w.originalInputs[0][0][0],a=tri[0],b=tri[1],c=tri[2];
const determinant=(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);
const bary=p=>{const dx=p[0]-a[0],dn=p[1]-a[1],wb=(dx*(c[1]-a[1])-dn*(c[0]-a[0]))/determinant,wc=((b[0]-a[0])*dn-(b[1]-a[1])*dx)/determinant;return[1-wb-wc,wb,wc];};
const sourceArea=Math.abs(stableRingArea(tri)),perimeter=tri.reduce((sum,p,i)=>sum+Math.hypot(p[0]-tri[(i+1)%3][0],p[1]-tri[(i+1)%3][1]),0);
const longestEdge=Math.max(...tri.map((p,i)=>Math.hypot(p[0]-tri[(i+1)%3][0],p[1]-tri[(i+1)%3][1]))),minimumAltitude=2*sourceArea/longestEdge;
let outputArea=0,minimumOutputTriangleArea=Infinity,outputVertices=0,outputTriangles=0,allFinite=true,maxHeightInterpolationError=0,maxUvInterpolationError=0,maxOutputOutsideWeight=0,maxRecoveredIntersectionOutsideWeight=0;
for(const p of clipped.pieces){
  allFinite&&=p.positions.every(Number.isFinite)&&p.uvs.every(Number.isFinite)&&p.indices.every(i=>Number.isInteger(i)&&i>=0&&i<p.positions.length/3);
  for(let i=0;i<p.indices.length;i+=3){const triangle=p.indices.slice(i,i+3).map(id=>[p.positions[id*3],-p.positions[id*3+2]]),ar=Math.abs(stableRingArea(triangle));outputArea+=ar;minimumOutputTriangleArea=Math.min(minimumOutputTriangleArea,ar);outputTriangles++;}
  for(let i=0;i<p.positions.length;i+=3){const weights=bary([p.positions[i],-p.positions[i+2]]);outputVertices++;maxOutputOutsideWeight=Math.max(maxOutputOutsideWeight,-Math.min(...weights),Math.max(...weights)-1);const expectedHeight=weights.reduce((s,w,k)=>s+w*source[k][1],0);maxHeightInterpolationError=Math.max(maxHeightInterpolationError,Math.abs(expectedHeight-p.positions[i+1]));for(let channel=0;channel<2;channel++){const expected=weights.reduce((s,w,k)=>s+w*uvs[k][channel],0);maxUvInterpolationError=Math.max(maxUvInterpolationError,Math.abs(expected-p.uvs[i/3*2+channel]));}}
}
if(snapped.ok)for(const poly of snapped.geometry)for(const ring of poly)for(const p of ring){const weights=bary(p);maxRecoveredIntersectionOutsideWeight=Math.max(maxRecoveredIntersectionOutsideWeight,-Math.min(...weights),Math.max(...weights)-1);}
const areaTolerance=perimeter*Math.SQRT2*w.latticeMetres+4*w.latticeMetres*w.latticeMetres;
const boundaryWeightTolerance=4*Math.SQRT2*w.latticeMetres/minimumAltitude;
const report={schemaVersion:1,witnessSha256:sha(bytes),helperSha256:sha(helperBytes),node:process.version,library:'polygon-clipping@0.15.7',guards:{maxV8HeapMiB:Number(process.execArgv.find(x=>x.startsWith('--max-old-space-size='))?.split('=')[1]??0),maxSweepLineSegments:process.env.POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS??'default1000000',maxQueueSize:process.env.POLYGON_CLIPPING_MAX_QUEUE_SIZE??'default1000000'},identity:{cell:w.cell,pieceIndex:w.pieceIndex,triangleIndex:w.triangleIndex,sourceIndices:w.sourceIndices,stage:w.stage},exact:{...exact,geometry:undefined},snapped:{ok:snapped.ok,...(snapped.ok?{area:geometryArea(snapped.geometry),polygons:snapped.geometry.length}:{error:snapped.error}),milliseconds:snapped.milliseconds},exactDifference:{ok:exactDifference.ok,...(exactDifference.ok?{area:geometryArea(exactDifference.geometry)}:{error:exactDifference.error}),milliseconds:exactDifference.milliseconds},snappedDifference:{ok:snappedDifference.ok,...(snappedDifference.ok?{area:geometryArea(snappedDifference.geometry)}:{error:snappedDifference.error}),milliseconds:snappedDifference.milliseconds},helper:{precisionRetries:clipped.precisionRetries,callbacks:callbacks.length,callbackBeforeRetry:callbacks.every(p=>p.status==='retrying'),sourcePieceIdentityPreserved:clipped.pieces.length===1&&clipped.pieces[0]===piece,stages:clipped.precisionRetryWitnesses.map(w=>w.stage),recoveredStatuses:clipped.precisionRetryWitnesses.map(w=>w.status),milliseconds:helperMilliseconds},geometry:{sourceArea,perimeter,minimumAltitude,outputArea,outputVertices,outputTriangles,minimumOutputTriangleArea:Number.isFinite(minimumOutputTriangleArea)?minimumOutputTriangleArea:null,allFinite,maxHeightInterpolationError,maxUvInterpolationError,maxOutputOutsideWeight,maxRecoveredIntersectionOutsideWeight,boundaryWeightTolerance,areaTolerance,areaPartitionError:snapped.ok?Math.abs(geometryArea(snapped.geometry)+outputArea-sourceArea):null,maxAxisDisplacementMetres:w.maxAxisDisplacementMetres},inputsUnchanged:JSON.stringify(w)===sourceBefore&&JSON.stringify({piece,mask})===before,peakResidentMemoryKiB:process.resourceUsage().maxRSS};
console.log(JSON.stringify(report));
