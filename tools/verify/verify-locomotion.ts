// Focused character-motion evidence using actual browser controls and the native review adapter.
// node tools/verify/verify-locomotion.ts --url http://127.0.0.1:5317/?review=1 --release apps/game/public/world/ID --out data/evidence/NEW_DIR
// Opens no extra debug surface. Captured JPEG sequences can be reviewed at 1x or 1/3x in review.html.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { Button, CHARACTER, type EncodedCommand, type SimState } from '../../packages/sim/src/index.ts';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5317/?review=1' },
  release: { type: 'string' }, out: { type: 'string' },
  preset: { type: 'string', default: 'standard' }, headful: { type: 'boolean', default: false },
  'capture-fps': { type: 'string', default: '10' }, 'officer-seconds': { type: 'string', default: '25' },
} });
if (!values.release || !values.out) throw new Error('--release and --out are required');
if (!['standard', 'low'].includes(values.preset)) throw new Error('--preset must be standard or low');
const captureFps = Number(values['capture-fps']);
const officerSeconds = Number(values['officer-seconds']);
if (!Number.isFinite(captureFps) || captureFps < 3 || captureFps > 20) throw new Error('--capture-fps must be 3–20');
if (!Number.isFinite(officerSeconds) || officerSeconds < 0 || officerSeconds > 60) throw new Error('--officer-seconds must be 0–60');
const out = values.out;
if (existsSync(out)) throw new Error(`${out} exists; evidence directories are never overwritten`);
mkdirSync(path.join(out, 'frames'), { recursive: true });
const releaseDir = values.release;
const manifestBytes = readFileSync(path.join(releaseDir, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'apps/game/src/render/characters.ts', 'apps/game/src/render/locomotion.ts', 'apps/game/src/render/assets.ts',
  'apps/game/src/input/input.ts', 'apps/game/src/game.ts', 'apps/game/src/testapi.ts',
  'packages/sim/src/character.ts', 'packages/sim/src/simulation.ts',
  'content/assets/character.contract.json', 'tools/verify/verify-locomotion.ts', 'tools/verify/lib/browser.ts',
  ...readdirSync('tools/blender').filter(file => file.endsWith('.py')).map(file => `tools/blender/${file}`),
];
const sourceIdentity = Object.fromEntries(sourceFiles.filter(existsSync).map(file => [file, sha256(readFileSync(file))]));
function git(args: string[]): string | null {
  try { return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim(); }
  catch { return null; }
}
const candidate = { head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain']), files: sourceIdentity };

interface Check { id: string; pass: boolean; detail: string }
interface Frame {
  file: string; wallMs: number; captureMs: number; tick: number; state: SimState;
  keys: string[]; input: 'keyboard' | 'mouse-and-keyboard';
}
interface Segment { id: string; frames: Frame[]; commands: EncodedCommand[]; start: SimState; end: SimState; wallMs: number }
const checks: Check[] = [];
const segments: Segment[] = [];
const check = (id: string, pass: boolean, detail: string) => { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const xzDistance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);

// Read the actual GLB JSON to bind clip identity/duration to the release bytes, independently of contract labels.
const characterAssets = manifest.assets.filter(asset => asset.kind === 'character').map(asset => {
  const bytes = readFileSync(path.join(releaseDir, asset.path));
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`invalid GLB ${asset.path}`);
  const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as {
    nodes?: { name?: string }[]; skins?: { joints: number[] }[];
    accessors?: { max?: number[] }[];
    animations?: { name?: string; channels: unknown[]; samplers: { input: number }[] }[];
  };
  const actualSha256 = sha256(bytes);
  check(`asset-${asset.id}`, actualSha256 === asset.sha256 && bytes.length === asset.bytes, `${bytes.length} bytes, ${actualSha256}`);
  return { id: asset.id, path: asset.path, sha256: actualSha256, bytes: bytes.length,
    joints: doc.skins?.[0]?.joints.map(j => doc.nodes?.[j]?.name ?? `#${j}`) ?? [],
    clips: doc.animations?.map(clip => ({ name: clip.name, tracks: clip.channels.length,
      seconds: Math.max(...clip.samplers.map(sampler => doc.accessors?.[sampler.input]?.max?.[0] ?? 0)) })) ?? [],
  };
});

const url = new URL(values.url);
url.searchParams.set('review', '1');
url.searchParams.set('preset', values.preset);
url.searchParams.set('release', manifest.worldReleaseId);
const session = await openGame(url.toString(), { headful: values.headful, width: 1100, height: 800, timeoutMs: 240000, videoDir: path.join(out, 'video') });
const { page } = session;
const held = new Set<string>();
type NativeWindow = Window & { __HELSINKI_GAME__: { commands(): EncodedCommand[]; reset(): void } };
const commandLog = () => page.evaluate(() => (window as unknown as NativeWindow).__HELSINKI_GAME__.commands());
const reset = () => page.evaluate(() => (window as unknown as NativeWindow).__HELSINKI_GAME__.reset());
async function keys(next: readonly string[]): Promise<void> {
  for (const code of [...held]) if (!next.includes(code)) { await page.keyboard.up(code); held.delete(code); }
  for (const code of next) if (!held.has(code)) { await page.keyboard.down(code); held.add(code); }
}
async function clearInput(): Promise<void> {
  await keys([]);
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
  await game.setCommand(page, null);
}
async function fresh(): Promise<void> {
  await clearInput();
  await game.pause(page);
  await reset();
  await game.setCamera(page, 0, -0.12);
  await game.resume(page);
  await sleep(250);
}
async function record(id: string, seconds: number, input: Frame['input'], act?: (state: SimState, elapsedSeconds: number) => Promise<void>, done?: (state: SimState) => boolean, fps = captureFps): Promise<Segment> {
  const start = await game.state(page);
  const logStart = (await commandLog()).length;
  const startMs = performance.now();
  const frames: Frame[] = [];
  let nextFrameMs = 0;
  do {
    const state = await game.state(page);
    const elapsed = (performance.now() - startMs) / 1000;
    if (act) await act(state, elapsed);
    const file = `frames/${id}-${String(frames.length).padStart(4, '0')}.jpg`;
    const before = performance.now();
    await page.screenshot({ path: path.join(out, file), type: 'jpeg', quality: 88 });
    frames.push({ file, wallMs: before - startMs, captureMs: performance.now() - before, tick: state.tick, state, keys: [...held], input });
    if (done?.(state)) break;
    nextFrameMs += 1000 / fps;
    const now = performance.now() - startMs;
    if (nextFrameMs < now) nextFrameMs = now;
    await sleep(Math.max(0, nextFrameMs - now));
  } while (performance.now() - startMs < seconds * 1000);
  const end = await game.state(page);
  const segment = { id, frames, commands: (await commandLog()).slice(logStart), start, end, wallMs: performance.now() - startMs };
  segments.push(segment);
  console.log(`captured ${id}: ${frames.length} frames, ticks ${start.tick}–${end.tick}, player ${end.player.clip}, ${end.player.speed.toFixed(2)} m/s`);
  return segment;
}
function movement(segment: Segment, clip: string, minMetres: number): void {
  const distance = xzDistance(segment.start.player.position, segment.end.player.position);
  const samples = segment.frames.filter(frame => frame.state.player.clip === clip && frame.state.player.speed > 0.5);
  check(segment.id, distance > minMetres && samples.length >= 2, `${distance.toFixed(2)} m displacement, ${samples.length} moving ${clip} samples`);
}

let failure: string | null = null;
let officerCoverage = officerSeconds === 0 ? 'SKIPPED' : 'INCOMPLETE';
let browserManifestSha256: string | null = null;
let resourceUrls: string[] = [];
try {
  await game.start(page);
  check('release', await game.release(page) === manifest.worldReleaseId, manifest.worldReleaseId);
  const loaded = await page.evaluate(async id => {
    const response = await fetch(`/world/${encodeURIComponent(id)}/manifest.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`manifest fetch ${response.status}`);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, manifest.worldReleaseId);
  browserManifestSha256 = sha256(new Uint8Array(loaded));
  check('served-manifest', browserManifestSha256 === sha256(manifestBytes), browserManifestSha256);
  resourceUrls = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));

  // The normal controls cover the full locomotion sequence: Alt+W walk, W run, Shift+W sprint.
  await fresh();
  await record('keyboard-idle', 0.6, 'keyboard');
  await keys(['KeyW', 'AltLeft']);
  const walk = await record('keyboard-walk', 2.2, 'keyboard');
  movement(walk, 'walk', 1.5);
  check('keyboard-alt-w-trace', walk.commands.some(command => command[1] > 0 && command[1] < 512 && (command[4] & Button.sprint) === 0), 'real Alt + W produces the bounded walk input');
  check('walk-speed', walk.frames.some(frame => Math.abs(frame.state.player.speed - CHARACTER.walk) < 0.08), 'Alt + W reaches 1.4 m/s');
  await keys(['KeyW', 'KeyA', 'AltLeft']);
  const diagonalWalk = await record('keyboard-diagonal-walk', 1, 'keyboard');
  movement(diagonalWalk, 'walk', 0.8);
  check('diagonal-walk-speed', diagonalWalk.frames.some(frame => Math.abs(frame.state.player.speed - CHARACTER.walk) < 0.08), 'Alt + W + A keeps the walking speed');
  check('diagonal-walk-trace', diagonalWalk.commands.some(command => command[0] < 0 && command[1] > 0 && Math.hypot(command[0], command[1]) < 512), 'diagonal walk vector stays below the run threshold');
  await keys(['KeyW']);
  const run = await record('keyboard-run', 2.2, 'keyboard');
  movement(run, 'run', 3);
  check('keyboard-w-trace', run.commands.some(command => command[1] === 1024 && (command[4] & Button.sprint) === 0), 'real W appears in per-tick encoded input');
  await game.pause(page);
  await sleep(800); // Allow the camera's render-time spring to settle while simulation and gait stay paused.
  const pausedTick = (await game.state(page)).tick;
  const pausedStart = await page.screenshot({ path: path.join(out, 'frames', 'paused-start.png') });
  await sleep(350);
  const pausedEnd = await page.screenshot({ path: path.join(out, 'frames', 'paused-end.png') });
  check('paused-tick', (await game.state(page)).tick === pausedTick, `simulation remains at tick ${pausedTick}`);
  const pausedPixelsStart = await sharp(pausedStart).raw().toBuffer();
  const pausedPixelsEnd = await sharp(pausedEnd).raw().toBuffer();
  let pausedPixelDelta = 0;
  for (let i = 0; i < pausedPixelsStart.length; i++) pausedPixelDelta = Math.max(pausedPixelDelta, Math.abs(pausedPixelsStart[i]! - pausedPixelsEnd[i]!));
  // Subpixel camera convergence and GPU rounding can change a channel by one 8-bit level.
  check('paused-animation', pausedPixelDelta <= 1, `paused rendered pixels differ by at most ${pausedPixelDelta}/255 (quantization tolerance 1/255)`);
  await game.resume(page);
  await keys(['KeyW', 'ShiftLeft']);
  const sprint = await record('keyboard-sprint', 2, 'keyboard');
  movement(sprint, 'sprint', 5);
  check('keyboard-shift-trace', sprint.commands.some(command => command[1] === 1024 && (command[4] & Button.sprint) !== 0), 'real W + Shift appears in per-tick encoded input');
  await keys(['KeyW']);
  movement(await record('keyboard-sprint-to-run', 1.2, 'keyboard'), 'run', 1.5);
  for (const [label, codes] of [['left', ['KeyW', 'KeyA']], ['right', ['KeyW', 'KeyD']], ['reverse', ['KeyS']]] as const) {
    await keys(codes);
    const turn = await record(`keyboard-${label}`, 1.1, 'keyboard');
    movement(turn, 'run', 1);
    const wantX = label === 'left' ? -1024 : label === 'right' ? 1024 : 0;
    const wantZ = label === 'reverse' ? -1024 : 1024;
    check(`keyboard-${label}-trace`, turn.commands.some(command => command[0] === wantX && command[1] === wantZ), codes.join(' + '));
  }
  await keys([]);
  const stop = await record('keyboard-stop', 0.9, 'keyboard');
  check('stop', stop.end.player.clip === 'idle' && stop.end.player.speed < 0.05 && xzDistance(stop.start.player.position, stop.end.player.position) < 0.3, `clip ${stop.end.player.clip}, speed ${stop.end.player.speed.toFixed(3)} m/s`);

  // Normal-keyboard approach to car-1 and F transitions; API camera aiming compensates for headless pointer lock.
  await fresh();
  await keys(['KeyW']);
  const approach = await record('keyboard-car-approach', 12, 'keyboard', async state => {
    const car = state.vehicles.find(vehicle => vehicle.id === 'car-1');
    if (car) await game.setCamera(page, Math.atan2(car.position[0] - state.player.position[0], car.position[2] - state.player.position[2]), -0.12);
  }, state => state.player.nearVehicle === 'car-1', Math.min(captureFps, 5));
  await keys([]);
  check('car-approach', approach.end.player.nearVehicle === 'car-1', `near ${approach.end.player.nearVehicle}`);
  let enteredKeySent = false;
  const enter = await record('keyboard-car-enter', 16, 'keyboard', async () => {
    if (!enteredKeySent) { enteredKeySent = true; await page.keyboard.press('KeyF'); }
  }, state => state.player.mode === 'driving');
  check('enter-car', enter.end.player.mode === 'driving' && enter.end.player.inVehicle === 'car-1', `mode ${enter.end.player.mode}, vehicle ${enter.end.player.inVehicle}`);
  check('keyboard-enter-trace', enter.commands.some(command => (command[4] & Button.interact) !== 0), 'real F appears in per-tick encoded input');
  // Let the previous interact tick clear before the next F edge.
  await record('keyboard-car-seated', 0.7, 'keyboard');
  let exitKeySent = false;
  const exit = await record('keyboard-car-exit', 5, 'keyboard', async () => {
    if (!exitKeySent) { exitKeySent = true; await page.keyboard.press('KeyF'); }
  }, state => state.player.mode === 'onFoot');
  check('exit-car', exit.end.player.mode === 'onFoot' && exit.end.player.inVehicle === null, `mode ${exit.end.player.mode}`);
  check('keyboard-exit-trace', exit.commands.some(command => (command[4] & Button.interact) !== 0), 'real F appears in per-tick encoded input');
  await keys(['KeyW']);
  movement(await record('keyboard-run-after-exit', 1.2, 'keyboard'), 'run', 1);
  await keys([]);

  if (officerSeconds > 0) {
    await fresh();
    // A separate fixture beside the initial Unioninkatu patrol; this is not evidence of walking here from spawn.
    // The crime, response, officer exit and pursuit still happen through ordinary simulation and real input.
    await game.teleport(page, -90, -230, 180);
    await sleep(300);
    // One real mouse click into the sky raises wanted naturally through the normal weapon/crime path.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounds');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await game.setCamera(page, 0, 1.15);
    await page.mouse.down({ button: 'left' });
    await record('mouse-wanted-trigger', 0.12, 'mouse-and-keyboard');
    await page.mouse.up({ button: 'left' });
    const officers = await record('officer-natural-response', officerSeconds, 'mouse-and-keyboard', async state => {
      const units = state.characters.filter(character => character.id !== 'player' && character.alive && character.inVehicle === null);
      const closest = units.toSorted((a, b) => xzDistance(a.position, state.player.position) - xzDistance(b.position, state.player.position))[0];
      if (closest) {
        const yaw = Math.atan2(closest.position[0] - state.player.position[0], closest.position[2] - state.player.position[2]);
        await game.setCamera(page, yaw, -0.12);
        // S retreats while the camera faces the officer, keeping the real pursuit visible for a few strides.
        await keys(xzDistance(closest.position, state.player.position) < 13 ? ['KeyS'] : []);
      } else await game.setCamera(page, 0, -0.12);
    }, undefined, Math.min(captureFps, 6));
    const moving = officers.frames.flatMap(frame => frame.state.characters.filter(character => character.id !== 'player' && character.inVehicle === null && character.speed > 1 && ['walk', 'run', 'sprint'].includes(character.clip)).map(character => ({ tick: frame.tick, character })));
    const fireSeen = (await game.events(page, 0)).some(event => event.type === 'fire');
    const wantedSeen = officers.frames.some(frame => frame.state.wanted.stars > 0);
    officerCoverage = moving.length >= 5 && fireSeen && wantedSeen ? 'CAPTURED_NOT_REVIEWED' : 'INCOMPLETE';
    console.log(`officer coverage ${officerCoverage}: ${moving.length} moving on-foot samples, fire ${fireSeen}, wanted ${wantedSeen}`);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  check('harness-completed', false, failure);
} finally {
  await clearInput().catch(() => {});
  check('console-errors', session.consoleErrors.length === 0, session.consoleErrors.slice(0, 5).join(' | ') || 'none');
  writeFileSync(path.join(out, 'console.log'), session.consoleLines.join('\n') + '\n');
  const status = checks.some(item => !item.pass) ? 'FAIL' : officerCoverage === 'INCOMPLETE' ? 'INCOMPLETE' : 'PASS';
  const report = {
    status, capturedAt: new Date().toISOString(), url: url.toString(), preset: values.preset,
    release: manifest.worldReleaseId, releaseManifestSha256: sha256(manifestBytes), browserManifestSha256,
    candidate, characterAssets, resourceUrls, checks, segments, officerCoverage, failure,
    visualReview: 'CAPTURED_NOT_REVIEWED',
    evidenceScope: 'Actual Alt/W/Shift/A/S/D/F keyboard input; optional real mouse crime followed by natural officer response. No scene-bone/mixer access is exposed by the existing test API. This harness checks movement and records visuals, not foot contacts, clip blending quality, performance budgets, or the full release journey.',
  };
  writeFileSync(path.join(out, 'locomotion.json'), JSON.stringify(report, null, 1) + '\n');
  // Use an inline JSON payload without injecting arbitrary source text into the review document.
  const index = JSON.stringify(segments.map(segment => ({ id: segment.id, frames: segment.frames.map(frame => ({ file: frame.file, wallMs: frame.wallMs, tick: frame.tick, clip: frame.state.player.clip, speed: frame.state.player.speed })) }))).replaceAll('<', '\\u003c');
  writeFileSync(path.join(out, 'review.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Locomotion capture review</title><style>body{margin:1rem;background:#17191c;color:#eee;font:16px system-ui}button,select,input{font:inherit;margin:.35rem}img{display:block;max-height:75vh;max-width:100%}p{max-width:70rem}</style><h1>Locomotion capture review</h1><p>Captured real-time browser frames. Slow playback changes presentation of these same frames. Movement/command observations are in locomotion.json; visual quality remains CAPTURED_NOT_REVIEWED until inspected.</p><select id="segment"></select><button id="play">Play / pause</button><select id="rate"><option value="1">1× normal</option><option value="0.333333">⅓× slow</option></select><input id="seek" type="range" min="0" value="0"><span id="label"></span><img id="frame" alt="Captured game frame"><script type="application/json" id="data">${index}</script><script>const segments=JSON.parse(document.getElementById('data').textContent);const select=document.getElementById('segment'),rate=document.getElementById('rate'),seek=document.getElementById('seek'),frame=document.getElementById('frame'),label=document.getElementById('label');let playing=false,last=0,position=0;for(const s of segments){const o=document.createElement('option');o.textContent=s.id;select.append(o)}function draw(){const s=segments[select.selectedIndex];if(!s||!s.frames.length)return;seek.max=s.frames.length-1;const f=s.frames[Number(seek.value)];frame.src=f.file;label.textContent='tick '+f.tick+' · '+f.clip+' · '+f.speed.toFixed(2)+' m/s · '+(f.wallMs/1000).toFixed(2)+' s'}select.onchange=()=>{seek.value=0;position=0;draw()};seek.oninput=()=>{position=segments[select.selectedIndex].frames[Number(seek.value)].wallMs;draw()};document.getElementById('play').onclick=()=>{playing=!playing;last=0};function animate(now){if(playing&&segments.length){const s=segments[select.selectedIndex];if(last)position+=(now-last)*Number(rate.value);if(position>s.frames[s.frames.length-1].wallMs)position=0;let i=0;while(i<s.frames.length-1&&s.frames[i+1].wallMs<=position)i++;if(Number(seek.value)!==i){seek.value=i;draw()}}last=now;requestAnimationFrame(animate)}draw();requestAnimationFrame(animate)</script></html>\n`);
  await session.close();
  console.log(`${status}: ${checks.filter(item => item.pass).length}/${checks.length} checks; visual sequences and review.html in ${out}`);
  if (status !== 'PASS') process.exitCode = 1;
}
