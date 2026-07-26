import * as THREE from 'three';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';
import { CellFlag, NavGrid } from './NavGrid.ts';
import { AGENT, COVER } from '../Tuning.ts';

/**
 * Cover positions harvested from the nav grid.
 *
 * A cover point is a standable cell with a tall neighbour. That is a purely
 * geometric definition and says nothing about whether it is useful, so the
 * runtime scoring below ray-tests each candidate against the actual threat
 * position: cover is only cover relative to where the shooter is standing.
 */

export interface CoverPoint {
  position: THREE.Vector3;
  /** Points away from the obstacle, i.e. the direction the bot faces. */
  normal: THREE.Vector3;
  /** Height of the obstacle above the standing surface. */
  obstacleHeight: number;
  /** True when the obstacle is tall enough to stand behind. */
  standing: boolean;
}

export interface CoverChoice {
  point: CoverPoint;
  score: number;
  /** Lateral offset that has a firing line on the threat, in world space. */
  peek: THREE.Vector3 | null;
  /** Bots must crouch here to stay hidden. */
  crouched: boolean;
}

const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _probe = new THREE.Vector3();

/** Chest height used for cover tests, standing and crouched. */
const STAND_CHEST = 1.35;
const CROUCH_CHEST = 0.85;

export class CoverMap {
  readonly points: CoverPoint[] = [];
  /** Bucket index for the broad-phase, keyed by a coarse cell hash. */
  #buckets = new Map<number, number[]>();
  #bucketSize = 4;

  constructor(grid: NavGrid) {
    this.#harvest(grid);
    this.#index();
  }

  #harvest(grid: NavGrid): void {
    const { cols, rows } = grid;
    // Thin candidates on a coarse lattice: adjacent cells behind the same
    // crate are the same tactical position and evaluating all of them just
    // burns rays.
    const stride = Math.max(1, Math.round(COVER.spacing / grid.cellSize));
    const best = new Map<number, { score: number; point: CoverPoint }>();

    for (let cz = 1; cz < rows - 1; cz++) {
      for (let cx = 1; cx < cols - 1; cx++) {
        const i = grid.index(cx, cz);
        if ((grid.flags[i] & CellFlag.Agent) === 0) continue;
        if (grid.clearance[i] < AGENT.radius + 0.05) continue;
        const floor = grid.height[i];

        let bestHeight = 0;
        let nx = 0;
        let nz = 0;
        for (let n = 0; n < NavGrid.neighbours.length; n++) {
          const [dx, dz] = NavGrid.neighbours[n] as [number, number, number];
          const ni = grid.index(cx + dx, cz + dz);
          const blocked = (grid.flags[ni] & CellFlag.Walkable) === 0;
          const rise = (grid.flags[ni] & CellFlag.Floor) !== 0 ? grid.height[ni] - floor : 3;
          const obstacle = blocked ? Math.max(rise, COVER.lowHeight) : rise;
          if (obstacle > bestHeight) {
            bestHeight = obstacle;
            nx = -dx;
            nz = -dz;
          }
        }
        if (bestHeight < COVER.lowHeight) continue;

        const bucketX = Math.floor(cx / stride);
        const bucketZ = Math.floor(cz / stride);
        const key = bucketZ * cols + bucketX;
        // Prefer the roomiest cell in each bucket: bots pinned against a wall
        // corner cannot peek out of it.
        const score = grid.clearance[i] + Math.min(bestHeight, 2) * 0.35;
        const existing = best.get(key);
        if (existing && existing.score >= score) continue;

        const inverse = 1 / Math.hypot(nx, nz);
        best.set(key, {
          score,
          point: {
            position: new THREE.Vector3(grid.worldX(cx), floor, grid.worldZ(cz)),
            normal: new THREE.Vector3(nx * inverse, 0, nz * inverse),
            obstacleHeight: bestHeight,
            standing: bestHeight >= COVER.highHeight,
          },
        });
      }
    }

