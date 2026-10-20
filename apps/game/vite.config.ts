import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createWorldDeployment, worldReleaseUrl, type WorldDeployment } from './src/world/urls.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/** Pages contains the application, decoders and service worker only; world releases are separately licensed downloads. */
function pagesDecoders(): Plugin {
  return {
    name: 'pages-basis-decoders',
    generateBundle() {
      for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
        this.emitFile({ type: 'asset', fileName: `basis/${file}`, source: readFileSync(path.join(import.meta.dirname, 'public/basis', file)) });
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync(path.join(import.meta.dirname, 'sw.js')) });
    },
  };
}

/**
 * Rapier's compat build inlines its WebAssembly as base64 inside the JavaScript. Load the identical binary as a
 * separate, separately cached asset instead: `instantiateStreaming` compiles it while it downloads, and the main
 * bundle loses about 4 MB of base64. The build fails unless the inlined bytes equal the packaged binary exactly.
 */
function rapierWasmAsset(): Plugin {
  return {
    name: 'rapier-wasm-asset',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!.replaceAll('\\', '/');
      if (!file.endsWith('/rapier3d-deterministic-compat/dist/rapier.mjs')) return null;
      const call = /([A-Za-z_$][\w$]*)\.toByteArray\("([A-Za-z0-9+/=]{100000,})"\)\.buffer/.exec(code);
      if (!call) throw new Error('Rapier inline WebAssembly call site not found; update rapierWasmAsset for this Rapier version');
      const inline = Buffer.from(call[2]!, 'base64');
      const packaged = readFileSync(path.join(path.dirname(file), 'rapier_wasm3d_bg.wasm'));
      if (!inline.equals(packaged)) throw new Error('Rapier inline WebAssembly differs from rapier_wasm3d_bg.wasm');
      return { code: code.slice(0, call.index) + 'new URL("./rapier_wasm3d_bg.wasm", import.meta.url)' + code.slice(call.index + call[0].length), map: { mappings: '' } };
    },
  };
}

/** Start the pinned world manifest and the Rapier binary downloading while the application bundle loads. */
function startupPreloads(deployment: WorldDeployment): Plugin {
  return {
    name: 'startup-preloads',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        // Same CORS mode and credentials as the loader's and wasm-bindgen's fetch(), so the browser reuses them.
        const preload = (href: string, type?: string) => ({ tag: 'link', injectTo: 'head' as const,
          attrs: { rel: 'preload', as: 'fetch', crossorigin: 'anonymous', href, ...(type ? { type } : {}) } });
        const tags = [];
        if (deployment.release) tags.push(preload(`${worldReleaseUrl(deployment, deployment.release)}manifest.json`));
        const wasm = Object.values(context.bundle ?? {}).find(file => file.type === 'asset' && /(?:^|\/)rapier_wasm3d_bg[^/]*\.wasm$/.test(file.fileName));
        if (wasm) tags.push(preload(`${deployment.appBase}${wasm.fileName}`, 'application/wasm'));
        return tags;
      },
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const pages = mode === 'pages';
  const env = loadEnv(mode, import.meta.dirname, ['VITE_WORLD_', 'HELSINKI_PAGES_RELEASE']);
  const deployment = createWorldDeployment({
    appBase: pages ? '/Helsinki-rides/' : '/',
    pages,
    worldBaseUrl: env.VITE_WORLD_BASE_URL,
    release: env.VITE_WORLD_RELEASE,
    manifestSha256: env.VITE_WORLD_MANIFEST_SHA256,
    requirePinned: pages && env.HELSINKI_PAGES_RELEASE === '1',
  });
  return {
    root: import.meta.dirname,
    base: deployment.appBase,
    publicDir: 'public',
    define: { __REVIEW_BUILD__: JSON.stringify(mode === 'review'), __CAPTURE_REPLAY__: JSON.stringify(mode === 'review' || command === 'serve'), __WORLD_DEPLOYMENT__: JSON.stringify(deployment) },
    plugins: [rapierWasmAsset(), startupPreloads(deployment), ...(pages ? [pagesDecoders()] : [])],
    server: { fs: { allow: [repoRoot] } },
    build: {
      target: 'es2022', sourcemap: !pages, outDir: pages ? 'dist-pages' : 'dist', emptyOutDir: true,
      copyPublicDir: !pages, chunkSizeWarningLimit: 4000,
    },
    optimizeDeps: { exclude: ['@helsinki/sim', '@helsinki/world-schema'] },
  };
});
