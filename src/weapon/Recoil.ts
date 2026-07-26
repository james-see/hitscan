import * as THREE from 'three';
import type { RecoilProfile } from '@/types/gameplay.ts';
import type { Rng } from '@/types/rng.ts';

const DEG = Math.PI / 180;

/** A single shot's kick, in radians. Positive pitch is up, positive yaw left. */
export interface RecoilImpulse {
  pitch: number;
  yaw: number;
  /** Normalised magnitude against the profile's nominal kick, for the rig. */
  strength: number;
}

/**
 * View recoil: a deterministic pattern with bounded randomness, plus a
 * return-to-origin spring.
 *
 * The pattern is the part players learn; the randomness is what stops them
 * from memorising it perfectly. Recovery pulls the view back toward where it
 * was before the burst, so a player who never compensates ends up back on
 * target instead of staring at the sky.
 */
export class RecoilController {
  /** Accumulated, un-recovered kick in radians. */
  #pitch = 0;
  #yaw = 0;
  #sinceShot = Infinity;
  #patternIndex = 0;

  /** Kick produced by the most recent step; the rig subtracts it from sway. */
  readonly applied = { pitch: 0, yaw: 0 };

  /** Advances one shot through the pattern and returns its kick. */
  fire(profile: RecoilProfile, adsFactor: number, rng: Rng): RecoilImpulse {
    const index = this.#patternIndex % profile.pattern.length;
    const patternX = profile.pattern[index] ?? 0;
    this.#patternIndex++;

    const r = profile.randomness;
    // Vertical variance is one-sided-ish (a shot can be weak or strong but
    // never kicks down), horizontal variance is symmetric around the pattern.
    const verticalJitter = 1 + (rng.next() * 2 - 1) * r;
    const horizontalJitter = (rng.next() * 2 - 1) * r * 1.4;

    const scale = adsFactor;
    const pitch = profile.vertical * verticalJitter * scale * DEG;
    // A positive pattern value drifts the muzzle right, which is a rightward
    // view rotation: negative yaw, since the player module treats +yaw as left.
    const yaw = -(patternX + horizontalJitter) * profile.horizontal * scale * DEG;

    this.#pitch += pitch;
    this.#yaw += yaw;
    this.#sinceShot = 0;

    return { pitch, yaw, strength: verticalJitter };
  }

  /**
   * Recovers toward the pre-fire origin. Returns the correction to feed to
   * the player's view; the caller applies it so the weapon module remains the
   * only writer of view kick.
   */
  step(dt: number, profile: RecoilProfile, out: { pitch: number; yaw: number }): void {
    this.#sinceShot += dt;
    out.pitch = 0;
    out.yaw = 0;

    // Pattern memory is short: pausing for a third of a second re-centres the
    // player's mental model, so the next burst starts from the top again.
    if (this.#sinceShot > 0.34) this.#patternIndex = 0;
    if (this.#sinceShot < profile.recoveryDelay) return;

    const magnitude = Math.hypot(this.#pitch, this.#yaw);
    if (magnitude < 1e-6) {
      this.#pitch = 0;
      this.#yaw = 0;
      return;
    }

    // Ease the last fraction of a degree so the view settles rather than
    // stopping dead, which would read as a hitch at the end of every burst.
    const rate = profile.recovery * DEG * THREE.MathUtils.clamp(magnitude / (1.5 * DEG), 0.2, 1);
    const stepSize = Math.min(magnitude, rate * dt);
    const nx = this.#pitch / magnitude;
    const ny = this.#yaw / magnitude;

    out.pitch = -nx * stepSize;
    out.yaw = -ny * stepSize;
    this.#pitch += out.pitch;
    this.#yaw += out.yaw;
  }

  /** Total un-recovered kick, in radians. Used by the HUD and the rig. */
  get offset(): { pitch: number; yaw: number } {
    return { pitch: this.#pitch, yaw: this.#yaw };
  }

  reset(): void {
    this.#pitch = 0;
    this.#yaw = 0;
    this.#patternIndex = 0;
    this.#sinceShot = Infinity;
  }
}
