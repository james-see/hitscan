import * as THREE from 'three';
import type { EngineContext } from '@/types/engine.ts';
import type { Rng } from '@/types/rng.ts';
import type { ShotPreset } from '@/engine/CaptureBridge.ts';
import { WorldBuilder, type ArenaCollider } from './kit/Builder.ts';
import { buildMaterials, PALETTE } from './kit/Materials.ts';
import { configureSurfaces } from './kit/Surfaces.ts';
import { buildGround } from './kit/Ground.ts';
import { PropLibrary } from './kit/Props.ts';
import { practical } from './kit/Lights.ts';
import { chamferBox, lumpGeometry } from './kit/Geometry.ts';
import {
  awning,
  barrelGeometry,
  cable,
  crateGeometry,
  culvert,
  foliageGeometry,
  latticeGirder,
  localPoint,
  palletGeometry,
  pillar,
  pipeRun,
  pitchedRoof,
  railing,
  sandbagGeometry,
  sandbagWall,
  shelfRack,
  shippingContainer,
  slabField,
  stairRun,
  strut,
  wall,
  type Opening,
} from './kit/Pieces.ts';

export type { ArenaCollider } from './kit/Builder.ts';

export interface Arena {
  root: THREE.Group;
  colliders: ArenaCollider[];
  shots: ShotPreset[];
  /** Where the player starts, and where bots may spawn. */
  spawns: THREE.Vector3[];
  /** Reported by the world module so the light budget stays visible. */
  localLightCount: number;
  dispose(): void;
}

/** Half-extent of the walled courtyard, measured to the wall centrelines. */
const BOUND = 33;
const WALL_HEIGHT = 6.4;

/** Warehouse A, west of the lane. Contains the shadowed interior pocket. */
const WAREHOUSE = { x: -13, z: -8, w: 12, d: 10, height: 6.6, ridge: 1.85 } as const;
/** Building B, east of the lane. Two storeys with a roof deck. */
const BLOCK_B = { x: 14, z: 6, w: 14, d: 11, height: 7.0 } as const;
/** Building C, the low utility shed in the north-east. */
const SHED_C = { x: 26, z: -3, w: 8, d: 6, height: 3.7 } as const;
/** Building D, the south-west mass that frames the establishing shot. */
const BLOCK_D = { x: -27.5, z: 15, w: 9, d: 8, height: 4.8 } as const;
/** Elevated platform, the south-east power position. */
const PLATFORM = { x: 20, z: -19, w: 16, d: 12, deck: 3.0 } as const;
/** Gantry crane straddling the lane. The establishing shot's focal point. */
const GANTRY = { z: -1.5, legX: 9, legTop: 8.0, beamY: 8.75 } as const;

/**
 * "Shipyard" — a walled Mediterranean dockside courtyard.
 *
 * The plan is unchanged from the blockout: a long central lane for
 * engagements, a covered warehouse and a container alley as flanking routes,
 * and an elevated platform giving the space a vertical axis. What the art pass
 * adds is the reason to believe it — profiled walls, framed openings, a
 * gantry that closes the sky over the lane, and enough working clutter that
 * every sightline has something in it at three different depths.
 */
export async function buildArena(ctx: EngineContext): Promise<Arena> {
  const root = new THREE.Group();
  root.name = 'shipyard';

  const materials = buildMaterials(ctx.resources);
  const b = new WorldBuilder(materials);
  const props = new PropLibrary(materials);
  const lights: THREE.PointLight[] = [];

  configureSurfaces({
    // The warehouse shell, measured to its inside faces. Everything within it
    // loses two and a half stops of indirect light, which is what separates a
    // covered interior from the sunlit yard when neither has a shadow to help.
    interior: {
      center: new THREE.Vector3(WAREHOUSE.x, 3.35, WAREHOUSE.z),
      halfExtents: new THREE.Vector3(WAREHOUSE.w / 2 - 0.55, 3.35, WAREHOUSE.d / 2 - 0.55),
      mouth: new THREE.Vector3(WAREHOUSE.x, 2.2, WAREHOUSE.z + WAREHOUSE.d / 2),
      mouthFalloff: 6.5,
      floor: 0.18,
      corner: 0.45,
      cornerRadius: 1.1,
    },
    // Grime pools where things stand, and half the level's props stand on the
    // platform rather than the yard.
    ground: {
      deckY: PLATFORM.deck,
      deckCenter: new THREE.Vector2(PLATFORM.x, PLATFORM.z),
      deckHalf: new THREE.Vector2(PLATFORM.w / 2, PLATFORM.d / 2),
    },
  });

  defineProps(props);

  buildPerimeter(b, props, ctx.rng.fork('arena.perimeter'));
  buildWarehouse(b, props, root, lights, ctx.rng.fork('arena.warehouse'));
  buildBlockB(b, props, root, lights, ctx.rng.fork('arena.blockB'));
  buildShedC(b, props, ctx.rng.fork('arena.shedC'));
  buildBlockD(b, props, ctx.rng.fork('arena.blockD'));
  buildGantry(b, props, root, lights);
  buildPlatform(b, props, root, lights, ctx.rng.fork('arena.platform'));
  buildContainers(b, props, ctx.rng.fork('arena.containers'));
  buildMarket(b, props, root, lights, ctx.rng.fork('arena.market'));
  buildSouthYard(b, props, root, lights, ctx.rng.fork('arena.southyard'));
  buildOverheadLines(b, props);
  buildSkyline(b, ctx.rng.fork('arena.skyline'));
  buildWaterTower(b, props, 25.5, -13.5);
  buildGantryLoad(b, props, ctx.rng.fork('arena.load'));
  buildForegroundFrames(b, props, ctx.rng.fork('arena.framing'));
  dressCourtyard(b, props, ctx.rng.fork('arena.dressing'));
  scatterDebris(b, props, ctx.rng.fork('arena.debris'));

  root.add(buildCourtyardFloor(materials));
  for (const mesh of b.finalize()) root.add(mesh);
  for (const mesh of props.build()) root.add(mesh);

  const colliders = b.colliders;
  // Floor plane. Everything above it is a discrete box collider.
  colliders.push({
    kind: 'box',
    position: new THREE.Vector3(0, -0.5, 0),
    halfExtents: new THREE.Vector3(52, 0.5, 52),
    rotation: new THREE.Quaternion(),
    surface: 'concrete',
  });

  return {
    root,
    colliders,
    shots: SHOTS,
    spawns: SPAWNS.map((s) => s.clone()),
    localLightCount: lights.length,
    dispose(): void {
      materials.dispose();
    },
  };
}

// -- prop library -----------------------------------------------------------

function defineProps(props: PropLibrary): void {
  // Both crates are exactly one metre tall so a stack's height is the sum of
  // its instance scales; the tall variant differs only in footprint.
  props.define('crate', crateGeometry(1.0, false), 'wood');
  props.define('crateTall', crateGeometry(0.645, true), 'wood');
  props.define('barrel', barrelGeometry(), 'metal');
  props.define('pallet', palletGeometry(), 'wood');
  // Three shapes on the burlap material, cycled by the emplacement builder.
  props.define('sandbag', sandbagGeometry(3.1, 1.0), 'burlap');
  props.define('sandbagB', sandbagGeometry(8.4, 0.86), 'burlap');
  props.define('sandbagC', sandbagGeometry(14.9, 1.14), 'burlap');
  props.define('rubbleLarge', lumpGeometry(1, 0.34, 11, 0.72), 'trim');
  props.define('rubbleSmall', lumpGeometry(0, 0.42, 27, 0.8), 'trim');
  props.define('plank', chamferBox(1, 0.05, 0.19, 0.01), 'wood');
  props.define('cobble', chamferBox(1, 0.1, 1, 0.02), 'trim');
  props.define('foliage', foliageGeometry(), 'wood', { mode: 'world' }, false);
  props.define('railPost', standing(chamferBox(0.07, 1.06, 0.07, 0.014)), 'metal');
  props.define('bollard', chamferBox(0.26, 0.9, 0.26, 0.05), 'trim');
  props.define('lampLens', new THREE.SphereGeometry(1, 8, 6), 'emissive', { mode: 'world' }, false);
}

/** Moves a centred geometry so its base sits on the origin plane. */
function standing(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const moved = geometry.clone();
  moved.computeBoundingBox();
  moved.translate(0, -(moved.boundingBox?.min.y ?? 0), 0);
  return moved;
}

// -- ground -----------------------------------------------------------------

function buildCourtyardFloor(materials: ReturnType<typeof buildMaterials>): THREE.Mesh {
  return buildGround(materials, {
    size: 104,
    segments: 168,
    paths: [
      // The main lane and the two flanking routes, polished by traffic.
      { points: [[-2, 30], [0, 12], [2, -4], [4, -20], [6, -30]], width: 4.5, shift: 0.14 },
      { points: [[-26, 26], [-25, 4], [-24, -12], [-20, -26]], width: 3.2, shift: 0.1 },
      { points: [[26, 24], [27, 8], [24, -8], [16, -14]], width: 3.0, shift: 0.1 },
      // Mud tracked out of the warehouse mouth.
      { points: [[-13, -2], [-11, 6], [-6, 14]], width: 2.6, shift: -0.12 },
    ],
    footprints: [
      { x: WAREHOUSE.x, z: WAREHOUSE.z, w: WAREHOUSE.w, d: WAREHOUSE.d },
      { x: BLOCK_B.x, z: BLOCK_B.z, w: BLOCK_B.w, d: BLOCK_B.d },
      { x: SHED_C.x, z: SHED_C.z, w: SHED_C.w, d: SHED_C.d },
      { x: BLOCK_D.x, z: BLOCK_D.z, w: BLOCK_D.w, d: BLOCK_D.d },
      { x: PLATFORM.x, z: PLATFORM.z, w: PLATFORM.w, d: PLATFORM.d },
      { x: 0, z: -BOUND, w: BOUND * 2, d: 1.6 },
      { x: 0, z: BOUND, w: BOUND * 2, d: 1.6 },
      { x: -BOUND, z: 0, w: 1.6, d: BOUND * 2 },
      { x: BOUND, z: 0, w: 1.6, d: BOUND * 2 },
    ],
    patches: [
      { x: -6, z: 12, radius: 3.4, tint: new THREE.Color(0.5, 0.46, 0.4), strength: 0.7 },
      { x: 4, z: -9, radius: 4.2, tint: new THREE.Color(0.62, 0.57, 0.48), strength: 0.5 },
      { x: -21, z: -18, radius: 5.0, tint: new THREE.Color(0.55, 0.5, 0.42), strength: 0.6 },
      { x: 18, z: 20, radius: 4.4, tint: new THREE.Color(0.68, 0.62, 0.5), strength: 0.45 },
      { x: -13, z: -1, radius: 3.0, tint: new THREE.Color(0.42, 0.39, 0.35), strength: 0.75 },
      { x: 24, z: -10, radius: 3.6, tint: new THREE.Color(0.6, 0.5, 0.4), strength: 0.55 },
      { x: 9, z: 24, radius: 5.2, tint: new THREE.Color(0.72, 0.66, 0.55), strength: 0.4 },
      { x: -29, z: -2, radius: 4.0, tint: new THREE.Color(0.58, 0.54, 0.46), strength: 0.5 },
    ],
  });
}

// -- perimeter --------------------------------------------------------------

/**
 * One kind of perimeter module.
 *
 * The horizon is the largest single thing in the wide framings and it was one
 * module repeated the whole way round. These four differ in height, cap
 * profile and damage state, and the run builder never places the same one
 * twice in a row, so no two adjacent bays match.
 */
interface WallVariant {
  id: string;
  /** Multiplier on the run's nominal height. */
  height: number;
  coping: boolean;
  /** String course, as a fraction of the module height. */
  band: number | null;
  /** Blocks along the top with gaps between them. */
  crenellated: boolean;
  /** Broken top, rubble at the foot and a buttress shoring up what is left. */
  ruined: boolean;
  plinth: number;
}

const WALL_VARIANTS: WallVariant[] = [
  {
    id: 'plain',
    height: 1.0,
    coping: true,
    band: 0.53,
    crenellated: false,
    ruined: false,
    plinth: 0.5,
  },
  {
    id: 'parapet',
    height: 1.18,
    coping: true,
    band: null,
    crenellated: true,
    ruined: false,
    plinth: 0.62,
  },
  {
    id: 'low',
    height: 0.82,
    coping: false,
    band: null,
    crenellated: false,
    ruined: false,
    plinth: 0.32,
  },
  {
    id: 'ruined',
    height: 0.66,
    coping: false,
    band: null,
    crenellated: false,
    ruined: true,
    plinth: 0.5,
  },
];

/** Render colours the perimeter draws from, one per module. */
const WALL_TINTS = [
  PALETTE.plasterWarm,
  PALETTE.plasterPale,
  PALETTE.plasterOchre,
  PALETTE.plasterRose,
  PALETTE.concrete,
];

interface PerimeterRunOptions {
  cx: number;
  cz: number;
  rotY?: number;
  length: number;
  height: number;
  thickness: number;
  openings?: Opening[];
  /** Spans, in run-local u, that must stay intact — gate piers and the like. */
  keepSolid?: Array<[number, number]>;
}

/**
 * Builds one side of the perimeter out of shuffled modules.
 *
 * Module edges are drawn from a short list of bay widths and nudged clear of
 * any opening, so a reveal is never split across two bays; a pier stands at
 * every joint, which turns the height changes between neighbours into a
 * deliberate rhythm rather than a mistake.
 */
function perimeterRun(
  b: WorldBuilder,
  props: PropLibrary,
  rng: Rng,
  o: PerimeterRunOptions
): void {
  const { cx, cz, rotY = 0, length, height, thickness, openings = [], keepSolid = [] } = o;
  const at = (u: number, t = 0): [number, number] => localPoint(cx, cz, rotY, u, t);

  const bays = [4.8, 6.0, 7.4, 8.6];
  const edges: number[] = [-length / 2];
  for (let guard = 0; guard < 32; guard++) {
    let next = edges[edges.length - 1] + rng.pick(bays);
    for (const op of openings) {
      const left = op.u - op.width / 2 - 1.1;
      const right = op.u + op.width / 2 + 1.1;
      if (next > left && next < right) next = right;
    }
    if (next > length / 2 - 3.2) break;
    edges.push(next);
  }
  edges.push(length / 2);

  const heights: number[] = [];
  let previous = -1;
  for (let i = 0; i < edges.length - 1; i++) {
    const u0 = edges[i];
    const u1 = edges[i + 1];
    const mid = (u0 + u1) / 2;
    const span = u1 - u0;
    const own = openings.filter((op) => op.u > u0 && op.u < u1);
    const protectedSpan =
      own.length > 0 || keepSolid.some(([a, c]) => mid > a && mid < c);

    let index = rng.int(0, WALL_VARIANTS.length - 1);
    if (index === previous) index = (index + 1 + rng.int(0, 1)) % WALL_VARIANTS.length;
    if (protectedSpan && WALL_VARIANTS[index].ruined) index = rng.int(0, 1);
    previous = index;
    const variant = WALL_VARIANTS[index];

    const moduleHeight = height * variant.height * rng.range(0.97, 1.03);
    heights.push(moduleHeight);
    const [mx, mz] = at(mid);
    const tint = WALL_TINTS[rng.int(0, WALL_TINTS.length - 1)]
      .clone()
      .multiplyScalar(rng.range(0.88, 1.08));

    wall(b, {
      cx: mx,
      cz: mz,
      rotY,
      length: span,
      height: moduleHeight,
      thickness,
      tint,
      grime: rng.range(0.26, 0.52),
      coping: variant.coping,
      plinth: variant.plinth,
      bandAt: variant.band === null ? undefined : moduleHeight * variant.band,
      pilasterEvery: 0,
      openings: own.map((op) => ({ ...op, u: op.u - mid })),
      // Different patch of albedo per bay, on top of the different tint.
      uvOffset: [rng.range(0, 11), rng.range(0, 7)],
    });

    if (variant.crenellated) {
      const merlons = Math.max(2, Math.round(span / 1.3));
      for (let k = 0; k < merlons; k++) {
        if (rng.chance(0.16)) continue;
        const u = u0 + (span * (k + 0.5)) / merlons;
        const [px, pz] = at(u);
        b.box({
          x: px,
          y: moduleHeight,
          z: pz,
          w: (span / merlons) * 0.66,
          h: rng.range(0.5, 0.78),
          d: thickness * 0.8,
          rotY,
          material: 'plaster',
          tint,
          grime: 0.14,
          mottle: 0.09,
          chamfer: 0.045,
          collide: false,
        });
      }
    }

    if (variant.ruined) {
      buildRuinedCrest(b, props, rng, {
        cx: mx,
        cz: mz,
        rotY,
        span,
        top: moduleHeight,
        thickness,
        tint,
      });
      // Whatever the silhouette says, the module still has to be a wall: an
      // invisible cap keeps the arena closed where the masonry is gone.
      b.solid(
        new THREE.Vector3(mx, moduleHeight + (height * 1.4 - moduleHeight) / 2, mz),
        new THREE.Vector3(span / 2, (height * 1.4 - moduleHeight) / 2, thickness / 2),
        'concrete',
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0))
      );
    }
  }

  // Piers at the joints, sized to clear the taller of the two bays they split.
  for (let i = 0; i < edges.length; i++) {
    const u = edges[i];
    if (openings.some((op) => Math.abs(op.u - u) < op.width / 2 + 0.6)) continue;
    const left = heights[i - 1] ?? heights[0] ?? height;
    const right = heights[i] ?? heights[heights.length - 1] ?? height;
    const pierHeight = Math.max(left, right) + rng.range(0.1, 0.45);
    const [px, pz] = at(u);
    b.box({
      x: px,
      y: 0,
      z: pz,
      w: rng.range(0.86, 1.08),
      h: pierHeight,
      d: thickness + 0.8,
      rotY,
      material: 'plaster',
      tint: WALL_TINTS[rng.int(0, WALL_TINTS.length - 1)]
        .clone()
        .multiplyScalar(rng.range(0.85, 1.02)),
      grime: rng.range(0.34, 0.52),
      mottle: 0.09,
      chamfer: 0.05,
    });
    b.box({
      x: px,
      y: pierHeight,
      z: pz,
      w: 1.24,
      h: 0.24,
      d: thickness + 1.04,
      rotY,
      material: 'trim',
      tint: PALETTE.concrete,
      grime: 0.1,
      chamfer: 0.05,
      collide: false,
    });
    b.box({
      x: px,
      y: 0,
      z: pz,
      w: 1.24,
      h: 0.6,
      d: thickness + 1.04,
      rotY,
      material: 'trim',
      tint: PALETTE.concrete,
      grime: 0.46,
      mottle: 0.06,
      chamfer: 0.05,
    });
  }
}

