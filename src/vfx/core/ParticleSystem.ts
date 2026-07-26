import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import { ParticleTypeTable } from './ParticleTypes.ts';
import { ParticleBatch, EmitDesc } from './ParticleBatch.ts';
import { buildSpriteArray } from './Textures.ts';

export { EmitDesc } from './ParticleBatch.ts';

/**
 * Fraction of the particle budget reserved for alpha-blended smoke and
 * debris. Additive sparks are short-lived and cheaper per pixel, so the
 * split leans towards the batch that has to persist.
 */
const ALPHA_SHARE = 0.58;

/** Owns both blend batches, the shared sprite array and the shared uniforms. */
export class ParticleSystem {
  readonly types = new ParticleTypeTable();
  readonly root = new THREE.Group();
  readonly alpha: ParticleBatch;
  readonly additive: ParticleBatch;

  readonly uniforms: Record<string, THREE.IUniform> = {
    uSprites: { value: null },
    uSceneDepth: { value: null },
    uDepthMode: { value: 0 },
    uSoftEnabled: { value: 1 },
    uCameraPlanes: { value: new THREE.Vector2(0.05, 1000) },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.92, 0.8) },
    uSkyColor: { value: new THREE.Color(0.25, 0.32, 0.42) },
    uGroundColor: { value: new THREE.Color(0.1, 0.09, 0.08) },
  };

  #sprites: THREE.DataArrayTexture;

  constructor(rng: Rng, maxParticles: number) {
    this.root.name = 'vfx.particles';
    this.#sprites = buildSpriteArray(rng.fork('sprites'));
    this.uniforms.uSprites!.value = this.#sprites;

    const alphaCapacity = Math.round(maxParticles * ALPHA_SHARE);
    this.alpha = new ParticleBatch({
      capacity: alphaCapacity,
      types: this.types,
      rng: rng.fork('particles.alpha'),
      sprites: this.#sprites,
      uniforms: this.uniforms,
      additive: false,
      name: 'vfx.particles.alpha',
      renderOrder: 12,
    });
    this.additive = new ParticleBatch({
      capacity: maxParticles - alphaCapacity,
      types: this.types,
      rng: rng.fork('particles.additive'),
      sprites: this.#sprites,
      uniforms: this.uniforms,
      additive: true,
      name: 'vfx.particles.additive',
      renderOrder: 14,
    });

    this.root.add(this.alpha.mesh, this.additive.mesh);
  }

  /** Resolves a type id to its index. Throws on an unknown id. */
  id(name: string): number {
    return this.types.id(name);
  }

  emit(desc: EmitDesc): void {
    if (this.types.batch[desc.type] === 1) this.additive.emit(desc);
    else this.alpha.emit(desc);
  }

  simulate(dt: number): void {
    this.alpha.simulate(dt);
    this.additive.simulate(dt);
  }

  write(camera: THREE.Camera): void {
    const p = camera.position;
    this.alpha.write(p.x, p.y, p.z);
    this.additive.write(p.x, p.y, p.z);
  }

  get liveCount(): number {
    return this.alpha.liveCount + this.additive.liveCount;
  }

  setSceneDepth(texture: THREE.Texture | null, mode: number): void {
    this.uniforms.uSceneDepth!.value = texture;
    this.uniforms.uDepthMode!.value = mode;
    this.uniforms.uSoftEnabled!.value = texture ? 1 : 0;
  }

  setCameraPlanes(near: number, far: number): void {
    (this.uniforms.uCameraPlanes!.value as THREE.Vector2).set(near, far);
  }

  setLighting(
    sunDirection: THREE.Vector3,
    sunColor: THREE.Color,
    skyColor: THREE.Color,
    groundColor: THREE.Color
  ): void {
    (this.uniforms.uSunDirection!.value as THREE.Vector3).copy(sunDirection).normalize();
    (this.uniforms.uSunColor!.value as THREE.Color).copy(sunColor);
    (this.uniforms.uSkyColor!.value as THREE.Color).copy(skyColor);
    (this.uniforms.uGroundColor!.value as THREE.Color).copy(groundColor);
  }

  clear(): void {
    this.alpha.clear();
    this.additive.clear();
  }

  dispose(): void {
    this.alpha.dispose();
    this.additive.dispose();
    this.#sprites.dispose();
    this.root.removeFromParent();
  }
}
