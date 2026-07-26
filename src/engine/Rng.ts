import type { Rng } from '@/types/rng.ts';

/**
 * sfc32 — small, fast, and statistically sound enough for gameplay. Chosen
 * over an LCG because bullet spread and particle jitter are visible when the
 * low bits are weak.
 */
export class SeededRng implements Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;
  readonly seed: number;
  /** Cached second value from the Box-Muller pair. */
  #spare: number | null = null;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    // Scramble the seed into four words so low-entropy seeds still diverge.
    let h = this.seed + 0x9e3779b9;
    const mix = (): number => {
      h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
      h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
      return (h ^= h >>> 15) >>> 0;
    };
    this.#a = mix();
    this.#b = mix();
    this.#c = mix();
    this.#d = mix();
    // Discard the first few outputs so the state is well mixed.
    for (let i = 0; i < 12; i++) this.next();
  }

  next(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  gaussian(mean = 0, stddev = 1): number {
    if (this.#spare !== null) {
      const v = this.#spare;
      this.#spare = null;
      return mean + stddev * v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const scale = Math.sqrt((-2 * Math.log(s)) / s);
    this.#spare = v * scale;
    return mean + stddev * u * scale;
  }

  onSphere(out: { x: number; y: number; z: number }): void {
    // Marsaglia's method: uniform on the sphere without trig rejection bias.
    const z = this.next() * 2 - 1;
    const theta = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.x = r * Math.cos(theta);
    out.y = r * Math.sin(theta);
    out.z = z;
  }

  inDisc(out: { x: number; y: number }): void {
    // sqrt keeps the distribution area-uniform rather than centre-heavy.
    const r = Math.sqrt(this.next());
    const theta = this.next() * Math.PI * 2;
    out.x = r * Math.cos(theta);
    out.y = r * Math.sin(theta);
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  fork(label: string): Rng {
    let h = this.seed >>> 0;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    }
    return new SeededRng(h);
  }
}
