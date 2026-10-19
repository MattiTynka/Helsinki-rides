import { readConfig } from './config.ts';
import { Game } from './game.ts';
import { installTestApi } from './testapi.ts';

declare const __REVIEW_BUILD__: boolean;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;
const loadingFill = document.getElementById('loading-fill') as HTMLDivElement;

async function boot(): Promise<void> {
  const config = readConfig();
  const game = await Game.create(canvas, config, (done, total, label) => {
    loadingText.textContent = `Loading ${label} (${done}/${total})`;
    loadingFill.style.width = `${Math.round(done / total * 100)}%`;
  });
  loadingText.textContent = 'Click to play';
  loadingFill.style.width = '100%';
  game.start();
  const begin = () => {
    loading.classList.add('hidden');
    game.audio.start();
    if (!config.review) canvas.requestPointerLock?.();
  };
  loading.addEventListener('click', begin, { once: true });
  canvas.addEventListener('click', () => game.audio.start());
  // Review controls are a build capability; a URL flag only changes presentation.
  if (__REVIEW_BUILD__ || import.meta.env.DEV) {
    installTestApi(game, () => loading.classList.add('hidden'));
  }
  if (config.review) loading.classList.add('hidden');
}

boot().catch(err => {
  console.error(err);
  window.__HELSINKI_ERROR__ = String(err?.stack ?? err);
  loadingText.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
