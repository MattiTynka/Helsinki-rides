// City cell and scenery material adaptation (decision 0003, decision 0023). `lit` keeps a flattened PBR material
// (`standard` class) or a cheaper Lambert material (`lambert` class, low tiers); materials marked `bakedLighting`
// (facade photos that already carry the flight's light) take most of their colour as emissive in both classes.
// `unlit` renders colour × texture only. The source is never modified: scenery sources belong to the asset library
// and may be adapted again for another class, and a mutated source would compound the baked diffuse factor.
import * as THREE from 'three';
import type { Lighting } from '../config.ts';
import type { MaterialClass } from './quality-tiers.ts';

/** Baked-light facades: emissive share of the texture colour, and the diffuse share left to the sun and sky. */
export const BAKED_EMISSIVE = 0.72, BAKED_DIFFUSE = 0.45;

export interface CityMaterialOptions {
  readonly lighting: Lighting;
  /** Anything but `lambert` keeps the standard class. */
  readonly materialClass?: MaterialClass;
}

type LitSource = THREE.Material & Partial<Pick<THREE.MeshStandardMaterial, 'map' | 'color' | 'emissive' | 'emissiveMap' | 'emissiveIntensity' | 'flatShading'>>;

/** Returns a new material; the caller decides whether the source can be disposed. */
export function adaptCityMaterial(source: THREE.Material, options: CityMaterialOptions): THREE.Material {
  if ((source as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    const clone = source.clone();
    clone.toneMapped = false;
    return clone;
  }
  const src = source as LitSource;
  if (options.lighting === 'unlit') {
    const basic = new THREE.MeshBasicMaterial({ map: src.map ?? null, side: src.side, transparent: src.transparent, alphaTest: src.alphaTest, opacity: src.opacity, vertexColors: src.vertexColors });
    if (src.color) basic.color.copy(src.color);
    basic.name = src.name;
    basic.toneMapped = false;
    return basic;
  }
  const baked = src.userData['bakedLighting'] === true && !!src.map;
  if (options.materialClass === 'lambert') {
    const lambert = new THREE.MeshLambertMaterial({
      map: src.map ?? null, side: src.side, transparent: src.transparent, opacity: src.opacity, alphaTest: src.alphaTest,
      vertexColors: src.vertexColors, depthWrite: src.depthWrite, depthTest: src.depthTest, toneMapped: src.toneMapped,
      emissiveMap: baked ? src.map! : src.emissiveMap ?? null, emissiveIntensity: src.emissiveIntensity ?? 1, flatShading: src.flatShading ?? false,
    });
    if (src.color) lambert.color.copy(src.color);
    if (src.emissive) lambert.emissive.copy(src.emissive);
    lambert.name = src.name;
    lambert.userData = { ...src.userData };
    if (baked) applyBakedLighting(lambert);
    return lambert;
  }
  const standard = source.clone() as THREE.MeshStandardMaterial;
  standard.roughness = 1;
  standard.metalness = 0;
  standard.envMapIntensity = 0;
  if (baked) { standard.emissiveMap = standard.map; applyBakedLighting(standard); }
  return standard;
}

function applyBakedLighting(material: THREE.MeshStandardMaterial | THREE.MeshLambertMaterial): void {
  material.emissive.setScalar(BAKED_EMISSIVE);
  material.color.multiplyScalar(BAKED_DIFFUSE);
}
