// Image-only repair of independently baked atlas owners inside appended cells.
// node tools/world/repair_owner_facades.ts --plan qualified-owner-plan.json --out FRESH_CELLS --texture-cache CACHE
// The plan pins the final/owner indices, source JSON/config/masters, reviewed reference files and pixel masks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { buildAtlases, type AtlasInput, type Placement } from './lib/atlas.ts';
import { encodeKtx2, type RgbaImage } from './lib/gltf.ts';
import { gradeFacade } from './lib/grade.ts';
import { solidTile, splitBySlope } from './lib/untextured.ts';
import { createFacadeRestorer, facadeRestorationSourceFiles } from './lib/facade-restoration-registry.ts';
import { cloneFacadeCandidate, facadeAtlasCacheKey, facadeSha, matchOwnerFacade, proveFacadeIndexPreservation, proveSelectedPixelChanges, replaceBoundOwnerImages, verifyFacadeSourceCorners, type PixelRectangle, type SourceFacadePart, type FacadeImageBinding } from './lib/owner-facade-repair.ts';

interface PinnedFile { file: string; sha256: string }
interface Target {
  buildingId: string; page: number; masterSha256: string; imageSha256: string;
  moduleIds: string[]; allowedPixels: PixelRectangle[];
  placement: Placement; atlasDimensions: [number, number];
}
interface Owner {
  cells: { directory: string; indexSha256: string; reportSha256: string };
  cityModel: { directory: string; jsonSha256: string }; config: PinnedFile; targets: Target[];
}
interface Plan {
  schemaVersion: 1; status: 'REFERENCE_QUALIFIED'; base: { directory: string; indexSha256: string; reportSha256: string };
  references: PinnedFile[]; owners: Owner[];
}
interface Slice { offset: number; bytes: number }
interface CityModel {
  binary: { file: string; sha256: string }; textures: { file: string; width: number; height: number }[];
  buildings: { id: string; parts: { texture: number | null; positions: Slice; uvs: Slice; indices: Slice }[] }[];
}
const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const inputPins = new Map<string, string>();
const pinned = (file: string, hash: string) => { assert.match(hash, /^[a-f0-9]{64}$/, `invalid pinned hash: ${file}`); const bytes = fs.readFileSync(file); assert.equal(facadeSha(bytes), hash, `pinned input changed: ${file}`); const previous = inputPins.get(file); assert.ok(previous === undefined || previous === hash, `conflicting input pin: ${file}`); inputPins.set(file, hash); return bytes; };
const receipt = (file: string) => ({ file, sha256: facadeSha(fs.readFileSync(file)) });
const { values } = parseArgs({ options: { plan: { type: 'string' }, out: { type: 'string' }, 'texture-cache': { type: 'string' } } });
assert.ok(values.plan && values.out, '--plan and --out required');
assert.ok(!fs.existsSync(values.out), 'output exists; choose a fresh directory');
const plan = readJson(values.plan) as Plan;
assert.equal(plan.schemaVersion, 1); assert.equal(plan.status, 'REFERENCE_QUALIFIED', 'reference-qualified authoring plan required');
assert.ok(plan.references?.length && plan.owners?.length, 'reviewed references and owners required');
for (const ref of plan.references) pinned(ref.file, ref.sha256);
const base = plan.base.directory, indexFile = path.join(base, 'cells.json'), reportFile = path.join(base, 'report.json');
const indexBytes = pinned(indexFile, plan.base.indexSha256), reportBytes = pinned(reportFile, plan.base.reportSha256);
const index = JSON.parse(indexBytes.toString('utf8')), report = JSON.parse(reportBytes.toString('utf8'));
const changed = new Map<string, Uint8Array>(), cellReplacements = new Map<string, { binding: FacadeImageBinding; originalEncoded: Uint8Array; replacement: Uint8Array }[]>();
const proofs: unknown[] = [], ownerProofs: unknown[] = [], imagePins = new Set<string>();
const sourceFiles = [...facadeRestorationSourceFiles, 'tools/world/repair_owner_facades.ts', 'tools/world/lib/owner-facade-repair.ts', 'tools/world/lib/facade-glb.ts', 'tools/world/lib/atlas.ts', 'tools/world/lib/gltf.ts', 'tools/world/lib/grade.ts', 'tools/world/lib/untextured.ts', 'package.json', 'pnpm-lock.yaml'];
// Bind the installed encoder implementation and WASM, rather than trusting only the lockfile.
const encoderFiles = fs.readdirSync('node_modules/ktx2-encoder/dist', { recursive: true }).filter(f => /\.(js|wasm)$/.test(f.toString())).map(f => path.join('node_modules/ktx2-encoder/dist', f.toString())).sort();
const sourceIdentity = [...new Set([...sourceFiles, ...encoderFiles])].map(receipt);
const encoderIdentity = facadeSha(JSON.stringify(sourceIdentity.filter(s => s.file.includes('ktx2-encoder') || ['tools/world/lib/gltf.ts', 'package.json', 'pnpm-lock.yaml'].includes(s.file))));
const textureCache = values['texture-cache']; if (textureCache) fs.mkdirSync(textureCache, { recursive: true });
const encoded = new Map<string, Uint8Array>();
async function encode(image: RgbaImage) {
  const key = facadeAtlasCacheKey(image, encoderIdentity); if (encoded.has(key)) return encoded.get(key)!;
  const file = textureCache ? path.join(textureCache, `${key}.ktx2`) : undefined;
  const identity = { key, width: image.width, height: image.height, rgbaSha256: facadeSha(image.data), encoderIdentity };
  let bytes: Uint8Array;
  if (file && fs.existsSync(file)) {
    const cached = readJson(`${file}.json`); bytes = fs.readFileSync(file);
    assert.deepEqual(cached, { ...identity, sha256: facadeSha(bytes) }, 'cached atlas receipt mismatch');
  } else {
    bytes = await encodeKtx2(image, 'facade');
    if (file) { fs.writeFileSync(file, bytes, { flag: 'wx' }); fs.writeFileSync(`${file}.json`, JSON.stringify({ ...identity, sha256: facadeSha(bytes) }) + '\n', { flag: 'wx' }); }
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(header.getUint32(20, true), image.width); assert.equal(header.getUint32(24, true), image.height);
  encoded.set(key, bytes); return bytes;
}
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const owner of plan.owners) {
  assert.ok(owner.targets?.length, 'owner has no selected targets');
  const ownerIndex = JSON.parse(pinned(path.join(owner.cells.directory, 'cells.json'), owner.cells.indexSha256).toString('utf8'));
  const ownerReport = JSON.parse(pinned(path.join(owner.cells.directory, 'report.json'), owner.cells.reportSha256).toString('utf8'));
  const model = JSON.parse(pinned(path.join(owner.cityModel.directory, 'city-model.json'), owner.cityModel.jsonSha256).toString('utf8')) as CityModel;
  const config = JSON.parse(pinned(owner.config.file, owner.config.sha256).toString('utf8'));
  assert.equal(config.vegetation.mode, 'restore-original', 'automatic vegetation removal is not a production facade repair');
  assert.equal(config.cellSize, ownerIndex.cellSize); assert.equal(index.cellSize, ownerIndex.cellSize); assert.equal(index.originId, ownerIndex.originId);
  assert.deepEqual(config.facadeGrade, ownerReport.facadeGrade, 'owner facade grade differs');
  const binary = pinned(path.join(owner.cityModel.directory, model.binary.file), model.binary.sha256);
  assert.equal(model.binary.sha256, ownerReport.inputs.cityModelSha256, 'source model differs from frozen owner');
  const array = (slice: Slice, indices = false) => { const bytes = binary.buffer.slice(binary.byteOffset + slice.offset, binary.byteOffset + slice.offset + slice.bytes); return indices ? new Uint32Array(bytes) : new Float32Array(bytes); };
  const buildingSources = new Map(model.buildings.map(b => [b.id, b])), parts = new Map<string, SourceFacadePart[]>();
  const getParts = (id: string) => {
    if (parts.has(id)) return parts.get(id)!; const source = buildingSources.get(id); assert.ok(source, `owner building source absent: ${id}`);
    const result = source.parts.map(p => {
      const positions = array(p.positions) as Float32Array, uvs = array(p.uvs) as Float32Array;
      for (let i = 0; i < positions.length; i += 3) { const n = positions[i + 1]!; positions[i + 1] = positions[i + 2]!; positions[i + 2] = -n; }
      for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i]!;
      return { texture: p.texture, positions, uvs, indices: array(p.indices, true) as Uint32Array };
    }); parts.set(id, result); return result;
  };
  const restorer = await createFacadeRestorer(owner.cityModel.directory, model.textures), newModules = [...new Set(owner.targets.flatMap(t => t.moduleIds))];
  const byCell = new Map<string, Target[]>();
  for (const target of owner.targets) {
    assert.ok(Number.isSafeInteger(target.page) && target.page >= 0 && model.textures[target.page], 'invalid target page');
    assert.ok(target.moduleIds.length && target.allowedPixels.length, 'target requires new module IDs and reviewed pixel selection');
    for (const id of target.moduleIds) assert.ok(restorer.modules.some(m => m.id === id && m.targetPages.includes(target.page)), `restoration ${id} does not target page${target.page}`);
    pinned(path.join(owner.cityModel.directory, model.textures[target.page]!.file), target.masterSha256);
    assert.ok(getParts(target.buildingId).some(p => p.texture === target.page), 'target page not used by selected building');
    const owners = ownerIndex.cells.filter((c: any) => c.buildings.some((b: any) => b.id === target.buildingId && !b.landmark));
    assert.equal(owners.length, 1, 'building must have one visual owner (not crossing buildingIds)');
    const list = byCell.get(owners[0].id) ?? []; list.push(target); byCell.set(owners[0].id, list);
  }
  const pageProofs: unknown[] = [], masterInputs = new Map<string, PinnedFile>();
  for (const [cellId, targets] of byCell) {
    const ownerCell = ownerIndex.cells.find((c: any) => c.id === cellId), finalCell = index.cells.find((c: any) => c.id === cellId); assert.ok(finalCell, 'final cell missing');
    const used = new Set<number | string>(), sourceParts: SourceFacadePart[] = [];
    for (const b of ownerCell.buildings) if (!b.landmark) for (const part of getParts(b.id)) {
      sourceParts.push(part);
      if (part.texture !== null) used.add(part.texture);
      else { const split = splitBySlope(part.positions, part.indices, config.untextured.wallMaxNormalY); if (split.wall.length) used.add('wall'); if (split.roof.length) used.add('roof'); }
    }
    const hiRes = new Set<number>(ownerReport.hiResFacadePages.map((p: any) => p.texture));
    const inputs: AtlasInput[] = [...used].map(t => {
      if (typeof t === 'string') { const image = solidTile(config.untextured[t], config.untextured.tileSize); return { id: `t${t}`, image, width: image.width, height: image.height, cap: image.width }; }
      const texture = model.textures[t]!, file = path.join(owner.cityModel.directory, texture.file), input = receipt(file); masterInputs.set(file, input); pinned(file, input.sha256);
      return { id: `t${t}`, file, width: texture.width, height: texture.height, cap: hiRes.has(t) ? config.texelCap.facadeHiRes : config.texelCap.facade };
    });
    const baselinePages = new Map<string, RgbaImage>(), changedPages = new Set<number>();
    const before = await buildAtlases(inputs, config.atlasSize, async (rgba, width, height, id) => {
      const data = Uint8Array.from(rgba), match = /^t(\d+)$/.exec(id);
      if (match) restorer.apply(Number(match[1]), data, width, height, { excludeModuleIds: newModules });
      baselinePages.set(id, { width, height, data }); return gradeFacade(data, width, height, config.facadeGrade);
    });
    const after = await buildAtlases(inputs, config.atlasSize, async (rgba, width, height, id) => {
      const data = Uint8Array.from(rgba), match = /^t(\d+)$/.exec(id), page = match ? Number(match[1]) : null;
      const evidence = page === null ? [] : restorer.apply(page, data, width, height);
      const allowed = targets.filter(t => t.page === page).flatMap(t => t.allowedPixels), proof = proveSelectedPixelChanges(baselinePages.get(id)!, { width, height, data }, allowed);
      if (page !== null && proof.changedPixels > 0) changedPages.add(page);
      pageProofs.push({ cell: cellId, id, ...proof, allowedPixels: allowed, evidence });
      return gradeFacade(data, width, height, config.facadeGrade);
    });
    assert.deepEqual([...after.placements], [...before.placements], 'owner packing changed'); assert.equal(after.atlases.length, before.atlases.length);
    for (const target of targets) assert.ok(changedPages.has(target.page), `selected page${target.page} has no restoration changes`);
    const selectedAtlases = new Set<number>();
    for (const target of targets) {
      const placement = before.placements.get(`t${target.page}`); assert.deepEqual(placement, target.placement, 'pinned owner page layout differs'); assert.ok(placement);
      const atlas = before.atlases[placement.atlas]!; assert.deepEqual([atlas.width, atlas.height], target.atlasDimensions, 'pinned owner atlas dimensions differ'); selectedAtlases.add(placement.atlas);
    }
    const ownerBytes = pinned(path.join(owner.cells.directory, ownerCell.visual.lod0.path), ownerCell.visual.lod0.sha256), finalBytes = pinned(path.join(base, finalCell.visual.lod0.path), finalCell.visual.lod0.sha256);
    const ownerDoc = await io.readBinary(ownerBytes), finalDoc = await io.readBinary(finalBytes);
    for (const [ai, atlas] of before.atlases.entries()) {
      const allowed: PixelRectangle[] = targets.filter(t => t.placement.atlas === ai).map(t => [Math.max(0, t.placement.x - 8), Math.max(0, t.placement.y - 8), Math.min(atlas.width, t.placement.x + t.placement.w + 8), Math.min(atlas.height, t.placement.y + t.placement.h + 8)]);
      const pixelProof = proveSelectedPixelChanges(atlas, after.atlases[ai]!, allowed);
      if (!selectedAtlases.has(ai)) { assert.equal(pixelProof.changedPixels, 0); continue; }
      assert.ok(pixelProof.changedPixels > 0, 'selected atlas has no repair changes');
      const selected = targets.filter(t => t.placement.atlas === ai); assert.ok(selected.every(t => t.imageSha256 === selected[0]!.imageSha256), 'conflicting atlas image pins');
      const correspondence = matchOwnerFacade(ownerBytes, ownerDoc, finalBytes, finalDoc, `${cellId}_facades_${ai}`, selected[0]!.imageSha256);
      const corners = verifyFacadeSourceCorners(correspondence.finalNode, sourceParts, before.placements, ai, [atlas.width, atlas.height]);
      const oldEncoded = await encode(atlas); assert.equal(facadeSha(oldEncoded), correspondence.ownerBinding.sha256, 'baseline atlas negative control failed');
      const replacement = await encode(after.atlases[ai]!), key = `${cellId}:${correspondence.finalBinding.imageIndex}`;
      assert.notEqual(facadeSha(replacement), facadeSha(oldEncoded), 'repair produces no encoded texture change');
      assert.ok(!imagePins.has(key), 'same final image selected by multiple owners'); imagePins.add(key);
      const replacements = cellReplacements.get(cellId) ?? []; replacements.push({ binding: correspondence.finalBinding, originalEncoded: oldEncoded, replacement }); cellReplacements.set(cellId, replacements);
      proofs.push({ cell: cellId, owner: owner.cells.directory, atlas: ai, targets: selected, geometrySha256: correspondence.geometrySha256,
        sourceCornerChecks: corners, finalBinding: { ...correspondence.finalBinding, bytes: undefined }, originalEncodedSha256: facadeSha(oldEncoded), replacementSha256: facadeSha(replacement),
        layout: [...before.placements], originalRgbaSha256: facadeSha(atlas.data), replacementRgbaSha256: facadeSha(after.atlases[ai]!.data), encoderIdentity, pixelProof });
    }
  }
  ownerProofs.push({ owner, modules: restorer.modules, sources: restorer.inputs, externalInputs: restorer.externalInputs, supportInputs: restorer.supportInputs, masterInputs: [...masterInputs.values()], pageProofs });
}
let byteDelta = 0, imageByteDelta = 0;
for (const [cellId, replacements] of cellReplacements) {
  const cell = index.cells.find((c: any) => c.id === cellId), file = path.join(base, cell.visual.lod0.path), bytes = pinned(file, cell.visual.lod0.sha256);
  const repaired = replaceBoundOwnerImages(bytes, replacements); changed.set(cell.visual.lod0.path, repaired);
  const oldDescriptor = structuredClone(cell.visual.lod0), delta = repaired.byteLength - bytes.byteLength;
  const imageDelta = replacements.reduce((n, r) => n + r.replacement.length - r.binding.bytes.length, 0); imageByteDelta += imageDelta;
  byteDelta += delta; cell.visual.lod0.bytes = repaired.byteLength; cell.visual.lod0.sha256 = facadeSha(repaired);
  const measured = report.cells?.find((c: any) => c.cell === cellId); if (measured) { measured.glbBytes += delta; if (typeof measured.ktx2Bytes === 'number') measured.ktx2Bytes += imageDelta; }
  // Image dimensions and GPU allocation remain identical; low/distant geometry and every tier descriptor survive.
  proofs.push({ cell: cellId, originalLod0: oldDescriptor, replacementLod0: cell.visual.lod0, lod1: cell.visual.lod1, lod2: cell.visual.lod2, collision: cell.collision });
}
assert.ok(cellReplacements.size, 'no facade images selected');
const indexPreservation = proveFacadeIndexPreservation(JSON.parse(indexBytes.toString('utf8')), index, new Set(cellReplacements.keys()));
if (typeof report.totals?.glbBytes === 'number') report.totals.glbBytes += byteDelta;
if (typeof report.totals?.ktx2Bytes === 'number') report.totals.ktx2Bytes += imageByteDelta;
report.ownerFacadeRepair = { schemaVersion: 1, status: 'EXPORTED_REQUIRES_RUNTIME_REVIEW', plan: receipt(values.plan), base: plan.base, references: plan.references, owners: ownerProofs, proofs, sourceIdentity,
  unchanged: ['all ground/building geometry and compressed payloads', 'all non-image GLB semantics except physical offsets', 'all unrelated embedded images', 'all LOD1/LOD2 payloads and descriptors', 'all HCOL, terrain, scenery and ancillary files'],
  limits: ['Reference qualification is supplied by the authoring plan; this tool does not infer architecture.', 'Raw ungraded changes are constrained to reviewed source pixel rectangles. Grading can affect adjacent pixels only inside the selected page; atlas bleed extends eight pixels.', 'KTX2 compression/mips can alter reconstructed texels within the selected image. Unrelated encoded images stay byte exact.', 'Existing distant colour approximation is retained; visual acceptance requires review of the new encoded near facade.'] };