interface RuinedCrestOptions {
  cx: number;
  cz: number;
  rotY: number;
  span: number;
  top: number;
  thickness: number;
  tint: THREE.Color;
}

/** The broken top of a collapsed bay, plus the spoil it shed and its shoring. */
function buildRuinedCrest(
  b: WorldBuilder,
  props: PropLibrary,
  rng: Rng,
  o: RuinedCrestOptions
): void {
  const { cx, cz, rotY, span, top, thickness, tint } = o;
  const at = (u: number, t = 0): [number, number] => localPoint(cx, cz, rotY, u, t);

  const blocks = Math.max(4, Math.round(span / 0.82));
  for (let i = 0; i < blocks; i++) {
    const u = -span / 2 + (span * (i + 0.5)) / blocks;
    // Two overlapping sines give a crest that dips and rises without ever
    // settling into the sawtooth a single frequency produces.
    const profile = 0.36 + 0.34 * Math.sin(i * 0.9 + cx) + 0.3 * Math.sin(i * 2.3 - cz);
    const h = Math.max(0.1, rng.range(0.16, 1.0) * profile);
    const [px, pz] = at(u, rng.range(-0.14, 0.14));
    b.box({
      x: px,
      y: top,
      z: pz,
      w: (span / blocks) * rng.range(0.86, 1.02),
      h,
      d: thickness * rng.range(0.72, 1.0),
      rotY: rotY + rng.range(-0.07, 0.07),
      material: 'plaster',
      tint,
      grime: 0.26,
      mottle: 0.1,
      chamfer: 0.045,
      collide: false,
    });
  }

  // Spoil at the foot, inside the yard, and a raking shore holding the rest up.
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let i = 0; i < 9; i++) {
    const [px, pz] = at(rng.range(-span / 2, span / 2), rng.range(0.55, 2.1));
    quaternion.setFromEuler(
      new THREE.Euler(rng.range(0, 0.6), rng.range(0, Math.PI * 2), rng.range(0, 0.6))
    );
    const s = rng.range(0.24, 0.62);
    scale.set(s, s * rng.range(0.5, 0.8), s * rng.range(0.8, 1.2));
    matrix.compose(new THREE.Vector3(px, s * 0.22, pz), quaternion, scale);
    props.place(
      rng.chance(0.6) ? 'rubbleLarge' : 'rubbleSmall',
      matrix,
      tint.clone().multiplyScalar(rng.range(0.6, 0.95))
    );
  }

  const [bx, bz] = at(rng.range(-span * 0.3, span * 0.3), 1.3);
  b.box({
    x: bx,
    y: 0,
    z: bz,
    w: 0.9,
    h: 2.4,
    d: 1.6,
    rotY,
    material: 'trim',
    tint: PALETTE.concrete,
    grime: 0.42,
    chamfer: 0.05,
  });
  b.box({
    x: bx,
    y: 2.4,
    z: bz + 0,
    w: 0.9,
    h: 1.0,
    d: 0.7,
    rotY,
    tiltX: 0.55,
    material: 'trim',
    tint: PALETTE.concrete,
    grime: 0.2,
    chamfer: 0.04,
  });
}

function buildPerimeter(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  const thickness = 1.0;

  // South: the backdrop for the market row, and the far wall of the
  // establishing shot.
  perimeterRun(b, props, rng.fork('south'), {
    cx: 0,
    cz: BOUND,
    rotY: Math.PI,
    length: BOUND * 2,
    height: WALL_HEIGHT,
    thickness,
  });

  // West: two service windows, bricked up.
  perimeterRun(b, props, rng.fork('west'), {
    cx: -BOUND,
    cz: 0,
    rotY: Math.PI / 2,
    length: BOUND * 2,
    height: WALL_HEIGHT,
    thickness,
    openings: [
      { u: -8, width: 1.4, sill: 2.4, head: 4.1, kind: 'window' },
      { u: 14, width: 1.4, sill: 2.4, head: 4.1, kind: 'window' },
    ],
  });

  // East: taller behind the platform, and the horizon of the elevated shot.
  perimeterRun(b, props, rng.fork('east'), {
    cx: BOUND,
    cz: 0,
    rotY: -Math.PI / 2,
    length: BOUND * 2,
    height: WALL_HEIGHT + 0.6,
    thickness,
  });

  // North-east: the main run, with the yard gate.
  perimeterRun(b, props, rng.fork('northeast'), {
    cx: 9.5,
    cz: -BOUND,
    length: 47,
    height: WALL_HEIGHT,
    thickness,
    openings: [{ u: -5.5, width: 6, sill: 0, head: 4.7, kind: 'bay' }],
    keepSolid: [[-14, 3]],
  });
  buildYardGate(b, 4, -BOUND, 6, 4.5);

  // North-west: the run that took the hit. Held to the low and ruined
  // variants, so the north end reads as the damaged side of the yard.
  perimeterRun(b, props, rng.fork('northwest'), {
    cx: -23.5,
    cz: -BOUND,
    length: 19,
    height: WALL_HEIGHT * 0.62,
    thickness,
  });

  // Corner returns tie the four runs together with a heavier pier.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box({
        x: sx * BOUND,
        y: 0,
        z: sz * BOUND,
        w: 2.0,
        h: WALL_HEIGHT + 0.9,
        d: 2.0,
        material: 'plaster',
        tint: PALETTE.plasterWarm,
        grime: 0.38,
        mottle: 0.05,
        chamfer: 0.06,
      });
      b.box({
        x: sx * BOUND,
        y: WALL_HEIGHT + 0.9,
        z: sz * BOUND,
        w: 2.4,
        h: 0.3,
        d: 2.4,
        material: 'trim',
        tint: PALETTE.concrete,
        chamfer: 0.06,
        collide: false,
      });
    }
  }

  // Grass in the crack where every wall meets the ground.
  const tuftRng = rng.fork('tufts');
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let i = 0; i < 190; i++) {
    const side = tuftRng.int(0, 3);
    const along = tuftRng.range(-BOUND + 1, BOUND - 1);
    const out = (BOUND - 0.62) * (tuftRng.chance(0.5) ? 1 : 1);
    const offset = tuftRng.range(-0.25, 0.4);
    const x = side === 0 ? along : side === 1 ? along : side === 2 ? -out + offset : out - offset;
    const z = side === 0 ? -out + offset : side === 1 ? out - offset : along;
    quaternion.setFromEuler(new THREE.Euler(0, tuftRng.range(0, Math.PI * 2), 0));
    const s = tuftRng.range(0.7, 1.5);
    scale.set(s, tuftRng.range(0.6, 1.3), s);
    matrix.compose(new THREE.Vector3(x, 0, z), quaternion, scale);
    props.place(
      'foliage',
      matrix,
      PALETTE.foliage.clone().multiplyScalar(tuftRng.range(0.75, 1.35))
    );
  }
}

/** Twin steel gate leaves closing the yard entrance. */
function buildYardGate(
  b: WorldBuilder,
  x: number,
  z: number,
  width: number,
  height: number
): void {
  for (const side of [-1, 1]) {
    const leafX = x + side * width / 4;
    b.box({
      x: leafX,
      y: 0.05,
      z,
      w: width / 2 - 0.06,
      h: height,
      d: 0.14,
      material: 'metal',
      tint: PALETTE.steelGreen,
      grime: 0.4,
      mottle: 0.05,
      chamfer: 0.03,
      collide: 'metal',
      uv: { mode: 'world', rotate: true },
    });
    // Frame and diagonal brace, the detail that separates a gate from a slab.
    for (const edgeY of [0.05, height - 0.13]) {
      b.box({
        x: leafX,
        y: edgeY,
        z: z + 0.1,
        w: width / 2 - 0.06,
        h: 0.14,
        d: 0.08,
        material: 'metal',
        tint: PALETTE.steel,
        collide: false,
        chamfer: 0.02,
      });
    }
    b.box({
      x: leafX,
      y: 0.05 + height / 2 - 0.09,
      z: z + 0.1,
      w: Math.hypot(width / 2, height),
      h: 0.11,
      d: 0.07,
      tiltZ: Math.atan2(height, width / 2) * side,
      material: 'metal',
      tint: PALETTE.steel,
      collide: false,
      chamfer: 0.02,
    });
  }
  // Gate posts.
  for (const side of [-1, 1]) {
    b.box({
      x: x + side * (width / 2 + 0.3),
      y: 0,
      z,
      w: 0.6,
      h: height + 0.7,
      d: 1.5,
      material: 'trim',
      tint: PALETTE.concrete,
      grime: 0.4,
      chamfer: 0.05,
    });
  }
}

// -- warehouse (building A) -------------------------------------------------

function buildWarehouse(
  b: WorldBuilder,
  props: PropLibrary,
  root: THREE.Group,
  lights: THREE.PointLight[],
  rng: Rng
): void {
  const { x, z, w, d, height, ridge } = WAREHOUSE;
  const t = 0.55;
  const tint = PALETTE.plasterPale;
  const south = z + d / 2;
  const north = z - d / 2;
  const west = x - w / 2;
  const east = x + w / 2;
  const bayWidth = 5.4;
  const bayHead = 4.5;

  // Quoin pilasters and a cornice band under the eaves. Without them these are
  // the largest blank surfaces in the level, and they face away from the sun.
  const common = {
    height,
    thickness: t,
    tint,
    grime: 0.34,
    plinth: 0.42,
    coping: false,
    bandAt: height - 0.55,
    pilasterEvery: 4,
  };

  wall(b, {
    ...common,
    cx: x,
    cz: south,
    rotY: 0,
    length: w,
    openings: [
      { u: 0, width: bayWidth, sill: 0, head: bayHead, kind: 'bay' },
      // Personnel door on the west pier. The `interior-shadow` camera stands
      // 5 m off this wall, and a reveal with a lintel breaks it far better than
      // anything that could be hung on the surface.
      { u: -4.3, width: 1.15, sill: 0, head: 2.35, kind: 'door' },
    ],
  });
  wall(b, {
    ...common,
    cx: x,
    cz: north,
    rotY: Math.PI,
    length: w,
    openings: [
      { u: -3.4, width: 1.5, sill: 4.5, head: 5.9, kind: 'window' },
      { u: 3.4, width: 1.5, sill: 4.5, head: 5.9, kind: 'window' },
    ],
  });
  wall(b, {
    ...common,
    cx: west,
    cz: z,
    rotY: -Math.PI / 2,
    length: d - t * 2,
    grime: 0.36,
    openings: [
      { u: -2.6, width: 1.4, sill: 4.4, head: 5.8, kind: 'window' },
      { u: 2.6, width: 1.4, sill: 4.4, head: 5.8, kind: 'window' },
    ],
  });
  wall(b, {
    ...common,
    cx: east,
    cz: z,
    rotY: Math.PI / 2,
    length: d - t * 2,
    grime: 0.36,
    openings: [
      { u: -3.0, width: 1.3, sill: 0, head: 2.35, kind: 'door' },
      { u: 2.8, width: 1.4, sill: 3.2, head: 4.8, kind: 'window' },
    ],
  });

  pitchedRoof(b, {
    cx: x,
    cz: z,
    y: height,
    span: w + 0.3,
    length: d,
    peak: ridge,
    rotY: Math.PI / 2,
    overhang: 0.5,
    tint: PALETTE.steel,
    gables: true,
    gableTint: tint,
  });

  slabField(b, rng.fork('floor'), {
    cx: x,
    cz: z,
    y: 0.07,
    w: w - t * 2 + 0.1,
    d: d - t * 2 + 0.1,
    thickness: 0.07,
    cols: 3,
    rows: 3,
    joint: 0.04,
    // Darker than the yard: this floor is the level's one deep shadow pocket
    // and it only reads as one if its albedo is low to begin with.
    tint: PALETTE.concreteDark.clone().multiplyScalar(0.62),
  });

  // Roof trusses and purlins. Open steel overhead is what makes an interior
  // read as a working building rather than a hollow box.
  for (const tz of [z - 3.4, z, z + 3.4]) {
    latticeGirder(b, {
      from: new THREE.Vector3(west + 0.3, height - 0.35, tz),
      to: new THREE.Vector3(east - 0.3, height - 0.35, tz),
      size: 0.42,
      chordRadius: 0.05,
      panels: 7,
      tint: PALETTE.steelRust,
    });
  }
  for (const px of [x - 3.6, x, x + 3.6]) {
    strut(
      b,
      new THREE.Vector3(px, height - 0.1, north + 0.4),
      new THREE.Vector3(px, height - 0.1, south - 0.4),
      0.045,
      PALETTE.steelRust
    );
  }

  // Roller shutter, mostly raised: drum, guide rails and a hanging curtain.
  b.box({
    x,
    y: bayHead + 0.28,
    z: south - 0.12,
    w: bayWidth + 0.5,
    h: 0.42,
    d: 0.42,
    material: 'metal',
    tint: PALETTE.steel,
    collide: false,
    chamfer: 0.06,
  });
  b.box({
    x,
    y: bayHead - 0.62,
    z: south - 0.12,
    w: bayWidth,
    h: 0.62,
    d: 0.09,
    material: 'metal',
    tint: PALETTE.steelGreen,
    grime: 0.15,
    collide: false,
    chamfer: 0.02,
    uv: { mode: 'world', rotate: true },
  });
  for (const side of [-1, 1]) {
    b.box({
      x: x + side * (bayWidth / 2 + 0.12),
      y: 0,
      z: south - 0.12,
      w: 0.14,
      h: bayHead + 0.3,
      d: 0.2,
      material: 'metal',
      tint: PALETTE.steel,
      grime: 0.35,
      collide: false,
      chamfer: 0.02,
    });
  }
  // Threshold ramp, so the doorway has a lip to read against the yard.
  b.box({
    x,
    y: 0,
    z: south + 0.34,
    w: bayWidth + 0.6,
    h: 0.1,
    d: 0.8,
    material: 'trim',
    tint: PALETTE.concreteDark,
    grime: 0.45,
    chamfer: 0.03,
  });

  dressWarehouseFacade(b, props, root, lights, rng.fork('facade'));

  // Racking down the west wall, loaded with crates.
  shelfRack(b, { cx: west + 0.95, cz: z, rotY: Math.PI / 2, length: 7.4, depth: 1.1, levels: 3, height: 3.6 });

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const stockRng = rng.fork('stock');
  for (let level = 0; level < 3; level++) {
    const y = (3.6 * (level + 1)) / 3.4;
    for (let i = 0; i < 6; i++) {
      if (stockRng.chance(0.25)) continue;
      const cz = z - 3.2 + i * 1.28;
      const s = stockRng.range(0.72, 0.92);
      quaternion.setFromEuler(new THREE.Euler(0, stockRng.range(-0.1, 0.1), 0));
      scale.setScalar(s);
      matrix.compose(new THREE.Vector3(west + 0.95, y + (s * 1.0) / 2 + 0.03, cz), quaternion, scale);
      props.place('crate', matrix, crateTint(stockRng));
    }
  }

  // Stacked stock against the north wall, and a spill of loose goods.
  stackCrates(b, props, stockRng, east - 2.4, north + 1.3, 3, 0.95);
  stackCrates(b, props, stockRng, east - 3.9, north + 1.2, 2, 0.85);
  placePallet(props, stockRng, x + 1.2, z + 2.6, 0.3);
  placePallet(props, stockRng, x + 1.35, z + 2.5, 0.34, 0.13);
  placeBarrels(b, props, stockRng, [
    [x + 2.4, z + 1.2],
    [x + 2.9, z + 1.8],
    [x + 2.2, z + 2.0],
  ]);

  // Workbench along the east wall.
  b.box({
    x: east - 1.1,
    y: 0.82,
    z: z - 2.6,
    w: 1.5,
    h: 0.07,
    d: 3.0,
    material: 'wood',
    tint: PALETTE.woodWarm,
    grime: 0.2,
    chamfer: 0.02,
    collide: 'wood',
  });
  for (const bz of [z - 3.9, z - 1.3]) {
    for (const bx of [east - 1.7, east - 0.5]) {
      b.box({
        x: bx,
        y: 0,
        z: bz,
        w: 0.09,
        h: 0.82,
        d: 0.09,
        material: 'wood',
        tint: PALETTE.woodGrey,
        grime: 0.35,
        chamfer: 0.015,
        collide: false,
      });
    }
  }

  // Services running along the inside of the east wall.
  pipeRun(b, {
    from: new THREE.Vector3(east - 0.32, height - 0.9, north + 0.5),
    to: new THREE.Vector3(east - 0.32, height - 0.9, south - 0.5),
    radius: 0.1,
    tint: PALETTE.steelRust,
  });
  pipeRun(b, {
    from: new THREE.Vector3(east - 0.32, 0, north + 1.2),
    to: new THREE.Vector3(east - 0.32, height - 1.0, north + 1.2),
    radius: 0.07,
    tint: PALETTE.steel,
    bracketEvery: 1.8,
  });

  // Two practicals: a hanging work lamp deep inside, and a spill lamp over the
  // bay so the doorway reads as a lit threshold from the courtyard.
  //
  // These are deliberately far weaker than a lamp you could work under. At
  // anything like a plausible working level they lift the whole interior to the
  // exposure of the sunlit yard outside, which destroys the one strong tonal
  // contrast the arena has; the lens material is unlit, so the fixtures still
  // read as on however little they actually emit.
  lights.push(
    practical(b, props, root, {
      x: x - 0.5,
      y: 4.3,
      z: z - 1.2,
      color: 0xffb066,
      intensity: 4.5,
      distance: 11,
      mount: 'ceiling',
      lens: 0.15,
    })
  );
  lights.push(
    practical(b, props, root, {
      x: x + 3.1,
      y: 3.0,
      z: south - 0.9,
      color: 0xffc98a,
      intensity: 3,
      distance: 7,
      mount: 'ceiling',
      lens: 0.1,
    })
  );
  lights.push(
    practical(b, props, root, {
      x: east + 0.55,
      y: 2.9,
      z: z - 3.0,
      color: 0xffd2a0,
      intensity: 2.5,
      distance: 6,
      mount: 'wall',
      rotY: Math.PI / 2,
    })
  );
}

