import { PRESET_STORAGE_KEY, readConfig } from './config.ts';
import { Game } from './game.ts';
import { installTestApi } from './testapi.ts';
import { runtimeDeployment, worldReleaseUrl } from './world/urls.ts';
import { i18n, progressLabel } from './i18n/index.ts';
import { installLanguageChoice } from './ui/language.ts';
import { TouchControls } from './ui/touch-controls.ts';
import { SessionControls } from './ui/session-controls.ts';

declare const __REVIEW_BUILD__: boolean;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;
const loadingFill = document.getElementById('loading-fill') as HTMLDivElement;
const playButton = document.getElementById('play-button') as HTMLButtonElement | null;
let startup: { kind: 'initial' } | { kind: 'progress'; done: number; total: number; label: string } | { kind: 'ready' } | { kind: 'failed' } = { kind: 'initial' };

function showStartupStatus(): void {
  loadingText.textContent = startup.kind === 'progress'
    ? i18n.text('loading.progress', { label: progressLabel(startup.label), done: i18n.number(startup.done), total: i18n.number(startup.total) })
    : i18n.text(startup.kind === 'ready' ? 'loading.ready' : startup.kind === 'failed' ? 'loading.failed' : 'loading.initial');
}

installLanguageChoice();
showStartupStatus();
i18n.subscribe(showStartupStatus);

async function boot(): Promise<void> {
  const config = readConfig();
  registerServiceWorker();
  installGraphicsChoice(config.presetSource === 'auto' ? 'auto' : config.preset, config.presetSource === 'url');
  const game = await Game.create(canvas, config, (done, total, label) => {
    startup = { kind: 'progress', done, total, label }; showStartupStatus();
    loadingFill.style.width = `${Math.round(done / total * 100)}%`;
  });
  startup = { kind: 'ready' }; showStartupStatus();
  if (playButton) playButton.disabled = false;
  loadingFill.style.width = '100%';
  const touch = new TouchControls(canvas, game.input);
  const session = new SessionControls(game, canvas, touch);
  if (!config.review) game.setPaused(true);
  game.start();
  const begin = (event: MouseEvent) => {
    // Keep source/license links usable without consuming the play interaction.
    if (event.target instanceof Element && event.target.closest('a, #loading-credits, #graphics, #language-choice, #touch-preferences')) return;
    loading.removeEventListener('click', begin);
    loading.classList.add('hidden');
    session.begin();
  };
  loading.addEventListener('click', begin);
  canvas.addEventListener('click', () => game.audio.start());
  // Review controls are a build capability; a URL flag only changes presentation.
  if (__REVIEW_BUILD__ || import.meta.env.DEV) {
    installTestApi(game, () => loading.classList.add('hidden'));
  }
  if (config.review) { loading.classList.add('hidden'); session.begin(); }
}

/** The loading screen's graphics choice is saved for later visits; the preset is fixed per page load, so it reloads. */
function installGraphicsChoice(current: string, fromUrl: boolean): void {
  const select = document.getElementById('graphics-preset') as HTMLSelectElement | null;
  if (!select) return;
  select.value = current;
  // An explicit ?preset= wins over the saved choice; say so instead of offering a control that would not apply.
  if (fromUrl) {
    select.disabled = true;
    const describe = (): void => { select.title = i18n.text('graphics.url'); };
    describe(); i18n.subscribe(describe);
  }
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
  startup = { kind: 'failed' }; showStartupStatus();
  if (playButton) {
    playButton.disabled = false;
    playButton.dataset.i18n = 'session.reload';
    playButton.textContent = i18n.text('session.reload');
    playButton.addEventListener('click', () => location.reload(), { once: true });
  }
});
