import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import type { HitResult, SurfaceKind } from '@/types/gameplay.ts';
import { EmitDesc, type ParticleSystem } from '../core/ParticleSystem.ts';
import type { LightPool } from './LightPool.ts';

interface Emission {
  type: string;
  /** Inclusive count range before distance scaling. */
  count: [number, number];
  speed: number;
  speedSpread?: number;
  /** Cone half-angle in radians. */
  spread: number;
  /** 0 = along the surface normal, 1 = along the mirror reflection. */
  reflectBias?: number;
  radius?: number;
  sizeScale?: number;
  /** Seconds of sub-frame spawn spread, so a burst is not a hollow shell. */
  prewarm?: number;
  /** Orients `Axial`/`Planar` billboards to the surface normal. */
  normalAxis?: boolean;
  colorScale?: number;
  opacityScale?: number;
}

interface ImpactSpec {
  emissions: Emission[];
  light?: { color: number; intensity: number; duration: number; distance: number };
  decal: boolean;
}

/**
 * Per-surface impact response.
 *
 * The differences are deliberately structural rather than cosmetic: concrete
 * throws a dust cloud and chips, metal throws a tight fan of hot sparks plus
 * a spall shard, wood throws long splinters, dirt lifts a slow plume with no
 * hot component at all. Two surfaces should never be distinguishable only by
 * their tint.
 */
