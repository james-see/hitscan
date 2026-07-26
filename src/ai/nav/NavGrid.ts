import * as THREE from 'three';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';

/**
 * A 2.5D navigation grid voxelised from the live physics world.
 *
 * Chosen over recast-navigation deliberately. Recast produces prettier
 * polygons, but it needs the level's triangle soup handed to it, and the
 * arena is being art-passed concurrently by another agent — anything that
 * reads geometry directly would break the moment the layout changes. Probing
 * the physics world with rays depends only on collision, which is the one
 * thing that must stay correct for the game to work at all. The cost is that
 * genuinely overlapping walkable surfaces (a catwalk over a floor) collapse
 * to a single height per column; this arena has none, and the connectivity
 * pass discards the unreachable islands that stacked crates would otherwise
 * create.
 *
 * Everything is stored in flat typed arrays: A* runs thousands of times per
 * minute and object-per-cell would dominate the profile in allocation alone.
 */

export const CellFlag = {
  /** A floor surface was found in this column. */
  Floor: 1 << 0,
  /** Floor plus headroom plus an acceptable slope. */
  Walkable: 1 << 1,
  /** Walkable, wide enough for the agent, and in the main connected region. */
  Agent: 1 << 2,
} as const;

export interface NavGridConfig {
  cellSize: number;
  agentRadius: number;
  agentHeight: number;
  maxStep: number;
  /** Minimum floor normal Y. Steeper surfaces are not stood on. */
  minNormalY: number;
  bounds: THREE.Box3;
}

const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);