/**
 * Dressing on the warehouse's south face.
 *
 * This wall is the backdrop of the `interior-shadow` framing and the largest
 * plane in the west half of the yard, so it carries the most obvious risk of
 * reading as a flat rectangle. Everything here is silhouette on the wall plane:
 * a sign band to break the height, downpipes at the quoins to break the width,
 * and a working spill of goods at the base so the wall meets the ground in
 * something other than a hard line.
 */
function dressWarehouseFacade(
  b: WorldBuilder,
  props: PropLibrary,
  root: THREE.Group,
  lights: THREE.PointLight[],
  rng: Rng
): void {
  const { x, z, w, d, height } = WAREHOUSE;
  const south = z + d / 2;
  const west = x - w / 2;
  const east = x + w / 2;
  const bayWidth = 5.4;
  const bayHead = 4.5;
  const face = south + 0.06;

  // Painted sign board over the bay, with a shadow-catching lip and brackets.
  const signY = bayHead + 0.42;
  b.box({
    x,
    y: signY,
    z: face + 0.06,
    w: w - 2.4,
    h: 1.0,
    d: 0.12,
    material: 'metal',
    tint: PALETTE.canvasCream,
    grime: 0.5,
    mottle: 0.16,
    collide: false,
    chamfer: 0.03,
    uv: { mode: 'world' },
  });
  for (const sy of [signY - 0.06, signY + 0.98]) {
    b.box({
      x,
      y: sy,
      z: face + 0.02,
      w: w - 2.2,
      h: 0.08,
      d: 0.2,
      material: 'metal',
      tint: PALETTE.steelRust,
      grime: 0.45,
      collide: false,
      chamfer: 0.02,
    });
  }
  for (const sx of [x - 3.6, x, x + 3.6]) {
    b.box({
      x: sx,
      y: signY - 0.4,
      z: face - 0.02,
      w: 0.09,
      h: 1.9,
      d: 0.14,
      material: 'metal',
      tint: PALETTE.steelRust,
      grime: 0.5,
      collide: false,
      chamfer: 0.015,
    });
  }

  // Downpipes at both quoins, each with a hopper head and a kicked-out shoe.
  for (const side of [-1, 1]) {
    const px = side < 0 ? west + 0.62 : east - 0.62;
    pipeRun(b, {
      from: new THREE.Vector3(px, 0.34, face + 0.1),
      to: new THREE.Vector3(px, height - 0.75, face + 0.1),
      radius: 0.075,
      tint: PALETTE.steelRust,
      bracketEvery: 2.0,
    });
    b.box({
      x: px,
      y: height - 0.78,
      z: face + 0.1,
      w: 0.3,
      h: 0.34,
      d: 0.3,
      material: 'metal',
      tint: PALETTE.steelRust,
      grime: 0.5,
      collide: false,
      chamfer: 0.06,
    });
    b.box({
      x: px,
      y: 0.06,
      z: face + 0.22,
      w: 0.17,
      h: 0.3,
      d: 0.42,
      tiltX: 0.32,
      material: 'metal',
      tint: PALETTE.steelRust,
      grime: 0.6,
      collide: false,
      chamfer: 0.03,
    });
    // Damp stain and moss at the outfall.
    props.place(
      'foliage',
      new THREE.Matrix4().compose(
        new THREE.Vector3(px + side * 0.24, 0.02, face + 0.36),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI), 0)),
        new THREE.Vector3(0.9, 0.7, 0.9)
      ),
      PALETTE.foliage.clone().multiplyScalar(rng.range(0.7, 1.0))
    );
  }

  // Gable vent above the sign: a recessed louvre reads as depth from the yard.
  b.box({
    x,
    y: height + 0.35,
    z: face,
    w: 1.7,
    h: 1.0,
    d: 0.16,
    material: 'trim',
    tint: PALETTE.concreteDark,
    grime: 0.4,
    collide: false,
    chamfer: 0.04,
  });
  for (let i = 0; i < 5; i++) {
    b.box({
      x,
      y: height + 0.44 + i * 0.17,
      z: face + 0.08,
      w: 1.5,
      h: 0.09,
      d: 0.13,
      tiltX: -0.5,
      material: 'metal',
      tint: PALETTE.steel,
      grime: 0.35,
      collide: false,
      chamfer: 0.02,
    });
  }

  // Working spill to the east of the bay: leaning pallets, a stack, a bin.
  const spillX = x + bayWidth / 2 + 1.5;
  for (let i = 0; i < 3; i++) {
    props.place(
      'pallet',
      new THREE.Matrix4().compose(
        new THREE.Vector3(spillX + i * 0.14, 0.62 + i * 0.02, face + 0.42 + i * 0.09),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(Math.PI / 2 - 0.22, rng.range(-0.12, 0.12), 0)
        ),
        new THREE.Vector3(1, 1, 1)
      ),
      PALETTE.woodGrey.clone().multiplyScalar(rng.range(0.6, 0.95))
    );
  }
  b.solid(
    new THREE.Vector3(spillX + 0.14, 0.62, face + 0.5),
    new THREE.Vector3(0.6, 0.62, 0.32),
    'wood'
  );
  stackCrates(b, props, rng.fork('spill'), spillX + 1.9, face + 0.7, 2, 0.9);

  // Skip bin standing clear of the wall so it does not block the new door and
  // reads as a separate mass against it.
  const binX = west - 1.4;
  const binZ = face + 1.9;
  b.box({
    x: binX,
    y: 0,
    z: binZ,
    w: 2.3,
    h: 1.05,
    d: 1.35,
    rotY: 0.32,
    material: 'metal',
    tint: PALETTE.steelRust,
    grime: 0.62,
    mottle: 0.2,
    chamfer: 0.05,
    collide: 'metal',
  });
  b.box({
    x: binX,
    y: 1.05,
    z: binZ,
    w: 2.42,
    h: 0.1,
    d: 1.47,
    rotY: 0.32,
    material: 'metal',
    tint: PALETTE.steel,
    grime: 0.5,
    collide: false,
    chamfer: 0.03,
  });
  // Overspilling load, so the bin has a broken top edge rather than a flat lid.
  const binRng = rng.fork('bin');
  for (let i = 0; i < 7; i++) {
    const s = binRng.range(0.24, 0.42);
    props.place(
      i % 3 === 0 ? 'plank' : 'rubbleLarge',
      new THREE.Matrix4().compose(
        new THREE.Vector3(
          binX + binRng.range(-0.85, 0.85),
          1.06 + binRng.range(0, 0.16),
          binZ + binRng.range(-0.45, 0.45)
        ),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(binRng.range(-0.5, 0.5), binRng.range(0, Math.PI * 2), binRng.range(-0.5, 0.5))
        ),
        i % 3 === 0 ? new THREE.Vector3(binRng.range(0.8, 1.4), 1, 1) : new THREE.Vector3(s, s * 0.7, s)
      ),
      (i % 3 === 0 ? PALETTE.woodGrey : PALETTE.concreteDark)
        .clone()
        .multiplyScalar(binRng.range(0.7, 1.05))
    );
  }

  // Services on the blank stretch left of the bay: this is the piece of wall
  // the `interior-shadow` framing sits closest to, and at 5 m a bare plane
  // shows every flaw in the plaster tiling.
  // The blank pier is only the 3.3 m between the bay jamb and the west quoin,
  // and the skip bin already takes its lower half, so the run sits above it.
  const boxX = x - bayWidth / 2 - 1.1;
  b.box({
    x: boxX,
    y: 1.55,
    z: face + 0.02,
    w: 0.6,
    h: 0.84,
    d: 0.24,
    material: 'metal',
    tint: PALETTE.steel,
    grime: 0.4,
    collide: false,
    chamfer: 0.03,
  });
  b.box({
    x: boxX,
    y: 2.39,
    z: face + 0.06,
    w: 0.72,
    h: 0.08,
    d: 0.32,
    material: 'metal',
    tint: PALETTE.steel,
    collide: false,
    chamfer: 0.02,
  });
  pipeRun(b, {
    from: new THREE.Vector3(boxX, 2.52, face + 0.06),
    to: new THREE.Vector3(boxX, 4.3, face + 0.06),
    radius: 0.035,
    tint: PALETTE.steel,
    bracketEvery: 0,
  });
  pipeRun(b, {
    from: new THREE.Vector3(boxX, 4.3, face + 0.06),
    to: new THREE.Vector3(x + bayWidth / 2 + 1.4, 4.3, face + 0.06),
    radius: 0.035,
    tint: PALETTE.steel,
    bracketEvery: 1.6,
  });
  // Hose reel on the pier east of the bay.
  const reelX = x + bayWidth / 2 + 1.0;
  b.add(
    new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14, 1, false),
    new THREE.Matrix4().compose(
      new THREE.Vector3(reelX, 1.5, face + 0.28),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
      new THREE.Vector3(1, 1, 1)
    ),
    {
      material: 'metal',
      tint: PALETTE.steelRust,
      grime: 0.4,
      uv: { mode: 'local', repeat: [(2 * Math.PI * 0.34) / 2, 0.3 / 2] },
    }
  );
  b.box({
    x: reelX,
    y: 1.42,
    z: face + 0.08,
    w: 0.14,
    h: 0.16,
    d: 0.34,
    material: 'metal',
    tint: PALETTE.steel,
    collide: false,
    chamfer: 0.02,
  });
  // Corrugated offcuts leaning between the door and the west quoin, catching a
  // raking shadow across the pier.
  for (let i = 0; i < 3; i++) {
    b.box({
      x: west + 0.95 + i * 0.16,
      y: 0,
      z: face + 0.36 + i * 0.07,
      w: 1.25,
      h: 2.1,
      d: 0.05,
      tiltX: 0.2 + i * 0.015,
      rotY: 0.06,
      material: 'metal',
      tint: PALETTE.steelRust.clone().multiplyScalar(rng.range(0.82, 1.0)),
      grime: 0.5,
      mottle: 0.18,
      collide: i === 1 ? 'metal' : false,
      chamfer: 0.015,
      uv: { mode: 'world', rotate: true },
    });
  }

  placeBarrels(b, props, rng.fork('doorstep'), [
    [west + 2.5, face + 0.55],
    [west + 3.1, face + 1.15],
  ]);

  // Wall lamp over the bay head, aimed into the yard.
  lights.push(
    practical(b, props, root, {
      x: x + bayWidth / 2 + 0.75,
      y: 3.55,
      z: face + 0.42,
      color: 0xffcf9a,
      intensity: 11,
      distance: 9,
      mount: 'wall',
      rotY: 0,
    })
  );
}

// -- block B ----------------------------------------------------------------

