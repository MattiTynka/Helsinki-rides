// Extend an accepted city-model without renumbering its source-bound facade pages or changing its buildings.
// node tools/world/merge_city_model.ts --base data/work/m0/citymodel-v2 --expanded data/work/NEW/converted --out data/work/NEW/citymodel
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

interface Span { offset: number; bytes: number }
interface Texture { file: string; width: number; height: number; sourceSha256: string }
interface Part { texture: number | null; colour: number[]; vertices: number; positions: Span; uvs: Span; indices: Span }
interface Building {
  id: string; parts: Part[]; triangles: number; textured: boolean;
  [key: string]: unknown;
}
interface CityModel {
  schemaVersion: number; kind: string; frame: string; originId: string; originProjected: number[];
  source: { tilesetVersion: string; [key: string]: unknown };
  binary: { file: string; bytes: number; sha256: string };
  textures: Texture[]; buildings: Building[]; stats: Record<string, number>;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function childPath(directory: string, relative: string): string {
  const root = path.resolve(directory), candidate = path.resolve(root, relative);
  if (!candidate.startsWith(root + path.sep)) throw new Error(`input path escapes its directory: ${relative}`);
  return candidate;
}
function readModel(directory: string) {
  const jsonBytes = readFileSync(path.join(directory, 'city-model.json'));
  const model = JSON.parse(jsonBytes.toString('utf8')) as CityModel;
  if (model.schemaVersion !== 1 || model.kind !== 'city-model-buildings') throw new Error(`${directory}: unexpected city-model format`);
  const binary = readFileSync(childPath(directory, model.binary.file));
  if (binary.byteLength !== model.binary.bytes || sha256(binary) !== model.binary.sha256) throw new Error(`${directory}: binary hash or size mismatch`);
  const ids = new Set<string>();
  for (const b of model.buildings) {
    if (!b.id || ids.has(b.id)) throw new Error(`${directory}: duplicate or empty building id ${b.id}`);
    ids.add(b.id);
    for (const part of b.parts) {
      if (part.texture !== null && (!Number.isInteger(part.texture) || !model.textures[part.texture])) throw new Error(`${b.id}: invalid texture index`);
      for (const key of ['positions', 'uvs', 'indices'] as const) span(binary, part[key]);
    }
  }
  const textures = model.textures.map(t => {
    if (!/^[a-f0-9]{64}$/.test(t.sourceSha256) || !(t.width > 0 && t.height > 0)) throw new Error('invalid texture metadata');
    return readFileSync(childPath(directory, t.file));
  });
  return { model, binary, textures, jsonSha256: sha256(jsonBytes) };
}
function span(binary: Buffer, ref: Span): Buffer {
  if (!Number.isInteger(ref.offset) || !Number.isInteger(ref.bytes) || ref.offset < 0 || ref.bytes < 0 || ref.offset + ref.bytes > binary.length || ref.offset % 4 || ref.bytes % 4) throw new Error('invalid city-model binary span');
  return binary.subarray(ref.offset, ref.offset + ref.bytes);
}

/** The base binary, building records and texture array are retained as exact prefixes. */
export function mergeCityModels(options: { base: string; expanded: string; out: string; appendSnapshot?: boolean; linkTextures?: boolean }) {
  if (existsSync(options.out)) throw new Error(`${options.out} exists; merge writes a new directory`);
  const base = readModel(options.base), expanded = readModel(options.expanded);
  for (const key of ['frame', 'originId', 'originProjected'] as const) if (!equal(base.model[key], expanded.model[key])) throw new Error(`city-model ${key} mismatch`);
  if (!base.model.source.tilesetVersion || base.model.source.tilesetVersion !== expanded.model.source.tilesetVersion) throw new Error('city-model tileset vintage mismatch');
  const textures = [...base.model.textures], textureBytes = [...base.textures];
  const textureSources = base.model.textures.map(t => childPath(options.base, t.file));
  const byHash = new Map(textures.map((t, i) => [t.sourceSha256, i]));
  if (byHash.size !== textures.length) throw new Error('base contains duplicate source texture hashes');
  const remap = new Map<number, number>();
  for (const [index, t] of expanded.model.textures.entries()) {
    let target = byHash.get(t.sourceSha256);
    if (target === undefined) {
      target = textures.length;
      const file = `textures/${t.sourceSha256}.png`;
      textures.push({ ...t, file }); textureBytes.push(expanded.textures[index]!);
      textureSources.push(childPath(options.expanded, t.file));
      byHash.set(t.sourceSha256, target);
    } else {
      const original = textures[target]!;
      if (original.width !== t.width || original.height !== t.height || !textureBytes[target]!.equals(expanded.textures[index]!)) throw new Error(`same source texture hash has different decoded pixels: ${t.sourceSha256}`);
    }
    remap.set(index, target);
  }
  const baseBuildings = new Map(base.model.buildings.map(b => [b.id, b]));
  const overlapping: string[] = [], added: string[] = [];
  const buildings = [...base.model.buildings];
  const chunks: Buffer[] = [base.binary]; let offset = base.binary.length;
  const append = (ref: Span): Span => { const bytes = span(expanded.binary, ref), next = { offset, bytes: bytes.length }; chunks.push(bytes); offset += bytes.length; return next; };
  for (const building of expanded.model.buildings) {
    const original = baseBuildings.get(building.id);
    if (original) {
      // A same-vintage overlap must match. Retaining old bytes must not conceal a source change.
      if (original.parts.length !== building.parts.length) throw new Error(`${building.id}: overlap part count changed`);
      for (let i = 0; i < building.parts.length; i++) {
        const p = building.parts[i]!, q = original.parts[i]!;
        const texture = p.texture === null ? null : remap.get(p.texture);
        if (texture !== q.texture || !equal(p.colour, q.colour) || p.vertices !== q.vertices) throw new Error(`${building.id}: overlap material changed`);
        for (const key of ['positions', 'uvs', 'indices'] as const) if (!span(expanded.binary, p[key]).equals(span(base.binary, q[key]))) throw new Error(`${building.id}: overlap ${key} changed`);
      }
      overlapping.push(building.id); continue;
    }
    const parts = building.parts.map(p => ({ ...p, texture: p.texture === null ? null : remap.get(p.texture)!, positions: append(p.positions), uvs: append(p.uvs), indices: append(p.indices) }));
    buildings.push({ ...building, parts }); added.push(building.id);
  }
  if (!options.appendSnapshot) for (const b of base.model.buildings) if (!overlapping.includes(b.id)) throw new Error(`expanded snapshot omits accepted building ${b.id}`);
  const binary = Buffer.concat(chunks);
  if (!binary.subarray(0, base.binary.length).equals(base.binary)) throw new Error('base binary prefix was not preserved');
  const model: CityModel & { merge: unknown } = {
    ...base.model,
    source: { ...expanded.model.source, retainedBase: base.model.source },
    binary: { file: 'city-model.bin', bytes: binary.length, sha256: sha256(binary) }, textures, buildings,
    stats: { sourceTriangles: buildings.reduce((n, b) => n + b.triangles, 0), skippedTriangles: 0, buildings: buildings.length, textured: buildings.filter(b => b.textured).length, texturePixels: textures.reduce((n, t) => n + t.width * t.height, 0) },
    merge: { baseModelSha256: base.jsonSha256, expandedModelSha256: expanded.jsonSha256, retainedBuildingCount: base.model.buildings.length, retainedTexturePrefix: base.model.textures.length, retainedBinaryPrefix: base.binary.length },
  };
  mkdirSync(path.join(options.out, 'textures'), { recursive: true });
  textures.forEach((t, i) => {
    const output = childPath(options.out, t.file); mkdirSync(path.dirname(output), { recursive: true });
    // Inputs and output are immutable source snapshots. The optional link avoids copying accepted atlas masters.
    if (options.linkTextures) {
      try { linkSync(textureSources[i]!, output); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; writeFileSync(output, textureBytes[i]!, { flag: 'wx' }); }
    } else writeFileSync(output, textureBytes[i]!);
  });
  writeFileSync(path.join(options.out, 'city-model.bin'), binary);
  writeFileSync(path.join(options.out, 'city-model.json'), JSON.stringify(model, null, 1) + '\n');
  const report = {
    status: 'PASS', base: { path: options.base, jsonSha256: base.jsonSha256, binarySha256: base.model.binary.sha256 }, expanded: { path: options.expanded, jsonSha256: expanded.jsonSha256, binarySha256: expanded.model.binary.sha256 },
    output: { path: options.out, jsonSha256: sha256(readFileSync(path.join(options.out, 'city-model.json'))), binarySha256: model.binary.sha256 },
    preserved: { buildings: base.model.buildings.length, textures: base.model.textures.length, binaryBytes: base.binary.length },
    added: { buildings: added.length, textures: textures.length - base.model.textures.length }, overlapVerified: overlapping.length,
    textureRemap: Object.fromEntries(remap), addedBuildingIds: added, totals: model.stats,
    snapshotMode: options.appendSnapshot ? 'append-subset-with-every-provided-overlap-verified' : 'complete-expanded-snapshot', linkedTextures: options.linkTextures === true,
  };
  writeFileSync(path.join(options.out, 'merge-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, expanded: { type: 'string' }, out: { type: 'string' }, 'append-snapshot': { type: 'boolean', default: false }, 'link-textures': { type: 'boolean', default: false } } });
  if (!values.base || !values.expanded || !values.out) throw new Error('--base, --expanded and --out are required');
  const report = mergeCityModels({ base: values.base, expanded: values.expanded, out: values.out, appendSnapshot: values['append-snapshot'], linkTextures: values['link-textures'] });
  console.log(JSON.stringify({ status: report.status, preserved: report.preserved, added: report.added, totals: report.totals }));
}
