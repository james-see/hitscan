import * as THREE from 'three';
import type { SurfaceKind } from '@/types/gameplay.ts';
import type { WorldBuilder } from './Builder.ts';
import type { PropLibrary } from './Props.ts';
import { chamferBox, gablePrism } from './Geometry.ts';
import { PALETTE, type MaterialKey } from './Materials.ts';

/**
 * The modular kit.
 *
 * Each function here emits one reusable architectural assembly — a wall run
 * with openings, a stair flight, a railing, a lattice girder — rather than a
 * raw box. The arena is composed from these so that scale, trim depth and
 * weathering stay consistent everywhere, which is what makes a level read as
 * one building rather than a pile of props.
 */

/** Maps a point in a piece's local frame (u along, t across) into world x/z. */
export function localPoint(
  cx: number,
  cz: number,
  rotY: number,
  u: number,
  t: number
): [number, number] {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return [cx + u * c + t * s, cz - u * s + t * c];
}

export interface Opening {
  /** Centre along the wall, in the wall's local frame. */
  u: number;
  width: number;
  /** Height of the opening's bottom edge above the wall base. */
  sill: number;
  /** Height of the opening's top edge. */
  head: number;
  kind: 'door' | 'window' | 'bay';
  shutters?: boolean;
}

export interface WallOptions {
  cx: number;
  cz: number;
  rotY?: number;
  length: number;
  height: number;
  thickness: number;
  baseY?: number;
  material?: MaterialKey;
  tint?: THREE.Color;
  grime?: number;
  openings?: Opening[];
  /** Height of the projecting base course. 0 disables it. */
  plinth?: number;
  /** Projecting cap along the top. */
  coping?: boolean;
  /** Horizontal band part-way up, breaking the vertical run. */
  bandAt?: number;
  /** Pilaster spacing in metres. 0 disables them. */
  pilasterEvery?: number;
  /** Emit colliders. Interior partitions sometimes want them suppressed. */
  collide?: boolean;
  /**
   * Shifts the body's world-space texture projection. Two adjacent runs of the
   * same wall otherwise sample the identical patch of albedo, which is what
   * makes a modular perimeter read as one module copied along the horizon.
   */
  uvOffset?: [number, number];
}

const TRIM_TINT = PALETTE.concrete;

/**
 * A wall run with a real profile: projecting plinth, body, optional string
 * course and coping, pilasters, and framed openings with reveals, sills and
 * lintels. Openings are cut by emitting the surrounding panels, not by CSG.
 */
export function wall(b: WorldBuilder, o: WallOptions): void {
  const {
    cx,
    cz,
    rotY = 0,
    length,
    height,
    thickness,
    baseY = 0,
    material = 'plaster',
    tint = PALETTE.plasterWarm,
    grime = 0.28,
    openings = [],
    plinth = 0.5,
    coping = true,
    bandAt,
    pilasterEvery = 0,
    collide = true,
    uvOffset,
  } = o;

  const copingHeight = coping ? 0.34 : 0;
  const bodyTop = height - copingHeight;
  const surface: SurfaceKind | false = collide ? 'concrete' : false;

  const at = (u: number, t = 0): [number, number] => localPoint(cx, cz, rotY, u, t);

  const panel = (u0: number, u1: number, y0: number, y1: number): void => {
    const w = u1 - u0;
    const h = y1 - y0;
    if (w <= 0.01 || h <= 0.01) return;
    const [x, z] = at((u0 + u1) / 2);
    b.box({
      x,
      y: baseY + y0,
      z,
      w,
      h,
      d: thickness,
      rotY,
      material,
      tint,
      grime: y0 < 0.6 ? grime : grime * 0.35,
      grimeTop: baseY + Math.min(y1, y0 + 2.2),
      // Panels only have vertices at their corners, so this reads as a broad
      // patchy fade across each bay rather than per-pixel noise.
      mottle: 0.11,
      collide: surface,
      chamfer: 0.03,
      uv: uvOffset ? { mode: 'world', offset: uvOffset } : undefined,
    });
  };

  const sorted = [...openings].sort((a, c) => a.u - c.u);
  let cursor = -length / 2;
  for (const op of sorted) {
    const left = op.u - op.width / 2;
    const right = op.u + op.width / 2;
    panel(cursor, left, plinth, bodyTop);
    if (op.sill > plinth) panel(left, right, plinth, op.sill);
    if (op.head < bodyTop) panel(left, right, op.head, bodyTop);
    cursor = right;
    openingTrim(b, { cx, cz, rotY, baseY, thickness, op, material });
  }
  panel(cursor, length / 2, plinth, bodyTop);

  if (plinth > 0) {
    // The base course runs the length of the wall but breaks for anything the
    // player walks through, or every doorway would have a 0.5 m step.
    const cuts = sorted.filter((op) => op.kind !== 'window' && op.sill < plinth);
    let start = -length / 2;
    const segments: Array<[number, number]> = [];
    for (const op of cuts) {
      segments.push([start, op.u - op.width / 2]);
      start = op.u + op.width / 2;
    }
    segments.push([start, length / 2]);
    for (const [u0, u1] of segments) {
      if (u1 - u0 < 0.05) continue;
      const [x, z] = at((u0 + u1) / 2);
      b.box({
        x,
        y: baseY,
        z,
        w: u1 - u0,
        h: plinth,
        d: thickness + 0.22,
        rotY,
        material: 'trim',
        tint: TRIM_TINT,
        grime: 0.42,
        mottle: 0.05,
        collide: surface,
        chamfer: 0.05,
      });
    }
  }

  if (coping) {
    const [x, z] = at(0);
    b.box({
      x,
      y: baseY + bodyTop,
      z,
      w: length + 0.12,
      h: copingHeight,
      d: thickness + 0.34,
      rotY,
      material: 'trim',
      tint: TRIM_TINT,
      grime: 0.12,
      mottle: 0.05,
      collide: surface,
      chamfer: 0.06,
    });
  }

  if (bandAt !== undefined && bandAt > plinth && bandAt < bodyTop) {
    const [x, z] = at(0);
    b.box({
      x,
      y: baseY + bandAt,
      z,
      w: length,
      h: 0.17,
      d: thickness + 0.16,
      rotY,
      material: 'trim',
      tint: TRIM_TINT,
      grime: 0.18,
      collide: false,
      chamfer: 0.04,
    });
  }

  if (pilasterEvery > 0) {
    const count = Math.max(2, Math.round(length / pilasterEvery));
    for (let i = 0; i <= count; i++) {
      const u = -length / 2 + (length * i) / count;
      if (sorted.some((op) => Math.abs(op.u - u) < op.width / 2 + 0.5)) continue;
      const [x, z] = at(u);
      b.box({
        x,
        y: baseY,
        z,
        w: 0.92,
        h: bodyTop + copingHeight * 0.4,
        d: thickness + 0.82,
        rotY,
        material,
        tint,
        grime: grime * 1.15,
        mottle: 0.09,
        collide: surface,
        chamfer: 0.05,
      });
      // Cap and base block, which is what actually catches the sun and turns
      // a flat wall into a rhythm of light and shadow.
      b.box({
        x,
        y: baseY + bodyTop + copingHeight * 0.4,
        z,
        w: 1.14,
        h: 0.22,
        d: thickness + 1.06,
        rotY,
        material: 'trim',
        tint: TRIM_TINT,
        grime: 0.1,
        collide: false,
        chamfer: 0.05,
      });
      if (plinth > 0) {
        b.box({
          x,
          y: baseY,
          z,
          w: 1.14,
          h: plinth + 0.12,
          d: thickness + 1.06,
          rotY,
          material: 'trim',
          tint: TRIM_TINT,
          grime: 0.44,
          mottle: 0.06,
          collide: surface,
          chamfer: 0.05,
        });
      }
    }
  }
}

