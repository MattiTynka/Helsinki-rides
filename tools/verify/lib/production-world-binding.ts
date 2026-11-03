import assert from 'node:assert/strict';
import {validatePayloadPath, validateReleaseId, validateWorldBaseUrl} from '../../../apps/game/src/world/urls.ts';

interface CellVisuals {readonly visual: {readonly lod0: {readonly path: string}; readonly lod1?: {readonly path: string}}}

/** Expected URLs come from the reviewed deployment, never from an observed redirect or arbitrary response. */
export function productionWorldBinding(input: {
  pageUrl: string; allowLive?: boolean; worldBaseUrl?: string; release: string; cells: readonly CellVisuals[];
}) {
  const page = new URL(input.pageUrl);
  assert.ok(!page.username && !page.password && !page.search && !page.hash, 'Use an ordinary application URL without credentials, query or fragment');
  const local = ['localhost', '127.0.0.1'].includes(page.hostname) && ['http:', 'https:'].includes(page.protocol);
  const live = input.allowLive === true && page.href === 'https://mattitynka.github.io/Helsinki-rides/';
  assert.ok(local || live, 'Only loopback or the explicitly selected Helsinki Rides live page may be verified');
  const release = validateReleaseId(input.release);
  let worldBase = new URL('world/', page).href;
  if (input.worldBaseUrl !== undefined) {
    worldBase = validateWorldBaseUrl(input.worldBaseUrl);
    assert.ok(worldBase === 'https://mattitynka.github.io/Helsinki-rides/world/' ||
      /^https:\/\/raw\.githubusercontent\.com\/MattiTynka\/Helsinki-rides\/[a-f0-9]{40}\/world\/$/.test(worldBase),
    'World base must use the reviewed Pages or commit-pinned GitHub raw provider');
  }
  const releaseBase = `${worldBase}${release}/`;
  const detailUrls = new Set(input.cells.flatMap(cell => [cell.visual.lod0.path, cell.visual.lod1?.path]
    .filter((p): p is string => p !== undefined).map(p => new URL(validatePayloadPath(p), releaseBase).href)));
  assert.ok(detailUrls.size > 0, 'Expected city visuals are required');
  return {pageUrl: page.href, worldBaseUrl: worldBase, releaseBase, manifestUrl: `${releaseBase}manifest.json`, detailUrls};
}
