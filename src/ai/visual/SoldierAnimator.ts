import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import { LIMB, resetPose, type BoneName, type SoldierAssets, type SoldierInstance } from './SoldierRig.ts';
import { orientLimb, setWorldQuaternion, solveTwoBone } from './Ik.ts';

/**
 * Procedural locomotion and combat posing.
 *
 * There are no authored clips, so weight has to come from the simulation
 * itself. The two things that buy almost all of it:
 *
 *  - Feet are planted in world space. A foot in its stance phase does not
 *    move, full stop, no matter what the body does. Everything else — hip
 *    drop, stride length, pivoting — is derived from that constraint rather
 *    than layered on top of it, so there is no configuration in which the
 *    feet can skate.
 *  - The hips are pulled down to whatever the legs can actually reach. Long
 *    strides therefore lower the body automatically, which is the bob that
 *    real gait has and a sine wave does not.
 */

export interface PoseInput {
  /** Ground contact position of the character. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Body yaw in radians; 0 faces -Z. */
  facing: number;
  /** World point the weapon is pointed at. */
  aimPoint: THREE.Vector3;
  /** 0 = weapon carried at low ready, 1 = shouldered and on target. */
  aimBlend: number;
  crouch: number;
  grounded: boolean;
  groundAt: (x: number, z: number, fallback: number) => number;
  /**
   * Exact surface height, queried only at the instant a foot plants. The nav
   * grid's filtered height is smooth enough for the body but blends across
   * kerb edges, which hovers a boot centimetres above whichever side it landed
   * on. Once per step is cheap enough to pay for a real answer.
   */
  surfaceAt: (x: number, z: number, fallback: number) => number;
}

/**
 * Stance shortens as the gait breaks from a walk into a run: a walk always
 * has a foot down, a run buys its longer steps with a flight phase instead.
 */
const STANCE_WALK = 0.64;
const STANCE_RUN = 0.34;
const LEG_REACH = LIMB.thigh + LIMB.shin;
/**
 * Half the distance a planted foot travels relative to the hip during stance.
 * Hard-capped well inside leg reach: a step longer than the leg can span
 * leaves the IK target unsolvable and the foot visibly hanging in the air.
 */
const HALF_STRIDE_MIN = 0.26;
const HALF_STRIDE_MAX = 0.38;
/** Touchdown sits slightly less far ahead than toe-off does behind, as in real gait. */
const LEAD_BIAS = 0.9;
const ARM_REACH = LIMB.upperArm + LIMB.forearm;
const STAND_HIP = 0.885;
const CROUCH_HIP = 0.6;
const MAX_TORSO_TWIST = 1.0;

interface Foot {
  /** Sole position while planted. Frozen for the whole stance phase. */
  plant: THREE.Vector3;
  swingFrom: THREE.Vector3;
  current: THREE.Vector3;
  yaw: number;
  planted: boolean;
  pitch: number;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _chestPos = new THREE.Vector3();
const _chestQuat = new THREE.Quaternion();
const _aimDir = new THREE.Vector3();
const _weaponQuat = new THREE.Quaternion();
const _weaponPos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _matrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _lookTarget = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const WRIST_ALIGN = new THREE.Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);

/** Local-space limp targets used by the death blend, in radians. */
const DEATH_POSE: Partial<Record<BoneName, [number, number, number]>> = {
  spine: [0.18, 0, 0],
  chest: [0.24, 0, 0],
  neck: [0.3, 0, 0],
  head: [0.22, 0, 0],
  clavicleR: [0, 0, -0.25],
  armR: [0.25, 0, -0.7],
  forearmR: [0.9, 0, 0],
  clavicleL: [0, 0, 0.25],
  armL: [0.25, 0, 0.7],
  forearmL: [0.9, 0, 0],
  thighR: [-0.5, 0, -0.16],
  shinR: [0.95, 0, 0],
  thighL: [-0.3, 0, 0.2],
  shinL: [1.25, 0, 0],
  footR: [0.35, 0, 0],
  footL: [0.35, 0, 0],
};

