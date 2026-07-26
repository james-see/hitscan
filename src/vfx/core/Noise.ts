import type { Rng } from '@/types/rng.ts';

const TABLE = 256;
const MASK = TABLE - 1;

/**
 * Gradient noise used to bake particle and decal textures at load time.
 *
 * Seeded from the VFX RNG fork so generated textures are byte-identical
 * between runs, which is a prerequisite for reproducible captures.
 */
export class GradientNoise2D {
  readonly #perm = new Uint8Array(TABLE * 2);
  readonly #gx = new Float32Array(TABLE);
  readonly #gy = new Float32Array(TABLE);

  constructor(rng: Rng) {
    const p = new Uint8Array(TABLE);
    for (let i = 0; i < TABLE; i++) p[i] = i;
    for (let i = TABLE - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < TABLE * 2; i++) this.#perm[i] = p[i & MASK]!;
    for (let i = 0; i < TABLE; i++) {
      const a = rng.range(0, Math.PI * 2);
      this.#gx[i] = Math.cos(a);
      this.#gy[i] = Math.sin(a);
    }
  }

  /** Perlin-style gradient noise, roughly in [-1,1]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & MASK;
    const Y = yi & MASK;

    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    const perm = this.#perm;
    const aa = perm[X + perm[Y]!]!;
    const ba = perm[X + 1 + perm[Y]!]!;
    const ab = perm[X + perm[Y + 1]!]!;
    const bb = perm[X + 1 + perm[Y + 1]!]!;

    const gx = this.#gx;
    const gy = this.#gy;
    const n00 = gx[aa]! * xf + gy[aa]! * yf;
    const n10 = gx[ba]! * (xf - 1) + gy[ba]! * yf;
    const n01 = gx[ab]! * xf + gy[ab]! * (yf - 1);
    const n11 = gx[bb]! * (xf - 1) + gy[bb]! * (yf - 1);

    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4;
  }

  /** Fractal sum in [0,1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(fx, fy) * amp;
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return norm > 0 ? sum / norm * 0.5 + 0.5 : 0.5;
  }

  /**
   * Ridged fractal sum in [0,1]. The absolute value creates sharp creases,
   * which is what makes it read as cracks rather than clouds.
   */
  ridged(x: number, y: number, octaves: number, lacunarity = 2.11, gain = 0.55): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(fx, fy));
      sum += n * n * amp;
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}