/** Neighbour offsets, orthogonals first so ties favour straight motion. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export class NavGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  readonly config: NavGridConfig;

  readonly height: Float32Array;
  readonly flags: Uint8Array;
  /** Metres to the nearest non-walkable cell, saturated at 4m. */
  readonly clearance: Float32Array;
  /** Connected-component id, -1 for unreachable or non-walkable cells. */
  readonly region: Int32Array;

  /** Cell count in the largest region, reported for diagnostics. */
  mainRegionCells = 0;
  mainRegion = -1;
  buildMs = 0;
  rayCount = 0;

  private constructor(config: NavGridConfig) {
    this.config = config;
    this.cellSize = config.cellSize;
    const size = config.bounds.getSize(new THREE.Vector3());
    this.cols = Math.max(1, Math.ceil(size.x / config.cellSize));
    this.rows = Math.max(1, Math.ceil(size.z / config.cellSize));
    this.originX = config.bounds.min.x;
    this.originZ = config.bounds.min.z;

    const count = this.cols * this.rows;
    this.height = new Float32Array(count);
    this.flags = new Uint8Array(count);
    this.clearance = new Float32Array(count);
    this.region = new Int32Array(count).fill(-1);
  }

  static build(physics: PhysicsWorld, config: NavGridConfig): NavGrid {
    const grid = new NavGrid(config);
    const started = performance.now();
    grid.#sampleColumns(physics);
    grid.#computeClearance();
    grid.#labelRegions();
    grid.buildMs = performance.now() - started;
    return grid;
  }

  index(cx: number, cz: number): number {
    return cz * this.cols + cx;
  }

  inBounds(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.cols && cz < this.rows;
  }

  cellX(worldX: number): number {
    return Math.floor((worldX - this.originX) / this.cellSize);
  }

  cellZ(worldZ: number): number {
    return Math.floor((worldZ - this.originZ) / this.cellSize);
  }

  worldX(cx: number): number {
    return this.originX + (cx + 0.5) * this.cellSize;
  }

  worldZ(cz: number): number {
    return this.originZ + (cz + 0.5) * this.cellSize;
  }

  cellAt(worldX: number, worldZ: number): number {
    const cx = this.cellX(worldX);
    const cz = this.cellZ(worldZ);
    return this.inBounds(cx, cz) ? this.index(cx, cz) : -1;
  }

  isAgentCell(index: number): boolean {
    return index >= 0 && (this.flags[index] & CellFlag.Agent) !== 0;
  }

  toWorld(index: number, out: THREE.Vector3): THREE.Vector3 {
    const cx = index % this.cols;
    const cz = (index - cx) / this.cols;
    return out.set(this.worldX(cx), this.height[index], this.worldZ(cz));
  }

  /**
   * Ground height under a point, bilinearly filtered across cells whose
   * heights agree. Filtering matters: stepping the body height per 0.5m cell
   * makes bots visibly stutter on ramps.
   */
  sampleHeight(worldX: number, worldZ: number, fallback: number): number {
    const fx = (worldX - this.originX) / this.cellSize - 0.5;
    const fz = (worldZ - this.originZ) / this.cellSize - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;

    let total = 0;
    let weight = 0;
    let reference = fallback;
    const centre = this.cellAt(worldX, worldZ);
    if (centre >= 0 && (this.flags[centre] & CellFlag.Floor) !== 0) {
      reference = this.height[centre];
    }

    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) {
        const cx = x0 + dx;
        const cz = z0 + dz;
        if (!this.inBounds(cx, cz)) continue;
        const i = this.index(cx, cz);
        if ((this.flags[i] & CellFlag.Floor) === 0) continue;
        // Reject columns on a different level so a bot walking beside a
        // platform does not get dragged upward by the platform's cells.
        if (Math.abs(this.height[i] - reference) > this.config.maxStep * 1.6) continue;
        const w = (dx ? tx : 1 - tx) * (dz ? tz : 1 - tz);
        total += this.height[i] * w;
        weight += w;
      }
    }
    return weight > 1e-4 ? total / weight : reference;
  }

  /** Nearest cell the agent can stand in, searched outward in rings. */
  nearestAgentCell(worldX: number, worldZ: number, maxRadius = 6): number {
    const cx = this.cellX(worldX);
    const cz = this.cellZ(worldZ);
    if (this.inBounds(cx, cz)) {
      const direct = this.index(cx, cz);
      if (this.isAgentCell(direct)) return direct;
    }
    const maxRing = Math.ceil(maxRadius / this.cellSize);
    for (let r = 1; r <= maxRing; r++) {
      let best = -1;
      let bestDistance = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (!this.inBounds(nx, nz)) continue;
          const i = this.index(nx, nz);
          if (!this.isAgentCell(i)) continue;
          const d = dx * dx + dz * dz;
          if (d < bestDistance) {
            bestDistance = d;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * True when an agent of `radius` can walk the straight segment between two
   * points. This is what turns a staircase of grid cells into a straight
   * line; without it paths zig-zag at 45 degrees and look robotic.
   */
  lineOfWalk(ax: number, az: number, bx: number, bz: number, radius: number): boolean {
    const inv = 1 / this.cellSize;
    let x = (ax - this.originX) * inv;
    let z = (az - this.originZ) * inv;
    const ex = (bx - this.originX) * inv;
    const ez = (bz - this.originZ) * inv;

    let cx = Math.floor(x);
    let cz = Math.floor(z);
    const endX = Math.floor(ex);
    const endZ = Math.floor(ez);

    const dx = ex - x;
    const dz = ez - z;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX =
      dx !== 0 ? ((dx > 0 ? cx + 1 - x : x - cx) * tDeltaX) : Infinity;
    let tMaxZ =
      dz !== 0 ? ((dz > 0 ? cz + 1 - z : z - cz) * tDeltaZ) : Infinity;

    if (!this.#segmentCellOk(cx, cz, radius)) return false;
    let previousHeight = this.#heightOf(cx, cz);

    // Bounded so a degenerate segment can never spin the loop.
    const limit = this.cols + this.rows + 4;
    for (let i = 0; i < limit; i++) {
      if (cx === endX && cz === endZ) return true;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (!this.#segmentCellOk(cx, cz, radius)) return false;
      const h = this.#heightOf(cx, cz);
      if (Math.abs(h - previousHeight) > this.config.maxStep) return false;
      previousHeight = h;
    }
    return false;
  }

  #segmentCellOk(cx: number, cz: number, radius: number): boolean {
    if (!this.inBounds(cx, cz)) return false;
    const i = this.index(cx, cz);
    if ((this.flags[i] & CellFlag.Agent) === 0) return false;
    return this.clearance[i] >= radius;
  }

  #heightOf(cx: number, cz: number): number {
    return this.height[this.index(cx, cz)];
  }

  // -- build stages ---------------------------------------------------------

  #sampleColumns(physics: PhysicsWorld): void {
    const { bounds, agentHeight, minNormalY } = this.config;
    const top = bounds.max.y + 1.5;
    const span = top - bounds.min.y + 1.5;
    let rays = 0;

    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = this.index(cx, cz);
        _origin.set(this.worldX(cx), top, this.worldZ(cz));
        const down = physics.raycast({
          origin: _origin,
          direction: _down,
          maxDistance: span,
          groups: CollisionGroup.World,
        });
        rays++;
        if (!down) continue;

        this.height[i] = down.point.y;
        this.flags[i] = CellFlag.Floor;
        if (down.normal.y < minNormalY && down.normal.y > -minNormalY) continue;

        // Headroom. Start slightly above the floor so the ray does not
        // immediately re-hit the surface it just landed on.
        _origin.set(down.point.x, down.point.y + 0.2, down.point.z);
        const up = physics.raycast({
          origin: _origin,
          direction: _up,
          maxDistance: agentHeight - 0.2,
          groups: CollisionGroup.World,
        });
        rays++;
        if (up) continue;

        this.flags[i] |= CellFlag.Walkable;
      }
    }
    this.rayCount = rays;
  }

  /**
   * Chamfer distance transform from non-walkable cells. Two sweeps is an
   * approximation of Euclidean distance accurate to ~2%, which is far below
   * the resolution the steering cares about.
   */
  #computeClearance(): void {
    const { cols, rows, cellSize } = this;
    const d = this.clearance;
    const far = 1e6;
    const orthogonal = cellSize;
    const diagonal = cellSize * Math.SQRT2;

    for (let i = 0; i < d.length; i++) {
      d[i] = (this.flags[i] & CellFlag.Walkable) !== 0 ? far : 0;
    }

    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const i = this.index(x, z);
        if (d[i] === 0) continue;
        let best = d[i];
        if (x > 0) best = Math.min(best, d[i - 1] + orthogonal);
        if (z > 0) best = Math.min(best, d[i - cols] + orthogonal);
        if (x > 0 && z > 0) best = Math.min(best, d[i - cols - 1] + diagonal);
        if (x < cols - 1 && z > 0) best = Math.min(best, d[i - cols + 1] + diagonal);
        d[i] = best;
      }
    }
    for (let z = rows - 1; z >= 0; z--) {
      for (let x = cols - 1; x >= 0; x--) {
        const i = this.index(x, z);
        if (d[i] === 0) continue;
        let best = d[i];
        if (x < cols - 1) best = Math.min(best, d[i + 1] + orthogonal);
        if (z < rows - 1) best = Math.min(best, d[i + cols] + orthogonal);
        if (x < cols - 1 && z < rows - 1) best = Math.min(best, d[i + cols + 1] + diagonal);
        if (x > 0 && z < rows - 1) best = Math.min(best, d[i + cols - 1] + diagonal);
        d[i] = best;
      }
    }
    for (let i = 0; i < d.length; i++) if (d[i] > 4) d[i] = 4;
  }

  /**
   * Flood fill over cells the agent physically fits in, respecting step
   * height. Anything not connected to the largest region — crate tops, the
   * strip outside the perimeter wall — is removed so pathfinding can never
   * target somewhere a bot cannot reach.
   */
  #labelRegions(): void {
    const need = this.config.agentRadius;
    const candidate = new Uint8Array(this.flags.length);
    for (let i = 0; i < candidate.length; i++) {
      candidate[i] =
        (this.flags[i] & CellFlag.Walkable) !== 0 && this.clearance[i] >= need ? 1 : 0;
    }

    const queue = new Int32Array(candidate.length);
    let regionId = 0;
    let bestRegion = -1;
    let bestCount = 0;

    for (let seed = 0; seed < candidate.length; seed++) {
      if (candidate[seed] === 0 || this.region[seed] !== -1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      this.region[seed] = regionId;
      let count = 0;

      while (head < tail) {
        const current = queue[head++];
        count++;
        const cx = current % this.cols;
        const cz = (current - cx) / this.cols;
        const h = this.height[current];
        for (let n = 0; n < NEIGHBOURS.length; n++) {
          const [dx, dz] = NEIGHBOURS[n] as [number, number, number];
          const nx = cx + dx;
          const nz = cz + dz;
          if (!this.inBounds(nx, nz)) continue;
          const ni = this.index(nx, nz);
          if (candidate[ni] === 0 || this.region[ni] !== -1) continue;
          if (Math.abs(this.height[ni] - h) > this.config.maxStep) continue;
          // A diagonal is only traversable when both orthogonals are too,
          // otherwise bots clip corners of geometry.
          if (dx !== 0 && dz !== 0) {
            const a = this.index(cx + dx, cz);
            const b = this.index(cx, cz + dz);
            if (candidate[a] === 0 || candidate[b] === 0) continue;
          }
          this.region[ni] = regionId;
          queue[tail++] = ni;
        }
      }

      if (count > bestCount) {
        bestCount = count;
        bestRegion = regionId;
      }
      regionId++;
    }

    this.mainRegion = bestRegion;
    this.mainRegionCells = bestCount;
    for (let i = 0; i < this.flags.length; i++) {
      if (this.region[i] === bestRegion) this.flags[i] |= CellFlag.Agent;
      else this.region[i] = -1;
    }
  }

  /** Neighbour table, exposed so the pathfinder does not duplicate it. */
  static get neighbours(): ReadonlyArray<readonly [number, number, number]> {
    return NEIGHBOURS;
  }
}