interface TrimOptions {
  cx: number;
  cz: number;
  rotY: number;
  baseY: number;
  thickness: number;
  op: Opening;
  material: MaterialKey;
}

/** Reveals, sill, lintel and shutters around a single opening. */
function openingTrim(b: WorldBuilder, o: TrimOptions): void {
  const { cx, cz, rotY, baseY, thickness, op } = o;
  const at = (u: number, t = 0): [number, number] => localPoint(cx, cz, rotY, u, t);
  const face = thickness / 2;
  const openHeight = op.head - op.sill;

  // Lintel: a deeper beam over the opening reads as structure carrying load.
  {
    const [x, z] = at(op.u, 0);
    b.box({
      x,
      y: baseY + op.head,
      z,
      w: op.width + 0.5,
      h: 0.26,
      d: thickness + 0.18,
      rotY,
      material: 'trim',
      tint: TRIM_TINT,
      grime: 0.14,
      collide: false,
      chamfer: 0.04,
    });
  }

  // Sill, sloped very slightly so it catches a different shade than the wall.
  if (op.kind !== 'door' && op.kind !== 'bay') {
    const [x, z] = at(op.u, face + 0.06);
    b.box({
      x,
      y: baseY + op.sill - 0.1,
      z,
      w: op.width + 0.42,
      h: 0.12,
      d: thickness * 0.55 + 0.3,
      rotY,
      material: 'trim',
      tint: TRIM_TINT,
      grime: 0.2,
      collide: false,
      chamfer: 0.035,
    });
  }

  // Jambs, set back from the face so the opening has visible depth.
  for (const side of [-1, 1]) {
    const [x, z] = at(op.u + side * (op.width / 2 - 0.05), 0);
    b.box({
      x,
      y: baseY + op.sill,
      z,
      w: 0.1,
      h: openHeight,
      d: thickness * 0.9,
      rotY,
      material: 'trim',
      tint: TRIM_TINT,
      grime: 0.25,
      collide: false,
      chamfer: 0.02,
    });
  }

  // Recessed dark panel: the interior seen through the opening. For windows it
  // also acts as the glass collider, so nothing can be walked through.
  if (op.kind === 'window') {
    const [x, z] = at(op.u, -face * 0.35);
    b.box({
      x,
      y: baseY + op.sill + 0.03,
      z,
      w: op.width - 0.12,
      h: openHeight - 0.06,
      d: 0.09,
      rotY,
      material: 'metal',
      tint: new THREE.Color(0.1, 0.11, 0.13),
      grime: 0,
      collide: 'glass',
      chamfer: 0.015,
    });
    // Muntin bars, so the glazing does not read as a black hole.
    const [mx, mz] = at(op.u, -face * 0.35 + 0.06);
    b.box({
      x: mx,
      y: baseY + op.sill + openHeight / 2 - 0.03,
      z: mz,
      w: op.width - 0.16,
      h: 0.06,
      d: 0.05,
      rotY,
      material: 'wood',
      tint: PALETTE.woodGrey,
      collide: false,
      chamfer: 0.015,
    });
    const [vx, vz] = at(op.u, -face * 0.35 + 0.06);
    b.box({
      x: vx,
      y: baseY + op.sill + 0.03,
      z: vz,
      w: 0.06,
      h: openHeight - 0.1,
      d: 0.05,
      rotY,
      material: 'wood',
      tint: PALETTE.woodGrey,
      collide: false,
      chamfer: 0.015,
    });
  }

  if (op.shutters) {
    const leaf = op.width * 0.48;
    for (const side of [-1, 1]) {
      // Hinged back against the façade, at a slight angle so they catch light.
      const swing = side * 0.28;
      const hingeU = op.u + side * (op.width / 2 + 0.04);
      const [hx, hz] = localPoint(
        cx,
        cz,
        rotY,
        hingeU + side * (leaf / 2) * Math.cos(swing),
        face + 0.06 + (leaf / 2) * Math.sin(Math.abs(swing))
      );
      b.box({
        x: hx,
        y: baseY + op.sill,
        z: hz,
        w: leaf,
        h: openHeight,
        d: 0.06,
        rotY: rotY + side * swing,
        material: 'wood',
        tint: PALETTE.tarpBlue,
        grime: 0.22,
        mottle: 0.05,
        collide: false,
        chamfer: 0.02,
      });
    }
  }
}

export interface PillarOptions {
  x: number;
  z: number;
  y?: number;
  height: number;
  width?: number;
  material?: MaterialKey;
  tint?: THREE.Color;
  /** Adds a flared base and capital. */
  classical?: boolean;
}

/** A column with a base and capital, so it does not read as a stretched cube. */
export function pillar(b: WorldBuilder, o: PillarOptions): void {
  const {
    x,
    z,
    y = 0,
    height,
    width = 0.52,
    material = 'trim',
    tint = TRIM_TINT,
    classical = true,
  } = o;
  const baseHeight = classical ? 0.22 : 0;
  const capHeight = classical ? 0.2 : 0;

  if (classical) {
    b.box({
      x,
      y,
      z,
      w: width + 0.26,
      h: baseHeight,
      d: width + 0.26,
      material,
      tint,
      grime: 0.4,
      chamfer: 0.05,
    });
  }
  b.box({
    x,
    y: y + baseHeight,
    z,
    w: width,
    h: height - baseHeight - capHeight,
    d: width,
    material,
    tint,
    grime: 0.3,
    mottle: 0.05,
    chamfer: 0.04,
  });
  if (classical) {
    b.box({
      x,
      y: y + height - capHeight,
      z,
      w: width + 0.3,
      h: capHeight,
      d: width + 0.3,
      material,
      tint,
      grime: 0.1,
      chamfer: 0.05,
      collide: false,
    });
  }
}

