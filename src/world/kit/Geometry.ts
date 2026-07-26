import * as THREE from 'three';

/**
 * Primitive generation for the level kit.
 *
 * Everything here returns indexed geometry with `position` and `normal` only —
 * UVs and vertex colours are applied later, in world space, by the builder.
 * Keeping the two steps apart is what lets a wall and the crate leaning
 * against it share one continuous texture projection.
 */

/** Accumulates flat-shaded triangles with automatically corrected winding. */
export class TriBuffer {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly indices: number[] = [];

  tri(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, n: THREE.Vector3): void {
    const [a, b, c] = this.#order(p0, p1, p2, n);
    const base = this.positions.length / 3;
    for (const p of [a, b, c]) {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(n.x, n.y, n.z);
    }
    this.indices.push(base, base + 1, base + 2);
  }

  quad(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    n: THREE.Vector3
  ): void {
    const flipped = this.#facesAway(p0, p1, p2, n);
    const ring = flipped ? [p0, p3, p2, p1] : [p0, p1, p2, p3];
    const base = this.positions.length / 3;
    for (const p of ring) {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(n.x, n.y, n.z);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setIndex(this.indices);
    return geometry;
  }

  #facesAway(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, n: THREE.Vector3): boolean {
    _e1.subVectors(p1, p0);
    _e2.subVectors(p2, p0);
    return _e1.cross(_e2).dot(n) < 0;
  }

  #order(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    n: THREE.Vector3
  ): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
    return this.#facesAway(p0, p1, p2, n) ? [p0, p2, p1] : [p0, p1, p2];
  }
}

const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

const chamferCache = new Map<string, THREE.BufferGeometry>();

/**
 * A box with its twelve edges and eight corners cut back.
 *
 * The bevel is the single highest-value detail in the whole kit: a hard 90°
 * edge under a directional light has no gradient at all, which is exactly what
 * makes untextured cubes read as programmer art. A 3–5 cm cut catches a
 * separate shade on every silhouette edge.
 */
export function chamferBox(
  width: number,
  height: number,
  depth: number,
  chamfer = 0.04
): THREE.BufferGeometry {
  const key = `${width.toFixed(4)},${height.toFixed(4)},${depth.toFixed(4)},${chamfer.toFixed(4)}`;
  const cached = chamferCache.get(key);
  if (cached) return cached;

  const extent = [width / 2, height / 2, depth / 2];
  const t = Math.min(chamfer, extent[0] * 0.45, extent[1] * 0.45, extent[2] * 0.45);

  let geometry: THREE.BufferGeometry;
  if (t <= 1e-4) {
    geometry = new THREE.BoxGeometry(width, height, depth);
    geometry.clearGroups();
  } else {
    const buf = new TriBuffer();
    /** Corner vertex that reaches full extent on `axis` and is cut on the others. */
    const corner = (s: readonly number[], axis: number): THREE.Vector3 =>
      new THREE.Vector3(
        s[0] * (extent[0] - (axis === 0 ? 0 : t)),
        s[1] * (extent[1] - (axis === 1 ? 0 : t)),
        s[2] * (extent[2] - (axis === 2 ? 0 : t))
      );
    const axisVec = (axis: number, sign: number): THREE.Vector3 =>
      new THREE.Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);

    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      for (const sign of [-1, 1]) {
        const s = [0, 0, 0];
        s[axis] = sign;
        const ring = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([su, sv]) => {
          s[u] = su;
          s[v] = sv;
          return corner(s, axis);
        });
        buf.quad(ring[0], ring[1], ring[2], ring[3], axisVec(axis, sign));
      }

      // Bevel between the `axis` face and the `u` face, running along `v`.
      for (const sa of [-1, 1]) {
        for (const su of [-1, 1]) {
          const s = [0, 0, 0];
          s[axis] = sa;
          s[u] = su;
          s[v] = -1;
          const a0 = corner(s, axis);
          const b0 = corner(s, u);
          s[v] = 1;
          const a1 = corner(s, axis);
          const b1 = corner(s, u);
          const n = axisVec(axis, sa).add(axisVec(u, su)).normalize();
          buf.quad(a0, a1, b1, b0, n);
        }
      }
    }

    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const s = [sx, sy, sz];
          buf.tri(
            corner(s, 0),
            corner(s, 1),
            corner(s, 2),
            new THREE.Vector3(sx, sy, sz).normalize()
          );
        }
      }
    }
    geometry = buf.build();
  }

  chamferCache.set(key, geometry);
  return geometry;
}

/**
 * A triangular prism, base along local z and apex on local y, extruded across
 * local x. Used for gable infill, where a stack of boxes would stair-step.
 */
export function gablePrism(span: number, peak: number, thickness: number): THREE.BufferGeometry {
  const hx = thickness / 2;
  const hz = span / 2;
  const buf = new TriBuffer();
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  for (const sx of [-1, 1]) {
    buf.tri(
      v(sx * hx, 0, -hz),
      v(sx * hx, 0, hz),
      v(sx * hx, peak, 0),
      v(sx, 0, 0)
    );
  }
  buf.quad(v(-hx, 0, -hz), v(hx, 0, -hz), v(hx, 0, hz), v(-hx, 0, hz), v(0, -1, 0));
  const slope = Math.atan2(peak, hz);
  for (const sz of [-1, 1]) {
    buf.quad(
      v(-hx, 0, sz * hz),
      v(hx, 0, sz * hz),
      v(hx, peak, 0),
      v(-hx, peak, 0),
      v(0, Math.cos(slope), sz * Math.sin(slope))
    );
  }
  return buf.build();
}

/**
 * An irregular convex lump, used for rubble, sandbags and debris.
 *
 * Built by perturbing an icosahedron so no two rocks share a silhouette, which
 * a scaled sphere never achieves.
 */
export function lumpGeometry(
  detail: number,
  jitter: number,
  seed: number,
  squash = 1
): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(0.5, detail);
  const position = geometry.getAttribute('position');
  const seen = new Map<string, THREE.Vector3>();
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let moved = seen.get(key);
    if (!moved) {
      const n = 1 + (hash3(v.x * 97 + seed, v.y * 97, v.z * 97) - 0.5) * 2 * jitter;
      moved = v.clone().multiplyScalar(n);
      moved.y *= squash;
      seen.set(key, moved);
    }
    position.setXYZ(i, moved.x, moved.y, moved.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Deterministic 3D value hash in [0,1). Exact across runs, unlike sin-based hashes. */
export function hash3(x: number, y: number, z: number): number {
  let h = (Math.round(x * 1024) * 374761393) | 0;
  h = (h + Math.round(y * 1024) * 668265263) | 0;
  h = (h + Math.round(z * 1024) * 2147483647) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

function hash2(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise in [0,1). */
export function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Fractal value noise in [0,1), roughly centred on 0.5. */
export function fbm(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 0.5;
  let total = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    fx *= 2.03;
    fy *= 2.01;
  }
  return sum / total;
}
