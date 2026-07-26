import * as THREE from 'three';

/**
 * Analytic two-bone IK.
 *
 * Limbs in the bind pose run down local -Y, so a bone's orientation is fully
 * described by the direction its segment points plus the axis it bends
 * around. Solving for both segment directions directly — rather than for the
 * joint angles — avoids the sign and gimbal problems that make hand-rolled
 * IK flip a knee inside out once per second.
 */

const _root = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _segA = new THREE.Vector3();
const _segB = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _parentQuat = new THREE.Quaternion();
const _worldA = new THREE.Quaternion();
const _worldB = new THREE.Quaternion();
const _fallbackAxis = new THREE.Vector3(1, 0, 0);

/** Orientation whose local -Y points along `direction` and +X along `bend`. */
export function orientLimb(
  direction: THREE.Vector3,
  bend: THREE.Vector3,
  out: THREE.Quaternion
): THREE.Quaternion {
  _y.copy(direction).normalize().negate();
  _x.copy(bend).addScaledVector(_y, -bend.dot(_y));
  if (_x.lengthSq() < 1e-8) {
    _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
    if (_x.lengthSq() < 1e-8) _x.set(0, 0, 1).addScaledVector(_y, -_y.z);
  }
  _x.normalize();
  _z.crossVectors(_x, _y);
  _basis.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_basis);
}

/**
 * Places `end` at `target` by rotating `upper` and `lower`.
 *
 * `pole` is a world-space hint for where the joint should point; for a knee
 * that is forward of the leg, for an elbow it is down and behind.
 */
export function solveTwoBone(
  upper: THREE.Bone,
  lower: THREE.Bone,
  lengthUpper: number,
  lengthLower: number,
  target: THREE.Vector3,
  pole: THREE.Vector3
): void {
  upper.getWorldPosition(_root);
  _toTarget.subVectors(target, _root);
  const reach = lengthUpper + lengthLower;
  let distance = _toTarget.length();
  if (distance < 1e-5) {
    _toTarget.set(0, -1, 0);
    distance = 1;
  }
  // Never let the limb reach its exact full length: at full extension the
  // bend axis is undefined and the joint pops.
  const clamped = THREE.MathUtils.clamp(distance, Math.abs(lengthUpper - lengthLower) + 1e-3, reach * 0.999);
  _dir.copy(_toTarget).multiplyScalar(1 / distance);

  _pole.subVectors(pole, _root);
  _axis.crossVectors(_dir, _pole);
  if (_axis.lengthSq() < 1e-8) {
    _axis.crossVectors(_dir, _fallbackAxis);
    if (_axis.lengthSq() < 1e-8) _axis.set(0, 0, 1);
  }
  _axis.normalize();

  const cosA = THREE.MathUtils.clamp(
    (lengthUpper * lengthUpper + clamped * clamped - lengthLower * lengthLower) /
      (2 * lengthUpper * clamped),
    -1,
    1
  );
  const angle = Math.acos(cosA);

  _segA.copy(_dir).applyAxisAngle(_axis, angle).normalize();
  _knee.copy(_root).addScaledVector(_segA, lengthUpper);
  _segB.copy(_dir).multiplyScalar(clamped).add(_root).sub(_knee);
  if (_segB.lengthSq() < 1e-8) _segB.copy(_segA);
  _segB.normalize();

  orientLimb(_segA, _axis, _worldA);
  orientLimb(_segB, _axis, _worldB);

  if (upper.parent) {
    upper.parent.getWorldQuaternion(_parentQuat);
    upper.quaternion.copy(_parentQuat.invert()).multiply(_worldA);
  } else {
    upper.quaternion.copy(_worldA);
  }
  lower.quaternion.copy(_worldA.invert()).multiply(_worldB);

  upper.updateMatrixWorld(true);
}

/** Sets a bone's local rotation so that its world rotation is `world`. */
export function setWorldQuaternion(bone: THREE.Bone, world: THREE.Quaternion): void {
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_parentQuat);
    bone.quaternion.copy(_parentQuat.invert()).multiply(world);
  } else {
    bone.quaternion.copy(world);
  }
}
