import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Per-face flag marking the narrow bevel strips that run around a part.
 *
 * The edge-wear shader keys off this rather than off measured curvature. On
 * geometry built entirely from boxes there is no such thing as a vertex that
 * is not on an edge, so no per-vertex signal can pick a chamfer out of a
 * flat panel; but the primitives know exactly which triangles they put in
 * their bevels, so they simply say so.
 */
const CHAMFER = 'aWear';

/**
 * Marks the bevel triangles of an extruded profile.
 *
 * Extrusions come out in three parts: two end caps at the full half-depth,
 * the perimeter walls at the core half-depth, and the bevel rings that join
 * them. Only the bevel spans the two, which identifies it exactly.
 *
 * `roundedCorners` additionally marks the vertical corner arcs of a rounded
 * rectangle, which are the box's upright edges and wear just as hard.
 */
function tagExtrudedChamfers(
  geometry: THREE.BufferGeometry,
  halfCore: number,
  bevel: number,
  roundedCorners: boolean
): void {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const flags = new Float32Array(count);
  const eps = bevel * 0.05;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const e0 = new THREE.Vector3();
  const e1 = new THREE.Vector3();

  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    const maxZ = Math.max(Math.abs(a.z), Math.abs(b.z), Math.abs(c.z));
    const minZ = Math.min(Math.abs(a.z), Math.abs(b.z), Math.abs(c.z));

    let chamfer = maxZ > halfCore + eps && minZ < halfCore + bevel - eps;
    if (!chamfer && roundedCorners && maxZ <= halfCore + eps) {
      normal.crossVectors(e0.subVectors(b, a), e1.subVectors(c, a)).normalize();
      chamfer = Math.abs(normal.x) > 0.3 && Math.abs(normal.y) > 0.3;
    }
    if (chamfer) {
      flags[i] = 1;
      flags[i + 1] = 1;
      flags[i + 2] = 1;
    }
  }
  geometry.setAttribute(CHAMFER, new THREE.BufferAttribute(flags, 1));
}

/**
 * Collects transformed geometry per material and merges it into one mesh per
 * material.
 *
 * A procedural weapon is a few hundred primitives; submitting those as
 * individual meshes would cost more draw calls than the rest of the frame
 * combined. Merging by material collapses the whole rifle into single-digit
 * draws while keeping the authoring code as "place a box here".
 */
export class GeometryBuilder {
  #buckets = new Map<string, THREE.BufferGeometry[]>();
  #matrix = new THREE.Matrix4();
  #quaternion = new THREE.Quaternion();
  #euler = new THREE.Euler();
  #position = new THREE.Vector3();
  #scale = new THREE.Vector3();

