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
 *        shades with. That means `material.roughness * roughnessMap.g` AND
 *        whatever the material's own compile hook does to `roughnessFactor`
 *        after it -- the world's detail layer swings it by up to half a unit
 *        per material. GGX alpha is `a * a`.
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
 *   b    metalness in [0,1], the same value the forward pass shades with:
 *        `material.metalness * metalnessMap.b`, plus the material's own hook.
 *        ZERO IS A REAL VALUE here,
 *        not a sentinel: most of the scene is dielectric and must read 0 so
 *        reflections stay at a dielectric Fresnel. Use the zero-length normal
 *        in attachment 0 to detect "no surface".
 *   a    VIEWMODEL FLAG. 1.0 for pixels covered by the first-person weapon,
 *        0.0 for everything else, including sky and background. See
 *        `renderViewmodel` for what it means and who must honour it.
 *
 * depth (`gbuffer.depth`, DEPTH24_STENCIL8)
 *   Non-linear window depth in [0,1] from the SAME projection the forward
 *   pass uses, including jitter. Linearise with the camera's near/far.
 *   Viewmodel pixels are re-encoded into that same range despite being
 *   rasterised with a different projection, so one linearisation is correct
 *   for the whole buffer.
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
  /**
   * World-camera depth encoding coefficients, `((f+n)/(f-n), -2fn/(f-n))`.
   * Only the viewmodel flavour reads them; see `VIEWMODEL_FRAGMENT_DEPTH`.
   */
  #depthRange = { value: new THREE.Vector2() };

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

    this.#prepare(scene, 'world');

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

  /**
   * Appends the first-person weapon to an already-filled G-buffer, flagged.
   *
   * WHY THE WEAPON IS IN HERE AT ALL, AND WHY IT IS FLAGGED
   *
   * The viewmodel is rasterised with its own camera and a much narrower field
   * of view, because a rifle drawn at the world's 90 degrees is grotesquely
   * distorted at the frame edges. That constant is a deliberate art control,
   * not an inconsistency to be unified away, so it stays — but it means a
   * consumer that reconstructs a view-space position from a pixel coordinate
   * and the world camera's inverse projection gets the weapon's geometry
   * stretched by the ratio of the two tangents. At the FOVs this game ships
   * that is a factor of about 2.1, which is far too wrong to trace against.
   *
   * So the weapon is written and then excluded, per pass, by consumer:
   *
   *   ACCEPT  motion blur and TAA. Both want only `velocity.rg`, which is
   *           computed from the viewmodel's own projection and is therefore
   *           correct in screen space no matter what the FOV is. Before this,
   *           weapon pixels carried the motion of whatever world geometry was
   *           behind them, so a rifle held still while the player turned
   *           smeared with the wall.
   *
   *   REJECT  reflections, and any occlusion pass that runs after this draw.
   *           Not a limitation being worked around: a weapon that casts
   *           occlusion into the world while receiving none is a dark halo
   *           bought for nothing, and its contact shading is already authored
   *           into the model and served by its own probe. This module's own
   *           occlusion trace is excluded by frame order rather than by testing
   *           the flag — the pipeline runs it before this draw. See
   *           `ScreenSpaceOcclusion`'s header for why that is the better of the
   *           two arrangements.
   *
   * Transparent weapon parts — the optic lens, the muzzle flash — are absent
   * and unflagged, exactly as transparent world geometry is, because the same
   * `isEligible` test governs both. On the shots that carry a weapon the flag
   * covers 8.2% of the frame from the hip and 12.2% down the sights.
   *
   * DEPTH. `gl_FragDepth` re-encodes each fragment into the world camera's
   * near/far window range rather than leaving it in the viewmodel camera's.
   * Both are needed at once: the depth *test* has to run in a single range or
   * the weapon fails to self-occlude, and a consumer linearising the buffer
   * has to get metres out for weapon pixels as well as world ones. The
   * viewmodel near plane is centimetres in front of the world's, so encoding
   * in the viewmodel's range instead would have crushed the entire world into
   * the last sliver of the buffer. Read back through the world camera's
   * near/far, weapon pixels linearise to 0.43–1.22m from the hip and
   * 0.04–0.43m down the sights, against a mean 3.0–4.6m for the world they
   * covered.
   *
   * @param worldCamera the camera every consumer reconstructs positions with
   * @param prevViewProjection unjittered VIEWMODEL view-projection, last frame
   */
  renderViewmodel(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Object3D,
    camera: THREE.PerspectiveCamera,
    worldCamera: THREE.PerspectiveCamera,
    gbuffer: GBuffer,
    prevViewProjection: THREE.Matrix4,
    jitter: THREE.Vector2
  ): void {
    this.#prevViewProjection.value.copy(prevViewProjection);
    this.#jitter.value.copy(jitter);

    const near = worldCamera.near;
    const far = worldCamera.far;
    const span = Math.max(far - near, 1e-6);
    this.#depthRange.value.set((far + near) / span, (-2 * far * near) / span);

    this.#prepare(scene, 'viewmodel');

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(gbuffer.target);
    // No clear of any kind: this draw is additive to the world's G-buffer.
    //
    // It therefore depth-tests against the world, which the forward pass does
    // not -- that clears depth first so the weapon can never be clipped by
    // scenery. The two disagree only where world geometry is nearer than the
    // weapon, i.e. pressed into a wall, and there the flag is absent and those
    // pixels behave exactly as they do today. Making the weapon win outright
    // instead would need a depth test that ignores the world while still
    // ordering the weapon against itself, which one draw into a shared buffer
    // cannot express.
    renderer.render(scene, camera);

    renderer.setRenderTarget(previousTarget);
    this.#restore();
  }

  dispose(): void {
    this.#background.geometry.dispose();
    (this.#background.material as THREE.Material).dispose();
  }

  #prepare(scene: THREE.Object3D, flavour: Flavour): void {
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
      const entry = this.#entryFor(mesh, flavour);
      entry.source = mesh.material;
      mesh.material = entry.variant;
      for (const uniforms of entry.uniforms) {
        uniforms.prevModelMatrix.value.copy(entry.prevMatrixWorld);
        uniforms.prevViewProjectionMatrix.value.copy(this.#prevViewProjection.value);
        uniforms.gbufferJitter.value.copy(this.#jitter.value);
        uniforms.gbufferDepthRange.value.copy(this.#depthRange.value);
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

  #entryFor(mesh: THREE.Mesh, flavour: Flavour): PrepassEntry {
    const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const existing = this.#entries.get(mesh);
    if (
      existing &&
      existing.builtFrom === mesh.material &&
      existing.flavour === flavour &&
      hooksUnchanged(existing.builtFromHooks, sources)
    ) {
      return existing;
    }

    // The variant snapshots the source's compile hook, so a material patched
    // after its variant was built would otherwise keep rendering the surface
    // response it had at first draw. `SceneMaterials.sync` patches every frame
    // and the world decorates at load, so this is the guard that stops the two
    // definitions drifting apart again.
    if (existing) disposeVariants(existing.variant);

    const uniforms: PrepassUniforms[] = [];
    const variants = sources.map((source) => {
      const set = createUniformSet();
      uniforms.push(set);
      return buildVariant(source, set, flavour);
    });

    const entry: PrepassEntry = {
      mesh,
      builtFrom: mesh.material,
      builtFromHooks: sources.map((source) => source?.onBeforeCompile),
      flavour,
      source: mesh.material,
      variant: Array.isArray(mesh.material) ? variants : variants[0]!,
      uniforms,
      prevMatrixWorld: new THREE.Matrix4().copy(mesh.matrixWorld),
    };
    this.#entries.set(mesh, entry);
    return entry;
  }
}

/**
 * Which camera a variant is rasterised with, and therefore whether it re-encodes
 * depth and raises the viewmodel flag. Baked into the shader source rather than
 * driven by a uniform: a mesh belongs to exactly one of the two scenes for its
 * whole life, so there is nothing to switch at runtime.
 */
type Flavour = 'world' | 'viewmodel';

type CompileHook = THREE.Material['onBeforeCompile'] | undefined;

function hooksUnchanged(built: readonly CompileHook[], sources: readonly THREE.Material[]): boolean {
  if (built.length !== sources.length) return false;
  for (let i = 0; i < sources.length; i++) {
    if (built[i] !== sources[i]?.onBeforeCompile) return false;
  }
  return true;
}

function disposeVariants(variant: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(variant)) for (const m of variant) m.dispose();
  else variant.dispose();
}

interface PrepassUniforms {
  prevModelMatrix: { value: THREE.Matrix4 };
  prevViewProjectionMatrix: { value: THREE.Matrix4 };
  gbufferJitter: { value: THREE.Vector2 };
  gbufferDepthRange: { value: THREE.Vector2 };
}

interface PrepassEntry {
  mesh: THREE.Mesh;
  builtFrom: THREE.Material | THREE.Material[];
  /** Compile hooks the variants were built from. A change forces a rebuild. */
  builtFromHooks: readonly CompileHook[];
  flavour: Flavour;
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
    gbufferDepthRange: { value: new THREE.Vector2() },
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
uniform vec2 gbufferDepthRange;
varying vec4 vClipCurrent;
varying vec4 vClipPrevious;
`;

/**
 * Re-encodes the fragment into the world camera's depth range.
 *
 * `vClipCurrent.w` is `-z_view` under the viewmodel projection, and it survives
 * interpolation exactly: perspective-correct interpolation of `w` reduces to
 * `1 / sum( bary / w )`, which is the true `w` at the pixel. The TAA jitter
 * does not disturb it either, since that is added to the two clip *offset*
 * terms and leaves the `w` row alone.
 *
 * From there this is the standard perspective depth encoding rearranged, with
 * the world camera's coefficients supplied instead of this camera's:
 *
 *   ndc_z = (f+n)/(f-n) - (2fn/(f-n)) / viewZ
 *
 * Anything nearer than the world near plane clamps to 0 rather than wrapping,
 * which matters because the viewmodel near plane is deliberately far closer;
 * a clamped fragment still orders correctly against the rest of the weapon
 * unless two of them are both in front of the world near plane, which at 5cm
 * would mean the stock intersecting the eye.
 */
const VIEWMODEL_FRAGMENT_DEPTH = /* glsl */ `
	float gbufferViewZ = max( vClipCurrent.w, 1e-6 );
	gl_FragDepth = clamp(
		( gbufferDepthRange.x + gbufferDepthRange.y / gbufferViewZ ) * 0.5 + 0.5,
		0.0,
		1.0
	);
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
function fragmentOutput(flavour: Flavour): string {
  const viewmodel = flavour === 'viewmodel';
  return /* glsl */ `
	vec2 gbufferNdcCurrent = vClipCurrent.xy / vClipCurrent.w - gbufferJitter;
	vec2 gbufferNdcPrevious = vClipPrevious.xy / vClipPrevious.w;
	gl_FragColor = vec4( normalize( normal ), clamp( roughnessFactor, 0.0, 1.0 ) );
	gVelocity = vec4(
		gbufferNdcCurrent - gbufferNdcPrevious,
		clamp( metalnessFactor, 0.0, 1.0 ),
		${viewmodel ? '1.0' : '0.0'}
	);
${viewmodel ? VIEWMODEL_FRAGMENT_DEPTH : ''}`;
}

/** Three's own no-op hook, used to spot a material that has its own. */
const DEFAULT_ON_BEFORE_COMPILE = THREE.Material.prototype.onBeforeCompile;

/**
 * Builds the prepass variant of a material.
 *
 * Cloning the real material rather than hand-rolling a shader is what makes
 * the normal, roughness and metalness in the G-buffer agree with what the
 * forward pass actually shades: every UV transform, define and texture channel
 * comes from three's own material system instead of being reimplemented. The
 * lighting tail of the shader is dead once the output is overwritten and the
 * compiler removes it.
 *
 * THE PREPASS COMPOSES, IT DOES NOT REPLACE. Materials in this project carry
 * their surface response in `onBeforeCompile`: the world layer modulates
 * `roughnessFactor` from a world-space detail field (`world/kit/Surfaces.ts`)
 * and the viewmodel modulates `roughnessFactor` and `metalnessFactor` from
 * baked curvature (`weapon/models/EdgeWear.ts`). Overwriting the hook, which
 * is what this used to do, compiled a different shader from the one the
 * forward pass shades with, so the G-buffer disagreed with the picture and
 * every consumer was quietly misled. Running the material's own hook first and
 * appending to its output keeps one definition of the modulation instead of a
 * copy here that has to be kept in step.
 *
 * `clone()` copies neither `defines` nor the hooks, so all three are carried
 * across by hand.
 */
function buildVariant(
  source: THREE.Material,
  uniforms: PrepassUniforms,
  flavour: Flavour
): THREE.Material {
  const lit = source as THREE.MeshStandardMaterial;
  if (!lit.isMeshStandardMaterial) return buildGenericVariant(source, uniforms, flavour);

  const variant = lit.clone();
  variant.name = `${source.name}:gbuffer`;

  const inherited =
    source.onBeforeCompile !== DEFAULT_ON_BEFORE_COMPILE ? source.onBeforeCompile : null;
  // Defines are copied wholesale rather than by name. The prepass has no
  // business knowing which flags the world or weapon layer uses, and the same
  // composed hook that needs them also supplies the uniforms they reference.
  if (source.defines !== undefined) {
    variant.defines = { ...variant.defines, ...source.defines };
  }

  // Inputs the prepass has no output channel for. `map` is the exception once
  // something is composed on top: an inherited layer may read `vMapUv`, which
  // exists only while the albedo is bound, and guessing which varyings the
  // layer needs is the coupling this composition exists to remove.
  if (inherited === null && variant.alphaTest <= 0) variant.map = null;
  variant.aoMap = null;
  variant.emissiveMap = null;
  variant.lightMap = null;
  variant.envMap = null;
  // `metalnessMap` is kept: it is usually the same packed ORM texture as
  // `roughnessMap`, so it costs no extra binding, and dropping it would flatten
  // every mapped metal to its scalar.
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

  variant.onBeforeCompile = function (shader, renderer): void {
    // First, so the prepass output is appended to the material's finished
    // surface response rather than to three's unmodulated one.
    inherited?.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${VERTEX_DECLARATIONS}\n#include <common>`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MOTION}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `${FRAGMENT_DECLARATIONS}\n#include <common>`)
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>\n${fragmentOutput(flavour)}`
      );
  };
  // Composed from the source's key, not a constant: two materials that compile
  // different surface layers must not share a program, and the world layer
  // relies on its key to keep its own variants apart. The flavour is in there
  // because the two differ only in appended source, which three cannot see.
  const sourceCacheKey = lit.customProgramCacheKey();
  variant.customProgramCacheKey = () => `gbuffer:${flavour}:${sourceCacheKey}`;
  return variant;
}

/**
 * Fallback for materials outside the standard family (debug helpers, custom
 * shaders). Interpolated geometric normal, roughness pinned to 1, metalness
 * pinned to 0 — a material with no metalness input is a dielectric, and
 * guessing anything else would light it up in the reflections.
 */
function buildGenericVariant(
  source: THREE.Material,
  uniforms: PrepassUniforms,
  flavour: Flavour
): THREE.Material {
  const viewmodel = flavour === 'viewmodel';
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
      uniform vec2 gbufferDepthRange;
      in vec3 vViewNormal;
      in vec4 vClipCurrent;
      in vec4 vClipPrevious;
      layout(location = 0) out vec4 gNormalRoughness;
      layout(location = 1) out vec4 gVelocity;
      void main() {
        vec2 ndcCurrent = vClipCurrent.xy / vClipCurrent.w - gbufferJitter;
        vec2 ndcPrevious = vClipPrevious.xy / vClipPrevious.w;
        gNormalRoughness = vec4( normalize( vViewNormal ), 1.0 );
        gVelocity = vec4( ndcCurrent - ndcPrevious, 0.0, ${viewmodel ? '1.0' : '0.0'} );
        ${viewmodel ? VIEWMODEL_FRAGMENT_DEPTH : ''}
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
