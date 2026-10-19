import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createWorldDeployment } from './src/world/urls.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/** Pages contains the application and decoders only; world releases are separately licensed downloads. */
function pagesDecoders(): Plugin {
  return {
    name: 'pages-basis-decoders',
    generateBundle() {
      for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
        this.emitFile({ type: 'asset', fileName: `basis/${file}`, source: readFileSync(path.join(import.meta.dirname, 'public/basis', file)) });
      }
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
    plugins: pages ? [pagesDecoders()] : [],
    server: { fs: { allow: [repoRoot] } },
    build: {
      target: 'es2022', sourcemap: !pages, outDir: pages ? 'dist-pages' : 'dist', emptyOutDir: true,
      copyPublicDir: !pages, chunkSizeWarningLimit: 4000,
    },
    optimizeDeps: { exclude: ['@helsinki/sim', '@helsinki/world-schema'] },
  };
});
