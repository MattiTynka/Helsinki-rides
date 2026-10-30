// Original vector artwork from the independently checked architectural layout.
// Reference photographs inform appearance; none of their pixels are reproduced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';

export const bulevardi46Layout = {
  building:'BID_04b25160-160a-4bbe-9d61-2fc92e490655', vtj:'1030750310',
  lowerBayCount:15, upperWindowCount:30, entranceAxes:[1,7,9],
  widthMetres:55.365, heightMetres:15.677,
  qualification:'Visual count corroborated independently in the 2017 I99pema and 2011 Arkkipuudeli originals; proportions and masonry detail are authored approximations, not a measured elevation.',
  references:[
    'https://commons.wikimedia.org/wiki/File:Bulevardi_46,_Helsinki.jpg',
    'https://commons.wikimedia.org/wiki/File:Bulevardin_Mallasmakasiini.jpg',
  ],
} as const;

export function renderBulevardi46Svg():string {
  const W=1800,H=510,bay=W/15,parts:string[]=[];
  const rect=(x:number,y:number,w:number,h:number,fill:string,extra='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
  const arch=(x:number,y:number,w:number,h:number,r:number)=>`M${x},${y+h}V${y+r}Q${x+w/2},${y-r} ${x+w},${y+r}V${y+h}Z`;
  const window=(cx:number,y:number,w:number,h:number,arched:boolean,id:string)=>{
    const x=cx-w/2,r=arched?5:0,shape=arched?arch(x,y,w,h,r):`M${x},${y}h${w}v${h}h-${w}Z`;
    parts.push(`<g id="${id}"><path d="${shape}" fill="#283b38" stroke="#72857b" stroke-width="3"/>`);
    parts.push(`<path d="M${cx},${y+2}V${y+h-2}M${x+2},${y+h*.35}H${x+w-2}M${x+2},${y+h*.68}H${x+w-2}" fill="none" stroke="#819187" stroke-width="1.5"/>`);
    parts.push(`<path d="M${x+3},${y+3}h${w/2-5}v${h*.31}h-${w/2-5}Z" fill="#afc0bf" opacity=".55"/>`);
    if(arched)parts.push(`<path d="M${x+3},${y+7}L${x+w-3},${y+22}M${x+w-3},${y+7}L${x+3},${y+22}" fill="none" stroke="#819187" stroke-width="1.3"/>`);
    parts.push(rect(x-3,y+h+1,w+6,3,'#aaa899'));
    if(arched){
      parts.push(`<path d="M${x-5},${y+4}Q${cx},${y-10} ${x+w+5},${y+4}" fill="none" stroke="#b37455" stroke-width="6"/>`);
      for(let i=0;i<7;i++){const a=x-3+(w+6)*i/6;parts.push(`<path d="M${a},${y+3}l${(cx-a)*.12},-7" stroke="#70422f" stroke-width="1"/>`);}
    }
    parts.push('</g>');
  };
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><pattern id="brick" width="30" height="12" patternUnits="userSpaceOnUse"><rect width="30" height="12" fill="#925638"/><path d="M0,0H30M0,6H30M0,12H30M0,0V6M15,6V12M30,0V6" fill="none" stroke="#b28c70" stroke-width=".7"/><rect x="1" y="1" width="13" height="4" fill="#a16243" opacity=".35"/><rect x="17" y="7" width="11" height="4" fill="#72452f" opacity=".25"/></pattern></defs>`);
  parts.push(rect(0,0,W,H,'url(#brick)'));
  for(const y of [7,18,132,143,155,447,457]){
    parts.push(rect(0,y,W,3,'#69412f'),rect(0,y+3,W,2,'#b27a59'));
  }
  // Upper corbels and sill ornaments remain masonry, rather than extra openings.
  for(let x=6;x<W;x+=20)parts.push(rect(x,22,8,12,'#72432f'),rect(x+1,22,6,3,'#b67955'));
  parts.push(rect(0,35,W,5,'#a36646'),rect(0,38,W,2,'#68412f'));
  for(let i=0;i<15;i++){
    const cx=(i+.5)*bay,axis=i+1;
    parts.push(`<g id="bay-${axis}" data-axis="${axis}">`);
    window(cx-bay*.22,49,31,75,false,`top-${axis}-a`);
    window(cx+bay*.22,49,31,75,false,`top-${axis}-b`);
    for(const ox of [-bay*.22,bay*.22])for(let k=0;k<4;k++)parts.push(rect(cx+ox-13+k*8,128,4,7,'#75442e'));
    window(cx,170,29,38,true,`small-${axis}`);
    for(const ox of [-43,43]){
      parts.push(rect(cx+ox-3,199,6,16,'#473b30'));
      for(let y=202;y<214;y+=3)parts.push(rect(cx+ox-2,y,4,1,'#94816a'));
    }
    window(cx,242,31,63,true,`middle-${axis}`);
    window(cx,350,31,62,true,`lower-${axis}`);
    // Thin recessed brick pilasters divide the fifteen independently counted axes.
    if(i<14)parts.push(rect((i+1)*bay-1,164,2,280,'#73432f'));
    parts.push('</g>');
  }
  parts.push(rect(0,443,W,5,'#6a8b7d'),rect(0,448,W,3,'#43594f'));
  for(let x=4;x<W;x+=12)parts.push(rect(x,454,6,4,'#67432f'));
  parts.push(rect(0,492,W,18,'#a39a88'));
  for(let x=0;x<W;x+=44)parts.push(`<path d="M${x},493V510" stroke="#7d776a" stroke-width="1"/>`);
  for(let i=0;i<15;i++){
    const cx=(i+.5)*bay,axis=i+1;
    if(!bulevardi46Layout.entranceAxes.some(n=>n===axis))window(cx,470,18,28,true,`basement-${axis}`);
  }
  for(const axis of bulevardi46Layout.entranceAxes){
    const cx=(axis-.5)*bay,doorW=30,y=450,h=60;
    parts.push(`<g id="entrance-${axis}" data-entrance-axis="${axis}">`);
    parts.push(rect(cx-doorW/2-3,y-1,doorW+6,h+1,'#b1a18a'));
    parts.push(rect(cx-doorW/2,y,doorW,h,axis===1?'#3e5c4a':'#75543a'));
    for(const ox of [-7.5,7.5]){
      parts.push(rect(cx+ox-5,y+4,10,33,'#31453c'));
      parts.push(`<path d="M${cx+ox-4},${y+5}l8,29m0,-29l-8,29M${cx+ox-4},${y+41}l8,12m0,-12l-8,12" stroke="#819080" stroke-width="1.3" fill="none"/>`);
    }
    parts.push(`<path d="M${cx},${y}V510" stroke="#b4a183" stroke-width="1"/>`);
    // Shallow sheet-metal canopies and their paired curved support/lamps.
    parts.push(`<path d="M${cx-31},445L${cx-23},439H${cx+23}L${cx+31},445L${cx+21},448H${cx-23}Z" fill="#3f5049" stroke="#253c35" stroke-width="1.3"/>`);
    for(const side of [-1,1])parts.push(`<path d="M${cx+side*24},441q${side*8},-15 ${side*10},-3v8" fill="none" stroke="#3b453f" stroke-width="1.8"/>`);
    parts.push('</g>');
  }
  // Five gutter groups are visible in the references; locations are appearance approximations.
  for(const x of [3,bay*3,bay*6,bay*9,bay*12,W-3])parts.push(`<path d="M${x},0v145l-4,9v285l4,8v63" fill="none" stroke="#3e4840" stroke-width="3"/><path d="M${x-1},0v142" stroke="#819080" stroke-width=".7"/>`);
  parts.push('</svg>');return parts.join('');
}

export async function authorBulevardi46(out:string){
  assert.ok(!fs.existsSync(out),'Fresh original-art output required');
  const svg=renderBulevardi46Svg(),png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9}).toBuffer();
  const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
  const receipt={schemaVersion:1,status:'AUTHORED_APPEARANCE_PENDING_COMPRESSED_GAME_REVIEW',...bulevardi46Layout,
    art:{license:'CC0-1.0',referencePixelsCopied:false,svgSha256:sha(svg),pngSha256:sha(png),width:1800,height:510},
    limitations:['Original vector approximation of the corroborated facade arrangement; brick dimensions, glazing reflections, door panels, drainpipe offsets and ornament profiles are authored detail.','Only the two municipal front triangles are targeted; roof, returns, ground, collision and separate trees remain preserved.']};
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'front-v1.svg'),svg,{flag:'wx'});fs.writeFileSync(path.join(out,'front-v1.png'),png,{flag:'wx'});fs.writeFileSync(path.join(out,'layout.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const{values}=parseArgs({options:{out:{type:'string'}}});assert.ok(values.out,'--out required');console.log(JSON.stringify(await authorBulevardi46(values.out)));
}