export interface StairOptions {
  /** Bottom-centre of the flight. */
  x: number;
  y?: number;
  z: number;
  /** Direction of ascent. 0 climbs toward +x. */
  rotY?: number;
  steps: number;
  rise: number;
  going: number;
  width: number;
  tint?: THREE.Color;
  handrail?: boolean;
}

/**
 * A stair flight built as real treads on stringers.
 *
 * Riser height is kept well under the character controller's auto-step so the
 * player walks up smoothly instead of catching on every nosing.
 */
export function stairRun(b: WorldBuilder, o: StairOptions): void {
  const {
    x,
    y = 0,
    z,
    rotY = 0,
    steps,
    rise,
    going,
    width,
    tint = TRIM_TINT,
    handrail = true,
  } = o;
  const run = steps * going;
  const at = (u: number, t = 0): [number, number] => localPoint(x, z, rotY, u, t);

  for (let i = 0; i < steps; i++) {
    const u = -run / 2 + going * (i + 0.5);
    const [sx, sz] = at(u);
    b.box({
      x: sx,
      y: y + i * rise,
      z: sz,
      w: going,
      h: rise,
      d: width,
      rotY,
      material: 'trim',
      tint,
      grime: 0.3,
      mottle: 0.05,
      chamfer: 0.02,
    });
    // Nosing: a lip on each tread, which is what makes a stair legible at
    // distance and in shadow.
    const [nx, nz] = at(u - going / 2 - 0.015);
    b.box({
      x: nx,
      y: y + (i + 1) * rise - 0.05,
      z: nz,
      w: 0.06,
      h: 0.05,
      d: width,
      rotY,
      material: 'trim',
      tint: PALETTE.concreteDark,
      collide: false,
      chamfer: 0.012,
    });
  }

  // Sloped stringers close the sides and hide the void beneath the treads.
  const slope = Math.atan2(steps * rise, run);
  const diagonal = Math.hypot(run, steps * rise);
  for (const side of [-1, 1]) {
    const [px, pz] = at(0, side * (width / 2 + 0.09));
    b.box({
      x: px,
      y: y + (steps * rise) / 2 - 0.24,
      z: pz,
      w: diagonal + 0.2,
      h: 0.42,
      d: 0.18,
      rotY,
      tiltZ: slope,
      material: 'trim',
      tint: PALETTE.concreteDark,
      grime: 0.35,
      chamfer: 0.03,
      collide: 'concrete',
    });
  }

  if (handrail) {
    for (const side of [-1, 1]) {
      const [px, pz] = at(0, side * (width / 2 + 0.09));
      b.box({
        x: px,
        y: y + (steps * rise) / 2 + 0.78,
        z: pz,
        w: diagonal,
        h: 0.07,
        d: 0.07,
        rotY,
        tiltZ: slope,
        material: 'metal',
        tint: PALETTE.steelRust,
        collide: false,
        chamfer: 0.02,
      });
      const posts = Math.max(2, Math.round(run / 1.3));
      for (let i = 0; i <= posts; i++) {
        const u = -run / 2 + (run * i) / posts;
        const stepIndex = Math.min(steps - 1, Math.floor((u + run / 2) / going));
        const [qx, qz] = at(u, side * (width / 2 + 0.09));
        b.box({
          x: qx,
          y: y + stepIndex * rise,
          z: qz,
          w: 0.06,
          h: 1.0 + (u + run / 2) * Math.tan(slope) - stepIndex * rise,
          d: 0.06,
          rotY,
          material: 'metal',
          tint: PALETTE.steelRust,
          collide: false,
          chamfer: 0.015,
        });
      }
    }
  }
}

export interface RailingOptions {
  cx: number;
  cz: number;
  y: number;
  length: number;
  rotY?: number;
  height?: number;
  tint?: THREE.Color;
  postSpacing?: number;
}

/**
 * A steel guardrail. Posts are instanced; rails are merged into the static
 * batch because a single long box is cheaper than many short ones.
 */
export function railing(
  b: WorldBuilder,
  props: PropLibrary,
  o: RailingOptions
): void {
  const {
    cx,
    cz,
    y,
    length,
    rotY = 0,
    height = 1.06,
    tint = PALETTE.steelRust,
    postSpacing = 1.5,
  } = o;

  const count = Math.max(2, Math.round(length / postSpacing));
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
  const scale = new THREE.Vector3(1, height / 1.06, 1);
  for (let i = 0; i <= count; i++) {
    const u = -length / 2 + (length * i) / count;
    const [px, pz] = localPoint(cx, cz, rotY, u, 0);
    matrix.compose(new THREE.Vector3(px, y, pz), quaternion, scale);
    props.place('railPost', matrix, tint);
  }

  for (const railY of [height - 0.05, height * 0.55]) {
    b.box({
      x: cx,
      y: y + railY,
      z: cz,
      w: length,
      h: 0.07,
      d: 0.05,
      rotY,
      material: 'metal',
      tint,
      collide: false,
      chamfer: 0.018,
      uv: { mode: 'world', rotate: true },
    });
  }
  // Toe board, and the single collider that keeps the player on the deck.
  b.box({
    x: cx,
    y: y + 0.02,
    z: cz,
    w: length,
    h: 0.16,
    d: 0.05,
    rotY,
    material: 'metal',
    tint,
    grime: 0.3,
    collide: false,
    chamfer: 0.015,
  });
  b.solid(
    new THREE.Vector3(cx, y + height / 2, cz),
    new THREE.Vector3(length / 2, height / 2, 0.07),
    'metal',
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0))
  );
}

export interface PipeRunOptions {
  /** Start and end of the run. Only straight axis-aligned runs are supported. */
  from: THREE.Vector3;
  to: THREE.Vector3;
  radius?: number;
  tint?: THREE.Color;
  /** Bracket spacing in metres. 0 disables them. */
  bracketEvery?: number;
  collide?: boolean;
}