export class SoldierAnimator {
  readonly instance: SoldierInstance;
  readonly #assets: SoldierAssets;
  readonly #rng: Rng;

  #phase: number;
  #feet: [Foot, Foot];
  #hipY = STAND_HIP;
  #lastFacing = 0;
  #yawRate = 0;
  #leanPitch = 0;
  #leanRoll = 0;
  #twist = 0;
  #aimPitch = 0;
  #breathe: number;
  #speedSmoothed = 0;

  #recoil = 0;
  #recoilVelocity = 0;
  #flinchPitch = 0;
  #flinchPitchVelocity = 0;
  #flinchRoll = 0;
  #flinchRollVelocity = 0;

  #deathTime = -1;
  #deathBlend = 0;
  #deathPitch = 0;
  #deathRoll = 0;
  #deathYaw = 0;
  #deathSlide = new THREE.Vector3();
  #deathHipDrop = 0.24;
  #settled = false;

  /** Muzzle position in world space, refreshed every pose. */
  readonly muzzle = new THREE.Vector3();
  readonly muzzleDirection = new THREE.Vector3(0, 0, -1);

  constructor(instance: SoldierInstance, assets: SoldierAssets, rng: Rng) {
    this.instance = instance;
    this.#assets = assets;
    this.#rng = rng;
    this.#phase = rng.next();
    this.#breathe = rng.range(0, Math.PI * 2);
    const origin = instance.root.position;
    this.#feet = [
      {
        plant: new THREE.Vector3(origin.x + LIMB.hipHalfWidth, origin.y, origin.z),
        swingFrom: new THREE.Vector3(),
        current: new THREE.Vector3(origin.x + LIMB.hipHalfWidth, origin.y, origin.z),
        yaw: 0,
        planted: true,
        pitch: 0,
      },
      {
        plant: new THREE.Vector3(origin.x - LIMB.hipHalfWidth, origin.y, origin.z),
        swingFrom: new THREE.Vector3(),
        current: new THREE.Vector3(origin.x - LIMB.hipHalfWidth, origin.y, origin.z),
        yaw: 0,
        planted: true,
        pitch: 0,
      },
    ];
  }

  /** Re-seats the character after a teleport or respawn. */
  reset(position: THREE.Vector3, facing: number): void {
    this.#deathTime = -1;
    this.#deathBlend = 0;
    this.#settled = false;
    this.#recoil = 0;
    this.#recoilVelocity = 0;
    this.#flinchPitch = 0;
    this.#flinchRoll = 0;
    this.#hipY = position.y + STAND_HIP;
    this.#lastFacing = facing;
    this.#phase = this.#rng.next();
    const sin = Math.sin(facing);
    const cos = Math.cos(facing);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const foot = this.#feet[i] as Foot;
      foot.plant.set(
        position.x + cos * side * LIMB.hipHalfWidth,
        position.y,
        position.z - sin * side * LIMB.hipHalfWidth
      );
      foot.current.copy(foot.plant);
      foot.planted = true;
      foot.yaw = facing;
      foot.pitch = 0;
    }
    resetPose(this.instance.bones);
  }

  notifyFire(): void {
    this.#recoilVelocity += 7.5;
  }

  notifyHit(direction: THREE.Vector3, severity: number): void {
    const scale = THREE.MathUtils.clamp(severity, 0.15, 1.4);
    _v1.copy(direction).setY(0).normalize();
    const facing = this.instance.root.rotation.y;
    const forward = -Math.sin(facing) * _v1.x - Math.cos(facing) * _v1.z;
    const lateral = Math.cos(facing) * _v1.x - Math.sin(facing) * _v1.z;
    this.#flinchPitchVelocity += forward * 9 * scale;
    this.#flinchRollVelocity += lateral * 7 * scale;
  }

  notifyDeath(direction: THREE.Vector3): void {
    if (this.#deathTime >= 0) return;
    this.#deathTime = 0;
    _v1.copy(direction).setY(0);
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, 1);
    _v1.normalize();
    const facing = this.instance.root.rotation.y;
    const forward = -Math.sin(facing) * _v1.x - Math.cos(facing) * _v1.z;
    const lateral = Math.cos(facing) * _v1.x - Math.sin(facing) * _v1.z;
    // Fall away from the round. Rolling onto the back reads as a solid hit;
    // pitching face-first reads as a stumble, so bias toward the former.
    this.#deathPitch = THREE.MathUtils.clamp(forward * 1.5, -1.5, 1.15);
    this.#deathRoll = THREE.MathUtils.clamp(lateral * 1.1, -1.1, 1.1);
    this.#deathYaw = this.#rng.range(-0.45, 0.45);
    this.#deathSlide.copy(_v1).multiplyScalar(this.#rng.range(0.18, 0.42));
    this.#deathHipDrop = this.#rng.range(0.2, 0.3);
  }

  get dead(): boolean {
    return this.#deathTime >= 0;
  }

  /** True once the death animation has come to rest. */
  get settled(): boolean {
    return this.#settled;
  }

  update(dt: number, input: PoseInput): void {
    const bones = this.instance.bones;
    const root = this.instance.root;
    const clampedDt = Math.min(dt, 1 / 20);

    this.#integrateSprings(clampedDt);

    if (this.#deathTime >= 0) {
      this.#deathTime += clampedDt;
      this.#deathBlend = Math.min(1, this.#deathBlend + clampedDt * 5.5);
      if (this.#deathTime > 1.6) this.#settled = true;
    }

    const speed = Math.hypot(input.velocity.x, input.velocity.z);
    this.#speedSmoothed = THREE.MathUtils.damp(this.#speedSmoothed, speed, 9, clampedDt);

    let yawDelta = input.facing - this.#lastFacing;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    this.#yawRate = clampedDt > 1e-5 ? yawDelta / clampedDt : 0;
    this.#lastFacing = input.facing;

    root.position.copy(input.position);
    root.rotation.set(0, input.facing, 0);
    root.updateMatrixWorld(true);

    _forward.set(-Math.sin(input.facing), 0, -Math.cos(input.facing));
    _right.set(-_forward.z, 0, _forward.x);

    if (this.#deathBlend < 1) {
      this.#updateGait(clampedDt, input, speed);
    }
    this.#poseSpine(clampedDt, input);
    root.updateMatrixWorld(true);

    this.#poseWeapon(input);
    this.#poseArms(input);

    if (this.#deathBlend < 1) this.#poseLegs(input);
    if (this.#deathBlend > 0) this.#applyDeathPose(bones);

    root.updateMatrixWorld(true);
    this.#refreshMuzzle();
  }

  #integrateSprings(dt: number): void {
    // Critically damped: recoil that oscillates reads as a spring toy.
    const spring = (value: number, velocity: number, stiffness: number, damping: number): [number, number] => {
      const acceleration = -stiffness * value - damping * velocity;
      const nextVelocity = velocity + acceleration * dt;
      return [value + nextVelocity * dt, nextVelocity];
    };
    [this.#recoil, this.#recoilVelocity] = spring(this.#recoil, this.#recoilVelocity, 320, 26);
    [this.#flinchPitch, this.#flinchPitchVelocity] = spring(
      this.#flinchPitch,
      this.#flinchPitchVelocity,
      110,
      13
    );
    [this.#flinchRoll, this.#flinchRollVelocity] = spring(
      this.#flinchRoll,
      this.#flinchRollVelocity,
      110,
      13
    );
  }

  // -- locomotion -----------------------------------------------------------

  #updateGait(dt: number, input: PoseInput, speed: number): void {
    const stanceFraction = THREE.MathUtils.lerp(
      STANCE_WALK,
      STANCE_RUN,
      THREE.MathUtils.smoothstep(speed, 1.4, 4.2)
    );
    const halfStride = THREE.MathUtils.clamp(
      HALF_STRIDE_MIN + speed * 0.05,
      HALF_STRIDE_MIN,
      HALF_STRIDE_MAX
    );
    // Cadence is a consequence of the stride, not a free parameter: a planted
    // foot must travel exactly one stride relative to the hip over its stance,
    // so the body has to cover that same distance in that time or the foot
    // either skates or is dragged out past the end of the leg.
    const strideCycles = speed > 0.05 ? (speed * stanceFraction) / (2 * halfStride) : 0;
    // Pivoting on the spot still costs steps; without this term a bot turning
    // 180 degrees rotates its planted feet through the floor.
    const turnSteps = Math.min(Math.abs(this.#yawRate) * 0.13, 1.4);
    const cyclesPerSecond = strideCycles + turnSteps;
    const moving = speed > 0.12 || Math.abs(this.#yawRate) > 0.55;

    if (moving) {
      this.#phase = (this.#phase + cyclesPerSecond * dt) % 1;
    } else {
      // Ease to feet-together rather than stopping mid-stride.
      const settle = this.#phase < 0.25 || this.#phase > 0.75 ? 0 : 0.5;
      let delta = settle - this.#phase;
      if (delta > 0.5) delta -= 1;
      if (delta < -0.5) delta += 1;
      this.#phase = (this.#phase + delta * Math.min(1, dt * 6) + 1) % 1;
    }

    const crouchScale = 1 - input.crouch * 0.35;
    const lift = (0.055 + speed * 0.028) * crouchScale;

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const foot = this.#feet[i] as Foot;
      const phase = (this.#phase + (i === 0 ? 0 : 0.5)) % 1;

      // Where this foot wants to land, given where the body is heading.
      const lead = halfStride * LEAD_BIAS;
      _v1.copy(input.position).addScaledVector(
        _right,
        side * LIMB.hipHalfWidth * (1 + input.crouch * 0.28)
      );
      if (speed > 0.2) {
        _v2.set(input.velocity.x, 0, input.velocity.z).multiplyScalar(lead / speed);
        _v1.add(_v2);
      } else {
        _v1.addScaledVector(_forward, lead);
      }
      _v1.y = input.groundAt(_v1.x, _v1.z, input.position.y);

      if (phase < stanceFraction) {
        if (!foot.planted) {
          foot.planted = true;
          foot.plant.copy(foot.current);
          foot.plant.y = input.surfaceAt(foot.plant.x, foot.plant.z, foot.plant.y);
        }
        foot.current.copy(foot.plant);
        foot.pitch = THREE.MathUtils.damp(foot.pitch, 0, 14, dt);
      } else {
        if (foot.planted) {
          foot.planted = false;
          foot.swingFrom.copy(foot.plant);
        }
        const swing = (phase - stanceFraction) / (1 - stanceFraction);
        // Ease-in-out horizontally so the foot accelerates off the ground and
        // decelerates into the plant, instead of gliding at constant speed.
        const eased = swing * swing * (3 - 2 * swing);
        foot.current.lerpVectors(foot.swingFrom, _v1, eased);
        foot.current.y += Math.sin(Math.PI * swing) * lift;
        foot.plant.copy(_v1);
        // Toe-off then heel-strike.
        foot.pitch = Math.sin(swing * Math.PI * 2) * -0.35;
      }
      foot.yaw = input.facing;
    }

    // Hips: nominal height, then pulled down to whatever the legs can reach.
    const bob = Math.cos(this.#phase * Math.PI * 4) * 0.016 * Math.min(1, speed / 2.5);
    this.#breathe += dt * 1.6;
    const idle = Math.sin(this.#breathe) * 0.006 * (1 - Math.min(1, speed));
    let desired =
      input.position.y +
      THREE.MathUtils.lerp(STAND_HIP, CROUCH_HIP, input.crouch) +
      bob +
      idle;

    // A planted foot fixes the end of the leg, so the hip can only be as high
    // as the remaining vertical span of a straight leg once its fore-aft
    // excursion is spent. This is what produces the drop through double
    // support: the bob falls out of the constraint rather than a sine wave.
    const span = LEG_REACH * 0.985;
    let ceiling = Infinity;
    for (let i = 0; i < 2; i++) {
      const foot = this.#feet[i] as Foot;
      if (!foot.planted) continue;
      const along =
        (input.position.x - foot.current.x) * _forward.x +
        (input.position.z - foot.current.z) * _forward.z;
      const vertical = Math.sqrt(Math.max(0, span * span - along * along));
      ceiling = Math.min(ceiling, foot.current.y + LIMB.ankleHeight + vertical);
    }
    if (ceiling < desired) desired = ceiling;
    this.#hipY = THREE.MathUtils.damp(this.#hipY, desired, 22, dt);
    // Damping may only ever hold the hips *down*. Letting it lag above the
    // reach limit is what lifts a planted foot off the floor for a few frames,
    // and a boot hovering over concrete is the one artefact nobody forgives.
    if (this.#hipY > ceiling) this.#hipY = ceiling;

    const targetLean = THREE.MathUtils.clamp(this.#speedSmoothed * 0.026, 0, 0.17);
    this.#leanPitch = THREE.MathUtils.damp(this.#leanPitch, targetLean, 6, dt);
    const targetRoll = THREE.MathUtils.clamp(-this.#yawRate * 0.035, -0.12, 0.12);
    this.#leanRoll = THREE.MathUtils.damp(this.#leanRoll, targetRoll, 6, dt);
  }

  #poseSpine(dt: number, input: PoseInput): void {
    const bones = this.instance.bones;

    _v1.subVectors(input.aimPoint, input.position);
    const planar = Math.hypot(_v1.x, _v1.z) || 1e-4;
    const aimYaw = Math.atan2(-_v1.x, -_v1.z);
    const desiredPitch = -Math.atan2(_v1.y - (this.#hipY - input.position.y) - 0.45, planar);

    let twist = aimYaw - input.facing;
    while (twist > Math.PI) twist -= Math.PI * 2;
    while (twist < -Math.PI) twist += Math.PI * 2;
    twist = THREE.MathUtils.clamp(twist, -MAX_TORSO_TWIST, MAX_TORSO_TWIST);
    this.#twist = THREE.MathUtils.damp(this.#twist, twist, 12, dt);
    this.#aimPitch = THREE.MathUtils.damp(
      this.#aimPitch,
      THREE.MathUtils.clamp(desiredPitch, -0.85, 0.7),
      12,
      dt
    );

    const crouch = input.crouch;
    const hipLocalY = this.#hipY - input.position.y;

    bones.pelvis.position.set(0, hipLocalY, crouch * -0.03);
    _euler.set(
      this.#leanPitch * 0.45 + crouch * 0.22 + this.#flinchPitch * 0.25,
      this.#twist * 0.18,
      this.#leanRoll * 0.5 + this.#flinchRoll * 0.2,
      'YXZ'
    );
    bones.pelvis.quaternion.setFromEuler(_euler);

    _euler.set(
      this.#leanPitch * 0.35 + this.#aimPitch * 0.12 + this.#flinchPitch * 0.4 + crouch * 0.14,
      this.#twist * 0.3,
      this.#flinchRoll * 0.35,
      'YXZ'
    );
    bones.spine.quaternion.setFromEuler(_euler);

    _euler.set(
      this.#aimPitch * 0.42 + this.#flinchPitch * 0.45 - this.#recoil * 0.035 + crouch * 0.1,
      this.#twist * 0.36,
      this.#flinchRoll * 0.45,
      'YXZ'
    );
    bones.chest.quaternion.setFromEuler(_euler);

    _euler.set(this.#aimPitch * 0.18 + this.#flinchPitch * 0.3, this.#twist * 0.08, 0, 'YXZ');
    bones.neck.quaternion.setFromEuler(_euler);

    // The head leads: eyes reach the target before the body finishes turning.
    _euler.set(
      this.#aimPitch * 0.34 + this.#flinchPitch * 0.5,
      this.#twist * 0.24,
      this.#flinchRoll * 0.4,
      'YXZ'
    );
    bones.head.quaternion.setFromEuler(_euler);
  }

  // -- weapon and arms ------------------------------------------------------

  #poseWeapon(input: PoseInput): void {
    const bones = this.instance.bones;
    bones.chest.getWorldPosition(_chestPos);
    bones.chest.getWorldQuaternion(_chestQuat);

    _aimDir.subVectors(input.aimPoint, _chestPos);
    if (_aimDir.lengthSq() < 1e-6) _aimDir.set(0, 0, -1);
    _aimDir.normalize();

    const blend = THREE.MathUtils.clamp(input.aimBlend, 0, 1);

    // Shoulder pocket, in chest space: high and to the right when shouldered.
    // Low ready carries it outboard and forward of the hip instead — tucked
    // against the centreline the barrel passes straight through the thigh.
    _v1.set(
      THREE.MathUtils.lerp(0.2, 0.14, blend),
      THREE.MathUtils.lerp(0.04, 0.13, blend),
      THREE.MathUtils.lerp(-0.11, -0.02, blend)
    )
      .applyQuaternion(_chestQuat)
      .add(_chestPos);
    // Low ready: muzzle down and inboard, weapon tucked. Sells "not shooting"
    // far better than simply leaving the aim pose on.
    _quat.setFromAxisAngle(_right, -0.48);
    _v3.copy(_aimDir).applyQuaternion(_quat);
    _quat.setFromAxisAngle(UP, 0.22);
    _v3.applyQuaternion(_quat).normalize();
    _v2.lerpVectors(_v3, _aimDir, blend).normalize();
    // A near-vertical barrel makes the look-at basis degenerate.
    if (Math.abs(_v2.y) > 0.94) {
      _v2.y = Math.sign(_v2.y) * 0.94;
      _v2.normalize();
    }

    _lookTarget.copy(_v1).add(_v2);
    _matrix.lookAt(_v1, _lookTarget, UP);
    _weaponQuat.setFromRotationMatrix(_matrix);

    const recoilPush = this.#recoil * 0.03;
    _weaponPos
      .copy(_v1)
      .addScaledVector(_v2, THREE.MathUtils.lerp(0.2, 0.34, blend) - recoilPush)
      .addScaledVector(UP, THREE.MathUtils.lerp(-0.05, -0.02, blend));

    _quat.setFromAxisAngle(_right, this.#recoil * 0.06);
    _weaponQuat.premultiply(_quat);

    const weapon = this.instance.weapon;
    _matrix.compose(_weaponPos, _weaponQuat, _scale);
    // The weapon lives under the bot's root group, so strip the group's
    // transform back out of the world matrix we just built.
    _inverse.copy(this.instance.root.matrixWorld).invert();
    _matrix.premultiply(_inverse);
    weapon.matrix.copy(_matrix);
    weapon.matrix.decompose(weapon.position, weapon.quaternion, weapon.scale);
    weapon.matrixWorldNeedsUpdate = true;
  }

  #poseArms(input: PoseInput): void {
    const bones = this.instance.bones;
    const weapon = this.instance.weapon;
    weapon.updateMatrixWorld(true);

    const blend = THREE.MathUtils.clamp(input.aimBlend, 0, 1);

    for (const side of [1, -1] as const) {
      const suffix = side > 0 ? 'R' : 'L';
      const upper = bones[`arm${suffix}` as BoneName];
      const lower = bones[`forearm${suffix}` as BoneName];
      const hand = bones[`hand${suffix}` as BoneName];
      const grip = side > 0 ? this.#assets.gripRight : this.#assets.gripLeft;

      _target.copy(grip).applyMatrix4(weapon.matrixWorld);

      upper.getWorldPosition(_v1);
      const distance = _v1.distanceTo(_target);
      if (distance > ARM_REACH * 0.985) {
        _v2.subVectors(_target, _v1).multiplyScalar((ARM_REACH * 0.985) / distance);
        _target.copy(_v1).add(_v2);
      }

      // Elbows down and out; the support elbow tucks lower when shouldered.
      // Driving them well below the weapon keeps both forearms under the
      // barrel line instead of collinear with it.
      _pole
        .copy(_v1)
        .addScaledVector(_right, side * (0.42 - blend * 0.14))
        .addScaledVector(UP, -0.98)
        .addScaledVector(_forward, side > 0 ? -0.18 : -0.34);

      solveTwoBone(upper, lower, LIMB.upperArm, LIMB.forearm, _target, _pole);

      // Wrist follows the weapon so the glove does not read as broken.
      weapon.getWorldQuaternion(_quat);
      _quat.multiply(WRIST_ALIGN);
      setWorldQuaternion(hand, _quat);
    }
  }

  #poseLegs(input: PoseInput): void {
    const bones = this.instance.bones;

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const suffix = side > 0 ? 'R' : 'L';
      const foot = this.#feet[i] as Foot;
      const thigh = bones[`thigh${suffix}` as BoneName];
      const shin = bones[`shin${suffix}` as BoneName];
      const footBone = bones[`foot${suffix}` as BoneName];

      thigh.getWorldPosition(_hip);
      _target.set(foot.current.x, foot.current.y + LIMB.ankleHeight, foot.current.z);

      const distance = _hip.distanceTo(_target);
      if (distance > LEG_REACH * 0.985) {
        _v2.subVectors(_target, _hip).multiplyScalar((LEG_REACH * 0.985) / distance);
        _target.copy(_hip).add(_v2);
      }

      // Knees track the direction of travel, and splay a little when crouched.
      _pole
        .copy(_hip)
        .addScaledVector(_forward, 1.2)
        .addScaledVector(_right, side * (0.15 + input.crouch * 0.45))
        .addScaledVector(UP, -0.25);

      solveTwoBone(thigh, shin, LIMB.thigh, LIMB.shin, _target, _pole);

      _euler.set(foot.pitch, foot.yaw, 0, 'YXZ');
      _quat.setFromEuler(_euler);
      setWorldQuaternion(footBone, _quat);
    }
  }

  #applyDeathPose(bones: Record<BoneName, THREE.Bone>): void {
    const t = THREE.MathUtils.clamp(this.#deathTime / 1.05, 0, 1);
    // Fast collapse, slow settle. A linear fall reads as a puppet dropping.
    const fall = 1 - Math.pow(1 - t, 2.4);
    const blend = this.#deathBlend;
    const bones_ = bones;

    const hipTarget = this.#deathHipDrop;
    const current = bones_.pelvis.position;
    current.y = THREE.MathUtils.lerp(current.y, hipTarget, blend * fall);
    current.x = THREE.MathUtils.lerp(current.x, this.#deathSlide.x * 0.6, blend * fall);
    current.z = THREE.MathUtils.lerp(current.z, this.#deathSlide.z * 0.6, blend * fall);

    // A little residual motion after the body lands stops the pose looking
    // like a statue that was placed there.
    const twitch = Math.exp(-this.#deathTime * 3.2) * Math.sin(this.#deathTime * 21) * 0.05;

    _euler.set(
      this.#deathPitch * fall + twitch,
      this.#deathYaw * fall,
      this.#deathRoll * fall + twitch * 0.4,
      'YXZ'
    );
    _quat.setFromEuler(_euler);
    bones_.pelvis.quaternion.slerp(_quat, blend * fall);

    for (const name of Object.keys(DEATH_POSE) as BoneName[]) {
      const angles = DEATH_POSE[name];
      if (!angles) continue;
      const bone = bones_[name];
      _euler.set(angles[0] * fall, angles[1] * fall, angles[2] * fall, 'XYZ');
      _quat.setFromEuler(_euler);
      bone.quaternion.slerp(_quat, blend * Math.min(1, fall * 1.3));
    }
  }

  #refreshMuzzle(): void {
    const weapon = this.instance.weapon;
    weapon.updateMatrixWorld(true);
    this.muzzle.copy(this.#assets.muzzle).applyMatrix4(weapon.matrixWorld);
    this.muzzleDirection.set(0, 0, -1).applyQuaternion(weapon.getWorldQuaternion(_quat)).normalize();
  }
}