function buildBlockB(
  b: WorldBuilder,
  props: PropLibrary,
  root: THREE.Group,
  lights: THREE.PointLight[],
  rng: Rng
): void {
  const { x, z, w, d, height } = BLOCK_B;
  const t = 0.5;
  const tint = PALETTE.plasterOchre;
  const west = x - w / 2;
  const east = x + w / 2;
  const north = z - d / 2;
  const south = z + d / 2;

  const upperWindow = (u: number): Opening => ({
    u,
    width: 1.25,
    sill: 4.15,
    head: 5.85,
    kind: 'window',
    shutters: true,
  });

  // West façade: the one the lane looks at, so it carries the most detail.
  wall(b, {
    cx: west,
    cz: z,
    rotY: -Math.PI / 2,
    length: d,
    height,
    thickness: t,
    tint,
    grime: 0.3,
    bandAt: 3.55,
    openings: [
      { u: 2.6, width: 1.35, sill: 0, head: 2.45, kind: 'door' },
      { u: -2.7, width: 1.4, sill: 1.05, head: 2.5, kind: 'window', shutters: true },
      upperWindow(-3.4),
      upperWindow(0),
      upperWindow(3.4),
    ],
  });
  wall(b, {
    cx: x,
    cz: north,
    rotY: Math.PI,
    length: w,
    height,
    thickness: t,
    tint,
    grime: 0.3,
    bandAt: 3.55,
    openings: [
      { u: -4.2, width: 1.4, sill: 1.05, head: 2.5, kind: 'window' },
      { u: 4.2, width: 1.4, sill: 1.05, head: 2.5, kind: 'window', shutters: true },
      upperWindow(-4.2),
      upperWindow(0),
      upperWindow(4.2),
    ],
  });
  wall(b, {
    cx: x,
    cz: south,
    rotY: 0,
    length: w,
    height,
    thickness: t,
    tint,
    grime: 0.3,
    bandAt: 3.55,
    openings: [
      { u: 0, width: 1.35, sill: 0, head: 2.45, kind: 'door' },
      { u: -4.6, width: 1.4, sill: 1.05, head: 2.5, kind: 'window', shutters: true },
      { u: 4.6, width: 1.4, sill: 1.05, head: 2.5, kind: 'window' },
      upperWindow(-4.4),
      upperWindow(4.4),
    ],
  });
  wall(b, {
    cx: east,
    cz: z,
    rotY: Math.PI / 2,
    length: d - t * 2,
    height,
    thickness: t,
    tint,
    grime: 0.32,
    bandAt: 3.55,
    openings: [
      { u: -2.8, width: 1.4, sill: 1.05, head: 2.5, kind: 'window' },
      upperWindow(-2.8),
      upperWindow(2.8),
    ],
  });

  // Roof deck and parapet.
  b.box({
    x,
    y: height - 0.24,
    z,
    w: w - 0.1,
    h: 0.26,
    d: d - 0.1,
    material: 'trim',
    tint: PALETTE.concrete,
    grime: 0.2,
    mottle: 0.05,
    chamfer: 0.03,
  });
  for (const spec of [
    { cx: x, cz: north, rotY: Math.PI, length: w },
    { cx: x, cz: south, rotY: 0, length: w },
    { cx: west, cz: z, rotY: -Math.PI / 2, length: d - 0.8 },
    { cx: east, cz: z, rotY: Math.PI / 2, length: d - 0.8 },
  ]) {
    wall(b, {
      ...spec,
      baseY: height,
      height: 0.92,
      thickness: 0.4,
      tint,
      grime: 0.1,
      plinth: 0,
      coping: true,
    });
  }

  // Roof clutter: water tank on a stand, vents, an aerial mast.
  b.add(
    new THREE.CylinderGeometry(0.78, 0.78, 1.3, 16, 1, false),
    new THREE.Matrix4().makeTranslation(x - 3.6, height + 1.55, z - 2.6),
    {
      material: 'metal',
      tint: PALETTE.steel,
      grime: 0.2,
      uv: { mode: 'local', repeat: [(2 * Math.PI * 0.78) / 2.5, 1.3 / 2.5] },
    }
  );
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box({
        x: x - 3.6 + sx * 0.55,
        y: height,
        z: z - 2.6 + sz * 0.55,
        w: 0.1,
        h: 0.9,
        d: 0.1,
        material: 'metal',
        tint: PALETTE.steelRust,
        chamfer: 0.02,
        collide: false,
      });
    }
  }
  for (const [vx, vz, vw] of [
    [x + 3.4, z + 2.2, 1.3],
    [x + 1.2, z - 3.4, 0.9],
    [x + 4.6, z - 1.4, 0.7],
  ] as const) {
    b.box({
      x: vx,
      y: height,
      z: vz,
      w: vw,
      h: 0.62,
      d: vw * 0.8,
      material: 'metal',
      tint: PALETTE.steelGreen,
      grime: 0.2,
      chamfer: 0.04,
    });
    b.box({
      x: vx,
      y: height + 0.62,
      z: vz,
      w: vw + 0.14,
      h: 0.1,
      d: vw * 0.8 + 0.14,
      material: 'metal',
      tint: PALETTE.steel,
      chamfer: 0.03,
      collide: false,
    });
  }
  strut(
    b,
    new THREE.Vector3(east - 1.0, height + 0.9, north + 1.0),
    new THREE.Vector3(east - 1.0, height + 4.2, north + 1.0),
    0.05,
    PALETTE.steel
  );

  // Balcony on the upper west façade, on corbels.
  const balconyY = 3.9;
  b.box({
    x: west - 0.62,
    y: balconyY,
    z: z + 0.05,
    w: 1.3,
    h: 0.18,
    d: 3.6,
    material: 'trim',
    tint: PALETTE.concrete,
    grime: 0.22,
    chamfer: 0.035,
    collide: 'concrete',
  });
  for (const bz of [z - 1.4, z + 0.05, z + 1.5]) {
    b.box({
      x: west - 0.34,
      y: balconyY - 0.34,
      z: bz,
      w: 0.72,
      h: 0.34,
      d: 0.22,
      material: 'trim',
      tint: PALETTE.concrete,
      grime: 0.3,
      chamfer: 0.03,
      collide: false,
    });
  }
  railing(b, props, {
    cx: west - 1.2,
    cz: z + 0.05,
    y: balconyY + 0.18,
    length: 3.6,
    rotY: Math.PI / 2,
    height: 0.95,
    tint: PALETTE.steelRust,
    postSpacing: 0.9,
  });

  // Awning and lamp over the west door, and a downpipe on the corner.
  awning(b, { cx: west, cz: z + 2.6, y: 2.9, width: 2.6, depth: 1.35, rotY: -Math.PI / 2, tint: PALETTE.canvasRed });
  pipeRun(b, {
    from: new THREE.Vector3(west - 0.32, 0, north + 0.7),
    to: new THREE.Vector3(west - 0.32, height + 0.6, north + 0.7),
    radius: 0.075,
    tint: PALETTE.steelRust,
    bracketEvery: 2.2,
  });
  pipeRun(b, {
    from: new THREE.Vector3(east + 0.3, 0, south - 0.8),
    to: new THREE.Vector3(east + 0.3, height + 0.6, south - 0.8),
    radius: 0.075,
    tint: PALETTE.steelRust,
    bracketEvery: 2.2,
  });

  lights.push(
    practical(b, props, root, {
      x: west - 0.55,
      y: 2.85,
      z: z + 1.35,
      color: 0xffcf9a,
      intensity: 14,
      distance: 11,
      mount: 'wall',
      rotY: -Math.PI / 2,
    })
  );
  lights.push(
    practical(b, props, root, {
      x: x - 0.1,
      y: 2.85,
      z: south + 0.55,
      color: 0xffcf9a,
      intensity: 11,
      distance: 9,
      mount: 'wall',
      rotY: 0,
    })
  );

  // Clutter against the base of the façade.
  const dressRng = rng.fork('dress');
  stackCrates(b, props, dressRng, west - 1.1, z - 3.9, 2, 1.0);
  placeBarrels(b, props, dressRng, [
    [west - 0.9, z + 4.3],
    [west - 1.5, z + 4.6],
    [east + 0.9, north + 1.6],
  ]);
  placePallet(props, dressRng, west - 1.3, z - 5.0, -0.4);
}

// -- shed C and block D -----------------------------------------------------

function buildShedC(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  const { x, z, w, d, height } = SHED_C;
  const t = 0.45;
  const tint = PALETTE.plasterRose;
  wall(b, {
    cx: x,
    cz: z + d / 2,
    length: w,
    height,
    thickness: t,
    tint,
    grime: 0.36,
    plinth: 0.36,
    coping: false,
    openings: [
      { u: -1.9, width: 1.25, sill: 0, head: 2.3, kind: 'door' },
      { u: 2.0, width: 1.3, sill: 1.1, head: 2.4, kind: 'window', shutters: true },
    ],
  });
  wall(b, {
    cx: x,
    cz: z - d / 2,
    rotY: Math.PI,
    length: w,
    height,
    thickness: t,
    tint,
    grime: 0.36,
    plinth: 0.36,
    coping: false,
    openings: [{ u: 0, width: 1.3, sill: 1.1, head: 2.4, kind: 'window' }],
  });
  wall(b, {
    cx: x - w / 2,
    cz: z,
    rotY: -Math.PI / 2,
    length: d - t * 2,
    height,
    thickness: t,
    tint,
    grime: 0.38,
    plinth: 0.36,
    coping: false,
  });
  wall(b, {
    cx: x + w / 2,
    cz: z,
    rotY: Math.PI / 2,
    length: d - t * 2,
    height,
    thickness: t,
    tint,
    grime: 0.38,
    plinth: 0.36,
    coping: false,
  });
  pitchedRoof(b, {
    cx: x,
    cz: z,
    y: height,
    span: d + 0.3,
    length: w,
    peak: 1.15,
    overhang: 0.45,
    tint: PALETTE.steelRust,
    gableTint: tint,
  });
  awning(b, { cx: x - 1.9, cz: z + d / 2, y: 2.75, width: 2.2, depth: 1.5, tint: PALETTE.canvasCream });
  placeBarrels(b, props, rng, [
    [x + 3.2, z + 3.6],
    [x + 3.7, z + 3.1],
  ]);
  stackCrates(b, props, rng, x - 3.4, z + 4.2, 2, 0.9);
}

function buildBlockD(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  const { x, z, w, d, height } = BLOCK_D;
  const t = 0.5;
  const tint = PALETTE.plasterRose;
  const openings: Opening[] = [
    { u: -2.2, width: 1.3, sill: 1.1, head: 2.5, kind: 'window', shutters: true },
    { u: 2.2, width: 1.3, sill: 1.1, head: 2.5, kind: 'window' },
  ];
  wall(b, { cx: x, cz: z + d / 2, length: w, height, thickness: t, tint, grime: 0.34, bandAt: 2.9, openings });
  wall(b, {
    cx: x,
    cz: z - d / 2,
    rotY: Math.PI,
    length: w,
    height,
    thickness: t,
    tint,
    grime: 0.34,
    bandAt: 2.9,
    openings: [{ u: 0, width: 1.35, sill: 0, head: 2.45, kind: 'door' }],
  });
  wall(b, {
    cx: x - w / 2,
    cz: z,
    rotY: -Math.PI / 2,
    length: d - t * 2,
    height,
    thickness: t,
    tint,
    grime: 0.36,
    bandAt: 2.9,
  });
  wall(b, {
    cx: x + w / 2,
    cz: z,
    rotY: Math.PI / 2,
    length: d - t * 2,
    height,
    thickness: t,
    tint,
    grime: 0.36,
    bandAt: 2.9,
    openings: [{ u: -1.6, width: 1.3, sill: 1.1, head: 2.5, kind: 'window', shutters: true }],
  });
  pitchedRoof(b, {
    cx: x,
    cz: z,
    y: height,
    span: d + 0.4,
    length: w,
    peak: 1.5,
    overhang: 0.5,
    tint: PALETTE.steelRust,
    gableTint: tint,
  });
  awning(b, {
    cx: x,
    cz: z - d / 2,
    y: 2.95,
    width: 3.0,
    depth: 1.6,
    rotY: Math.PI,
    tint: PALETTE.steelGreen,
  });
  pipeRun(b, {
    from: new THREE.Vector3(x + w / 2 + 0.3, 0, z - d / 2 + 0.6),
    to: new THREE.Vector3(x + w / 2 + 0.3, height + 0.3, z - d / 2 + 0.6),
    radius: 0.07,
    tint: PALETTE.steelRust,
  });
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 4; i++) {
    matrix.makeTranslation(x + w / 2 + 1.4, 0.45, z - 2.4 + i * 1.7);
    props.place('bollard', matrix, PALETTE.concreteDark);
  }

  dressBlockD(b, props, rng.fork('dress'));
}

/**
 * South-east corner of block D.
 *
 * The establishing framing puts this corner in the near left third, where it
 * was two storeys of unbroken plaster. Everything added here sits on or against
 * the wall so it breaks the plane without eating into the flanking route that
 * runs past the building.
 */
function dressBlockD(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  const { x, z, w, d, height } = BLOCK_D;
  const east = x + w / 2;
  const south = z + d / 2;

  // Downpipe on the corner, into a stone gutter block.
  pipeRun(b, {
    from: new THREE.Vector3(east + 0.28, 0.28, south - 0.5),
    to: new THREE.Vector3(east + 0.28, height + 0.2, south - 0.5),
    radius: 0.07,
    tint: PALETTE.steelRust,
    bracketEvery: 1.9,
  });
  b.box({
    x: east + 0.28,
    y: 0,
    z: south - 0.5,
    w: 0.42,
    h: 0.26,
    d: 0.6,
    material: 'trim',
    tint: PALETTE.concreteDark,
    grime: 0.6,
    chamfer: 0.04,
    collide: false,
  });

  // Lean-to against the south wall, centred on the pier between the two
  // windows so it does not blank one of them out.
  const leanX = x;
  awning(b, {
    cx: leanX,
    cz: south,
    y: 2.55,
    width: 3.4,
    depth: 1.9,
    fall: 0.5,
    tint: PALETTE.canvasCream,
    posts: true,
  });
  const dressRng = rng.fork('lean');
  stackCrates(b, props, dressRng, leanX - 1.0, south + 0.9, 2, 0.92);
  stackCrates(b, props, dressRng, leanX + 1.1, south + 1.0, 1, 0.8);
  placePallet(props, dressRng, leanX + 0.1, south + 1.4, 0.42);
  placeBarrels(b, props, dressRng, [[leanX + 1.6, south + 1.7]]);

  // Stone bench and planters along the wall, west of the lean-to.
  b.box({
    x: x - 3.1,
    y: 0,
    z: south + 0.55,
    w: 2.0,
    h: 0.46,
    d: 0.5,
    material: 'trim',
    tint: PALETTE.concrete,
    grime: 0.5,
    mottle: 0.14,
    chamfer: 0.045,
    collide: 'concrete',
  });
  for (const px of [x - 4.3, x + 3.4]) {
    b.box({
      x: px,
      y: 0,
      z: south + 0.55,
      w: 0.62,
      h: 0.68,
      d: 0.62,
      material: 'trim',
      tint: PALETTE.concrete,
      grime: 0.55,
      mottle: 0.16,
      chamfer: 0.05,
      collide: 'concrete',
    });
    props.place(
      'foliage',
      new THREE.Matrix4().compose(
        new THREE.Vector3(px, 0.6, south + 0.55),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI), 0)),
        new THREE.Vector3(1.5, 1.7, 1.5)
      ),
      PALETTE.foliage.clone().multiplyScalar(rng.range(0.8, 1.15))
    );
  }

  // Weeds where the wall meets the yard, so the junction is not a clean line.
  const weedRng = rng.fork('weeds');
  for (let i = 0; i < 9; i++) {
    const along = weedRng.range(-w / 2 + 0.4, w / 2 - 0.4);
    props.place(
      'foliage',
      new THREE.Matrix4().compose(
        new THREE.Vector3(x + along, 0.02, south + weedRng.range(0.12, 0.34)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, weedRng.range(0, Math.PI), 0)),
        new THREE.Vector3(weedRng.range(0.6, 1.1), weedRng.range(0.5, 1.0), weedRng.range(0.6, 1.1))
      ),
      PALETTE.foliage.clone().multiplyScalar(weedRng.range(0.6, 1.05))
    );
  }
}

// -- gantry crane -----------------------------------------------------------

function buildGantry(
  b: WorldBuilder,
  props: PropLibrary,
  root: THREE.Group,
  lights: THREE.PointLight[]
): void {
  const { z, legX, legTop, beamY } = GANTRY;

  for (const side of [-1, 1]) {
    const x = side * legX;
    b.box({
      x,
      y: 0,
      z,
      w: 2.4,
      h: 0.5,
      d: 2.4,
      material: 'trim',
      tint: PALETTE.concrete,
      grime: 0.45,
      chamfer: 0.05,
    });
    latticeGirder(b, {
      from: new THREE.Vector3(x, 0.5, z),
      to: new THREE.Vector3(x, legTop, z),
      size: 1.35,
      chordRadius: 0.1,
      panels: 7,
      tint: PALETTE.steelRust,
    });
    // Knee braces from the leg up to the girder.
    for (const brace of [-1, 1]) {
      strut(
        b,
        new THREE.Vector3(x + brace * 0.68, legTop - 2.2, z),
        new THREE.Vector3(x - side * 2.6, beamY - 0.6, z),
        0.07,
        PALETTE.steelRust
      );
    }
    // Ladder up the outer face.
    for (let i = 0; i < 14; i++) {
      const y = 0.9 + i * 0.5;
      if (y > legTop - 0.3) break;
      strut(
        b,
        new THREE.Vector3(x + side * 0.78, y, z - 0.22),
        new THREE.Vector3(x + side * 0.78, y, z + 0.22),
        0.022,
        PALETTE.steel
      );
    }
  }

  latticeGirder(b, {
    from: new THREE.Vector3(-legX - 1.6, beamY, z),
    to: new THREE.Vector3(legX + 1.6, beamY, z),
    size: 1.5,
    chordRadius: 0.1,
    panels: 14,
    tint: PALETTE.steelRust,
  });

  // Runway rails and a walkway plate on top of the girder.
  for (const rz of [z - 0.75, z + 0.75]) {
    b.box({
      x: 0,
      y: beamY + 0.78,
      z: rz,
      w: legX * 2 + 3.6,
      h: 0.1,
      d: 0.16,
      material: 'metal',
      tint: PALETTE.steel,
      grime: 0.05,
      chamfer: 0.02,
      collide: false,
    });
  }
  b.box({
    x: 0,
    y: beamY + 0.86,
    z,
    w: legX * 2 + 3.2,
    h: 0.06,
    d: 1.1,
    material: 'metal',
    tint: PALETTE.steelRust,
    grime: 0.05,
    chamfer: 0.02,
    collide: false,
    uv: { mode: 'world', rotate: true },
  });

  // Trolley and hook block hanging over the lane.
  const trolleyX = -2.6;
  b.box({
    x: trolleyX,
    y: beamY - 1.2,
    z,
    w: 1.7,
    h: 1.0,
    d: 1.5,
    material: 'metal',
    tint: PALETTE.steelRed,
    grime: 0.25,
    chamfer: 0.05,
    collide: false,
  });
  strut(
    b,
    new THREE.Vector3(trolleyX, beamY - 1.2, z),
    new THREE.Vector3(trolleyX, 4.6, z),
    0.025,
    new THREE.Color(0.22, 0.21, 0.2)
  );
  b.box({
    x: trolleyX,
    y: 4.0,
    z,
    w: 0.5,
    h: 0.62,
    d: 0.34,
    material: 'metal',
    tint: PALETTE.steelRed,
    grime: 0.2,
    chamfer: 0.04,
    collide: false,
  });

  // A worklight on the girder throws a pool onto the lane at night.
  lights.push(
    practical(b, props, root, {
      x: 2.2,
      y: beamY - 0.9,
      z,
      color: 0xbfd6ff,
      intensity: 30,
      distance: 20,
      mount: 'ceiling',
      lens: 0.14,
    })
  );

  // Cable drums and a control cabin at the foot of the east leg.
  b.box({
    x: legX + 2.1,
    y: 0,
    z: z + 1.6,
    w: 1.6,
    h: 2.3,
    d: 1.5,
    rotY: 0.12,
    material: 'metal',
    tint: PALETTE.steelGreen,
    grime: 0.35,
    chamfer: 0.05,
  });
  b.box({
    x: legX + 2.1,
    y: 2.3,
    z: z + 1.6,
    w: 1.8,
    h: 0.12,
    d: 1.7,
    rotY: 0.12,
    material: 'metal',
    tint: PALETTE.steel,
    chamfer: 0.03,
    collide: false,
  });
  // Cable drum by the east leg, clear of the warehouse-mouth sightline.
  b.add(
    new THREE.CylinderGeometry(0.68, 0.68, 0.78, 14, 1, false),
    new THREE.Matrix4().compose(
      new THREE.Vector3(legX + 3.9, 0.68, z - 2.6),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0.2)),
      new THREE.Vector3(1, 1, 1)
    ),
    {
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.3,
      uv: { mode: 'local', repeat: [(2 * Math.PI * 0.68) / 2, 0.78 / 2] },
    }
  );
  b.solid(
    new THREE.Vector3(legX + 3.9, 0.68, z - 2.6),
    new THREE.Vector3(0.72, 0.68, 0.72),
    'wood'
  );
}