/** A pipe with flange joints and wall brackets. */
export function pipeRun(b: WorldBuilder, o: PipeRunOptions): void {
  const { from, to, radius = 0.09, tint = PALETTE.steelRust, bracketEvery = 2.4, collide = false } = o;
  const delta = new THREE.Vector3().subVectors(to, from);
  const length = delta.length();
  if (length < 0.05) return;
  const direction = delta.clone().normalize();
  const centre = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);

  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction
  );
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 12, 1, false);
  const matrix = new THREE.Matrix4().compose(centre, quaternion, ONE);
  b.add(geometry, matrix, {
    material: 'metal',
    tint,
    grime: 0.25,
    uv: { mode: 'local', repeat: [(2 * Math.PI * radius) / 2.5, length / 2.5] },
  });

  const flange = new THREE.CylinderGeometry(radius * 1.35, radius * 1.35, 0.07, 12, 1, false);
  const joints = Math.max(1, Math.floor(length / 2.6));
  for (let i = 1; i <= joints; i++) {
    const t = i / (joints + 1);
    const p = new THREE.Vector3().lerpVectors(from, to, t);
    b.add(flange, new THREE.Matrix4().compose(p, quaternion, ONE), {
      material: 'metal',
      tint,
      uv: { mode: 'local', repeat: [(2 * Math.PI * radius * 1.35) / 2.5, 0.05] },
    });
  }

  if (bracketEvery > 0) {
    const brackets = Math.max(1, Math.round(length / bracketEvery));
    const up = Math.abs(direction.y) > 0.7;
    for (let i = 0; i <= brackets; i++) {
      const p = new THREE.Vector3().lerpVectors(from, to, i / brackets);
      b.box({
        x: p.x,
        y: p.y - radius * 1.8,
        z: p.z,
        w: up ? radius * 3.4 : 0.06,
        h: radius * 3.6,
        d: up ? 0.06 : radius * 3.4,
        material: 'metal',
        tint: PALETTE.steel,
        collide: false,
        chamfer: 0.012,
      });
    }
  }

  if (collide) {
    b.solid(
      centre,
      new THREE.Vector3(
        Math.max(radius, (Math.abs(delta.x) / 2) | 0 || radius),
        Math.max(radius, Math.abs(delta.y) / 2),
        Math.max(radius, Math.abs(delta.z) / 2)
      ),
      'metal'
    );
  }
}

const ONE = new THREE.Vector3(1, 1, 1);

export interface RoofOptions {
  cx: number;
  cz: number;
  /** Height of the eaves. */
  y: number;
  /** Span across the slope direction. */
  span: number;
  /** Length along the ridge. */
  length: number;
  /** Height of the ridge above the eaves. */
  peak: number;
  rotY?: number;
  overhang?: number;
  tint?: THREE.Color;
  /** Fills the gable triangles with plaster. */
  gables?: boolean;
  gableTint?: THREE.Color;
}

/**
 * A pitched corrugated roof with eaves, a ridge cap and optional gable infill.
 * A sloped roofline is the cheapest way to stop a building reading as a box.
 */
export function pitchedRoof(b: WorldBuilder, o: RoofOptions): void {
  const {
    cx,
    cz,
    y,
    span,
    length,
    peak,
    rotY = 0,
    overhang = 0.42,
    tint = PALETTE.steel,
    gables = true,
    gableTint = PALETTE.plasterWarm,
  } = o;

  const halfSpan = span / 2;
  const slope = Math.atan2(peak, halfSpan);
  const sheetLength = Math.hypot(halfSpan, peak) + overhang;
  const thickness = 0.12;
  const halfSheet = sheetLength / 2;

  for (const side of [-1, 1]) {
    // Local frame: the ridge runs along the piece's u axis, so each sheet is a
    // slab tilted about that axis, centred half a sheet down from the ridge.
    const midT = side * halfSheet * Math.cos(slope);
    const midY = y + peak - halfSheet * Math.sin(slope);
    const [px, pz] = localPoint(cx, cz, rotY, 0, midT);
    b.box({
      x: px,
      y: midY - thickness / 2,
      z: pz,
      w: length + overhang * 2,
      h: thickness,
      d: sheetLength,
      rotY,
      tiltX: side * slope,
      material: 'metal',
      tint,
      grime: 0.12,
      mottle: 0.06,
      chamfer: 0.03,
      collide: 'metal',
      uv: { mode: 'world', rotate: true },
    });
    // Fascia board closing the eaves, seen from below on every approach.
    const eaveT = side * (halfSpan + overhang * Math.cos(slope));
    const [fx, fz] = localPoint(cx, cz, rotY, 0, eaveT);
    b.box({
      x: fx,
      y: y - overhang * Math.sin(slope) - 0.24,
      z: fz,
      w: length + overhang * 2,
      h: 0.2,
      d: 0.1,
      rotY,
      material: 'metal',
      tint: PALETTE.steel,
      grime: 0.18,
      collide: false,
      chamfer: 0.025,
    });
  }

  // Ridge cap.
  {
    const [px, pz] = localPoint(cx, cz, rotY, 0, 0);
    b.box({
      x: px,
      y: y + peak + 0.02,
      z: pz,
      w: length + overhang * 2 + 0.1,
      h: 0.14,
      d: 0.34,
      rotY,
      material: 'metal',
      tint: PALETTE.steelRust,
      collide: false,
      chamfer: 0.04,
    });
  }

  if (gables) {
    const prism = gablePrism(span - 0.1, peak, 0.24);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
    for (const end of [-1, 1]) {
      const [px, pz] = localPoint(cx, cz, rotY, end * (length / 2 - 0.12), 0);
      b.add(
        prism,
        new THREE.Matrix4().compose(new THREE.Vector3(px, y - 0.05, pz), quaternion, ONE),
        { material: 'plaster', tint: gableTint, grime: 0.12, mottle: 0.05 }
      );
      b.solid(
        new THREE.Vector3(px, y + peak * 0.3, pz),
        new THREE.Vector3(0.13, peak * 0.32, span * 0.3),
        'concrete',
        quaternion
      );
    }
  }
}

export interface ContainerOptions {
  x: number;
  y?: number;
  z: number;
  rotY?: number;
  length?: number;
  tint?: THREE.Color;
}

/**
 * A shipping container: ribbed flanks, corner castings, a raised roof lip and
 * a door end with locking bars. Eight of these were plain boxes before.
 */
