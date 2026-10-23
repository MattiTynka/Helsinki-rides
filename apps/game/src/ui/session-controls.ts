import type { Game } from '../game.ts';
import { applyGraphicsChoice, FRAME_RATE_STORAGE_KEY } from '../config.ts';
import { i18n, type MessageKey } from '../i18n/index.ts';
import type { QualityTier } from '../render/quality-tiers.ts';
import type { TouchControls } from './touch-controls.ts';
import './session.css';

const QUALITY_LABELS: Readonly<Record<QualityTier, MessageKey>> = { standard: 'quality.standard', low: 'quality.low', minimal: 'quality.minimal' };

/** Player-owned pause state. Browser interruptions always require a fresh resume gesture. */
export class SessionControls {
  private readonly game: Game;
  private readonly canvas: HTMLCanvasElement;
  private readonly touch: TouchControls;
  private started = false;
  private graphicsLost = false;
  private readonly toolbar = document.createElement('div');
  private readonly panel = document.createElement('div');
  private readonly resumeButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly title = document.createElement('h2');
  private readonly note = document.createElement('p');
  private readonly preferences = document.createElement('div');
  private readonly frameRate = document.createElement('select');
  private readonly graphics = document.createElement('select');
  private readonly qualityStatus = document.createElement('p');
  private reason: MessageKey = 'session.interrupted';

