import { PRESET_STORAGE_KEY, readConfig } from './config.ts';
import { Game } from './game.ts';
import { installTestApi } from './testapi.ts';
import { runtimeDeployment, worldReleaseUrl } from './world/urls.ts';

declare const __REVIEW_BUILD__: boolean;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;
const loadingFill = document.getElementById('loading-fill') as HTMLDivElement;

async function boot(): Promise<void> {
  const config = readConfig();
  registerServiceWorker();
  installGraphicsChoice(config.presetSource === 'auto' ? 'auto' : config.preset, config.presetSource === 'url');
  const game = await Game.create(canvas, config, (done, total, label) => {
    loadingText.textContent = `Loading ${label} (${done}/${total})`;
    loadingFill.style.width = `${Math.round(done / total * 100)}%`;
  });
  loadingText.textContent = 'Click to play';
  loadingFill.style.width = '100%';
  game.start();
  const begin = (event: MouseEvent) => {
    // Keep source/license links usable without consuming the play interaction.
    if (event.target instanceof Element && event.target.closest('a, #loading-credits, #graphics')) return;
    loading.removeEventListener('click', begin);
    loading.classList.add('hidden');
    game.audio.start();
    if (!config.review) canvas.requestPointerLock?.();
  };
  loading.addEventListener('click', begin);
  canvas.addEventListener('click', () => game.audio.start());
  // Review controls are a build capability; a URL flag only changes presentation.
  if (__REVIEW_BUILD__ || import.meta.env.DEV) {
    installTestApi(game, () => loading.classList.add('hidden'));
  }
  if (config.review) loading.classList.add('hidden');
}

/** The loading screen's graphics choice is saved for later visits; the preset is fixed per page load, so it reloads. */
function installGraphicsChoice(current: string, fromUrl: boolean): void {
  const select = document.getElementById('graphics-preset') as HTMLSelectElement | null;
  if (!select) return;
  select.value = current;
  // An explicit ?preset= wins over the saved choice; say so instead of offering a control that would not apply.
  if (fromUrl) { select.disabled = true; select.title = 'Set by the page address (?preset=)'; }
  select.addEventListener('change', () => {
    try {
      if (select.value === 'auto') localStorage.removeItem(PRESET_STORAGE_KEY);
      else localStorage.setItem(PRESET_STORAGE_KEY, select.value);
      location.reload();
    } catch {
      // Storage unavailable (private mode): carry the choice in the address instead.
      const url = new URL(location.href);
      if (select.value === 'auto') url.searchParams.delete('preset'); else url.searchParams.set('preset', select.value);
      location.assign(url);
    }
  });
}

/**
 * Published Pages builds cache their pinned world release and hashed assets for repeat visits (sw.js). `?sw=0`
 * removes the worker and its caches.
 */
function registerServiceWorker(): void {
  const deployment = runtimeDeployment();
  if (!deployment.pages || !deployment.release || !('serviceWorker' in navigator)) return;
  if (new URLSearchParams(location.search).get('sw') === '0') {
    void navigator.serviceWorker.getRegistrations().then(all => Promise.all(all.map(r => r.unregister())))
      .then(() => caches.keys()).then(keys => Promise.all(keys.filter(k => k.startsWith('helsinki-rides:')).map(k => caches.delete(k)))).catch(() => {});
    return;
  }
  const script = new URL(`${deployment.appBase}sw.js`, location.href);
  script.searchParams.set('id', deployment.release);
  script.searchParams.append('immutable', new URL(worldReleaseUrl(deployment, deployment.release), location.href).href);
  script.searchParams.append('immutable', new URL(`${deployment.appBase}assets/`, location.href).href);
  navigator.serviceWorker.register(script, { scope: deployment.appBase }).catch(error => console.warn('Offline cache unavailable', error));
}

boot().catch(err => {
  console.error(err);
  window.__HELSINKI_ERROR__ = String(err?.stack ?? err);
  loadingText.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
