import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {prepareAddressSources,appendAddressPrefix,type AddressFileBinding,type AddressSourceAuthority} from './delivery-address-sources.ts';
import {inspectAddressTargets,type AddressPhysicalAuthority} from './delivery-address-physical.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './delivery-city-provenance.ts';
import {sourceSha256} from './source-files.ts';

/** The resolver imports package aliases. Bind their real source closures as
 * well as relative imports; a single resolver-file digest is insufficient. */
export function bindAddressProducer(){
  const require=createRequire(new URL('../../../apps/game/src/world/drop-in.ts',import.meta.url)),aliases=['sim','world-schema'].map(name=>{const entry=fileURLToPath(new URL(`../../../packages/${name}/src/index.ts`,import.meta.url)),manifest=fileURLToPath(new URL(`../../../packages/${name}/package.json`,import.meta.url));assert.equal(fs.realpathSync(require.resolve('@helsinki/'+name)),fs.realpathSync(entry),'Address runtime package alias resolves outside its bound source');return{name:'@helsinki/'+name,file:manifest,sha256:sourceSha256(fs.readFileSync(manifest)),entrySha256:sourceSha256(fs.readFileSync(entry))};});
  const bindings=['./delivery-city-addresses.ts','../../../packages/sim/src/index.ts','../../../packages/world-schema/src/index.ts'].map(file=>bindDeliveryProducer(new URL(file,import.meta.url))),runtimeFile=fileURLToPath(new URL('../../../apps/game/src/game.ts',import.meta.url)),runtimeSha256=sourceSha256(fs.readFileSync(runtimeFile));
  return{proof:{closures:bindings.map(publicDeliveryProducer),packageAliases:aliases.map(a=>({package:a.name,manifestSha256:a.sha256,entrySha256:a.entrySha256})),runtimePlacement:{file:'apps/game/src/game.ts',sha256:runtimeSha256}},verify:()=>{bindings.forEach(verifyDeliveryProducer);for(const a of aliases)assert.equal(sourceSha256(fs.readFileSync(a.file)),a.sha256,'Address package alias manifest changed');assert.equal(sourceSha256(fs.readFileSync(runtimeFile)),runtimeSha256,'Runtime address placement changed during qualification');}};
}
export function prepareAppendAddresses(input:AddressFileBinding,authority:AddressSourceAuthority){
  const producer=bindAddressProducer(),source=prepareAddressSources(input,authority);
  return{entries:source.entries,qualifyFinal:async(final:AddressPhysicalAuthority)=>{
    assert.deepEqual(final.gameplay.addresses,authority.acceptedGameplay.addresses,'Accepted address prefix changed before qualification');assert.deepEqual(final.gameplay.landmarks,authority.acceptedGameplay.landmarks,'Accepted landmarks changed before address qualification');
    source.verifyInputs();const physical=await inspectAddressTargets(source.entries,final);assert.equal(physical.proof.status,'PASS_FINAL_SERIALIZED_ADDRESS_TARGETS','Selected address failed final serialized HCOL qualification: '+physical.results.filter(r=>r.status!=='QUALIFIED').map(r=>r.label+': '+r.reason).join('; '));
    const gameplay=appendAddressPrefix(final.gameplay,source.entries),verifyInputs=()=>{source.verifyInputs();physical.verifyInputs();producer.verify();};verifyInputs();
    return{gameplay,proof:{schemaVersion:1,kind:'source-bound-additive-addresses',status:'PASS_SOURCE_AND_FINAL_SERIALIZED_ADDRESS_TARGETS_RUNTIME_PENDING',acceptedManifestSha256:authority.acceptedManifestSha256,acceptedAddressCount:authority.acceptedGameplay.addresses.length,appendedAddressCount:source.entries.length,acceptedAddressesLiteralPrefix:true,acceptedOtherGameplayPreserved:true,source:source.proof,physical:physical.proof,producer:producer.proof},verifyInputs};
  }};
}
