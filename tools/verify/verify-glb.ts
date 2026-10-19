// Offline acceptance of the hero assets against their contracts (content/assets/*.contract.json): node names,
// sockets, axes, budgets, skeleton and clips are read from the exported bytes, and Khronos glTF-Validator runs on
// each file. Exit 1 on any failed check.
//   node tools/verify/verify-glb.ts --character data/work/m0/blender-character --car data/work/m0/blender-car --out data/evidence/NEW_DIR
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { parseGlb, worldMatrices as worldMatricesOf, transformPoint, triangleCount as triangleCountOf, type Glb } from './glb.ts';
import { checkCharacter, type CharacterContract } from './lib/character-contract.ts';

const worldMatrices = (glb: Glb) => worldMatricesOf(glb.json);
const triangleCount = (glb: Glb) => triangleCountOf(glb.json);

const { values } = parseArgs({ options: { character: { type: 'string' }, car: { type: 'string' }, out: { type: 'string' } } });
if (!values.character || !values.car || !values.out) throw new Error('--character, --car and --out are required');
const OUT = values.out;
if (existsSync(OUT)) throw new Error(`${OUT} exists; evidence directories are never overwritten`);
mkdirSync(OUT, { recursive: true });

interface Check { id: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (id: string, pass: boolean, detail: string) => { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const validator = await import('gltf-validator');

const charContractPath = 'content/assets/character.contract.json';
const charContract = JSON.parse(readFileSync(charContractPath, 'utf8')) as CharacterContract;
const carContract = JSON.parse(readFileSync('content/assets/vehicle-lumi-gt.contract.json', 'utf8')) as { nodes: { root: string; body: string; wheels: string[] }; sockets: { node: string }[]; expectedDimensions: Record<string, [number, number]>; budgets: { triangles: number; materials: number; fileBytes: number }; variants: { id: string; file: string }[] };
const identity = (file: string) => ({ file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
const characterBindings: { asset: ReturnType<typeof identity>; contract: ReturnType<typeof identity> }[] = [];
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

async function validate(file: string, bytes: Uint8Array): Promise<void> {
  const r = await validator.validateBytes(bytes, { maxIssues: 50 });
  check(`${path.basename(file)}:validator`, r.issues.numErrors === 0, `${r.issues.numErrors} errors, ${r.issues.numWarnings} warnings${r.issues.numErrors ? ': ' + r.issues.messages.filter(m => m.severity === 0).map(m => m.code).join(', ') : ''}`);
}

function nodeByName(glb: Glb, name: string): number { return (glb.json.nodes ?? []).findIndex(n => n.name === name); }

// ---- characters ----
for (const variant of charContract.variants ?? []) {
  const file = path.join(values.character, `${variant.id}.glb`);
  const bytes = new Uint8Array(readFileSync(file));
  await validate(file, bytes);
  const contractPath = variant.contract ?? charContractPath;
  const contract = variant.contract ? JSON.parse(readFileSync(contractPath, 'utf8')) as CharacterContract : charContract;
  characterBindings.push({ asset: identity(file), contract: identity(contractPath) });
  const document = await io.readBinary(bytes);
  for (const result of await checkCharacter(document, contract, variant.role, bytes.byteLength)) check(`${variant.id}:${result.id}`, result.pass, result.detail);
}

// ---- pistol ----
{
  const file = path.join(values.character, 'prop-pistol.glb');
  const bytes = new Uint8Array(readFileSync(file));
  const glb = parseGlb(bytes);
  await validate(file, bytes);
  const acc = glb.json.accessors![glb.json.meshes![0]!.primitives[0]!.attributes['POSITION']!]!;
  const len = (acc.max as number[])[2]! - (acc.min as number[])[2]!;
  check('prop-pistol:length', Math.abs(len - 0.19) < 0.03 && triangleCount(glb) <= 600, `${len.toFixed(3)} m along +Z, ${triangleCount(glb)} triangles`);
}

// ---- cars ----
for (const variant of carContract.variants) {
  const file = path.join(values.car, variant.file);
  const bytes = new Uint8Array(readFileSync(file));
  const glb = parseGlb(bytes);
  await validate(file, bytes);
  const tris = triangleCount(glb);
  check(`${variant.id}:triangles`, tris <= carContract.budgets.triangles, `${tris} (budget ${carContract.budgets.triangles})`);
  check(`${variant.id}:materials`, (glb.json.materials ?? []).length <= carContract.budgets.materials, `${(glb.json.materials ?? []).length} (budget ${carContract.budgets.materials})`);
  check(`${variant.id}:bytes`, bytes.byteLength <= carContract.budgets.fileBytes, `${bytes.byteLength} (budget ${carContract.budgets.fileBytes})`);
  const mats = worldMatrices(glb);
  const required = [carContract.nodes.root, carContract.nodes.body, ...carContract.nodes.wheels, ...carContract.sockets.map(s => s.node)];
  const missing = required.filter(n => nodeByName(glb, n) < 0);
  check(`${variant.id}:nodes`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${required.length} required nodes present`);
  const wheel = (name: string) => { const i = nodeByName(glb, name); const m = i >= 0 ? mats.get(i) : undefined; return m ? transformPoint(m, [0, 0, 0]) : null; };
  const fl = wheel('WHEEL_FL'), fr = wheel('WHEEL_FR'), rl = wheel('WHEEL_RL');
  if (fl && fr && rl) {
    const wheelbase = fl[2] - rl[2], track = fl[0] - fr[0];
    const d = carContract.expectedDimensions;
    check(`${variant.id}:wheelbase`, wheelbase >= d['wheelbaseM']![0] && wheelbase <= d['wheelbaseM']![1], `${wheelbase.toFixed(3)} m`);
    check(`${variant.id}:axes`, fl[0] > 0 && fl[2] > 0 && Math.abs(fl[1] - 0.342) < 0.05 && track > 1.4, `FL at ${fl.map(x => x.toFixed(3)).join(',')} (+X left, +Z forward, hub at wheel radius)`);
  }
  const bodyIdx = nodeByName(glb, carContract.nodes.body);
  const body = glb.json.meshes![glb.json.nodes![bodyIdx]!.mesh!]!;
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of body.primitives) { const acc = glb.json.accessors![p.attributes['POSITION']!]!; min = min.map((v, i) => Math.min(v, (acc.min as number[])[i]!)); max = max.map((v, i) => Math.max(v, (acc.max as number[])[i]!)); }
  const length = max[2]! - min[2]!, width = max[0]! - min[0]!, height = max[1]!;
  const d = carContract.expectedDimensions;
  check(`${variant.id}:dimensions`, length >= d['lengthM']![0] && length <= d['lengthM']![1] && width >= d['widthM']![0] && width <= d['widthM']![1] && height >= d['heightM']![0] && height <= d['heightM']![1], `${length.toFixed(2)} × ${width.toFixed(2)} × ${height.toFixed(2)} m`);
  if (variant.id === 'vehicle-patrol') check('vehicle-patrol:lightbar', nodeByName(glb, 'LIGHTBAR_MESH') >= 0, nodeByName(glb, 'LIGHTBAR_MESH') >= 0 ? 'LIGHTBAR_MESH present' : 'missing');
}

const summary = { status: checks.every(c => c.pass) ? 'PASS' : 'FAIL', characterRegistry: identity(charContractPath), characterBindings, checks, checkedAt: new Date().toISOString() };
writeFileSync(path.join(OUT, 'glb.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(`\n${summary.status}: ${checks.filter(c => c.pass).length}/${checks.length} checks`);
process.exit(summary.status === 'PASS' ? 0 : 1);
