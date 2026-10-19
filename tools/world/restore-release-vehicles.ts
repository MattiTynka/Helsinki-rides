// Add selected historical vehicles to a fresh immutable derivative; never roll back the current city.
import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateGameplayBundle, validateWorldManifest, type FileRef, type GameplayBundle, type WorldManifest } from '../../packages/world-schema/src/index.ts';

export interface RestoreReleaseVehiclesOptions {
  source: string;
  vehicleSource: string;
  out: string;
  vehicles: readonly string[];
  release: string;
  report?: string;
}

class RestorationError extends Error {}
function fail(message: string): never { throw new RestorationError(message); }
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function safeRelative(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value)
    || value.split('/').some(part => part === '.' || part === '..' || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))) fail('Unsafe payload path');
  if (value === 'manifest.json' || value === 'current.json') fail('A payload cannot replace release metadata');
  return value;
}

/** Check every ancestor too: a Windows junction is a symbolic link according to lstat. */
function checkedPath(value: string, mustExist: boolean): string {
  const absolute = path.resolve(value), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      if (mustExist) fail('Required release file or directory is missing');
      continue;
    }
    if (lstatSync(current).isSymbolicLink()) fail('Release paths must not contain symbolic links or junctions');
  }
  return absolute;
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return fail('Release JSON is unreadable or invalid'); }
}

function manifestAt(root: string): { manifest: WorldManifest; bytes: Buffer } {
  const file = checkedPath(path.join(root, 'manifest.json'), true), bytes = readFileSync(file);
  const value = readJson(file);
  let problems: string[];
  try { problems = validateWorldManifest(value); }
  catch { return fail('Native world manifest validation failed'); }
  if (problems.length) fail('Native world manifest validation failed');
  const manifest = value as WorldManifest;
  if (!Array.isArray(manifest.assets) || typeof manifest.origin.id !== 'string') fail('Native world asset or origin metadata is invalid');
  uniqueIds(manifest.assets, 'Duplicate or invalid asset ID');
  return { manifest, bytes };
}

function uniqueIds(items: readonly { readonly id: string }[], message: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !idPattern.test(item.id) || ids.has(item.id)) fail(message);
    ids.add(item.id);
  }
}

/** File references may also occur in publicationFiles or future additive native fields. */
function references(value: unknown, refs = new Map<string, FileRef>()): Map<string, FileRef> {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) { for (const item of value) references(item, refs); return refs; }
  const record = value as Record<string, unknown>;
  if ('path' in record) {
    const name = safeRelative(record.path);
    if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0 || typeof record.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.sha256)) fail('Payload references require exact byte sizes and SHA-256 pins');
    const ref = record as unknown as FileRef, previous = refs.get(name);
    if (previous && (previous.sha256 !== ref.sha256 || previous.bytes !== ref.bytes)) fail('Conflicting pins for a payload path');
    refs.set(name, ref);
  }
  for (const item of Object.values(record)) references(item, refs);
  return refs;
}

async function verifyRef(root: string, ref: FileRef): Promise<string> {
  const file = checkedPath(path.join(root, safeRelative(ref.path)), true), stat = lstatSync(file);
  if (!stat.isFile() || stat.size !== ref.bytes) fail('Payload size verification failed');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  if (hash.digest('hex') !== ref.sha256) fail('Payload SHA-256 verification failed');
  return file;
}

