import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {applyInlandWaterSeparation} from './lib/delivery-inland-water-apply.ts';
const {values:v}=parseArgs({options:Object.fromEntries(['world','manifest-sha256','profile','profile-sha256','osm','precache-receipt','postcache-metadata','source-root','out','release'].map(name=>[name,{type:'string' as const}]))});
for(const name of['world','manifest-sha256','profile','profile-sha256','osm','precache-receipt','postcache-metadata','source-root','out','release'])assert.ok(v[name],`--${name} required`);
console.log(JSON.stringify(await applyInlandWaterSeparation({world:v.world!,manifestSha256:v['manifest-sha256']!,profile:v.profile!,profileSha256:v['profile-sha256']!,osm:v.osm!,precacheReceipt:v['precache-receipt']!,postcacheMetadata:v['postcache-metadata']!,sourceRoot:v['source-root']!,out:v.out!,release:v.release!}),null,2));
