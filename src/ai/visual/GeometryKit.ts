import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Primitive builders for the procedural soldier.
 *
 * Everything is built in bind-pose world space and merged, so the whole
 * character costs one draw call per material. Rounded forms throughout: a
 * silhouette assembled from hard-edged boxes reads as programmer art at any
 * distance, and the vertex cost of a 0.02m fillet is negligible next to the
 * shading cost of drawing the thing at all.
 */

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export interface Placement {
  position?: [number, number, number];
  /** Euler XYZ in radians. */
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

export function place(geometry: THREE.BufferGeometry, at: Placement): THREE.BufferGeometry {
  const position = at.position ?? [0, 0, 0];
  const rotation = at.rotation ?? [0, 0, 0];
  const scale = at.scale ?? [1, 1, 1];
  _q.setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2], 'XYZ'));
  _m.compose(
    _v.set(position[0], position[1], position[2]),
    _q,
    new THREE.Vector3(scale[0], scale[1], scale[2])
  );
  geometry.applyMatrix4(_m);
  return geometry;
}

export function box(
  width: number,
  height: number,
  depth: number,
  radius = 0.018,
  segments = 1
): THREE.BufferGeometry {
  const r = Math.max(0.001, Math.min(radius, width / 2.05, height / 2.05, depth / 2.05));
  return new RoundedBoxGeometry(width, height, depth, segments, r);
}

/**
 * A limb: a capsule whose radius tapers from bottom to top, built along +Y
 * from `bottom` to `top`. Real limbs are cones, not cylinders, and the taper
 * is most of what stops a procedural character reading as a mannequin.
 */
export function limb(
  bottomY: number,
  topY: number,
  bottomRadius: number,
  topRadius: number,
  x = 0,
  z = 0,
  radial = 10
): THREE.BufferGeometry {
  const length = Math.abs(topY - bottomY);
  const maxRadius = Math.max(bottomRadius, topRadius);
  const geometry = new THREE.CapsuleGeometry(maxRadius, length, 4, radial);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const half = length / 2;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    // Capsule caps overshoot the segment; clamp before mapping so the ends
    // taper with the shaft instead of ballooning.
    const t = THREE.MathUtils.clamp((y + half) / Math.max(length, 1e-4), 0, 1);
    const target = THREE.MathUtils.lerp(bottomRadius, topRadius, t) / maxRadius;
    position.setX(i, position.getX(i) * target);
    position.setZ(i, position.getZ(i) * target);
  }
  geometry.computeVertexNormals();
  return place(geometry, { position: [x, (bottomY + topY) / 2, z] });
}

/** Upper hemisphere, used for the helmet and shoulder pads. */
export function dome(
  radius: number,
  sweep = Math.PI * 0.6,
  radial = 18,
  rings = 10
): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, radial, rings, 0, Math.PI * 2, 0, sweep);
}

export function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radial = 10
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radial, 1);
}

/**
 * Flattens a primitive to a common layout so unrelated generators can be
 * merged: non-indexed, position and normal only. `RoundedBoxGeometry` is
 * already non-indexed while the lathe-family primitives are not, and
 * `mergeGeometries` refuses to reconcile the two.
 */
export function normalise(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
  }
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  return flat;
}

export function mergeAll(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geometries, false);
  if (!merged) throw new Error('[ai] geometry merge failed');
  for (const geometry of geometries) geometry.dispose();
  return merged;
}
