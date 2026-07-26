import { Sprite } from './Textures.ts';

/**
 * Particle type registry.
 *
 * Types are authored as readable specs and flattened into parallel typed
 * arrays at boot. The simulation loop only ever touches the flat arrays, so
 * a frame's worth of particle work stays in a handful of cache lines instead
 * of chasing object pointers.
 */

/** Piecewise-linear control points, `[t, value]`, t ascending over [0,1]. */
export type Curve = readonly (readonly [number, number])[];
/** Colour multiplier control points, `[t, r, g, b]`. */
export type ColorRamp = readonly (readonly [number, number, number, number])[];

export const Billboard = {
  /** Camera-facing quad with a per-particle roll. */
  Spherical: 0,
  /** Quad's long axis follows `axis`, rolled to face the camera. */
  Axial: 1,
  /** Quad lies in the plane perpendicular to `axis`, e.g. flat on a surface. */
  Planar: 2,
} as const;

export type BatchKind = 'alpha' | 'additive';

export interface ParticleTypeSpec {
  id: string;
  batch: BatchKind;
  sprite: number;
  billboard: 0 | 1 | 2;
  /** Lifetime range in seconds. */
  life: [number, number];
  /** Base half-width range in metres. */
  size: [number, number];
  /** Height/width ratio of the quad. */
  aspect?: number;
  /** Exponential velocity damping, per second. */
  drag: number;
  /** Constant vertical acceleration in m/s^2. Negative falls. */
  gravity: number;
  /** Upward acceleration that decays over the particle's life. */
  buoyancy?: number;
  /** Roll rate range in rad/s. */
  spin?: [number, number];
  /** Amplitude of the divergence-free drift field, in m/s^2. */
  turbulence?: number;
  color: [number, number, number];
  /** Per-particle random offset added to the base colour. */
  colorVariance?: [number, number, number];
  /** HDR multiplier range applied to the colour. */
  intensity?: [number, number];
  opacity?: number;
  /** 0 = purely emissive, 1 = fully lit by the sun and sky. */
  lightMix?: number;
  /** Depth-fade distance in metres for the soft-particle test. */
  softness?: number;
  /** Extra quad length per m/s of speed. Only meaningful for `Axial`. */
  stretch?: number;
  /** Restitution against the ground plane. 0 disables collision. */
  bounce?: number;
  sizeCurve?: Curve;
  alphaCurve?: Curve;
  colorRamp?: ColorRamp;
}

export const LUT_SIZE = 48;

// -- shared curves ----------------------------------------------------------

/**
 * Smoke dissipation: a fast fade-in so nothing pops, a long shoulder while
 * the puff is dense, then a tail that thins out rather than switching off.
 */
const SMOKE_ALPHA: Curve = [
  [0, 0],
  [0.05, 1],
  [0.3, 0.86],
  [0.62, 0.42],
  [0.85, 0.14],
  [1, 0],
];
const SMOKE_SIZE: Curve = [
  [0, 0.32],
  [0.15, 0.62],
  [0.5, 0.92],
  [1, 1.3],
];
const SMOKE_RAMP: ColorRamp = [
  [0, 1.35, 1.3, 1.25],
  [0.2, 1.05, 1.03, 1.0],
  [1, 0.72, 0.72, 0.74],
];

const DUST_ALPHA: Curve = [
  [0, 0],
  [0.07, 1],
  [0.45, 0.6],
  [1, 0],
];
const DUST_SIZE: Curve = [
  [0, 0.4],
  [0.3, 0.95],
  [1, 1.45],
];

const SPARK_ALPHA: Curve = [
  [0, 1],
  [0.55, 0.95],
  [0.85, 0.5],
  [1, 0],
];
const SPARK_SIZE: Curve = [
  [0, 1],
  [0.6, 0.8],
  [1, 0.15],
];
/** White-hot to orange to a dull red ember. */
const SPARK_RAMP: ColorRamp = [
  [0, 1.7, 1.6, 1.35],
  [0.18, 1.55, 0.95, 0.4],
  [0.5, 1.15, 0.42, 0.09],
  [0.82, 0.6, 0.14, 0.02],
  [1, 0.2, 0.03, 0],
];