export function shippingContainer(b: WorldBuilder, o: ContainerOptions): void {
  const { x, y = 0, z, rotY = 0, length = 6.06, tint = PALETTE.steelBlue } = o;
  const width = 2.44;
  const height = 2.59;
  const at = (u: number, t = 0): [number, number] => localPoint(x, z, rotY, u, t);

  b.box({
    x,
    y,
    z,
    w: length,
    h: height,
    d: width,
    rotY,
    material: 'metal',
    tint,
    grime: 0.34,
    mottle: 0.05,
    chamfer: 0.05,
    collide: 'metal',
  });

  // A few structural ribs for silhouette. The fine corrugation is already in
  // the normal map, so these are spaced wide — closer together they beat
  // against the texture and the flank turns into a barcode.
  const ribs = Math.max(1, Math.floor(length / 1.5));
  for (let i = 0; i <= ribs; i++) {
    const u = -length / 2 + 0.45 + (i * (length - 0.9)) / Math.max(1, ribs);
    for (const side of [-1, 1]) {
      const [px, pz] = at(u, side * (width / 2 + 0.015));
      b.box({
        x: px,
        y: y + 0.16,
        z: pz,
        w: 0.1,
        h: height - 0.34,
        d: 0.035,
        rotY,
        material: 'metal',
        tint,
        grime: 0.22,
        collide: false,
        chamfer: 0.01,
      });
    }
  }

  // Top and bottom rails plus corner castings.
  for (const side of [-1, 1]) {
    const [px, pz] = at(0, side * (width / 2 + 0.03));
    for (const railY of [0.02, height - 0.16]) {
      b.box({
        x: px,
        y: y + railY,
        z: pz,
        w: length + 0.04,
        h: 0.16,
        d: 0.1,
        rotY,
        material: 'metal',
        tint: PALETTE.steel,
        grime: railY < 0.5 ? 0.4 : 0.1,
        collide: false,
        chamfer: 0.02,
      });
    }
  }
  for (const su of [-1, 1]) {
    for (const st of [-1, 1]) {
      for (const sy of [0, height - 0.26]) {
        const [px, pz] = at(su * (length / 2 - 0.09), st * (width / 2 - 0.06));
        b.box({
          x: px,
          y: y + sy,
          z: pz,
          w: 0.3,
          h: 0.26,
          d: 0.24,
          rotY,
          material: 'metal',
          tint: PALETTE.steel,
          grime: 0.3,
          collide: false,
          chamfer: 0.03,
        });
      }
    }
  }

  // Door end: four leaves with vertical locking bars and handles.
  const [dx, dz] = at(length / 2 + 0.03, 0);
  for (let i = 0; i < 4; i++) {
    const t = -width / 2 + width * ((i + 0.5) / 4);
    const [bx, bz] = at(length / 2 + 0.08, t);
    b.box({
      x: bx,
      y: y + 0.24,
      z: bz,
      w: 0.07,
      h: height - 0.5,
      d: 0.07,
      rotY,
      material: 'metal',
      tint: PALETTE.steelRust,
      grime: 0.3,
      collide: false,
      chamfer: 0.015,
    });
  }
  b.box({
    x: dx,
    y: y + 0.2,
    z: dz,
    w: 0.06,
    h: height - 0.42,
    d: width - 0.14,
    rotY,
    material: 'metal',
    tint: tint.clone().multiplyScalar(0.92),
    grime: 0.3,
    collide: false,
    chamfer: 0.02,
  });
}

export interface AwningOptions {
  cx: number;
  cz: number;
  y: number;
  width: number;
  depth: number;
  rotY?: number;
  /** Drop of the outer edge below the inner edge. */
  fall?: number;
  tint?: THREE.Color;
  posts?: boolean;
}

/** A lean-to canopy over a doorway or stall, with struts or posts. */
export function awning(b: WorldBuilder, o: AwningOptions): void {
  const { cx, cz, y, width, depth, rotY = 0, fall = 0.34, tint = PALETTE.steelRust, posts = false } = o;
  const slope = Math.atan2(fall, depth);
  const [px, pz] = localPoint(cx, cz, rotY, 0, depth / 2);
  b.box({
    x: px,
    y: y - fall / 2,
    z: pz,
    w: width,
    h: 0.08,
    d: Math.hypot(depth, fall),
    rotY,
    tiltX: -slope,
    material: 'metal',
    tint,
    grime: 0.1,
    mottle: 0.06,
    collide: false,
    chamfer: 0.025,
    uv: { mode: 'world', rotate: true },
  });
  // Fascia along the leading edge.
  const [fx, fz] = localPoint(cx, cz, rotY, 0, depth);
  b.box({
    x: fx,
    y: y - fall - 0.1,
    z: fz,
    w: width,
    h: 0.14,
    d: 0.07,
    rotY,
    material: 'metal',
    tint: PALETTE.steel,
    collide: false,
    chamfer: 0.02,
  });

  const supports = Math.max(2, Math.round(width / 2.2));
  for (let i = 0; i <= supports; i++) {
    const u = -width / 2 + (width * i) / supports;
    if (posts) {
      const [qx, qz] = localPoint(cx, cz, rotY, u, depth - 0.1);
      b.box({
        x: qx,
        y: 0,
        z: qz,
        w: 0.11,
        h: y - fall - 0.1,
        d: 0.11,
        rotY,
        material: 'wood',
        tint: PALETTE.woodGrey,
        grime: 0.35,
        chamfer: 0.02,
        collide: 'wood',
      });
    } else {
      // Diagonal strut from the wall to the canopy's outer edge.
      const [qx, qz] = localPoint(cx, cz, rotY, u, depth * 0.5);
      const drop = 0.62;
      b.box({
        x: qx,
        y: y - fall * 0.5 - drop / 2,
        z: qz,
        w: 0.05,
        h: 0.05,
        d: Math.hypot(depth, drop),
        rotY,
        tiltX: -Math.atan2(drop, depth),
        material: 'metal',
        tint: PALETTE.steelRust,
        collide: false,
        chamfer: 0.012,
      });
    }
  }
}

export interface LatticeOptions {
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Width and height of the girder's cross-section. */
  size: number;
  chordRadius?: number;
  tint?: THREE.Color;
  /** Number of diagonal web panels. */
  panels?: number;
}

/**
 * A four-chord lattice girder.
 *
 * Open steelwork gives the arena a strong, readable silhouette against the sky
 * that no solid volume can, and it costs almost nothing because every member
 * merges into the metal batch.
 */
export function latticeGirder(b: WorldBuilder, o: LatticeOptions): void {
  const { from, to, size, chordRadius = 0.075, tint = PALETTE.steelRust, panels = 8 } = o;
  const axis = new THREE.Vector3().subVectors(to, from);
  const length = axis.length();
  const direction = axis.clone().normalize();

  // Build an orthonormal frame around the girder's axis.
  const up = Math.abs(direction.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(direction, up).normalize();
  const top = new THREE.Vector3().crossVectors(right, direction).normalize();

  const half = size / 2;
  const corners = [
    new THREE.Vector3().addScaledVector(right, half).addScaledVector(top, half),
    new THREE.Vector3().addScaledVector(right, -half).addScaledVector(top, half),
    new THREE.Vector3().addScaledVector(right, -half).addScaledVector(top, -half),
    new THREE.Vector3().addScaledVector(right, half).addScaledVector(top, -half),
  ];

  const member = (a: THREE.Vector3, c: THREE.Vector3, radius: number): void => {
    const delta = new THREE.Vector3().subVectors(c, a);
    const len = delta.length();
    if (len < 0.02) return;
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      delta.clone().normalize()
    );
    const centre = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
    b.add(
      new THREE.CylinderGeometry(radius, radius, len, 8, 1, false),
      new THREE.Matrix4().compose(centre, quaternion, ONE),
      {
        material: 'metal',
        tint,
        grime: 0.16,
        uv: { mode: 'local', repeat: [(2 * Math.PI * radius) / 2.5, len / 2.5] },
      }
    );
  };

  for (const corner of corners) {
    member(from.clone().add(corner), to.clone().add(corner), chordRadius);
  }

  const step = length / panels;
  for (let i = 0; i <= panels; i++) {
    const p = from.clone().addScaledVector(direction, i * step);
    for (let k = 0; k < 4; k++) {
      member(p.clone().add(corners[k]), p.clone().add(corners[(k + 1) % 4]), chordRadius * 0.62);
    }
    if (i < panels) {
      const q = from.clone().addScaledVector(direction, (i + 1) * step);
      // Alternating diagonals form the classic zig-zag web.
      const a = i % 2 === 0 ? 0 : 1;
      member(p.clone().add(corners[a]), q.clone().add(corners[(a + 1) % 4]), chordRadius * 0.55);
      member(p.clone().add(corners[a + 2]), q.clone().add(corners[(a + 3) % 4]), chordRadius * 0.55);
    }
  }
}

