import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import { CAMERA } from './tuning.ts';

/** Per-frame view inputs, assembled by the player module. */
export interface ViewFrame {
  dt: number;
  /** Eye position before any camera effect is applied. */
  eye: THREE.Vector3;
  yaw: number;
  pitch: number;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Cumulative horizontal distance actually travelled, m. */
  travelled: number;
  /** Strafe input in [-1,1]; positive is right. */
  strafe: number;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;
  sliding: boolean;
  /** Mantle progress in [0,1]; 0 when not mantling. */
  mantle: number;
  baseFov: number;
  shakeScale: number;
  fovKickScale: number;
}

interface Spring {
  x: number;
  v: number;
}

/** Semi-implicit damped spring. Stable for the frame times we clamp to. */
function springStep(s: Spring, dt: number, omega: number, zeta: number): void {
  s.v += (-2 * zeta * omega * s.v - omega * omega * s.x) * dt;
  s.x += s.v * dt;
}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();

/**
 * Everything the camera does that the character controller does not: landing
 * punch, view roll, FOV kicks, head bob, damage flinch and shake.
 *
 * All of it is additive on top of the raw aim transform, and all of it is
 * scaled by `screenShakeScale` so a player who wants a locked camera can have
 * one. The rig is driven per frame, never per fixed step, so aim stays smooth
 * regardless of simulation rate.
 */
export class CameraRig {
  #landDip: Spring = { x: 0, v: 0 };
  #landPitch: Spring = { x: 0, v: 0 };
  #damagePitch: Spring = { x: 0, v: 0 };
  #damageYaw: Spring = { x: 0, v: 0 };
  #damageRoll: Spring = { x: 0, v: 0 };

  #trauma = 0;
  #roll = 0;
  #fovOffset = 0;
  #bobAmount = 0;
  #time = 0;

  /** Fixed noise phases, drawn once so shake is deterministic per seed. */
  readonly #phase: number[] = [];
  readonly #freq: number[] = [];

  constructor(rng: Rng) {
    for (let i = 0; i < 6; i++) {
      this.#phase.push(rng.range(0, Math.PI * 2));
      this.#freq.push(rng.range(13, 21) * Math.PI * 2);
    }
  }

  /** Impact punch on touchdown. `speed` is the vertical closing speed. */
  punchLanding(speed: number): void {
    const t = THREE.MathUtils.clamp(
      (speed - CAMERA.landMinSpeed) / (CAMERA.landMaxSpeed - CAMERA.landMinSpeed),
      0,
      1
    );
    if (t <= 0) return;
    // Kick the spring's velocity rather than its position: the camera
    // accelerates into the dip instead of teleporting to the bottom of it.
    const scale = t * t * 0.6 + t * 0.4;
    this.#landDip.v -= CAMERA.landMaxDip * CAMERA.landOmega * scale;
    this.#landPitch.v += CAMERA.landMaxPitch * CAMERA.landOmega * scale;
    this.#trauma = Math.min(1, this.#trauma + 0.25 * scale);
  }

  /**
   * Flinch away from an incoming hit. `lateral` is the signed sine of the
   * angle between the view and the shooter; positive means from the right.
   */
  punchDamage(lateral: number, forward: number, amount: number): void {
    const scale = THREE.MathUtils.clamp(amount / 35, 0.25, 1.6);
    this.#damagePitch.v += CAMERA.damagePitch * CAMERA.damageOmega * scale;
    this.#damageYaw.v += CAMERA.damageYaw * CAMERA.damageOmega * scale * lateral;
    // Hits from behind roll the view less; there is no direction to lean from.
    this.#damageRoll.v -=
      CAMERA.damageRoll * CAMERA.damageOmega * scale * lateral * (0.5 + 0.5 * forward);
    this.addTrauma(CAMERA.damageTrauma * scale);
  }

  addTrauma(amount: number): void {
    this.#trauma = THREE.MathUtils.clamp(this.#trauma + amount, 0, 1);
  }

