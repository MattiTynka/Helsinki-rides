// Clips added to the original civilian skeletons (Mixamo-style 22 joints), leaving their geometry and skin untouched:
// - run and sprint from a motion-design export (Kimodo, retargeted in Blender to the same 22 joints plus a root), matched
//   joint by joint through skinning matrices, G_run(t) * IBM_run = G(t) * IBM, so the Blender round trip may reorient bones;
// - Snow's hand-keyed jump and climb poses, retargeted from the native71 skeleton by world rotation change with each
//   limb's rest direction aligned first (motion-design retarget.py: W = dG * C * R_rest).
// Only rotations and the hips' translation are written, as in the existing clips.
import assert from 'node:assert/strict';
import { readFacadeGlb } from '../world/lib/facade-glb.ts';

type Mat = Float64Array;
type Vec = readonly number[];
interface Glb { json: any; bin: Uint8Array }

const identity = (): Mat => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
function multiply(a: Mat, b: Mat): Mat {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = sum;
  }
  return out;
}
function invert(m: Mat): Mat {
  // Gauss-Jordan with partial pivoting on [M | I], rows read from the column-major matrix.
  const a = Array.from({ length: 4 }, (_, r) => [0, 1, 2, 3].map(c => m[c * 4 + r]!).concat([0, 1, 2, 3].map(c => Number(c === r))));
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    assert.ok(Math.abs(a[pivot]![col]!) > 1e-12, 'Singular joint matrix');
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const scale = a[col]![col]!;
    for (let k = 0; k < 8; k++) a[col]![k]! /= scale;
    for (let r = 0; r < 4; r++) if (r !== col) {
      const f = a[r]![col]!;
      for (let k = 0; k < 8; k++) a[r]![k]! -= f * a[col]![k]!;
    }
  }
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r]![4 + c]!;
  return out;
}
function compose(t: ArrayLike<number> = [0, 0, 0], q: ArrayLike<number> = [0, 0, 0, 1], s: ArrayLike<number> = [1, 1, 1]): Mat {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  return Float64Array.of(
    (1 - 2 * (y * y + z * z)) * s[0]!, 2 * (x * y + z * w) * s[0]!, 2 * (x * z - y * w) * s[0]!, 0,
    2 * (x * y - z * w) * s[1]!, (1 - 2 * (x * x + z * z)) * s[1]!, 2 * (y * z + x * w) * s[1]!, 0,
    2 * (x * z + y * w) * s[2]!, 2 * (y * z - x * w) * s[2]!, (1 - 2 * (x * x + y * y)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1);
}
function decompose(m: Mat): { t: number[]; q: number[]; s: number[] } {
  const s = [0, 4, 8].map(c => Math.hypot(m[c]!, m[c + 1]!, m[c + 2]!));
  const r = (row: number, col: number) => m[col * 4 + row]! / s[col]!;
  const trace = r(0, 0) + r(1, 1) + r(2, 2);
  let q: number[];
  if (trace > 0) { const k = 0.5 / Math.sqrt(trace + 1); q = [(r(2, 1) - r(1, 2)) * k, (r(0, 2) - r(2, 0)) * k, (r(1, 0) - r(0, 1)) * k, 0.25 / k]; }
  else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) { const k = 2 * Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)); q = [0.25 * k, (r(0, 1) + r(1, 0)) / k, (r(0, 2) + r(2, 0)) / k, (r(2, 1) - r(1, 2)) / k]; }
  else if (r(1, 1) > r(2, 2)) { const k = 2 * Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)); q = [(r(0, 1) + r(1, 0)) / k, 0.25 * k, (r(1, 2) + r(2, 1)) / k, (r(0, 2) - r(2, 0)) / k]; }
  else { const k = 2 * Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)); q = [(r(0, 2) + r(2, 0)) / k, (r(1, 2) + r(2, 1)) / k, 0.25 * k, (r(1, 0) - r(0, 1)) / k]; }
  const n = Math.hypot(...q);
  return { t: [m[12]!, m[13]!, m[14]!], q: q.map(v => v / n), s };
}
/** Rotation part of a joint matrix as a scale-free 4x4 (translation dropped). */
function rotationOf(m: Mat): Mat { return compose(undefined, decompose(m).q); }
function transpose(m: Mat): Mat {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c]!;
  return out;
}
const unit = (v: Vec) => { const n = Math.hypot(v[0]!, v[1]!, v[2]!); return [v[0]! / n, v[1]! / n, v[2]! / n]; };
/** Minimal rotation taking unit vector a onto unit vector b. */
function align(a: Vec, b: Vec): Mat {
  const v = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const c = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  assert.ok(c > -0.999999, 'Opposite rest directions');
  const w = 1 + c, n = Math.hypot(v[0]!, v[1]!, v[2]!, w);
  return compose(undefined, [v[0]! / n, v[1]! / n, v[2]! / n, w / n]);
}
const position = (m: Mat) => [m[12]!, m[13]!, m[14]!];
function slerp(a: Vec, b: Vec, t: number): number[] {
  let dot = a.reduce((sum, v, i) => sum + v * b[i]!, 0);
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  if (dot > 0.9995) { const q = a.map((v, i) => v + (sign * b[i]! - v) * t), n = Math.hypot(...q); return q.map(v => v / n); }
  const theta = Math.acos(dot), sin = Math.sin(theta), wa = Math.sin((1 - t) * theta) / sin, wb = sign * Math.sin(t * theta) / sin;
  return a.map((v, i) => v * wa + b[i]! * wb);
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor({ json, bin }: Glb, index: number): Float32Array {
  const a = json.accessors[index], view = json.bufferViews[a.bufferView], n = COMPONENTS[a.type]!;
  assert.equal(a.componentType, 5126, 'Float accessors expected');
  assert.ok(!a.sparse && (!view.byteStride || view.byteStride === n * 4), 'Tightly packed accessors expected');
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  // A copy: Buffer.slice would share memory, and its .buffer starts at the whole file.
  return new Float32Array(Uint8Array.from(bin.subarray(start, start + a.count * n * 4)).buffer);
}
function nodeLocal(node: any): Mat {
  return node.matrix ? Float64Array.from(node.matrix) : compose(node.translation, node.rotation, node.scale);
}
function parents(json: any): Int32Array {
  const parent = new Int32Array(json.nodes.length).fill(-1);
  json.nodes.forEach((n: any, i: number) => { for (const c of n.children ?? []) parent[c] = i; });
  return parent;
}
function worlds(json: any, local: (i: number) => Mat): Mat[] {
  const parent = parents(json), out: Mat[] = [];
  const world = (i: number): Mat => out[i] ??= parent[i]! < 0 ? local(i) : multiply(world(parent[i]!), local(i));
  json.nodes.forEach((_: any, i: number) => world(i));
  return out;
}
const nodeNamed = (json: any, name: string): number => {
  const i = json.nodes.findIndex((n: any) => n.name === name);
  assert.ok(i >= 0, `node ${name} missing`);
  return i;
};

/** The skinned joints of the target, its hips (the joint whose parent is no joint), and the rest world matrices. */
function skeleton(target: Glb) {
  const json = target.json, skin = json.skins[0], parent = parents(json);
  const joints = skin.joints as number[], jointSet = new Set(joints);
  const hips = joints.find(node => !jointSet.has(parent[node]!))!;
  return { json, joints, parent, hips, rest: worlds(json, i => nodeLocal(json.nodes[i])) };
}

/**
 * Writes per-frame joint world matrices as an animation: rotation tracks for every joint and a translation track for the
 * hips, keyed at `times`. Returns how far non-hips joints drift from their rest offsets, which must stay tiny.
 */
function appendAnimation(target: Glb, name: string, times: Float32Array, posed: (frame: number) => Map<number, Mat>) {
  const { json, joints, parent, hips, rest } = skeleton(target);
  assert.ok(!json.animations.some((a: any) => a.name === name), `${name} already present`);
  const frames = times.length, rotations = new Map<number, Float32Array>(joints.map(node => [node, new Float32Array(frames * 4)]));
  const hipsTranslation = new Float32Array(frames * 3);
  let offsetDrift = 0, scaleDrift = 0;
  for (let f = 0; f < frames; f++) {
    const world = posed(f);
    for (const node of joints) {
      const above = world.get(parent[node]!) ?? (parent[node]! >= 0 ? rest[parent[node]!]! : identity());
      const { t, q, s } = decompose(multiply(invert(above), world.get(node)!));
      const out = rotations.get(node)!;
      if (f > 0 && q.reduce((sum, v, c) => sum + v * out[(f - 1) * 4 + c]!, 0) < 0) for (let c = 0; c < 4; c++) q[c] = -q[c]!;
      out.set(q, f * 4);
      scaleDrift = Math.max(scaleDrift, ...s.map(v => Math.abs(v - 1)));
      if (node === hips) hipsTranslation.set(t, f * 3);
      else { const r = json.nodes[node].translation ?? [0, 0, 0]; offsetDrift = Math.max(offsetDrift, Math.hypot(t[0]! - r[0], t[1]! - r[1], t[2]! - r[2])); }
    }
  }
  const chunks: Uint8Array[] = [];
  const start = target.bin.length + (4 - target.bin.length % 4) % 4;
  let offset = start;
  const add = (data: Float32Array, type: string, extra: object = {}) => {
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: data.length / COMPONENTS[type]!, type, ...extra });
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    offset += data.byteLength;
    return json.accessors.length - 1;
  };
  const input = add(times, 'SCALAR', { min: [times[0]], max: [times[frames - 1]] });
  const samplers: any[] = [], channels: any[] = [];
  const track = (node: number, path: string, data: Float32Array, type: string) => {
    samplers.push({ input, output: add(data, type), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node, path } });
  };
  track(hips, 'translation', hipsTranslation, 'VEC3');
  for (const [node, data] of rotations) track(node, 'rotation', data, 'VEC4');
  json.animations.push({ name, channels, samplers });
  const bin = new Uint8Array(offset);
  bin.set(target.bin);
  for (let at = start, k = 0; k < chunks.length; at += chunks[k]!.byteLength, k++) bin.set(chunks[k]!, at);
  target.bin = bin;
  json.buffers[0].byteLength = bin.length;
  return { frames, seconds: times[frames - 1]!, offsetDrift, scaleDrift };
}

