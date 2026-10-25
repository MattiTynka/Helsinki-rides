// Contact shadows: a soft ellipse laid flat on the ground and cast away from the sun, in place of shadow maps (off for
// weak GPUs). It stays on the ground when its actor tilts, rolls or leaves the ground, sliding further down-sun and
// fading with height, so it no longer reads as a dark plate glued under the body.
import * as THREE from 'three';
import { SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG } from './scene.ts';

const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG), el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
/** Unit ground direction in which shadows fall (away from the sun; runtime +X east, +Z south). */
const DOWN_SUN = { x: -Math.sin(az), z: Math.cos(az) };
/** Horizontal shadow length per metre of height. */
const LENGTH_PER_METRE = 1 / Math.tan(el);
/** Height above the ground at which a shadow has faded out. */
const FADE_HEIGHT = 6;

let falloff: THREE.DataTexture | null = null;
/** Radial alpha falloff shared by every contact shadow: solid in the middle, soft towards the rim. */
export function contactShadowTexture(): THREE.DataTexture {
  if (falloff) return falloff;
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    const a = Math.round(255 * THREE.MathUtils.smoothstep(1 - r, 0, 0.55));
    data.set([a, a, a, a], (y * size + x) * 4);
  }
  falloff = new THREE.DataTexture(data, size, size);
  falloff.needsUpdate = true;
  return falloff;
}

/** Footprint and height of the actor that casts a shadow. */
export interface ShadowCaster {
  /** Half extents across and along the actor's heading, metres. */
  readonly halfWidth: number;
  readonly halfLength: number;
  /** Height of the actor's top above its base, metres. */
  readonly height: number;
}

const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const spin = new THREE.Quaternion(), turn = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
const position = new THREE.Vector3(), scale = new THREE.Vector3();

/** Places `shadow` (a 2 × 2 plane under a contact-shadow material) in world space; it ignores its parent's transform. */
export function placeContactShadow(shadow: THREE.Mesh, caster: ShadowCaster, x: number, z: number, groundY: number, yaw: number, lift: number): void {
  shadow.matrixAutoUpdate = false;
  shadow.matrixWorldAutoUpdate = false;
  const h = Math.max(0, lift);
  // Extent of the footprint along and across the shadow direction.
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const along = DOWN_SUN.x * fx + DOWN_SUN.z * fz, across = DOWN_SUN.x * fz - DOWN_SUN.z * fx;
  const extentAlong = Math.hypot(caster.halfLength * along, caster.halfWidth * across);
  const extentAcross = Math.hypot(caster.halfLength * across, caster.halfWidth * along);
  // The footprint swept down-sun from the base (lifted by `h`) to the top, as one ellipse.
  const near = h * LENGTH_PER_METRE, far = (h + caster.height) * LENGTH_PER_METRE;
  const centre = (near + far) / 2, spread = 1 + h * 0.15;
  position.set(x + DOWN_SUN.x * centre, groundY + 0.03, z + DOWN_SUN.z * centre);
  scale.set((extentAlong + (far - near) / 2) * spread, extentAcross * spread, 1);
  // The plane's local +X points down-sun, lying flat.
  spin.setFromAxisAngle(up, Math.atan2(-DOWN_SUN.z, DOWN_SUN.x));
  turn.copy(spin).multiply(flat);
  shadow.matrixWorld.compose(position, turn, scale);
  const material = shadow.material as THREE.MeshBasicMaterial;
  material.opacity = (shadow.userData.baseOpacity as number) * Math.max(0, 1 - h / FADE_HEIGHT);
  shadow.visible = material.opacity > 0.01;
}

/** A contact-shadow mesh with its own material copy (so it can fade on its own) and a falloff alpha map. */
export function createContactShadow(material: THREE.Material): THREE.Mesh {
  const own = material.clone() as THREE.MeshBasicMaterial;
  own.alphaMap = contactShadowTexture();
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), own);
  shadow.userData.baseOpacity = material.opacity;
  shadow.renderOrder = -1;
  shadow.frustumCulled = false;
  return shadow;
}
