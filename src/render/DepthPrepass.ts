import * as THREE from 'three';
import type { GBuffer } from '@/types/render.ts';

/**
 * MRT depth prepass that fills the G-buffer every screen-space effect reads.
 *
 * ENCODING CONTRACT — every consumer must match this exactly.
 *
 * attachment 0, RGBA16F (`gbuffer.normalRoughness`)
 *   rgb  unit-length surface normal in VIEW space of the current frame,
 *        including normal-map perturbation. Right-handed, camera looks down
 *        -Z, so a surface facing the camera reads (0, 0, 1). Not encoded or
 *        packed: read it, normalize it, use it.
 *        A ZERO-LENGTH normal is the sentinel for "no surface": sky,
 *        background and anything excluded from the prepass. Test it with
 *        `dot(n, n) < 0.01` before using the value.
 *   a    perceptual roughness in [0,1], the same value the forward pass
 *        shades with (`material.roughness * roughnessMap.g`). GGX alpha is
 *        `a * a`.
 *
 * attachment 1, RGBA16F (`gbuffer.velocity`)
 *   rg   screen-space motion in NDC units for this frame, defined as
 *        `ndcCurrent - ndcPrevious`. Both endpoints are UNJITTERED, so the
 *        vector is free of TAA sub-pixel offset regardless of what the
 *        pipeline is jittering by. To reproject a UV:
 *            uvPrevious = uvCurrent - velocity * 0.5
 *        (the 0.5 converts NDC to UV; the sign is negative because velocity
 *        points from the old position to the new one).
 *        Sky and background pixels carry the camera-rotation-only motion of a
 *        point at infinity, so temporal passes need no special case there.
 *   b    metalness in [0,1], the same value the forward pass shades with
 *        (`material.metalness * metalnessMap.b`). ZERO IS A REAL VALUE here,
 *        not a sentinel: most of the scene is dielectric and must read 0 so
 *        reflections stay at a dielectric Fresnel. Use the zero-length normal
 *        in attachment 0 to detect "no surface".
 *   a    reserved, written as 0.
 *
 * depth (`gbuffer.depth`, DEPTH24_STENCIL8)
 *   Non-linear window depth in [0,1] from the SAME projection the forward
 *   pass uses, including jitter. Linearise with the camera's near/far.
 *
 * Objects that do not write depth (the sky dome, anything transparent) are
 * skipped; their depth stays at 1.0.
 */
export class DepthPrepass {
  #entries = new WeakMap<THREE.Mesh, PrepassEntry>();
  #visited: THREE.Mesh[] = [];
  #hidden: THREE.Object3D[] = [];
  #swapped: PrepassEntry[] = [];

  /** Unjittered previous-frame view-projection, shared by every variant. */
  #prevViewProjection = { value: new THREE.Matrix4() };
  /** Current-frame projection jitter in NDC, removed from the motion vector. */
  #jitter = { value: new THREE.Vector2() };