    for (const entry of best.values()) this.points.push(entry.point);
  }

  #index(): void {
    for (let i = 0; i < this.points.length; i++) {
      const p = (this.points[i] as CoverPoint).position;
      const key = this.#hash(p.x, p.z);
      const bucket = this.#buckets.get(key);
      if (bucket) bucket.push(i);
      else this.#buckets.set(key, [i]);
    }
  }

  #hash(x: number, z: number): number {
    const cx = Math.floor(x / this.#bucketSize);
    const cz = Math.floor(z / this.#bucketSize);
    return (cx & 0xffff) | ((cz & 0xffff) << 16);
  }

  /** Cover points within `radius` of a position, unsorted. */
  near(position: THREE.Vector3, radius: number, out: CoverPoint[]): CoverPoint[] {
    out.length = 0;
    const span = Math.ceil(radius / this.#bucketSize);
    const cx = Math.floor(position.x / this.#bucketSize);
    const cz = Math.floor(position.z / this.#bucketSize);
    const r2 = radius * radius;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const key = ((cx + dx) & 0xffff) | (((cz + dz) & 0xffff) << 16);
        const bucket = this.#buckets.get(key);
        if (!bucket) continue;
        for (const index of bucket) {
          const point = this.points[index] as CoverPoint;
          const ddx = point.position.x - position.x;
          const ddz = point.position.z - position.z;
          if (ddx * ddx + ddz * ddz <= r2) out.push(point);
        }
      }
    }
    return out;
  }

  /**
   * Picks the best cover for a bot at `from` against a threat at `threat`.
   *
   * Scoring is deliberately blunt — protection first, then a firing line,
   * then travel cost — because a bot that agonises over a marginally better
   * position reads as indecisive.
   */
  evaluate(
    physics: PhysicsWorld,
    from: THREE.Vector3,
    threat: THREE.Vector3,
    threatEyeHeight: number,
    options: {
      searchRadius?: number;
      preferredRange?: number;
      /** Positive values push the choice away from the threat. */
      retreatBias?: number;
      scratch: CoverPoint[];
    }
  ): CoverChoice | null {
    const radius = options.searchRadius ?? COVER.searchRadius;
    const preferred = options.preferredRange ?? 14;
    const retreat = options.retreatBias ?? 0;

    const candidates = this.near(from, radius, options.scratch);
    if (candidates.length === 0) return null;

    _eye.copy(threat);
    _eye.y += threatEyeHeight;

    // Cheap ordering pass so the ray budget is spent on plausible options.
    candidates.sort((a, b) => coarse(a) - coarse(b));
    function coarse(point: CoverPoint): number {
      const travel = point.position.distanceTo(from);
      const standoff = Math.abs(point.position.distanceTo(threat) - preferred);
      const away = retreat * -point.position.distanceTo(threat);
      // Facing matters: cover whose obstacle is between the bot and the
      // threat is worth checking, cover facing away almost never is.
      _dir.subVectors(threat, point.position).normalize();
      const facing = -point.normal.dot(_dir);
      // Facing dominates. Orientation is the only cheap term that actually
      // predicts whether the ray test will pass, so letting travel distance
      // outweigh it just spends the ray budget on near-by positions that are
      // wide open.
      return travel * 0.32 + standoff * 0.25 + away + facing * 14;
    }

    let bestChoice: CoverChoice | null = null;
    let bestScore = -Infinity;
    const limit = Math.min(COVER.evaluateCount, candidates.length);

    for (let i = 0; i < limit; i++) {
      const point = candidates[i] as CoverPoint;
      const standHidden = !this.#visible(physics, _eye, point.position, STAND_CHEST);
      const crouchHidden =
        standHidden || !this.#visible(physics, _eye, point.position, CROUCH_CHEST);
      if (!crouchHidden) continue;

      // A peek is a lateral step that regains the firing line. Without one
      // the bot has hidden rather than taken cover.
      _dir.subVectors(_eye, point.position).setY(0).normalize();
      _right.set(-_dir.z, 0, _dir.x);
      let peek: THREE.Vector3 | null = null;
      for (const side of [1, -1]) {
        _probe
          .copy(point.position)
          .addScaledVector(_right, side * COVER.peekOffset);
        if (this.#visible(physics, _eye, _probe, STAND_CHEST)) {
          peek = _probe.clone();
          break;
        }
      }

      const travel = point.position.distanceTo(from);
      const standoff = Math.abs(point.position.distanceTo(threat) - preferred);
      const score =
        (standHidden ? 3.5 : 2.2) +
        (point.standing ? 1.1 : 0) +
        (peek ? 2.4 : 0) +
        retreat * point.position.distanceTo(threat) * 0.12 -
        travel * 0.16 -
        standoff * 0.08;

      if (score > bestScore) {
        bestScore = score;
        bestChoice = { point, score, peek, crouched: !standHidden };
      }
    }

    return bestChoice;
  }

  /** True when a ray from `eye` reaches `position + height` unobstructed. */
  #visible(
    physics: PhysicsWorld,
    eye: THREE.Vector3,
    position: THREE.Vector3,
    height: number
  ): boolean {
    _target.copy(position);
    _target.y += height;
    _dir.subVectors(_target, eye);
    const distance = _dir.length();
    if (distance < 0.05) return true;
    _dir.multiplyScalar(1 / distance);
    const hit = physics.raycast({
      origin: eye,
      direction: _dir,
      maxDistance: distance - 0.05,
      groups: CollisionGroup.World,
    });
    return hit === null;
  }
}
