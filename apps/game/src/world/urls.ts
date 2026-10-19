import type { WorldManifest } from '@helsinki/world-schema';

/** Public, build-time configuration. These values never contain upload credentials. */
export interface WorldDeployment {
  readonly appBase: string;
  readonly pages: boolean;
  readonly worldBaseUrl: string | null;
  readonly release: string | null;
  readonly manifestSha256: string | null;
}

declare const __WORLD_DEPLOYMENT__: WorldDeployment;

export function runtimeDeployment(): WorldDeployment { return __WORLD_DEPLOYMENT__; }

export function validateReleaseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error('Invalid world release ID');
  }
  return value;
}

/** Keep every manifest reference below its immutable release directory, including later GLB loads. */
export function validatePayloadPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !value.split('/').every(segment =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error('World payload paths must be relative files without traversal, escapes, queries or fragments');
  }
  return value;
}

export function validateWorldBaseUrl(value: string): string {
  if (!value.startsWith('https://') || /[\\\s%?#]/.test(value)) throw new Error('World base URL must be an HTTPS directory URL');
  const url = new URL(value);
  const hostname = url.hostname;
  // The only cross-origin host is explicitly supplied by the release builder. Do not accept local/IP targets.
  if (url.username || url.password || url.port || !hostname.includes('.') || /^[\d.]+$/.test(hostname)
    || hostname.includes(':') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname)
    || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('World base URL must name an approved public HTTPS host without credentials or a custom port');
  }
  // Validate the original spelling before URL normalisation can hide a /../ component.
  const pathname = value.slice(value.indexOf('/', 'https://'.length));
  const hasPath = value.indexOf('/', 'https://'.length) !== -1;
  if (hasPath && pathname !== '/') validatePayloadPath(pathname.replace(/^\//, '').replace(/\/$/, ''));
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

export function createWorldDeployment(input: {
  appBase: string;
  pages: boolean;
  worldBaseUrl?: string;
  release?: string;
  manifestSha256?: string;
  requirePinned?: boolean;
}): WorldDeployment {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(input.appBase)) throw new Error('Application base must be a root-relative directory');
  const configured = [input.worldBaseUrl, input.release, input.manifestSha256].filter(value => value !== undefined && value !== '').length;
  if ((configured !== 0 && configured !== 3) || (input.requirePinned && configured !== 3)) {
    throw new Error('Set VITE_WORLD_BASE_URL, VITE_WORLD_RELEASE and VITE_WORLD_MANIFEST_SHA256 together before publishing');
  }
  if (!configured) return { appBase: input.appBase, pages: input.pages, worldBaseUrl: null, release: null, manifestSha256: null };
  if (!/^[a-fA-F0-9]{64}$/.test(input.manifestSha256!)) throw new Error('VITE_WORLD_MANIFEST_SHA256 must be a SHA-256 hex digest');
  return {
    appBase: input.appBase,
    pages: input.pages,
    worldBaseUrl: validateWorldBaseUrl(input.worldBaseUrl!),
    release: validateReleaseId(input.release),
    manifestSha256: input.manifestSha256!.toLowerCase(),
  };
}

export function selectedRelease(deployment: WorldDeployment, requested: string | null): string | null {
  return deployment.release ?? (requested ? validateReleaseId(requested) : null);
}

export function worldRootUrl(deployment: WorldDeployment): string {
  return deployment.worldBaseUrl ?? `${deployment.appBase}world/`;
}

export function worldReleaseUrl(deployment: WorldDeployment, release: string): string {
  validateReleaseId(release);
  if (deployment.release && release !== deployment.release) throw new Error('This build requires its pinned world release');
  return `${worldRootUrl(deployment)}${release}/`;
}

export function basisDecoderUrl(deployment: WorldDeployment): string { return `${deployment.appBase}basis/`; }

export function validateManifestPaths(manifest: WorldManifest): void {
  if (!Array.isArray(manifest.assets)) throw new Error('manifest: assets must be an array');
  const references = [manifest.terrain, manifest.roads, manifest.gameplay, ...manifest.assets];
  if (manifest.scenery) references.push(manifest.scenery);
  for (const cell of manifest.cells) {
    references.push(cell.collision, cell.visual.lod0);
    if (cell.visual.lod1) references.push(cell.visual.lod1);
    if (cell.visual.lod2) references.push(cell.visual.lod2);
  }
  for (const reference of references) validatePayloadPath(reference?.path);
}

export async function verifyManifestHash(bytes: Uint8Array, expected: string | null): Promise<void> {
  if (!expected) return;
  if (!globalThis.crypto?.subtle) throw new Error('This release requires HTTPS to verify its world manifest');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('World manifest integrity check failed; reload or contact the game maintainer');
}
