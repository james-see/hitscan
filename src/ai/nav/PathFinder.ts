import * as THREE from 'three';
import { CellFlag, NavGrid } from './NavGrid.ts';
import { NAV } from '../Tuning.ts';

/**
 * Budgeted A* over the nav grid, plus the string-pulling that turns a cell
 * chain into something a person would walk.
 *
 * Searches are queued rather than run on demand. Twelve bots each repathing
 * on contact would otherwise land in the same frame and produce exactly the
 * kind of periodic hitch that the 1% low is meant to catch. The queue spends
 * a fixed node budget per tick and resumes next tick; a bot with a stale path
 * keeps walking it in the meantime, which is invisible at these timescales.
 */

export type PathStatus = 'complete' | 'partial' | 'failed';

export interface PathResult {
  points: THREE.Vector3[];
  status: PathStatus;
  /** Cell the search was asked to reach, for staleness checks. */
  goalCell: number;
}

interface PathRequest {
  id: number;
  startCell: number;
  goalCell: number;
  goalPoint: THREE.Vector3;
  radius: number;
  resolve: (result: PathResult) => void;
  cancelled: boolean;
}

/** Binary min-heap over cell indices keyed by an external score array. */
class Heap {
  #items: Int32Array;
  #size = 0;
  #score: Float32Array;

  constructor(capacity: number, score: Float32Array) {
    this.#items = new Int32Array(Math.max(64, capacity));
    this.#score = score;
  }

  get size(): number {
    return this.#size;
  }

  clear(): void {
    this.#size = 0;
  }

