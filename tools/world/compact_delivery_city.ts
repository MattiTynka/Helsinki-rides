import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {compactDeliveryCity} from './lib/delivery-city-compaction.ts';
const{values:v}=parseArgs({options:Object.fromEntries(['world','manifest-sha256','live-world','live-manifest-sha256','out','release','delivery-mode','world-budget-bytes'].map(k=>[k,{type:'string' as const}]))});
const get=(k:string)=>{const value=v[k];assert.ok(typeof value==='string'&&value.length,`--${k} required`);return value;};
const mode=v['delivery-mode']??'pages';assert.ok(mode==='pages'||mode==='external','--delivery-mode must be pages or external');
assert.ok(mode==='external'||v['world-budget-bytes']===undefined,'Pages budget cannot be overridden');
const delivery=mode==='external'?{mode:'external' as const,worldBudgetBytes:Number(get('world-budget-bytes'))}:{mode:'pages' as const};
console.log(JSON.stringify(await compactDeliveryCity({world:get('world'),manifestSha256:get('manifest-sha256'),liveWorld:get('live-world'),liveManifestSha256:get('live-manifest-sha256'),out:get('out'),release:get('release'),delivery})));
