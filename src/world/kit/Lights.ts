import * as THREE from 'three';
import type { WorldBuilder } from './Builder.ts';
import type { PropLibrary } from './Props.ts';
import { PALETTE } from './Materials.ts';
import { localPoint } from './Pieces.ts';

export interface PracticalOptions {
  /** Position of the light itself, which is also the lens position. */
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  /** Wall-mounted lamps get a bracket arm pointing back along -rotY. */
  mount: 'wall' | 'ceiling' | 'none';
  rotY?: number;
  /** Radius of the emissive lens. */
  lens?: number;
}

/**
 * Places a practical light and the fixture that justifies it.
 *
 * A point light with no visible source reads as a bug; a lamp housing with a
 * glowing lens reads as a place someone works in. The lens is unlit geometry
 * on the shared emissive material, so every fixture in the level costs one
 * instance rather than one draw call.
 */
export function practical(
  b: WorldBuilder,
  props: PropLibrary,
  group: THREE.Group,
  o: PracticalOptions
): THREE.PointLight {
  const { x, y, z, color, intensity, distance, mount, rotY = 0, lens = 0.11 } = o;

  if (mount === 'wall') {
    // Bracket arm reaching out from the wall behind the lamp.
    const [ax, az] = localPoint(x, z, rotY, 0, -0.22);
    b.box({
      x: ax,
      y: y + 0.16,
      z: az,
      w: 0.06,
      h: 0.06,
      d: 0.5,
      rotY,
      material: 'metal',
      tint: PALETTE.steelRust,
      collide: false,
      chamfer: 0.014,
    });
    const [px, pz] = localPoint(x, z, rotY, 0, -0.46);
    b.box({
      x: px,
      y: y + 0.06,
      z: pz,
      w: 0.16,
      h: 0.3,
      d: 0.06,
      rotY,
      material: 'metal',
      tint: PALETTE.steelRust,
      collide: false,
      chamfer: 0.015,
    });
    // Conical shade above the lens.
    b.box({
      x,
      y: y + 0.1,
      z,
      w: 0.34,
      h: 0.1,
      d: 0.34,
      rotY,
      material: 'metal',
      tint: PALETTE.steelGreen,
      collide: false,
      chamfer: 0.06,
    });
  } else if (mount === 'ceiling') {
    b.box({
      x,
      y: y + 0.1,
      z,
      w: 0.05,
      h: 0.6,
      d: 0.05,
      rotY,
      material: 'metal',
      tint: PALETTE.steelRust,
      collide: false,
      chamfer: 0.012,
    });
    b.box({
      x,
      y: y + 0.04,
      z,
      w: 0.42,
      h: 0.12,
      d: 0.42,
      rotY,
      material: 'metal',
      tint: PALETTE.steelGreen,
      collide: false,
      chamfer: 0.07,
    });
  }

  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion(),
    new THREE.Vector3(lens, lens * 0.7, lens)
  );
  // Pushed above 1 so the lens clips to white and feeds bloom rather than
  // reading as a flat coloured ball.
  props.place('lampLens', matrix, new THREE.Color(color).multiplyScalar(2.4));

  const light = new THREE.PointLight(color, intensity, distance, 2);
  light.position.set(x, y, z);
  light.castShadow = false;
  group.add(light);
  return light;
}
