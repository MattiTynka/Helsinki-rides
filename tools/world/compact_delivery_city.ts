import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {compactDeliveryCity} from './lib/delivery-city-compaction.ts';
const{values:v}=parseArgs({options:Object.fromEntries(['world','manifest-sha256','live-world','live-manifest-sha256','out','release'].map(k=>[k,{type:'string' as const}]))});
const get=(k:string)=>{const value=v[k];assert.ok(typeof value==='string'&&value.length,`--${k} required`);return value;};
console.log(JSON.stringify(await compactDeliveryCity({world:get('world'),manifestSha256:get('manifest-sha256'),liveWorld:get('live-world'),liveManifestSha256:get('live-manifest-sha256'),out:get('out'),release:get('release')})));