// -- elevated platform ------------------------------------------------------

function buildPlatform(
  b: WorldBuilder,
  props: PropLibrary,
  root: THREE.Group,
  lights: THREE.PointLight[],
  rng: Rng
): void {
  const { x, z, w, d, deck } = PLATFORM;
  const west = x - w / 2;
  const east = x + w / 2;
  const north = z - d / 2;
  const south = z + d / 2;

  // Deck poured in jointed bays, with a separate deeper edge beam so the
  // platform has a profile rather than a single flat lip. Bays are kept near
  // 2.5 m square: the elevated shot stands on this deck and looks along it, so
  // it is the one surface in the arena seen almost entirely at grazing angle,
  // and a coarser grid left the near ground reading as an unbroken sheet.
  slabField(b, rng.fork('deckSlabs'), {
    cx: x,
    cz: z,
    y: deck,
    w,
    d,
    thickness: 0.3,
    cols: 6,
    rows: 5,
    tint: PALETTE.concrete,
  });
  for (const spec of [
    { cx: x, cz: north, rotY: 0, length: w },
    { cx: x, cz: south, rotY: 0, length: w },
    { cx: west, cz: z, rotY: Math.PI / 2, length: d },
    { cx: east, cz: z, rotY: Math.PI / 2, length: d },
  ]) {
    b.box({
      x: spec.cx,
      y: deck - 0.72,
      z: spec.cz,
      w: spec.length + 0.24,
      h: 0.46,
      d: 0.42,
      rotY: spec.rotY,
      material: 'trim',
      tint: PALETTE.concreteDark,
      grime: 0.3,
      chamfer: 0.04,
      collide: false,
    });
  }

  for (const px of [west + 2, x, east - 2]) {
    for (const pz of [north + 2.4, south - 2.4]) {
      pillar(b, { x: px, z: pz, height: deck - 0.72, width: 0.62, tint: PALETTE.concreteDark });
    }
  }
  // Cross bracing under the deck, visible from the lane.
  for (const pz of [north + 2.4, south - 2.4]) {
    strut(b, new THREE.Vector3(west + 2, 0.4, pz), new THREE.Vector3(x, deck - 0.9, pz), 0.055, PALETTE.steelRust);
    strut(b, new THREE.Vector3(east - 2, 0.4, pz), new THREE.Vector3(x, deck - 0.9, pz), 0.055, PALETTE.steelRust);
  }

  railing(b, props, { cx: x, cz: north + 0.1, y: deck, length: w - 0.4, rotY: 0 });
  railing(b, props, { cx: x, cz: south - 0.1, y: deck, length: w - 0.4, rotY: 0 });
  railing(b, props, { cx: east - 0.1, cz: z, y: deck, length: d - 0.6, rotY: Math.PI / 2 });
  // The west edge is left open where the stair lands.
  railing(b, props, { cx: west + 0.1, cz: north + 2.6, y: deck, length: 4.0, rotY: Math.PI / 2 });
  railing(b, props, { cx: west + 0.1, cz: south - 2.6, y: deck, length: 4.0, rotY: Math.PI / 2 });

  // Stair up the west edge. Rise stays well under the controller's auto-step.
  const steps = 15;
  const rise = deck / steps;
  const going = 0.3;
  stairRun(b, {
    x: west - (steps * going) / 2,
    z,
    rotY: 0,
    steps,
    rise,
    going,
    width: 2.6,
    tint: PALETTE.concrete,
  });

  // Working clutter on the deck. Weighted toward the west half, which is the
  // half the player and the elevated camera actually look across.
  sandbagWall(b, props, rng.fork('sandbags'), {
    cx: x + 2.4,
    cz: north + 0.9,
    rotY: 0,
    length: 4.2,
    rows: 5,
    baseY: deck,
  });
  sandbagWall(b, props, rng.fork('sandbagsW'), {
    cx: west + 3.4,
    cz: south - 1.4,
    rotY: 0.08,
    length: 3.6,
    rows: 6,
    baseY: deck,
  });
  const deckRng = rng.fork('deck');
  stackCrates(b, props, deckRng, east - 2.6, south - 2.2, 3, 0.95, deck);
  stackCrates(b, props, deckRng, east - 4.0, south - 2.0, 2, 0.85, deck);
  stackCrates(b, props, deckRng, west + 1.9, south - 3.6, 2, 1.0, deck, 0.3);
  stackCrates(b, props, deckRng, west + 3.1, south - 4.2, 1, 0.9, deck, -0.4);
  placePallet(props, deckRng, west + 5.4, south - 2.6, 0.5, deck);
  placePallet(props, deckRng, west + 5.3, south - 2.5, 0.2, deck + 0.11);
  placeBarrels(
    b,
    props,
    deckRng,
    [
      [west + 5.4, south - 2.6],
      [west + 2.2, z + 1.6],
      [west + 2.7, z + 2.2],
      [x + 4.6, z - 0.4],
    ],
    deck
  );
  // A tool chest and a spool, so the deck has something other than boxes.
  b.box({
    x: west + 6.6,
    y: deck,
    z: north + 2.2,
    w: 1.5,
    h: 0.85,
    d: 0.72,
    rotY: 0.22,
    material: 'metal',
    tint: PALETTE.steelRed,
    grime: 0.28,
    chamfer: 0.04,
  });
  b.add(
    new THREE.CylinderGeometry(0.66, 0.66, 0.72, 14, 1, false),
    new THREE.Matrix4().compose(
      new THREE.Vector3(x + 2.0, deck + 0.66, z + 3.2),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0.14)),
      new THREE.Vector3(1, 1, 1)
    ),
    {
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.25,
      uv: { mode: 'local', repeat: [(2 * Math.PI * 0.66) / 2, 0.72 / 2] },
    }
  );
  b.solid(
    new THREE.Vector3(x + 2.0, deck + 0.66, z + 3.2),
    new THREE.Vector3(0.7, 0.66, 0.7),
    'wood'
  );

  // Roofed lookout on the deck's north-west corner: it faces the lane, so the
  // platform gets a silhouette from the courtyard, and it stays out of the
  // elevated framing, which needs its view across the arena kept open.
  buildLookout(b, props, rng.fork('lookout'), west + 3.6, north + 2.5, deck);
  // Rampart along the south parapet. This edge is the elevated shot's near
  // ground, and bare slab was reading as an unfinished floor.
  const rampartRng = rng.fork('rampart');
  sandbagWall(b, props, rampartRng, {
    cx: east - 3.0,
    cz: south - 1.0,
    rotY: 0,
    length: 3.8,
    rows: 6,
    baseY: deck,
  });
  stackCrates(b, props, rampartRng, x + 3.2, south - 1.6, 2, 0.9, deck, 0.18);
  placeBarrels(b, props, rampartRng, [[x - 2.6, south - 2.9]], deck);
  placePallet(props, rampartRng, x + 4.6, south - 2.6, -0.35, deck);

  // A coiled airline and its offcuts, dropped where a crew would leave them:
  // clear of the firing lines but inside the elevated shot's near ground, which
  // otherwise runs to the parapet with nothing in it to read depth against.
  const hoseRng = rng.fork('deckHose');
  for (let i = 0; i < 3; i++) {
    const radius = 0.46 - i * 0.09;
    b.add(
      new THREE.TorusGeometry(radius, 0.035, 6, 20),
      new THREE.Matrix4().compose(
        new THREE.Vector3(east - 5.4, deck + 0.04 + i * 0.07, south - 4.6),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(Math.PI / 2, 0, hoseRng.range(0, Math.PI))
        ),
        new THREE.Vector3(1, 1, 1)
      ),
      {
        material: 'metal',
        tint: PALETTE.steelDark,
        grime: 0.4,
        uv: { mode: 'local', repeat: [(2 * Math.PI * radius) / 1.6, 0.22] },
      }
    );
  }
  scatterDeckLitter(b, props, rng.fork('deckLitter'), west, east, north, south, deck);

  // Under-deck storage, which is the only genuinely dark pocket outdoors.
  const underRng = rng.fork('under');
  stackCrates(b, props, underRng, x - 1.4, z + 1.2, 2, 1.0);
  stackCrates(b, props, underRng, x + 0.4, z + 0.6, 1, 0.9);
  placePallet(props, underRng, x + 2.6, z - 1.4, 0.6);
  pipeRun(b, {
    from: new THREE.Vector3(west + 0.6, deck - 1.05, north + 1.0),
    to: new THREE.Vector3(east - 0.6, deck - 1.05, north + 1.0),
    radius: 0.11,
    tint: PALETTE.steelRust,
    bracketEvery: 3.0,
  });

  lights.push(
    practical(b, props, root, {
      x: west + 0.5,
      y: deck - 1.35,
      z: z + 2.4,
      color: 0xffbc78,
      intensity: 10,
      distance: 8,
      mount: 'ceiling',
      lens: 0.1,
    })
  );
  lights.push(
    practical(b, props, root, {
      x: east - 0.8,
      y: deck + 2.5,
      z: north + 1.2,
      color: 0xbfd6ff,
      intensity: 16,
      distance: 12,
      mount: 'wall',
      rotY: Math.PI / 2,
    })
  );
}

/**
 * Grit, chippings and dropped offcuts across the platform deck.
 *
 * Scaled well below the courtyard scatter and given no colliders: the deck is a
 * fighting position, so this has to add tonal break-up at a grazing angle
 * without becoming something the player trips over or shoots at.
 */
function scatterDeckLitter(
  b: WorldBuilder,
  props: PropLibrary,
  rng: Rng,
  west: number,
  east: number,
  north: number,
  south: number,
  deck: number
): void {
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();

  for (let i = 0; i < 150; i++) {
    const x = rng.range(west + 0.7, east - 0.7);
    const z = rng.range(north + 0.7, south - 0.7);
    euler.set(rng.range(0, Math.PI), rng.range(0, Math.PI * 2), rng.range(0, Math.PI));
    quaternion.setFromEuler(euler);
    const s = rng.range(0.05, 0.15);
    scale.set(s * rng.range(0.8, 1.5), s * 0.5, s * rng.range(0.8, 1.5));
    matrix.compose(new THREE.Vector3(x, deck + s * 0.18, z), quaternion, scale);
    colour.copy(PALETTE.concrete).multiplyScalar(rng.range(0.4, 0.9));
    props.place('rubbleSmall', matrix, colour);
  }

  // Timber offcuts, laid flat. Long thin shapes cut across the bay joints and
  // give the eye something with a direction to it among the round grit.
  for (let i = 0; i < 7; i++) {
    const x = rng.range(west + 1.4, east - 1.4);
    const z = rng.range(north + 1.4, south - 1.4);
    euler.set(0, rng.range(0, Math.PI * 2), 0);
    quaternion.setFromEuler(euler);
    scale.set(rng.range(0.5, 1.4), 1, rng.range(0.8, 1.2));
    matrix.compose(new THREE.Vector3(x, deck + 0.025, z), quaternion, scale);
    colour.copy(PALETTE.woodGrey).multiplyScalar(rng.range(0.5, 0.85));
    props.place('plank', matrix, colour);
  }

  // Two patches of spilled sand, flattened almost to the slab. Warm against the
  // grey concrete, which is what the near ground was missing more than shape.
  for (const [sx, sz, sw] of [
    [east - 3.8, south - 3.4, 1.5],
    [west + 5.8, north + 4.6, 1.1],
  ]) {
    b.box({
      x: sx,
      y: deck,
      z: sz,
      w: sw,
      h: 0.035,
      d: sw * rng.range(0.6, 0.9),
      rotY: rng.range(0, Math.PI),
      material: 'ground',
      tint: PALETTE.sand.clone().multiplyScalar(rng.range(0.7, 0.9)),
      grime: 0.2,
      mottle: 0.3,
      collide: false,
      chamfer: 0.012,
      uv: { mode: 'world' },
    });
  }
}

/** Open-sided corrugated shelter: four posts, a braced head and a shed roof. */
function buildLookout(
  b: WorldBuilder,
  props: PropLibrary,
  rng: Rng,
  cx: number,
  cz: number,
  baseY: number
): void {
  const halfW = 1.85;
  const halfD = 1.5;
  const postTop = 2.35;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box({
        x: cx + sx * halfW,
        y: baseY,
        z: cz + sz * halfD,
        w: 0.16,
        h: postTop,
        d: 0.16,
        material: 'wood',
        tint: PALETTE.woodGrey,
        grime: 0.45,
        chamfer: 0.025,
        collide: 'wood',
      });
      // Knee brace into the head beam, which is what stops four posts and a
      // slab reading as a table.
      b.box({
        x: cx + sx * (halfW - 0.28),
        y: baseY + postTop - 0.62,
        z: cz + sz * halfD,
        w: 0.68,
        h: 0.09,
        d: 0.1,
        tiltZ: -sx * 0.75,
        material: 'wood',
        tint: PALETTE.woodGrey,
        grime: 0.35,
        chamfer: 0.02,
        collide: false,
      });
    }
  }
  for (const sz of [-1, 1]) {
    b.box({
      x: cx,
      y: baseY + postTop - 0.16,
      z: cz + sz * halfD,
      w: halfW * 2 + 0.3,
      h: 0.16,
      d: 0.12,
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.32,
      chamfer: 0.02,
      collide: false,
    });
  }
  // Shed roof, pitched toward the parapet so runoff reads in one direction.
  b.box({
    x: cx,
    y: baseY + postTop + 0.06,
    z: cz,
    w: halfW * 2 + 0.7,
    h: 0.07,
    d: halfD * 2 + 0.8,
    tiltX: 0.16,
    material: 'metal',
    tint: PALETTE.steel,
    grime: 0.5,
    mottle: 0.14,
    chamfer: 0.02,
    collide: false,
    uv: { mode: 'world', rotate: true },
  });
  b.box({
    x: cx,
    y: baseY + postTop + 0.12,
    z: cz - halfD - 0.42,
    w: halfW * 2 + 0.7,
    h: 0.12,
    d: 0.1,
    material: 'metal',
    tint: PALETTE.steelRust,
    grime: 0.55,
    collide: false,
    chamfer: 0.02,
  });

  // Half-height corrugated screen on the west face, for one solid side.
  b.box({
    x: cx - halfW,
    y: baseY,
    z: cz,
    w: 0.07,
    h: 1.25,
    d: halfD * 2,
    material: 'metal',
    tint: PALETTE.steelRust,
    grime: 0.6,
    mottle: 0.18,
    chamfer: 0.02,
    collide: 'metal',
    uv: { mode: 'world', rotate: true },
  });

  // Occupied: a stool, a map table, a thermos-scale clutter pile.
  b.box({
    x: cx + 0.5,
    y: baseY,
    z: cz - 0.3,
    w: 1.3,
    h: 0.78,
    d: 0.7,
    rotY: 0.12,
    material: 'wood',
    tint: PALETTE.woodWarm,
    grime: 0.3,
    chamfer: 0.03,
    collide: 'wood',
  });
  placeBarrels(b, props, rng, [[cx - 0.8, cz + 0.85]], baseY);
  stackCrates(b, props, rng, cx + 1.1, cz + 0.9, 1, 0.7, baseY, 0.4);
}

