/** Seven reviewed new placements inside a precise municipal lake. This only
 * qualifies the source identity; the ordinary complete unsupported-root and
 * actual visible-water proof still decides whether omission is permissible. */
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import type {LocalPolygon, Ring} from './geometry.ts';
import type {TreeBarkModel} from './tree-bark-registration.ts';
import {registrationSha256 as sha,type RegistrationTree} from './tree-ground-registration.ts';

const sourceFileSha256='bd3828f66f110164ab3c78ac743f5b4c7ea2de687f4099ea45e587d39767d234';
const lakeId='Maavesi_muut_vesialueet.1631';
const lakeSha256='12e4a88b96870208f52119719ff7c3de4e3005cd388caf97168b53d0343cfc03';
const barkSha256='3349636ed04775d442be808816d9170446994f9cec69d015d6dd2130fd639a03';
const reviewedIdentities=new Map([
 ['TREE_SUMMER_c15def91-0cbd-4de2-8ec5-084f1f2099d4','ec606667e66dba388f79c00699891ae6c4dfc23fa82df231f5630bc3691e0cf3'],
 ['TREE_SUMMER_0a197ba3-6fee-4a89-b613-370861e00487','567a397930640e6693a4742a88f181f8cbceea4b071ae1428117d1b3fba5fc74'],
 ['TREE_SUMMER_0f8ba45e-6dab-4374-b5ac-e728fc32da74','11860cad8499bd5f3bb42a12463bc56238328c6c20c57120baf0cecd39c30a9d'],
 ['TREE_SUMMER_5b6a8dbc-605f-4e63-9dd9-90330349cf3f','5b147bba694224af0edf6c1c98397cb0d741d698dcab5b9fce81f64bf56d107c'],
 ['TREE_SUMMER_638eb035-afcf-46ed-b6f3-6133e77cad66','11f044f44a1a58ca8f3af30fa61e330d9c72e09ff75c43f2028b1310ede6e60e'],
 ['TREE_SUMMER_66eddfc5-b9e5-4924-81f4-b9ce6debb56e','920244c1c0bedbb320c5de5ea8c8ba2f6498ffc6ca7e8eab41eacc3874a0d89e'],
 ['TREE_SUMMER_aaaffd3f-436a-4879-8940-746f45ab71a6','5f04569c06b339d7fb6a3e483db03db5ef97f3d056b168f0e958fad1a479b7a6'],
]);
export interface PreciseLakeTreeBinding {
 kind:'reviewed-precise-lake-source';path:string;sha256:string;featureId:string;featureSha256:string;barkModelSha256:string;
 retainedWaterReport:{path:string;sha256:string};
}
export interface PreciseLakeWaterClassification {
 sha256:string;report:{nativeShore:{profileSha256:string;preciseMunicipalWaterSha256:string};nativeMetadataSha256:string;coastal:{mask:{water:readonly LocalPolygon[]}}};
}
export function qualifyPreciseLakeWaterMask(binding:PreciseLakeTreeBinding,classification:PreciseLakeWaterClassification,water:readonly LocalPolygon[]){
 const expected='b12184d66b27f70c6ed388aa2037b611e245612ac474fbaa8cb87e3a6a4bdfa9';
 assert.equal(binding.retainedWaterReport.sha256,expected);assert.equal(classification.sha256,expected,'Reviewed retained-water classification changed');
 assert.equal(classification.report.nativeShore.profileSha256,'772a9c509fe3a40b67dd5bda04fafb9d72654aa228663d7861ccac7d5648596f');
 assert.equal(classification.report.nativeShore.preciseMunicipalWaterSha256,sourceFileSha256);
 assert.equal(classification.report.nativeMetadataSha256,'38442ad1254e59fa21b99d1adf3d750a1f65065f9407139bbab38c8625dd3c56');
 assert.deepEqual(water,classification.report.coastal.mask.water,'Planning water union differs from the exact source-derived retained-water classification');
}
const area=(geometry:ReturnType<typeof polygonClipping.intersection>)=>geometry.reduce((sum,p)=>sum+p.reduce((a,r,i)=>a+(i?-1:1)*Math.abs(r.reduce((n,v,j)=>n+v[0]*r[(j+1)%r.length]![1]-r[(j+1)%r.length]![0]*v[1],0)/2),0),0);
/** Independent precise-water authority shared by the separately reviewed retain
 * and complete-water omission cases. This grants neither decision on its own. */
export function qualifyPreciseLakeAuthority(model:TreeBarkModel,binding:PreciseLakeTreeBinding,source:{sha256:string;polygons:readonly LocalPolygon[]}) {
 assert.equal(binding.kind,'reviewed-precise-lake-source');assert.equal(binding.barkModelSha256,barkSha256);assert.equal(sha(JSON.stringify(model)),barkSha256,'Actual bark model changed');
 assert.equal(binding.sha256,sourceFileSha256);assert.equal(source.sha256,sourceFileSha256,'Precise municipal source bytes changed');
 assert.equal(binding.featureId,lakeId);assert.equal(binding.featureSha256,lakeSha256);
 const actual=source.polygons.filter(p=>p.id===lakeId);assert.equal(actual.length,1,'Precise lake source must be unambiguous');const lake=actual[0]!;
 assert.equal(sha(JSON.stringify(lake)),lakeSha256,'Precise municipal lake shape or classification changed');
 assert.equal(lake.properties['tyyppi'],'Manner_vesialue');assert.equal(lake.properties['datanomistaja'],'Helsinki/Kami');return lake;
}
export function qualifyPreciseLakeTreeSource(tree:RegistrationTree,model:TreeBarkModel,binding:PreciseLakeTreeBinding,
 source:{sha256:string;polygons:readonly LocalPolygon[]},root:readonly [number,number][]){
 assert.equal(binding.kind,'reviewed-precise-lake-source');
 const expected=reviewedIdentities.get(tree.id);assert.ok(expected,'Precise lake review is restricted to seven individually measured new placements');
 assert.equal(sha(JSON.stringify({id:tree.id,position:tree.position,model:tree.model,scale:tree.scale,yaw:tree.yaw})),expected,'Reviewed lake placement changed');
 assert.equal(tree.model,'tree-birch');const lake=qualifyPreciseLakeAuthority(model,binding,source);
 const[x,,z]=tree.position,c=Math.cos(tree.yaw),s=Math.sin(tree.yaw),actualRoot=model.root.map(([u,,v])=>[x+c*u*tree.scale[0]+s*v*tree.scale[2],z-s*u*tree.scale[0]+c*v*tree.scale[2]]);
 assert.deepEqual(root,actualRoot,'Lake review requires the actual full woody root ring');assert.ok(root.length>=3);
 const ring:Ring=root.map(([u,v])=>[u,-v]);ring.push([...ring[0]!] as[number,number]);
 assert.ok(area(polygonClipping.difference([ring],lake.rings))<=1e-8,'A partial dry-bank root cannot use the complete-lake source review');
 return lake;
}
