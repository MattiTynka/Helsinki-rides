import * as THREE from 'three';

export type SceneryLodLevel = 0 | 1 | 2;
export const SCENERY_LOD_DISTANCES = Object.freeze({ near: 120, nearExit: 132, far: 240, farExit: 264 });

/** Hysteresis is measured from the conservative crown sphere, never from a cell or tree origin. */
export function sceneryLodLevel(surfaceDistance: number, previous: SceneryLodLevel): SceneryLodLevel {
  if (surfaceDistance < SCENERY_LOD_DISTANCES.near) return 0;
  if (previous === 0 && surfaceDistance <= SCENERY_LOD_DISTANCES.nearExit) return 0;
  if (surfaceDistance > SCENERY_LOD_DISTANCES.farExit) return 2;
  if (previous === 2 && surfaceDistance >= SCENERY_LOD_DISTANCES.far) return 2;
  return 1;
}

export interface FoliageLods {
  mid: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  sourceCards: number;
  midCards: readonly number[];
  farCards: readonly number[];
  mandatoryCards: readonly number[];
}

/** Only complete independent source cards are selected. Attributes, UVs, colour, normals and winding stay exact.
 * Source crown extrema seed a nested spatial coverage ordering, so remote trees retain their canopy outline.
 * Both levels share the original vertex attributes and materials; only their small index arrays are new. */
export function createFoliageLods(source: THREE.BufferGeometry): FoliageLods | null {
  const positions = source.getAttribute('position'), index = source.getIndex();
  if (!positions || !index || index.count % 6 || index.count / 6 <= 160 || source.drawRange.start !== 0 || source.drawRange.count !== Infinity) return null;
  if (source.groups.length || Object.keys(source.morphAttributes).length) return null;
  const count = index.count / 6, cards: number[][] = [], centers: number[][] = [], owner = new Map<number, number>();
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let card = 0; card < count; card++) {
    const indices = Array.from({ length: 6 }, (_, k) => index.getX(card * 6 + k)), vertices = [...new Set(indices)];
    if (vertices.length !== 4 || new Set(indices.slice(0, 3)).size !== 3 || new Set(indices.slice(3)).size !== 3 || indices.slice(0, 3).filter(v => indices.slice(3).includes(v)).length !== 2) return null;
    const center = [0, 0, 0];
    for (const vertex of vertices) {
      if (vertex >= positions.count || owner.has(vertex)) return null;
      owner.set(vertex, card);
      const v = [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)];
      if (!v.every(Number.isFinite)) return null;
      for (let axis = 0; axis < 3; axis++) { center[axis]! += v[axis]! / 4; low[axis] = Math.min(low[axis]!, v[axis]!); high[axis] = Math.max(high[axis]!, v[axis]!); }
    }
    cards.push(indices); centers.push(center);
  }
  const mandatory = new Set<number>();
  // All26 signed axis/corner directions include every X/Y/Z extremum and a broad silhouette sample.
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (x === 0 && y === 0 && z === 0) continue;
    let best = -Infinity, selected = 0;
    for (let card = 0; card < count; card++) for (const vertex of new Set(cards[card]!)) {
      const value = positions.getX(vertex) * x + positions.getY(vertex) * y + positions.getZ(vertex) * z;
      if (value > best) { best = value; selected = card; }
    }
    mandatory.add(selected);
  }
  const sequence = [...mandatory].sort((a, b) => a - b), selected = new Uint8Array(count), distances = new Float64Array(count).fill(Infinity);
  const add = (card: number) => {
    selected[card] = 1;
    for (let k = 0; k < count; k++) {
      let distance = 0;
      for (let axis = 0; axis < 3; axis++) distance += ((centers[k]![axis]! - centers[card]![axis]!) / Math.max(1e-6, high[axis]! - low[axis]!)) ** 2;
      distances[k] = Math.min(distances[k]!, distance);
    }
  };
  for (const card of sequence) add(card);
  while (sequence.length < 160) {
    let best = -1, card = -1;
    for (let k = 0; k < count; k++) if (!selected[k] && distances[k]! > best) { best = distances[k]!; card = k; }
    if (card < 0) throw new Error('Foliage coverage ordering exhausted source cards');
    sequence.push(card); add(card);
  }
  const farCards = sequence.slice(0, 80).sort((a, b) => a - b), midCards = sequence.slice(0, 160).sort((a, b) => a - b);
  const level = (name: string, chosen: readonly number[]) => {
    const geometry = new THREE.BufferGeometry(); geometry.name = `${source.name}:${name}`;
    for (const [semantic, attribute] of Object.entries(source.attributes)) geometry.setAttribute(semantic, attribute);
    const values = chosen.flatMap(card => cards[card]!);
    geometry.setIndex(new THREE.BufferAttribute(positions.count > 65535 ? Uint32Array.from(values) : Uint16Array.from(values), 1));
    geometry.boundingBox = source.boundingBox?.clone() ?? null;
    geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
    return geometry;
  };
  return { mid: level('foliage-mid', midCards), far: level('foliage-far', farCards), sourceCards: count, midCards, farCards, mandatoryCards: [...mandatory].sort((a, b) => a - b) };
}