// -- containers -------------------------------------------------------------

function buildContainers(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  const tints = [
    PALETTE.steelBlue,
    PALETTE.steelRed,
    PALETTE.steelGreen,
    PALETTE.steelRust,
    PALETTE.steel,
  ];
  const layout: Array<[number, number, number, number]> = [
    // x, z, rotY, stack height
    [-27, -7, 0.04, 2],
    [-24.5, -15.5, 0.1, 1],
    [-28.5, -20.5, Math.PI / 2 + 0.05, 1],
    [27.5, 12, Math.PI / 2, 2],
    [27, 2.5, Math.PI / 2 - 0.03, 1],
    [-5.5, 24.5, 0.05, 1],
    [13.5, 25.5, Math.PI / 2 - 0.12, 1],
    [30.0, -24.0, 0.06, 2],
    [15.5, -29.5, 0.03, 2],
    [-16, -27.5, Math.PI / 2 + 0.02, 1],
    [24, 25.5, 0.02, 1],
  ];

  for (const [x, z, rotY, stack] of layout) {
    for (let level = 0; level < stack; level++) {
      const short = rng.chance(0.25);
      shippingContainer(b, {
        x: x + (level > 0 ? rng.range(-0.2, 0.2) : 0),
        y: level * 2.62,
        z: z + (level > 0 ? rng.range(-0.14, 0.14) : 0),
        rotY: rotY + (level > 0 ? rng.range(-0.03, 0.03) : 0),
        length: short ? 3.0 : 6.06,
        tint: rng.pick(tints),
      });
    }
  }
}

// -- market row -------------------------------------------------------------

function buildMarket(
  b: WorldBuilder,
  props: PropLibrary,
  root: THREE.Group,
  lights: THREE.PointLight[],
  rng: Rng
): void {
  const z = 25.5;
  for (let i = 0; i < 5; i++) {
    const x = -19 + i * 4.4;
    const tint = [
      PALETTE.canvasRed,
      PALETTE.canvasCream,
      PALETTE.canvasGreen,
      PALETTE.canvasBlue,
    ][i % 4];
    awning(b, {
      cx: x,
      cz: z,
      y: 2.72,
      width: 3.6,
      depth: 2.5,
      rotY: Math.PI,
      fall: 0.42,
      tint,
      posts: true,
    });
    // Counter, and boards leaning against its front.
    b.box({
      x,
      y: 0.86,
      z: z - 1.6,
      w: 3.2,
      h: 0.08,
      d: 0.85,
      material: 'wood',
      tint: PALETTE.woodWarm,
      grime: 0.22,
      chamfer: 0.025,
      collide: 'wood',
    });
    b.box({
      x,
      y: 0,
      z: z - 1.98,
      w: 3.2,
      h: 0.86,
      d: 0.09,
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.4,
      chamfer: 0.02,
      collide: 'wood',
    });
    for (const side of [-1, 1]) {
      b.box({
        x: x + side * 1.5,
        y: 0,
        z: z - 1.6,
        w: 0.09,
        h: 0.86,
        d: 0.8,
        material: 'wood',
        tint: PALETTE.woodGrey,
        grime: 0.35,
        chamfer: 0.02,
        collide: false,
      });
    }

    const stallRng = rng.fork(`stall${i}`);
    stackCrates(b, props, stallRng, x - 1.1, z - 0.7, stallRng.int(1, 2), 0.8);
    placeBarrels(b, props, stallRng, [[x + 1.3, z - 0.6]]);
    placePallet(props, stallRng, x + 0.2, z - 0.2, stallRng.range(-0.4, 0.4));

    if (i % 2 === 0) {
      lights.push(
        practical(b, props, root, {
          x,
          y: 2.42,
          z: z - 1.1,
          color: 0xffb35e,
          intensity: 8,
          distance: 7,
          mount: 'ceiling',
          lens: 0.09,
        })
      );
    }
  }
}

/**
 * The south yard: a materials laydown between the lane mouth and the market.
 *
 * The `lane` and `backlit` framings both look north across this ground, and
 * with nothing on it the lower third of both images was bare floor. These
 * pieces are deliberately tall and read in silhouette — a culvert stack, a
 * tarped pile under scaffold, a standpipe — and are set either side of the
 * lane centreline so they frame the sightline instead of blocking it.
 */
function buildSouthYard(
  b: WorldBuilder,
  props: PropLibrary,
  root: THREE.Group,
  lights: THREE.PointLight[],
  rng: Rng
): void {
  // Culvert pyramid, east of the lane. Yawed so the bores angle between the
  // two south framings — side-on they would read as blank drums.
  const stackRng = rng.fork('culverts');
  const baseX = 8.6;
  const baseZ = 14.2;
  const yaw = 1.15;
  const across: [number, number] = [Math.sin(yaw), Math.cos(yaw)];
  const pitch = 1.46;
  for (let i = 0; i < 3; i++) {
    const u = (i - 1) * pitch;
    culvert(b, {
      x: baseX + across[0] * u + stackRng.range(-0.08, 0.08),
      y: 0.68,
      z: baseZ + across[1] * u + stackRng.range(-0.08, 0.08),
      rotY: yaw + stackRng.range(-0.05, 0.05),
      tint: PALETTE.concrete.clone().multiplyScalar(stackRng.range(0.86, 1.06)),
    });
  }
  for (let i = 0; i < 2; i++) {
    const u = (i - 0.5) * pitch;
    culvert(b, {
      x: baseX + across[0] * u + stackRng.range(-0.1, 0.1),
      y: 1.85,
      z: baseZ + across[1] * u + stackRng.range(-0.1, 0.1),
      rotY: yaw + stackRng.range(-0.06, 0.06),
      tint: PALETTE.concrete.clone().multiplyScalar(stackRng.range(0.86, 1.06)),
    });
  }
  // Chocks, so the bottom row is not floating on a perfectly flat yard.
  for (const end of [-1, 1]) {
    b.box({
      x: baseX + Math.cos(yaw) * end * 0.8,
      y: 0,
      z: baseZ - Math.sin(yaw) * end * 0.8,
      w: 0.16,
      h: 0.12,
      d: 4.6,
      rotY: yaw,
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.5,
      chamfer: 0.02,
      collide: false,
    });
  }
  // A single loose section rolled clear of the stack, breaking the grid.
  culvert(b, { x: baseX - 3.4, y: 0.66, z: baseZ + 2.6, rotY: 0.2, tint: PALETTE.concrete });

  // Tarped material pile under a scaffold frame, west of the lane.
  const pileX = -9.4;
  const pileZ = 16.2;
  buildScaffold(b, pileX, pileZ);
  const tarpRng = rng.fork('tarp');
  for (let i = 0; i < 5; i++) {
    const s = tarpRng.range(0.9, 1.45);
    b.box({
      x: pileX + tarpRng.range(-1.3, 1.3),
      y: 0,
      z: pileZ + tarpRng.range(-1.0, 1.0),
      w: s * 1.5,
      h: tarpRng.range(0.55, 1.1),
      d: s,
      rotY: tarpRng.range(0, Math.PI),
      material: 'trim',
      tint: PALETTE.tarpBlue.clone().multiplyScalar(tarpRng.range(0.8, 1.1)),
      grime: 0.4,
      mottle: 0.16,
      chamfer: 0.16,
      collide: 'fabric',
    });
  }
  stackCrates(b, props, tarpRng, pileX + 2.4, pileZ - 1.4, 3, 1.0);
  placeBarrels(b, props, tarpRng, [
    [pileX - 2.3, pileZ + 0.6],
    [pileX - 2.0, pileZ + 1.4],
  ]);

  // Standpipe and trough on the lane's west kerb: a vertical accent at eye
  // height that gives the mid-ground a readable scale reference.
  const tapX = -3.9;
  const tapZ = 8.4;
  b.box({
    x: tapX,
    y: 0,
    z: tapZ,
    w: 1.9,
    h: 0.62,
    d: 0.9,
    rotY: 0.08,
    material: 'trim',
    tint: PALETTE.concreteDark,
    grime: 0.6,
    mottle: 0.14,
    chamfer: 0.05,
    collide: 'concrete',
  });
  b.box({
    x: tapX,
    y: 0.5,
    z: tapZ,
    w: 1.62,
    h: 0.14,
    d: 0.62,
    rotY: 0.08,
    material: 'trim',
    tint: PALETTE.concreteDark.clone().multiplyScalar(0.55),
    grime: 0.2,
    collide: false,
    chamfer: 0.03,
  });
  pipeRun(b, {
    from: new THREE.Vector3(tapX + 0.75, 0, tapZ - 0.62),
    to: new THREE.Vector3(tapX + 0.75, 1.68, tapZ - 0.62),
    radius: 0.055,
    tint: PALETTE.steel,
    bracketEvery: 0,
  });
  b.box({
    x: tapX + 0.75,
    y: 1.5,
    z: tapZ - 0.4,
    w: 0.09,
    h: 0.09,
    d: 0.44,
    material: 'metal',
    tint: PALETTE.steel,
    collide: false,
    chamfer: 0.02,
  });
  for (const [fx, fz] of [
    [tapX - 1.2, tapZ + 0.7],
    [tapX + 1.3, tapZ + 0.6],
  ] as const) {
    props.place(
      'foliage',
      new THREE.Matrix4().compose(
        new THREE.Vector3(fx, 0.02, fz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI), 0)),
        new THREE.Vector3(1.15, 1.0, 1.15)
      ),
      PALETTE.foliage.clone().multiplyScalar(rng.range(0.75, 1.05))
    );
  }

  // Spoil heap between the lane and the culverts. Kept under knee height so it
  // fills the bare floor in the two south framings without becoming cover that
  // closes off the lane's cross-connection.
  const heapRng = rng.fork('spoil');
  // Three overlapping lumps rather than one box: a chamfered slab at this size
  // reads as a poured pad, which is the opposite of what a spoil heap is.
  for (const [mx, mz, sx, sy, sz] of [
    [3.4, 16.3, 2.6, 0.72, 2.0],
    [4.5, 15.6, 1.9, 0.52, 1.6],
    [2.5, 17.1, 1.7, 0.44, 1.5],
  ] as const) {
    props.place(
      'rubbleLarge',
      new THREE.Matrix4().compose(
        new THREE.Vector3(mx, 0.02, mz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, heapRng.range(0, Math.PI * 2), 0)),
        new THREE.Vector3(sx, sy, sz)
      ),
      PALETTE.concreteDark.clone().multiplyScalar(heapRng.range(0.45, 0.62))
    );
  }
  b.solid(new THREE.Vector3(3.4, 0.26, 16.3), new THREE.Vector3(1.5, 0.26, 1.2), 'dirt');
  for (let i = 0; i < 16; i++) {
    const s = heapRng.range(0.16, 0.4);
    props.place(
      heapRng.chance(0.35) ? 'rubbleLarge' : 'rubbleSmall',
      new THREE.Matrix4().compose(
        new THREE.Vector3(
          3.6 + heapRng.range(-2.2, 2.2),
          0.16 + heapRng.range(0, 0.3),
          16.4 + heapRng.range(-1.6, 1.6)
        ),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(heapRng.range(-0.6, 0.6), heapRng.range(0, Math.PI * 2), heapRng.range(-0.6, 0.6))
        ),
        new THREE.Vector3(s, s * 0.75, s)
      ),
      PALETTE.concreteDark.clone().multiplyScalar(heapRng.range(0.5, 0.85))
    );
  }
  // Sheet of corrugated iron dumped on the heap: one bright specular plane in
  // an otherwise matte patch of ground.
  b.box({
    x: 5.2,
    y: 0.22,
    z: 15.2,
    w: 2.2,
    h: 0.05,
    d: 1.15,
    rotY: -0.5,
    tiltX: 0.16,
    tiltZ: 0.1,
    material: 'metal',
    tint: PALETTE.steelRust,
    grime: 0.45,
    mottle: 0.2,
    chamfer: 0.015,
    collide: false,
    uv: { mode: 'world', rotate: true },
  });
  placeBarrels(b, props, heapRng, [[1.9, 15.0]]);

  lights.push(
    practical(b, props, root, {
      x: pileX + 1.85,
      y: 3.15,
      z: pileZ - 1.85,
      color: 0xffc27a,
      intensity: 9,
      distance: 8,
      mount: 'ceiling',
      lens: 0.1,
    })
  );
}

/** Four-post scaffold tower over a laydown pile. */
function buildScaffold(b: WorldBuilder, cx: number, cz: number): void {
  const half = 2.0;
  const top = 3.3;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box({
        x: cx + sx * half,
        y: 0,
        z: cz + sz * half,
        w: 0.1,
        h: top,
        d: 0.1,
        material: 'metal',
        tint: PALETTE.steel,
        grime: 0.45,
        chamfer: 0.02,
        collide: 'metal',
      });
    }
  }
  for (const y of [1.15, 2.3, top - 0.06]) {
    for (const sz of [-1, 1]) {
      strut(
        b,
        new THREE.Vector3(cx - half, y, cz + sz * half),
        new THREE.Vector3(cx + half, y, cz + sz * half),
        0.045,
        PALETTE.steel
      );
    }
    for (const sx of [-1, 1]) {
      strut(
        b,
        new THREE.Vector3(cx + sx * half, y, cz - half),
        new THREE.Vector3(cx + sx * half, y, cz + half),
        0.045,
        PALETTE.steel
      );
    }
  }
  // Diagonal bracing on the two faces that read from the lane.
  strut(
    b,
    new THREE.Vector3(cx - half, 0.1, cz - half),
    new THREE.Vector3(cx + half, 2.3, cz - half),
    0.038,
    PALETTE.steel
  );
  strut(
    b,
    new THREE.Vector3(cx + half, 0.1, cz + half),
    new THREE.Vector3(cx + half, 2.3, cz - half),
    0.038,
    PALETTE.steel
  );
  // Plank deck at the top, partly laid.
  for (let i = 0; i < 4; i++) {
    b.box({
      x: cx - 1.55 + i * 0.62,
      y: top,
      z: cz,
      w: 0.55,
      h: 0.05,
      d: half * 2,
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.4,
      chamfer: 0.012,
      collide: false,
    });
  }
}

// -- skyline and framing ----------------------------------------------------

/**
 * The town beyond the wall.
 *
 * Every wide framing ended at a flat perimeter with empty sky above it, which
 * is why the eye found nothing to read distance against. These masses stand
 * forty to fifty metres out, so only their tops clear the wall, and they are
 * tinted toward the sky and stripped of grime: value and saturation falling off
 * with distance is what aerial perspective actually looks like, and geometry
 * can carry half of it before a fog term ever runs.
 */
function buildSkyline(b: WorldBuilder, rng: Rng): void {
  const haze = (base: THREE.Color, amount: number): THREE.Color =>
    base.clone().lerp(SKYLINE_HAZE, amount);

  // North: the grain end of the dock, closing the backlit and lane framings.
  distantSilos(b, -30, -45, 3, 2.5, 15.5, haze(PALETTE.plasterPale, 0.42));
  distantBlock(b, rng, {
    x: 3,
    z: -46,
    w: 26,
    d: 12,
    height: 10.5,
    tint: haze(PALETTE.plasterWarm, 0.4),
    ridge: 2.2,
  });
  distantStack(b, 21, -49, 1.3, 23, haze(PALETTE.plasterRose, 0.45));

  // East: a neighbouring shed and a quayside crane, seen past the platform.
  distantBlock(b, rng, {
    x: 45,
    z: -7,
    w: 13,
    d: 22,
    height: 12.5,
    tint: haze(PALETTE.plasterOchre, 0.44),
  });
  distantCrane(b, 43, 15, 18, haze(PALETTE.steelRust, 0.5));

  // South: a terrace of town blocks, the horizon of the elevated framing.
  let cursor = -34;
  while (cursor < 30) {
    const width = rng.range(8, 15);
    distantBlock(b, rng, {
      x: cursor + width / 2,
      z: 45 + rng.range(-2.5, 2.5),
      w: width,
      d: 11,
      height: rng.range(8, 13.5),
      tint: haze(rng.pick(WALL_TINTS), rng.range(0.36, 0.52)),
      ridge: rng.chance(0.45) ? rng.range(1.4, 2.6) : 0,
    });
    cursor += width + rng.range(1.2, 4);
  }
  distantBlock(b, rng, {
    x: -38,
    z: 41,
    w: 5.5,
    d: 5.5,
    height: 17,
    tint: haze(PALETTE.plasterPale, 0.4),
    ridge: 2.6,
  });

  // West: the back of the next warehouse, and a tank on a frame.
  distantBlock(b, rng, {
    x: -45,
    z: 4,
    w: 12,
    d: 24,
    height: 11,
    tint: haze(PALETTE.plasterWarm, 0.46),
    ridge: 1.8,
  });
  distantSilos(b, -43, -24, 2, 3.0, 13, haze(PALETTE.plasterOchre, 0.48));
}

