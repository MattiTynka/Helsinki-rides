// Hand-written structural validators (no schema library): each returns a list of problems, empty when valid.
import type { GameplayBundle, WorldManifest } from './types.ts';
import { validateSimulationFileRef } from './payload.ts';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec2 = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(isNum);
const isVec3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNum);

export function validateWorldManifest(m: unknown): string[] {
  const p: string[] = [];
  const x = m as Partial<WorldManifest>;
  if (!x || typeof x !== 'object') return ['manifest is not an object'];
  if (x.schemaVersion !== 2) p.push('schemaVersion must be 2');
  if (typeof x.worldReleaseId !== 'string' || !x.worldReleaseId) p.push('worldReleaseId missing');
  if (!x.origin || !isVec3(x.origin.originProjected)) p.push('origin.originProjected must be [E, N, H]');
  if (!isNum(x.cellSize) || x.cellSize <= 0) p.push('cellSize must be positive');
  if (!Array.isArray(x.boundsRuntimeXZ) || x.boundsRuntimeXZ.length !== 4) p.push('boundsRuntimeXZ must have 4 numbers');
  if (!Array.isArray(x.cells)) p.push('cells must be an array');
  else {
    const ids = new Set<string>();
    for (const c of x.cells) {
      if (ids.has(c.id)) p.push(`duplicate cell ${c.id}`);
      ids.add(c.id);
      if (!c.visual?.lod0?.path || !c.visual.lod0.sha256) p.push(`cell ${c.id} has no lod0`);
      if (!c.collision?.path || !c.collision.sha256) p.push(`cell ${c.id} has no collision`);
      else {
        for (const problem of validateSimulationFileRef(c.collision)) p.push(`cell ${c.id}: ${problem}`);
        const b = c.collision.boundsXZ;
        if (b !== undefined && !(Array.isArray(b) && b.length === 4 && b.every(isNum) && b[0]! <= b[2]! && b[1]! <= b[3]!)) p.push(`cell ${c.id}: collision boundsXZ must be [x0, z0, x1, z1]`);
      }
      if (!Array.isArray(c.buildings)) p.push(`cell ${c.id} has no building records`);
      else for (const b of c.buildings) {
        if (b.match === 'unmatched' && b.collider !== 'citymodel') p.push(`cell ${c.id}: unmatched building ${b.id} without a citymodel collider`);
      }
    }
  }
  if (!x.terrain?.path || !isNum(x.terrain.resolution)) p.push('terrain missing');
  else for (const problem of validateSimulationFileRef(x.terrain)) p.push(`terrain: ${problem}`);
  if (!x.roads?.path) p.push('roads missing');
  if (!x.gameplay?.path) p.push('gameplay missing');
  for (const asset of x.assets ?? []) if (asset.optimization !== undefined) {
    const proof = asset.optimization;
    if (proof.lossless !== true || !/^[0-9a-f]{64}$/.test(proof.sourceSha256) || !/^[0-9a-f]{64}$/.test(proof.semanticSha256)) p.push(`asset ${asset.id}: invalid lossless storage provenance`);
  }
  if (x.scenery !== undefined && (!x.scenery.path || !x.scenery.sha256)) p.push('scenery must be a file reference');
  if (x.scenery && !x.assets?.some(a => a.kind === 'scenery')) p.push('scenery without a scenery asset');
  if (x.sharedTextures !== undefined) {
    if (!Array.isArray(x.sharedTextures)) p.push('sharedTextures must be an array');
    else {
      const paths = new Set<string>();
      for (const ref of x.sharedTextures) {
        if (!ref || typeof ref.path !== 'string' || ref.path.length > 512
          || !ref.path.split('/').every((segment: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
          || !/\.(?:ktx2|png)$/.test(ref.path)) p.push('shared texture must be a relative KTX2 or PNG file');
        else if (paths.has(ref.path)) p.push(`duplicate shared texture ${ref.path}`);
        else paths.add(ref.path);
        if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) p.push('shared texture requires positive bytes and SHA-256');
      }
    }
  }
  if (x.sharedTexturesM1 !== undefined) {
    const shared = new Set(Array.isArray(x.sharedTextures) ? x.sharedTextures.map(ref => ref?.path) : []), sources = new Set<string>();
    if (!Array.isArray(x.sharedTexturesM1)) p.push('sharedTexturesM1 must be an array');
    else for (const ref of x.sharedTexturesM1) {
      if (!ref || typeof ref.path !== 'string' || !/^textures-m1\/[0-9a-f]{64}\.ktx2$/.test(ref.path) || ref.path !== `textures-m1/${ref.sha256}.ktx2`
        || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) p.push('reduced texture must be a content-addressed textures-m1 KTX2 file');
      else if (typeof ref.source !== 'string' || !ref.source.endsWith('.ktx2') || !shared.has(ref.source)) p.push(`reduced texture ${ref.path} must name a shared KTX2 texture`);
      else if (sources.has(ref.source)) p.push(`duplicate reduced texture for ${ref.source}`);
      else sources.add(ref.source);
    }
  }
  if (!Array.isArray(x.sources) || x.sources.length === 0) p.push('sources must list every data source');
  if (!Array.isArray(x.attribution) || x.attribution.length === 0) p.push('attribution missing');
  if (x.lighting !== 'unlit-facades' && x.lighting !== 'lit-facades') p.push('lighting decision missing');
  return p;
}

export function validateGameplayBundle(g: unknown): string[] {
  const p: string[] = [];
  const x = g as Partial<GameplayBundle>;
  if (!x || typeof x !== 'object') return ['gameplay is not an object'];
  if (x.schemaVersion !== 2) p.push('schemaVersion must be 2');
  if (!x.player || !isVec2(x.player.spawn?.position)) p.push('player.spawn.position must be [x, z]');
  if (!x.playArea || ![x.playArea.minX, x.playArea.maxX, x.playArea.minZ, x.playArea.maxZ].every(isNum)) p.push('playArea missing');
  const defs = new Set<string>();
  for (const d of x.vehicleDefinitions ?? []) {
    defs.add(d.id);
    if (!(d.massKg > 0)) p.push(`vehicle ${d.id}: massKg`);
    if (!Array.isArray(d.wheels) || d.wheels.length < 3) p.push(`vehicle ${d.id}: wheels`);
    if (!isVec3(d.collider?.halfExtents)) p.push(`vehicle ${d.id}: collider.halfExtents`);
    if (!(d.engine?.topSpeedMs > 0)) p.push(`vehicle ${d.id}: engine.topSpeedMs`);
    if (!(d.seat?.entryRadius > 0) || !Array.isArray(d.seat.exits) || d.seat.exits.length === 0) p.push(`vehicle ${d.id}: seat`);
    const ia = d.interaction;
    if (ia && (typeof ia.poses !== 'string' || !isVec3(ia.stage) || !isVec3(ia.windshieldStage) || !isVec2(ia.flippedStage)
      || !Array.isArray(ia.doorSweep) || !ia.doorSweep.length || !ia.doorSweep.every(isVec3)
      || !Array.isArray(ia.bonnetPath) || !ia.bonnetPath.length || !ia.bonnetPath.every(isVec3))) p.push(`vehicle ${d.id}: interaction`);
  }
  for (const v of x.vehicles ?? []) {
    if (!defs.has(v.definition)) p.push(`vehicle spawn ${v.id}: unknown definition ${v.definition}`);
    if (!isVec2(v.position)) p.push(`vehicle spawn ${v.id}: position`);
  }
  const anchors = x.anchors ?? [];
  if (!anchors.some(a => a.kind === 'hospital')) p.push('no hospital anchor');
  if (!anchors.some(a => a.kind === 'police')) p.push('no police anchor');
  for (const a of anchors) if (!a.destinationName) p.push(`anchor ${a.id}: destinationName names the real place`);
  if (!x.weapons?.some(w => w.id === 'pistol')) p.push('pistol weapon missing');
  if (!x.wanted || !Array.isArray(x.wanted.starThresholds) || x.wanted.starThresholds.length !== 5) p.push('wanted.starThresholds must have 5 entries');
  if (!x.wanted || !Array.isArray(x.wanted.unitCaps) || x.wanted.unitCaps.length !== 5) p.push('wanted.unitCaps must have 5 entries');
  if (!x.police || !Array.isArray(x.police.patrolSpawns) || x.police.patrolSpawns.length < 2) p.push('police.patrolSpawns needs at least two edges');
  return p;
}