  constructor(game: Game, canvas: HTMLCanvasElement, touch: TouchControls) {
    this.game = game; this.canvas = canvas; this.touch = touch;
    canvas.tabIndex = -1;
    this.toolbar.className = 'session-toolbar hidden';
    const pause = this.button('session.pause', () => this.pause());
    pause.id = 'pause-button';
    this.toolbar.append(pause);
    this.panel.id = 'pause-menu';
    this.panel.className = 'session-panel hidden';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'pause-title');
    this.title.id = 'pause-title';
    this.note.setAttribute('role', 'status');
    const box = document.createElement('div');
    box.className = 'session-box';
    box.append(this.title, this.note);
    this.resumeButton = this.button('session.resume', () => this.resume());
    this.resumeButton.id = 'resume-button';
    this.fullscreenButton = this.button('session.fullscreen', () => { void this.toggleFullscreen(); });
    const reload = this.button('session.reload', () => location.reload());
    reload.id = 'graphics-reload';
    reload.classList.add('hidden');
    this.preferences.className = 'session-preferences';
    const label = document.createElement('label');
    const caption = document.createElement('span');
    caption.dataset.sessionText = 'session.frameRate';
    label.append(caption, this.frameRate);
    this.frameRate.id = 'session-frame-rate';
    for (const fps of [30, 60] as const) {
      const option = document.createElement('option');
      option.value = String(fps);
      option.dataset.sessionText = fps === 30 ? 'session.fps30' : 'session.fps60';
      this.frameRate.append(option);
    }
    this.frameRate.value = String(game.targetFrameRate || 60);
    this.frameRate.addEventListener('change', () => {
      const fps = this.frameRate.value === '30' ? 30 : 60;
      try { localStorage.setItem(FRAME_RATE_STORAGE_KEY, String(fps)); } catch { /* The current session still applies it. */ }
      game.setFrameRate(fps);
    });
    // Same storage semantics as the loading screen: the preset is fixed per page load, so a change reloads.
    const graphicsLabel = document.createElement('label');
    const graphicsCaption = document.createElement('span');
    graphicsCaption.dataset.sessionText = 'graphics.quality';
    graphicsLabel.append(graphicsCaption, this.graphics);
    this.graphics.id = 'session-graphics';
    for (const [value, key] of [['auto', 'graphics.auto'], ['standard', 'graphics.standard'], ['low', 'graphics.low']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.dataset.sessionText = key;
      this.graphics.append(option);
    }
    this.graphics.value = game.config.presetSource === 'auto' ? 'auto' : game.config.preset;
    this.graphics.disabled = game.config.presetSource === 'url';
    this.graphics.addEventListener('change', () => {
      const value = this.graphics.value;
      applyGraphicsChoice(value === 'low' || value === 'standard' ? value : 'auto');
    });
    this.qualityStatus.id = 'session-quality';
    this.preferences.append(label, graphicsLabel, this.qualityStatus);
    const credits = document.createElement('details');
    credits.className = 'session-credits';
    const creditTitle = document.createElement('summary');
    creditTitle.dataset.sessionText = 'credits.heading';
    const creditText = document.createElement('p');
    creditText.textContent = game.data.manifest.attribution.join(' · ');
    const notices = document.createElement('a');
    notices.href = 'https://github.com/MattiTynka/Helsinki-rides/blob/main/THIRD_PARTY_NOTICES.md';
    notices.target = '_blank'; notices.rel = 'noopener noreferrer';
    notices.dataset.sessionText = 'credits.notices';
    credits.append(creditTitle, creditText, notices);
    box.append(this.resumeButton, this.fullscreenButton, this.preferences, credits, reload);
    this.panel.append(box);
    document.body.append(this.toolbar, this.panel);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    addEventListener('pagehide', () => this.pause());
    addEventListener('blur', () => this.pause());
    addEventListener('keydown', event => {
      if (event.code !== 'Escape' || !this.started || this.graphicsLost) return;
      event.preventDefault();
      // Escape releases desktop pointer lock first. Pausing never implicitly resumes gameplay.
      if (!this.game.paused) this.pause();
    });
    this.panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...this.panel.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, summary, a[href]')]
        .filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.graphicsLost = true;
      this.pause('session.contextLost');
      reload.classList.remove('hidden');
      this.resumeButton.disabled = true;
    });
    // Three.js restores its context, but the streamed scene's uploaded resources need a clean reload.
    canvas.addEventListener('webglcontextrestored', () => { if (this.graphicsLost) this.pause('session.contextLost'); });
    document.addEventListener('fullscreenchange', () => this.translate());
    i18n.subscribe(() => this.translate());
    this.translate();
    game.onStateChange = () => this.updateTouch();
  }

  begin(): void {
    this.started = true;
    this.toolbar.classList.remove('hidden');
    this.preferences.append(this.touch.preferences);
    if (this.graphicsLost) this.pause('session.contextLost');
    else this.resume();
  }

  pause(reason: MessageKey = 'session.interrupted'): void {
    if (!this.started) return;
    this.reason = reason;
    this.game.setPaused(true);
    this.touch.setActive(false);
    this.game.audio.suspend();
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.panel.classList.remove('hidden');
    this.translate();
    if (!document.hidden) this.resumeButton.focus({ preventScroll: true });
  }

  private resume(): void {
    if (!this.started || this.graphicsLost || document.hidden) return;
    this.panel.classList.add('hidden');
    this.game.audio.start();
    this.game.setPaused(false);
    this.updateTouch();
    this.canvas.focus({ preventScroll: true });
    if (!this.touch.enabled && !this.game.config.review) {
      try { void this.canvas.requestPointerLock?.()?.catch(() => {}); } catch { /* Windowed keyboard/gamepad play remains available. */ }
    }
  }

  private updateTouch(): void {
    const p = this.game.state.player;
    this.game.hud.touchControls = this.touch.enabled;
    this.touch.update({ mode: p.mode, alive: p.alive, canInteract: !!p.nearVehicle, canRecover: true });
    this.touch.setActive(this.started && !this.game.paused && !this.game.visualLoading.blocked
      && !this.game.collisionLoading.blocked && !this.game.collisionLoading.teleporting && !this.game.modelLoading.blocked);
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else throw new Error('unsupported');
    } catch {
      this.reason = 'session.fullscreenUnavailable';
      this.translate();
    }
  }

  private button(key: MessageKey, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.sessionText = key;
    button.addEventListener('click', onClick);
    return button;
  }

  private translate(): void {
    for (const root of [this.toolbar, this.panel]) for (const element of root.querySelectorAll<HTMLElement>('[data-session-text]')) {
      element.textContent = i18n.template(element.dataset.sessionText as MessageKey);
    }
    this.title.textContent = i18n.text('session.paused');
    const tier = i18n.template(QUALITY_LABELS[this.game.stats.tier]);
    this.qualityStatus.textContent = i18n.text(this.game.config.presetSource === 'auto' ? 'quality.statusAuto' : 'quality.status', { tier });
    if (this.graphics.disabled) this.graphics.title = i18n.text('graphics.url');
    this.note.textContent = i18n.template(this.reason);
    this.fullscreenButton.textContent = i18n.text(document.fullscreenElement ? 'session.windowed' : 'session.fullscreen');
  }
}
