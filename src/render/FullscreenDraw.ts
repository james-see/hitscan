import * as THREE from 'three';
import { FULLSCREEN_VERTEX_SHADER } from './Pipeline.ts';

/**
 * One full-screen shader draw.
 *
 * The post chain has an equivalent helper, but the render module deliberately
 * does not import it: the two directories are owned separately and a shared
 * base class turns every refactor on one side into a compile break on the
 * other. Thirty lines of duplication is the cheaper trade.
 */
export class FullscreenDraw {
  readonly material: THREE.ShaderMaterial;

  #mesh: THREE.Mesh;

  constructor(options: {
    name: string;
    fragmentShader: string;
    uniforms?: Record<string, THREE.IUniform>;
    defines?: Record<string, string | number>;
  }) {
    this.material = new THREE.ShaderMaterial({
      name: options.name,
      uniforms: options.uniforms ?? {},
      defines: options.defines ?? {},
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: options.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.#mesh = new THREE.Mesh(geometry(), this.material);
    this.#mesh.frustumCulled = false;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  set(name: string, value: unknown): void {
    const uniform = this.material.uniforms[name];
    if (uniform !== undefined) uniform.value = value;
  }

  /** Recompiles on the next draw. Required after changing `defines`. */
  invalidate(): void {
    this.material.needsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.#mesh, CAMERA);
  }

  dispose(): void {
    this.material.dispose();
  }
}

const CAMERA = /*@__PURE__*/ new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

let shared: THREE.BufferGeometry | null = null;

/** A triangle rather than a quad: no diagonal seam, one fewer vertex. */
function geometry(): THREE.BufferGeometry {
  if (shared === null) {
    shared = new THREE.BufferGeometry();
    shared.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    shared.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  }
  return shared;
}
