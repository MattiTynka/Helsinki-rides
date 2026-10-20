// Publish a world release (plan section 15): content-hashed copies of the baked cells, terrain, roads, gameplay,
// instanced scenery and hero and scenery assets under apps/game/public/world/<release>/ with a schemaVersion 2
// manifest, after the glTF validator and the budget gates pass. `current.json` points the game at the newest release.
//   node tools/world/publish_release.ts --cells data/work/m0/cells --terrain data/work/m0/terrain --roads data/work/m0/roads \
//     --gameplay data/work/m0/gameplay --assets data/work/m0/blender-character,data/work/m0/blender-car,data/work/m0/blender-scenery \
//     --origin content/helsinki/world-origin.json --sources content/helsinki/sources.json --config content/helsinki/cells.json \
//     --out apps/game/public/world [--status PILOT] [--keep]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTerrain, validateWorldManifest, type CellDescriptor, type SceneryDocument, type SourceRecord, type WorldManifest } from '../../packages/world-schema/src/index.ts';

const { values } = parseArgs({ options: {
  cells: { type: 'string' }, terrain: { type: 'string' }, roads: { type: 'string' }, gameplay: { type: 'string' }, assets: { type: 'string' },
  origin: { type: 'string' }, sources: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, status: { type: 'string', default: 'PILOT' }, keep: { type: 'boolean', default: false },
  'link-payloads': { type: 'boolean', default: false },
} });
for (const k of ['cells', 'terrain', 'roads', 'gameplay', 'assets', 'origin', 'sources', 'config', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const RESTRICTED_VEHICLE_SHA256 = '01d9f51ee1e19637ed479246991891c9a0f0fb54f9f4e87da43ab18583b766f3';
const origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const config = JSON.parse(readFileSync(values.config!, 'utf8'));
const sourcesCfg = JSON.parse(readFileSync(values.sources!, 'utf8')) as { sources: { id: string; ledger: string; snapshot: string | null; title: string; url: string; license: string; attribution: string }[]; assetCredits: string[] };
const cellsIndex = JSON.parse(readFileSync(path.join(values.cells!, 'cells.json'), 'utf8')) as { originId: string; cellSize: number; cells: CellDescriptor[] };
const cellsReport = JSON.parse(readFileSync(path.join(values.cells!, 'report.json'), 'utf8')) as { lighting?: string; inputs?: { terrainSha256?: string }; supportTerrain?: { path: string; bytes: number; sha256: string }; totals: { residentTextureMiBEstimate: number; drawCalls: number }; budgets: { pass: boolean } };
const terrainMeta = JSON.parse(readFileSync(path.join(values.terrain!, 'terrain.json'), 'utf8'));

// ---- gather files ----
interface Staged { readonly src: string; readonly published: string; readonly bytes: Uint8Array; readonly sha256: string }
const staged: Staged[] = [];
const stage = (src: string, dir: string, baseName: string, ext: string): Staged => {
  const bytes = new Uint8Array(readFileSync(src));
  const h = sha(bytes);
  if (ext === '.glb' && h === RESTRICTED_VEHICLE_SHA256) throw new Error('Nonredistributable vehicle GLB digest is excluded from publication');
  const s: Staged = { src, published: `${dir}${baseName}.${h.slice(0, 10)}${ext}`, bytes, sha256: h };
  staged.push(s);
  return s;
};
const ref = (s: Staged) => ({ path: s.published, bytes: s.bytes.byteLength, sha256: s.sha256 });

const cells = cellsIndex.cells.map(c => {
  const vis = stage(path.join(values.cells!, c.visual.lod0.path), 'cells/', `${c.id}.lod0`, '.glb');
  const low = c.visual.lod1 ? stage(path.join(values.cells!, c.visual.lod1.path), 'cells/', `${c.id}.lod1`, '.glb') : null;
  const distant = c.visual.lod2 ? stage(path.join(values.cells!, c.visual.lod2.path), 'cells/', `${c.id}.lod2`, '.glb') : null;
  const col = stage(path.join(values.cells!, c.collision.path), 'cells/', c.id, '.hcol');
  return { ...c, visual: { lod0: { ...c.visual.lod0, ...ref(vis) }, ...(low ? {lod1: {...c.visual.lod1!, ...ref(low)}} : {}), ...(distant ? {lod2: {...c.visual.lod2!, ...ref(distant)}} : {}) }, collision: { ...c.collision, ...ref(col) } } as CellDescriptor;
});
let terrainPath = path.join(values.terrain!, 'terrain.bin');
if (cellsReport.supportTerrain) {
  // Source terrain still determines authored heights. Only the fallback collision field is lowered beneath
  // those surfaces; publishing a cell repair without its matching field would restore the stair collision bug.
  if (cellsReport.supportTerrain.path !== 'runtime-terrain.bin') throw new Error('unexpected support terrain path');
  if (cellsReport.inputs?.terrainSha256 !== sha(new Uint8Array(readFileSync(terrainPath)))) throw new Error('support terrain source does not match --terrain');
  terrainPath = path.join(values.cells!, cellsReport.supportTerrain.path);
  const bytes = new Uint8Array(readFileSync(terrainPath));
  if (bytes.byteLength !== cellsReport.supportTerrain.bytes || sha(bytes) !== cellsReport.supportTerrain.sha256) throw new Error('support terrain payload does not match cell report');
  const grid = parseTerrain(bytes);
  for (const key of ['x0', 'z0', 'resolution', 'nx', 'nz'] as const) if (grid[key] !== terrainMeta[key]) throw new Error(`support terrain ${key} differs from source`);
}
const terrain = stage(terrainPath, '', 'terrain', '.bin');
const roads = stage(path.join(values.roads!, 'roads.json'), '', 'roads', '.json');
const gameplay = stage(path.join(values.gameplay!, 'gameplay.json'), '', 'gameplay', '.json');
// Instanced scenery written by the cell builder (decision 0006), tied to the scenery asset builds it was sized for.
const sceneryPath = path.join(values.cells!, 'scenery.json');
const sceneryDoc = existsSync(sceneryPath) ? JSON.parse(readFileSync(sceneryPath, 'utf8')) as SceneryDocument : null;
if (sceneryDoc && sceneryDoc.originId !== origin.id) throw new Error(`scenery origin ${sceneryDoc.originId} is not ${origin.id}`);
const scenery = sceneryDoc ? stage(sceneryPath, '', 'scenery', '.json') : null;
type AssetKind = WorldManifest['assets'][number]['kind'];
const assetKinds: Record<string, AssetKind> = { 'character-snow': 'character', 'character-rain': 'character', 'prop-pistol': 'prop', 'vehicle-lumi-gt': 'vehicle', 'vehicle-patrol': 'vehicle', 'scenery-trees': 'scenery' };
// Cars only some worlds' gameplay defines; a world that defines one must ship it (checked below).
const optionalAssetKinds: Record<string, AssetKind> = { 'vehicle-lumi-gt-far-low': 'prop', 'vehicle-patrol-far-low': 'prop', 'vehicle-revontuli': 'vehicle' };
const restrictedVehicle = /^(?:vehicle[-_]?)?(?:kaamos|gt[-_]?40)(?:[-_.][A-Za-z0-9_.-]+)?$/i;
const assets: (ReturnType<typeof ref> & { id: string; kind: AssetKind })[] = [];
for (const dir of values.assets!.split(',')) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.glb')) continue;
    const id = f.replace(/\.glb$/, '');
    if (restrictedVehicle.test(id)) throw new Error('Nonredistributable vehicle asset is excluded from publication');
    const kind = assetKinds[id] ?? optionalAssetKinds[id];
    if (!kind) { console.warn(`skipping unknown asset ${f}`); continue; }
    assets.push({ id, kind, ...ref(stage(path.join(dir, f), 'assets/', id, '.glb')) });
  }
}
for (const [id, kind] of Object.entries(assetKinds)) if (kind !== 'scenery' && !assets.some(a => a.id === id)) throw new Error(`hero asset ${id} missing from --assets`);
for (const d of (JSON.parse(readFileSync(path.join(values.gameplay!, 'gameplay.json'), 'utf8')) as { vehicleDefinitions: { id: string; assetId: string }[] }).vehicleDefinitions) {
  if (restrictedVehicle.test(d.id) || restrictedVehicle.test(d.assetId)) throw new Error('Nonredistributable vehicle definition is excluded from publication');
  if (!assets.some(a => a.id === d.assetId && a.kind === 'vehicle')) throw new Error(`vehicle ${d.id} needs asset ${d.assetId} in --assets`);
}
for (const a of sceneryDoc?.assets ?? []) {
  const staged = assets.find(s => s.id === a.id);
  if (!staged) throw new Error(`scenery asset ${a.id} missing from --assets`);
  if (staged.sha256 !== a.sha256) throw new Error(`scenery was sized for ${a.id} ${a.sha256.slice(0, 10)}, --assets has ${staged.sha256.slice(0, 10)}`);
}
for (const s of assets) if (s.kind === 'scenery' && !sceneryDoc?.assets.some(a => a.id === s.id)) throw new Error(`scenery asset ${s.id} has no instances in ${sceneryPath}`);