const FLASH_ALPHA: Curve = [
  [0, 0.85],
  [0.12, 1],
  [0.4, 0.45],
  [1, 0],
];
const FLASH_SIZE: Curve = [
  [0, 0.55],
  [0.2, 1],
  [1, 1.25],
];

const DEBRIS_ALPHA: Curve = [
  [0, 1],
  [0.75, 1],
  [1, 0],
];
const DEBRIS_SIZE: Curve = [
  [0, 1],
  [1, 0.8],
];

const DROPLET_ALPHA: Curve = [
  [0, 0],
  [0.05, 1],
  [0.8, 0.9],
  [1, 0],
];

const RING_ALPHA: Curve = [
  [0, 0.9],
  [0.25, 0.7],
  [1, 0],
];
const RING_SIZE: Curve = [
  [0, 0.15],
  [0.35, 0.8],
  [1, 1.5],
];

// -- type table -------------------------------------------------------------

const SPECS: ParticleTypeSpec[] = [
  // ---- muzzle ----
  {
    id: 'muzzle.core',
    batch: 'additive',
    sprite: Sprite.Flare,
    billboard: Billboard.Spherical,
    life: [0.035, 0.055],
    size: [0.085, 0.13],
    drag: 6,
    gravity: 0,
    spin: [-14, 14],
    color: [1.0, 0.82, 0.5],
    intensity: [9, 15],
    softness: 0.08,
    sizeCurve: [
      [0, 0.7],
      [0.25, 1.15],
      [1, 0.6],
    ],
    alphaCurve: [
      [0, 1],
      [0.5, 0.8],
      [1, 0],
    ],
  },
  {
    id: 'muzzle.flash',
    batch: 'additive',
    sprite: Sprite.Flash,
    billboard: Billboard.Axial,
    life: [0.04, 0.06],
    size: [0.065, 0.1],
    aspect: 2.1,
    drag: 4,
    gravity: 0,
    color: [1.0, 0.72, 0.36],
    intensity: [7, 11],
    softness: 0.08,
    sizeCurve: FLASH_SIZE,
    alphaCurve: FLASH_ALPHA,
  },
  {
    id: 'muzzle.glow',
    batch: 'additive',
    sprite: Sprite.Glow,
    billboard: Billboard.Spherical,
    life: [0.06, 0.09],
    size: [0.19, 0.28],
    drag: 3,
    gravity: 0,
    color: [1.0, 0.66, 0.3],
    intensity: [2.2, 3.4],
    softness: 0.2,
    sizeCurve: [
      [0, 0.6],
      [0.3, 1.1],
      [1, 1.4],
    ],
    alphaCurve: [
      [0, 1],
      [0.3, 0.5],
      [1, 0],
    ],
  },
  {
    id: 'muzzle.ember',
    batch: 'additive',
    sprite: Sprite.Spark,
    billboard: Billboard.Axial,
    life: [0.12, 0.34],
    size: [0.008, 0.017],
    drag: 3.4,
    gravity: -7,
    color: [1, 0.6, 0.22],
    intensity: [3.5, 7],
    softness: 0.05,
    stretch: 0.02,
    bounce: 0.28,
    sizeCurve: SPARK_SIZE,
    alphaCurve: SPARK_ALPHA,
    colorRamp: SPARK_RAMP,
  },
  {
    id: 'muzzle.smoke',
    batch: 'alpha',
    sprite: Sprite.SmokeSoft,
    billboard: Billboard.Spherical,
    life: [0.9, 1.7],
    size: [0.07, 0.14],
    drag: 3.6,
    gravity: 0.1,
    buoyancy: 0.55,
    spin: [-2.2, 2.2],
    turbulence: 0.5,
    // Burnt propellant is dark. A light grey puff vanishes against a bright
    // sky, which is most of what the player is aiming at.
    color: [0.34, 0.33, 0.33],
    colorVariance: [0.05, 0.05, 0.05],
    intensity: [0.85, 1.15],
    opacity: 0.8,
    lightMix: 0.8,
    softness: 0.3,
    sizeCurve: SMOKE_SIZE,
    alphaCurve: SMOKE_ALPHA,
    colorRamp: SMOKE_RAMP,
  },
  {
    id: 'muzzle.smokeWisp',
    batch: 'alpha',
    sprite: Sprite.SmokeWisp,
    billboard: Billboard.Spherical,
    life: [1.3, 2.6],
    size: [0.09, 0.2],
    drag: 2.4,
    gravity: 0.05,
    buoyancy: 0.75,
    spin: [-1.1, 1.1],
    turbulence: 0.42,
    color: [0.44, 0.43, 0.42],
    intensity: [0.8, 1.05],
    opacity: 0.45,
    lightMix: 0.85,
    softness: 0.4,
    sizeCurve: [
      [0, 0.4],
      [0.4, 1.05],
      [1, 1.9],
    ],
    alphaCurve: SMOKE_ALPHA,
    colorRamp: SMOKE_RAMP,
  },

  // ---- impact: generic hot flash ----
  {
    id: 'impact.flash',
    batch: 'additive',
    sprite: Sprite.Glow,
    billboard: Billboard.Spherical,
    life: [0.05, 0.085],
    size: [0.075, 0.14],
    drag: 5,
    gravity: 0,
    color: [1, 0.74, 0.4],
    intensity: [4, 7],
    softness: 0.1,
    sizeCurve: FLASH_SIZE,
    alphaCurve: FLASH_ALPHA,
  },
  {
    id: 'impact.ring',
    batch: 'additive',
    sprite: Sprite.Ring,
    billboard: Billboard.Planar,
    life: [0.1, 0.16],
    size: [0.16, 0.26],
    drag: 1,
    gravity: 0,
    color: [1, 0.85, 0.62],
    intensity: [1.6, 2.6],
    softness: 0.12,
    sizeCurve: RING_SIZE,
    alphaCurve: RING_ALPHA,
  },

  // ---- concrete ----
  {
    id: 'concrete.dust',
    batch: 'alpha',
    sprite: Sprite.Dust,
    billboard: Billboard.Spherical,
    life: [0.5, 1.25],
    size: [0.06, 0.16],
    drag: 4.6,
    gravity: -0.7,
    buoyancy: 0.14,
    spin: [-2.6, 2.6],
    turbulence: 0.55,
    color: [0.58, 0.56, 0.53],
    colorVariance: [0.06, 0.05, 0.05],
    intensity: [0.9, 1.15],
    opacity: 0.44,
    lightMix: 0.9,
    softness: 0.28,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },
  {
    id: 'concrete.puff',
    batch: 'alpha',
    sprite: Sprite.SmokeDense,
    billboard: Billboard.Spherical,
    life: [0.28, 0.6],
    size: [0.045, 0.1],
    drag: 7,
    gravity: -0.8,
    spin: [-4, 4],
    turbulence: 0.3,
    color: [0.62, 0.6, 0.57],
    intensity: [0.95, 1.2],
    opacity: 0.58,
    lightMix: 0.9,
    softness: 0.22,
    sizeCurve: [
      [0, 0.4],
      [0.3, 1],
      [1, 1.3],
    ],
    alphaCurve: DUST_ALPHA,
  },
  {
    id: 'concrete.chip',
    batch: 'alpha',
    sprite: Sprite.Debris,
    billboard: Billboard.Spherical,
    life: [0.5, 1.2],
    size: [0.006, 0.017],
    drag: 0.7,
    gravity: -16,
    spin: [-24, 24],
    color: [0.6, 0.58, 0.55],
    colorVariance: [0.1, 0.1, 0.1],
    intensity: [0.85, 1.1],
    opacity: 1,
    lightMix: 1,
    softness: 0.04,
    bounce: 0.32,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DEBRIS_ALPHA,
  },

  // ---- metal ----
  {
    id: 'metal.spark',
    batch: 'additive',
    sprite: Sprite.Spark,
    billboard: Billboard.Axial,
    life: [0.22, 0.6],
    size: [0.007, 0.016],
    drag: 1.5,
    gravity: -13,
    color: [1, 0.72, 0.34],
    intensity: [6, 12],
    softness: 0.04,
    stretch: 0.032,
    bounce: 0.42,
    sizeCurve: SPARK_SIZE,
    alphaCurve: SPARK_ALPHA,
    colorRamp: SPARK_RAMP,
  },
  {
    id: 'metal.ricochet',
    batch: 'additive',
    sprite: Sprite.Spark,
    billboard: Billboard.Axial,
    life: [0.35, 0.85],
    size: [0.009, 0.02],
    drag: 0.9,
    gravity: -14,
    color: [1, 0.8, 0.46],
    intensity: [8, 15],
    softness: 0.04,
    stretch: 0.044,
    bounce: 0.5,
    sizeCurve: SPARK_SIZE,
    alphaCurve: SPARK_ALPHA,
    colorRamp: SPARK_RAMP,
  },
  {
    id: 'metal.spall',
    batch: 'alpha',
    sprite: Sprite.Shard,
    billboard: Billboard.Axial,
    life: [0.35, 0.8],
    size: [0.004, 0.011],
    aspect: 3.2,
    drag: 1.1,
    gravity: -15,
    color: [0.5, 0.48, 0.46],
    intensity: [1.0, 1.4],
    opacity: 1,
    lightMix: 1,
    softness: 0.03,
    stretch: 0.006,
    bounce: 0.3,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DEBRIS_ALPHA,
  },
  {
    id: 'metal.smoke',
    batch: 'alpha',
    sprite: Sprite.SmokeDense,
    billboard: Billboard.Spherical,
    life: [0.25, 0.55],
    size: [0.035, 0.075],
    drag: 6,
    gravity: 0.1,
    buoyancy: 0.5,
    spin: [-3.4, 3.4],
    color: [0.3, 0.29, 0.28],
    intensity: [0.85, 1.1],
    opacity: 0.5,
    lightMix: 0.85,
    softness: 0.2,
    sizeCurve: SMOKE_SIZE,
    alphaCurve: DUST_ALPHA,
  },

  // ---- wood ----
  {
    id: 'wood.splinter',
    batch: 'alpha',
    sprite: Sprite.Shard,
    billboard: Billboard.Axial,
    life: [0.55, 1.3],
    size: [0.005, 0.014],
    aspect: 4.5,
    drag: 1.6,
    gravity: -14,
    spin: [-10, 10],
    color: [0.52, 0.38, 0.24],
    colorVariance: [0.1, 0.08, 0.06],
    intensity: [0.9, 1.2],
    opacity: 1,
    lightMix: 1,
    softness: 0.03,
    stretch: 0.01,
    bounce: 0.22,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DEBRIS_ALPHA,
  },
  {
    id: 'wood.dust',
    batch: 'alpha',
    sprite: Sprite.Dust,
    billboard: Billboard.Spherical,
    life: [0.4, 0.95],
    size: [0.045, 0.11],
    drag: 5.5,
    gravity: -0.6,
    buoyancy: 0.3,
    spin: [-3, 3],
    turbulence: 0.4,
    color: [0.66, 0.5, 0.32],
    colorVariance: [0.07, 0.06, 0.04],
    intensity: [0.9, 1.15],
    opacity: 0.6,
    lightMix: 1,
    softness: 0.24,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },

  // ---- dirt / sand ----
  {
    id: 'dirt.clod',
    batch: 'alpha',
    sprite: Sprite.Debris,
    billboard: Billboard.Spherical,
    life: [0.7, 1.4],
    size: [0.009, 0.026],
    drag: 0.9,
    gravity: -17,
    spin: [-16, 16],
    color: [0.34, 0.26, 0.18],
    colorVariance: [0.07, 0.06, 0.04],
    intensity: [0.9, 1.15],
    opacity: 1,
    lightMix: 1,
    softness: 0.04,
    bounce: 0.14,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DEBRIS_ALPHA,
  },
  {
    id: 'dirt.plume',
    batch: 'alpha',
    sprite: Sprite.SmokeSoft,
    billboard: Billboard.Spherical,
    life: [0.55, 1.4],
    size: [0.07, 0.18],
    drag: 4,
    gravity: -0.7,
    buoyancy: 0.5,
    spin: [-2.4, 2.4],
    turbulence: 0.6,
    color: [0.46, 0.37, 0.27],
    colorVariance: [0.06, 0.05, 0.04],
    intensity: [0.9, 1.15],
    opacity: 0.68,
    lightMix: 1,
    softness: 0.3,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },
  {
    id: 'sand.plume',
    batch: 'alpha',
    sprite: Sprite.Dust,
    billboard: Billboard.Spherical,
    life: [0.6, 1.5],
    size: [0.075, 0.19],
    drag: 3.6,
    gravity: -0.5,
    buoyancy: 0.4,
    spin: [-2, 2],
    turbulence: 0.55,
    color: [0.78, 0.68, 0.48],
    intensity: [0.95, 1.2],
    opacity: 0.64,
    lightMix: 1,
    softness: 0.32,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },

  // ---- glass ----
  {
    id: 'glass.shard',
    batch: 'alpha',
    sprite: Sprite.Shard,
    billboard: Billboard.Axial,
    life: [0.6, 1.4],
    size: [0.005, 0.016],
    aspect: 2.8,
    drag: 0.6,
    gravity: -17,
    spin: [-20, 20],
    color: [0.72, 0.85, 0.9],
    intensity: [1.4, 2.6],
    opacity: 0.85,
    lightMix: 0.5,
    softness: 0.03,
    stretch: 0.008,
    bounce: 0.4,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DEBRIS_ALPHA,
  },
  {
    id: 'glass.glint',
    batch: 'additive',
    sprite: Sprite.Ember,
    billboard: Billboard.Spherical,
    life: [0.35, 0.9],
    size: [0.007, 0.016],
    drag: 0.6,
    gravity: -17,
    color: [0.8, 0.93, 1],
    intensity: [3, 7],
    softness: 0.03,
    bounce: 0.4,
    sizeCurve: SPARK_SIZE,
    alphaCurve: [
      [0, 0.2],
      [0.15, 1],
      [0.5, 0.3],
      [0.7, 0.9],
      [1, 0],
    ],
  },
  {
    id: 'glass.dust',
    batch: 'alpha',
    sprite: Sprite.SmokeWisp,
    billboard: Billboard.Spherical,
    life: [0.3, 0.7],
    size: [0.04, 0.1],
    drag: 6,
    gravity: -1.2,
    spin: [-3, 3],
    color: [0.8, 0.88, 0.92],
    intensity: [1.1, 1.5],
    opacity: 0.42,
    lightMix: 0.7,
    softness: 0.22,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },

  // ---- water ----
  {
    id: 'water.droplet',
    batch: 'alpha',
    sprite: Sprite.Splash,
    billboard: Billboard.Axial,
    life: [0.4, 0.9],
    size: [0.008, 0.022],
    aspect: 2.2,
    drag: 0.8,
    gravity: -16,
    color: [0.72, 0.82, 0.86],
    intensity: [1.2, 1.8],
    opacity: 0.75,
    lightMix: 0.6,
    softness: 0.05,
    stretch: 0.012,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DROPLET_ALPHA,
  },
  {
    id: 'water.mist',
    batch: 'alpha',
    sprite: Sprite.SmokeWisp,
    billboard: Billboard.Spherical,
    life: [0.4, 0.95],
    size: [0.05, 0.14],
    drag: 5,
    gravity: -1.4,
    spin: [-2, 2],
    turbulence: 0.4,
    color: [0.78, 0.85, 0.88],
    intensity: [1.0, 1.3],
    opacity: 0.5,
    lightMix: 0.9,
    softness: 0.26,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },
  {
    id: 'water.crown',
    batch: 'alpha',
    sprite: Sprite.Ring,
    billboard: Billboard.Planar,
    life: [0.22, 0.34],
    size: [0.1, 0.16],
    drag: 1,
    gravity: 0,
    color: [0.8, 0.88, 0.92],
    intensity: [1.1, 1.5],
    opacity: 0.6,
    lightMix: 0.8,
    softness: 0.1,
    sizeCurve: RING_SIZE,
    alphaCurve: RING_ALPHA,
  },

  // ---- flesh ----
  {
    id: 'blood.mist',
    batch: 'alpha',
    sprite: Sprite.BloodMist,
    billboard: Billboard.Spherical,
    life: [0.3, 0.7],
    size: [0.05, 0.14],
    drag: 5.5,
    gravity: -2.2,
    spin: [-2.6, 2.6],
    turbulence: 0.35,
    color: [0.42, 0.035, 0.03],
    colorVariance: [0.08, 0.01, 0.01],
    intensity: [0.9, 1.3],
    opacity: 0.6,
    lightMix: 0.9,
    softness: 0.2,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },
  {
    id: 'blood.droplet',
    batch: 'alpha',
    sprite: Sprite.BloodDrop,
    billboard: Billboard.Axial,
    life: [0.5, 1.1],
    size: [0.006, 0.018],
    aspect: 1.8,
    drag: 0.7,
    gravity: -17,
    color: [0.36, 0.03, 0.025],
    intensity: [0.9, 1.3],
    opacity: 1,
    lightMix: 0.95,
    softness: 0.04,
    stretch: 0.011,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DROPLET_ALPHA,
  },

  // ---- misc ----
  {
    id: 'foliage.leaf',
    batch: 'alpha',
    sprite: Sprite.Debris,
    billboard: Billboard.Spherical,
    life: [0.9, 2.0],
    size: [0.012, 0.03],
    drag: 3.2,
    gravity: -3.4,
    spin: [-9, 9],
    turbulence: 1.1,
    color: [0.24, 0.34, 0.14],
    colorVariance: [0.06, 0.08, 0.04],
    intensity: [0.9, 1.2],
    opacity: 1,
    lightMix: 1,
    softness: 0.05,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DEBRIS_ALPHA,
  },
  {
    id: 'fabric.fluff',
    batch: 'alpha',
    sprite: Sprite.SmokeWisp,
    billboard: Billboard.Spherical,
    life: [0.5, 1.2],
    size: [0.02, 0.05],
    drag: 4.5,
    gravity: -1.6,
    spin: [-5, 5],
    turbulence: 0.6,
    color: [0.6, 0.56, 0.5],
    intensity: [0.9, 1.15],
    opacity: 0.55,
    lightMix: 1,
    softness: 0.1,
    sizeCurve: DEBRIS_SIZE,
    alphaCurve: DUST_ALPHA,
  },
  {
    id: 'footstep.dust',
    batch: 'alpha',
    sprite: Sprite.Dust,
    billboard: Billboard.Spherical,
    life: [0.45, 1.0],
    size: [0.05, 0.13],
    drag: 5,
    gravity: -0.25,
    buoyancy: 0.25,
    spin: [-1.8, 1.8],
    turbulence: 0.35,
    color: [0.7, 0.67, 0.62],
    intensity: [0.9, 1.1],
    opacity: 0.4,
    lightMix: 1,
    softness: 0.3,
    sizeCurve: DUST_SIZE,
    alphaCurve: DUST_ALPHA,
  },
  {
    id: 'death.dust',
    batch: 'alpha',
    sprite: Sprite.SmokeSoft,
    billboard: Billboard.Spherical,
    life: [0.9, 2.2],
    size: [0.12, 0.3],
    drag: 3,
    gravity: -0.35,
    buoyancy: 0.4,
    spin: [-1.4, 1.4],
    turbulence: 0.5,
    color: [0.62, 0.58, 0.52],
    intensity: [0.9, 1.1],
    opacity: 0.46,
    lightMix: 1,
    softness: 0.35,
    sizeCurve: DUST_SIZE,
    alphaCurve: SMOKE_ALPHA,
  },
  {
    // Life is always 1s at the type level; the emitter scales it to the
    // round's actual time of flight so the streak dies exactly at the impact.
    id: 'tracer',
    batch: 'additive',
    sprite: Sprite.Streak,
    billboard: Billboard.Axial,
    life: [1, 1],
    size: [0.016, 0.024],
    drag: 0,
    gravity: -2.5,
    color: [1, 0.64, 0.24],
    intensity: [9, 14],
    softness: 0.06,
    stretch: 0.022,
    sizeCurve: [
      [0, 0.55],
      [0.08, 1],
      [0.7, 1],
      [1, 0.45],
    ],
    alphaCurve: [
      [0, 0],
      [0.05, 1],
      [0.5, 0.82],
      [0.86, 0.36],
      [1, 0],
    ],
  },
  {
    id: 'shell.glint',
    batch: 'additive',
    sprite: Sprite.Ember,
    billboard: Billboard.Spherical,
    life: [0.12, 0.26],
    size: [0.006, 0.012],
    drag: 2,
    gravity: -9,
    color: [1, 0.86, 0.55],
    intensity: [2, 4],
    softness: 0.03,
    sizeCurve: SPARK_SIZE,
    alphaCurve: SPARK_ALPHA,
  },
];

