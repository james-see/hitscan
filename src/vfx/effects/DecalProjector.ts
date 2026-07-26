import * as THREE from 'three';

/** Floats per emitted vertex: position, normal, tangent, uv, (birth, life). */
export const DECAL_VERTEX_STRIDE = 13;

/** Sutherland-Hodgman against six planes can add at most six vertices. */
const MAX_POLY = 12;

/** Lift along the projector normal, on top of the material's polygon offset. */
const SURFACE_LIFT = 0.0016;

const _center = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _seed = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _edge1 = new THREE.Vector3();
const _edge2 = new THREE.Vector3();
const _faceNormal = new THREE.Vector3();

/** Options for one projection. Reused by the decal pool. */
export interface DecalProjection {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  /** Rotation about the projector normal, in radians. */
  roll: number;
  width: number;
  height: number;
  /** Projection depth. Too deep and the decal wraps onto unrelated faces. */
  depth: number;
  uvOriginX: number;
  uvOriginY: number;
  uvScaleX: number;
  uvScaleY: number;
}

/**
 * Clips mesh geometry against a decal box, the construction three's
 * `DecalGeometry` uses, but writing into a caller-owned slot of a shared
 * buffer so nothing is allocated at runtime.
 *
 * Projecting rather than laying down a quad is what makes a bullet hole sit
 * *in* an angled wall, and wrap a crate edge, instead of hovering in front.
 */
export class DecalProjector {
  #polyA = new Float32Array(MAX_POLY * 3);
  #polyB = new Float32Array(MAX_POLY * 3);

  /** @returns the number of vertices written into `out`. */
  build(
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    projection: DecalProjection,
    out: Float32Array,
    outOffset: number,
    maxVertices: number
  ): number {
    const positions = geometry.getAttribute('position');
    if (!positions) return 0;

    const { position, normal, roll, width, height, depth } = projection;
    _center.copy(position);
    _zAxis.copy(normal).normalize();
    if (Math.abs(_zAxis.y) < 0.985) _seed.set(0, 1, 0);
    else _seed.set(1, 0, 0);
    _xAxis.crossVectors(_seed, _zAxis).normalize();
    _yAxis.crossVectors(_zAxis, _xAxis).normalize();
    if (roll !== 0) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      const xx = _xAxis.x * c + _yAxis.x * s;
      const xy = _xAxis.y * c + _yAxis.y * s;
      const xz = _xAxis.z * c + _yAxis.z * s;
      const yx = _yAxis.x * c - _xAxis.x * s;
      const yy = _yAxis.y * c - _xAxis.y * s;
      const yz = _yAxis.z * c - _xAxis.z * s;
      _xAxis.set(xx, xy, xz);
      _yAxis.set(yx, yy, yz);
    }

    const invW = 1 / width;
    const invH = 1 / height;
    const invD = 1 / depth;

    const index = geometry.getIndex();
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(positions.count / 3);

    const polyA = this.#polyA;
    let written = 0;

    for (let tri = 0; tri < triangleCount; tri++) {
      const i0 = index ? index.getX(tri * 3) : tri * 3;
      const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
      const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;

      _v0.fromBufferAttribute(positions, i0).applyMatrix4(matrix);
      _v1.fromBufferAttribute(positions, i1).applyMatrix4(matrix);
      _v2.fromBufferAttribute(positions, i2).applyMatrix4(matrix);

      _edge1.subVectors(_v1, _v0);
      _edge2.subVectors(_v2, _v0);
      _faceNormal.crossVectors(_edge1, _edge2).normalize();
      // Reject the far side of thin geometry: a decal must never print
      // through a wall onto the surface behind it.
      if (_faceNormal.dot(_zAxis) < 0.2) continue;

      let common = 0x3f;
      common &= this.#toDecalSpace(_v0, polyA, 0, invW, invH, invD);
      common &= this.#toDecalSpace(_v1, polyA, 1, invW, invH, invD);
      common &= this.#toDecalSpace(_v2, polyA, 2, invW, invH, invD);
      // Every vertex beyond the same plane means the triangle cannot overlap.
      if (common !== 0) continue;

      let count = 3;
      let src = polyA;
      let dst = this.#polyB;
      for (let axis = 0; axis < 3; axis++) {
        count = this.#clip(src, count, dst, axis, true);
        if (count < 3) break;
        let swap = src;
        src = dst;
        dst = swap;
        count = this.#clip(src, count, dst, axis, false);
        if (count < 3) break;
        swap = src;
        src = dst;
        dst = swap;
      }
      if (count < 3) continue;

      const needed = (count - 2) * 3;
      if (written + needed > maxVertices) break;

      for (let k = 1; k < count - 1; k++) {
        this.#emit(src, 0, projection, out, outOffset + written * DECAL_VERTEX_STRIDE);
        written++;
        this.#emit(src, k, projection, out, outOffset + written * DECAL_VERTEX_STRIDE);
        written++;
        this.#emit(src, k + 1, projection, out, outOffset + written * DECAL_VERTEX_STRIDE);
        written++;
      }
    }