// ---- gates ----
const problems: string[] = [];
const budgets = config.budgets as { drawCallsPerCell: number; sceneTextureMiB: number; lowPresetTextureMiB: number };
for (const c of cells) if (c.visual.lod0.drawCalls > budgets.drawCallsPerCell) problems.push(`${c.id}: ${c.visual.lod0.drawCalls} draw calls > ${budgets.drawCallsPerCell}`);
if (config.streaming?.enabled === true) {
  for (const c of cells) {
    if (!c.visual.lod2 || c.visual.lod2.textureBytesEstimate !== 0 || c.visual.lod2.drawCalls > 3) problems.push(`${c.id}: bounded streaming requires a textureless distant fallback with <=3 draws`);
  }
} else if (cellsReport.totals.residentTextureMiBEstimate > budgets.sceneTextureMiB) problems.push(`resident textures ${cellsReport.totals.residentTextureMiBEstimate} MiB > ${budgets.sceneTextureMiB}`);
if (!cellsReport.budgets.pass) problems.push('cell builder reported budget failure');
const validator = await import('gltf-validator');
let validated = 0;
for (const s of staged) {
  if (!s.published.endsWith('.glb')) continue;
  const report = await validator.validateBytes(s.bytes, { maxIssues: 20 });
  validated++;
  if (report.issues.numErrors > 0) problems.push(`${s.src}: ${report.issues.numErrors} glTF validator errors: ${report.issues.messages.filter(m => m.severity === 0).map(m => m.code).join(', ')}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

// ---- sources ----
const sources: SourceRecord[] = sourcesCfg.sources.map(s => {
  const ledger = JSON.parse(readFileSync(s.ledger, 'utf8')) as { snapshots?: Record<string, { retrievedAt?: string; sha256?: string }>; retrievedAt?: string };
  const snap = s.snapshot ? ledger.snapshots?.[s.snapshot] : undefined;
  const rec: SourceRecord = { id: s.id, title: s.title, url: s.url, license: s.license, attribution: s.attribution };
  const extra: { retrievedAt?: string; snapshot?: string; sha256?: string } = {};
  const retrievedAt = snap?.retrievedAt ?? ledger.retrievedAt;
  if (retrievedAt) extra.retrievedAt = retrievedAt;
  if (s.snapshot) extra.snapshot = s.snapshot;
  if (snap?.sha256) extra.sha256 = snap.sha256;
  return { ...rec, ...extra };
});

// ---- manifest ----
const allHashes = staged.map(s => s.sha256).sort().join('');
const releaseId = `senate-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${sha(new TextEncoder().encode(allHashes)).slice(0, 8)}`;
const bounds = cells.reduce((b, c) => [Math.min(b[0], c.boundsXZ[0]), Math.min(b[1], c.boundsXZ[1]), Math.max(b[2], c.boundsXZ[2]), Math.max(b[3], c.boundsXZ[3])] as [number, number, number, number], [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number]);
const lighting = (cellsReport.lighting ?? 'lit-facades') as WorldManifest['lighting'];
const manifest: WorldManifest = {
  schemaVersion: 2,
  worldReleaseId: releaseId,
  status: values.status === 'PROOF' ? 'PROOF' : 'PILOT',
  builtAt: new Date().toISOString(),
  coordinateFrame: { crs: 'EPSG:3879', heightDatum: 'N2000', runtimeAxes: 'X-east,Y-up,Z-south', units: 'meter' },
  origin: { id: origin.id, originProjected: origin.originProjected },
  cellSize: cellsIndex.cellSize,
  boundsRuntimeXZ: bounds,
  cells,
  terrain: { ...ref(terrain), x0: terrainMeta.x0, z0: terrainMeta.z0, resolution: terrainMeta.resolution, nx: terrainMeta.nx, nz: terrainMeta.nz },
  roads: ref(roads),
  gameplay: ref(gameplay),
  assets,
  ...(scenery ? { scenery: ref(scenery) } : {}),
  simulation: { engine: '@dimforge/rapier3d-deterministic-compat', version: '0.21.0', tickHz: 60 },
  sources,
  attribution: [...sourcesCfg.sources.map(s => s.attribution), ...sourcesCfg.assetCredits],
  lighting,
};
const mp = validateWorldManifest(manifest);
if (mp.length) throw new Error(`manifest invalid: ${mp.join('; ')}`);

// ---- write ----
const outDir = path.join(values.out!, releaseId);
if (values['link-payloads'] && (!values.keep || existsSync(outDir))) throw new Error('--link-payloads requires --keep and a new immutable release directory');
if (!values.keep && existsSync(values.out!)) {
  for (const d of readdirSync(values.out!)) { const p = path.join(values.out!, d); if (statSync(p).isDirectory() && d !== releaseId) rmSync(p, { recursive: true, force: true }); }
}
mkdirSync(path.join(outDir, 'cells'), { recursive: true });
mkdirSync(path.join(outDir, 'assets'), { recursive: true });
let total = 0;
let linkedPayloads = 0;
for (const s of staged) {
  const target = path.join(outDir, s.published);
  // Both source and release are immutable build artifacts. Never modify a linked payload in place.
  if (values['link-payloads']) {
    try { linkSync(s.src, target); linkedPayloads++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; copyFileSync(s.src, target); }
  } else copyFileSync(s.src, target);
  total += s.bytes.byteLength;
}
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
writeFileSync(path.join(values.out!, 'current.json'), JSON.stringify({ release: releaseId, publishedAt: manifest.builtAt }, null, 1) + '\n');
console.log(JSON.stringify({ release: releaseId, cells: cells.length, assets: assets.length, files: staged.length, validatedGlbs: validated, totalMB: Math.round(total / 1e5) / 10, residentTextureMiB: cellsReport.totals.residentTextureMiBEstimate, lighting, linkedPayloads }));