const IMPACTS: Record<SurfaceKind, ImpactSpec> = {
  concrete: {
    emissions: [
      { type: 'impact.flash', count: [1, 1], speed: 0.3, spread: 1.2, sizeScale: 0.9 },
      { type: 'impact.ring', count: [1, 1], speed: 0, spread: 0, normalAxis: true, sizeScale: 0.7, colorScale: 0.55 },
      { type: 'concrete.puff', count: [4, 7], speed: 2.4, speedSpread: 0.6, spread: 0.95, radius: 0.02, prewarm: 0.02 },
      { type: 'concrete.dust', count: [7, 12], speed: 1.5, speedSpread: 0.7, spread: 1.35, radius: 0.05, prewarm: 0.05 },
      { type: 'concrete.chip', count: [6, 11], speed: 5.5, speedSpread: 0.65, spread: 0.85, reflectBias: 0.65 },
      { type: 'metal.spark', count: [2, 5], speed: 4.5, speedSpread: 0.7, spread: 0.7, reflectBias: 0.8, colorScale: 0.55 },
    ],
    light: { color: 0xffb066, intensity: 2.2, duration: 0.05, distance: 3.2 },
    decal: true,
  },
  metal: {
    emissions: [
      { type: 'impact.flash', count: [1, 2], speed: 0.4, spread: 1.2, sizeScale: 1.3, colorScale: 1.4 },
      { type: 'impact.ring', count: [1, 1], speed: 0, spread: 0, normalAxis: true, sizeScale: 0.8, colorScale: 1.2 },
      { type: 'metal.spark', count: [16, 26], speed: 7.5, speedSpread: 0.75, spread: 0.85, reflectBias: 0.75, prewarm: 0.008 },
      // A tight, fast fan along the ricochet path reads as the round
      // skipping off rather than simply exploding into sparks.
      { type: 'metal.ricochet', count: [4, 8], speed: 15, speedSpread: 0.45, spread: 0.24, reflectBias: 1 },
      { type: 'metal.spall', count: [3, 6], speed: 6.5, speedSpread: 0.6, spread: 0.6, reflectBias: 0.85 },
      { type: 'metal.smoke', count: [2, 4], speed: 1.4, speedSpread: 0.6, spread: 1.1, radius: 0.02, prewarm: 0.02 },
    ],
    light: { color: 0xffd08a, intensity: 6.5, duration: 0.07, distance: 5 },
    decal: true,
  },
  wood: {
    emissions: [
      { type: 'impact.flash', count: [1, 1], speed: 0.3, spread: 1.2, sizeScale: 0.75, colorScale: 0.7 },
      { type: 'wood.splinter', count: [8, 14], speed: 5.5, speedSpread: 0.7, spread: 0.75, reflectBias: 0.7 },
      { type: 'wood.dust', count: [5, 9], speed: 1.9, speedSpread: 0.7, spread: 1.2, radius: 0.03, prewarm: 0.03 },
      { type: 'concrete.puff', count: [1, 3], speed: 1.6, speedSpread: 0.6, spread: 1.0, radius: 0.02, colorScale: 0.75 },
    ],
    light: { color: 0xff9a4a, intensity: 1.4, duration: 0.045, distance: 2.6 },
    decal: true,
  },
  dirt: {
    emissions: [
      { type: 'dirt.clod', count: [9, 16], speed: 4.2, speedSpread: 0.75, spread: 0.7, reflectBias: 0.35 },
      { type: 'dirt.plume', count: [7, 12], speed: 2.2, speedSpread: 0.7, spread: 0.8, radius: 0.04, prewarm: 0.04 },
      { type: 'concrete.dust', count: [3, 6], speed: 1.1, speedSpread: 0.7, spread: 1.4, radius: 0.06, colorScale: 0.6, prewarm: 0.06 },
    ],
    decal: true,
  },
  sand: {
    emissions: [
      { type: 'sand.plume', count: [10, 16], speed: 2.6, speedSpread: 0.7, spread: 0.75, radius: 0.04, prewarm: 0.05 },
      { type: 'dirt.clod', count: [5, 9], speed: 3.4, speedSpread: 0.8, spread: 0.8, reflectBias: 0.3, sizeScale: 0.7, colorScale: 1.6 },
    ],
    decal: true,
  },
  glass: {
    emissions: [
      { type: 'impact.flash', count: [1, 1], speed: 0.3, spread: 1.2, sizeScale: 0.8, colorScale: 0.9 },
      { type: 'glass.shard', count: [12, 20], speed: 5.5, speedSpread: 0.8, spread: 0.9, reflectBias: 0.15 },
      { type: 'glass.glint', count: [8, 14], speed: 4.5, speedSpread: 0.85, spread: 1.0, reflectBias: 0.2 },
      { type: 'glass.dust', count: [4, 7], speed: 2.0, speedSpread: 0.7, spread: 1.1, radius: 0.03, prewarm: 0.03 },
      { type: 'impact.ring', count: [1, 1], speed: 0, spread: 0, normalAxis: true, sizeScale: 1.1, colorScale: 0.8 },
    ],
    light: { color: 0xbfe4ff, intensity: 2.0, duration: 0.05, distance: 3.4 },
    decal: true,
  },
  water: {
    emissions: [
      { type: 'water.crown', count: [1, 1], speed: 0, spread: 0, normalAxis: true, sizeScale: 1 },
      { type: 'water.droplet', count: [14, 22], speed: 4.0, speedSpread: 0.65, spread: 0.55, reflectBias: 0.15 },
      { type: 'water.mist', count: [5, 9], speed: 1.8, speedSpread: 0.7, spread: 0.9, radius: 0.03, prewarm: 0.03 },
    ],
    decal: false,
  },
  fabric: {
    emissions: [
      { type: 'fabric.fluff', count: [5, 9], speed: 2.2, speedSpread: 0.8, spread: 1.0, reflectBias: 0.4 },
      { type: 'concrete.dust', count: [2, 4], speed: 1.2, speedSpread: 0.7, spread: 1.2, radius: 0.03, colorScale: 0.7 },
    ],
    decal: true,
  },
  foliage: {
    emissions: [
      { type: 'foliage.leaf', count: [6, 11], speed: 3.0, speedSpread: 0.8, spread: 1.2, reflectBias: 0.5 },
      { type: 'wood.dust', count: [2, 4], speed: 1.4, speedSpread: 0.7, spread: 1.2, radius: 0.04, colorScale: 0.8 },
    ],
    decal: true,
  },
  flesh: {
    emissions: [
      { type: 'blood.mist', count: [7, 12], speed: 2.6, speedSpread: 0.75, spread: 0.85, reflectBias: 0.85, radius: 0.02, prewarm: 0.02 },
      { type: 'blood.droplet', count: [10, 17], speed: 4.5, speedSpread: 0.8, spread: 0.8, reflectBias: 0.9 },
    ],
    decal: false,
  },
};