export interface SlabFieldOptions {
  cx: number;
  cz: number;
  /** Top surface height. Slabs are built downward from here. */
  y: number;
  w: number;
  d: number;
  thickness?: number;
  cols?: number;
  rows?: number;
  /** Width of the expansion joint between bays. */
  joint?: number;
  tint?: THREE.Color;
  material?: MaterialKey;
}

/**
 * A cast concrete surface poured in bays.
 *
 * A single slab the size of a platform deck shows its texture repeat from
 * anywhere on it. Splitting it into jointed bays, each with its own texture
 * offset and a shade of its own, hides the repeat behind real construction
 * logic and adds a grid of contact shadows into the bargain.
 */
export function slabField(
  b: WorldBuilder,
  rng: { range(min: number, max: number): number },
  o: SlabFieldOptions
): void {
  const {
    cx,
    cz,
    y,
    w,
    d,
    thickness = 0.3,
    cols = 4,
    rows = 3,
    tint = TRIM_TINT,
    material = 'trim',
  } = o;
  const joint = o.joint ?? 0.05;
  const bayW = (w - joint * (cols - 1)) / cols;
  const bayD = (d - joint * (rows - 1)) / rows;

  for (let i = 0; i < cols; i++) {
    for (let k = 0; k < rows; k++) {
      const x = cx - w / 2 + bayW / 2 + i * (bayW + joint);
      const z = cz - d / 2 + bayD / 2 + k * (bayD + joint);
      b.box({
        x,
        y: y - thickness,
        z,
        w: bayW,
        h: thickness,
        d: bayD,
        material,
        tint: tint.clone().multiplyScalar(rng.range(0.9, 1.06)),
        grime: 0.16,
        mottle: 0.1,
        chamfer: 0.025,
        // Every bay samples a different part of the texture, so no two are
        // recognisably the same pour.
        uv: { mode: 'world', offset: [rng.range(0, 6), rng.range(0, 6)] },
      });
    }
  }
}

/** A single tubular member between two points. Used for bracing and cables. */
export function strut(
  b: WorldBuilder,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  tint: THREE.Color = PALETTE.steelRust,
  material: MaterialKey = 'metal'
): void {
  const delta = new THREE.Vector3().subVectors(to, from);
  const length = delta.length();
  if (length < 0.02) return;
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    delta.clone().normalize()
  );
  const centre = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  b.add(
    new THREE.CylinderGeometry(radius, radius, length, 7, 1, false),
    new THREE.Matrix4().compose(centre, quaternion, ONE),
    {
      material,
      tint,
      grime: 0.15,
      uv: { mode: 'local', repeat: [(2 * Math.PI * radius) / 2.5, length / 2.5] },
    }
  );
}

export interface CulvertOptions {
  /** Centre of the pipe. The bore runs along local +x before yaw. */
  x: number;
  y: number;
  z: number;
  rotY?: number;
  outer?: number;
  bore?: number;
  length?: number;
  tint?: THREE.Color;
}

/**
 * A precast concrete culvert section.
 *
 * Stacked in a pyramid these are one of the few yard props that read at a
 * hundred metres: a strong circular silhouette against a flat sky, with a
 * genuinely dark hole in it. The bore is faked with a recessed dark core
 * rather than a real tube, which halves the triangle count and avoids
 * needing double-sided material.
 */
export function culvert(b: WorldBuilder, o: CulvertOptions): void {
  const {
    x,
    y,
    z,
    rotY = 0,
    outer = 0.66,
    bore = 0.48,
    length = 1.9,
    tint = PALETTE.concrete,
  } = o;

  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, Math.PI / 2));
  const centre = new THREE.Vector3(x, y, z);
  const matrix = new THREE.Matrix4().compose(centre, quaternion, ONE);

  b.add(new THREE.CylinderGeometry(outer, outer, length, 20, 1, true), matrix, {
    material: 'trim',
    tint,
    grime: 0.4,
    grimeTop: y + outer,
    mottle: 0.1,
    uv: { mode: 'local', repeat: [(2 * Math.PI * outer) / 2.2, length / 2.2] },
  });
  // Collar bands at the spigot ends, which is what stops it reading as a can.
  for (const end of [-1, 1]) {
    const p = new THREE.Vector3(0, (end * (length - 0.18)) / 2, 0).applyQuaternion(quaternion).add(centre);
    b.add(
      new THREE.CylinderGeometry(outer * 1.07, outer * 1.07, 0.18, 20, 1, true),
      new THREE.Matrix4().compose(p, quaternion, ONE),
      {
        material: 'trim',
        tint,
        grime: 0.45,
        grimeTop: y + outer,
        uv: { mode: 'local', repeat: [(2 * Math.PI * outer) / 2.2, 0.1] },
      }
    );
    // Annulus face between bore and wall.
    const ring = new THREE.RingGeometry(bore, outer * 1.07, 20);
    ring.rotateX(end > 0 ? -Math.PI / 2 : Math.PI / 2);
    const rp = new THREE.Vector3(0, (end * length) / 2, 0).applyQuaternion(quaternion).add(centre);
    b.add(ring, new THREE.Matrix4().compose(rp, quaternion, ONE), {
      material: 'trim',
      tint,
      grime: 0.5,
      grimeTop: y + outer,
      uv: { mode: 'local', repeat: [outer / 1.4, outer / 1.4] },
    });
  }
  // Recessed core standing in for the bore.
  b.add(new THREE.CylinderGeometry(bore, bore, length - 0.5, 16, 1, false), matrix, {
    material: 'trim',
    tint: tint.clone().multiplyScalar(0.3),
    grime: 0.2,
    grimeTop: y + bore,
    uv: { mode: 'local', repeat: [(2 * Math.PI * bore) / 2.2, length / 2.2] },
  });

  const half = new THREE.Vector3(length / 2, outer, outer);
  b.colliders.push({
    kind: 'box',
    position: centre.clone(),
    halfExtents: half,
    rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)),
    surface: 'concrete',
  });
}