  /**
   * Adds a geometry, baking the given transform into its vertices.
   *
   * `flat` recomputes normals per face, which is how a low-segment cylinder
   * reads as a machined octagon instead of a smooth tube.
   */
  add(
    material: string,
    geometry: THREE.BufferGeometry,
    position: readonly [number, number, number] = [0, 0, 0],
    rotation: readonly [number, number, number] = [0, 0, 0],
    scale: readonly [number, number, number] = [1, 1, 1],
    flat = false
  ): void {
    this.#position.set(position[0], position[1], position[2]);
    this.#euler.set(rotation[0], rotation[1], rotation[2], 'XYZ');
    this.#quaternion.setFromEuler(this.#euler);
    this.#scale.set(scale[0], scale[1], scale[2]);
    this.#matrix.compose(this.#position, this.#quaternion, this.#scale);

    // Primitives arrive indexed and extrusions do not, and merging refuses to
    // mix the two. Flattening everything is cheaper than the alternative of
    // hand-indexing the extruded parts, and the whole rifle is a few thousand
    // triangles either way.
    let normalised = geometry.index ? geometry.toNonIndexed() : geometry;
    if (normalised !== geometry) geometry.dispose();
    for (const name of Object.keys(normalised.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== CHAMFER) {
        normalised.deleteAttribute(name);
      }
    }
    const count = normalised.getAttribute('position').count;
    if (!normalised.getAttribute('uv')) {
      normalised.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    // Primitives that carry no chamfer strips still need the attribute, since
    // merging refuses to mix geometries with different attribute sets.
    if (!normalised.getAttribute(CHAMFER)) {
      normalised.setAttribute(CHAMFER, new THREE.BufferAttribute(new Float32Array(count), 1));
    }
    normalised.clearGroups();
    if (flat) normalised.computeVertexNormals();
    normalised.applyMatrix4(this.#matrix);
    geometry = normalised;
    // Non-uniform scale leaves normals unnormalised, which shows up as
    // banding on the anisotropic parts (rail teeth, magazine ribs).
    if (scale[0] !== scale[1] || scale[1] !== scale[2]) geometry.normalizeNormals();

    const bucket = this.#buckets.get(material);
    if (bucket) bucket.push(geometry);
    else this.#buckets.set(material, [geometry]);
  }

  /**
   * Merges each bucket and parents the resulting meshes to `target`.
   *
   * `uvDensity` re-projects UVs from object space so detail maps land at a
   * consistent texel size. Primitive UVs run 0..1 per face regardless of how
   * big the face is, which would smear the same texture across a 2mm screw
   * and a 300mm handguard.
   */
  build(
    target: THREE.Object3D,
    materials: Record<string, THREE.Material>,
    namePrefix = '',
    uvDensity = 11
  ): void {
    for (const [key, geometries] of this.#buckets) {
      const material = materials[key];
      if (!material) throw new Error(`[weapon] no material registered for "${key}"`);
      const merged =
        geometries.length === 1
          ? (geometries[0] as THREE.BufferGeometry)
          : mergeGeometries(geometries, false);
      if (!merged) throw new Error(`[weapon] failed to merge geometry for "${key}"`);
      if (geometries.length > 1) for (const g of geometries) g.dispose();
      if (uvDensity > 0) boxProjectUvs(merged, uvDensity);
      computeCurvatureAttributes(merged);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${namePrefix}${key}`;
      // The viewmodel is drawn into a cleared depth buffer with its own
      // camera, so it is never a shadow caster or receiver.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      target.add(mesh);
    }
    this.#buckets.clear();
  }
}

/** Positions are welded at 0.01mm, far below any feature on the weapon. */
const WELD = 1e5;

/**
 * Per-vertex welded convexity, in roughly [-1,1].
 *
 * Measured by welding coincident vertices and asking whether the surrounding
 * faces fall away from the averaged normal (convex) or close over it
 * (concave). This interpolates smoothly across a face, which is what the
 * cavity term wants: grime gathers in a gradient out of a corner, not in a
 * hard band.
 *
 * It deliberately does *not* drive the edge wear. On box-built geometry every
 * vertex is a corner, so convexity is high nearly everywhere and would wear
 * the entire model; the chamfer strips are tagged by the primitives that
 * build them instead.
 */
function computeCurvatureAttributes(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  const vertexCount = position.count;
  const faceCount = Math.floor(vertexCount / 3);

  const faceNormal = new Float32Array(faceCount * 3);
  const faceCentroid = new Float32Array(faceCount * 3);

  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const e0 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let f = 0; f < faceCount; f++) {
    const i = f * 3;
    ax.fromBufferAttribute(position, i);
    bx.fromBufferAttribute(position, i + 1);
    cx.fromBufferAttribute(position, i + 2);
    e0.subVectors(bx, ax);
    e1.subVectors(cx, ax);
    cross.crossVectors(e0, e1);
    const twiceArea = cross.length();
    if (twiceArea > 1e-12) cross.multiplyScalar(1 / twiceArea);
    faceNormal[i] = cross.x;
    faceNormal[i + 1] = cross.y;
    faceNormal[i + 2] = cross.z;
    faceCentroid[i] = (ax.x + bx.x + cx.x) / 3;
    faceCentroid[i + 1] = (ax.y + bx.y + cx.y) / 3;
    faceCentroid[i + 2] = (ax.z + bx.z + cx.z) / 3;
  }

  // Weld by quantised position. The key packs three 17-bit axis indices into
  // one double, which is exact for anything inside a 0.65m half-extent.
  const buckets = new Map<number, number[]>();
  const keys = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const qx = Math.round(position.getX(v) * WELD) + 65536;
    const qy = Math.round(position.getY(v) * WELD) + 65536;
    const qz = Math.round(position.getZ(v) * WELD) + 65536;
    const key = (qx * 131072 + qy) * 131072 + qz;
    keys[v] = key;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(v);
    else buckets.set(key, [v]);
  }

  const convexity = new Map<number, number>();
  const average = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const point = new THREE.Vector3();
  for (const [key, vertices] of buckets) {
    average.set(0, 0, 0);
    for (const v of vertices) {
      const i = Math.floor(v / 3) * 3;
      average.x += faceNormal[i] as number;
      average.y += faceNormal[i + 1] as number;
      average.z += faceNormal[i + 2] as number;
    }
    if (average.lengthSq() < 1e-12) {
      convexity.set(key, 0);
      continue;
    }
    average.normalize();
    point.fromBufferAttribute(position, vertices[0] as number);
    let sum = 0;
    for (const v of vertices) {
      const i = Math.floor(v / 3) * 3;
      offset.set(
        (faceCentroid[i] as number) - point.x,
        (faceCentroid[i + 1] as number) - point.y,
        (faceCentroid[i + 2] as number) - point.z
      );
      const length = offset.length();
      if (length < 1e-9) continue;
      sum += offset.dot(average) / length;
    }
    convexity.set(key, THREE.MathUtils.clamp((-sum / vertices.length) * 2.2, -1, 1));
  }

  const edge = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    edge[v] = convexity.get(keys[v] as number) ?? 0;
  }

  geometry.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
}

/**
 * Replaces UVs with an object-space box projection: each triangle is mapped
 * along whichever axis its normal points at most strongly. Uniform texel
 * density on every part, at the cost of visible seams where a surface turns
 * a corner — invisible under a fine grain map.
 */
function boxProjectUvs(geometry: THREE.BufferGeometry, density: number): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const count = position.count;

  for (let i = 0; i < count; i += 3) {
    const nx = Math.abs(normal.getX(i) + normal.getX(i + 1) + normal.getX(i + 2));
    const ny = Math.abs(normal.getY(i) + normal.getY(i + 1) + normal.getY(i + 2));
    const nz = Math.abs(normal.getZ(i) + normal.getZ(i + 1) + normal.getZ(i + 2));
    // Brushing runs along the weapon's long axis, so the Z component always
    // feeds U where it can: that is the direction real machining marks run.
    for (let v = 0; v < 3; v++) {
      const j = i + v;
      const x = position.getX(j);
      const y = position.getY(j);
      const z = position.getZ(j);
      if (nx >= ny && nx >= nz) uv.setXY(j, z * density, y * density);
      else if (ny >= nz) uv.setXY(j, z * density, x * density);
      else uv.setXY(j, x * density, y * density);
    }
  }
  uv.needsUpdate = true;
}

/**
 * Axis-aligned box with softened edges, extruded along Z.
 *
 * Built from an extruded rounded rectangle rather than three.js's
 * RoundedBoxGeometry so the long faces keep clean, unstretched UVs — which
 * matters for the ribbed and knurled parts.
 */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius = 0.002,
  segments = 2
): THREE.BufferGeometry {
  const smallest = Math.min(width, height, depth);
  const r = Math.max(1e-4, Math.min(radius, smallest * 0.45));
  // The bevel grows the profile outward, so the flat shape is inset by it to
  // keep the finished part exactly the requested size.
  const b = Math.min(r * 0.7, smallest * 0.24);
  const rc = Math.max(1e-4, r - b);
  const w = width / 2 - b - rc;
  const h = height / 2 - b - rc;

  const shape = new THREE.Shape();
  shape.moveTo(-w, -h - rc);
  shape.lineTo(w, -h - rc);
  shape.quadraticCurveTo(w + rc, -h - rc, w + rc, -h);
  shape.lineTo(w + rc, h);
  shape.quadraticCurveTo(w + rc, h + rc, w, h + rc);
  shape.lineTo(-w, h + rc);
  shape.quadraticCurveTo(-w - rc, h + rc, -w - rc, h);
  shape.lineTo(-w - rc, -h);
  shape.quadraticCurveTo(-w - rc, -h - rc, -w, -h - rc);

  const core = depth - b * 2;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: core,
    bevelEnabled: true,
    bevelSize: b,
    bevelThickness: b,
    bevelSegments: Math.max(1, segments - 1),
    curveSegments: segments,
    steps: 1,
  });
  geometry.translate(0, 0, -core / 2);
  geometry.computeVertexNormals();
  tagExtrudedChamfers(geometry, core / 2, b, true);
  return geometry;
}

/**
 * A rounded rectangular plate with a circular bore through it, extruded along
 * Z. Used for the optic's face plates, where a floating bezel ring would
 * leave the corners of the housing open to the sky.
 */
export function apertureFace(
  width: number,
  height: number,
  radius: number,
  depth: number,
  corner = 0.004,
  segments = 32
): THREE.BufferGeometry {
  const b = Math.min(0.0009, depth * 0.18);
  const rc = Math.max(1e-4, corner - b);
  const w = width / 2 - b - rc;
  const h = height / 2 - b - rc;

  const shape = new THREE.Shape();
  shape.moveTo(-w, -h - rc);
  shape.lineTo(w, -h - rc);
  shape.quadraticCurveTo(w + rc, -h - rc, w + rc, -h);
  shape.lineTo(w + rc, h);
  shape.quadraticCurveTo(w + rc, h + rc, w, h + rc);
  shape.lineTo(-w, h + rc);
  shape.quadraticCurveTo(-w - rc, h + rc, -w - rc, h);
  shape.lineTo(-w - rc, -h);
  shape.quadraticCurveTo(-w - rc, -h - rc, -w, -h - rc);

  const hole = new THREE.Path();
  hole.absarc(0, 0, radius - b, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const core = depth - b * 2;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: core,
    bevelEnabled: true,
    bevelSize: b,
    bevelThickness: b,
    bevelSegments: 1,
    curveSegments: segments,
    steps: 1,
  });
  geometry.translate(0, 0, -core / 2);
  geometry.computeVertexNormals();
  tagExtrudedChamfers(geometry, core / 2, b, false);
  return geometry;
}

/** Cylinder aligned to the Z axis, which is the weapon's bore direction. */
export function tube(
  radiusTop: number,
  radiusBottom: number,
  length: number,
  radialSegments = 16,
  open = false
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    length,
    radialSegments,
    1,
    open
  );
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** A closed profile revolved about the Z axis. Points are (radius, z). */
export function lathe(
  points: readonly (readonly [number, number])[],
  segments = 20
): THREE.BufferGeometry {
  const geometry = new THREE.LatheGeometry(
    points.map(([r, z]) => new THREE.Vector2(r, z)),
    segments
  );
  geometry.rotateX(Math.PI / 2);
  return geometry;
}
