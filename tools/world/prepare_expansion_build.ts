import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {prepareExpansionBuild,prepareExpansionTerrain,prepareExpansionModel,prepareExpansionTrees,prepareExpansionDistantInputs,prepareExpansionDelivery} from './lib/expansion-build.ts';

const {values}=parseArgs({options:Object.fromEntries(['phase','scope','profile','region','sources','snapshot','accepted-world','accepted-coverage','accepted-source-terrain','tree-profile','tree-asset','conflict-review','converted-model','raw-terrain','out','job'].map(key=>[key,{type:'string' as const}]))});
const required=(key:string)=>{const value=values[key];assert.ok(typeof value==='string'&&value.length,`--${key} required`);return value;};
const phase=required('phase');
let result:unknown;
if(phase==='plan')result=prepareExpansionBuild({scope:required('scope'),profile:required('profile'),regionId:required('region'),sources:required('sources'),snapshot:required('snapshot'),acceptedWorld:required('accepted-world'),acceptedCoverage:required('accepted-coverage'),acceptedSourceTerrain:required('accepted-source-terrain'),treeProfile:required('tree-profile'),treeAsset:required('tree-asset'),out:required('out'),...(values['conflict-review']?{conflictReview:values['conflict-review']}: {}),...(values['converted-model']?{convertedModel:values['converted-model']}: {}),...(values['raw-terrain']?{rawTerrain:values['raw-terrain']}: {})});
else if(phase==='terrain')result=prepareExpansionTerrain(required('job'));
else if(phase==='model')result=prepareExpansionModel(required('job'));
else if(phase==='trees')result=prepareExpansionTrees(required('job'));
else if(phase==='distant-inputs')result=prepareExpansionDistantInputs(required('job'));
else if(phase==='delivery')result=await prepareExpansionDelivery(required('job'));
else throw new Error('Unknown preparation phase; expected plan, terrain, model, trees, distant-inputs or delivery');
console.log(JSON.stringify(result,null,2));
