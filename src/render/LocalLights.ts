import * as THREE from 'three';
import type { ClusteredLightHandle } from '@/types/render.ts';

export interface LocalLightDescription {
  kind: 'point' | 'spot';
  position: THREE.Vector3;
  color: THREE.ColorRepresentation;
  /** Radiant intensity, in the same units as `Photometry.SUN_IRRADIANCE`. */
  intensity: number;
  /** Cutoff distance in metres. Also the culling radius. */
  distance: number;
  decay?: number;
  /** Spot only: direction the cone points. */
  direction?: THREE.Vector3;
  /** Spot only: cone half-angle in radians. */
  angle?: number;
  /** Spot only: soft edge fraction in [0,1]. */
  penumbra?: number;
  /**
   * Tie-breaker for lights of equal screen importance. A gameplay-critical
   * light should outrank set dressing at the same distance.
   */
  priority?: number;
}

interface Registration extends LocalLightDescription {
  id: number;
  alive: boolean;
  score: number;
  slot: number;
}

interface Slot {
  light: THREE.PointLight | THREE.SpotLight;
  owner: number;
  /** Smoothed intensity, so a light entering the budget ramps in. */
  current: number;
}

/**
 * Local light budget for point and spot lights.
 *
 * HONEST TRADEOFF, stated up front: this is not a froxel cluster. A real
 * clustered forward renderer needs the light list in a data texture and a
 * hand-written light loop in every shader, which means replacing three's
 * `lights_fragment_begin` and light uniform structs wholesale — that fights
 * every built-in material and breaks the moment three's chunks change. What
 * this does instead is bound the problem: the world can register any number of
 * lights, and each frame the manager frustum-culls them, ranks the survivors
 * by screen-space importance (intensity over squared distance, scaled by
 * priority) and binds the best `budget` of them to a fixed pool of real
 * three.js lights.
 *
 * Two properties make that behave like clustering from the caller's side:
 *
 *   - Cost is constant. The pool size never changes, so the shader permutation
 *     never changes and there is no recompile hitch when a fire is lit.
 *   - There is no popping. A light entering or leaving the budget ramps its
 *     intensity over a few frames rather than switching on.
 *
 * What it does not give you is hundreds of simultaneously visible lights. For
 * a courtyard with lamps and fires the budget is comfortably above what is
 * ever on screen at once; if the world needs more than that, the honest fix is
 * a deferred or clustered path, not a bigger pool.
 */
export class LocalLights {
  #scene: THREE.Scene;
  #pointBudget: number;
  #spotBudget: number;
  #pointSlots: Slot[] = [];
  #spotSlots: Slot[] = [];
  #registrations = new Map<number, Registration>();
  #candidates: Registration[] = [];
  #nextId = 1;
  #created = false;

  #frustum = new THREE.Frustum();
  #viewProjection = new THREE.Matrix4();
  #sphere = new THREE.Sphere();

  constructor(scene: THREE.Scene, pointBudget = 8, spotBudget = 4) {
    this.#scene = scene;
    this.#pointBudget = pointBudget;
    this.#spotBudget = spotBudget;
  }

  /**
   * Adds a light to the pool of candidates. The returned handle releases it.
   *
   * The first call allocates the light pool, which changes the shader
   * permutation once. Doing it lazily keeps scenes with no local lights on the
   * cheapest possible shader.
   */
  register(description: LocalLightDescription): ClusteredLightHandle {
    this.#ensurePool();
    const id = this.#nextId++;
    const registration: Registration = {
      ...description,
      position: description.position.clone(),
      id,
      alive: true,
      score: 0,
      slot: -1,
    };
    this.#registrations.set(id, registration);
    return {
      id,
      release: (): void => {
        const entry = this.#registrations.get(id);
        if (!entry) return;
        entry.alive = false;
        this.#registrations.delete(id);
      },
    };
  }

  /** Moves or retunes an already registered light. */
  set(id: number, changes: Partial<LocalLightDescription>): void {
    const entry = this.#registrations.get(id);
    if (!entry) return;
    if (changes.position) entry.position.copy(changes.position);
    if (changes.direction) entry.direction = changes.direction.clone();
    if (changes.intensity !== undefined) entry.intensity = changes.intensity;
    if (changes.color !== undefined) entry.color = changes.color;
    if (changes.distance !== undefined) entry.distance = changes.distance;
    if (changes.angle !== undefined) entry.angle = changes.angle;
    if (changes.penumbra !== undefined) entry.penumbra = changes.penumbra;
  }

