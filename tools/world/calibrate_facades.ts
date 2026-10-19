// Source | shipped erase | conservative repair, at the shipped source-page resolution. No world export.
// node tools/world/calibrate_facades.ts --out NEW_DIR --pages 44,28,56
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { eraseVegetation, trianglesNearTrees, type PageTriangle, type TreeVolume, type VegetationOptions, type VegetationRepairDiagnostics } from './lib/vegetation.ts';
import { restoreUniversityFacade, assertUniversityMaster, UNIVERSITY_PAGE } from './lib/facade-restoration.ts';

const { values } = parseArgs({ options: { out: { type: 'string' }, pages: { type: 'string' }, experimental: { type: 'boolean', default: false }, 'city-model': { type: 'string', default: 'data/work/m0/citymodel-v2' }, baseline: { type: 'string', default: 'data/work/m0/cells-v14' } } });
if (!values.out || existsSync(values.out)) throw new Error('--out must name a new directory');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const city = read(path.join(values['city-model']!, 'city-model.json'));
const binary = readFileSync(path.join(values['city-model']!, city.binary.file));
const array = (slice: { offset: number; bytes: number }, indices = false) => {
  const copy = binary.buffer.slice(binary.byteOffset + slice.offset, binary.byteOffset + slice.offset + slice.bytes);
  return indices ? new Uint32Array(copy) : new Float32Array(copy);
};
const config = read('content/helsinki/cells.json');
const options: VegetationOptions = { ...config.vegetation, ...(values.experimental ? { mode: 'experimental-repeats' as const } : {}) };
const trees = read('data/work/m0/trees-v1/trees.json').trees;
const volumes: TreeVolume[] = trees.map((t: { position: number[]; crownRadius: number; height: number }) => ({ x: t.position[0]!, z: t.position[2]!, radius: t.crownRadius, base: t.position[1]!, top: t.position[1]! + t.height }));
const selected = new Set((values.pages ?? '44,28,56,55,58,71,33,77,23,5,16').split(',').map(Number));
const pages = new Map<number, { tris: { tri: PageTriangle; trees: TreeVolume[] }[]; addresses: Set<string> }>();
for (const b of city.buildings) for (const part of b.parts) {
  if (!selected.has(part.texture)) continue;
  const positions = array(part.positions), uvs = array(part.uvs), indices = array(part.indices, true);
  for (let i = 0; i < positions.length; i += 3) { const north = positions[i + 1]!; positions[i + 1] = positions[i + 2]!; positions[i + 2] = -north; }
  for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i]!;
  const near = trianglesNearTrees(positions, uvs, indices, volumes, options);
  const entry = pages.get(part.texture) ?? { tris: [], addresses: new Set<string>() };
  entry.tris.push(...near); entry.addresses.add(b.address ?? b.id); pages.set(part.texture, entry);
}
mkdirSync(values.out, { recursive: true });
const baselineReport = read(path.join(values.baseline!, 'report.json'));
const records = [];
for (const [page, entry] of pages) {
  const texture = city.textures[page], master = readFileSync(path.join(values['city-model']!, texture.file));
  const shipped = baselineReport.vegetation.pages.find((p: { texture: number }) => p.texture === page);
  const scale = Math.min(1, (shipped?.size?.[0] ?? 512) / texture.width), w = Math.round(texture.width * scale), h = Math.round(texture.height * scale);
  const before = new Uint8Array(await sharp(master).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer());
  const candidate = Uint8Array.from(before), diagnostics: VegetationRepairDiagnostics = { candidates: 0, changed: 0, decisions: [] };
  const changed = eraseVegetation(candidate, w, h, entry.tris, options, diagnostics);
  if (page === UNIVERSITY_PAGE) assertUniversityMaster(master);
  const curated = page === UNIVERSITY_PAGE ? restoreUniversityFacade(candidate, w, h) : null;
  const shippedFile = path.join(values.baseline!, 'vegetation', `t${page}.png`);
  const bad = existsSync(shippedFile) ? new Uint8Array(await sharp(shippedFile).extract({ left: w, top: 0, width: w, height: h }).ensureAlpha().raw().toBuffer()) : before;
  const triptych = new Uint8Array(w * 3 * h * 4);
  for (let y = 0; y < h; y++) for (const [column, image] of [before, bad, candidate].entries()) triptych.set(image.subarray(y * w * 4, (y + 1) * w * 4), (y * w * 3 + column * w) * 4);
  await sharp(triptych, { raw: { width: w * 3, height: h, channels: 4 } }).png().toFile(path.join(values.out, `t${page}.png`));
  records.push({ page, addresses: [...entry.addresses], master: texture.file, masterSha256: sha(master), size: [w, h], changed, diagnostics, curated, candidateRgbaSha256: sha(candidate), originalRgbaSha256: sha(before), retainedFoliage: 'Rejected automatic regions retain original photographed vegetation; the University hero chart has a separate curated reconstruction.' });
  console.log(`t${page}: ${changed} changed of ${diagnostics.candidates} candidates; ${entry.addresses.size} buildings`);
}
writeFileSync(path.join(values.out, 'calibration.json'), JSON.stringify({ columns: ['untouched master resampled', 'shipped cells-v14 erase', 'conservative candidate'], options, pages: records, status: 'CAPTURED_NOT_REVIEWED' }, null, 2) + '\n');
