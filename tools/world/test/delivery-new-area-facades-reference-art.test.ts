import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {OriginalWallArt} from '../author_senate_facade_charts.ts';
import {readReferenceFacadeArt,renderReferenceFacade,type ReferenceFacadeArt} from '../lib/delivery-new-area-facades-reference-art.ts';
const plan:ReferenceFacadeArt={wallColour:'#d8c79e',groundColour:'#66615b',surroundColour:'#aca595',frameColour:'#665846',glassColour:'#667975',groundHeight:3.5,
  rows:[{bottom:4,height:2,width:1.2,axes:[2,5,8],header:'triangle'}],groundOpenings:[{x:5,bottom:.2,width:1.4,height:2.8,kind:'door'}],
  bands:[{from:'top',offset:-.3,height:.15,colour:'#b1a999'}],rustication:null};
test('Observed art plans reject SVG injection and openings beyond the exact native elevation',async()=>{
  assert.throws(()=>readReferenceFacadeArt({...plan,svg:'<image href="https://example.invalid/">'}),/Unexpected or missing/);
  assert.throws(()=>readReferenceFacadeArt({...plan,wallColour:'#fff" onload="alert(1)'}),/literal RGB/);
  assert.throws(()=>renderReferenceFacade(new OriginalWallArt(10,0,8),2,{...plan,rows:[{...plan.rows[0]!,bottom:6}]}),/above selected native wall/);
  assert.throws(()=>renderReferenceFacade(new OriginalWallArt(10,0,12),2,{...plan,rows:[{...plan.rows[0]!,axes:[10]}]}),/extends past this exact elevation/);
  for(const header of ['flat','triangle','arch']as const){const wall=new OriginalWallArt(10,0,12);renderReferenceFacade(wall,2,{...plan,rows:[{...plan.rows[0]!,header}]});
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${wall.svg([2,2,508,508])}</svg>`;
    assert.doesNotMatch(svg,/NaN|Infinity|<image|href=/);assert.equal((await sharp(Buffer.from(svg)).png().toBuffer({resolveWithObject:true})).info.width,512);
  }
});