/** Stable ids, resolved to indices once at boot. */
export type ParticleTypeId = (typeof SPECS)[number]['id'];

function bake(points: Curve | undefined, fallback: number): Float32Array {
  const out = new Float32Array(LUT_SIZE);
  if (!points || points.length === 0) {
    out.fill(fallback);
    return out;
  }
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let a = points[0]!;
    let b = points[points.length - 1]!;
    for (let k = 0; k < points.length - 1; k++) {
      if (t >= points[k]![0] && t <= points[k + 1]![0]) {
        a = points[k]!;
        b = points[k + 1]!;
        break;
      }
    }
    const span = b[0] - a[0];
    const f = span > 1e-6 ? (t - a[0]) / span : 0;
    out[i] = a[1] + (b[1] - a[1]) * f;
  }
  return out;
}

function bakeRamp(points: ColorRamp | undefined): Float32Array {
  const out = new Float32Array(LUT_SIZE * 3);
  if (!points || points.length === 0) {
    out.fill(1);
    return out;
  }
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let a = points[0]!;
    let b = points[points.length - 1]!;
    for (let k = 0; k < points.length - 1; k++) {
      if (t >= points[k]![0] && t <= points[k + 1]![0]) {
        a = points[k]!;
        b = points[k + 1]!;
        break;
      }
    }
    const span = b[0] - a[0];
    const f = span > 1e-6 ? (t - a[0]) / span : 0;
    out[i * 3] = a[1] + (b[1] - a[1]) * f;
    out[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
    out[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
  }
  return out;
}

/** Flattened, simulation-ready view of the type registry. */
export class ParticleTypeTable {
  readonly count = SPECS.length;
  readonly ids: string[] = [];
  readonly index = new Map<string, number>();

  readonly batch = new Uint8Array(SPECS.length);
  readonly sprite = new Float32Array(SPECS.length);
  readonly billboard = new Float32Array(SPECS.length);
  readonly lifeMin = new Float32Array(SPECS.length);
  readonly lifeSpan = new Float32Array(SPECS.length);
  readonly sizeMin = new Float32Array(SPECS.length);
  readonly sizeSpan = new Float32Array(SPECS.length);
  readonly aspect = new Float32Array(SPECS.length);
  readonly drag = new Float32Array(SPECS.length);
  readonly gravity = new Float32Array(SPECS.length);
  readonly buoyancy = new Float32Array(SPECS.length);
  readonly spinMin = new Float32Array(SPECS.length);
  readonly spinSpan = new Float32Array(SPECS.length);
  readonly turbulence = new Float32Array(SPECS.length);
  readonly colorR = new Float32Array(SPECS.length);
  readonly colorG = new Float32Array(SPECS.length);
  readonly colorB = new Float32Array(SPECS.length);
  readonly varR = new Float32Array(SPECS.length);
  readonly varG = new Float32Array(SPECS.length);
  readonly varB = new Float32Array(SPECS.length);
  readonly intensityMin = new Float32Array(SPECS.length);
  readonly intensitySpan = new Float32Array(SPECS.length);
  readonly opacity = new Float32Array(SPECS.length);
  readonly lightMix = new Float32Array(SPECS.length);
  readonly softness = new Float32Array(SPECS.length);
  readonly stretch = new Float32Array(SPECS.length);
  readonly bounce = new Float32Array(SPECS.length);

  readonly sizeLut = new Float32Array(SPECS.length * LUT_SIZE);
  readonly alphaLut = new Float32Array(SPECS.length * LUT_SIZE);
  readonly colorLut = new Float32Array(SPECS.length * LUT_SIZE * 3);

  constructor() {
    for (let i = 0; i < SPECS.length; i++) {
      const s = SPECS[i]!;
      this.ids.push(s.id);
      this.index.set(s.id, i);
      this.batch[i] = s.batch === 'additive' ? 1 : 0;
      this.sprite[i] = s.sprite;
      this.billboard[i] = s.billboard;
      this.lifeMin[i] = s.life[0];
      this.lifeSpan[i] = s.life[1] - s.life[0];
      this.sizeMin[i] = s.size[0];
      this.sizeSpan[i] = s.size[1] - s.size[0];
      this.aspect[i] = s.aspect ?? 1;
      this.drag[i] = s.drag;
      this.gravity[i] = s.gravity;
      this.buoyancy[i] = s.buoyancy ?? 0;
      this.spinMin[i] = s.spin ? s.spin[0] : 0;
      this.spinSpan[i] = s.spin ? s.spin[1] - s.spin[0] : 0;
      this.turbulence[i] = s.turbulence ?? 0;
      this.colorR[i] = s.color[0];
      this.colorG[i] = s.color[1];
      this.colorB[i] = s.color[2];
      this.varR[i] = s.colorVariance?.[0] ?? 0;
      this.varG[i] = s.colorVariance?.[1] ?? 0;
      this.varB[i] = s.colorVariance?.[2] ?? 0;
      this.intensityMin[i] = s.intensity?.[0] ?? 1;
      this.intensitySpan[i] = (s.intensity?.[1] ?? 1) - (s.intensity?.[0] ?? 1);
      this.opacity[i] = s.opacity ?? 1;
      this.lightMix[i] = s.lightMix ?? 0;
      this.softness[i] = s.softness ?? 0.2;
      this.stretch[i] = s.stretch ?? 0;
      this.bounce[i] = s.bounce ?? 0;

      this.sizeLut.set(bake(s.sizeCurve, 1), i * LUT_SIZE);
      this.alphaLut.set(bake(s.alphaCurve, 1), i * LUT_SIZE);
      this.colorLut.set(bakeRamp(s.colorRamp), i * LUT_SIZE * 3);
    }
  }

  /** Throws on an unknown id: a typo here is a silent missing effect. */
  id(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`[vfx] unknown particle type "${name}"`);
    return i;
  }
}