  #background: THREE.Mesh;
  #backgroundUniforms = {
    inverseViewProjection: { value: new THREE.Matrix4() },
    prevViewProjection: { value: new THREE.Matrix4() },
    cameraWorldPosition: { value: new THREE.Vector3() },
    jitter: { value: new THREE.Vector2() },
  };

  constructor() {
    this.#background = buildBackgroundFill(this.#backgroundUniforms);
  }

  /**
   * @param prevViewProjection unjittered view-projection of the previous frame
   * @param viewProjection     unjittered view-projection of this frame
   * @param jitter             sub-pixel projection offset applied this frame
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    gbuffer: GBuffer,
    prevViewProjection: THREE.Matrix4,
    viewProjection: THREE.Matrix4,
    jitter: THREE.Vector2
  ): void {
    this.#prevViewProjection.value.copy(prevViewProjection);
    this.#jitter.value.copy(jitter);

    this.#backgroundUniforms.inverseViewProjection.value.copy(viewProjection).invert();
    this.#backgroundUniforms.prevViewProjection.value.copy(prevViewProjection);
    this.#backgroundUniforms.cameraWorldPosition.value.setFromMatrixPosition(camera.matrixWorld);
    this.#backgroundUniforms.jitter.value.copy(jitter);

    this.#prepare(scene);

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(gbuffer.target);
    renderer.clear(false, true, false);

    // Fills normal and velocity for every pixel first, so anything the depth
    // pass does not cover still carries a usable reprojection vector.
    renderer.render(this.#background, BACKGROUND_CAMERA);
    renderer.render(scene, camera);

    renderer.setRenderTarget(previousTarget);
    this.#restore();
  }

  dispose(): void {
    this.#background.geometry.dispose();
    (this.#background.material as THREE.Material).dispose();
  }

  #prepare(scene: THREE.Scene): void {
    scene.traverse((object) => {
      if (!object.visible) return;
      const mesh = object as THREE.Mesh & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
      const renderable = mesh.isMesh || mesh.isLine || mesh.isPoints || mesh.isSprite;
      if (!renderable) return;

      if (!mesh.isMesh || !isEligible(mesh)) {
        object.visible = false;
        this.#hidden.push(object);
        return;
      }
      this.#visited.push(mesh);
    });

    for (const mesh of this.#visited) {
      const entry = this.#entryFor(mesh);
      entry.source = mesh.material;
      mesh.material = entry.variant;
      for (const uniforms of entry.uniforms) {
        uniforms.prevModelMatrix.value.copy(entry.prevMatrixWorld);
        uniforms.prevViewProjectionMatrix.value.copy(this.#prevViewProjection.value);
        uniforms.gbufferJitter.value.copy(this.#jitter.value);
      }
      this.#swapped.push(entry);
    }
  }

  #restore(): void {
    for (const entry of this.#swapped) {
      const mesh = entry.mesh;
      mesh.material = entry.source;
      entry.prevMatrixWorld.copy(mesh.matrixWorld);
    }
    this.#swapped.length = 0;
    this.#visited.length = 0;
    for (const object of this.#hidden) object.visible = true;
    this.#hidden.length = 0;
  }

  #entryFor(mesh: THREE.Mesh): PrepassEntry {
    const existing = this.#entries.get(mesh);
    if (existing && existing.builtFrom === mesh.material) return existing;

    const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const uniforms: PrepassUniforms[] = [];
    const variants = sources.map((source) => {
      const set = createUniformSet();
      uniforms.push(set);
      return buildVariant(source, set);
    });

    const entry: PrepassEntry = {
      mesh,
      builtFrom: mesh.material,
      source: mesh.material,
      variant: Array.isArray(mesh.material) ? variants : variants[0]!,
      uniforms,
      prevMatrixWorld: new THREE.Matrix4().copy(mesh.matrixWorld),
    };
    this.#entries.set(mesh, entry);
    return entry;
  }
}

interface PrepassUniforms {
  prevModelMatrix: { value: THREE.Matrix4 };
  prevViewProjectionMatrix: { value: THREE.Matrix4 };
  gbufferJitter: { value: THREE.Vector2 };
}

interface PrepassEntry {
  mesh: THREE.Mesh;
  builtFrom: THREE.Material | THREE.Material[];
  source: THREE.Material | THREE.Material[];
  variant: THREE.Material | THREE.Material[];
  uniforms: PrepassUniforms[];
  prevMatrixWorld: THREE.Matrix4;
}

function createUniformSet(): PrepassUniforms {
  return {
    prevModelMatrix: { value: new THREE.Matrix4() },
    prevViewProjectionMatrix: { value: new THREE.Matrix4() },
    gbufferJitter: { value: new THREE.Vector2() },
  };
}

/** Transparent geometry and anything that skips depth is not in the prepass. */
function isEligible(mesh: THREE.Mesh): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    if (!material) return false;
    if (material.transparent === true) return false;
    if (material.depthWrite === false) return false;
    if (material.visible === false) return false;
  }
  return true;
}

const VERTEX_DECLARATIONS = /* glsl */ `
uniform mat4 prevModelMatrix;
uniform mat4 prevViewProjectionMatrix;
varying vec4 vClipCurrent;
varying vec4 vClipPrevious;
`;

const VERTEX_MOTION = /* glsl */ `
	vClipCurrent = gl_Position;
	vec4 gbufferPreviousLocal = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		gbufferPreviousLocal = instanceMatrix * gbufferPreviousLocal;
	#endif
	vClipPrevious = prevViewProjectionMatrix * prevModelMatrix * gbufferPreviousLocal;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
layout(location = 1) out vec4 gVelocity;
uniform vec2 gbufferJitter;
varying vec4 vClipCurrent;
varying vec4 vClipPrevious;
`;

/**
 * Emitted after the material's own output. `normal`, `roughnessFactor` and
 * `metalnessFactor` are three's own names and are still in scope at the end of
 * main; whatever the lighting chain computed before this point is dead and gets
 * stripped.
 *
 * `metalnessFactor` comes out of `<metalnessmap_fragment>`, the same chunk pair
 * that produces `roughnessFactor`, so metalness is sourced exactly where
 * roughness is: the material's scalar times the map channel three itself picks.
 */
const FRAGMENT_OUTPUT = /* glsl */ `
	vec2 gbufferNdcCurrent = vClipCurrent.xy / vClipCurrent.w - gbufferJitter;
	vec2 gbufferNdcPrevious = vClipPrevious.xy / vClipPrevious.w;
	gl_FragColor = vec4( normalize( normal ), clamp( roughnessFactor, 0.0, 1.0 ) );
	gVelocity = vec4(
		gbufferNdcCurrent - gbufferNdcPrevious,
		clamp( metalnessFactor, 0.0, 1.0 ),
		0.0
	);
`;

/**
 * Builds the prepass variant of a material.
 *
 * Cloning the real material rather than hand-rolling a shader is what makes
 * the normal, roughness and metalness in the G-buffer agree with what the
 * forward pass actually shades: every UV transform, define and texture channel
 * comes from three's own material system instead of being reimplemented. The
 * lighting tail of the shader is dead once the output is overwritten and the
 * compiler removes it.
 */
