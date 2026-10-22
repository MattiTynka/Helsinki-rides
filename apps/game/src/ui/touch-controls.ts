import { isTouchFirstDevice } from '../device.ts';
import { i18n, type MessageKey } from '../i18n/index.ts';
import type { Input } from '../input/input.ts';
import type { TouchRole } from '../input/touch-state.ts';

export interface TouchControlsState {
  readonly mode: string;
  readonly alive: boolean;
  readonly canInteract?: boolean;
  readonly canRecover?: boolean;
  /** Respawn/recovery generation, if a transition happens between two presentation frames. */
  readonly contextKey?: string;
}
interface Preferences { mode: 'auto' | 'on' | 'off'; scale: number; mirror: boolean; sensitivity: number; }
const STORAGE_KEY = 'helsinki-rides:touch-controls';
const bounded = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function touchPreferences(value: unknown): Preferences {
  const p = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { mode: p.mode === 'on' || p.mode === 'off' ? p.mode : 'auto',
    scale: bounded(p.scale, 0.85, 1.25, 1), mirror: p.mirror === true,
    sensitivity: bounded(p.sensitivity, 0.5, 2, 1) };
}

function savedPreferences(): Preferences {
  try { return touchPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')); }
  catch { return touchPreferences(null); }
}

/** Touch controls write ordinary simulation commands; they never manufacture mouse/keyboard events. */
export class TouchControls {
  private readonly input: Input;
  readonly preferences: HTMLDetailsElement;
  readonly element: HTMLDivElement;
  private active = false;
  private state: TouchControlsState = { mode: 'onFoot', alive: true };
  private context: string | null = null;
  private presentationKey = '';
  private visible = false;
  private aimPresented = false;
  private readonly prefs = savedPreferences();
  private readonly labels: { element: HTMLElement; key: MessageKey }[] = [];
  private readonly buttons = new Map<TouchRole, HTMLButtonElement>();
  private readonly captured = new Map<number, HTMLElement>();
  private readonly cleanups: (() => void)[] = [];
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLSpanElement;
  private readonly modeChoice: HTMLSelectElement;
  private readonly autoTouch = isTouchFirstDevice();

  constructor(_canvas: HTMLCanvasElement, input: Input, options: { enabled?: boolean } = {}) {
    this.input = input;
    if (options.enabled !== undefined) this.prefs.mode = options.enabled ? 'on' : 'off';
    this.element = document.createElement('div'); this.element.id = 'touch-controls'; this.element.className = 'touch-controls hidden';
    this.element.setAttribute('aria-label', i18n.text('touch.controls'));
    const look = document.createElement('div'); look.className = 'touch-look'; look.setAttribute('aria-hidden', 'true');
    this.bind(look, 'look'); this.element.append(look);
    this.stick = document.createElement('div'); this.stick.className = 'touch-stick';
    this.stick.setAttribute('role', 'group'); this.stick.setAttribute('aria-label', i18n.text('touch.move'));
    const guide = document.createElement('span'); guide.className = 'touch-stick-guide'; this.label(guide, 'touch.move');
    this.knob = document.createElement('span'); this.knob.className = 'touch-stick-knob';
    this.stick.append(guide, this.knob); this.bind(this.stick, 'move'); this.element.append(this.stick);
    const actions = document.createElement('div'); actions.className = 'touch-actions';
    for (const [role, key] of [
      ['aim', 'touch.aim'], ['fire', 'touch.fire'], ['jump', 'touch.jump'], ['reload', 'touch.reload'],
      ['holster', 'touch.holster'], ['interact', 'touch.enter'], ['recover', 'touch.recover'],
      ['accelerate', 'touch.accelerate'], ['brake', 'touch.brake'], ['handbrake', 'touch.handbrake'], ['horn', 'touch.horn'],
    ] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `touch-button touch-${role}`;
      button.dataset.touchRole = role; this.label(button, key); this.bind(button, role);
      if (role === 'aim') button.setAttribute('aria-pressed', 'false');
      this.buttons.set(role, button); actions.append(button);
    }
    this.element.append(actions); document.body.append(this.element);

    this.preferences = document.createElement('details'); this.preferences.id = 'touch-preferences'; this.preferences.className = 'touch-preferences';
    const summary = document.createElement('summary'); this.label(summary, 'touch.settings'); this.preferences.append(summary);
    this.modeChoice = document.createElement('select'); this.modeChoice.id = 'touch-mode';
    for (const [value, key] of [['auto', 'touch.auto'], ['on', 'touch.on'], ['off', 'touch.off']] as const) {
      const option = document.createElement('option'); option.value = value; this.label(option, key); this.modeChoice.append(option);
    }
    this.modeChoice.value = this.prefs.mode;
    this.setting('touch.controls', this.modeChoice);
    this.modeChoice.addEventListener('change', () => {
      this.prefs.mode = this.modeChoice.value === 'on' ? 'on' : this.modeChoice.value === 'off' ? 'off' : 'auto';
      this.clear(); this.applyPreferences(); this.save();
    });
    const size = document.createElement('input'); size.type = 'range'; size.min = '0.85'; size.max = '1.25'; size.step = '0.05'; size.value = String(this.prefs.scale);
    this.setting('touch.size', size); size.addEventListener('input', () => { this.prefs.scale = Number(size.value); this.clear(); this.applyPreferences(); this.save(); });
    const sensitivity = document.createElement('input'); sensitivity.type = 'range'; sensitivity.min = '0.5'; sensitivity.max = '2'; sensitivity.step = '0.1'; sensitivity.value = String(this.prefs.sensitivity);
    this.setting('touch.sensitivity', sensitivity); sensitivity.addEventListener('input', () => { this.prefs.sensitivity = Number(sensitivity.value); this.applyPreferences(); this.save(); });
    const mirror = document.createElement('input'); mirror.type = 'checkbox'; mirror.checked = this.prefs.mirror;
    this.setting('touch.mirror', mirror); mirror.addEventListener('change', () => { this.prefs.mirror = mirror.checked; this.clear(); this.applyPreferences(); this.save(); });
    const hint = document.createElement('p'); this.label(hint, 'touch.hint'); this.preferences.append(hint);
    document.querySelector('.loading-main')?.append(this.preferences);
    const clear = () => this.clear();
    addEventListener('blur', clear); addEventListener('resize', clear);
    this.cleanups.push(() => { removeEventListener('blur', clear); removeEventListener('resize', clear); });
    const visibility = () => { if (document.hidden) this.clear(); };
    document.addEventListener('visibilitychange', visibility); this.cleanups.push(() => document.removeEventListener('visibilitychange', visibility));
    this.cleanups.push(i18n.subscribe(() => this.translate()));
    this.applyPreferences(); this.update(this.state);
  }

  get enabled(): boolean { return this.prefs.mode === 'on' || (this.prefs.mode === 'auto' && this.autoTouch); }
  setEnabled(enabled: boolean): void {
    this.prefs.mode = enabled ? 'on' : 'off'; this.modeChoice.value = this.prefs.mode;
    this.clear(); this.applyPreferences(); this.save();
  }
  setActive(active: boolean): void {
    if (active !== this.active) this.clear();
    this.active = active; this.refreshVisibility();
  }
  update(state: TouchControlsState): void {
    const context = `${state.mode}:${state.alive}:${state.contextKey ?? ''}`;
    if (this.context !== null && this.context !== context) this.clear();
    this.context = context; this.state = state;
    const driving = state.mode === 'driving' || state.mode === 'exiting';
    this.input.touch.setDriving(driving);
    const presentation = `${driving}:${Boolean(state.canInteract)}:${state.canRecover !== false}:${i18n.language}`;
    if (presentation !== this.presentationKey) {
      this.presentationKey = presentation; this.element.classList.toggle('touch-driving', driving);
      this.stick.querySelector('.touch-stick-guide')!.textContent = i18n.text(driving ? 'touch.steer' : 'touch.move');
      for (const role of ['aim', 'fire', 'jump', 'reload', 'holster'] as const) this.buttons.get(role)!.hidden = driving;
      for (const role of ['accelerate', 'brake', 'handbrake', 'horn'] as const) this.buttons.get(role)!.hidden = !driving;
      const interact = this.buttons.get('interact')!;
      interact.hidden = !driving && !state.canInteract;
      interact.textContent = i18n.text(driving ? 'touch.exit' : 'touch.enter');
      this.buttons.get('recover')!.hidden = state.canRecover === false;
    }
    if (this.aimPresented !== this.input.touch.aiming) {
      this.aimPresented = this.input.touch.aiming;
      this.buttons.get('aim')!.setAttribute('aria-pressed', String(this.aimPresented));
    }
    this.refreshVisibility();
  }
  dispose(): void {
    this.clear(); for (const cleanup of this.cleanups) cleanup(); this.element.remove(); this.preferences.remove();
    this.input.setTouchEnabled(false); document.body.classList.remove('touch-layout');
  }

  private label(element: HTMLElement, key: MessageKey): void { this.labels.push({ element, key }); element.textContent = i18n.template(key); }
  private setting(key: MessageKey, control: HTMLElement): void {
    const label = document.createElement('label'), text = document.createElement('span');
    this.label(text, key); label.append(text, control); this.preferences.append(label);
  }
  private translate(): void {
    for (const { element, key } of this.labels) element.textContent = i18n.template(key);
    this.element.setAttribute('aria-label', i18n.text('touch.controls')); this.stick.setAttribute('aria-label', i18n.text('touch.move'));
    this.update(this.state); this.setHint();
  }
  private setHint(): void {
    const hint = document.getElementById('loading-hint');
    if (hint) { hint.dataset.i18n = this.enabled ? 'touch.hint' : 'loading.hint'; hint.textContent = i18n.text(this.enabled ? 'touch.hint' : 'loading.hint'); }
  }
  private save(): void { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs)); } catch { /* Preferences still apply for this visit. */ } }
  private applyPreferences(): void {
    this.element.style.setProperty('--touch-scale', String(this.prefs.scale));
    this.element.classList.toggle('touch-mirrored', this.prefs.mirror);
    this.input.touch.lookSensitivity = 0.004 * this.prefs.sensitivity;
    this.input.setTouchEnabled(this.enabled); document.body.classList.toggle('touch-layout', this.enabled);
    this.setHint(); this.refreshVisibility();
  }
  private refreshVisibility(): void {
    const playableMode = this.state.mode === 'onFoot' || this.state.mode === 'driving' || this.state.mode === 'exiting';
    const visible = this.active && this.enabled && this.state.alive && playableMode;
    if (visible !== this.visible) { this.visible = visible; this.element.classList.toggle('hidden', !visible); }
    this.input.touch.setActive(visible && this.input.active);
  }
  private clear(): void {
    this.input.touch.reset(); this.knob.style.transform = 'translate(0px, 0px)';
    this.aimPresented = false; this.buttons.get('aim')?.setAttribute('aria-pressed', 'false');
    for (const [pointer, element] of this.captured) if (element.hasPointerCapture?.(pointer)) element.releasePointerCapture(pointer);
    this.captured.clear();
    for (const button of this.buttons.values()) button.classList.remove('pressed');
  }
  private bind(element: HTMLElement, role: TouchRole): void {
    const down = (event: PointerEvent): void => {
      if (!this.active || !this.enabled || !this.state.alive || !this.input.active) return;
      if (!this.input.touch.begin(event.pointerId, role, event.clientX, event.clientY)) return;
      event.preventDefault(); event.stopPropagation(); element.setPointerCapture(event.pointerId);
      this.captured.set(event.pointerId, element); element.classList.add('pressed');
      if (role === 'move') this.moveStick(event);
      if (role === 'aim') this.buttons.get('aim')!.setAttribute('aria-pressed', String(this.input.touch.aiming));
    };
    const move = (event: PointerEvent): void => {
      if (this.captured.get(event.pointerId) !== element) return;
      event.preventDefault(); this.input.touch.move(event.pointerId, event.clientX, event.clientY);
      if (role === 'move') this.moveStick(event);
    };
    const end = (event: PointerEvent): void => {
      if (this.captured.get(event.pointerId) !== element) return;
      event.preventDefault(); this.input.touch.end(event.pointerId, event.type !== 'pointerup');
      this.captured.delete(event.pointerId); element.classList.remove('pressed');
      if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
      if (role === 'move') this.knob.style.transform = 'translate(0px, 0px)';
    };
    element.addEventListener('pointerdown', down); element.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, end as EventListener);
    this.cleanups.push(() => {
      element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.removeEventListener(type, end as EventListener);
    });
  }
  private moveStick(event: PointerEvent): void {
    const rect = this.stick.getBoundingClientRect(), radius = rect.width / 2;
    const x = (event.clientX - rect.left - radius) / radius, y = (event.clientY - rect.top - rect.height / 2) / radius;
    this.input.touch.stick(event.pointerId, x, y);
    const scale = Math.min(1, 1 / (Math.hypot(x, y) || 1));
    this.knob.style.transform = `translate(${x * scale * radius * 0.65}px, ${y * scale * radius * 0.65}px)`;
  }
}
