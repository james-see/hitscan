import * as THREE from 'three';

/**
 * Motion primitives for the viewmodel rig.
 *
 * Everything here is integrated with a fixed step so the weapon settles over
 * the same wall-clock duration regardless of frame rate. Springs are
 * parameterised by frequency and damping ratio rather than raw stiffness:
 * frequency is what you actually tune by feel ("this should settle in about a
 * tenth of a second"), and the damping ratio then reads as overshoot.
 */

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * ADS curve. Fast off the mark and decelerating hard into alignment, which
 * reads as the sights "snapping" into place while still costing the full
 * transition time — an ease-in-out feels sluggish at the start of the pull.
 */
export function easeOutQuint(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u * u * u;
}

/** Slight overshoot, used where a part seats mechanically (magazine, bolt). */
export function easeOutBack(t: number, overshoot = 1.7): number {
  const c = overshoot + 1;
  const u = t - 1;
  return 1 + c * u * u * u + overshoot * u * u;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Maps `x` from [a,b] into [0,1], clamped. */
export function remap01(x: number, a: number, b: number): number {
  return THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
}

/** Scalar damped harmonic oscillator, integrated semi-implicitly. */
export class Spring1 {
  value = 0;
  velocity = 0;
  target = 0;

  #omega: number;
  #zeta: number;

  constructor(frequencyHz: number, dampingRatio: number) {
    this.#omega = frequencyHz * Math.PI * 2;
    this.#zeta = dampingRatio;
  }

  configure(frequencyHz: number, dampingRatio: number): void {
    this.#omega = frequencyHz * Math.PI * 2;
    this.#zeta = dampingRatio;
  }

  step(dt: number): number {
    const k = this.#omega * this.#omega;
    const c = 2 * this.#zeta * this.#omega;
    const accel = (this.target - this.value) * k - this.velocity * c;
    // Semi-implicit Euler: stable at the stiffnesses used here (up to ~30Hz)
    // for a 120Hz step, and cheap enough to run several per frame.
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
    return this.value;
  }

  impulse(delta: number): void {
    this.velocity += delta;
  }

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
    this.target = value;
  }
}

/** Vector form of `Spring1`, sharing one set of coefficients. */
export class Spring3 {
  readonly value = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly target = new THREE.Vector3();

  #omega: number;
  #zeta: number;
  #accel = new THREE.Vector3();

  constructor(frequencyHz: number, dampingRatio: number) {
    this.#omega = frequencyHz * Math.PI * 2;
    this.#zeta = dampingRatio;
  }

  configure(frequencyHz: number, dampingRatio: number): void {
    this.#omega = frequencyHz * Math.PI * 2;
    this.#zeta = dampingRatio;
  }

  step(dt: number): THREE.Vector3 {
    const k = this.#omega * this.#omega;
    const c = 2 * this.#zeta * this.#omega;
    this.#accel.copy(this.target).sub(this.value).multiplyScalar(k);
    this.#accel.addScaledVector(this.velocity, -c);
    this.velocity.addScaledVector(this.#accel, dt);
    this.value.addScaledVector(this.velocity, dt);
    return this.value;
  }

  impulse(x: number, y: number, z: number): void {
    this.velocity.x += x;
    this.velocity.y += y;
    this.velocity.z += z;
  }

  reset(): void {
    this.value.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.target.set(0, 0, 0);
  }
}

/**
 * A rigid pose in the viewmodel camera's space. Rotations are stored as
 * Euler angles because every pose in the rig is authored by hand and radians
 * per axis are what a human can reason about; blending converts to
 * quaternions so large blends (hip to sprint) do not gimbal.
 */
export class Pose {
  readonly position = new THREE.Vector3();
  readonly rotation = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    px = 0,
    py = 0,
    pz = 0,
    rx = 0,
    ry = 0,
    rz = 0
  ) {
    this.position.set(px, py, pz);
    this.rotation.set(rx, ry, rz, 'YXZ');
  }

  copy(other: Pose): this {
    this.position.copy(other.position);
    this.rotation.copy(other.rotation);
    return this;
  }
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** Interpolates `out` from `a` to `b`, slerping the rotation. */
export function blendPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  out.position.lerpVectors(a.position, b.position, t);
  _qa.setFromEuler(a.rotation);
  _qb.setFromEuler(b.rotation);
  _qa.slerp(_qb, t);
  out.rotation.setFromQuaternion(_qa, 'YXZ');
  return out;
}