  /** Sum of two detuned sines: cheap, smooth, and never repeats audibly. */
  #noise(channel: number, t: number): number {
    const a = channel * 2;
    const b = a + 1;
    return (
      Math.sin(t * this.#freq[a] + this.#phase[a]) * 0.62 +
      Math.sin(t * this.#freq[b] + this.#phase[b]) * 0.38
    );
  }

  /** Applies the whole rig to the camera for this frame. */
  apply(frame: ViewFrame, camera: THREE.PerspectiveCamera): void {
    // Clamp the integration step: a stalled frame must not let the springs
    // explode, and the effects are cosmetic enough that dropping time is free.
    const dt = Math.min(frame.dt, 1 / 30);
    this.#time += dt;
    const shake = Math.max(0, frame.shakeScale);

    springStep(this.#landDip, dt, CAMERA.landOmega, CAMERA.landZeta);
    springStep(this.#landPitch, dt, CAMERA.landOmega, CAMERA.landZeta);
    springStep(this.#damagePitch, dt, CAMERA.damageOmega, CAMERA.damageZeta);
    springStep(this.#damageYaw, dt, CAMERA.damageOmega, CAMERA.damageZeta);
    springStep(this.#damageRoll, dt, CAMERA.damageOmega, CAMERA.damageZeta);
    this.#trauma = Math.max(0, this.#trauma - CAMERA.traumaDecay * dt);

    // -- roll ---------------------------------------------------------------
    let targetRoll = -frame.strafe * CAMERA.strafeRoll;
    if (frame.sliding) targetRoll -= CAMERA.slideRoll;
    if (!frame.grounded) targetRoll *= 0.6;
    this.#roll = THREE.MathUtils.damp(this.#roll, targetRoll, CAMERA.strafeRollLambda, dt);

    // -- fov ----------------------------------------------------------------
    let targetFov = 0;
    if (frame.sliding) targetFov = CAMERA.slideFov;
    else if (frame.sprinting) {
      // Ramp with actual speed, so the kick tracks acceleration out of a stop
      // rather than snapping on with the sprint key.
      targetFov = CAMERA.sprintFov * THREE.MathUtils.clamp(frame.speed / 6.4, 0, 1);
    }
    targetFov *= Math.max(0, frame.fovKickScale);
    this.#fovOffset = THREE.MathUtils.damp(this.#fovOffset, targetFov, CAMERA.fovLambda, dt);

    // -- head bob -----------------------------------------------------------
    // Phase comes from distance travelled, not time, so the cadence stays
    // locked to the feet at every speed and stops dead against a wall.
    const stride = frame.crouching
      ? CAMERA.strideCrouch
      : frame.sprinting
        ? CAMERA.strideSprint
        : CAMERA.strideWalk;
    const stanceScale = frame.sliding
      ? 0
      : frame.crouching
        ? CAMERA.bobCrouchScale
        : frame.sprinting
          ? CAMERA.bobSprintScale
          : 1;
    const targetBob =
      frame.grounded && !frame.sliding
        ? THREE.MathUtils.clamp(frame.speed / 3.2, 0, 1) * stanceScale
        : 0;
    this.#bobAmount = THREE.MathUtils.damp(this.#bobAmount, targetBob, CAMERA.bobLambda, dt);

    const phase = (frame.travelled / stride) * Math.PI;
    const bob = this.#bobAmount * shake;
    const bobY = -Math.abs(Math.sin(phase)) * CAMERA.bobVertical * bob;
    const bobX = Math.sin(phase * 0.5) * CAMERA.bobLateral * bob;
    const bobRoll = Math.sin(phase * 0.5 + 0.4) * CAMERA.bobRoll * bob;

    // -- shake --------------------------------------------------------------
    const trauma = this.#trauma * this.#trauma * shake;
    const shakePitch = this.#noise(0, this.#time) * CAMERA.traumaMaxAngle * trauma;
    const shakeYaw = this.#noise(1, this.#time) * CAMERA.traumaMaxAngle * trauma;
    const shakeOffset = this.#noise(2, this.#time) * CAMERA.traumaMaxOffset * trauma;

    // -- mantle -------------------------------------------------------------
    // A single hump across the arc: the view dips and pitches down as the
    // player hauls up, which sells the effort without stealing the horizon.
    const mantleCurve = frame.mantle > 0 ? Math.sin(frame.mantle * Math.PI) : 0;

    const pitch =
      frame.pitch +
      (this.#landPitch.x + this.#damagePitch.x + shakePitch) * shake -
      mantleCurve * CAMERA.mantlePitch;
    const yaw = frame.yaw + (this.#damageYaw.x + shakeYaw) * shake;
    const roll = this.#roll + bobRoll + (this.#damageRoll.x * shake);

    camera.rotation.set(
      THREE.MathUtils.clamp(pitch, -Math.PI / 2, Math.PI / 2),
      yaw,
      roll,
      'YXZ'
    );

    // Offsets are applied in view space so bob and shake follow the aim.
    _forward.set(-Math.sin(frame.yaw), 0, -Math.cos(frame.yaw));
    _right.set(-_forward.z, 0, _forward.x);

    const dip = (this.#landDip.x * shake) - mantleCurve * CAMERA.mantleDip;
    camera.position.copy(frame.eye);
    camera.position.y += bobY + dip;
    camera.position.addScaledVector(_right, bobX + shakeOffset);

    // Compare against the camera rather than a cached value: the weapon module
    // also drives FOV for ADS, and it runs after this one. Whoever writes last
    // in a frame wins, which is the priority we want.
    const fov = frame.baseFov + this.#fovOffset;
    if (Math.abs(fov - camera.fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Cancels every transient effect. Used on respawn. */
  reset(): void {
    this.#landDip = { x: 0, v: 0 };
    this.#landPitch = { x: 0, v: 0 };
    this.#damagePitch = { x: 0, v: 0 };
    this.#damageYaw = { x: 0, v: 0 };
    this.#damageRoll = { x: 0, v: 0 };
    this.#trauma = 0;
    this.#roll = 0;
    this.#fovOffset = 0;
    this.#bobAmount = 0;
  }
}
