/**
 * Deterministic random number generation.
 *
 * Captures must be reproducible frame-for-frame, so nothing in the game may
 * call `Math.random()`. Every stochastic system draws from an `Rng` instead.
 */

export interface Rng {
  /** Uniform in [0,1). */
  next(): number;
  /** Uniform in [min,max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min,max]. */
  int(min: number, max: number): number;
  /** Standard normal, via Box-Muller. */
  gaussian(mean?: number, stddev?: number): number;
  /** Uniform point on the unit sphere. */
  onSphere(out: { x: number; y: number; z: number }): void;
  /** Uniform point in the unit disc. Used for cone-of-fire spread. */
  inDisc(out: { x: number; y: number }): void;
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
  /**
   * Derives an independent stream from this one. Lets a subsystem consume
   * random numbers without perturbing the sequence seen by others.
   */
  fork(label: string): Rng;
  readonly seed: number;
}
