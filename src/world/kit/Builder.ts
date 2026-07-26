import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SurfaceKind } from '@/types/gameplay.ts';
import { chamferBox } from './Geometry.ts';
import type { KitMaterials, MaterialKey } from './Materials.ts';

export type ArenaCollider =
  | {
      kind: 'box';
      position: THREE.Vector3;
      halfExtents: THREE.Vector3;
      rotation: THREE.Quaternion;
      surface: SurfaceKind;
    }
  | { kind: 'mesh'; mesh: THREE.Mesh; surface: SurfaceKind };

/** How texture coordinates are derived for a piece. */
export type UvSpec =
  | {
      /**
       * Planar projection from world space along the dominant vertex normal.
       * Adjacent pieces of the same material line up, so a wall built from
       * eight boxes reads as one surface.
       */
      mode: 'world';
      offset?: [number, number];
      /** Swaps u and v, to turn the corrugated iron's ribs 90°. */
      rotate?: boolean;
      /** Multiplies the material's own tile scale. */
      scale?: number;
    }
  | { mode: 'local'; repeat: [number, number]; offset?: [number, number] };

export interface PaintOptions {
  /** Multiplied into the albedo through vertex colour. */
  tint?: THREE.Color;
  /** Darkens the piece toward its base, faking dirt and contact occlusion. */
  grime?: number;
  /** World height at which grime reaches zero. Defaults to the piece's top. */
  grimeTop?: number;
  /** Per-vertex shade jitter, breaking up flat plaster. */
  mottle?: number;
}

export interface AddOptions extends PaintOptions {
  material: MaterialKey;
  uv?: UvSpec;
}

export interface BoxSpec extends AddOptions {
  /** Centre in x/z; `y` is the base of the piece, before any tilt. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rotY?: number;
  /** Tilt about the local x axis, applied after yaw. Radians. */
  tiltX?: number;
  tiltZ?: number;
  chamfer?: number;
  /** Surface tag for the collider, or false for decorative geometry. */
  collide?: SurfaceKind | false;
  /** Shrinks the collider relative to the visual, for pieces that overhang. */
  colliderScale?: THREE.Vector3;
}

const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _origin = new THREE.Vector3();

/**
 * Width of one spatial merge bucket.
 *
 * Sized to swallow the whole arena. Splitting the merge spatially would let the
 * shadow cascades reject distant halves, but every one of the six shot framings
 * sees most of the courtyard, so in practice the split rejected almost nothing
 * while multiplying the batch count by the number of zones — and draw calls,
 * not triangles, are what this scene is short of.
 */
const ZONE_SIZE = 200;
/** Shifts world coordinates positive so the grid does not split across x = 0. */
const ZONE_ORIGIN = 512;

/**
 * Accumulates the level's static geometry and batches it for submission.
 *
 * Pieces are transformed into world space at build time and merged per
 * (material, spatial zone). One merged mesh per bucket costs a single draw
 * call in the main pass and one per shadow cascade, which is what makes a
 * densely dressed arena affordable — a thousand individually placed boxes
 * would not be.
 */
export class WorldBuilder {
  readonly colliders: ArenaCollider[] = [];

  #materials: KitMaterials;
  #buckets = new Map<string, { material: MaterialKey; parts: THREE.BufferGeometry[] }>();

  constructor(materials: KitMaterials) {
    this.#materials = materials;
  }

