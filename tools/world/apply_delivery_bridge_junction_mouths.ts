import assert from 'node:assert/strict';import{parseArgs}from'node:util';
import{applyDeliveryBridgeJunctionMouths}from'./lib/delivery-bridge-junction-apply.ts';
const{values}=parseArgs({options:{world:{type:'string'},'expected-manifest':{type:'string'},profile:{type:'string'},'profile-sha256':{type:'string'},'source-root':{type:'string',default:'.'},out:{type:'string'},release:{type:'string'}}});
for(const name of['world','expected-manifest','profile','profile-sha256','out','release']as const)assert.ok(values[name],`--${name} required`);
console.log(JSON.stringify(await applyDeliveryBridgeJunctionMouths({world:values.world!,expectedManifestSha256:values['expected-manifest']!,profileFile:values.profile!,expectedProfileSha256:values['profile-sha256']!,sourceRoot:values['source-root']!,out:values.out!,release:values.release!})));