  push(value: number): void {
    if (this.#size === this.#items.length) {
      const grown = new Int32Array(this.#items.length * 2);
      grown.set(this.#items);
      this.#items = grown;
    }
    let i = this.#size++;
    this.#items[i] = value;
    const score = this.#score;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (score[this.#items[parent]] <= score[this.#items[i]]) break;
      const tmp = this.#items[parent];
      this.#items[parent] = this.#items[i];
      this.#items[i] = tmp;
      i = parent;
    }
  }

  pop(): number {
    const top = this.#items[0];
    const last = this.#items[--this.#size];
    if (this.#size > 0) {
      this.#items[0] = last;
      const score = this.#score;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.#size && score[this.#items[left]] < score[this.#items[smallest]]) {
          smallest = left;
        }
        if (right < this.#size && score[this.#items[right]] < score[this.#items[smallest]]) {
          smallest = right;
        }
        if (smallest === i) break;
        const tmp = this.#items[smallest];
        this.#items[smallest] = this.#items[i];
        this.#items[i] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}

const _a = new THREE.Vector3();

export class PathFinder {
  readonly grid: NavGrid;

  #gScore: Float32Array;
  #fScore: Float32Array;
  #cameFrom: Int32Array;
  /** Generation stamps avoid clearing three big arrays per search. */
  #stamp: Int32Array;
  #closed: Uint8Array;
  #generation = 0;
  #heap: Heap;

  #queue: PathRequest[] = [];
  #nextId = 1;

  /** Rolling diagnostics, surfaced by the behaviour test. */
  searches = 0;
  nodesExpanded = 0;
  failures = 0;

  constructor(grid: NavGrid) {
    this.grid = grid;
    const count = grid.cols * grid.rows;
    this.#gScore = new Float32Array(count);
    this.#fScore = new Float32Array(count);
    this.#cameFrom = new Int32Array(count);
    this.#stamp = new Int32Array(count).fill(-1);
    this.#closed = new Uint8Array(count);
    this.#heap = new Heap(2048, this.#fScore);
  }

  /**
   * Queues a search. The returned handle can be cancelled if the bot changes
   * its mind before the search runs.
   */
  request(
    start: THREE.Vector3,
    goal: THREE.Vector3,
    radius: number,
    resolve: (result: PathResult) => void
  ): number {
    const startCell = this.grid.nearestAgentCell(start.x, start.z, 3);
    const goalCell = this.grid.nearestAgentCell(goal.x, goal.z, 4);
    const id = this.#nextId++;
    if (startCell < 0 || goalCell < 0) {
      resolve({ points: [], status: 'failed', goalCell });
      this.failures++;
      return id;
    }
    this.#queue.push({
      id,
      startCell,
      goalCell,
      goalPoint: goal.clone(),
      radius,
      resolve,
      cancelled: false,
    });
    return id;
  }

  cancel(id: number): void {
    for (const request of this.#queue) {
      if (request.id === id) request.cancelled = true;
    }
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Spends this tick's node budget on the head of the queue. */
  update(): void {
    let budget = NAV.nodeBudgetPerTick;
    let served = 0;
    while (this.#queue.length > 0 && served < NAV.requestsPerTick && budget > 0) {
      const request = this.#queue.shift() as PathRequest;
      if (request.cancelled) continue;
      const result = this.#search(request, budget);
      budget -= result.nodes;
      served++;
      request.resolve(result.path);
    }
  }

  /** Runs a search immediately, ignoring the queue. Used for spawn placement. */
  solveNow(
    start: THREE.Vector3,
    goal: THREE.Vector3,
    radius: number
  ): PathResult {
    const startCell = this.grid.nearestAgentCell(start.x, start.z, 3);
    const goalCell = this.grid.nearestAgentCell(goal.x, goal.z, 4);
    if (startCell < 0 || goalCell < 0) {
      return { points: [], status: 'failed', goalCell };
    }
    return this.#search(
      {
        id: 0,
        startCell,
        goalCell,
        goalPoint: goal.clone(),
        radius,
        resolve: () => {},
        cancelled: false,
      },
      NAV.maxNodesPerSearch
    ).path;
  }

  #search(request: PathRequest, budget: number): { path: PathResult; nodes: number } {
    const grid = this.grid;
    const { startCell, goalCell } = request;
    const cols = grid.cols;
    const cellSize = grid.cellSize;

    if (startCell === goalCell) {
      const points = [grid.toWorld(goalCell, new THREE.Vector3())];
      return { path: { points, status: 'complete', goalCell }, nodes: 1 };
    }

    const generation = ++this.#generation;
    const stamp = this.#stamp;
    const gScore = this.#gScore;
    const fScore = this.#fScore;
    const cameFrom = this.#cameFrom;
    const closed = this.#closed;
    const heap = this.#heap;
    heap.clear();

    const goalX = goalCell % cols;
    const goalZ = (goalCell - goalX) / cols;

    const heuristic = (cell: number): number => {
      const x = cell % cols;
      const z = (cell - x) / cols;
      const dx = Math.abs(x - goalX);
      const dz = Math.abs(z - goalZ);
      // Octile distance: the exact cost of an unobstructed 8-connected walk.
      const octile = (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
      return octile * cellSize * NAV.heuristicWeight;
    };

    stamp[startCell] = generation;
    gScore[startCell] = 0;
    fScore[startCell] = heuristic(startCell);
    cameFrom[startCell] = -1;
    closed[startCell] = 0;
    heap.push(startCell);

    const limit = Math.min(budget, NAV.maxNodesPerSearch);
    let expanded = 0;
    let bestCell = startCell;
    let bestHeuristic = fScore[startCell];
    let found = false;

    const neighbours = NavGrid.neighbours;

    while (heap.size > 0 && expanded < limit) {
      const current = heap.pop();
      if (stamp[current] === generation && closed[current] === 1) continue;
      closed[current] = 1;
      expanded++;

      if (current === goalCell) {
        found = true;
        bestCell = current;
        break;
      }

      const h = heuristic(current);
      if (h < bestHeuristic) {
        bestHeuristic = h;
        bestCell = current;
      }

      const cx = current % cols;
      const cz = (current - cx) / cols;
      const currentHeight = grid.height[current];
      const currentG = gScore[current];

      for (let n = 0; n < neighbours.length; n++) {
        const [dx, dz, cost] = neighbours[n] as [number, number, number];
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= cols || nz >= grid.rows) continue;
        const ni = nz * cols + nx;
        if ((grid.flags[ni] & CellFlag.Agent) === 0) continue;
        if (grid.clearance[ni] < request.radius) continue;
        const dh = grid.height[ni] - currentHeight;
        if (Math.abs(dh) > grid.config.maxStep) continue;
        if (dx !== 0 && dz !== 0) {
          const a = cz * cols + (cx + dx);
          const b = (cz + dz) * cols + cx;
          if ((grid.flags[a] & CellFlag.Agent) === 0) continue;
          if ((grid.flags[b] & CellFlag.Agent) === 0) continue;
        }

        // Hugging walls is cheap in raw distance and looks terrible, so pay
        // a penalty for it and a small one for climbing.
        const tight = Math.max(0, 1 - grid.clearance[ni] / NAV.comfortClearance);
        const step = cost * cellSize;
        const tentative =
          currentG + step * (1 + NAV.comfortPenalty * tight * tight) + Math.abs(dh) * 0.9;

        if (stamp[ni] !== generation) {
          stamp[ni] = generation;
          closed[ni] = 0;
          gScore[ni] = tentative;
          cameFrom[ni] = current;
          fScore[ni] = tentative + heuristic(ni);
          heap.push(ni);
        } else if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          cameFrom[ni] = current;
          fScore[ni] = tentative + heuristic(ni);
          closed[ni] = 0;
          heap.push(ni);
        }
      }
    }