const _reflect = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _lightPosition = new THREE.Vector3();

/** Turns a `weapon:impact` into the right burst for the surface it struck. */
export class ImpactEffects {
  #particles: ParticleSystem;
  #lights: LightPool;
  #rng: Rng;
  #desc = new EmitDesc();
  #resolved = new Map<SurfaceKind, Array<Emission & { typeIndex: number }>>();

  constructor(particles: ParticleSystem, lights: LightPool, rng: Rng) {
    this.#particles = particles;
    this.#lights = lights;
    this.#rng = rng;
    for (const key of Object.keys(IMPACTS) as SurfaceKind[]) {
      this.#resolved.set(
        key,
        IMPACTS[key].emissions.map((e) => ({ ...e, typeIndex: particles.id(e.type) }))
      );
    }
  }

  /** True when this surface should also receive a projected bullet hole. */
  wantsDecal(surface: SurfaceKind): boolean {
    return IMPACTS[surface]?.decal ?? false;
  }

  /** `normal` is the surface normal already oriented against the round. */
  spawn(hit: HitResult, cameraDistance: number, normal: THREE.Vector3): void {
    const spec = IMPACTS[hit.surface];
    const emissions = this.#resolved.get(hit.surface);
    if (!spec || !emissions) return;

    // Distant impacts still need to read, but they do not need the same
    // particle count. Half the budget beyond 30m costs nothing visually.
    const lod = THREE.MathUtils.clamp(1 - (cameraDistance - 18) / 45, 0.3, 1);

    const incoming = hit.direction;
    _reflect.copy(incoming).addScaledVector(normal, -2 * incoming.dot(normal)).normalize();

    // A round arriving flat throws its debris along the surface; a
    // perpendicular hit throws it straight back at the shooter.
    const obliquity = 1 - Math.abs(incoming.dot(normal));

    const desc = this.#desc;
    for (const emission of emissions) {
      const range = emission.count[1] - emission.count[0];
      const count = Math.max(
        1,
        Math.round((emission.count[0] + this.#rng.next() * range) * lod)
      );

      const bias = emission.reflectBias ?? 0;
      _direction
        .copy(_reflect)
        .multiplyScalar(bias)
        .addScaledVector(normal, 1 - bias)
        .normalize();

      desc.reset(emission.typeIndex, count);
      desc.position.copy(hit.point).addScaledVector(normal, 0.012);
      desc.direction.copy(_direction);
      desc.spread = emission.spread + obliquity * 0.25;
      desc.speed = emission.speed;
      desc.speedSpread = emission.speedSpread ?? 0.5;
      desc.radius = emission.radius ?? 0;
      desc.sizeScale = emission.sizeScale ?? 1;
      desc.colorScale = emission.colorScale ?? 1;
      desc.opacityScale = emission.opacityScale ?? 1;
      desc.prewarm = emission.prewarm ?? 0;
      desc.groundY = hit.point.y;
      if (emission.normalAxis) {
        desc.explicitAxis = true;
        desc.axis.copy(normal);
      }
      this.#particles.emit(desc);
    }

    if (spec.light && lod > 0.5) {
      this.#lights.spawn(
        _lightPosition.copy(hit.point).addScaledVector(normal, 0.08),
        spec.light.color,
        spec.light.intensity * this.#rng.range(0.75, 1.25),
        spec.light.duration,
        spec.light.distance
      );
    }
  }
}
