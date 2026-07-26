import * as THREE from 'three';
import { easeOutBack, easeOutCubic, smoothstep } from './Springs.ts';

/**
 * Keyframed clips for the mechanical animations: reloads, the inspect, and
 * the draw. Everything reactive — sway, bob, recoil, ADS — lives in the rig
 * instead, so these clips only describe what the hands are doing.
 *
 * Times are normalised so a clip can be retimed to whatever the weapon
 * definition says a reload costs without re-authoring the keys.
 */

type Ease = 'linear' | 'smooth' | 'out' | 'in' | 'back' | 'snap';

interface PoseKey {
  t: number;
  /** Additive position offset in viewmodel camera space, metres. */
  p: readonly [number, number, number];
  /** Additive rotation offset in weapon-local space, radians. */
  r: readonly [number, number, number];
  ease?: Ease;
}

interface ScalarKey {
  t: number;
  v: number;
  ease?: Ease;
}

export interface AnimationClip {
  readonly id: string;
  readonly pose: readonly PoseKey[];
  readonly magX?: readonly ScalarKey[];
  readonly magY?: readonly ScalarKey[];
  readonly magZ?: readonly ScalarKey[];
  readonly magPitch?: readonly ScalarKey[];
  readonly magRoll?: readonly ScalarKey[];
  /** Normalised window during which the magazine mesh is hidden. */
  readonly magHidden?: readonly [number, number];
  readonly charge?: readonly ScalarKey[];
  readonly bolt?: readonly ScalarKey[];
  /** Cancellable by firing after this normalised time. */
  readonly cancelAfter?: number;
}

function applyEase(t: number, ease: Ease): number {
  switch (ease) {
    case 'linear':
      return t;
    case 'out':
      return easeOutCubic(t);
    case 'in':
      return t * t;
    case 'back':
      return easeOutBack(t, 1.9);
    // Springs and released bolts move far faster than a hand does; 'snap'
    // front-loads almost the whole travel into the first fifth of the segment.
    case 'snap':
      return 1 - Math.pow(1 - t, 6);
    case 'smooth':
    default:
      return smoothstep(0, 1, t);
  }
}

function sampleScalar(keys: readonly ScalarKey[] | undefined, t: number): number {
  if (!keys || keys.length === 0) return 0;
  if (t <= (keys[0] as ScalarKey).t) return (keys[0] as ScalarKey).v;
  const last = keys[keys.length - 1] as ScalarKey;
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i] as ScalarKey;
    const b = keys[i + 1] as ScalarKey;
    if (t >= a.t && t <= b.t) {
      const span = Math.max(1e-6, b.t - a.t);
      return THREE.MathUtils.lerp(a.v, b.v, applyEase((t - a.t) / span, b.ease ?? 'smooth'));
    }
  }
  return last.v;
}

function samplePose(
  keys: readonly PoseKey[],
  t: number,
  outPosition: THREE.Vector3,
  outRotation: THREE.Euler
): void {
  const first = keys[0] as PoseKey;
  const last = keys[keys.length - 1] as PoseKey;
  let a = first;
  let b = last;
  let local = 0;
  if (t <= first.t) {
    a = first;
    b = first;
  } else if (t >= last.t) {
    a = last;
    b = last;
  } else {
    for (let i = 0; i < keys.length - 1; i++) {
      const ka = keys[i] as PoseKey;
      const kb = keys[i + 1] as PoseKey;
      if (t >= ka.t && t <= kb.t) {
        a = ka;
        b = kb;
        const span = Math.max(1e-6, kb.t - ka.t);
        local = applyEase((t - ka.t) / span, kb.ease ?? 'smooth');
        break;
      }
    }
  }
  outPosition.set(
    THREE.MathUtils.lerp(a.p[0], b.p[0], local),
    THREE.MathUtils.lerp(a.p[1], b.p[1], local),
    THREE.MathUtils.lerp(a.p[2], b.p[2], local)
  );
  outRotation.set(
    THREE.MathUtils.lerp(a.r[0], b.r[0], local),
    THREE.MathUtils.lerp(a.r[1], b.r[1], local),
    THREE.MathUtils.lerp(a.r[2], b.r[2], local),
    'YXZ'
  );
}

const REST: PoseKey = { t: 0, p: [0, 0, 0], r: [0, 0, 0] };

/**
 * Empty reload: the magazine is dropped free, a fresh one is rocked in, and
 * the bolt is released on the charging handle. Roughly 40% of the clip is
 * spent on the charging handle, which is what makes an empty reload feel
 * meaningfully worse than a tactical one.
 */
