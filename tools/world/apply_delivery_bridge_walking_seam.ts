import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {validateBytes} from 'gltf-validator';
import {validateWorldManifest, type FileRef, type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {deliveryFile, readDeliveryFile, freshDeliveryDirectory} from './lib/delivery-city.ts';
import {deliverySha, decodeDeliverySimulation, encodeDeliverySimulation, decodeDeliveryCityGlb, deliveryCollisionBounds, embedDeliveryImages} from './lib/delivery-city-payloads.ts';
import {linkOrCopyDeliveryFile, resolveAppendDeliveryBudget, type AppendDeliveryBudget} from './lib/delivery-city-files.ts';
import {bindDeliveryProducer, verifyDeliveryProducer, publicDeliveryProducer} from './lib/delivery-city-provenance.ts';
import {prepareReviewedBridgeWalkingSeam, EAST_BRIDGE_WALKING_SEAM_PUBLICATION} from './lib/reviewed-bridge-walking-seam.ts';
import {readSerializedRoadFloor} from './lib/serialized-road-floor.ts';
import {loadGeoJsonPolygons} from './lib/geometry.ts';
import {appendInlandCollision} from './lib/delivery-inland-water.ts';
import {appendPartitionGroundVisual} from './lib/append-partition-ground-visual.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
interface Pin {path: string; sha256: string}
interface Plan {schemaVersion: 1; world: Pin; profile: Pin; baseProfile: Pin; proposal: Pin; independentReview: Pin; nativeRays: Pin; nativeCharacter: Pin; staticCensus: Pin; treeImpact: Pin; osm: Pin; streetParts: Pin; release: string; delivery: AppendDeliveryBudget}

/** Offline preflight is read-only. The append changes one walking seam's exact
 * visual/HCOL faces; it does not publish a mask, graph or runtime acceptance. */
export function prepareDeliveryBridgeWalkingSeam(planFile: string) {
  const planBytes = fs.readFileSync(planFile); assert.ok(planBytes.length <= 128 * 1024);
  const plan = JSON.parse(planBytes.toString()) as Plan;
  assert.deepEqual(Object.keys(plan).sort(), ['schemaVersion', 'world', 'profile', 'baseProfile', 'proposal', 'independentReview', 'nativeRays', 'nativeCharacter', 'staticCensus', 'treeImpact', 'osm', 'streetParts', 'release', 'delivery'].sort());
  assert.equal(plan.schemaVersion, 1); assert.match(plan.release, /^[a-z0-9][a-z0-9-]{0,95}$/);
  const budget = resolveAppendDeliveryBudget(plan.delivery), pins = new Map<string, string>();
  const read = (ref: Pin, cap = 64 * 1024 * 1024) => {assert.deepEqual(Object.keys(ref).sort(), ['path', 'sha256']); assert.match(ref.sha256, /^[a-f0-9]{64}$/); const info = fs.lstatSync(ref.path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= cap); const bytes = fs.readFileSync(ref.path); assert.equal(deliverySha(bytes), ref.sha256); pins.set(path.resolve(ref.path), ref.sha256); return bytes;};
  const json = (ref: Pin) => JSON.parse(read(ref).toString()), world = path.resolve(plan.world.path);
  const manifest = json({path: path.join(world, 'manifest.json'), sha256: plan.world.sha256}) as WorldManifest & {publicationFiles?: FileRef[]};
  assert.deepEqual(validateWorldManifest(manifest), []);
  assert.ok(!manifest.publicationFiles?.some(ref => ref.path === EAST_BRIDGE_WALKING_SEAM_PUBLICATION), 'Walking seam already published');
  assert.ok(manifest.publicationFiles?.some(ref => ref.path === 'publication/extra-bridges/selkamerensilta/profile.json' && ref.sha256 === plan.baseProfile.sha256));
  const profileBytes = read(plan.profile, 128 * 1024), baseBytes = read(plan.baseProfile), profile = JSON.parse(profileBytes.toString());
  const proposal = json(plan.proposal), independent = json(plan.independentReview), rays = json(plan.nativeRays), motion = json(plan.nativeCharacter), statics = json(plan.staticCensus), trees = json(plan.treeImpact);
  assert.equal(plan.proposal.sha256, profile.approvedProposalSha256); assert.equal(proposal.world.manifestSha256, plan.world.sha256);
  assert.equal(independent.proposal.sha256, plan.proposal.sha256); assert.equal(independent.status, 'PASS_INDEPENDENT_LITERAL_SOURCE_DOMAIN_AND_CONTINUOUS_UPPER_WALKING_FLOOR_PROPOSAL_ONLY');
  assert.equal(rays.status, 'PASS_IN_MEMORY_SERIALIZED_APPEND_AND_NATIVE_UPPER_LOWER_RAYS_PENDING_WORLD_SERIALIZATION_AND_TRAVEL');
  assert.equal(rays.inputs.proposal.sha256, plan.proposal.sha256); assert.equal(rays.inputs.manifest.sha256, plan.world.sha256); assert.equal(rays.upperRays.length, 60); assert.equal(rays.lowerFiniteHits, 257);
  assert.equal(motion.status, 'PASS_SIX_NATIVE_CHARACTER_UPPER_BRIDGE_TRAVERSALS_PENDING_FINAL_SERIALIZED_WORLD_AND_LIVE_CONTROLS'); assert.equal(motion.inputs.proposal.sha256, plan.proposal.sha256); assert.equal(motion.inputs.sourceWorld.manifestSha256, plan.world.sha256); assert.equal(motion.runs.length, 6); assert.equal(new Set(motion.runs.map((r: any) => r.offset + '/' + r.reverse)).size, 6);
  for (const run of motion.runs) assert.ok(run.ticks > 0 && run.ticks < 3000 && run.maximumTrackError <= .1 && run.expandedStaticCapsuleRadius === .44);
  assert.equal(statics.status, 'PASS_NO_UNRELATED_STATIC_INTERFERENCE_RETAINED_AUTHORED_SOFFIT_SKINS_EXPLICIT'); assert.equal(statics.proposal.sha256, plan.proposal.sha256); assert.equal(statics.world.manifestSha256, plan.world.sha256); assert.deepEqual(statics.unrelatedConflicts, []); assert.ok(statics.maximumExistingSkinProtrusionMetres < .001);
  assert.equal(trees.status, 'PASS_ALL_ACTUAL_BARK_ROOT_BOUNDS_SEPARATED_FROM_PROPOSED_PATCHES_BY_MORE_THAN_ONE_METRE'); assert.equal(trees.manifestSha256, plan.world.sha256); assert.equal(trees.proposalSha256, proposal.inputs.proposal.sha256); assert.ok(manifest.scenery); assert.equal(trees.scenerySha256, manifest.scenery.sha256); assert.ok(trees.rows.length === 1 && trees.rows[0].minimumBarkRootBoundsDistance > 1); assert.deepEqual(trees.rows[0].rootsWithinOneMetre, []);
  read(plan.streetParts); const osm = json(plan.osm), parts = loadGeoJsonPolygons(plan.streetParts.path, manifest.origin.originProjected[0], manifest.origin.originProjected[1], p => String(p.osan_id));
  const floor = readSerializedRoadFloor({directory: world, manifestSha256: plan.world.sha256}, [-2030, 864, -2026, 867], manifest.origin.id);
  const result = prepareReviewedBridgeWalkingSeam({profileBytes, baseProfileBytes: baseBytes, sourcePins: {osmSha256: plan.osm.sha256, streetPartsSha256: plan.streetParts.sha256}, parts, way: osm.elements.find((w: any) => w.type === 'way' && w.id === 42438829), floor: floor.triangles});
  const cell = manifest.cells.find(c => c.id === 'c_m16_p06'); assert.ok(cell); assert.equal(result.pieces.length, 60); assert.ok(result.pieces.every(p => p.cell === cell.id));
  const collision = appendInlandCollision(decodeDeliverySimulation(readDeliveryFile(world, cell.collision), cell.collision), result.pieces, true);
  assert.equal(collision.added, 60); assert.equal(collision.duplicates, 0); assert.equal(deliverySha(collision.bytes), rays.prospectiveDecodedCollisionSha256); assert.equal(deliverySha(collision.bytes), motion.prospectiveCollisionSha256);
  const verify = () => {for (const [file, sha256] of pins) assert.equal(deliverySha(fs.readFileSync(file)), sha256); assert.equal(deliverySha(fs.readFileSync(planFile)), deliverySha(planBytes));}; verify();
  return {plan, planBytes, manifest, world, profileBytes, budget, result, cell, collision, floor: floor.receipt, verify, summary: {status: 'PASS_READ_ONLY_WALKING_SEAM_PREFLIGHT_FINAL_WORLD_AND_ROUTE_GATES_PENDING', sourceManifestSha256: plan.world.sha256, profileSha256: plan.profile.sha256, faces: collision.added, prospectiveCollisionSha256: deliverySha(collision.bytes), role: 'upperWalking', expectedCompleteRoleFaces: {upperRoad: 252, upperWalking: 599, northernLower: 257}, evidence: Object.fromEntries(['proposal', 'independentReview', 'nativeRays', 'nativeCharacter', 'staticCensus', 'treeImpact'].map(key => [key, (plan as any)[key].sha256]))}};
}

export async function applyDeliveryBridgeWalkingSeam(planFile: string, output: string) {
  const producer = bindDeliveryProducer(new URL(import.meta.url)), prepared = prepareDeliveryBridgeWalkingSeam(planFile), {plan, manifest, world, profileBytes, budget, result, cell, collision} = prepared;
  const out = path.resolve(output); freshDeliveryDirectory(world, out);
  const next: any = structuredClone(manifest), target = next.cells.find((c: any) => c.id === cell.id)!, written = new Map<string, FileRef>();
  const put = (relative: string, bytes: Uint8Array) => {assert.ok(!written.has(relative)); const file = deliveryFile(out, relative); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes, {flag: 'wx'}); const ref = {path: relative, bytes: bytes.length, sha256: deliverySha(bytes)}; written.set(relative, ref); return ref;};
  const textures = new Map((manifest.sharedTextures ?? []).map(ref => ['../' + ref.path, ref])), aliases = new Map<string, typeof cell.visual.lod0>(), visuals = [];
  for (const [level, ref] of Object.entries(cell.visual)) {
    if (aliases.has(ref.path)) {(target.visual as any)[level] = aliases.get(ref.path); continue;}
    const bytes = readDeliveryFile(world, ref), images = new Map<string, Uint8Array>();
    for (const image of readFacadeGlb(bytes).json.images ?? []) {const uri = (image as any).uri; if (uri) {const texture = textures.get(uri); assert.ok(texture); images.set(uri, readDeliveryFile(world, texture));}}
    const appended = await appendPartitionGroundVisual(bytes, await decodeDeliveryCityGlb(bytes, images), result.pieces, level === 'lod2');
    const validation = await validateBytes(embedDeliveryImages(appended.bytes, images), {maxIssues: 100}); assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues.messages));
    const after = {...ref, ...put(`cells/${cell.id}.${level}.walking-seam.${deliverySha(appended.bytes).slice(0, 16)}.glb`, appended.bytes), triangles: appended.stats.triangles, drawCalls: appended.stats.drawCalls};
    (target.visual as any)[level] = after; aliases.set(ref.path, after); visuals.push({level, before: ref, after, proofs: appended.proofs, validationErrors: 0});
  }
  const encoded = encodeDeliverySimulation(collision.bytes);
  target.collision = {...cell.collision, ...put(`cells/${cell.id}.walking-seam.${deliverySha(encoded.bytes).slice(0, 16)}.hcol.gz`, encoded.bytes), compression: encoded.compression, decodedBytes: encoded.decodedBytes, decodedSha256: encoded.decodedSha256, ...deliveryCollisionBounds(collision.bytes, cell.boundsXZ)};
  const proof = {...prepared.summary, schemaVersion: 1, kind: 'source-bound-bridge-walking-seam-append', status: 'SERIALIZED_BRIDGE_WALKING_SEAM_FINAL_MASK_GRAPH_AND_NATIVE_TRAVEL_PENDING', producer: publicDeliveryProducer(producer), planSha256: deliverySha(prepared.planBytes), qualification: result.proof, collision: {before: cell.collision, after: target.collision, originalArrayPrefixesLiteral: true, added: collision.added}, visuals, preserved: {originalUpperAndLowerFloors: true, allOtherColliders: true, allOtherCells: true, terrain: true, roads: true, gameplay: true, scenery: true, textures: true}, delivery: budget};
  // Preserve every non-cell manifest field verbatim before publishing provenance.
  const {cells: oldCells, ...oldRest} = manifest, {cells: newCells, ...newRest} = next; assert.deepEqual(oldRest, newRest);
  for (const old of oldCells) if (old.id !== cell.id) assert.deepEqual(newCells.find((c: any) => c.id === old.id), old);
  const proofBytes = Buffer.from(JSON.stringify(proof) + '\n'), encodedProof = encodeDeliverySimulation(proofBytes);
  next.publicationFiles = [...manifest.publicationFiles ?? [], put(EAST_BRIDGE_WALKING_SEAM_PUBLICATION, profileBytes), {...put(`publication/extra-bridges/selkamerensilta/walking-seam.${deliverySha(proofBytes).slice(0, 16)}.json.gz`, encodedProof.bytes), compression: encodedProof.compression, decodedBytes: encodedProof.decodedBytes, decodedSha256: encodedProof.decodedSha256}];
  next.worldReleaseId = plan.release; next.builtAt = new Date().toISOString(); assert.deepEqual(validateWorldManifest(next), []);
  const refs = new Map<string, FileRef>(); const collect = (value: any) => {if (!value || typeof value !== 'object') return; if (typeof value.path === 'string' && typeof value.bytes === 'number' && typeof value.sha256 === 'string') {const ref = {path: value.path, bytes: value.bytes, sha256: value.sha256}; if (refs.has(ref.path)) assert.deepEqual(refs.get(ref.path), ref); refs.set(ref.path, ref);} Object.values(value).forEach(collect);}; collect(next);
  const final = Buffer.from(JSON.stringify(next, null, 1) + '\n'), worldBytes = final.length + [...refs.values()].reduce((sum, ref) => sum + ref.bytes, 0);
  assert.ok(budget.inclusive ? worldBytes <= budget.worldBudgetBytes : worldBytes < budget.worldBudgetBytes); assert.ok(refs.size + 1 < 10000);
  for (const ref of refs.values()) {const target = deliveryFile(out, ref.path); if (!written.has(ref.path)) {fs.mkdirSync(path.dirname(target), {recursive: true}); linkOrCopyDeliveryFile(deliveryFile(world, ref.path), target, ref);} else assert.equal(deliverySha(fs.readFileSync(target)), ref.sha256);}
  verifyDeliveryProducer(producer); prepared.verify(); fs.writeFileSync(path.join(out, 'manifest.json'), final, {flag: 'wx'});
  const summary = {...prepared.summary, status: 'SERIALIZED_BRIDGE_WALKING_SEAM_FINAL_MASK_GRAPH_AND_NATIVE_TRAVEL_PENDING', manifestSha256: deliverySha(final), worldBytes, files: refs.size + 1, affectedCells: [cell.id]}; fs.writeFileSync(out + '.receipt.json', JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'}); return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}, inspect: {type: 'boolean'}}}); assert.ok(values.plan);
  assert.ok(values.inspect ? !values.out : !!values.out, 'Use either --inspect or --out FRESH_DIRECTORY');
  console.log(JSON.stringify(values.inspect ? prepareDeliveryBridgeWalkingSeam(values.plan).summary : await applyDeliveryBridgeWalkingSeam(values.plan, values.out!)));
}