/** Colour the distant masses are pulled toward, matching the sky near the horizon. */
const SKYLINE_HAZE = new THREE.Color(0.78, 0.84, 0.95);

interface DistantBlockOptions {
  x: number;
  z: number;
  w: number;
  d: number;
  height: number;
  tint: THREE.Color;
  /** Gable rise. 0 gives a flat roof with a parapet. */
  ridge?: number;
}

/** A background building: mass, roofline and one piece of roof clutter. */
function distantBlock(b: WorldBuilder, rng: Rng, o: DistantBlockOptions): void {
  const { x, z, w, d, height, tint, ridge = 0 } = o;
  b.box({
    x,
    y: 0,
    z,
    w,
    h: height,
    d,
    material: 'plaster',
    tint,
    grime: 0.1,
    mottle: 0.06,
    chamfer: 0.08,
    collide: false,
  });
  if (ridge > 0) {
    pitchedRoof(b, {
      cx: x,
      cz: z,
      y: height,
      span: w + 0.4,
      length: d,
      peak: ridge,
      rotY: Math.PI / 2,
      overhang: 0.4,
      tint: tint.clone().multiplyScalar(0.92),
      gables: true,
      gableTint: tint,
    });
  } else {
    b.box({
      x,
      y: height,
      z,
      w: w + 0.5,
      h: 0.6,
      d: d + 0.5,
      material: 'trim',
      tint: tint.clone().multiplyScalar(1.04),
      chamfer: 0.07,
      collide: false,
    });
    // A stair head or tank house, so no two rooflines are the same rectangle.
    b.box({
      x: x + rng.range(-w * 0.25, w * 0.25),
      y: height,
      z: z + rng.range(-d * 0.2, d * 0.2),
      w: rng.range(2.5, 4.5),
      h: rng.range(1.8, 3.2),
      d: rng.range(2.5, 4),
      material: 'plaster',
      tint: tint.clone().multiplyScalar(0.95),
      chamfer: 0.06,
      collide: false,
    });
  }
}

/** A row of silos with a conical cap and a headhouse bridging them. */
function distantSilos(
  b: WorldBuilder,
  x: number,
  z: number,
  count: number,
  radius: number,
  height: number,
  tint: THREE.Color
): void {
  const spacing = radius * 2.05;
  for (let i = 0; i < count; i++) {
    const cx = x + (i - (count - 1) / 2) * spacing;
    b.add(
      new THREE.CylinderGeometry(radius, radius, height, 16, 1, false),
      new THREE.Matrix4().compose(
        new THREE.Vector3(cx, height / 2, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1)
      ),
      {
        material: 'plaster',
        tint,
        uv: { mode: 'local', repeat: [(2 * Math.PI * radius) / 3, height / 3] },
      }
    );
    b.add(
      new THREE.ConeGeometry(radius * 1.06, radius * 0.8, 16, 1, false),
      new THREE.Matrix4().compose(
        new THREE.Vector3(cx, height + radius * 0.4, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1)
      ),
      { material: 'metal', tint: tint.clone().multiplyScalar(0.88), uv: { mode: 'world' } }
    );
  }
  b.box({
    x,
    y: height + radius * 0.8,
    z,
    w: spacing * count,
    h: 2.6,
    d: radius * 1.6,
    material: 'metal',
    tint: tint.clone().multiplyScalar(0.9),
    chamfer: 0.08,
    collide: false,
  });
}

/** A tapering chimney with banding. */
function distantStack(
  b: WorldBuilder,
  x: number,
  z: number,
  radius: number,
  height: number,
  tint: THREE.Color
): void {
  b.add(
    new THREE.CylinderGeometry(radius * 0.72, radius, height, 14, 1, false),
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, height / 2, z),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1)
    ),
    {
      material: 'plaster',
      tint,
      uv: { mode: 'local', repeat: [(2 * Math.PI * radius) / 3, height / 3] },
    }
  );
  for (const y of [height * 0.55, height * 0.98]) {
    b.add(
      new THREE.CylinderGeometry(radius * 0.86, radius * 0.9, 0.7, 14, 1, false),
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1)
      ),
      { material: 'metal', tint: tint.clone().multiplyScalar(0.82), uv: { mode: 'world' } }
    );
  }
}

/** An A-frame quay crane, read entirely as silhouette at this distance. */
function distantCrane(
  b: WorldBuilder,
  x: number,
  z: number,
  height: number,
  tint: THREE.Color
): void {
  for (const side of [-1, 1]) {
    latticeGirder(b, {
      from: new THREE.Vector3(x + side * 3.6, 0, z + side * 2.4),
      to: new THREE.Vector3(x, height, z),
      size: 1.1,
      chordRadius: 0.12,
      panels: 8,
      tint,
    });
  }
  latticeGirder(b, {
    from: new THREE.Vector3(x - 12, height - 1.2, z),
    to: new THREE.Vector3(x + 7, height + 2.6, z),
    size: 1.2,
    chordRadius: 0.11,
    panels: 11,
    tint,
  });
  b.box({
    x: x + 5.4,
    y: height + 1.2,
    z,
    w: 3.2,
    h: 2.4,
    d: 2.6,
    material: 'metal',
    tint: tint.clone().multiplyScalar(0.92),
    chamfer: 0.08,
    collide: false,
  });
}

/**
 * Near-camera elements that give the wide framings a foreground plane.
 *
 * Both wide shots were flat fields: everything in them sat at the same depth
 * and the frame had no edge. A drying frame beside the south-west approach and
 * a shade over the platform's near corner each put a dark, out-of-focus mass in
 * the top of frame, which is the cheapest depth cue there is.
 */
function buildForegroundFrames(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  // South-west approach, four metres in front of the establishing camera.
  const frameX = -21.8;
  const frameZ = 22.4;
  const frameTop = 4.15;
  for (const [ox, oz] of [
    [-1.7, -1.5],
    [1.7, -1.5],
    [-1.7, 1.5],
    [1.7, 1.5],
  ]) {
    b.box({
      x: frameX + ox,
      y: 0,
      z: frameZ + oz,
      w: 0.2,
      h: frameTop,
      d: 0.2,
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.55,
      mottle: 0.13,
      chamfer: 0.025,
      collide: 'wood',
    });
  }
  for (const oz of [-1.5, 1.5]) {
    b.box({
      x: frameX,
      y: frameTop,
      z: frameZ + oz,
      w: 3.9,
      h: 0.17,
      d: 0.14,
      material: 'wood',
      tint: PALETTE.woodWarm,
      grime: 0.35,
      chamfer: 0.02,
      collide: false,
    });
  }
  // Purlins across, with a half-rolled tarp thrown over two of them.
  for (let i = 0; i < 5; i++) {
    b.box({
      x: frameX - 1.6 + i * 0.8,
      y: frameTop + 0.17,
      z: frameZ,
      w: 0.11,
      h: 0.09,
      d: 3.3,
      material: 'wood',
      tint: PALETTE.woodGrey,
      grime: 0.3,
      chamfer: 0.015,
      collide: false,
    });
  }
  awning(b, {
    cx: frameX + 1.1,
    cz: frameZ,
    y: frameTop + 0.26,
    width: 3.2,
    depth: 1.9,
    rotY: Math.PI / 2,
    fall: 0.5,
    tint: PALETTE.canvasCream,
  });
  // Working spill at its feet, so the frame is somewhere a person uses.
  const frameRng = rng.fork('frameProps');
  stackCrates(b, props, frameRng, frameX + 1.5, frameZ + 1.2, 2, 0.9, 0, 0.4);
  placeBarrels(b, props, frameRng, [[frameX - 1.5, frameZ + 1.3]]);
  placePallet(props, frameRng, frameX - 1.3, frameZ - 1.2, 0.5);

  // Platform deck: a shade over the near corner of the elevated framing.
  const shadeX = PLATFORM.x + 2.6;
  const shadeZ = PLATFORM.z - PLATFORM.d / 2 + 1.6;
  const deck = PLATFORM.deck;
  for (const [ox, oz] of [
    [-1.8, -1.1],
    [1.8, -1.1],
    [-1.8, 1.1],
    [1.8, 1.1],
  ]) {
    b.box({
      x: shadeX + ox,
      y: deck,
      z: shadeZ + oz,
      w: 0.13,
      h: 2.45,
      d: 0.13,
      material: 'metal',
      tint: PALETTE.steelRust,
      grime: 0.4,
      chamfer: 0.02,
      collide: 'metal',
    });
  }
  awning(b, {
    cx: shadeX,
    cz: shadeZ,
    y: deck + 2.45,
    width: 4.0,
    depth: 2.5,
    rotY: 0,
    fall: 0.42,
    tint: PALETTE.canvasGreen,
  });
}

/**
 * A slung load under the gantry hook.
 *
 * The gantry was the only thing in the arena tall enough to be a focal point
 * and it was holding nothing, so the eye passed straight through it. A bundle
 * hanging in the middle of the lane at head height gives the convergence of
 * every leading line in the establishing framing something to land on.
 */
function buildGantryLoad(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  const { z } = GANTRY;
  const x = -2.6;
  const y = 2.35;

  // Spreader beam, then four slings up to the hook block at 4.0 m.
  b.box({
    x,
    y: y + 1.05,
    z,
    w: 2.9,
    h: 0.16,
    d: 0.22,
    material: 'metal',
    tint: PALETTE.steel,
    grime: 0.22,
    chamfer: 0.03,
    collide: false,
  });
  for (const side of [-1, 1]) {
    strut(
      b,
      new THREE.Vector3(x + side * 1.4, y + 1.05, z),
      new THREE.Vector3(x, 3.72, z),
      0.02,
      PALETTE.steelDark
    );
    for (const oz of [-0.62, 0.62]) {
      strut(
        b,
        new THREE.Vector3(x + side * 1.35, y + 1.02, z),
        new THREE.Vector3(x + side * 1.05, y + 0.42, z + oz),
        0.016,
        PALETTE.steelDark
      );
    }
  }

  // The load itself: banded timber on bearers, swinging a few degrees off true.
  const tilt = 0.045;
  for (let i = 0; i < 4; i++) {
    b.box({
      x,
      y: y + i * 0.19,
      z,
      w: 2.5,
      h: 0.17,
      d: 1.15,
      tiltZ: tilt,
      material: 'wood',
      tint: PALETTE.woodWarm.clone().multiplyScalar(rng.range(0.88, 1.08)),
      grime: 0.18,
      mottle: 0.1,
      chamfer: 0.02,
      collide: false,
    });
  }
  for (const ox of [-0.85, 0.85]) {
    b.box({
      x: x + ox,
      y: y - 0.03,
      z,
      w: 0.09,
      h: 0.82,
      d: 1.22,
      tiltZ: tilt,
      material: 'metal',
      tint: PALETTE.steel,
      grime: 0.3,
      chamfer: 0.015,
      collide: false,
    });
  }
  b.solid(new THREE.Vector3(x, y + 0.38, z), new THREE.Vector3(1.3, 0.42, 0.62), 'wood');
}

/**
 * A water tower over the north-east yard.
 *
 * The midground between the gantry and the perimeter had nothing in it taller
 * than a container, so the two read as one plane. This sits between them.
 */
function buildWaterTower(b: WorldBuilder, props: PropLibrary, x: number, z: number): void {
  const legTop = 8.2;
  const spread = 1.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      strut(
        b,
        new THREE.Vector3(x + sx * spread * 1.5, 0, z + sz * spread * 1.5),
        new THREE.Vector3(x + sx * spread, legTop, z + sz * spread),
        0.09,
        PALETTE.steelRust
      );
    }
  }
  // Horizontal ties and diagonals at two levels, which is what makes a tower
  // read as a frame rather than four sticks.
  for (const level of [2.9, 5.8]) {
    const t = level / legTop;
    const r = spread * 1.5 + (spread - spread * 1.5) * t;
    for (const [ax, az, bx, bz] of [
      [-1, -1, 1, -1],
      [1, -1, 1, 1],
      [1, 1, -1, 1],
      [-1, 1, -1, -1],
    ]) {
      strut(
        b,
        new THREE.Vector3(x + ax * r, level, z + az * r),
        new THREE.Vector3(x + bx * r, level, z + bz * r),
        0.045,
        PALETTE.steelRust
      );
      strut(
        b,
        new THREE.Vector3(x + ax * r, level, z + az * r),
        new THREE.Vector3(x + bx * r, level + 2.6, z + bz * r),
        0.032,
        PALETTE.steel
      );
    }
  }
  b.add(
    new THREE.CylinderGeometry(2.35, 2.35, 3.1, 18, 1, false),
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, legTop + 1.55, z),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1)
    ),
    {
      material: 'metal',
      tint: PALETTE.steelGreen,
      grime: 0.4,
      uv: { mode: 'local', repeat: [(2 * Math.PI * 2.35) / 2.5, 3.1 / 2.5] },
    }
  );
  b.add(
    new THREE.ConeGeometry(2.45, 0.95, 18, 1, false),
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, legTop + 3.55, z),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1)
    ),
    { material: 'metal', tint: PALETTE.steelRust, uv: { mode: 'world' } }
  );
  // Downpipe to the ground, and a valve stand at its foot.
  pipeRun(b, {
    from: new THREE.Vector3(x + 1.9, 0, z + 0.4),
    to: new THREE.Vector3(x + 1.9, legTop + 0.6, z + 0.4),
    radius: 0.11,
    tint: PALETTE.steelRust,
    bracketEvery: 2.4,
  });
  b.box({
    x: x + 1.9,
    y: 0,
    z: z + 1.3,
    w: 0.8,
    h: 1.0,
    d: 0.7,
    material: 'metal',
    tint: PALETTE.steelGreen,
    grime: 0.45,
    chamfer: 0.04,
  });
}

// -- overhead lines ---------------------------------------------------------

function buildOverheadLines(b: WorldBuilder, props: PropLibrary): void {
  // Strung across the lane, between the warehouse eaves and block B.
  cable(b, props, {
    from: new THREE.Vector3(-7.2, 6.2, -4.0),
    to: new THREE.Vector3(6.8, 5.6, 1.0),
    sag: 1.15,
    bulbs: 6,
  });
  cable(b, props, {
    from: new THREE.Vector3(-7.2, 6.6, -11.5),
    to: new THREE.Vector3(-9.0, 7.4, GANTRY.z),
    sag: 0.5,
  });
  // The long festoon run across the south yard. It needs a visible terminus at
  // the market end or it reads as a line drifting in from nowhere.
  const poleX = -18.5;
  const poleZ = 24.6;
  const poleTop = 5.4;
  cable(b, props, {
    from: new THREE.Vector3(6.8, 6.4, 11.0),
    to: new THREE.Vector3(poleX, poleTop - 0.25, poleZ),
    sag: 2.2,
    bulbs: 9,
  });
  b.box({
    x: poleX,
    y: 0,
    z: poleZ,
    w: 0.24,
    h: poleTop,
    d: 0.24,
    material: 'wood',
    tint: PALETTE.woodGrey,
    grime: 0.55,
    mottle: 0.14,
    chamfer: 0.03,
    collide: 'wood',
  });
  b.box({
    x: poleX,
    y: poleTop - 0.62,
    z: poleZ,
    w: 1.5,
    h: 0.12,
    d: 0.12,
    material: 'wood',
    tint: PALETTE.woodGrey,
    grime: 0.4,
    chamfer: 0.02,
    collide: false,
  });
  for (const side of [-1, 1]) {
    b.box({
      x: poleX + side * 0.6,
      y: poleTop - 0.5,
      z: poleZ,
      w: 0.09,
      h: 0.2,
      d: 0.09,
      material: 'trim',
      tint: PALETTE.concreteDark,
      collide: false,
      chamfer: 0.03,
    });
  }
  strut(
    b,
    new THREE.Vector3(poleX + 0.06, poleTop - 0.9, poleZ),
    new THREE.Vector3(poleX + 1.4, 0.1, poleZ - 0.3),
    0.022,
    PALETTE.steel
  );
  // Short drop into the stalls, so the pole feeds something.
  cable(b, props, {
    from: new THREE.Vector3(poleX, poleTop - 0.4, poleZ),
    to: new THREE.Vector3(-6.2, 3.1, 25.2),
    sag: 0.7,
    bulbs: 5,
  });
  cable(b, props, {
    from: new THREE.Vector3(21.4, 6.0, 1.0),
    to: new THREE.Vector3(30.2, 5.2, -3.0),
    sag: 0.9,
  });
  cable(b, props, {
    from: new THREE.Vector3(9.6, 7.6, GANTRY.z),
    to: new THREE.Vector3(12.5, 4.2, -13.5),
    sag: 0.6,
  });
}

