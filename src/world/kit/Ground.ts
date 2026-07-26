import * as THREE from 'three';
import { fbm, valueNoise } from './Geometry.ts';
import type { KitMaterials } from './Materials.ts';

export interface GroundPath {
  /** Polyline in world x/z that traffic has worn smooth. */
  points: Array<[number, number]>;
  width: number;
  /** Positive brightens (polished), negative darkens (mud). */
  shift: number;
}

export interface GroundPatch {
  x: number;
  z: number;
  radius: number;
  tint: THREE.Color;
  strength: number;
}

export interface GroundOptions {
  size: number;
  segments: number;
  paths?: GroundPath[];
  patches?: GroundPatch[];
  /** Rectangles under buildings, darkened as contact dirt. */
  footprints?: Array<{ x: number; z: number; w: number; d: number }>;
}

/** Warm dust, so the floor does not go violet where only sky light reaches it. */
const BASE = new THREE.Color(1.0, 0.9, 0.75);

/**
 * The courtyard floor.
 *
 * A single 4 m-tile concrete texture stretched over ninety metres is the most
 * obvious repetition in the scene, so the tiling is deliberately broken with
 * low-frequency vertex colour: fbm mottling, worn traffic lanes, damp shade
 * under the buildings and a handful of stained patches. All of it is free —
 * the attribute is already there for the rest of the kit.
 */
export function buildGround(materials: KitMaterials, options: GroundOptions): THREE.Mesh {
  const { size, segments, paths = [], patches = [], footprints = [] } = options;

  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.getAttribute('position');
  const count = position.count;
  const uv = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  const tile = materials.tileScale.ground;
  const colour = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);

    // Gentle undulation, kept under the character controller's step tolerance
    // so the flat collider underneath is never noticed.
    const relief = (fbm(x * 0.06, z * 0.06, 3) - 0.5) * 0.07;
    position.setY(i, relief);

    uv[i * 2] = x / tile;
    uv[i * 2 + 1] = z / tile;

    // Held near a 0.45 albedo. The source concrete is a bright studio scan and
    // at full value the sunlit yard clips to white, taking the mottling, the
    // worn paths and every contact shadow with it.
    let shade = 0.28 + fbm(x * 0.055, z * 0.055, 4) * 0.34;
    shade *= 0.86 + valueNoise(x * 0.42, z * 0.42) * 0.28;
    shade *= 0.88 + fbm(x * 0.19, z * 0.19, 3) * 0.26;
    colour.copy(BASE);

    for (const path of paths) {
      const d = distanceToPolyline(x, z, path.points);
      const t = Math.max(0, 1 - d / path.width);
      shade += path.shift * t * t;
    }

    for (const footprint of footprints) {
      const dx = Math.max(0, Math.abs(x - footprint.x) - footprint.w / 2);
      const dz = Math.max(0, Math.abs(z - footprint.z) - footprint.d / 2);
      const d = Math.hypot(dx, dz);
      shade -= 0.3 * Math.max(0, 1 - d / 2.2) ** 2;
    }

    for (const patch of patches) {
      const d = Math.hypot(x - patch.x, z - patch.z);
      // Ragged edge, so stains do not read as circles.
      const wobble = patch.radius * (0.78 + valueNoise(x * 0.6, z * 0.6) * 0.45);
      const t = Math.max(0, 1 - d / wobble);
      colour.lerp(patch.tint, t * t * patch.strength);
    }

    colors[i * 3] = colour.r * shade;
    colors[i * 3 + 1] = colour.g * shade;
    colors[i * 3 + 2] = colour.b * shade;
  }

  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, materials.byKey.ground);
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  // A flat floor contributes nothing to the shadow map but would be redrawn
  // in every cascade, so it is excluded from the shadow pass entirely.
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function distanceToPolyline(x: number, z: number, points: Array<[number, number]>): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq)) : 0;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) best = d;
  }
  return best;
}
