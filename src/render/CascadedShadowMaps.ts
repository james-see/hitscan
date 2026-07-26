import * as THREE from 'three';
import { Photometry } from './Lighting.ts';
import { installForwardShadingChunks } from './ShadowShader.ts';
import { isLitMaterial } from './SceneMaterials.ts';

export interface CsmOptions {
  cascades: number;
  mapSize: number;
  maxDistance: number;
  soft: boolean;
}

/** Compile-time cascade slots. Fixed so a quality change never recompiles. */
const CASCADE_SLOTS = 4;

/** Largest single tile. A 2x2 atlas of these is the shadow memory budget. */
const MAX_TILE = 2048;

/**
 * Depth, in metres, that each cascade's orthographic volume is extended
 * backwards along the light so casters behind the visible slice still land in
 * the map. The arena's tallest geometry is 7m; at a 33-degree solar elevation
 * that reaches roughly 11m of shadow, and this leaves generous headroom for
 * anything the world module adds later.
 */
const CASTER_MARGIN = 60;

/**
 * Cascaded shadow maps with contact-hardening soft shadows.
 *
 * This is a bespoke implementation rather than three's `CSM` helper. That
 * helper works by adding one `DirectionalLight` per cascade and relying on the
 * light array index lining up with the cascade index. Any other directional
 * light in the scene shifts every index by one, at which point the near
 * cascade is lit by the wrong light and sampled against a shadow map that was
 * truncated off the end of the uniform array — the scene renders with no
 * direct sun in the near field and no shadows anywhere. It also burns four
 * light slots and cannot do a blocker search, because three's shadow samplers
 * are hardware comparison samplers.
 *
 * Instead:
 *   - one `DirectionalLight`, no three-managed shadow at all;
 *   - four cascades rendered into a single 2x2 depth atlas by this class;
 *   - a stable bounding-sphere fit per cascade, snapped to the texel grid, so
 *     the shadow does not crawl when the camera moves or turns;
 *   - PCSS in the shading pass: a blocker search sizes the filter kernel from
 *     the actual occluder distance, so contacts stay tight and distant
 *     silhouettes soften the way they do under a real sun.
 */
export class CascadedShadowMaps {
  #scene: THREE.Scene;
  #sun: THREE.DirectionalLight;
  #options: CsmOptions;
  #enabled = true;

  #tileSize: number;
  #atlasSize: number;
  #atlas: THREE.WebGLRenderTarget;
  #casterMaterial: THREE.MeshBasicMaterial;

  #cameras: THREE.OrthographicCamera[] = [];
  #viewports: THREE.Vector4[] = [];
  #activeCascades: number;

  #patched = new WeakSet<THREE.Material>();
  #hidden: THREE.Object3D[] = [];

  #lightDirection = new THREE.Vector3();
  #lightBasis = new THREE.Matrix4();
  #lightBasisInverse = new THREE.Matrix4();
  #splits: number[] = [];

