import assert from'node:assert/strict';
import{deliverySha}from'./delivery-city-payloads.ts';import{readDeliveryFile}from'./delivery-city.ts';import{readKtx2Layout,dropTopMip,assertSameLevels}from'./ktx2-mips.ts';
export function nativeFacadeMipReduction(root:string,row:any){
 const encoded=readDeliveryFile(root,row.texture),oldLow=readDeliveryFile(root,row.low);assertSameLevels(encoded,oldLow);const layout=readKtx2Layout(encoded);assert.deepEqual([layout.width,layout.height],[row.width,row.height]);
 if(layout.width<256||layout.height<256)return null;const low=dropTopMip(oldLow);assertSameLevels(oldLow,low);const next={width:Math.floor(row.width/2),height:Math.floor(row.height/2),texture:{path:'textures/'+deliverySha(oldLow)+'.ktx2',bytes:oldLow.length,sha256:deliverySha(oldLow)},low:{path:'textures-m1/'+deliverySha(low)+'.ktx2',bytes:low.length,sha256:deliverySha(low),source:'textures/'+deliverySha(oldLow)+'.ktx2'}};
 const charts=row.rectification.chartsLedger??[],density=charts.length?Math.min(...charts.map((c:any)=>Math.min((c.placement.w-1)/(c.bounds[2]-c.bounds[0]),(c.placement.h-1)/(c.bounds[3]-c.bounds[1])))):row.rectification.texelsPerMetre;
 return{next,encoded:oldLow,low,minimumPhysicalTexelsPerMetre:density,minimumReducedPhysicalTexelsPerMetre:density/2,retainedEncodedLevelsLiteral:true};
}
export function facadeCacheTextureBytes(rows:readonly any[]){const refs=new Map<string,{bytes:number;sha256:string}>();for(const row of rows)for(const ref of[row.texture,row.low]){const old=refs.get(ref.path);if(old)assert.deepEqual(old,{bytes:ref.bytes,sha256:ref.sha256});else refs.set(ref.path,{bytes:ref.bytes,sha256:ref.sha256});}return[...refs.values()].reduce((s,r)=>s+r.bytes,0);}