changed.set('cells.json', Buffer.from(JSON.stringify(index, null, 1) + '\n')); changed.set('report.json', Buffer.from(JSON.stringify(report, null, 1) + '\n'));
// Check sources once more after encoding, before creating any candidate output.
for (const source of sourceIdentity) pinned(source.file, source.sha256);
for (const ref of plan.references) pinned(ref.file, ref.sha256);
pinned(indexFile, plan.base.indexSha256); pinned(reportFile, plan.base.reportSha256);
for (const [file, hash] of inputPins) pinned(file, hash);
const inventory = cloneFacadeCandidate(base, values.out, changed);
const finalProof = { schemaVersion: 1, status: 'PASS_IMAGE_ONLY_PRESERVATION_RUNTIME_REVIEW_PENDING', base: plan.base, plan: receipt(values.plan),
  outputIndexSha256: facadeSha(changed.get('cells.json')!), outputReportSha256: facadeSha(changed.get('report.json')!), changedCellCount: cellReplacements.size, changedImageCount: imagePins.size, byteDelta, inventory, indexPreservation, proofs };
fs.writeFileSync(path.join(values.out, 'owner-facade-preservation.json'), JSON.stringify(finalProof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ out: values.out, status: finalProof.status, changedCells: cellReplacements.size, changedImages: imagePins.size, byteDelta, indexSha256: finalProof.outputIndexSha256 }));