/** Adds each named loop of a motion-design export, time-scaled so its natural speed is `naturalSpeed` (m/s). */
export function spliceLocomotionClips(target: Glb, exportBytes: Uint8Array, clips: readonly { name: string; clipSpeed: number; naturalSpeed: number }[]) {
  const run = readFacadeGlb(exportBytes) as Glb, { json, joints } = skeleton(target);
  const runSkin = run.json.skins[0], name = (j: any, i: number) => j.nodes[i].name as string;
  const runJoint = new Map<string, number>(runSkin.joints.map((node: number, k: number) => [name(run.json, node), k]));
  const runIbm = accessor(run, runSkin.inverseBindMatrices), ibm = accessor(target, json.skins[0].inverseBindMatrices);
  const ibmAt = (a: Float32Array, k: number) => Float64Array.from(a.subarray(k * 16, k * 16 + 16));
  // Both exports must describe the same bind body; otherwise matching skinning matrices would move the mesh.
  let bindError = 0;
  for (const [k, node] of joints.entries()) {
    const r = runJoint.get(name(json, node));
    assert.ok(r !== undefined, `export lacks joint ${name(json, node)}`);
    bindError = Math.max(bindError, Math.hypot(...[12, 13, 14].map(i => invert(ibmAt(ibm, k))[i]! - invert(ibmAt(runIbm, r))[i]!)));
  }
  assert.ok(bindError < 0.005, `bind poses differ by ${bindError} m`);
  const receipts: Record<string, object> = {};
  for (const clip of clips) {
    const animation = run.json.animations.find((a: any) => a.name === clip.name);
    assert.ok(animation, `export lacks ${clip.name}`);
    assert.ok(animation.samplers.every((s: any) => s.input === animation.samplers[0].input && s.interpolation === 'LINEAR'), 'Shared LINEAR keys expected');
    const keyed = new Map<string, Float32Array>();
    for (const channel of animation.channels) keyed.set(`${channel.target.node}/${channel.target.path}`, accessor(run, animation.samplers[channel.sampler].output));
    const runLocal = (i: number, f: number) => {
      const node = run.json.nodes[i], at = (path: string, n: number) => keyed.get(`${i}/${path}`)?.subarray(f * n, f * n + n);
      return node.matrix ? nodeLocal(node) : compose(at('translation', 3) ?? node.translation, at('rotation', 4) ?? node.rotation, at('scale', 3) ?? node.scale);
    };
    const scale = clip.clipSpeed / clip.naturalSpeed, times = accessor(run, animation.samplers[0].input).map(t => t * scale);
    const result = appendAnimation(target, clip.name, times, f => {
      const runWorld = worlds(run.json, i => runLocal(i, f));
      return new Map(joints.map((node, k) => {
        const r = runJoint.get(name(json, node))!;
        return [node, multiply(multiply(runWorld[runSkin.joints[r]]!, ibmAt(runIbm, r)), invert(ibmAt(ibm, k)))];
      }));
    });
    // Bone lengths are the target's own; a drifting joint offset would mean the two skeletons disagree.
    assert.ok(result.offsetDrift < 0.002 && result.scaleDrift < 1e-3, `${clip.name} disagrees with the target skeleton (${JSON.stringify(result)})`);
    receipts[clip.name] = { ...result, timeScale: scale, bindErrorMetres: bindError };
  }
  return receipts;
}

