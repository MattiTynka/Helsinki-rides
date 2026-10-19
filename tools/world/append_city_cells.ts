import {parseArgs} from 'node:util';
import {appendCityCells,parseAppendRectangle} from './lib/append-city-cells.ts';
const{values}=parseArgs({options:Object.fromEntries(['base-cells','append-cells','region','source-terrain','runtime-terrain','config','out','frontier-repair'].map(k=>[k,{type:'string' as const}]))});
for(const key of['base-cells','append-cells','region','source-terrain','runtime-terrain','config','out'])if(!values[key])throw new Error(`--${key} is required`);
const r=appendCityCells({baseCells:values['base-cells']!,appendCells:values['append-cells']!,region:parseAppendRectangle(values.region!),sourceTerrain:values['source-terrain']!,runtimeTerrain:values['runtime-terrain']!,config:values.config!,out:values.out!,frontierRepair:values['frontier-repair']});
console.log(JSON.stringify({status:r.status,cells:r.cells,unchanged:r.unchanged,appended:r.appended,added:r.added}));
if(r.status.startsWith('FAIL'))process.exitCode=1;
