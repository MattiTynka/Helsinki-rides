# three.js runtime

`assets/runtime/locomotion.ts` is the engine-side half: copy it into the game and wire it as below. The layers
below (aim, rifle, hand IK, finger curls, recoil) come from the Snow game, whose code is not bundled; implement
them with your own bone names.

## Wiring

```ts
const [gltf, clips] = await Promise.all([loader.loadAsync('/assets/char.glb'),
  fetch('/assets/char.clips.json').then((r) => r.json() as Promise<ClipMeta[]>)]);
const model = SkeletonUtils.clone(gltf.scene);            // one skeleton per instance; reset = fresh clone
model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = false; }); // skinned bounds do not follow clips
const mixer = new THREE.AnimationMixer(model);
const loco = new Locomotion(mixer, gltf.animations, clips);

// fixed 60 Hz step
root.rotation.y = yaw; root.position.x += v.x * dt; root.position.z += v.y * dt;   // controller owns translation
const local = new THREE.Vector2(v.x, v.y).rotateAround(new THREE.Vector2(), yaw);    // x = character left, y = forward
loco.update(dt, local);
mixer.update(dt);
root.updateMatrixWorld(true);
// procedural layers, in this order: lean -> arm swing -> aim spine -> weapon -> arm IK -> fingers
```

glTF is Y up and the exported character faces +Z (three.js yaw 0 = facing +Z, +X = character left).

## What the blend does

- Clips are grouped by direction (forward/back/left/right). The velocity direction splits weight between groups
  (cosine/sine), and inside a group the two clips whose speeds bracket the current speed share it linearly.
  Missing directions fall back to forward.
- All loops share one normalised gait phase, advanced by the weighted cycle duration and scaled by actual/clip speed
  (clamped 0.35-1.6), so feet stay planted between clip speeds.
- Idle fades in below about half the slowest clip's speed.
- Input velocity is smoothed (`k = 1 - exp(-(accelerating ? 6 : 9) * dt)`) so gait changes are not instant.

## Procedural layers (after the mixer)

- **Arm swing for running** (`widenArmSwing`): Kimodo runs carried small arm swings (Snow run: upper arm 37-49°, wrist
  17-24 cm fore-aft). Widening each arm's swing about the two arms' mean angle (antiphase arms → the mean is the cycle
  centre, lag-free) with `extra = 0.35 * smoothstep(speed, walk, run) * (1 - armedWeight)` gave 52-65° at run without
  touching the walk. Tune the 0.35, not the clips.
- **Lean into turns**: roll spine and chest about the forward axis by `-yawRate * speed * 0.035` (clamped ±0.14 rad).
- **Aim**: twist spine/ribcage/chest (25/30/45 %) toward the aim yaw, pitch 60 % on the spine and the rest on neck/head;
  blade the torso 0.4 rad so the support shoulder comes forward; cheek weld with a small head roll.
- **Weapon + hands**: place the weapon from the shoulder pocket (aim) or a low-ready grip point, then two-bone IK
  (analytic, pole hint) for both arms onto grip/foregrip, orient the wrist from the fingers/palm directions, and curl
  fingers about axes computed at bind time. Blend everything by the armed/aim weights.

Procedural layers run every step after `mixer.update()`, because the mixer rewrites the bone quaternions each update.

## Deterministic test API (dev builds only)

Expose `window.__GAME_TEST__` with `reset({seed, scenario})`, `step(ticks)`, `setPresentation({view})`, `render()`,
`snapshot()` (build id, tick, state, metrics). Scenarios write the **same input struct** the keyboard/mouse path writes.
Useful metrics: planted-foot slide (cm/s of the ankle while ankle and toe are down), hand-to-grip error, shots, speed.
The build id must match the served build in every capture.

## Demo video

A demo recorder freezes the real-time loop, drives a choreography through a scripted-input hook, steps the
simulation one 60 Hz tick per frame, renders with its own camera rigs and pipes JPEG frames from Playwright into ffmpeg
(`-f image2pipe -c:v mjpeg -i - -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -movflags +faststart`), so the video is
smooth regardless of capture speed. Viewport 1280×720 at deviceScaleFactor 1.5 gives 1080p. For shots fired from the
camera centre, the capture camera must reproduce the game camera exactly at fire time; iterate the aim yaw so the centre
ray hits the target. Hide the dev HUD; captions and end cards are DOM overlays. Re-record after every asset change and
look at full-resolution stills of joints, contacts and hands.