/** Civilian joint <- native71 joint, and for limbs the joints that give each one's rest direction. */
const NATIVE: Record<string, { from: string; dir?: readonly [string, string] }> = {
  Hips: { from: 'DEF-Hips' }, Spine: { from: 'DEF-Spine' }, Spine1: { from: 'DEF-RibCage' }, Spine2: { from: 'DEF-Chest' },
  Neck: { from: 'DEF-Neck' }, Head: { from: 'DEF-Head' },
  ...Object.fromEntries((['Left', 'Right'] as const).flatMap(side => {
    const s = side === 'Left' ? 'L' : 'R';
    return [
      [`${side}Shoulder`, { from: `DEF-Shoulder.${s}`, dir: [`${side}Arm`, `DEF-UpperArm_1.${s}`] }],
      [`${side}Arm`, { from: `DEF-UpperArm_1.${s}`, dir: [`${side}ForeArm`, `DEF-Forearm_1.${s}`] }],
      [`${side}ForeArm`, { from: `DEF-Forearm_1.${s}`, dir: [`${side}Hand`, `DEF-Wrist.${s}`] }],
      [`${side}Hand`, { from: `DEF-Wrist.${s}` }],
      [`${side}UpLeg`, { from: `DEF-Thigh_1.${s}`, dir: [`${side}Leg`, `DEF-Knee_1.${s}`] }],
      [`${side}Leg`, { from: `DEF-Knee_1.${s}`, dir: [`${side}Foot`, `DEF-Foot.${s}`] }],
      [`${side}Foot`, { from: `DEF-Foot.${s}`, dir: [`${side}ToeBase`, `DEF-Toes.${s}`] }],
      [`${side}ToeBase`, { from: `DEF-Toes.${s}` }],
    ];
  })),
};
/** End joints with no child to aim along take their parent's rest correction. */
const LEAF_PARENT: Record<string, string> = { LeftHand: 'LeftForeArm', RightHand: 'RightForeArm', LeftToeBase: 'LeftFoot', RightToeBase: 'RightFoot' };

