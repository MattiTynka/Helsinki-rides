import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groundTriangleLine,groundLineEnvelope,measuredGroundAt,warpGroundedFacade} from '../lib/bulevardi46-ground-chart.ts';
import {externalizeAppendedFacadeChart} from '../lib/delivery-chart-external.ts';
import {GlbBuilder,flatNormals,encodeKtx2} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {packGlb,externalizeCellImages} from '../lib/shared-textures.ts';
import {applyFacadeChartsToGlb,readFacadeChartTriangles} from '../lib/facade-chart-glb.ts';
import {rebindDeliveryFacadeFaces} from '../apply_delivery_facade_charts.ts';
import {facadeChartSha256 as sha,facadeTriangleKey,type FacadeChart,type FacadeTriangle} from '../lib/facade-charts.ts';
import {assertSameLevels,readKtx2Layout} from '../lib/ktx2-mips.ts';

const chart:FacadeChart={id:'front',building:'new',origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,1,0],bounds:[0,0,2,10],pixels:[1,1,1022,288],planeToleranceMetres:.001};
test('native ground-line envelope retains a slope and sheet crossing, rejecting real uncovered gaps and downward faces',()=>{
 const slope:FacadeTriangle=[[0,1,0],[0,1,1],[2,3,0]],piece=groundTriangleLine(slope,chart,.25,'native');assert.ok(piece);assert.ok(Math.abs(piece.fromY-1)<1e-12&&Math.abs(piece.toY-2.5)<1e-12);assert.equal(groundTriangleLine([slope[0],slope[2],slope[1]],chart,.25,'reversed'),null);
 const p=groundLineEnvelope([{from:0,to:2,fromY:1,toY:3,witness:'slope'},{from:0,to:2,fromY:2,toY:2,witness:'platform'}],0,2);assert.equal(p.length,2);assert.equal(measuredGroundAt(p,.5),2);assert.equal(measuredGroundAt(p,1.5),2.5);
 assert.throws(()=>groundLineEnvelope([{from:0,to:.9,fromY:1,toY:1,witness:'left'},{from:.90001,to:2,fromY:1,toY:1,witness:'right'}],0,2),/Uncovered native ground/);
});
test('grounded artwork preserves cornice, lifts the bottom by measured u and replicates gutters',()=>{
 const data=new Uint8Array(2*11*4);for(let y=0;y<11;y++)for(let x=0;x<2;x++){data[(y*2+x)*4]=y*20;data[(y*2+x)*4+3]=255;}
 const p=[{from:0,to:2,fromY:2,toY:4,witness:'actual'}],small={...chart,pixels:[1,1,3,11]as const},out=warpGroundedFacade({data,width:2,height:11},small,p,5,13),red=(x:number,y:number)=>out[(y*5+x)*4];
 assert.equal(red(1,1),0);assert.equal(red(3,1),0);assert.equal(red(1,9),200);assert.equal(red(3,7),200);assert.equal(red(1,5),100);assert.equal(red(0,5),red(1,5));assert.equal(red(4,5),red(3,5));assert.equal(red(2,12),red(2,11));
 assert.throws(()=>warpGroundedFacade({data,width:2,height:11},small,[{from:0,to:2,fromY:-1,toY:0,witness:'below wall'}],5,13),/outside this facade/);
});

test('new chart externalization preserves original BIN/images/geometry, removes only new duplicate bytes and wires exact Low mip',async()=>{
 const A:FacadeTriangle=[[0,0,0],[2,0,0],[2,10,0]],B:FacadeTriangle=[[0,0,0],[2,10,0],[0,10,0]],C:FacadeTriangle=[[3,0,0],[4,0,0],[4,2,0]],builder=new GlbBuilder('test'),P=Float32Array.from([...A.flat(),...B.flat(),...C.flat()]),I=Uint32Array.from({length:9},(_,i)=>i);
 await builder.addMesh({name:'owner',positions:P,indices:I,normals:flatNormals(P,I),uvs:new Float32Array(18).fill(.5),materialName:'old'},{name:'old',unlit:true,textureKind:'facade',texture:{width:8,height:8,data:new Uint8Array(8*8*4).fill(255)}});
 const external=externalizeCellImages(await builder.toGlb('test',{},'exact')),before=external.bytes,images=new Map(external.images.map(i=>['../'+i.path,i.bytes])),faces=[A,B].map(t=>({key:facadeTriangleKey(t),chart:'front'})),targets=await rebindDeliveryFacadeFaces(before,images,faces,[chart]);
 const encoded=await encodeKtx2({width:1024,height:512,data:new Uint8Array(1024*512*4).fill(255)},'facade'),options={expectedSha256:sha(before),charts:[chart],targets,externalImages:images,atlas:{name:'front',image:encoded,mimeType:'image/ktx2' as const,width:1024,height:512},maximumFallbackBytes:6*1024*1024,material:{name:'front',unlit:true,roughness:.95,doubleSided:false},extras:{original:true}},changed=await applyFacadeChartsToGlb(before,options),result=externalizeAppendedFacadeChart(before,changed.bytes);
 const invalid=await encodeKtx2({width:16,height:10,data:new Uint8Array(16*10*4).fill(255)},'facade');
 await assert.rejects(applyFacadeChartsToGlb(before,{...options,atlas:{...options.atlas,image:invalid,width:16,height:10}}),/multiples of four for GPU upload/);
 images.set('../'+result.standard.path,result.standard.bytes);assert.deepEqual(result.standard.bytes,encoded);assertSameLevels(result.standard.bytes,result.low.bytes);assert.equal(readKtx2Layout(result.low.bytes).width,512);
 const a=readFacadeGlb(before),b=readFacadeGlb(result.bytes);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);assert.deepEqual(b.json.images!.slice(0,a.json.images!.length),a.json.images);assert.equal(readFacadeGlb(changed.bytes).bin.length-b.bin.length,result.removedDuplicateBytes);assert.ok(result.removedDuplicateBytes>=encoded.length);
 assert.deepEqual((await readFacadeChartTriangles(before,images)).map(t=>t.key).sort(),(await readFacadeChartTriangles(result.bytes,images)).map(t=>t.key).sort());
 const bad=readFacadeGlb(changed.bytes);bad.bin=Uint8Array.from(bad.bin);bad.bin[0]=bad.bin[0]!^1;assert.throws(()=>externalizeAppendedFacadeChart(before,packGlb(bad.json,bad.bin)),/Original BIN prefix/);
 await assert.rejects(rebindDeliveryFacadeFaces(before,images,[{key:facadeTriangleKey([A[0],A[2],A[1]]),chart:'front'}],[chart]),/absent or changed/);
});
