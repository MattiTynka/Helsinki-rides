// Small transient effects: bullet tracers, muzzle flashes, hit sparks. Pooled line segments, no allocations per frame.
import * as THREE from 'three';
import type { Shot } from '@helsinki/sim';

const MAX_TRACERS = 24;

export class Effects {
  readonly group = new THREE.Group();
  private readonly tracers: { line: THREE.Line; ttl: number }[] = [];
  private readonly flash: THREE.Sprite;
  private flashTtl = 0;

  constructor() {
    const mat = new THREE.LineBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.9 });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.frustumCulled = false;
      this.group.add(line);
      this.tracers.push({ line, ttl: 0 });
    }
    const spriteMat = new THREE.SpriteMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.9, depthWrite: false });
    this.flash = new THREE.Sprite(spriteMat);
    this.flash.scale.set(0.35, 0.35, 1);
    this.flash.visible = false;
    this.group.add(this.flash);
  }

  addShots(shots: readonly Shot[]): void {
    for (const s of shots) {
      const t = this.tracers.find(x => x.ttl <= 0) ?? this.tracers[0]!;
      const pos = t.line.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, s.origin[0], s.origin[1], s.origin[2]);
      pos.setXYZ(1, s.end[0], s.end[1], s.end[2]);
      pos.needsUpdate = true;
      t.line.visible = true;
      t.ttl = 0.08;
      if (s.shooter === 'player') { this.flash.position.set(s.origin[0], s.origin[1], s.origin[2]); this.flash.visible = true; this.flashTtl = 0.05; }
    }
  }

  update(dt: number): void {
    for (const t of this.tracers) { if (t.ttl > 0) { t.ttl -= dt; if (t.ttl <= 0) t.line.visible = false; } }
    if (this.flashTtl > 0) { this.flashTtl -= dt; if (this.flashTtl <= 0) this.flash.visible = false; }
  }
}
