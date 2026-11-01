// Drop-in places of the whole playable city, published beside the static base map as `basemap/places.json`
// (tools/world/build_drop_in_places.ts): every district with streets in it, its sub-districts, and the named streets the
// release's own addresses do not cover. Positions are runtime XZ on a carriageway.

export const PLACES_FORMAT = 'helsinki-drop-in-places-1';

export interface DropInPlace { readonly name: string; readonly position: readonly [x: number, z: number] }
export interface DropInDistrict extends DropInPlace {
  readonly areas: readonly DropInPlace[];
  readonly streets: readonly DropInPlace[];
}
export interface DropInPlaces { readonly format: typeof PLACES_FORMAT; readonly districts: DropInDistrict[] }

const isPlace = (p: unknown): p is DropInPlace => {
  const v = p as DropInPlace;
  return !!v && typeof v.name === 'string' && Array.isArray(v.position) && v.position.length === 2 && v.position.every(Number.isFinite);
};

/** The base map's places; empty when the release publishes none. */
export async function loadDropInPlaces(baseMapUrl: string, signal?: AbortSignal): Promise<DropInDistrict[]> {
  const response = await fetch(new URL('places.json', baseMapUrl), { signal });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`places.json: HTTP ${response.status}`);
  const value = await response.json() as DropInPlaces;
  if (value.format !== PLACES_FORMAT || !Array.isArray(value.districts)) throw new Error('places.json: unknown format');
  return value.districts.filter(d => isPlace(d) && Array.isArray(d.areas) && Array.isArray(d.streets))
    .map(d => ({ ...d, areas: d.areas.filter(isPlace), streets: d.streets.filter(isPlace) }));
}
