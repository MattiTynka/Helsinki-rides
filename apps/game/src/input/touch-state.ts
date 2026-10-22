import { Button } from '@helsinki/sim';

export type TouchRole = 'move' | 'look' | 'fire' | 'aim' | 'jump' | 'interact' | 'reload'
  | 'holster' | 'recover' | 'accelerate' | 'brake' | 'handbrake' | 'horn';
interface Contact { readonly role: TouchRole; x: number; y: number; }
export interface TouchCommand { moveX: number; moveZ: number; buttons: number; jumpPresses: number; }

/** Semantic touch input. Pointer identities, rather than a shared mouse button, own held controls. */
export class TouchState {
  private readonly contacts = new Map<number, Contact>();
  private readonly pulses: { pointer: number; role: TouchRole }[] = [];
  private enabled = true;
  private driving = false;
  private dx = 0;
  private dy = 0;
  private moveX = 0;
  private moveZ = 0;
  private sprint = false;
  aiming = false;
  lookSensitivity = 0.004;

  setActive(active: boolean): void { if (!active) this.reset(); this.enabled = active; }
  setDriving(driving: boolean): void { if (this.driving !== driving) { this.reset(); this.driving = driving; } }
  get isDriving(): boolean { return this.driving; }
  get activePointers(): number { return this.contacts.size; }

  begin(pointer: number, role: TouchRole, x = 0, y = 0): boolean {
    if (!this.enabled || this.contacts.has(pointer) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    // A single thumb owns camera look, including look while dragging Fire. Other buttons remain independent.
    for (const contact of this.contacts.values()) {
      if (contact.role === role || ((role === 'look' || role === 'fire') && (contact.role === 'look' || contact.role === 'fire'))) return false;
    }
    this.contacts.set(pointer, { role, x, y });
    if (role === 'aim' && !this.driving) this.aiming = !this.aiming;
    if (role === 'holster') { this.aiming = false; this.pulses.push({ pointer, role }); }
    // A tap may begin and end between two 30Hz presentations. Preserve its press until a command
    // consumes it, while the contact itself continues to own ordinary held firing/reloading.
    if (role === 'jump' || role === 'interact' || role === 'fire' || role === 'reload') this.pulses.push({ pointer, role });
    return true;
  }

  move(pointer: number, x: number, y: number): void {
    const contact = this.contacts.get(pointer);
    if (!contact || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (contact.role === 'look' || contact.role === 'fire') { this.dx += x - contact.x; this.dy += y - contact.y; }
    contact.x = x; contact.y = y;
  }

  /** x/y are displacement divided by the visible stick radius; up is negative screen Y. */
  stick(pointer: number, x: number, y: number): void {
    if (this.contacts.get(pointer)?.role !== 'move' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const radius = Math.hypot(x, y), clamped = Math.min(1, radius);
    const magnitude = clamped < 0.12 ? 0 : this.driving ? (clamped - 0.12) / 0.88
      : clamped <= 0.55 ? (clamped - 0.12) / 0.43 * 0.4 : 0.4 + (clamped - 0.55) / 0.45 * 0.6;
    this.moveX = radius > 0 ? x / radius * magnitude : 0;
    // The car uses pedals for throttle. Its stick only steers, so dragging vertically never accelerates.
    this.moveZ = this.driving ? 0 : radius > 0 ? -y / radius * magnitude : 0;
    this.sprint = !this.driving && clamped >= 0.94;
  }

  end(pointer: number, cancelled = false): void {
    const contact = this.contacts.get(pointer);
    if (!contact) return;
    this.contacts.delete(pointer);
    if (contact.role === 'move') { this.moveX = 0; this.moveZ = 0; this.sprint = false; }
    if (cancelled) {
      for (let i = this.pulses.length - 1; i >= 0; i--) if (this.pulses[i]!.pointer === pointer) this.pulses.splice(i, 1);
      if (contact.role === 'aim') this.aiming = false;
      if (contact.role === 'look' || contact.role === 'fire') { this.dx = 0; this.dy = 0; }
    }
  }

  takeLook(): [number, number] {
    const look: [number, number] = [this.dx * this.lookSensitivity, this.dy * this.lookSensitivity];
    this.dx = 0; this.dy = 0;
    return look;
  }

  consume(): TouchCommand {
    let buttons = this.sprint ? Button.sprint : 0, jumps = 0;
    const held = new Set(Array.from(this.contacts.values(), contact => contact.role));
    if (this.driving) {
      if (held.has('handbrake')) buttons |= Button.handbrake;
      if (held.has('horn')) buttons |= Button.horn;
    } else {
      if (held.has('fire')) buttons |= Button.fire;
      if (this.aiming) buttons |= Button.aim;
      if (held.has('reload')) buttons |= Button.reload;
    }
    if (held.has('recover')) buttons |= Button.recover;
    for (const pulse of this.pulses) {
      if (pulse.role === 'interact') buttons |= Button.interact;
      if (!this.driving && pulse.role === 'holster') buttons |= Button.holster;
      if (!this.driving && pulse.role === 'fire') buttons |= Button.fire;
      if (!this.driving && pulse.role === 'reload') buttons |= Button.reload;
      if (!this.driving && pulse.role === 'jump') jumps++;
    }
    this.pulses.length = 0;
    return { moveX: this.moveX, moveZ: this.driving ? held.has('brake') ? -1 : held.has('accelerate') ? 1 : 0 : this.moveZ, buttons, jumpPresses: jumps };
  }

  reset(): void {
    this.contacts.clear(); this.pulses.length = 0; this.moveX = 0; this.moveZ = 0;
    this.dx = 0; this.dy = 0; this.sprint = false; this.aiming = false;
  }
}
