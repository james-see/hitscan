/**
 * The sound catalogue and the mix's tuning constants.
 *
 * Cue ids match the keys in `public/audio/index.json`, which is written by
 * `tools/audio/generate.mjs`. Everything in the bank is synthesised — there
 * is no third-party audio in this project — so a cue is a family of
 * procedurally generated variants rather than a single recording.
 */

import type { SurfaceKind } from '@/types/gameplay.ts';

export type CueId =
  | 'weapon.rifle.fire.close'
  | 'weapon.rifle.fire.distant'
  | 'weapon.rifle.dry'
  | 'weapon.rifle.mag.out'
  | 'weapon.rifle.mag.in'
  | 'weapon.rifle.charge.pull'
  | 'weapon.rifle.charge.release'
  | 'weapon.rifle.ads.in'
  | 'weapon.rifle.ads.out'
  | 'impact.concrete'
  | 'impact.metal'
  | 'impact.wood'
  | 'impact.dirt'
  | 'impact.sand'
  | 'impact.glass'
  | 'impact.water'
  | 'impact.fabric'
  | 'impact.foliage'
  | 'impact.flesh'
  | 'step.concrete'
  | 'step.metal'
  | 'step.wood'
  | 'step.dirt'
  | 'step.sand'
  | 'step.water'
  | 'step.foliage'
  | 'shell.bounce'
  | 'ui.hit'
  | 'ui.hit.head'
  | 'ui.hit.kill'
  | 'player.land.soft'
  | 'player.land.hard'
  | 'player.jump'
  | 'player.hurt'
  | 'ambience.courtyard'
  | 'ir.courtyard'
  | 'ir.interior';

export interface CueVariant {
  url: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
}

export interface CueDefinition {
  group: string;
  /** Authored mix level relative to the loudest cue in the bank. */
  gain: number;
  loop: boolean;
  variants: CueVariant[];
}

export interface AudioIndex {
  version: number;
  generatedAt: string;
  note?: string;
  cues: Record<string, CueDefinition>;
}

/**
 * Voice-stealing priority. When the pool is saturated the quietest voice of
 * the lowest priority is taken, so a firefight loses shell casings and
 * footsteps long before it loses the shot the player just fired.
 */
export const Priority = {
  Ui: 100,
  PlayerWeapon: 90,
  PlayerBody: 70,
  EnemyWeapon: 65,
  Impact: 45,
  Footstep: 25,
  Shell: 10,
} as const;

/** Surfaces without a bespoke footstep borrow the nearest plausible one. */
const FOOTSTEP_BY_SURFACE: Record<SurfaceKind, CueId> = {
  concrete: 'step.concrete',
  metal: 'step.metal',
  wood: 'step.wood',
  dirt: 'step.dirt',
  sand: 'step.sand',
  glass: 'step.concrete',
  water: 'step.water',
  fabric: 'step.dirt',
  foliage: 'step.foliage',
  flesh: 'step.dirt',
};

const IMPACT_BY_SURFACE: Record<SurfaceKind, CueId> = {
  concrete: 'impact.concrete',
  metal: 'impact.metal',
  wood: 'impact.wood',
  dirt: 'impact.dirt',
  sand: 'impact.sand',
  glass: 'impact.glass',
  water: 'impact.water',
  fabric: 'impact.fabric',
  foliage: 'impact.foliage',
  flesh: 'impact.flesh',
};

export const footstepCue = (surface: SurfaceKind): CueId =>
  FOOTSTEP_BY_SURFACE[surface] ?? 'step.concrete';
export const impactCue = (surface: SurfaceKind): CueId =>
  IMPACT_BY_SURFACE[surface] ?? 'impact.concrete';

export const TUNING = {
  /**
   * Voice budget. Chrome handles far more than this, but an unbounded pool
   * turns a firefight into undifferentiated noise long before it becomes a
   * performance problem; the cap is a mix decision, not a perf one.
   */
  maxSpatialVoices: 24,
  maxFlatVoices: 10,

  /** Metres per second. Used for the propagation delay on distant fire. */
  speedOfSound: 343,
  /** Beyond this the delay stops feeling like distance and starts feeling laggy. */
  maxPropagationDelay: 0.32,
  /** Below this range, no delay at all: it would only smear the player's own fire. */
  propagationMinDistance: 12,

  /** PannerNode inverse-distance model. */
  refDistance: 5,
  rolloffFactor: 1.05,
  maxDistance: 150,

  /**
   * Air absorption, as a one-pole lowpass whose corner falls with range.
   * 20kHz at the listener, ~8kHz at 30m, ~4kHz at 80m. This is the single
   * cheapest cue for distance after loudness itself.
   */
  airAbsorptionScale: 22,

  /** Occlusion: a wall costs ~7dB and everything above ~700Hz. */
  occlusionGain: 0.44,
  occlusionCutoff: 700,
  /** Seconds for the occlusion filter to slide, so moving into cover glides. */
  occlusionGlide: 0.08,

  /**
   * Distance crossfade between the close and distant weapon layers. Close
   * fire is dominated by the transient, distant fire by the tail; a single
   * layer scaled by gain sounds like a small gun rather than a far one.
   */
  distantFadeStart: 14,
  distantFadeEnd: 55,

  /** Reverb send, as a fraction of the dry signal. */
  reverbSendDry: 0.3,
  /** Enclosed spaces get both a different impulse and more of it. */
  reverbWetOpen: 0.34,
  reverbWetEnclosed: 0.6,

  /** Ambience bed level, before the music volume setting. */
  ambienceGain: 0.28,

  /** Gunfire ducks the ambience bed so the shot owns the mix for a moment. */
  duckAmount: 0.45,
  duckAttack: 0.012,
  duckRelease: 0.35,

  /** Per-shot randomisation, so sustained fire never repeats exactly. */
  pitchJitter: 0.022,
  gainJitter: 0.9,

  /** Minimum spacing between shell-casing cues, in seconds. */
  shellMinInterval: 0.05,
} as const;
