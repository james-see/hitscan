import * as THREE from 'three';

/**
 * Procedural micro-detail maps.
 *
 * The shipped CC0 albedos carry almost no high-frequency content — the plaster
 * one is a 37 kB near-flat beige field — so tiling them harder cannot raise
 * texel density, it only makes the repeat visible. Instead the big surfaces get
 * a second, world-space detail layer generated here and blended in by
 * `Surfaces.ts` at a scale of its own, which decouples surface detail from the
 * source texture's repeat entirely.
 *
 * Both maps are tileable: the value-noise lattices wrap on their own period, so
 * a fragment can sample them at any world scale without a seam.
 */

/** Detail atlas resolution. 512 over a 3 m repeat is about 6 mm per texel. */
const DETAIL_SIZE = 512;
const WEAVE_SIZE = 256;

/**
 * Channel layout of the detail atlas, shared with the shader in `Surfaces.ts`.
 *
 *   r, g  tangent-space normal xy of the grain height field, biased to [0,1]
 *   b     the grain height itself, doubling as the cavity mask
 *   a     low-frequency stain field, used for patchiness and water streaks
 */
interface Octave {
  /** Lattice cells across the tile. Also the wrap period. */
  cells: number;
  amp: number;
  seed: number;
}

/**
 * Concrete and render: coarse aggregate, a mid pit structure, fine tooth.
 *
 * The spectrum is deliberately flat rather than the usual halving per octave.
 * A 1/f falloff puts most of the energy in the lowest octave, which at these
 * world scales is a half-metre blob — that reads as damp marble, not concrete,
 * and it is the opposite of the fine tooth the surface is short of.
 */
const GRAIN_OCTAVES: Octave[] = [
  { cells: 6, amp: 0.22, seed: 11 },
  { cells: 13, amp: 0.26, seed: 27 },
  { cells: 29, amp: 0.24, seed: 53 },
  { cells: 61, amp: 0.18, seed: 97 },
  { cells: 131, amp: 0.12, seed: 193 },
];

/** Broad tonal drift: patch repairs, damp, old paint. */
const STAIN_OCTAVES: Octave[] = [
  { cells: 3, amp: 0.4, seed: 7 },
  { cells: 7, amp: 0.3, seed: 31 },
  { cells: 15, amp: 0.2, seed: 71 },
  { cells: 31, amp: 0.12, seed: 149 },
];

/** Crack network. Ridged, so the field peaks along lines rather than blobs. */
const CRACK_OCTAVES: Octave[] = [
  { cells: 4, amp: 0.7, seed: 313 },
  { cells: 9, amp: 0.22, seed: 419 },
  { cells: 19, amp: 0.08, seed: 577 },
];

/**
 * Where cracking is allowed at all.
 *
 * Without this the ridge network covers the whole tile evenly and the wall
 * reads as crazed marble. Real cracking is local — it follows a settlement or
 * a damp patch — so the network is gated to roughly a third of the surface.
 */
const CRACK_MASK_OCTAVES: Octave[] = [
  { cells: 2, amp: 0.62, seed: 1201 },
  { cells: 5, amp: 0.38, seed: 1367 },
];

let detailTexture: THREE.DataTexture | null = null;
let weaveTexture: THREE.DataTexture | null = null;

/**
 * The shared concrete/plaster detail atlas.
 *
 * Generated once and cached: every surface material samples the same texture at
 * a different world scale, which costs one sampler for the whole level.
 */
