import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {projectPublicCityOsm} from './lib/delivery-city-osm.ts';
import {deliverySha} from './lib/delivery-city-payloads.ts';
const{values}=parseArgs({options:Object.fromEntries(['source','expected','out'].map(k=>[k,{type:'string' as const}]))});
for(const key of['source','expected','out'])assert.ok(values[key],`--${key} required`);
assert.ok(!fs.existsSync(values.out!),'Public OSM output must be fresh');const sourceBytes=fs.readFileSync(values.source!);assert.equal(deliverySha(sourceBytes),values.expected,'Source OSM snapshot changed');const projected=projectPublicCityOsm(JSON.parse(sourceBytes.toString())),bytes=Buffer.from(JSON.stringify(projected)+'\n');fs.mkdirSync(path.dirname(values.out!),{recursive:true});fs.writeFileSync(values.out!,bytes,{flag:'wx'});console.log(JSON.stringify({sha256:deliverySha(bytes),bytes:bytes.length,elements:projected.elements.length,sourceSha256:values.expected}));