export const RELOAD_EMPTY: AnimationClip = {
  id: 'reload_empty',
  pose: [
    REST,
    // The weapon rises and cants hard toward the shooter. Both parts matter:
    // the magwell hangs 100mm below a bore that already sits below the frame,
    // so without the lift the entire reload happens off-screen and reads as a
    // stutter rather than an action.
    { t: 0.06, p: [0.014, 0.043, 0.026], r: [0.14, 0.24, -0.48], ease: 'out' },
    { t: 0.22, p: [0.016, 0.035, 0.03], r: [0.16, 0.26, -0.52] },
    { t: 0.33, p: [0.01, 0.012, 0.036], r: [0.1, 0.2, -0.44], ease: 'in' },
    { t: 0.5, p: [0.014, 0.035, 0.028], r: [0.15, 0.24, -0.5], ease: 'out' },
    // Magazine seats: a short upward jolt sells the impact of the slap.
    { t: 0.55, p: [0.014, 0.055, 0.024], r: [0.13, 0.24, -0.46], ease: 'snap' },
    { t: 0.6, p: [0.02, 0.04, 0.03], r: [0.06, 0.42, -0.3], ease: 'out' },
    { t: 0.74, p: [0.024, 0.034, 0.034], r: [0.04, 0.46, -0.24] },
    // Bolt released; the whole weapon shudders forward.
    { t: 0.79, p: [0.024, 0.038, 0.022], r: [0.05, 0.45, -0.25], ease: 'snap' },
    { t: 0.84, p: [0.02, 0.032, 0.032], r: [0.04, 0.44, -0.26], ease: 'out' },
    { t: 1, p: [0, 0, 0], r: [0, 0, 0], ease: 'out' },
  ],
  magY: [
    { t: 0.18, v: 0 },
    { t: 0.3, v: -0.42, ease: 'in' },
    { t: 0.33, v: -0.4 },
    { t: 0.38, v: -0.36, ease: 'out' },
    { t: 0.55, v: 0, ease: 'back' },
  ],
  magZ: [
    { t: 0.18, v: 0 },
    { t: 0.3, v: -0.05, ease: 'in' },
    { t: 0.38, v: -0.055 },
    { t: 0.55, v: 0, ease: 'out' },
  ],
  magPitch: [
    { t: 0.18, v: 0 },
    { t: 0.3, v: 0.55, ease: 'in' },
    { t: 0.38, v: 0.34 },
    { t: 0.55, v: 0, ease: 'out' },
  ],
  magHidden: [0.31, 0.36],
  charge: [
    { t: 0.62, v: 0 },
    { t: 0.73, v: 0.088, ease: 'out' },
    { t: 0.77, v: 0.088 },
    { t: 0.79, v: 0, ease: 'snap' },
  ],
  bolt: [
    { t: 0.62, v: 0 },
    { t: 0.73, v: 0.06, ease: 'out' },
    { t: 0.77, v: 0.06 },
    { t: 0.79, v: 0, ease: 'snap' },
  ],
  cancelAfter: 0.92,
};

/** Tactical reload: chamber is loaded, so the bolt is never touched. */
export const RELOAD_TACTICAL: AnimationClip = {
  id: 'reload_tactical',
  pose: [
    REST,
    { t: 0.08, p: [0.013, 0.04, 0.024], r: [0.13, 0.22, -0.44], ease: 'out' },
    { t: 0.26, p: [0.015, 0.034, 0.028], r: [0.15, 0.24, -0.48] },
    { t: 0.42, p: [0.009, 0.014, 0.034], r: [0.1, 0.19, -0.4], ease: 'in' },
    { t: 0.62, p: [0.013, 0.036, 0.026], r: [0.14, 0.23, -0.47], ease: 'out' },
    { t: 0.68, p: [0.013, 0.056, 0.02], r: [0.12, 0.23, -0.43], ease: 'snap' },
    { t: 0.78, p: [0.012, 0.04, 0.026], r: [0.11, 0.2, -0.38], ease: 'out' },
    { t: 1, p: [0, 0, 0], r: [0, 0, 0], ease: 'out' },
  ],
  magY: [
    { t: 0.22, v: 0 },
    { t: 0.36, v: -0.42, ease: 'in' },
    { t: 0.4, v: -0.4 },
    { t: 0.46, v: -0.34, ease: 'out' },
    { t: 0.68, v: 0, ease: 'back' },
  ],
  magZ: [
    { t: 0.22, v: 0 },
    { t: 0.36, v: -0.05, ease: 'in' },
    { t: 0.46, v: -0.05 },
    { t: 0.68, v: 0, ease: 'out' },
  ],
  magPitch: [
    { t: 0.22, v: 0 },
    { t: 0.36, v: 0.5, ease: 'in' },
    { t: 0.46, v: 0.3 },
    { t: 0.68, v: 0, ease: 'out' },
  ],
  magHidden: [0.375, 0.43],
  cancelAfter: 0.88,
};

