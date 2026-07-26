import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import type { SurfaceKind } from '@/types/gameplay.ts';
import { DecalProjector, DECAL_VERTEX_STRIDE, type DecalProjection } from './DecalProjector.ts';
import { DecalTile, buildDecalAtlas, type DecalAtlas } from '../core/Textures.ts';

/** Vertex budget per decal. A hole spans one or two source triangles. */
const VERTICES_PER_DECAL = 48;

const SURFACE_TILE: Record<SurfaceKind, number> = {
  concrete: DecalTile.Concrete,
  metal: DecalTile.Metal,
  wood: DecalTile.Wood,
  dirt: DecalTile.Dirt,
  sand: DecalTile.Sand,
  glass: DecalTile.Glass,
  water: DecalTile.Dirt,
  fabric: DecalTile.Fabric,
  foliage: DecalTile.Fabric,
  flesh: DecalTile.Flesh,
};

/**
 * Decal width in metres. Sized against the round, not the texture: a rifle
 * hole in concrete is a ~1cm perforation inside a ~6cm spall ring, so the
 * quad only needs to be wide enough to hold the spall and its dust halo.
 */
const SURFACE_SIZE: Record<SurfaceKind, number> = {
  concrete: 0.12,
  metal: 0.085,
  wood: 0.105,
  dirt: 0.16,
  sand: 0.18,
  glass: 0.22,
  water: 0.12,
  fabric: 0.09,
  foliage: 0.1,
  flesh: 0.085,
};

const _origin = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _basisX = new THREE.Vector3();
const _basisY = new THREE.Vector3();
const _seed = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _meshMatrix = new THREE.Matrix4();
const _instanceMatrix = new THREE.Matrix4();

const DECAL_VERTEX = /* glsl */ `
attribute vec3 aTangent;
attribute vec2 aDecal;

uniform float uTime;
uniform float uFadeOut;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vTangent;
varying float vFade;

void main() {
  vUv = uv;
  vNormal = normal;
  vTangent = aTangent;

  float life = aDecal.y;
  float age = uTime - aDecal.x;
  float fadeIn = smoothstep(0.0, 0.05, age);
  float fadeOut = 1.0 - smoothstep(max(life - uFadeOut, 0.0), life, age);
  vFade = life > 0.0 ? clamp(fadeIn * fadeOut, 0.0, 1.0) : 0.0;

  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const DECAL_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uAlbedo;
uniform sampler2D uNormalMap;
uniform vec3 uSunDirection;
uniform float uAmbient;
uniform float uNormalStrength;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vTangent;
varying float vFade;

void main() {
  if (vFade <= 0.002) discard;

  vec4 texel = texture2D(uAlbedo, vUv);
  float coverage = texel.a * vFade;
  if (coverage < 0.004) discard;

  vec3 n = normalize(vNormal);
  vec3 t = normalize(vTangent - n * dot(n, vTangent));
  vec3 b = cross(n, t);
  vec3 tn = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
  tn.xy *= uNormalStrength;
  vec3 bumped = normalize(t * tn.x + b * tn.y + n * tn.z);

  // The decal multiplies the already-lit surface, so shading is expressed as
  // the *ratio* between the crater's response and the flat wall's. That way
  // the hole inherits shadowing, ambient occlusion and exposure for free.
  // Not named "flat": that is a reserved interpolation qualifier in GLSL.
  float planar = max(dot(n, uSunDirection), 0.0);
  float bump = max(dot(bumped, uSunDirection), 0.0);
  float ratio = clamp((bump + uAmbient) / (planar + uAmbient), 0.25, 2.6);

  vec3 tint = texel.rgb * 2.0;
  vec3 result = mix(vec3(1.0), tint * ratio, coverage);
  gl_FragColor = vec4(result, 1.0);
}
`;

/**
 * Pooled projected decals.
 *
 * All decals live in one buffer and one draw call. Slots are recycled in a
 * ring, and the lifetime is derived from `maxDecals` so that under sustained
 * automatic fire a decal always reaches the end of its fade before its slot
 * is needed again — recycling a decal that is still fully opaque is what
 * makes bullet holes visibly blink out of existence.
 */
export class DecalSystem {
  readonly mesh: THREE.Mesh;
  readonly atlas: DecalAtlas;

  #capacity: number;
  #data: Float32Array;
  #buffer: THREE.InterleavedBuffer;
  #geometry: THREE.BufferGeometry;
  #material: THREE.ShaderMaterial;
  #projector = new DecalProjector();
  #rng: Rng;
  #cursor = 0;
  #highWater = 0;
  #placed = 0;
  #noTarget = 0;
  #noClip = 0;
  #life: number;
  #fadeOut: number;
  #time = 0;

