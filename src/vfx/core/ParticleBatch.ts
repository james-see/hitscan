import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import { LUT_SIZE, ParticleTypeTable } from './ParticleTypes.ts';
import { PARTICLE_FRAGMENT, PARTICLE_VERTEX } from './ParticleShaders.ts';

/** Floats per instance in the interleaved GPU buffer. */
const STRIDE = 20;

/** Quantisation range for the back-to-front sort key, in metres. */
const SORT_RANGE = 240;

/**
 * A sine table indexed by radians. The drift field needs a smooth periodic
 * function evaluated three times per particle per step; `Math.sin` at that
 * rate costs more than the rest of the integrator combined.
 */
const SIN_BITS = 1024;
const SIN_MASK = SIN_BITS - 1;
const SIN_SCALE = SIN_BITS / (Math.PI * 2);
const SIN_TABLE = new Float32Array(SIN_BITS);
for (let i = 0; i < SIN_BITS; i++) SIN_TABLE[i] = Math.sin((i / SIN_BITS) * Math.PI * 2);

function fastSin(x: number): number {
  return SIN_TABLE[((x * SIN_SCALE + 1e7) | 0) & SIN_MASK]!;
}

/** Parameters for a burst. Reused by callers to keep emission allocation-free. */
export class EmitDesc {
  type = 0;
  count = 1;
  readonly position = new THREE.Vector3();
  /** Cone axis for the emitted velocities. */
  readonly direction = new THREE.Vector3(0, 1, 0);
  /**
   * Orientation axis for `Axial` and `Planar` billboards. Ignored unless
   * `explicitAxis` is set, in which case velocity direction is used instead.
   */
  readonly axis = new THREE.Vector3(0, 1, 0);
  explicitAxis = false;
  /** Cone half-angle in radians. At or above PI the emission is spherical. */
  spread = 0.4;
  speed = 1;
  /** Fractional speed variance, in [0,1]. */
  speedSpread = 0.4;
  /** Spawn jitter radius in metres. */
  radius = 0;
  sizeScale = 1;
  lifeScale = 1;
  colorScale = 1;
  opacityScale = 1;
  /** Velocity added to every particle, e.g. the shooter's own motion. */
  readonly inherit = new THREE.Vector3();
  /** Spread spawns over this many seconds of pre-simulation. */
  prewarm = 0;
  /** Ground height used by bouncing types. */
  groundY = 0;

  reset(type: number, count: number): this {
    this.type = type;
    this.count = count;
    this.position.set(0, 0, 0);
    this.direction.set(0, 1, 0);
    this.axis.set(0, 1, 0);
    this.explicitAxis = false;
    this.spread = 0.4;
    this.speed = 1;
    this.speedSpread = 0.4;
    this.radius = 0;
    this.sizeScale = 1;
    this.lifeScale = 1;
    this.colorScale = 1;
    this.opacityScale = 1;
    this.inherit.set(0, 0, 0);
    this.prewarm = 0;
    this.groundY = 0;
    return this;
  }
}

const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const _disc = { x: 0, y: 0 };
const _sphere = { x: 0, y: 0, z: 0 };

/**
 * One blend mode's worth of particles: pool, integrator and draw call.
 *
 * Simulation runs on the CPU over structure-of-arrays typed buffers rather
 * than on the GPU. WebGL2 in three.js has no transform feedback, so a GPU
 * solver means ping-ponging float render targets, which costs a pass per
 * frame, makes spawning a render-to-texture operation, and rules out the
 * depth sort that alpha-blended smoke needs. At the budget this game runs
 * (12k particles at high) the CPU integrator is roughly 0.25ms and buys
 * exact determinism, per-particle collision and correct sorting.
 */
export class ParticleBatch {
  readonly capacity: number;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  #types: ParticleTypeTable;
  #rng: Rng;

  #px: Float32Array;
  #py: Float32Array;
  #pz: Float32Array;
  #vx: Float32Array;
  #vy: Float32Array;
  #vz: Float32Array;
  #ax: Float32Array;
  #ay: Float32Array;
  #az: Float32Array;
  #age: Float32Array;
  #life: Float32Array;
  #rot: Float32Array;
  #rotVel: Float32Array;
  #sizeW: Float32Array;
  #sizeH: Float32Array;
  #cr: Float32Array;
  #cg: Float32Array;
  #cb: Float32Array;
  #opacity: Float32Array;
  #seed: Float32Array;
  #groundY: Float32Array;
  #type: Uint16Array;