function buildVariant(source: THREE.Material, uniforms: PrepassUniforms): THREE.Material {
  const lit = source as THREE.MeshStandardMaterial;
  if (!lit.isMeshStandardMaterial) return buildGenericVariant(source, uniforms);

  const variant = lit.clone();
  variant.name = `${source.name}:gbuffer`;
  // Only the normal, roughness and metalness inputs matter; dropping the rest
  // shrinks the shader and avoids binding textures the prepass never reads.
  // `metalnessMap` is kept: it is usually the same packed ORM texture as
  // `roughnessMap`, so it costs no extra binding, and dropping it would flatten
  // every mapped metal to its scalar.
  if (variant.alphaTest <= 0) variant.map = null;
  variant.aoMap = null;
  variant.emissiveMap = null;
  variant.lightMap = null;
  variant.envMap = null;
  // A non-finite scalar reaches the shader as NaN, and a NaN metalness would
  // make a dielectric reflect like chrome rather than not at all.
  if (!Number.isFinite(variant.metalness)) variant.metalness = 0;
  if (!Number.isFinite(variant.roughness)) variant.roughness = 1;
  variant.transparent = false;
  variant.blending = THREE.NoBlending;
  variant.depthWrite = true;
  variant.depthTest = true;
  variant.fog = false;
  variant.dithering = false;
  variant.toneMapped = false;

  variant.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${VERTEX_DECLARATIONS}\n#include <common>`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MOTION}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `${FRAGMENT_DECLARATIONS}\n#include <common>`)
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>\n${FRAGMENT_OUTPUT}`
      );
  };
  variant.customProgramCacheKey = () => 'gbuffer';
  return variant;
}

/**
 * Fallback for materials outside the standard family (debug helpers, custom
 * shaders). Interpolated geometric normal, roughness pinned to 1, metalness
 * pinned to 0 — a material with no metalness input is a dielectric, and
 * guessing anything else would light it up in the reflections.
 */
function buildGenericVariant(source: THREE.Material, uniforms: PrepassUniforms): THREE.Material {
  const variant = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      uniform mat4 prevModelMatrix;
      uniform mat4 prevViewProjectionMatrix;
      out vec3 vViewNormal;
      out vec4 vClipCurrent;
      out vec4 vClipPrevious;
      void main() {
        vViewNormal = normalize( normalMatrix * normal );
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        vClipCurrent = gl_Position;
        vClipPrevious = prevViewProjectionMatrix * prevModelMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec2 gbufferJitter;
      in vec3 vViewNormal;
      in vec4 vClipCurrent;
      in vec4 vClipPrevious;
      layout(location = 0) out vec4 gNormalRoughness;
      layout(location = 1) out vec4 gVelocity;
      void main() {
        vec2 ndcCurrent = vClipCurrent.xy / vClipCurrent.w - gbufferJitter;
        vec2 ndcPrevious = vClipPrevious.xy / vClipPrevious.w;
        gNormalRoughness = vec4( normalize( vViewNormal ), 1.0 );
        gVelocity = vec4( ndcCurrent - ndcPrevious, 0.0, 0.0 );
      }
    `,
    side: source.side,
  });
  variant.name = `${source.name}:gbuffer`;
  return variant;
}

const BACKGROUND_CAMERA = /*@__PURE__*/ new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * Full-screen fill that gives background pixels a valid motion vector.
 *
 * A point at infinity only moves with camera rotation, which falls out of
 * transforming its direction by the previous view-projection with w = 0.
 */
function buildBackgroundFill(uniforms: Record<string, THREE.IUniform>): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: /* glsl */ `
      out vec2 vNdc;
      void main() {
        vNdc = position.xy;
        gl_Position = vec4( position.xy, 1.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform mat4 inverseViewProjection;
      uniform mat4 prevViewProjection;
      uniform vec3 cameraWorldPosition;
      uniform vec2 jitter;
      in vec2 vNdc;
      layout(location = 0) out vec4 gNormalRoughness;
      layout(location = 1) out vec4 gVelocity;
      void main() {
        vec4 farPoint = inverseViewProjection * vec4( vNdc, 1.0, 1.0 );
        vec3 direction = farPoint.xyz / farPoint.w - cameraWorldPosition;
        vec4 previous = prevViewProjection * vec4( direction, 0.0 );
        vec2 previousNdc = previous.xy / previous.w;
        // A zero-length normal is the agreed sentinel for "no surface here";
        // screen-space effects use it to reject sky and unwritten pixels.
        gNormalRoughness = vec4( 0.0, 0.0, 0.0, 1.0 );
        // Background metalness is 0: the sky is not a mirror, and anything the
        // depth pass later covers overwrites this.
        gVelocity = vec4( ( vNdc - jitter ) - previousNdc, 0.0, 0.0 );
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  material.name = 'gbuffer.background';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}