  /** Adds pre-transformed geometry. `matrix` maps local space to world space. */
  add(source: THREE.BufferGeometry, matrix: THREE.Matrix4, options: AddOptions): void {
    const geometry = source.clone().applyMatrix4(matrix);
    if (!geometry.getIndex()) {
      const count = geometry.getAttribute('position').count;
      geometry.setIndex(Array.from({ length: count }, (_, i) => i));
    }
    geometry.clearGroups();
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') {
        geometry.deleteAttribute(name);
      }
    }

    const tile = this.#materials.tileScale[options.material];
    applyUvs(geometry, options.uv ?? { mode: 'world' }, tile);
    applyVertexColors(geometry, options);

    const key = this.#bucketKey(options.material, geometry);
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { material: options.material, parts: [] };
      this.#buckets.set(key, bucket);
    }
    bucket.parts.push(geometry);
  }

  /** Chamfered box plus, unless suppressed, a matching static collider. */
  box(spec: BoxSpec): void {
    const {
      x,
      y,
      z,
      w,
      h,
      d,
      rotY = 0,
      tiltX = 0,
      tiltZ = 0,
      chamfer = 0.035,
      collide,
      colliderScale,
    } = spec;

    _euler.set(tiltX, rotY, tiltZ, 'YXZ');
    _quaternion.setFromEuler(_euler);
    _position.set(x, y + h / 2, z);
    _matrix.compose(_position, _quaternion, _scale);

    this.add(chamferBox(w, h, d, chamfer), _matrix, spec);

    const surface = collide === false ? null : (collide ?? this.#materials.surface[spec.material]);
    if (surface) {
      const half = new THREE.Vector3(w / 2, h / 2, d / 2);
      if (colliderScale) half.multiply(colliderScale);
      this.colliders.push({
        kind: 'box',
        position: _position.clone(),
        halfExtents: half,
        rotation: _quaternion.clone(),
        surface,
      });
    }
  }

  /** A collider with no geometry of its own, for blockouts and clamped volumes. */
  solid(
    position: THREE.Vector3,
    halfExtents: THREE.Vector3,
    surface: SurfaceKind,
    rotation = new THREE.Quaternion()
  ): void {
    this.colliders.push({
      kind: 'box',
      position: position.clone(),
      halfExtents: halfExtents.clone(),
      rotation: rotation.clone(),
      surface,
    });
  }

  /** Merges every bucket and returns the meshes to attach to the scene. */
  finalize(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [key, bucket] of this.#buckets) {
      if (bucket.parts.length === 0) continue;
      const merged = mergeGeometries(bucket.parts, false);
      if (!merged) {
        console.warn(`[world] failed to merge bucket "${key}"`);
        continue;
      }
      merged.setAttribute('uv1', merged.getAttribute('uv').clone());
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this.#materials.byKey[bucket.material]);
      mesh.name = `arena:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      meshes.push(mesh);
      for (const part of bucket.parts) part.dispose();
    }
    return meshes;
  }

  #bucketKey(material: MaterialKey, geometry: THREE.BufferGeometry): string {
    geometry.computeBoundingSphere();
    const c = geometry.boundingSphere?.center ?? _origin.set(0, 0, 0);
    const zx = Math.floor((c.x + ZONE_ORIGIN) / ZONE_SIZE);
    const zz = Math.floor((c.z + ZONE_ORIGIN) / ZONE_SIZE);
    return `${material}:${zx}:${zz}`;
  }
}

/** Derives texture coordinates for a piece already placed in its final space. */
export function applyUvs(geometry: THREE.BufferGeometry, spec: UvSpec, tile: number): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const count = position.count;

  if (spec.mode === 'local') {
    const existing = geometry.getAttribute('uv');
    const uv = new Float32Array(count * 2);
    const [ou, ov] = spec.offset ?? [0, 0];
    for (let i = 0; i < count; i++) {
      const u = existing ? existing.getX(i) : 0;
      const v = existing ? existing.getY(i) : 0;
      uv[i * 2] = u * spec.repeat[0] + ou;
      uv[i * 2 + 1] = v * spec.repeat[1] + ov;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return;
  }

  const scale = tile * (spec.scale ?? 1);
  const [ou, ov] = spec.offset ?? [0, 0];
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const px = position.getX(i);
    const py = position.getY(i);
    const pz = position.getZ(i);
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = px;
      v = ny >= 0 ? -pz : pz;
    } else if (ax >= az) {
      u = nx >= 0 ? -pz : pz;
      v = py;
    } else {
      u = nz >= 0 ? px : -px;
      v = py;
    }
    if (spec.rotate) {
      const swap = u;
      u = v;
      v = swap;
    }
    uv[i * 2] = (u + ou) / scale;
    uv[i * 2 + 1] = (v + ov) / scale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Bakes tint, grime and mottling into the `color` attribute. */
export function applyVertexColors(geometry: THREE.BufferGeometry, options: PaintOptions): void {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const colors = new Float32Array(count * 3);
  const tint = options.tint ?? WHITE;
  const grime = options.grime ?? 0;
  const mottle = options.mottle ?? 0;

  let minY = Infinity;
  let maxY = -Infinity;
  if (grime > 0) {
    for (let i = 0; i < count; i++) {
      const y = position.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (options.grimeTop !== undefined) maxY = options.grimeTop;
  }
  const span = Math.max(0.001, maxY - minY);

  for (let i = 0; i < count; i++) {
    let shade = 1;
    if (grime > 0) {
      // Dirt is strongest at the base and fades over a metre or so; clamping
      // the span stops a tall pillar from becoming one long gradient.
      const t = Math.min(1, (position.getY(i) - minY) / Math.min(span, 1.6));
      shade -= grime * (1 - t) * (1 - t);
    }
    if (mottle > 0) {
      const h = hashVertex(position.getX(i), position.getY(i), position.getZ(i));
      shade *= 1 + (h - 0.5) * 2 * mottle;
    }
    colors[i * 3] = tint.r * shade;
    colors[i * 3 + 1] = tint.g * shade;
    colors[i * 3 + 2] = tint.b * shade;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

const WHITE = new THREE.Color(1, 1, 1);

/** Coarse position hash, quantised so shared vertices agree. */
function hashVertex(x: number, y: number, z: number): number {
  let h = (Math.round(x * 3.2) * 374761393) | 0;
  h = (h + Math.round(y * 3.2) * 668265263) | 0;
  h = (h + Math.round(z * 3.2) * 1442695041) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >> 16)) | 0;
  return (h >>> 0) / 4294967296;
}