    this.searches++;
    this.nodesExpanded += expanded;

    const endCell = found ? goalCell : bestCell;
    if (!found && endCell === startCell) {
      this.failures++;
      return { path: { points: [], status: 'failed', goalCell }, nodes: expanded };
    }

    const cells: number[] = [];
    let cursor = endCell;
    let guard = 0;
    while (cursor !== -1 && guard++ < 20000) {
      cells.push(cursor);
      if (cursor === startCell) break;
      cursor = cameFrom[cursor];
    }
    cells.reverse();

    const points = this.#stringPull(cells, request.radius);
    if (found) {
      // End exactly on the requested point when it is directly reachable, so
      // bots stop at cover positions rather than at the cell centre.
      const last = points[points.length - 1];
      if (
        last &&
        grid.lineOfWalk(last.x, last.z, request.goalPoint.x, request.goalPoint.z, request.radius)
      ) {
        last.set(
          request.goalPoint.x,
          grid.sampleHeight(request.goalPoint.x, request.goalPoint.z, last.y),
          request.goalPoint.z
        );
      }
    }

    return {
      path: { points, status: found ? 'complete' : 'partial', goalCell },
      nodes: expanded,
    };
  }

  /**
   * Greedy string pull followed by one round of corner cutting.
   *
   * The string pull removes the staircase; the corner cut removes the
   * remaining hard angles so a bot decelerating into a turn has something to
   * arc around instead of pivoting on the spot.
   */
  #stringPull(cells: number[], radius: number): THREE.Vector3[] {
    const grid = this.grid;
    if (cells.length === 0) return [];

    const raw: THREE.Vector3[] = [];
    let anchor = 0;
    raw.push(grid.toWorld(cells[0], new THREE.Vector3()));

    while (anchor < cells.length - 1) {
      let furthest = anchor + 1;
      const from = raw[raw.length - 1];
      for (let probe = cells.length - 1; probe > anchor; probe--) {
        grid.toWorld(cells[probe], _a);
        if (grid.lineOfWalk(from.x, from.z, _a.x, _a.z, radius)) {
          furthest = probe;
          break;
        }
      }
      raw.push(grid.toWorld(cells[furthest], new THREE.Vector3()));
      anchor = furthest;
    }

    if (raw.length < 3) return raw;

    const smoothed: THREE.Vector3[] = [raw[0] as THREE.Vector3];
    for (let i = 1; i < raw.length - 1; i++) {
      const previous = raw[i - 1] as THREE.Vector3;
      const corner = raw[i] as THREE.Vector3;
      const next = raw[i + 1] as THREE.Vector3;
      const inLength = previous.distanceTo(corner);
      const outLength = corner.distanceTo(next);
      const cut = Math.min(0.9, inLength * 0.3, outLength * 0.3);
      if (cut < 0.25) {
        smoothed.push(corner);
        continue;
      }
      const a = corner.clone().lerp(previous, cut / inLength);
      const b = corner.clone().lerp(next, cut / outLength);
      // Only accept the cut if the shortcut it implies is actually walkable.
      if (grid.lineOfWalk(a.x, a.z, b.x, b.z, radius)) {
        a.y = grid.sampleHeight(a.x, a.z, a.y);
        b.y = grid.sampleHeight(b.x, b.z, b.y);
        smoothed.push(a, b);
      } else {
        smoothed.push(corner);
      }
    }
    smoothed.push(raw[raw.length - 1] as THREE.Vector3);
    return smoothed;
  }
}