export function surfaceDetailTexture(): THREE.DataTexture {
  if (detailTexture) return detailTexture;

  const size = DETAIL_SIZE;
  const grain = fbmField(size, GRAIN_OCTAVES);
  const stain = fbmField(size, STAIN_OCTAVES);
  const crackNoise = fbmField(size, CRACK_OCTAVES);
  const crackMask = fbmField(size, CRACK_MASK_OCTAVES);

  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    // Ridged transform: the crest of the noise becomes a thin line, and the
    // power sharpens it from a valley into a crack.
    const ridge = 1 - Math.abs(crackNoise[i] * 2 - 1);
    const mask = smoothstep(0.52, 0.78, crackMask[i]);
    const crack = Math.pow(ridge, 10) * 0.7 * mask;
    height[i] = clamp01(0.5 + (grain[i] - 0.5) * 1.5 - crack);
  }

  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Central difference on the wrapped height field. The gain is chosen so a
      // typical slope lands near 45 degrees before the shader's own strength
      // term scales it back.
      const dx = height[y * size + wrap(x + 1, size)] - height[y * size + wrap(x - 1, size)];
      const dy = height[wrap(y + 1, size) * size + x] - height[wrap(y - 1, size) * size + x];
      const nx = -dx * 2.0;
      const ny = -dy * 2.0;
      const inverseLength = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = i * 4;
      data[o] = encode(nx * inverseLength);
      data[o + 1] = encode(ny * inverseLength);
      data[o + 2] = Math.round(height[i] * 255);
      data[o + 3] = Math.round(clamp01(stain[i]) * 255);
    }
  }

  detailTexture = makeTexture(data, size);
  detailTexture.name = 'world.detail';
  return detailTexture;
}

/**
 * Woven hessian, for the sandbags.
 *
 * A plain weave is two interleaved thread families with the over-under
 * alternating per cell; without that alternation the pattern reads as a
 * printed grid rather than cloth.
 */
export function weaveDetailTexture(): THREE.DataTexture {
  if (weaveTexture) return weaveTexture;

  const size = WEAVE_SIZE;
  const threads = 14;
  const fibre = fbmField(size, [
    { cells: 23, amp: 0.5, seed: 601 },
    { cells: 47, amp: 0.3, seed: 733 },
    { cells: 97, amp: 0.2, seed: 811 },
  ]);
  const slack = fbmField(size, [
    { cells: 3, amp: 0.7, seed: 907 },
    { cells: 7, amp: 0.3, seed: 1013 },
  ]);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * threads;
      const v = (y / size) * threads;
      const cellU = Math.floor(u);
      const cellV = Math.floor(v);
      // Rounded thread cross-section, flattened at the crossing where the
      // other family passes over it.
      const warp = Math.cos((u - cellU - 0.5) * Math.PI);
      const weft = Math.cos((v - cellV - 0.5) * Math.PI);
      const warpOver = (cellU + cellV) % 2 === 0;
      const top = warpOver ? Math.max(warp, weft * 0.5) : Math.max(weft, warp * 0.5);
      // Slack varies the weave depth so the cloth sags rather than reading as
      // a machined grid, and the fibre field frays the thread edges.
      height[i] = clamp01(top * (0.72 + slack[i] * 0.5) + (fibre[i] - 0.5) * 0.3);
    }
  }

  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = height[y * size + wrap(x + 1, size)] - height[y * size + wrap(x - 1, size)];
      const dy = height[wrap(y + 1, size) * size + x] - height[wrap(y - 1, size) * size + x];
      const nx = -dx * 5.5;
      const ny = -dy * 5.5;
      const inverseLength = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = i * 4;
      data[o] = encode(nx * inverseLength);
      data[o + 1] = encode(ny * inverseLength);
      data[o + 2] = Math.round(height[i] * 255);
      data[o + 3] = Math.round(clamp01(fibre[i]) * 255);
    }
  }

  weaveTexture = makeTexture(data, size);
  weaveTexture.name = 'world.weave';
  return weaveTexture;
}

export function disposeDetailTextures(): void {
  detailTexture?.dispose();
  weaveTexture?.dispose();
  detailTexture = null;
  weaveTexture = null;
}

function makeTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // Deliberately at the high end. The worst case for a world-projected detail
  // map is the platform deck, which the elevated shot sees almost edge-on for
  // its whole depth; at eight taps the fine grain there is mipped to nothing.
  texture.anisotropy = 16;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Sums periodic gradient-noise octaves over the whole image.
 *
 * Gradient noise rather than value noise, and each octave's coordinates warped
 * by the one below it: interpolated value noise on an axis-aligned lattice
 * leaves a faint regular grid, and at ten metres that grid resolved into a
 * visible dot pattern across every wall — exactly the periodicity this layer
 * exists to avoid. Warping also costs nothing in tileability, because the warp
 * field wraps on the same period as the lattice it displaces.
 *
 * Run octave-by-octave with the lattice precomputed rather than hashing inside
 * the pixel loop, which is what keeps a 512-square field under ten
 * milliseconds.
 */
function fbmField(size: number, octaves: Octave[]): Float32Array {
  const out = new Float32Array(size * size);
  const warp = new Float32Array(size * size * 2);
  let total = 0;
  for (const octave of octaves) total += octave.amp;

  for (let index = 0; index < octaves.length; index++) {
    const octave = octaves[index];
    const { cells, seed } = octave;
    const grid = lattice(cells, seed);
    const weight = octave.amp / total;
    const step = cells / size;
    // Each octave is displaced by the accumulated result of the coarser ones,
    // in units of its own cells, which is what breaks the lattice alignment.
    // Kept to a twentieth of the tile. Warping by a fixed fraction of the
    // octave's own cell size instead scales the swirl with frequency, and the
    // result stops reading as grain and starts reading as figured wood.
    const warpScale = index === 0 ? 0 : cells * 0.05;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const gx = x * step + warp[i * 2] * warpScale;
        const gy = y * step + warp[i * 2 + 1] * warpScale;
        const value = gradientNoise(grid, cells, gx, gy);
        out[i] += value * weight;
        if (index === 0) {
          warp[i * 2] = value - 0.5;
          warp[i * 2 + 1] = gradientNoise(grid, cells, gy + 31.7, gx - 17.3) - 0.5;
        }
      }
    }
  }
  return out;
}

/** Periodic Perlin sample in [0,1). `grid` holds one unit gradient per cell. */
function gradientNoise(grid: Float32Array, cells: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const x0 = (((ix % cells) + cells) % cells) * 2;
  const x1 = ((((ix + 1) % cells) + cells) % cells) * 2;
  const y0 = (((iy % cells) + cells) % cells) * cells * 2;
  const y1 = ((((iy + 1) % cells) + cells) % cells) * cells * 2;

  const d00 = grid[y0 + x0] * fx + grid[y0 + x0 + 1] * fy;
  const d10 = grid[y0 + x1] * (fx - 1) + grid[y0 + x1 + 1] * fy;
  const d01 = grid[y1 + x0] * fx + grid[y1 + x0 + 1] * (fy - 1);
  const d11 = grid[y1 + x1] * (fx - 1) + grid[y1 + x1 + 1] * (fy - 1);

  const u = fade(fx);
  const v = fade(fy);
  const top = d00 + (d10 - d00) * u;
  const bottom = d01 + (d11 - d01) * u;
  // Perlin's range is roughly +/-0.707; the scale lands it inside [0,1].
  return (top + (bottom - top) * v) * 0.7 + 0.5;
}

/** One unit gradient per lattice cell, stored interleaved. */
function lattice(cells: number, seed: number): Float32Array {
  const grid = new Float32Array(cells * cells * 2);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
      h = (h ^ (h >>> 13)) | 0;
      h = Math.imul(h, 1274126177) | 0;
      h = (h ^ (h >>> 16)) | 0;
      h = Math.imul(h, 668265263) | 0;
      h = (h ^ (h >>> 15)) | 0;
      const angle = ((h >>> 0) / 4294967296) * Math.PI * 2;
      const o = (y * cells + x) * 2;
      grid[o] = Math.cos(angle);
      grid[o + 1] = Math.sin(angle);
    }
  }
  return grid;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function wrap(i: number, size: number): number {
  return ((i % size) + size) % size;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function encode(v: number): number {
  return Math.round(clamp01(v * 0.5 + 0.5) * 255);
}