    return written;
  }

  /** @returns the outcode of the vertex, one bit per box plane it is beyond. */
  #toDecalSpace(
    v: THREE.Vector3,
    poly: Float32Array,
    slot: number,
    invW: number,
    invH: number,
    invD: number
  ): number {
    const rx = v.x - _center.x;
    const ry = v.y - _center.y;
    const rz = v.z - _center.z;
    const dx = (rx * _xAxis.x + ry * _xAxis.y + rz * _xAxis.z) * invW;
    const dy = (rx * _yAxis.x + ry * _yAxis.y + rz * _yAxis.z) * invH;
    const dz = (rx * _zAxis.x + ry * _zAxis.y + rz * _zAxis.z) * invD;
    poly[slot * 3] = dx;
    poly[slot * 3 + 1] = dy;
    poly[slot * 3 + 2] = dz;

    let code = 0;
    if (dx > 0.5) code |= 1;
    else if (dx < -0.5) code |= 2;
    if (dy > 0.5) code |= 4;
    else if (dy < -0.5) code |= 8;
    if (dz > 0.5) code |= 16;
    else if (dz < -0.5) code |= 32;
    return code;
  }

  #clip(
    src: Float32Array,
    count: number,
    dst: Float32Array,
    axis: number,
    positive: boolean
  ): number {
    let out = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 === count ? 0 : i + 1;
      const ai = src[i * 3 + axis]!;
      const aj = src[j * 3 + axis]!;
      const di = positive ? 0.5 - ai : ai + 0.5;
      const dj = positive ? 0.5 - aj : aj + 0.5;
      const insideI = di >= 0;
      const insideJ = dj >= 0;

      if (insideI) {
        if (out >= MAX_POLY) break;
        dst[out * 3] = src[i * 3]!;
        dst[out * 3 + 1] = src[i * 3 + 1]!;
        dst[out * 3 + 2] = src[i * 3 + 2]!;
        out++;
      }
      if (insideI !== insideJ) {
        if (out >= MAX_POLY) break;
        const t = di / (di - dj);
        dst[out * 3] = src[i * 3]! + (src[j * 3]! - src[i * 3]!) * t;
        dst[out * 3 + 1] = src[i * 3 + 1]! + (src[j * 3 + 1]! - src[i * 3 + 1]!) * t;
        dst[out * 3 + 2] = src[i * 3 + 2]! + (src[j * 3 + 2]! - src[i * 3 + 2]!) * t;
        out++;
      }
    }
    return out;
  }

  #emit(
    poly: Float32Array,
    vertex: number,
    projection: DecalProjection,
    out: Float32Array,
    offset: number
  ): void {
    const dx = poly[vertex * 3]!;
    const dy = poly[vertex * 3 + 1]!;
    const dz = poly[vertex * 3 + 2]! * projection.depth + SURFACE_LIFT;
    const sx = dx * projection.width;
    const sy = dy * projection.height;

    out[offset] = _center.x + _xAxis.x * sx + _yAxis.x * sy + _zAxis.x * dz;
    out[offset + 1] = _center.y + _xAxis.y * sx + _yAxis.y * sy + _zAxis.y * dz;
    out[offset + 2] = _center.z + _xAxis.z * sx + _yAxis.z * sy + _zAxis.z * dz;
    out[offset + 3] = _faceNormal.x;
    out[offset + 4] = _faceNormal.y;
    out[offset + 5] = _faceNormal.z;
    out[offset + 6] = _xAxis.x;
    out[offset + 7] = _xAxis.y;
    out[offset + 8] = _xAxis.z;
    out[offset + 9] = projection.uvOriginX + (dx + 0.5) * projection.uvScaleX;
    out[offset + 10] = projection.uvOriginY + (dy + 0.5) * projection.uvScaleY;
    out[offset + 11] = 0;
    out[offset + 12] = 0;
  }
}
