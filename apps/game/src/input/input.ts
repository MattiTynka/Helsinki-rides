// Keyboard, mouse (pointer lock) and gamepad → one Command per tick (plan section 2).
import { Button, type Command } from '@helsinki/sim';
import { TouchState } from './touch-state.ts';

export class Input {
  readonly touch = new TouchState();
  private enabled = true;
  private touchEnabled = false;
  private readonly keys = new Set<string>();
  private mouseDx = 0;
  private mouseDy = 0;
  private mouseButtons = 0;
  private interactLatch = false;
  private holsterLatch = false;
  private jumpPresses = 0;
  private jumpPulseLastTick = false;
  private gamepadJumpHeld = false;
  private gamepadNeedsNeutral = false;
  locked = false;
  sensitivity = 0.0022;
  /** Review builds accept mouse buttons and movement without pointer lock (headless harnesses cannot lock). */
  readonly unlockedMouse: boolean;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, unlockedMouse = false) {
    this.canvas = canvas;
    this.unlockedMouse = unlockedMouse;
    this.touch.setActive(false);
    addEventListener('keydown', e => {
      if (!this.enabled) return;
      // Startup controls keep native Tab/Space/Enter behaviour and never send gameplay commands.
      if (document.getElementById?.('loading')?.classList.contains('hidden') === false
        || (e.target && e.target instanceof Element && e.target.closest('button, a, select, input, textarea, [contenteditable="true"]'))) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab', 'AltLeft', 'AltRight'].includes(e.code)) e.preventDefault();
      if (e.repeat || this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (e.code === 'KeyF' || e.code === 'Enter') this.interactLatch = true;
      if (e.code === 'KeyG') this.holsterLatch = true;
      if (e.code === 'Space') this.jumpPresses = Math.min(2, this.jumpPresses + 1);
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.reset());
    canvas.addEventListener('mousedown', e => { if (!this.enabled || this.touchEnabled) return; this.mouseButtons |= 1 << e.button; if (!this.locked && !this.unlockedMouse) canvas.requestPointerLock?.(); });
    addEventListener('mouseup', e => { this.mouseButtons &= ~(1 << e.button); });
    addEventListener('mousemove', e => { if (this.enabled && (this.locked || this.unlockedMouse)) { this.mouseDx += e.movementX; this.mouseDy += e.movementY; } });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; if (!this.locked && !this.unlockedMouse) this.mouseButtons = 0; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  get active(): boolean { return this.enabled; }

  setActive(active: boolean): void {
    if (active && !this.enabled) this.gamepadNeedsNeutral = true;
    if (!active || active !== this.enabled) this.reset();
    this.enabled = active; this.touch.setActive(active && this.touchEnabled);
  }

  setTouchEnabled(enabled: boolean): void {
    if (enabled !== this.touchEnabled) this.reset();
    this.touchEnabled = enabled; this.touch.setActive(this.enabled && enabled);
  }

  /** Lifecycle boundaries discard held controls and queued impulses, including latched touch aim. */
  reset(): void {
    this.keys.clear(); this.jumpPresses = 0; this.jumpPulseLastTick = false; this.gamepadJumpHeld = false;
    this.interactLatch = false; this.holsterLatch = false; this.mouseButtons = 0; this.mouseDx = 0; this.mouseDy = 0;
    this.touch.reset();
    const pad = navigator.getGamepads?.()[0];
    if (pad && (pad.axes.some(axis => Math.abs(axis) > 0.15) || pad.buttons.some(button => button.pressed || button.value > 0.05))) this.gamepadNeedsNeutral = true;
  }

  private get mouseActive(): boolean { return this.locked || this.unlockedMouse; }

  private activeGamepad(): Gamepad | null | undefined {
    const pad = navigator.getGamepads?.()[0];
    if (this.gamepadNeedsNeutral) {
      if (pad && (pad.axes.some(axis => Math.abs(axis) > 0.15) || pad.buttons.some(button => button.pressed || button.value > 0.05))) return undefined;
      this.gamepadNeedsNeutral = false;
    }
    return pad;
  }

  /** Consume accumulated mouse look (pixels). */
  takeLook(): [number, number] {
    if (!this.enabled) return [0, 0];
    const touch = this.touch.takeLook();
    const r: [number, number] = [this.mouseDx * this.sensitivity + touch[0], this.mouseDy * this.sensitivity + touch[1]];
    this.mouseDx = 0; this.mouseDy = 0;
    return r;
  }

  private axis(neg: string[], pos: string[]): number {
    let v = 0;
    if (neg.some(k => this.keys.has(k))) v -= 1;
    if (pos.some(k => this.keys.has(k))) v += 1;
    return v;
  }

  /** Build the command for the next tick; `yaw`/`pitch` come from the camera. */
  command(yaw: number, pitch: number, driving: boolean): Command {
    if (!this.enabled) return { moveX: 0, moveZ: 0, yaw, pitch, buttons: 0 };
    this.touch.setDriving(driving);
    let moveX = this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    let moveZ = this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    let buttons = 0;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) buttons |= Button.sprint;
    if (this.interactLatch) { buttons |= Button.interact; this.interactLatch = false; }
    if (this.holsterLatch) { if (!driving) buttons |= Button.holster; this.holsterLatch = false; }
    if ((this.mouseButtons & 1) !== 0 && this.mouseActive) buttons |= Button.fire;
    if ((this.mouseButtons & 4) !== 0 && this.mouseActive) buttons |= Button.aim;
    if (driving && this.keys.has('Space')) buttons |= Button.handbrake;
    if (this.keys.has('KeyH')) buttons |= Button.horn;
    if (this.keys.has('KeyR')) buttons |= Button.reload;
    if (this.keys.has('KeyX') || this.keys.has('Backspace')) buttons |= Button.recover;
    // Gamepad: left stick move/steer, right stick look is read by the game loop, RT throttle/fire, LT brake/aim.
    const gp = this.activeGamepad();
    if (gp) {
      const dz = (v: number) => Math.abs(v) < 0.12 ? 0 : v;
      const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0);
      if (lx !== 0 || ly !== 0) { moveX = lx; moveZ = -ly; }
      const rt = gp.buttons[7]?.value ?? 0, lt = gp.buttons[6]?.value ?? 0;
      if (driving) { if (rt > 0.05) moveZ = rt; if (lt > 0.05) moveZ = -lt; }
      else { if (rt > 0.5) buttons |= Button.fire; if (lt > 0.5) buttons |= Button.aim; }
      if (gp.buttons[0]?.pressed) buttons |= Button.interact;
      if (gp.buttons[10]?.pressed) buttons |= Button.sprint;
      const jumpHeld = gp.buttons[1]?.pressed ?? false;
      if (driving && jumpHeld) buttons |= Button.handbrake;
      if (!driving && jumpHeld && !this.gamepadJumpHeld) this.jumpPresses = Math.min(2, this.jumpPresses + 1);
      this.gamepadJumpHeld = jumpHeld;
      if (gp.buttons[2]?.pressed) buttons |= Button.reload;
      if (gp.buttons[3]?.pressed) buttons |= Button.recover;
    } else this.gamepadJumpHeld = false;
    const touch = this.touch.consume();
    if (touch.moveX !== 0 || touch.moveZ !== 0) { moveX = touch.moveX; moveZ = touch.moveZ; }
    buttons |= touch.buttons;
    this.jumpPresses = Math.min(2, this.jumpPresses + touch.jumpPresses);
    // Preserve two distinct taps even if both arrive between simulation ticks. A neutral tick between
    // pulses keeps the replay's edge-triggered jump deterministic; holding Space never auto-jumps.
    if (driving) { this.jumpPresses = 0; this.jumpPulseLastTick = false; }
    else if (this.jumpPulseLastTick) this.jumpPulseLastTick = false;
    else if (this.jumpPresses > 0) { buttons |= Button.jump; this.jumpPresses--; this.jumpPulseLastTick = true; }
    // Preserve WASD run / Shift sprint; Alt exposes the controller's existing walking speed on a keyboard.
    // Bound the vector length as well as each axis so diagonal walking stays below the walk threshold.
    if (!driving && (this.keys.has('AltLeft') || this.keys.has('AltRight'))) {
      const scale = Math.min(1, 0.4 / (Math.hypot(moveX, moveZ) || 1));
      moveX *= scale; moveZ *= scale;
      buttons &= ~Button.sprint;
    }
    return { moveX, moveZ, yaw, pitch, buttons };
  }

  gamepadLook(dtSeconds = 1 / 60): [number, number] {
    if (!this.enabled) return [0, 0];
    const gp = this.activeGamepad();
    if (!gp) return [0, 0];
    const dz = (v: number) => Math.abs(v) < 0.15 ? 0 : v;
    const frameScale = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(0.1, dtSeconds)) * 60 : 0;
    return [dz(gp.axes[2] ?? 0) * 0.05 * frameScale, dz(gp.axes[3] ?? 0) * 0.04 * frameScale];
  }
}