export interface CableOptions {
  from: THREE.Vector3;
  to: THREE.Vector3;
  sag: number;
  radius?: number;
  segments?: number;
  tint?: THREE.Color;
  /** Emissive bulbs hung along the span. */
  bulbs?: number;
  bulbColor?: THREE.Color;
}

/**
 * A sagging cable, approximated by straight segments along a parabola.
 *
 * Overhead lines strung between buildings do more for the "inhabited" read of
 * a courtyard than almost any ground clutter, because they cut across empty
 * sky in every wide shot.
 */
export function cable(b: WorldBuilder, props: PropLibrary, o: CableOptions): void {
  const {
    from,
    to,
    sag,
    radius = 0.022,
    segments = 8,
    tint = new THREE.Color(0.2, 0.19, 0.18),
    bulbs = 0,
    bulbColor = new THREE.Color(1.0, 0.72, 0.42),
  } = o;

  const point = (t: number): THREE.Vector3 => {
    const p = new THREE.Vector3().lerpVectors(from, to, t);
    p.y -= sag * 4 * t * (1 - t);
    return p;
  };

  for (let i = 0; i < segments; i++) {
    strut(b, point(i / segments), point((i + 1) / segments), radius, tint);
  }

  const matrix = new THREE.Matrix4();
  const identity = new THREE.Quaternion();
  const bulbScale = new THREE.Vector3(0.09, 0.12, 0.09);
  for (let i = 0; i < bulbs; i++) {
    const t = (i + 0.5) / bulbs;
    const p = point(t);
    strut(b, p, p.clone().add(new THREE.Vector3(0, -0.16, 0)), 0.012, tint);
    matrix.compose(p.clone().add(new THREE.Vector3(0, -0.24, 0)), identity, bulbScale);
    props.place('lampLens', matrix, bulbColor);
  }
}

/** Prop names the sandbag variants are registered under. */
export const SANDBAG_NAMES = ['sandbag', 'sandbagB', 'sandbagC'] as const;

export interface SandbagWallOptions {
  cx: number;
  cz: number;
  rotY?: number;
  length: number;
  rows?: number;
  tint?: THREE.Color;
  /** Level the bottom course sits on. */
  baseY?: number;
}

/** A stacked sandbag emplacement with one box collider for the whole wall. */
export function sandbagWall(
  b: WorldBuilder,
  props: PropLibrary,
  rng: { range(min: number, max: number): number },
  o: SandbagWallOptions
): void {
  const { cx, cz, rotY = 0, length, rows = 3, tint = PALETTE.sand, baseY = 0 } = o;
  const bagLength = 0.44;
  const bagHeight = 0.17;
  const bagDepth = 0.32;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();

  let variant = 0;
  for (let row = 0; row < rows; row++) {
    // Each course steps back slightly and is offset half a bag, like real work.
    const perRow = Math.max(1, Math.floor(length / bagLength));
    const offset = row % 2 === 0 ? 0 : bagLength / 2;
    for (let i = 0; i <= perRow; i++) {
      const u = -length / 2 + offset + i * bagLength;
      if (u < -length / 2 - 0.05 || u > length / 2 + 0.05) continue;
      const [px, pz] = localPoint(cx, cz, rotY, u, rng.range(-0.04, 0.04));
      euler.set(rng.range(-0.07, 0.07), rotY + rng.range(-0.16, 0.16), rng.range(-0.09, 0.09));
      quaternion.setFromEuler(euler);
      const s = rng.range(0.9, 1.1);
      // Divided through by the bag's own extents so one bag occupies one course
      // position: scaling by the spacing directly stretched each bag over its
      // neighbours and the wall read as a single extruded sausage. The extra
      // width and squat height are the bags pressing against each other.
      const squeeze = rng.range(0.94, 1.12);
      scale.set(
        (bagLength * 1.04 * s * squeeze) / SANDBAG_EXTENTS.x,
        (bagHeight * 1.9 * s) / (SANDBAG_EXTENTS.y * squeeze),
        (bagDepth * s * rng.range(0.92, 1.08)) / SANDBAG_EXTENTS.z
      );
      matrix.compose(
        new THREE.Vector3(
          px,
          baseY + bagHeight / 2 + row * bagHeight * 0.94 + rng.range(-0.012, 0.012),
          pz
        ),
        quaternion,
        scale
      );
      // Hue as well as value: a real stack has bags from several deliveries,
      // some sun-bleached and some still damp from the last one. The range runs
      // well below the nominal tint rather than around it — from any distance
      // where the weave has mipped away, this spread is the only thing keeping
      // the stack from reading as one pale extruded mass.
      colour.copy(tint).multiplyScalar(rng.range(0.5, 1.08));
      colour.r *= rng.range(0.92, 1.07);
      colour.b *= rng.range(0.82, 1.1);
      props.place(SANDBAG_NAMES[variant % SANDBAG_VARIANTS], matrix, colour);
      variant++;
    }
    // Stepping the variant by two per course stops the checkerboard the plain
    // running count produces against a half-bag row offset.
    variant++;
  }

  const height = rows * bagHeight * 0.94;
  b.solid(
    new THREE.Vector3(cx, baseY + height / 2, cz),
    new THREE.Vector3(length / 2, height / 2, bagDepth / 2),
    'sand',
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0))
  );
}

export interface ShelfRackOptions {
  cx: number;
  cz: number;
  rotY?: number;
  length: number;
  depth?: number;
  levels?: number;
  height?: number;
}

/** Warehouse racking: steel uprights with timber decks. */
export function shelfRack(b: WorldBuilder, o: ShelfRackOptions): void {
  const { cx, cz, rotY = 0, length, depth = 1.0, levels = 3, height = 3.4 } = o;
  const uprights = Math.max(2, Math.round(length / 2.2));
  for (let i = 0; i <= uprights; i++) {
    const u = -length / 2 + (length * i) / uprights;
    for (const side of [-1, 1]) {
      const [px, pz] = localPoint(cx, cz, rotY, u, side * (depth / 2 - 0.05));
      b.box({
        x: px,
        y: 0,
        z: pz,
        w: 0.09,
        h: height,
        d: 0.09,
        rotY,
        material: 'metal',
        tint: PALETTE.steelRed,
        grime: 0.3,
        chamfer: 0.015,
        collide: 'metal',
      });
    }
  }
  for (let level = 1; level <= levels; level++) {
    const y = (height * level) / (levels + 0.4);
    const [px, pz] = localPoint(cx, cz, rotY, 0, 0);
    b.box({
      x: px,
      y,
      z: pz,
      w: length,
      h: 0.05,
      d: depth,
      rotY,
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.2,
      chamfer: 0.015,
      collide: 'wood',
    });
    for (const side of [-1, 1]) {
      const [bx, bz] = localPoint(cx, cz, rotY, 0, side * (depth / 2 - 0.05));
      b.box({
        x: bx,
        y: y - 0.11,
        z: bz,
        w: length,
        h: 0.11,
        d: 0.06,
        rotY,
        material: 'metal',
        tint: PALETTE.steelRed,
        collide: false,
        chamfer: 0.015,
      });
    }
  }
}

