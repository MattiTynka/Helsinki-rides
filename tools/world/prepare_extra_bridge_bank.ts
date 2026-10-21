// Replay a bounded, explicitly named source-buffer bank from cached municipal
// quantized terrain. This writes authoring evidence, never a released world.
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {prepareExtraBridgeSourceBank} from './lib/delivery-extra-bridges-bank.ts';
const{values}=parseArgs({options:{terrain:{type:'string'},'expected-terrain-index':{type:'string'},'source-root':{type:'string',default:'.'},'street-parts':{type:'string'},'expected-street-parts':{type:'string'},parts:{type:'string'},bounds:{type:'string'},out:{type:'string'}}});
for(const name of['terrain','expected-terrain-index','street-parts','expected-street-parts','parts','bounds','out']as const)assert.ok(values[name],`--${name} required`);
const ids=values.parts!.split(',').map(Number),b=values.bounds!.split(',').map(Number);assert.ok(ids.length&&ids.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(ids).size===ids.length);assert.ok(b.length===4&&b.every(Number.isFinite)&&b[0]!<b[2]!&&b[1]!<b[3]!);
console.log(JSON.stringify(prepareExtraBridgeSourceBank({terrainDirectory:values.terrain!,expectedTerrainIndexSha256:values['expected-terrain-index']!,sourceRoot:values['source-root']!,streetParts:{path:values['street-parts']!,sha256:values['expected-street-parts']!},partIds:ids,area:{minX:b[0]!,minZ:b[1]!,maxX:b[2]!,maxZ:b[3]!},out:values.out!})));
