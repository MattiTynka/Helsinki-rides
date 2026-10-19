import {parseArgs} from 'node:util';
import {parseAppendRectangle} from './lib/append-city-cells.ts';
import {patchGroundRegion} from './lib/ground-region-patch.ts';
const{values}=parseArgs({options:Object.fromEntries(['cells','native-cache','native-metadata','region','out'].map(k=>[k,{type:'string' as const}]))});
for(const k of['cells','native-cache','native-metadata','region','out'])if(!values[k])throw new Error(`--${k} required`);
console.log(JSON.stringify(await patchGroundRegion({cells:values.cells!,nativeCache:values['native-cache']!,nativeMetadata:values['native-metadata']!,region:parseAppendRectangle(values.region!),out:values.out!})));