/** A slatted crate: six panels of boards with corner battens. */
export function crateGeometry(size: number, tall = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const height = tall ? size * 1.55 : size;
  const batten = 0.075;
  const board = 0.05;

  const push = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number
  ): void => {
    const g = chamferBox(w, h, d, 0.012).clone();
    g.translate(x, y, z);
    parts.push(g);
  };

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      push(batten, height, batten, (sx * (size - batten)) / 2, 0, (sz * (size - batten)) / 2);
    }
  }
  // Face boards, with a gap between them so light reads through the slats.
  const rows = tall ? 4 : 3;
  for (let i = 0; i < rows; i++) {
    const y = -height / 2 + (height * (i + 0.5)) / rows;
    const h = (height / rows) * 0.74;
    push(size - batten * 2, h, board, 0, y, (size - board) / 2);
    push(size - batten * 2, h, board, 0, y, -(size - board) / 2);
    push(board, h, size - batten * 2, (size - board) / 2, y, 0);
    push(board, h, size - batten * 2, -(size - board) / 2, y, 0);
  }
  push(size, board, size, 0, (height - board) / 2, 0);
  push(size - 0.1, board, size - 0.1, 0, -(height - board) / 2, 0);

  return mergeParts(parts);
}

/** A barrel: tapered body, two rolling hoops and a rimmed lid. */
export function barrelGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = 0.29;
  const h = 0.88;
  parts.push(new THREE.CylinderGeometry(r * 0.94, r * 0.94, h, 18, 1, false));
  for (const y of [-h * 0.28, h * 0.28]) {
    const hoop = new THREE.CylinderGeometry(r, r, 0.07, 18, 1, false);
    hoop.translate(0, y, 0);
    parts.push(hoop);
  }
  const lid = new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.05, 18, 1, false);
  lid.translate(0, h / 2 + 0.01, 0);
  parts.push(lid);
  const bung = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 8, 1, false);
  bung.translate(r * 0.5, h / 2 + 0.04, 0);
  parts.push(bung);
  return mergeParts(parts);
}

/** A stringer pallet: three bearers and seven deck boards. */
export function palletGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const w = 1.2;
  const d = 0.8;
  const push = (bw: number, bh: number, bd: number, x: number, y: number, z: number): void => {
    const g = chamferBox(bw, bh, bd, 0.008).clone();
    g.translate(x, y, z);
    parts.push(g);
  };
  for (const z of [-d / 2 + 0.05, 0, d / 2 - 0.05]) push(w, 0.09, 0.1, 0, 0.045, z);
  for (let i = 0; i < 6; i++) {
    push(w, 0.022, 0.1, 0, 0.101, -d / 2 + 0.05 + (i * (d - 0.1)) / 5);
  }
  for (let i = 0; i < 3; i++) {
    push(w, 0.022, 0.11, 0, -0.011, -d / 2 + 0.055 + (i * (d - 0.11)) / 2);
  }
  return mergeParts(parts);
}

/** Full size of every `sandbagGeometry` variant, before any instance scale. */
export const SANDBAG_EXTENTS = { x: 1.35, y: 0.44, z: 0.82 };

/** How many distinct sandbag shapes the kit builds. */
export const SANDBAG_VARIANTS = 3;

/**
 * A slumped sandbag.
 *
 * Each variant is a different lump: the seam runs at a different angle, the
 * fill has settled to a different side and the underside is flattened by a
 * different amount, so a course of them does not read as one primitive
 * stamped along a line. Every variant is normalised back to the same extents
 * afterwards, so the wall builder can place them interchangeably.
 */
export function sandbagGeometry(seed: number, slump = 1): THREE.BufferGeometry {
  // Smooth-shaded and finely segmented, unlike every other prop in the kit:
  // the woven normal map carries the surface now, and against it the coarse
  // facets of a low-segment sphere read as a cut gemstone rather than cloth.
  const g = new THREE.SphereGeometry(0.5, 14, 9);
  const position = g.getAttribute('position');
  const v = new THREE.Vector3();
  const lean = Math.sin(seed * 1.7) * 0.16;
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    // Flatten into a pillow and pinch the ends into seams.
    v.y *= 0.44;
    v.x *= 1.35 - 0.3 * Math.abs(v.y) * 2;
    v.z *= 0.82;
    v.multiplyScalar(
      1 +
        0.075 * Math.sin(seed + v.x * 9 + v.z * 7) +
        0.055 * Math.sin(seed * 2.3 + v.z * 13 - v.y * 11)
    );
    // The fill settles: the underside spreads and flattens, the top stays
    // rounded, and the whole bag lists slightly to one side.
    if (v.y < 0) v.y *= 0.78 * slump;
    v.x += lean * (v.y + 0.2);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  normalizeExtents(g, SANDBAG_EXTENTS);
  g.computeVertexNormals();
  return g;
}

/** Rescales and recentres a geometry so its bounding box matches `extents`. */
function normalizeExtents(
  geometry: THREE.BufferGeometry,
  extents: { x: number; y: number; z: number }
): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;
  const size = new THREE.Vector3().subVectors(box.max, box.min);
  const center = new THREE.Vector3().addVectors(box.max, box.min).multiplyScalar(0.5);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(
    extents.x / Math.max(size.x, 1e-4),
    extents.y / Math.max(size.y, 1e-4),
    extents.z / Math.max(size.z, 1e-4)
  );
}

/** A tuft of dry grass: a few crossed blades, cheap enough to scatter freely. */
export function foliageGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.4;
    const lean = 0.22 + (i % 3) * 0.09;
    const height = 0.26 + (i % 4) * 0.06;
    const blade = chamferBox(0.035, height, 0.008, 0).clone();
    blade.rotateZ(lean * Math.cos(angle));
    blade.rotateX(lean * Math.sin(angle));
    blade.translate(Math.cos(angle) * 0.045, height / 2, Math.sin(angle) * 0.045);
    parts.push(blade);
  }
  return mergeParts(parts);
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    vertexCount += part.getAttribute('position').count;
    const index = part.getIndex();
    indexCount += index ? index.count : part.getAttribute('position').count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vo = 0;
  let io = 0;
  for (const part of parts) {
    const p = part.getAttribute('position');
    const n = part.getAttribute('normal');
    positions.set(p.array as Float32Array, vo * 3);
    normals.set(n.array as Float32Array, vo * 3);
    const index = part.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices[io + i] = index.getX(i) + vo;
      io += index.count;
    } else {
      for (let i = 0; i < p.count; i++) indices[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
  }
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
