import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';

/** Frames the flicker envelope is sampled over. */
const FLICKER_STEPS = 4;

/**
 * Pooled dynamic point lights for muzzle flashes and hot impacts.
 *
 * The lights are created once and left in the scene at zero intensity for the
 * lifetime of the process. Adding a light to a three.js scene changes every
 * material's program permutation, so spawning them on demand would compile
 * shaders on the first shot — the single most noticeable hitch a shooter can
 * have.
 */
export class LightPool {
  #lights: THREE.PointLight[] = [];
  #age: Float32Array;
  #duration: Float32Array;
  #peak: Float32Array;
  #envelope: Float32Array;
  #rng: Rng;
  #cursor = 0;

  constructor(parent: THREE.Object3D, count: number, rng: Rng) {
    this.#rng = rng;
    this.#age = new Float32Array(count);
    this.#duration = new Float32Array(count);
    this.#peak = new Float32Array(count);
    this.#envelope = new Float32Array(count * FLICKER_STEPS);

    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.name = `vfx.light.${i}`;
      light.castShadow = false;
      light.visible = false;
      this.#lights.push(light);
      parent.add(light);
      this.#duration[i] = 0;
    }
  }

  /**
   * Lights the next pooled light at `position`.
   *
   * `duration` is deliberately short — 40-55ms, i.e. two to three frames —
   * because a muzzle flash that lingers reads as a lamp rather than a
   * detonation.
   */
  spawn(
    position: THREE.Vector3,
    color: THREE.ColorRepresentation,
    intensity: number,
    duration: number,
    distance: number
  ): void {
    const i = this.#cursor % this.#lights.length;
    this.#cursor++;
    const light = this.#lights[i]!;
    light.position.copy(position);
    light.color.set(color);
    light.distance = distance;
    light.visible = true;
    this.#age[i] = 0;
    this.#duration[i] = duration;
    this.#peak[i] = intensity;

    // A short, front-loaded random envelope. Real muzzle flashes are a
    // bright first frame followed by an uneven decay, never a clean ramp.
    const base = i * FLICKER_STEPS;
    this.#envelope[base] = 1;
    this.#envelope[base + 1] = this.#rng.range(0.55, 1.0);
    this.#envelope[base + 2] = this.#rng.range(0.18, 0.5);
    this.#envelope[base + 3] = this.#rng.range(0.03, 0.16);
    light.intensity = intensity;
  }

  update(dt: number): void {
    for (let i = 0; i < this.#lights.length; i++) {
      const duration = this.#duration[i]!;
      if (duration <= 0) continue;
      const age = this.#age[i]! + dt;
      this.#age[i] = age;
      const light = this.#lights[i]!;
      if (age >= duration) {
        this.#duration[i] = 0;
        light.intensity = 0;
        light.visible = false;
        continue;
      }
      const t = age / duration;
      const step = Math.min(FLICKER_STEPS - 1, (t * FLICKER_STEPS) | 0);
      const base = i * FLICKER_STEPS;
      const a = this.#envelope[base + step]!;
      const b = step + 1 < FLICKER_STEPS ? this.#envelope[base + step + 1]! : 0;
      const local = t * FLICKER_STEPS - step;
      light.intensity = this.#peak[i]! * (a + (b - a) * local);
    }
  }

  clear(): void {
    for (let i = 0; i < this.#lights.length; i++) {
      this.#duration[i] = 0;
      this.#lights[i]!.intensity = 0;
      this.#lights[i]!.visible = false;
    }
  }

  dispose(): void {
    for (const light of this.#lights) light.removeFromParent();
    this.#lights.length = 0;
  }
}