// -- courtyard dressing -----------------------------------------------------

function dressCourtyard(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  // The cluster the material-detail shot frames: mixed heights, mixed
  // materials, and a barrel to catch a specular highlight.
  const heroRng = rng.fork('hero');
  stackCrates(b, props, heroRng, -5.4, 13.2, 2, 1.05);
  stackCrates(b, props, heroRng, -4.0, 14.4, 1, 0.85);
  placePallet(props, heroRng, -6.6, 14.4, 0.24);
  placePallet(props, heroRng, -6.5, 14.5, 0.31, 0.11);
  placeBarrels(b, props, heroRng, [
    [-6.6, 14.4],
    [-7.2, 13.6],
    [-6.1, 12.9],
  ]);
  sandbagWall(b, props, heroRng, { cx: -3.0, cz: 11.4, rotY: 0.22, length: 3.4, rows: 5 });
  b.box({
    x: -4.6,
    y: 0,
    z: 12.0,
    w: 0.14,
    h: 1.5,
    d: 0.14,
    rotY: 0.3,
    tiltZ: 0.24,
    material: 'wood',
    tint: PALETTE.woodGrey,
    grime: 0.4,
    chamfer: 0.02,
    collide: false,
  });

  // Cover down the lane, positioned to break the long sightline without
  // closing it: staggered so there is always a way through.
  const coverRng = rng.fork('cover');
  const covers: Array<[number, number, number]> = [
    [2.6, 4.5, 0.2],
    [-2.4, -3.0, -0.35],
    [4.4, -12.5, 0.15],
    [-3.6, -18.0, 0.5],
    [1.5, -24.0, -0.2],
    [-10.5, 3.6, 0.1],
    [-19.5, 6.4, 0.4],
    [-25.5, 3.0, -0.3],
    [24.5, 18.5, 0.25],
    [30.0, -12.0, -0.15],
    [21.0, -6.5, 0.35],
    [-30.0, 24.0, 0.1],
    [-14.0, 19.5, -0.4],
    [11.0, 14.5, 0.3],
    [-21.0, -22.5, 0.2],
    [6.0, -20.5, -0.25],
  ];
  for (const [x, z, rotY] of covers) {
    const count = coverRng.int(1, 3);
    stackCrates(b, props, coverRng, x, z, count, coverRng.range(0.85, 1.1), 0, rotY);
    if (coverRng.chance(0.55)) {
      placeBarrels(b, props, coverRng, [
        [x + coverRng.range(-1.6, 1.6), z + coverRng.range(-1.6, 1.6)],
      ]);
    }
    if (coverRng.chance(0.4)) {
      placePallet(props, coverRng, x + coverRng.range(-1.8, 1.8), z + coverRng.range(-1.8, 1.8), rotY);
    }
  }

  // Two more sandbag positions covering the flanking routes.
  sandbagWall(b, props, rng.fork('sbA'), { cx: -22.5, cz: -3.0, rotY: Math.PI / 2, length: 4.6, rows: 6 });
  sandbagWall(b, props, rng.fork('sbB'), { cx: 12.5, cz: -8.0, rotY: 0.15, length: 5.0, rows: 5 });

  // Bollards protecting the warehouse mouth and the gate.
  const matrix = new THREE.Matrix4();
  for (const [x, z] of [
    [-17.2, -1.6],
    [-8.8, -1.6],
    [0.4, -31.2],
    [7.6, -31.2],
    [22.0, 10.5],
  ] as const) {
    matrix.makeTranslation(x, 0.45, z);
    props.place('bollard', matrix, PALETTE.concreteDark);
  }

  // Wall-mounted service pipes on the perimeter, breaking up the long runs.
  pipeRun(b, {
    from: new THREE.Vector3(-BOUND + 0.66, 3.2, -14),
    to: new THREE.Vector3(-BOUND + 0.66, 3.2, 12),
    radius: 0.1,
    tint: PALETTE.steelRust,
    bracketEvery: 3.2,
  });
  pipeRun(b, {
    from: new THREE.Vector3(BOUND - 0.66, 4.0, -22),
    to: new THREE.Vector3(BOUND - 0.66, 4.0, 6),
    radius: 0.09,
    tint: PALETTE.steel,
    bracketEvery: 3.4,
  });
  pipeRun(b, {
    from: new THREE.Vector3(-16, 4.6, -BOUND + 0.66),
    to: new THREE.Vector3(6, 4.6, -BOUND + 0.66),
    radius: 0.08,
    tint: PALETTE.steelRust,
    bracketEvery: 3.0,
  });
}

// -- debris scatter ---------------------------------------------------------

function scatterDebris(b: WorldBuilder, props: PropLibrary, rng: Rng): void {
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();

  // Rubble field spilling from the collapsed north-west wall.
  const rubbleRng = rng.fork('rubble');
  for (let i = 0; i < 260; i++) {
    const x = rubbleRng.range(-32, -14);
    // Density falls off with distance from the wall, like a real spill.
    const spread = rubbleRng.range(0, 1) ** 1.7;
    const z = -BOUND + 0.9 + spread * 9;
    const big = rubbleRng.chance(0.24);
    euler.set(
      rubbleRng.range(0, Math.PI * 2),
      rubbleRng.range(0, Math.PI * 2),
      rubbleRng.range(0, Math.PI * 2)
    );
    quaternion.setFromEuler(euler);
    const s = big ? rubbleRng.range(0.34, 0.8) : rubbleRng.range(0.12, 0.3);
    scale.set(s * rubbleRng.range(0.8, 1.4), s * rubbleRng.range(0.6, 1.0), s * rubbleRng.range(0.8, 1.4));
    matrix.compose(new THREE.Vector3(x, s * 0.3, z), quaternion, scale);
    colour
      .copy(rubbleRng.chance(0.3) ? PALETTE.steelRust : PALETTE.plasterPale)
      .multiplyScalar(rubbleRng.range(0.55, 1.0));
    props.place(big ? 'rubbleLarge' : 'rubbleSmall', matrix, colour);
  }

  // A ramp of rubble the player can actually walk up, onto the low wall.
  b.solid(
    new THREE.Vector3(-23, 0.7, -BOUND + 2.6),
    new THREE.Vector3(3.4, 0.7, 1.9),
    'dirt',
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.32, 0, 0))
  );

  // General grit across the yard, densest where traffic converges.
  const gritRng = rng.fork('grit');
  for (let i = 0; i < 420; i++) {
    const x = gritRng.range(-BOUND + 1.5, BOUND - 1.5);
    const z = gritRng.range(-BOUND + 1.5, BOUND - 1.5);
    if (insideBuilding(x, z)) continue;
    euler.set(gritRng.range(0, Math.PI), gritRng.range(0, Math.PI * 2), gritRng.range(0, Math.PI));
    quaternion.setFromEuler(euler);
    const s = gritRng.range(0.07, 0.22);
    scale.set(s * gritRng.range(0.8, 1.5), s * 0.65, s * gritRng.range(0.8, 1.5));
    matrix.compose(new THREE.Vector3(x, s * 0.22, z), quaternion, scale);
    colour.copy(PALETTE.concrete).multiplyScalar(gritRng.range(0.45, 0.95));
    props.place('rubbleSmall', matrix, colour);
  }

  // Cobbled aprons by each doorway. Setts are small, tightly packed and barely
  // tilted: any more variation and they stop reading as paving and start
  // reading as scattered debris.
  const cobbleRng = rng.fork('cobbles');
  for (const [ax, az, aw, ad, rot] of [
    [-13, -1.3, 7.4, 3.0, 0],
    [6.0, 8.6, 2.8, 4.4, 0],
    [4, -31.3, 8.0, 2.4, 0],
    [-27.5, 10.2, 5.0, 2.2, 0],
    [20, -12.4, 6.0, 2.2, 0],
  ] as const) {
    const cols = Math.round(aw / 0.2);
    const rows = Math.round(ad / 0.2);
    for (let cx = 0; cx < cols; cx++) {
      for (let cz = 0; cz < rows; cz++) {
        if (cobbleRng.chance(0.04)) continue;
        const u = -aw / 2 + (aw * (cx + 0.5)) / cols + cobbleRng.range(-0.012, 0.012);
        const t = -ad / 2 + (ad * (cz + 0.5)) / rows + cobbleRng.range(-0.012, 0.012);
        const [px, pz] = localPoint(ax, az, rot, u, t);
        euler.set(
          cobbleRng.range(-0.02, 0.02),
          cobbleRng.range(-0.14, 0.14),
          cobbleRng.range(-0.02, 0.02)
        );
        quaternion.setFromEuler(euler);
        scale.set(
          (aw / cols) * cobbleRng.range(0.84, 0.95),
          cobbleRng.range(0.35, 0.5),
          (ad / rows) * cobbleRng.range(0.84, 0.95)
        );
        matrix.compose(new THREE.Vector3(px, 0.012, pz), quaternion, scale);
        colour.copy(PALETTE.concrete).multiplyScalar(cobbleRng.range(0.72, 1.05));
        props.place('cobble', matrix, colour);
      }
    }
  }

  // Loose boards, dropped where crates were opened.
  const plankRng = rng.fork('planks');
  for (let i = 0; i < 70; i++) {
    const x = plankRng.range(-BOUND + 3, BOUND - 3);
    const z = plankRng.range(-BOUND + 3, BOUND - 3);
    if (insideBuilding(x, z)) continue;
    euler.set(0, plankRng.range(0, Math.PI * 2), plankRng.range(-0.04, 0.04));
    quaternion.setFromEuler(euler);
    scale.set(plankRng.range(0.7, 1.9), 1, plankRng.range(0.8, 1.3));
    matrix.compose(new THREE.Vector3(x, 0.03, z), quaternion, scale);
    colour.copy(PALETTE.woodGrey).multiplyScalar(plankRng.range(0.6, 1.05));
    props.place('plank', matrix, colour);
  }

  // Weeds anywhere sheltered: against crates, in the rubble, along kerbs.
  const weedRng = rng.fork('weeds');
  for (let i = 0; i < 240; i++) {
    const x = weedRng.range(-BOUND + 1, BOUND - 1);
    const z = weedRng.range(-BOUND + 1, BOUND - 1);
    if (insideBuilding(x, z)) continue;
    // Bias toward the untravelled edges; the middle is scoured by traffic.
    if (weedRng.chance(0.72) && Math.hypot(x * 0.6, z) < 22) continue;
    quaternion.setFromEuler(new THREE.Euler(0, weedRng.range(0, Math.PI * 2), 0));
    const s = weedRng.range(0.6, 1.5);
    scale.set(s, weedRng.range(0.55, 1.4), s);
    matrix.compose(new THREE.Vector3(x, 0, z), quaternion, scale);
    props.place('foliage', matrix, PALETTE.foliage.clone().multiplyScalar(weedRng.range(0.7, 1.3)));
  }
}

// -- shared placement helpers ----------------------------------------------

const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();

function crateTint(rng: Rng): THREE.Color {
  const base = rng.chance(0.3) ? PALETTE.woodWarm : PALETTE.woodGrey;
  return base.clone().multiplyScalar(rng.range(0.86, 1.2));
}

/**
 * A leaning stack of crates. Both crate meshes are one metre tall in their own
 * space, so instance scale alone controls the silhouette.
 */
function stackCrates(
  b: WorldBuilder,
  props: PropLibrary,
  rng: Rng,
  x: number,
  z: number,
  count: number,
  size: number,
  baseY = 0,
  rotY = 0
): void {
  let y = baseY;
  let widest = 0;
  for (let i = 0; i < count; i++) {
    const tall = rng.chance(0.28);
    const s = size * rng.range(0.88, 1.06) * (i > 0 ? 0.92 : 1);
    const height = s * (tall ? rng.range(1.2, 1.5) : 1);
    _euler.set(0, rotY + rng.range(-0.35, 0.35), 0);
    _quaternion.setFromEuler(_euler);
    _scale.set(s, height, s);
    const ox = rng.range(-0.12, 0.12) * i;
    const oz = rng.range(-0.12, 0.12) * i;
    _matrix.compose(new THREE.Vector3(x + ox, y + height / 2, z + oz), _quaternion, _scale);
    props.place(tall ? 'crateTall' : 'crate', _matrix, crateTint(rng));
    y += height;
    widest = Math.max(widest, s);
  }
  // One collider for the whole stack, sized to the widest crate in it.
  const height = y - baseY;
  b.solid(
    new THREE.Vector3(x, baseY + height / 2, z),
    new THREE.Vector3(widest / 2, height / 2, widest / 2),
    'wood',
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0))
  );
}

function placePallet(
  props: PropLibrary,
  rng: Rng,
  x: number,
  z: number,
  rotY: number,
  y = 0
): void {
  _euler.set(0, rotY, 0);
  _quaternion.setFromEuler(_euler);
  _scale.set(1, 1, 1);
  _matrix.compose(new THREE.Vector3(x, y, z), _quaternion, _scale);
  props.place('pallet', _matrix, PALETTE.woodGrey.clone().multiplyScalar(rng.range(0.6, 1.0)));
}

function placeBarrels(
  b: WorldBuilder,
  props: PropLibrary,
  rng: Rng,
  spots: ReadonlyArray<readonly [number, number]>,
  baseY = 0
): void {
  const tints = [
    PALETTE.steelRust,
    PALETTE.steelBlue,
    PALETTE.steelGreen,
    PALETTE.steelRed,
    PALETTE.steelOrange,
  ];
  for (const [x, z] of spots) {
    _euler.set(0, rng.range(0, Math.PI * 2), 0);
    _quaternion.setFromEuler(_euler);
    _scale.set(1, 1, 1);
    _matrix.compose(new THREE.Vector3(x, baseY + 0.44, z), _quaternion, _scale);
    props.place('barrel', _matrix, rng.pick(tints).clone().multiplyScalar(rng.range(0.95, 1.3)));
    b.solid(
      new THREE.Vector3(x, baseY + 0.44, z),
      new THREE.Vector3(0.3, 0.44, 0.3),
      'metal'
    );
  }
}

/** Cheap rejection test so scatter does not drop props inside a building. */
function insideBuilding(x: number, z: number): boolean {
  const boxes = [WAREHOUSE, BLOCK_B, SHED_C, BLOCK_D];
  for (const box of boxes) {
    if (
      Math.abs(x - box.x) < box.w / 2 + 0.4 &&
      Math.abs(z - box.z) < box.d / 2 + 0.4
    ) {
      return true;
    }
  }
  return false;
}

// -- shots and spawns -------------------------------------------------------

const SHOTS: ShotPreset[] = [
  {
    id: 'establishing',
    intent: 'Wide read of the arena: silhouette, lighting direction, depth.',
    position: [-26, 3.2, 26],
    target: [8, 2, -6],
    fov: 75,
    viewmodel: false,
    warmup: 0.5,
  },
  {
    id: 'lane',
    intent: 'Player eye level down the main lane, the most-seen framing.',
    position: [-2.5, 1.65, 20],
    target: [4, 1.5, -14],
    fov: 90,
    warmup: 0.5,
  },
  {
    id: 'material-detail',
    intent: 'Close read of material response, normal detail and contact shadows.',
    position: [-3.4, 1.15, 15.6],
    target: [-5.2, 0.6, 13.4],
    fov: 55,
    viewmodel: false,
  },
  {
    id: 'backlit',
    intent: 'Shooting into the sun: bloom, volumetrics, specular and rim light.',
    position: [10, 1.7, 20],
    target: [-9, 7, -14],
    fov: 80,
    viewmodel: false,
  },
  {
    id: 'interior-shadow',
    intent: 'Shadowed pocket: ambient occlusion, indirect light, black levels.',
    position: [-13, 1.6, 2.5],
    target: [-13, 1.4, -8],
    fov: 85,
    viewmodel: false,
  },
  {
    id: 'elevated',
    intent: 'From the platform: shadow cascade transitions at distance.',
    position: [20, 4.7, -18],
    target: [-8, 1, 14],
    fov: 85,
    viewmodel: false,
  },
];

const SPAWNS = [
  new THREE.Vector3(-2.5, 1.0, 20),
  new THREE.Vector3(24, 4.0, -18),
  new THREE.Vector3(-26, 1.0, -18),
  new THREE.Vector3(18, 1.0, 18),
];