function gameplayAt(root: string, manifest: WorldManifest): GameplayBundle {
  const value = readJson(checkedPath(path.join(root, safeRelative(manifest.gameplay.path)), true));
  let problems: string[];
  try { problems = validateGameplayBundle(value); }
  catch { return fail('Native gameplay validation failed'); }
  if (problems.length) fail('Native gameplay validation failed');
  const gameplay = value as GameplayBundle;
  if (!Array.isArray(gameplay.vehicleDefinitions) || !Array.isArray(gameplay.vehicles) || gameplay.originId !== manifest.origin.id) fail('Gameplay origin or vehicle lists are invalid');
  uniqueIds(gameplay.vehicleDefinitions, 'Duplicate or invalid vehicle definition ID');
  uniqueIds(gameplay.vehicles, 'Duplicate or invalid vehicle spawn ID');
  return gameplay;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function restoreReleaseVehicles(options: RestoreReleaseVehiclesOptions) {
  let createdOutput: string | null = null;
  try {
    if (!idPattern.test(options.release) || !options.vehicles.length || options.vehicles.some(id => !idPattern.test(id))
      || new Set(options.vehicles).size !== options.vehicles.length) fail('Release and selected vehicle IDs must be valid and unique');
    const source = checkedPath(options.source, true), historical = checkedPath(options.vehicleSource, true);
    if (!lstatSync(source).isDirectory() || !lstatSync(historical).isDirectory()) fail('Release inputs must be directories');
    const out = checkedPath(options.out, false), parent = checkedPath(path.dirname(out), true);
    if (existsSync(out)) fail('Output release directory already exists');
    if (!lstatSync(parent).isDirectory() || isWithin(source, out) || isWithin(historical, out)
      || isWithin(out, source) || isWithin(out, historical)) fail('Output must be a fresh directory outside both input releases');
    const reportFile = options.report ? checkedPath(options.report, false) : null;
    if (reportFile && (existsSync(reportFile) || isWithin(source, reportFile) || isWithin(historical, reportFile) || isWithin(out, reportFile))) fail('Report must be a fresh file outside input and output releases');
    if (reportFile) checkedPath(path.dirname(reportFile), true);

    const current = manifestAt(source), old = manifestAt(historical);
    if (current.manifest.worldReleaseId === options.release || old.manifest.worldReleaseId === options.release) fail('Derivative must have a new release ID');
    if (!equal(current.manifest.origin, old.manifest.origin) || !equal(current.manifest.coordinateFrame, old.manifest.coordinateFrame)) fail('Vehicle source uses a different world origin or coordinate frame');
    const currentRefs = references(current.manifest);
    references(old.manifest); // Validate paths and pins even for historical payloads which are not copied.
    const files = new Map<string, { ref: FileRef; source: string }>();
    for (const ref of currentRefs.values()) files.set(ref.path, { ref, source: await verifyRef(source, ref) });
    await verifyRef(historical, old.manifest.gameplay);
    const gameplay = gameplayAt(source, current.manifest), oldGameplay = gameplayAt(historical, old.manifest);
    const definitions = options.vehicles.map(id => {
      if (gameplay.vehicleDefinitions.some(def => def.id === id)) fail('Selected vehicle definition already exists in the current release');
      const definition = oldGameplay.vehicleDefinitions.find(def => def.id === id);
      if (!definition) return fail('Selected historical vehicle definition is missing');
      return definition;
    });
    const selected = new Set(options.vehicles), spawns = oldGameplay.vehicles.filter(spawn => selected.has(spawn.definition));
    const currentSpawnIds = new Set(gameplay.vehicles.map(spawn => spawn.id));
    for (const id of selected) if (!spawns.some(spawn => spawn.definition === id)) fail('Selected historical vehicle has no spawn records');
    for (const spawn of spawns) {
      if (currentSpawnIds.has(spawn.id)) fail('Selected historical vehicle spawn ID conflicts with the current release');
      const [x, z] = spawn.position, area = gameplay.playArea;
      if (x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ) fail('Selected vehicle spawn lies outside the current playable area');
    }
    const assets: WorldManifest['assets'][number][] = [];
    for (const definition of definitions) {
      if (assets.some(asset => asset.id === definition.assetId)) continue;
      if (current.manifest.assets.some(asset => asset.id === definition.assetId)) fail('Selected historical vehicle asset ID conflicts with the current release');
      const asset = old.manifest.assets.find(asset => asset.id === definition.assetId && asset.kind === 'vehicle');
      if (!asset) fail('Selected historical vehicle asset is missing');
      const sourceFile = await verifyRef(historical, asset);
      const existing = files.get(asset.path);
      if (existing && (existing.ref.sha256 !== asset.sha256 || existing.ref.bytes !== asset.bytes)) fail('Selected historical asset payload path conflicts with the current release');
      files.set(asset.path, { ref: asset, source: sourceFile }); assets.push(asset);
    }
    const nextGameplay: GameplayBundle = { ...gameplay, vehicleDefinitions: [...gameplay.vehicleDefinitions, ...definitions], vehicles: [...gameplay.vehicles, ...spawns] };
    if (validateGameplayBundle(nextGameplay).length) fail('Merged gameplay validation failed');
    const gameplayBytes = Buffer.from(JSON.stringify(nextGameplay, null, 1) + '\n'), gameplayHash = sha(gameplayBytes);
    const nextGameplayRef: FileRef = { path: `gameplay.${gameplayHash.slice(0, 12)}.json`, bytes: gameplayBytes.length, sha256: gameplayHash };
    if (files.has(nextGameplayRef.path)) fail('New gameplay payload path collides with an existing payload');
    const manifest: WorldManifest = { ...current.manifest, worldReleaseId: options.release, builtAt: new Date().toISOString(), gameplay: nextGameplayRef, assets: [...current.manifest.assets, ...assets] };
    if (validateWorldManifest(manifest).length) fail('Derivative manifest validation failed');
    const outputRefs = references(manifest), manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n');
    let linkedPayloads = 0, copiedPayloads = 0, payloadBytes = 0;
    mkdirSync(out); createdOutput = out;
    for (const ref of outputRefs.values()) {
      const target = path.join(out, ref.path);
      mkdirSync(path.dirname(target), { recursive: true });
      if (ref.path === nextGameplayRef.path) writeFileSync(target, gameplayBytes, { flag: 'wx' });
      else {
        const input = files.get(ref.path);
        if (!input) fail('An output payload has no verified source');
        try { linkSync(input.source, target); linkedPayloads++; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          copyFileSync(input.source, target); copiedPayloads++;
        }
      }
      payloadBytes += ref.bytes;
    }
    writeFileSync(path.join(out, 'manifest.json'), manifestBytes, { flag: 'wx' });
    const receipt = {
      schemaVersion: 1, sourceRelease: current.manifest.worldReleaseId, vehicleSourceRelease: old.manifest.worldReleaseId, release: options.release,
      sourceManifestSha256: sha(current.bytes), vehicleSourceManifestSha256: sha(old.bytes), manifestSha256: sha(manifestBytes),
      files: outputRefs.size + 1, bytes: payloadBytes + manifestBytes.length, linkedPayloads, copiedPayloads,
      selectedVehicles: [...options.vehicles], addedAssetIds: assets.map(asset => asset.id), addedSpawnIds: spawns.map(spawn => spawn.id),
      preservation: { currentCells: 'byte exact', collision: 'byte exact', terrainAndRoads: 'byte exact', existingAssets: 'byte exact',
        existingGameplayFields: 'preserved; only selected definitions and spawn records appended', publicationFiles: 'byte exact', currentPointer: 'untouched' },
    };
    if (reportFile) writeFileSync(reportFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  } catch (error) {
    if (createdOutput) rmSync(createdOutput, { recursive: true, force: true });
    if (error instanceof RestorationError) throw error;
    throw new RestorationError('Vehicle release restoration failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, 'vehicle-source': { type: 'string' }, out: { type: 'string' }, vehicles: { type: 'string' }, release: { type: 'string' }, report: { type: 'string' } } });
    for (const key of ['source', 'vehicle-source', 'out', 'vehicles', 'release', 'report'] as const) if (!values[key]) fail('All release restoration CLI options are required');
    const receipt = await restoreReleaseVehicles({ source: values.source!, vehicleSource: values['vehicle-source']!, out: values.out!, vehicles: values.vehicles!.split(','), release: values.release!, report: values.report! });
    console.log(JSON.stringify(receipt));
  } catch (error) { console.error(error instanceof RestorationError ? error.message : 'Invalid release restoration command'); process.exitCode = 1; }
}