  #raycaster = new THREE.Raycaster();
  #hits: THREE.Intersection[] = [];
  #rayOrigin = new THREE.Vector3();
  #rayDirection = new THREE.Vector3();
  #projection: DecalProjection = {
    position: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    roll: 0,
    width: 0.12,
    height: 0.12,
    depth: 0.1,
    uvOriginX: 0,
    uvOriginY: 0,
    uvScaleX: 0.25,
    uvScaleY: 0.5,
  };

  constructor(rng: Rng, maxDecals: number) {
    this.#rng = rng;
    this.#capacity = Math.max(8, maxDecals | 0);
    this.atlas = buildDecalAtlas(rng.fork('decals'));

    // Chosen so a decal always finishes fading before its slot comes round
    // again at a 700rpm cyclic rate.
    this.#life = THREE.MathUtils.clamp(this.#capacity / 12, 6, 40);
    this.#fadeOut = Math.min(4, this.#life * 0.3);

    const vertexCount = this.#capacity * VERTICES_PER_DECAL;
    this.#data = new Float32Array(vertexCount * DECAL_VERTEX_STRIDE);
    this.#buffer = new THREE.InterleavedBuffer(this.#data, DECAL_VERTEX_STRIDE);
    this.#buffer.setUsage(THREE.DynamicDrawUsage);

    this.#geometry = new THREE.BufferGeometry();
    this.#geometry.setAttribute(
      'position',
      new THREE.InterleavedBufferAttribute(this.#buffer, 3, 0)
    );
    this.#geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(this.#buffer, 3, 3));
    this.#geometry.setAttribute(
      'aTangent',
      new THREE.InterleavedBufferAttribute(this.#buffer, 3, 6)
    );
    this.#geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(this.#buffer, 2, 9));
    this.#geometry.setAttribute('aDecal', new THREE.InterleavedBufferAttribute(this.#buffer, 2, 11));
    this.#geometry.setDrawRange(0, 0);
    this.#geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.#material = new THREE.ShaderMaterial({
      uniforms: {
        uAlbedo: { value: this.atlas.albedo },
        uNormalMap: { value: this.atlas.normal },
        uTime: { value: 0 },
        uFadeOut: { value: this.#fadeOut },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uAmbient: { value: 0.35 },
        uNormalStrength: { value: 1.35 },
      },
      vertexShader: DECAL_VERTEX,
      fragmentShader: DECAL_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // Multiplicative: `result = fragment * framebuffer`. Values above one
      // brighten, which is how a sunlit crater lip reads as raised.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    this.#material.name = 'vfx.decals';

    this.mesh = new THREE.Mesh(this.#geometry, this.#material);
    this.mesh.name = 'vfx.decals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 4;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = (): void => {};

    this.#raycaster.near = 0;
    this.#raycaster.far = 0.6;
  }

  /** Projection outcomes, split so a failure can be attributed. */
  get stats(): { placed: number; noTarget: number; noClip: number } {
    return { placed: this.#placed, noTarget: this.#noTarget, noClip: this.#noClip };
  }

  setTime(time: number): void {
    this.#time = time;
    this.#material.uniforms.uTime!.value = time;
  }

  setLighting(sunDirection: THREE.Vector3, ambient: number): void {
    (this.#material.uniforms.uSunDirection!.value as THREE.Vector3)
      .copy(sunDirection)
      .normalize();
    this.#material.uniforms.uAmbient!.value = ambient;
  }

  /**
   * Projects a bullet hole onto whatever static geometry is at `point`.
   *
   * @returns true when geometry was found and a decal was written.
   */
  place(
    scene: THREE.Object3D,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    incoming: THREE.Vector3,
    surface: SurfaceKind,
    scale = 1
  ): boolean {
    // Trimesh hits report the triangle's own normal, which points away from
    // the shooter on half of all geometry. Everything downstream assumes it
    // faces the incoming round.
    _normal.copy(normal).normalize();
    if (_normal.dot(incoming) > 0) _normal.negate();
    normal = _normal;

    // Search back along the surface normal: the physics hit point sits on the
    // collider, which is not always exactly on the render mesh.
    this.#rayOrigin.copy(normal).multiplyScalar(0.3).add(point);
    this.#rayDirection.copy(normal).multiplyScalar(-1).normalize();
    this.#raycaster.set(this.#rayOrigin, this.#rayDirection);
    this.#hits.length = 0;
    this.#raycaster.intersectObject(scene, true, this.#hits);

    let target: THREE.Mesh | null = null;
    for (const hit of this.#hits) {
      const mesh = hit.object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) continue;
      // Skinned geometry moves every frame; a static projection would peel
      // off the model as soon as it animated.
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) continue;
      target = mesh;
      _origin.copy(hit.point);
      mesh.updateWorldMatrix(true, false);
      _meshMatrix.copy(mesh.matrixWorld);
      // Instanced props keep their placement in the instance matrix, which
      // the object's world matrix knows nothing about.
      const instanced = mesh as THREE.InstancedMesh;
      if (instanced.isInstancedMesh && hit.instanceId !== undefined) {
        instanced.getMatrixAt(hit.instanceId, _instanceMatrix);
        _meshMatrix.multiply(_instanceMatrix);
      }
      break;
    }
    if (!target) {
      this.#noTarget++;
      return false;
    }

    const tile = SURFACE_TILE[surface] ?? DecalTile.Concrete;
    const size = (SURFACE_SIZE[surface] ?? 0.13) * scale * this.#rng.range(0.85, 1.2);

    // Grazing hits tear an elongated hole. Aligning the stretch with the
    // round's path across the surface is a strong readability cue for angle.
    const incidence = Math.abs(incoming.dot(normal));
    const elongation = THREE.MathUtils.clamp(1 / Math.max(incidence, 0.001), 1, 1.7);
    _tangent.copy(incoming).addScaledVector(normal, -incoming.dot(normal));
    const tangentLength = _tangent.length();

    const projection = this.#projection;
    projection.position.copy(_origin);
    projection.normal.copy(normal);
    projection.width = size;
    projection.height = size * elongation;
    projection.depth = Math.max(0.06, size * 0.8);
    projection.roll =
      tangentLength > 1e-4
        ? rollForTangent(normal, _tangent.divideScalar(tangentLength))
        : this.#rng.range(0, Math.PI * 2);
    projection.uvOriginX = (tile % this.atlas.cols) / this.atlas.cols;
    projection.uvOriginY = Math.floor(tile / this.atlas.cols) / this.atlas.rows;
    projection.uvScaleX = 1 / this.atlas.cols;
    projection.uvScaleY = 1 / this.atlas.rows;

    const slot = this.#cursor % this.#capacity;
    this.#cursor++;
    const vertexOffset = slot * VERTICES_PER_DECAL;
    const floatOffset = vertexOffset * DECAL_VERTEX_STRIDE;
    const data = this.#data;

    const written = this.#projector.build(
      target.geometry,
      _meshMatrix,
      projection,
      data,
      floatOffset,
      VERTICES_PER_DECAL
    );
    if (written === 0) {
      // Nothing clipped: leave the slot degenerate rather than showing a
      // stale decal, and give the slot straight back.
      data.fill(0, floatOffset, floatOffset + VERTICES_PER_DECAL * DECAL_VERTEX_STRIDE);
      this.#flush(floatOffset);
      this.#noClip++;
      return false;
    }

    for (let v = 0; v < written; v++) {
      const o = floatOffset + v * DECAL_VERTEX_STRIDE;
      data[o + 11] = this.#time;
      data[o + 12] = this.#life;
    }
    // Collapse the unused tail of the slot so it rasterises nothing.
    data.fill(
      0,
      floatOffset + written * DECAL_VERTEX_STRIDE,
      floatOffset + VERTICES_PER_DECAL * DECAL_VERTEX_STRIDE
    );

    this.#flush(floatOffset);
    this.#highWater = Math.max(this.#highWater, vertexOffset + VERTICES_PER_DECAL);
    this.#geometry.setDrawRange(0, this.#highWater);
    this.#placed++;
    return true;
  }

  clear(): void {
    this.#data.fill(0);
    this.#buffer.needsUpdate = true;
    this.#cursor = 0;
    this.#highWater = 0;
    this.#geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.#geometry.dispose();
    this.#material.dispose();
    this.atlas.albedo.dispose();
    this.atlas.normal.dispose();
  }

  #flush(floatOffset: number): void {
    this.#buffer.addUpdateRange(floatOffset, VERTICES_PER_DECAL * DECAL_VERTEX_STRIDE);
    this.#buffer.needsUpdate = true;
  }
}

/**
 * Roll that aligns the projector's local Y axis with `tangent`.
 *
 * Mirrors the basis construction in `DecalProjector`; the two must agree or
 * the elongation points the wrong way.
 */
export function rollForTangent(normal: THREE.Vector3, tangent: THREE.Vector3): number {
  if (Math.abs(normal.y) < 0.985) _seed.set(0, 1, 0);
  else _seed.set(1, 0, 0);
  _basisX.crossVectors(_seed, normal).normalize();
  _basisY.crossVectors(normal, _basisX).normalize();
  return Math.atan2(-tangent.dot(_basisX), tangent.dot(_basisY));
}