/** Idle flourish. Purely cosmetic, cancellable by anything. */
export const INSPECT: AnimationClip = {
  id: 'inspect',
  pose: [
    REST,
    { t: 0.13, p: [0.022, 0.012, 0.062], r: [0.04, 0.72, -0.38], ease: 'out' },
    { t: 0.34, p: [0.016, 0.004, 0.058], r: [-0.02, 0.78, -0.44] },
    { t: 0.5, p: [-0.004, -0.008, 0.05], r: [-0.14, -0.5, 0.46] },
    { t: 0.68, p: [0.012, -0.036, 0.03], r: [0.4, 0.16, 0.12] },
    { t: 0.85, p: [0.02, -0.03, 0.034], r: [0.1, 0.32, -0.46] },
    { t: 1, p: [0, 0, 0], r: [0, 0, 0], ease: 'out' },
  ],
  charge: [
    { t: 0.5, v: 0 },
    { t: 0.57, v: 0.03, ease: 'out' },
    { t: 0.62, v: 0, ease: 'snap' },
  ],
  bolt: [
    { t: 0.5, v: 0 },
    { t: 0.57, v: 0.022, ease: 'out' },
    { t: 0.62, v: 0, ease: 'snap' },
  ],
  cancelAfter: 0,
};

/** First raise. Overshoots slightly so the weapon lands with weight. */
export const DRAW: AnimationClip = {
  id: 'draw',
  pose: [
    { t: 0, p: [0.03, -0.26, 0.05], r: [-0.55, 0.6, 0.42] },
    { t: 0.72, p: [-0.004, 0.012, -0.008], r: [0.05, -0.05, -0.04], ease: 'out' },
    { t: 1, p: [0, 0, 0], r: [0, 0, 0], ease: 'out' },
  ],
  cancelAfter: 0.6,
};

/** Sampled output of the active clip, consumed by the rig each fixed step. */
export interface AnimationOutput {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Euler;
  readonly magazineOffset: THREE.Vector3;
  magazinePitch: number;
  magazineRoll: number;
  magazineVisible: boolean;
  chargeOffset: number;
  boltOffset: number;
  /** True while a clip is playing that should suppress aiming down sights. */
  blocking: boolean;
}

/** Plays one clip at a time and blends its tail back to rest. */
export class WeaponAnimator {
  readonly output: AnimationOutput = {
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(0, 0, 0, 'YXZ'),
    magazineOffset: new THREE.Vector3(),
    magazinePitch: 0,
    magazineRoll: 0,
    magazineVisible: true,
    chargeOffset: 0,
    boltOffset: 0,
    blocking: false,
  };

  #clip: AnimationClip | null = null;
  #elapsed = 0;
  #duration = 1;

  get clipId(): string | null {
    return this.#clip?.id ?? null;
  }

  get playing(): boolean {
    return this.#clip !== null;
  }

  /** Normalised progress of the active clip, or 1 when idle. */
  get progress(): number {
    return this.#clip ? THREE.MathUtils.clamp(this.#elapsed / this.#duration, 0, 1) : 1;
  }

  play(clip: AnimationClip, duration: number): void {
    this.#clip = clip;
    this.#duration = Math.max(0.05, duration);
    this.#elapsed = 0;
  }

  /** True when firing should be allowed to interrupt the current clip. */
  get cancellable(): boolean {
    if (!this.#clip) return true;
    return this.progress >= (this.#clip.cancelAfter ?? 1);
  }

  cancel(): void {
    this.#clip = null;
    this.#elapsed = 0;
  }

  step(dt: number): AnimationOutput {
    const out = this.output;
    if (!this.#clip) {
      out.position.set(0, 0, 0);
      out.rotation.set(0, 0, 0, 'YXZ');
      out.magazineOffset.set(0, 0, 0);
      out.magazinePitch = 0;
      out.magazineRoll = 0;
      out.magazineVisible = true;
      out.chargeOffset = 0;
      out.boltOffset = 0;
      out.blocking = false;
      return out;
    }

    this.#elapsed += dt;
    const t = THREE.MathUtils.clamp(this.#elapsed / this.#duration, 0, 1);
    const clip = this.#clip;

    samplePose(clip.pose, t, out.position, out.rotation);
    out.magazineOffset.set(
      sampleScalar(clip.magX, t),
      sampleScalar(clip.magY, t),
      sampleScalar(clip.magZ, t)
    );
    out.magazinePitch = sampleScalar(clip.magPitch, t);
    out.magazineRoll = sampleScalar(clip.magRoll, t);
    out.magazineVisible = !clip.magHidden || t < clip.magHidden[0] || t > clip.magHidden[1];
    out.chargeOffset = sampleScalar(clip.charge, t);
    out.boltOffset = sampleScalar(clip.bolt, t);
    out.blocking = true;

    if (this.#elapsed >= this.#duration) this.cancel();
    return out;
  }
}