  #uniforms = {
    csmShadowAtlas: { value: null as THREE.Texture | null },
    csmViewToShadow: {
      value: Array.from({ length: CASCADE_SLOTS }, () => new THREE.Matrix4()),
    },
    csmTileBounds: {
      value: Array.from({ length: CASCADE_SLOTS }, () => new THREE.Vector4()),
    },
    csmSplitFar: { value: new THREE.Vector4() },
    csmSplitNear: { value: new THREE.Vector4() },
    csmDepthRange: { value: new THREE.Vector4() },
    csmTexelWorld: { value: new THREE.Vector4() },
    csmUvPerMetre: { value: new THREE.Vector4() },
    csmShadowFar: { value: 100 },
    csmFadeStart: { value: 80 },
    /** Fraction of a cascade's range spent cross-fading into the next. */
    csmBlend: { value: 0.16 },
    /** Normal offset in shadow texels. */
    csmNormalBias: { value: 1.35 },
    /** Depth bias in shadow texels of world distance. */
    csmDepthBias: { value: 0.85 },
    csmSunTan: { value: 0 },
    csmMaxPenumbra: { value: 0.5 },
    csmIntensity: { value: 1 },
  };

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    sun: THREE.DirectionalLight,
    options: CsmOptions
  ) {
    installForwardShadingChunks();

    this.#scene = scene;
    this.#sun = sun;
    this.#options = options;
    this.#activeCascades = THREE.MathUtils.clamp(Math.floor(options.cascades), 1, CASCADE_SLOTS);
    this.#tileSize = Math.min(MAX_TILE, Math.max(512, options.mapSize));
    this.#atlasSize = this.#tileSize * 2;

    this.#atlas = createAtlas(this.#atlasSize);
    this.#uniforms.csmShadowAtlas.value = this.#atlas.depthTexture;

    this.#casterMaterial = new THREE.MeshBasicMaterial({
      // Depth is the only output; the colour attachment exists purely because
      // three always allocates one.
      colorWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1.0,
      polygonOffsetUnits: 1.0,
    });
    this.#casterMaterial.name = 'csm.caster';

    for (let i = 0; i < CASCADE_SLOTS; i++) {
      const cascadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      cascadeCamera.name = `csm.cascade${i}`;
      this.#cameras.push(cascadeCamera);

      const tx = (i % 2) * this.#tileSize;
      const ty = Math.floor(i / 2) * this.#tileSize;
      this.#viewports.push(new THREE.Vector4(tx, ty, this.#tileSize, this.#tileSize));
    }

    // A much larger apparent source than the real sun.
    //
    // The physical disc is half a degree, which puts the penumbra of a body
    // one metre off the ground at under a centimetre — below one shadow texel
    // in every cascade, so the blocker search does its job and the result is
    // still indistinguishable from a hard stencil. Contact hardening is only
    // legible if the *widest* penumbra in the frame is several texels across,
    // which means opening the source up until a seven-metre gantry throws an
    // edge tens of centimetres wide. The near contact stays tight regardless,
    // because separation there is genuinely near zero.
    this.#uniforms.csmSunTan.value =
      Math.tan(Photometry.SUN_ANGULAR_RADIUS) * (options.soft ? 11 : 2.5);
    this.#uniforms.csmMaxPenumbra.value = options.soft ? 0.85 : 0.2;

    sun.castShadow = false;
    this.#lightDirection.copy(sun.position).normalize().negate();
    this.update(camera);
  }

  /** Patches a material so its directional light samples the cascades. */
  setupMaterial(material: THREE.Material): void {
    if (this.#patched.has(material)) return;
    if (!isLitMaterial(material)) return;
    this.#patched.add(material);

    const defines = (material.defines ??= {});
    defines.CSM_ENABLED = '';
    defines.CSM_CASCADES = CASCADE_SLOTS;
    if (this.#options.soft) defines.CSM_PCSS = '';

    const previous = material.onBeforeCompile;
    const uniforms = this.#uniforms;
    material.onBeforeCompile = function (shader, renderer): void {
      previous.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
    };
    material.needsUpdate = true;
  }

  /**
   * Walks the scene and patches anything new.
   *
   * Cheap enough to run every frame: it is a graph walk plus a `WeakSet`
   * probe, and it removes the entire class of bug where geometry spawned at
   * runtime renders without shadows because a sync call was missed.
   */
  syncMaterials(): void {
    this.#scene.traverse(collectMaterials);
    for (const material of scratchMaterials) this.setupMaterial(material);
    scratchMaterials.length = 0;
  }

  /** Recomputes cascade volumes for the current view. Call before `render`. */
  update(camera: THREE.PerspectiveCamera): void {
    if (!this.#enabled) return;

    const far = Math.min(this.#options.maxDistance, camera.far);
    // Starting the split series at the true near plane wastes a whole cascade
    // on the first few centimetres.
    const near = Math.max(camera.near, 0.5);
    this.#computeSplits(near, far);

    this.#lightDirection.copy(this.#sun.position).normalize().negate();
    const up = Math.abs(this.#lightDirection.y) > 0.99 ? UP_ALTERNATE : UP;
    this.#lightBasis.lookAt(ORIGIN, this.#lightDirection, up);
    this.#lightBasisInverse.copy(this.#lightBasis).transpose();

    camera.updateMatrixWorld();
    const tanHalfY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanHalfX = tanHalfY * camera.aspect;
    const k2 = tanHalfX * tanHalfX + tanHalfY * tanHalfY;

    const forward = scratchVectorA.set(0, 0, -1).applyQuaternion(camera.quaternion);

    for (let i = 0; i < this.#activeCascades; i++) {
      const sliceNear = i === 0 ? near : this.#splits[i - 1]!;
      const sliceFar = this.#splits[i]!;
      const fit = frustumSliceSphere(sliceNear, sliceFar, k2);
      const distance = fit.center;
      // Quantise the extent so the player's FOV kick, which rewrites the
      // projection every frame, cannot continuously resize the cascade. A
      // changing extent changes the texel size, which moves the snapping grid
      // underneath the shadow and reintroduces the crawl that snapping exists
      // to remove.
      const radius = Math.ceil(fit.radius * 8) / 8;

      const center = scratchVectorB
        .copy(camera.position)
        .addScaledVector(forward, distance);

      // Snap the cascade centre to whole texels in light space. Without this
      // the shadow map resamples every frame and every edge crawls.
      const texel = (radius * 2) / this.#tileSize;
      center.applyMatrix4(this.#lightBasisInverse);
      center.x = Math.floor(center.x / texel) * texel;
      center.y = Math.floor(center.y / texel) * texel;
      center.applyMatrix4(this.#lightBasis);

      const depthRange = radius * 2 + CASTER_MARGIN;
      const cascadeCamera = this.#cameras[i]!;
      cascadeCamera.left = -radius;
      cascadeCamera.right = radius;
      cascadeCamera.top = radius;
      cascadeCamera.bottom = -radius;
      cascadeCamera.near = 0;
      cascadeCamera.far = depthRange;
      cascadeCamera.position
        .copy(center)
        .addScaledVector(this.#lightDirection, -(radius + CASTER_MARGIN));
      cascadeCamera.quaternion.setFromRotationMatrix(this.#lightBasis);
      cascadeCamera.updateMatrixWorld(true);
      cascadeCamera.updateProjectionMatrix();

      const tileU = (i % 2) * 0.5;
      const tileV = Math.floor(i / 2) * 0.5;
      const bias = scratchMatrix.set(
        0.25, 0, 0, tileU + 0.25,
        0, 0.25, 0, tileV + 0.25,
        0, 0, 0.5, 0.5,
        0, 0, 0, 1
      );

      const matrix = this.#uniforms.csmViewToShadow.value[i]!;
      matrix
        .copy(bias)
        .multiply(cascadeCamera.projectionMatrix)
        .multiply(cascadeCamera.matrixWorldInverse)
        // View space in, so the receiver never needs a world-position varying.
        .multiply(camera.matrixWorld);

      const inset = 1.5 / this.#atlasSize;
      this.#uniforms.csmTileBounds.value[i]!.set(
        tileU + inset,
        tileV + inset,
        tileU + 0.5 - inset,
        tileV + 0.5 - inset
      );

      setComponent(this.#uniforms.csmSplitNear.value, i, sliceNear);
      setComponent(this.#uniforms.csmSplitFar.value, i, sliceFar);
      setComponent(this.#uniforms.csmDepthRange.value, i, depthRange);
      setComponent(this.#uniforms.csmTexelWorld.value, i, texel);
      setComponent(this.#uniforms.csmUvPerMetre.value, i, 0.5 / (radius * 2));
    }

    // Unused slots mirror the last active cascade so the selection loop in the
    // shader resolves to it without a dynamic cascade count.
    const last = this.#activeCascades - 1;
    for (let i = this.#activeCascades; i < CASCADE_SLOTS; i++) {
      this.#uniforms.csmViewToShadow.value[i]!.copy(this.#uniforms.csmViewToShadow.value[last]!);
      this.#uniforms.csmTileBounds.value[i]!.copy(this.#uniforms.csmTileBounds.value[last]!);
      copyComponent(this.#uniforms.csmSplitNear.value, i, last);
      copyComponent(this.#uniforms.csmSplitFar.value, i, last);
      copyComponent(this.#uniforms.csmDepthRange.value, i, last);
      copyComponent(this.#uniforms.csmTexelWorld.value, i, last);
      copyComponent(this.#uniforms.csmUvPerMetre.value, i, last);
    }

    this.#uniforms.csmShadowFar.value = far;
    this.#uniforms.csmFadeStart.value = far * 0.82;
  }

  /**
   * Renders every cascade into the atlas.
   *
   * Runs from the pipeline rather than a module update so it sees the final
   * camera transform for the frame; a shadow map fitted to last frame's camera
   * pops visibly at the cascade edges when the player turns quickly.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (!this.#enabled) return;

    this.#hideNonCasters(scene);
    const previousOverride = scene.overrideMaterial;
    const previousTarget = renderer.getRenderTarget();
    const previousViewport = renderer.getViewport(scratchViewport);
    scene.overrideMaterial = this.#casterMaterial;

    renderer.setRenderTarget(this.#atlas);
    renderer.setScissorTest(false);
    // Colour is never written, so only depth needs clearing.
    renderer.clear(false, true, false);

    for (let i = 0; i < this.#activeCascades; i++) {
      renderer.state.viewport(this.#viewports[i]!);
      renderer.render(scene, this.#cameras[i]!);
    }

    scene.overrideMaterial = previousOverride;
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport);
    this.#restoreNonCasters();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#uniforms.csmIntensity.value = enabled ? 1 : 0;
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.#lightDirection.copy(direction).normalize().negate();
  }

  get atlas(): THREE.Texture {
    return this.#atlas.depthTexture as THREE.Texture;
  }

  get splits(): readonly number[] {
    return this.#splits;
  }

  dispose(): void {
    this.#atlas.depthTexture?.dispose();
    this.#atlas.dispose();
    this.#casterMaterial.dispose();
  }

  /**
   * Practical split scheme: a blend of logarithmic and uniform. Logarithmic
   * alone starves the far cascades, uniform alone wastes resolution up close.
   */
  #computeSplits(near: number, far: number): void {
    const count = this.#activeCascades;
    const lambda = 0.78;
    this.#splits.length = count;
    for (let i = 1; i <= count; i++) {
      const logSplit = near * Math.pow(far / near, i / count);
      const uniformSplit = near + (far - near) * (i / count);
      this.#splits[i - 1] = lambda * logSplit + (1 - lambda) * uniformSplit;
    }
    this.#splits[count - 1] = far;
  }

  #hideNonCasters(scene: THREE.Scene): void {
    scene.traverse((object) => {
      if (!object.visible) return;
      const renderable = object as THREE.Mesh & { isLine?: boolean; isPoints?: boolean };
      if (!renderable.isMesh && !renderable.isLine && !renderable.isPoints) return;
      if (object.castShadow) return;
      object.visible = false;
      this.#hidden.push(object);
    });
  }

  #restoreNonCasters(): void {
    for (const object of this.#hidden) object.visible = true;
    this.#hidden.length = 0;
  }
}

const UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);
const UP_ALTERNATE = /*@__PURE__*/ new THREE.Vector3(0, 0, 1);
const ORIGIN = /*@__PURE__*/ new THREE.Vector3();
const scratchVectorA = /*@__PURE__*/ new THREE.Vector3();
const scratchVectorB = /*@__PURE__*/ new THREE.Vector3();
const scratchMatrix = /*@__PURE__*/ new THREE.Matrix4();
const scratchViewport = /*@__PURE__*/ new THREE.Vector4();
const scratchMaterials: THREE.Material[] = [];

function collectMaterials(object: THREE.Object3D): void {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh || !mesh.material) return;
  if (Array.isArray(mesh.material)) scratchMaterials.push(...mesh.material);
  else scratchMaterials.push(mesh.material);
}

/**
 * Smallest sphere enclosing a perspective frustum slice.
 *
 * Fitting a sphere rather than a light-space box is what makes the cascade
 * invariant to camera rotation: the extent depends only on the split
 * distances, so texel snapping alone is enough to freeze the map.
 */
function frustumSliceSphere(near: number, far: number, k2: number): { center: number; radius: number } {
  const center = ((near + far) * (k2 + 1)) / 2;
  if (center >= far) {
    return { center: far, radius: far * Math.sqrt(k2) };
  }
  const radius = Math.sqrt(far * far * (k2 + 1) - 2 * far * center + center * center);
  return { center, radius };
}

function createAtlas(size: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  target.texture.name = 'csm.atlasColor';

  // A real depth texture rather than a renderbuffer: PCSS needs to read raw
  // occluder depth for the blocker search, which a hardware comparison
  // sampler cannot provide.
  const depth = new THREE.DepthTexture(size, size);
  depth.type = THREE.UnsignedIntType;
  depth.format = THREE.DepthFormat;
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  depth.compareFunction = null;
  depth.name = 'csm.atlas';
  target.depthTexture = depth;
  return target;
}

function setComponent(target: THREE.Vector4, index: number, value: number): void {
  if (index === 0) target.x = value;
  else if (index === 1) target.y = value;
  else if (index === 2) target.z = value;
  else target.w = value;
}

function getComponent(source: THREE.Vector4, index: number): number {
  if (index === 0) return source.x;
  if (index === 1) return source.y;
  if (index === 2) return source.z;
  return source.w;
}

function copyComponent(target: THREE.Vector4, index: number, from: number): void {
  setComponent(target, index, getComponent(target, from));
}