interface PoseTrack { readonly node: string; readonly path: string; readonly times: readonly number[]; readonly values: readonly number[] }
/**
 * Adds Snow's authored jump and climb poses (content/assets/snow-jump-poses.json, normalized time 0..1) under their own
 * names. `native` is the hero GLB whose rest skeleton they were authored on. Civilians never super-jump.
 */
export function addJumpPoses(target: Glb, poses: { clips: Record<string, { tracks: readonly PoseTrack[] }> }, native: { json: any }) {
  const { json, joints, rest, parent } = skeleton(target), nativeRest = worlds(native.json, i => nodeLocal(native.json.nodes[i]));
  const civ = (name: string) => nodeNamed(json, name), nat = (name: string) => nodeNamed(native.json, name);
  const jointName = new Map(joints.map(node => [node, json.nodes[node].name as string]));
  assert.deepEqual([...jointName.values()].sort(), Object.keys(NATIVE).sort(), 'Civilian joint set changed');
  const legHeight = (world: Mat[], l: number, r: number) => (world[l]![13]! + world[r]![13]!) / 2;
  const hipScale = legHeight(rest, civ('LeftUpLeg'), civ('RightUpLeg')) / legHeight(nativeRest, nat('DEF-Thigh_1.L'), nat('DEF-Thigh_1.R'));
  const correction = new Map<string, Mat>();
  for (const [name, { from, dir }] of Object.entries(NATIVE)) {
    if (!dir) continue;
    const a = unit(position(rest[civ(dir[0])]!).map((v, i) => v - position(rest[civ(name)]!)[i]!));
    const b = unit(position(nativeRest[nat(dir[1])]!).map((v, i) => v - position(nativeRest[nat(from)]!)[i]!));
    correction.set(name, align(a, b));
  }
  const clips = Object.entries(poses.clips).filter(([key]) => !key.startsWith('super_'));
  const receipts: Record<string, object> = {};
  for (const [key, clip] of clips) {
    const times = Float32Array.from([...new Set(clip.tracks.flatMap(t => t.times))].sort((a, b) => a - b));
    const sample = (track: PoseTrack, u: number) => {
      const n = track.path === 'quaternion' ? 4 : 3, next = track.times.findIndex(t => t > u);
      const k = next < 0 ? track.times.length - 2 : Math.max(0, next - 1);
      if (track.times.length === 1) return track.values.slice(0, n);
      const t0 = track.times[k]!, t1 = track.times[k + 1]!, w = Math.max(0, Math.min(1, (u - t0) / (t1 - t0)));
      const a = track.values.slice(k * n, k * n + n), b = track.values.slice(k * n + n, k * n + 2 * n);
      return n === 4 ? slerp(a, b, w) : a.map((v, i) => v + (b[i]! - v) * w);
    };
    const byNode = new Map<number, PoseTrack[]>();
    for (const track of clip.tracks) { const i = nat(track.node); byNode.set(i, [...(byNode.get(i) ?? []), track]); }
    const result = appendAnimation(target, key, times, f => {
      const u = times[f]!;
      const world = worlds(native.json, i => {
        const node = native.json.nodes[i], tracks = byNode.get(i);
        if (!tracks) return nodeLocal(node);
        const at = (path: string) => { const t = tracks.find(t => t.path === path); return t ? sample(t, u) : undefined; };
        return compose(at('position') ?? node.translation, at('quaternion') ?? node.rotation, node.scale);
      });
      const out = new Map<number, Mat>();
      const hipsFrom = nat('DEF-Hips'), hipsTo = civ('Hips');
      for (const node of joints) {
        const name = jointName.get(node)!, from = nat(NATIVE[name]!.from);
        const change = multiply(rotationOf(world[from]!), transpose(rotationOf(nativeRest[from]!)));
        const c = correction.get(name) ?? correction.get(LEAF_PARENT[name] ?? '') ?? identity();
        const m = multiply(multiply(change, c), rotationOf(rest[node]!));
        out.set(node, m);
      }
      // Joint positions follow from the hierarchy; only the hips carry the authored body offset, scaled to these legs.
      const offset = position(world[hipsFrom]!).map((v, i) => (v - position(nativeRest[hipsFrom]!)[i]!) * hipScale);
      const placed = new Map<number, Mat>();
      const place = (node: number): Mat => {
        const done = placed.get(node);
        if (done) return done;
        const m = Float64Array.from(out.get(node)!), p = parent[node]!;
        if (node === hipsTo) { const r = position(rest[node]!); m[12] = r[0]! + offset[0]!; m[13] = r[1]! + offset[1]!; m[14] = r[2]! + offset[2]!; }
        else {
          const parentWorld = place(p), local = multiply(invert(rest[p]!), rest[node]!);
          const at = multiply(parentWorld, compose(position(local)));
          m[12] = at[12]!; m[13] = at[13]!; m[14] = at[14]!;
        }
        placed.set(node, m);
        return m;
      };
      for (const node of joints) place(node);
      return placed;
    });
    assert.ok(result.offsetDrift < 1e-4 && result.scaleDrift < 1e-4, `${key}: ${JSON.stringify(result)}`);
    receipts[key] = { frames: result.frames };
  }
  return { hipScale, clips: receipts };
}