  #free: Int32Array;
  #freeCount: number;
  #live: Int32Array;
  #liveCount = 0;
  #recycleCursor = 0;

  #keys: Uint32Array;
  #keyScratch: Uint32Array;
  #radixCounts = new Uint32Array(256);

  #gpu: Float32Array;
  #interleaved: THREE.InstancedInterleavedBuffer;
  #geometry: THREE.InstancedBufferGeometry;

  #dragFactor: Float32Array;
  #sorted: boolean;

  constructor(options: {
    capacity: number;
    types: ParticleTypeTable;
    rng: Rng;
    sprites: THREE.DataArrayTexture;
    uniforms: Record<string, THREE.IUniform>;
    additive: boolean;
    name: string;
    renderOrder: number;
  }) {
    // The sort key packs the pool index into 16 bits.
    this.capacity = Math.max(16, Math.min(65535, options.capacity | 0));
    this.#types = options.types;
    this.#rng = options.rng;
    this.#sorted = !options.additive;

    const n = this.capacity;
    this.#px = new Float32Array(n);
    this.#py = new Float32Array(n);
    this.#pz = new Float32Array(n);
    this.#vx = new Float32Array(n);
    this.#vy = new Float32Array(n);
    this.#vz = new Float32Array(n);
    this.#ax = new Float32Array(n);
    this.#ay = new Float32Array(n);
    this.#az = new Float32Array(n);
    this.#age = new Float32Array(n);
    this.#life = new Float32Array(n);
    this.#rot = new Float32Array(n);
    this.#rotVel = new Float32Array(n);
    this.#sizeW = new Float32Array(n);
    this.#sizeH = new Float32Array(n);
    this.#cr = new Float32Array(n);
    this.#cg = new Float32Array(n);
    this.#cb = new Float32Array(n);
    this.#opacity = new Float32Array(n);
    this.#seed = new Float32Array(n);
    this.#groundY = new Float32Array(n);
    this.#type = new Uint16Array(n);

    this.#free = new Int32Array(n);
    for (let i = 0; i < n; i++) this.#free[i] = n - 1 - i;
    this.#freeCount = n;
    this.#live = new Int32Array(n);
    this.#keys = new Uint32Array(n);
    this.#keyScratch = new Uint32Array(n);
    this.#dragFactor = new Float32Array(options.types.count);

    this.#gpu = new Float32Array(n * STRIDE);
    this.#interleaved = new THREE.InstancedInterleavedBuffer(this.#gpu, STRIDE, 1);
    this.#interleaved.setUsage(THREE.DynamicDrawUsage);

    const source = new THREE.PlaneGeometry(2, 2, 1, 1);
    this.#geometry = new THREE.InstancedBufferGeometry();
    this.#geometry.setIndex(source.getIndex());
    this.#geometry.setAttribute('position', source.getAttribute('position'));
    this.#geometry.setAttribute('uv', source.getAttribute('uv'));
    source.dispose();

    const buffer = this.#interleaved;
    this.#geometry.setAttribute('iPosRot', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
    this.#geometry.setAttribute('iSize', new THREE.InterleavedBufferAttribute(buffer, 4, 4));
    this.#geometry.setAttribute('iColor', new THREE.InterleavedBufferAttribute(buffer, 4, 8));
    this.#geometry.setAttribute('iAxis', new THREE.InterleavedBufferAttribute(buffer, 4, 12));
    this.#geometry.setAttribute('iShade', new THREE.InterleavedBufferAttribute(buffer, 4, 16));
    this.#geometry.instanceCount = 0;
    this.#geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: options.uniforms,
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.material.name = options.name;
    // The sprite array lives on the shared uniform block, but three needs it
    // referenced from a material to bind the sampler.
    this.material.uniforms.uSprites!.value = options.sprites;

    this.mesh = new THREE.Mesh(this.#geometry, this.material);
    this.mesh.name = options.name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = options.renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Decal placement raycasts the scene; VFX geometry must be invisible to it.
    this.mesh.raycast = (): void => {};
  }

  get liveCount(): number {
    return this.#liveCount;
  }

  /** Spawns `desc.count` particles, recycling the pool when it is full. */
  emit(desc: EmitDesc): void {
    const t = this.#types;
    const ty = desc.type;
    const rng = this.#rng;

    // Orthonormal basis for the emission cone, built once per burst.
    const dir = desc.direction;
    const spherical = desc.spread >= Math.PI - 1e-3;
    if (!spherical) {
      if (Math.abs(dir.y) < 0.97) _tangent.set(0, 1, 0);
      else _tangent.set(1, 0, 0);
      _bitangent.crossVectors(dir, _tangent).normalize();
      _tangent.crossVectors(_bitangent, dir).normalize();
    }

    const bounce = t.bounce[ty]!;

    for (let k = 0; k < desc.count; k++) {
      const i = this.#allocate();
      if (i < 0) return;

      let dx: number;
      let dy: number;
      let dz: number;
      if (spherical) {
        rng.onSphere(_sphere);
        dx = _sphere.x;
        dy = _sphere.y;
        dz = _sphere.z;
      } else {
        rng.inDisc(_disc);
        const radial = Math.sqrt(_disc.x * _disc.x + _disc.y * _disc.y);
        const angle = desc.spread * radial;
        const sa = Math.sin(angle);
        const ca = Math.cos(angle);
        const nx = radial > 1e-5 ? _disc.x / radial : 1;
        const ny = radial > 1e-5 ? _disc.y / radial : 0;
        dx = dir.x * ca + (_tangent.x * nx + _bitangent.x * ny) * sa;
        dy = dir.y * ca + (_tangent.y * nx + _bitangent.y * ny) * sa;
        dz = dir.z * ca + (_tangent.z * nx + _bitangent.z * ny) * sa;
      }

      const speed = desc.speed * (1 + rng.range(-desc.speedSpread, desc.speedSpread));
      let vx = dx * speed + desc.inherit.x;
      let vy = dy * speed + desc.inherit.y;
      let vz = dz * speed + desc.inherit.z;

      let px = desc.position.x;
      let py = desc.position.y;
      let pz = desc.position.z;
      if (desc.radius > 0) {
        rng.onSphere(_sphere);
        const r = desc.radius * Math.cbrt(rng.next());
        px += _sphere.x * r;
        py += _sphere.y * r;
        pz += _sphere.z * r;
      }

      const life = (t.lifeMin[ty]! + rng.next() * t.lifeSpan[ty]!) * desc.lifeScale;
      let age = 0;
      if (desc.prewarm > 0) {
        // Pre-advancing spreads a burst over sub-frame time so it does not
        // appear as a shell of particles all at the same radius.
        age = rng.range(0, Math.min(desc.prewarm, life * 0.9));
        px += vx * age;
        py += vy * age;
        pz += vz * age;
      }

      const size = (t.sizeMin[ty]! + rng.next() * t.sizeSpan[ty]!) * desc.sizeScale;
      const intensity = t.intensityMin[ty]! + rng.next() * t.intensitySpan[ty]!;
      const tint = intensity * desc.colorScale;

      this.#px[i] = px;
      this.#py[i] = py;
      this.#pz[i] = pz;
      this.#vx[i] = vx;
      this.#vy[i] = vy;
      this.#vz[i] = vz;
      this.#age[i] = age;
      this.#life[i] = life;
      this.#rot[i] = rng.range(0, Math.PI * 2);
      this.#rotVel[i] = t.spinMin[ty]! + rng.next() * t.spinSpan[ty]!;
      this.#sizeW[i] = size;
      this.#sizeH[i] = size * t.aspect[ty]!;
      this.#cr[i] = (t.colorR[ty]! + rng.range(-t.varR[ty]!, t.varR[ty]!)) * tint;
      this.#cg[i] = (t.colorG[ty]! + rng.range(-t.varG[ty]!, t.varG[ty]!)) * tint;
      this.#cb[i] = (t.colorB[ty]! + rng.range(-t.varB[ty]!, t.varB[ty]!)) * tint;
      this.#opacity[i] = t.opacity[ty]! * desc.opacityScale;
      this.#seed[i] = rng.range(0, 100);
      this.#groundY[i] = bounce > 0 ? desc.groundY : -Infinity;
      this.#type[i] = ty;

      if (desc.explicitAxis) {
        this.#ax[i] = desc.axis.x;
        this.#ay[i] = desc.axis.y;
        this.#az[i] = desc.axis.z;
      } else {
        const len = Math.hypot(vx, vy, vz) || 1;
        this.#ax[i] = vx / len;
        this.#ay[i] = vy / len;
        this.#az[i] = vz / len;
      }

      this.#live[this.#liveCount++] = i;
    }
  }

  /** Integrates one step. Called from `fixedUpdate` so motion is deterministic. */
  simulate(dt: number): void {
    const t = this.#types;
    for (let ty = 0; ty < t.count; ty++) {
      this.#dragFactor[ty] = Math.exp(-t.drag[ty]! * dt);
    }

    const px = this.#px;
    const py = this.#py;
    const pz = this.#pz;
    const vx = this.#vx;
    const vy = this.#vy;
    const vz = this.#vz;
    const age = this.#age;
    const life = this.#life;
    const rot = this.#rot;
    const rotVel = this.#rotVel;
    const type = this.#type;
    const live = this.#live;
    const seed = this.#seed;
    const drag = this.#dragFactor;

    let n = this.#liveCount;
    let li = 0;
    while (li < n) {
      const i = live[li]!;
      const a = age[i]! + dt;
      if (a >= life[i]!) {
        this.#release(i);
        live[li] = live[--n]!;
        continue;
      }
      age[i] = a;

      const ty = type[i]!;
      const norm = a / life[i]!;

      let ivx = vx[i]!;
      let ivy = vy[i]!;
      let ivz = vz[i]!;

      const turbulence = t.turbulence[ty]!;
      if (turbulence > 0) {
        // A cheap curl-like field: each axis is driven by the other two, so
        // the drift swirls instead of pushing every particle the same way.
        const s = seed[i]!;
        const x = px[i]!;
        const y = py[i]!;
        const z = pz[i]!;
        const scale = turbulence * dt;
        ivx += (fastSin(y * 1.7 + s) + fastSin(z * 2.3 - s * 0.7)) * scale * 0.5;
        ivy += (fastSin(z * 1.9 + s * 1.3) + fastSin(x * 2.1 + s)) * scale * 0.5;
        ivz += (fastSin(x * 1.5 - s) + fastSin(y * 2.7 + s * 0.4)) * scale * 0.5;
      }

      ivy += t.gravity[ty]! * dt;
      const buoyancy = t.buoyancy[ty]!;
      if (buoyancy > 0) ivy += buoyancy * (1 - norm) * dt;

      const d = drag[ty]!;
      ivx *= d;
      ivy *= d;
      ivz *= d;

      let x = px[i]! + ivx * dt;
      let y = py[i]! + ivy * dt;
      let z = pz[i]! + ivz * dt;

      const ground = this.#groundY[i]!;
      if (y < ground && ivy < 0) {
        const restitution = t.bounce[ty]!;
        y = ground + (ground - y) * restitution;
        ivy = -ivy * restitution;
        ivx *= 0.62;
        ivz *= 0.62;
        rotVel[i] = rotVel[i]! * 0.5;
      }

      px[i] = x;
      py[i] = y;
      pz[i] = z;
      vx[i] = ivx;
      vy[i] = ivy;
      vz[i] = ivz;
      rot[i] = rot[i]! + rotVel[i]! * dt;

      if (t.stretch[ty]! > 0) {
        const len = Math.hypot(ivx, ivy, ivz);
        if (len > 1e-3) {
          this.#ax[i] = ivx / len;
          this.#ay[i] = ivy / len;
          this.#az[i] = ivz / len;
        }
      }

      li++;
    }
    this.#liveCount = n;
  }

  /** Packs the live set into the instance buffer, depth-sorted when needed. */
  write(cameraX: number, cameraY: number, cameraZ: number): void {
    const n = this.#liveCount;
    this.#geometry.instanceCount = n;
    if (n === 0) return;

    const live = this.#live;
    const keys = this.#keys;

    if (this.#sorted) {
      for (let li = 0; li < n; li++) {
        const i = live[li]!;
        const dx = this.#px[i]! - cameraX;
        const dy = this.#py[i]! - cameraY;
        const dz = this.#pz[i]! - cameraZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // Descending distance so the farthest particle is drawn first.
        const q = 65535 - Math.min(65535, ((dist / SORT_RANGE) * 65535) | 0);
        keys[li] = (q << 16) | i;
      }
      this.#radixSort(n);
    } else {
      for (let li = 0; li < n; li++) keys[li] = live[li]!;
    }

    const t = this.#types;
    const gpu = this.#gpu;
    const sizeLut = t.sizeLut;
    const alphaLut = t.alphaLut;
    const colorLut = t.colorLut;
    const last = LUT_SIZE - 1;

    for (let li = 0; li < n; li++) {
      const i = this.#sorted ? keys[li]! & 0xffff : keys[li]!;
      const ty = this.#type[i]!;
      const norm = this.#age[i]! / this.#life[i]!;

      const f = norm * last;
      let i0 = f | 0;
      if (i0 > last) i0 = last;
      const i1 = i0 < last ? i0 + 1 : last;
      const frac = f - i0;

      const lutBase = ty * LUT_SIZE;
      const s0 = sizeLut[lutBase + i0]!;
      const sizeMul = s0 + (sizeLut[lutBase + i1]! - s0) * frac;
      const a0 = alphaLut[lutBase + i0]!;
      const alphaMul = a0 + (alphaLut[lutBase + i1]! - a0) * frac;

      const cBase = ty * LUT_SIZE * 3;
      const c0 = cBase + i0 * 3;
      const c1 = cBase + i1 * 3;
      const mr = colorLut[c0]! + (colorLut[c1]! - colorLut[c0]!) * frac;
      const mg = colorLut[c0 + 1]! + (colorLut[c1 + 1]! - colorLut[c0 + 1]!) * frac;
      const mb = colorLut[c0 + 2]! + (colorLut[c1 + 2]! - colorLut[c0 + 2]!) * frac;

      const o = li * STRIDE;
      gpu[o] = this.#px[i]!;
      gpu[o + 1] = this.#py[i]!;
      gpu[o + 2] = this.#pz[i]!;
      gpu[o + 3] = this.#rot[i]!;

      gpu[o + 4] = this.#sizeW[i]! * sizeMul;
      gpu[o + 5] = this.#sizeH[i]! * sizeMul;
      gpu[o + 6] = t.sprite[ty]!;
      gpu[o + 7] = t.billboard[ty]!;

      gpu[o + 8] = this.#cr[i]! * mr;
      gpu[o + 9] = this.#cg[i]! * mg;
      gpu[o + 10] = this.#cb[i]! * mb;
      gpu[o + 11] = this.#opacity[i]! * alphaMul;

      gpu[o + 12] = this.#ax[i]!;
      gpu[o + 13] = this.#ay[i]!;
      gpu[o + 14] = this.#az[i]!;
      const stretch = t.stretch[ty]!;
      gpu[o + 15] =
        stretch > 0
          ? stretch * Math.hypot(this.#vx[i]!, this.#vy[i]!, this.#vz[i]!)
          : 0;

      gpu[o + 16] = t.lightMix[ty]!;
      gpu[o + 17] = t.softness[ty]!;
      gpu[o + 18] = 0;
      gpu[o + 19] = 0;
    }

    this.#interleaved.clearUpdateRanges();
    this.#interleaved.addUpdateRange(0, n * STRIDE);
    this.#interleaved.needsUpdate = true;
  }

  clear(): void {
    for (let li = 0; li < this.#liveCount; li++) this.#release(this.#live[li]!);
    this.#liveCount = 0;
    this.#geometry.instanceCount = 0;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.material.dispose();
  }

  #allocate(): number {
    if (this.#freeCount > 0) return this.#free[--this.#freeCount]!;
    if (this.#liveCount === 0) return -1;
    // Pool exhausted: retire a live particle rather than dropping the burst,
    // so a sustained firefight degrades in density instead of stuttering.
    const slot = this.#recycleCursor % this.#liveCount;
    this.#recycleCursor = (this.#recycleCursor + 7) % Math.max(1, this.#liveCount);
    const index = this.#live[slot]!;
    this.#live[slot] = this.#live[--this.#liveCount]!;
    return index;
  }

  #release(index: number): void {
    this.#free[this.#freeCount++] = index;
  }

  /**
   * Two-pass radix sort over the 16-bit depth key. A comparison sort would
   * allocate a comparator closure and cost 4x as much at this element count.
   */
  #radixSort(n: number): void {
    const keys = this.#keys;
    const scratch = this.#keyScratch;
    const counts = this.#radixCounts;

    for (let shift = 16; shift <= 24; shift += 8) {
      counts.fill(0);
      for (let i = 0; i < n; i++) counts[(keys[i]! >>> shift) & 0xff]!++;
      let total = 0;
      for (let b = 0; b < 256; b++) {
        const c = counts[b]!;
        counts[b] = total;
        total += c;
      }
      for (let i = 0; i < n; i++) {
        const key = keys[i]!;
        scratch[counts[(key >>> shift) & 0xff]!++] = key;
      }
      for (let i = 0; i < n; i++) keys[i] = scratch[i]!;
    }
  }
}
