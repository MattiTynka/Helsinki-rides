import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {projectPublicCitySurvey} from './lib/delivery-city-survey.ts';
import {deliverySha} from './lib/delivery-city-payloads.ts';
const{values}=parseArgs({options:Object.fromEntries(['source','expected','kind','out'].map(k=>[k,{type:'string' as const}]))});for(const key of['source','expected','kind','out'])assert.ok(values[key],`--${key} required`);assert.ok(values.kind==='street-parts'||values.kind==='footprints');assert.ok(!fs.existsSync(values.out!),'Public survey output must be fresh');const source=fs.readFileSync(values.source!);assert.equal(deliverySha(source),values.expected);const projected=projectPublicCitySurvey(JSON.parse(source.toString()),values.kind),bytes=Buffer.from(JSON.stringify(projected)+'\n');fs.mkdirSync(path.dirname(values.out!),{recursive:true});fs.writeFileSync(values.out!,bytes,{flag:'wx'});console.log(JSON.stringify({sourceSha256:values.expected,sha256:deliverySha(bytes),bytes:bytes.length,features:projected.features.length,kind:values.kind}));
