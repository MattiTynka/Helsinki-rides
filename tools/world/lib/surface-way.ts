/** This release has one terrain surface. Underground/bridge ways need an authored
 * separate-height surface before they can contribute roads, stairs or footways. */
export function isSupportedSurfaceWay(tags: Record<string, string>): boolean {
  if (tags['tunnel'] && tags['tunnel'] !== 'no') return false;
  if (tags['bridge'] && tags['bridge'] !== 'no') return false;
  if (tags['indoor'] && tags['indoor'] !== 'no') return false;
  const layer = Number(tags['layer'] ?? 0);
  if (Number.isFinite(layer) && layer < 0) return false;
  return true;
}
