import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTerrain, encodeTerrain } from '../../packages/world-schema/src/index.ts';
import { pointInPolygon, ringDistance, type Pt } from './lib/geometry.ts';

const {values}=parseArgs({options:{terrain:{type:'string'},placement:{type:'string'},out:{type:'string'}}});
if(!values.terrain||!values.placement||!values.out)throw new Error('--terrain --placement --out required');
if(existsSync(values.out))throw new Error('output already exists');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const meta=JSON.parse(readFileSync(path.join(values.terrain,'terrain.json'),'utf8'));
const source=readFileSync(path.join(values.terrain,meta.file));
if(sha(source)!==meta.sha256)throw new Error('terrain hash mismatch');
const placement=JSON.parse(readFileSync(values.placement,'utf8'));
if(placement.originId!==meta.originId)throw new Error('origin mismatch');
const grid=parseTerrain(source),ring=placement.placement.footprintRuntimeXZ as Pt[],target=Number(placement.placement.groundY);
if(!Number.isFinite(target)||ring.length<3)throw new Error('invalid monument placement');
let changed=0,maxCorrection=0;
for(let z=0;z<grid.nz;z++)for(let x=0;x<grid.nx;x++){
  const p:Pt=[grid.x0+x*grid.resolution,grid.z0+z*grid.resolution];
  const d=pointInPolygon(p,[ring])?0:ringDistance(p,ring);
  if(d>=1)continue;
  const blend=1-d*d*(3-2*d),i=z*grid.nx+x,before=grid.heights[i]!;
  grid.heights[i]=before+(target-before)*blend;
  if(grid.heights[i]!==before){changed++;maxCorrection=Math.max(maxCorrection,Math.abs(grid.heights[i]!-before));}
}
mkdirSync(values.out,{recursive:true});const bytes=encodeTerrain(grid);
writeFileSync(path.join(values.out,meta.file),bytes);
writeFileSync(path.join(values.out,'terrain.json'),JSON.stringify({...meta,bytes:bytes.byteLength,sha256:sha(bytes),authoredMonumentGround:{placement:values.placement,placementSha256:sha(readFileSync(values.placement)),sourceTerrainSha256:sha(source),changedGridPoints:changed,maxCorrection,featherMetres:1,groundY:target}},null,1)+'\n');
console.log(JSON.stringify({changedGridPoints:changed,maxCorrection,groundY:target}));