  update(camera: THREE.PerspectiveCamera, deltaTime: number): void {
    if (!this.#created) return;

    this.#viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#viewProjection);

    this.#assign('point', this.#pointSlots, camera);
    this.#assign('spot', this.#spotSlots, camera);

    // Ramp toward the target so entering and leaving the budget is invisible.
    const rate = 1 - Math.exp(-deltaTime * 12);
    for (const slots of [this.#pointSlots, this.#spotSlots]) {
      for (const slot of slots) {
        const entry = slot.owner >= 0 ? this.#registrations.get(slot.owner) : undefined;
        const target = entry ? entry.intensity : 0;
        slot.current += (target - slot.current) * (deltaTime > 0 ? rate : 1);
        slot.light.intensity = slot.current;
        slot.light.visible = slot.current > 1e-4;
        if (slot.current <= 1e-4) slot.owner = -1;
      }
    }
  }

  dispose(): void {
    for (const slots of [this.#pointSlots, this.#spotSlots]) {
      for (const slot of slots) {
        slot.light.removeFromParent();
        (slot.light as THREE.SpotLight).target?.removeFromParent();
        slot.light.dispose();
      }
    }
    this.#pointSlots.length = 0;
    this.#spotSlots.length = 0;
    this.#registrations.clear();
    this.#created = false;
  }

  get budget(): { point: number; spot: number } {
    return { point: this.#pointBudget, spot: this.#spotBudget };
  }

  #ensurePool(): void {
    if (this.#created) return;
    this.#created = true;

    for (let i = 0; i < this.#pointBudget; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.name = `local.point${i}`;
      light.visible = false;
      light.castShadow = false;
      this.#scene.add(light);
      this.#pointSlots.push({ light, owner: -1, current: 0 });
    }

    for (let i = 0; i < this.#spotBudget; i++) {
      const light = new THREE.SpotLight(0xffffff, 0, 10, Math.PI / 6, 0.4, 2);
      light.name = `local.spot${i}`;
      light.visible = false;
      light.castShadow = false;
      this.#scene.add(light);
      this.#scene.add(light.target);
      this.#spotSlots.push({ light, owner: -1, current: 0 });
    }
  }

  #assign(kind: 'point' | 'spot', slots: Slot[], camera: THREE.PerspectiveCamera): void {
    this.#candidates.length = 0;

    for (const entry of this.#registrations.values()) {
      if (entry.kind !== kind || !entry.alive || entry.intensity <= 0) continue;
      this.#sphere.center.copy(entry.position);
      this.#sphere.radius = entry.distance;
      if (!this.#frustum.intersectsSphere(this.#sphere)) continue;

      const distance = Math.max(0.5, camera.position.distanceTo(entry.position) - entry.distance);
      entry.score = (entry.intensity * (entry.priority ?? 1)) / (distance * distance);
      this.#candidates.push(entry);
    }

    this.#candidates.sort((a, b) => b.score - a.score);
    const selected = this.#candidates.slice(0, slots.length);
    const taken = new Set<number>();

    // Keep a light in the slot it already occupies; reshuffling slots makes
    // the ramp fight itself and produces visible flicker.
    for (const entry of selected) {
      if (entry.slot >= 0 && slots[entry.slot]?.owner === entry.id) taken.add(entry.slot);
    }
    for (const entry of selected) {
      if (entry.slot >= 0 && slots[entry.slot]?.owner === entry.id) continue;
      const free = slots.findIndex((slot, index) => !taken.has(index) && slot.owner === -1);
      const index = free >= 0 ? free : slots.findIndex((_, i) => !taken.has(i));
      if (index < 0) continue;
      entry.slot = index;
      taken.add(index);
      slots[index]!.owner = entry.id;
    }
    for (let i = 0; i < slots.length; i++) {
      if (!taken.has(i)) slots[i]!.owner = -1;
    }

    for (const slot of slots) {
      const entry = slot.owner >= 0 ? this.#registrations.get(slot.owner) : undefined;
      if (!entry) continue;
      const light = slot.light;
      light.position.copy(entry.position);
      light.color.set(entry.color);
      light.distance = entry.distance;
      light.decay = entry.decay ?? 2;
      if (kind === 'spot') {
        const spot = light as THREE.SpotLight;
        spot.angle = entry.angle ?? Math.PI / 6;
        spot.penumbra = entry.penumbra ?? 0.4;
        const direction = entry.direction ?? DOWN;
        spot.target.position.copy(entry.position).add(direction);
        spot.target.updateMatrixWorld();
      }
    }
  }
}

const DOWN = /*@__PURE__*/ new THREE.Vector3(0, -1, 0);
