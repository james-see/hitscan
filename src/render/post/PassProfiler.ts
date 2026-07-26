import type * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface PendingQuery {
  name: string;
  query: WebGLQuery;
}

/** Recent samples kept per pass, for the percentile estimates. */
const WINDOW = 64;

interface PassStats {
  /** Ring of the most recent measurements, in milliseconds. */
  recent: Float64Array;
  cursor: number;
  filled: number;
  last: number;
  samples: number;
}

/**
 * GPU timing for the post chain.
 *
 * CPU frame time says nothing useful about a chain that is almost entirely
 * fill-bound: the driver returns from every draw call immediately and the
 * work lands later. `EXT_disjoint_timer_query_webgl2` measures the actual
 * GPU interval, which is the only number worth quoting for a per-pass cost.
 *
 * Off unless explicitly switched on; the queries themselves are cheap but
 * they serialise nothing and there is no reason to carry them in a shipped
 * frame.
 */
export class PassProfiler {
  enabled = false;

  #gl: WebGL2RenderingContext | null = null;
  #extension: TimerExtension | null = null;
  #pending: PendingQuery[] = [];
  #stats = new Map<string, PassStats>();
  #active: string | null = null;

  attach(renderer: THREE.WebGLRenderer): void {
    if (this.#gl !== null) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.#gl = gl;
    this.#extension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
  }

  get available(): boolean {
    return this.#extension !== null;
  }

  begin(name: string): void {
    if (!this.enabled || this.#gl === null || this.#extension === null) return;
    // Only one TIME_ELAPSED query can be open at a time; passes are
    // sequential, so a nested begin means something re-entered.
    if (this.#active !== null) return;
    const query = this.#gl.createQuery();
    if (query === null) return;
    this.#gl.beginQuery(this.#extension.TIME_ELAPSED_EXT, query);
    this.#active = name;
    this.#pending.push({ name, query });
  }

  end(): void {
    if (this.#active === null || this.#gl === null || this.#extension === null) return;
    this.#gl.endQuery(this.#extension.TIME_ELAPSED_EXT);
    this.#active = null;
  }

  /** Drains whatever has resolved. Results lag by a few frames. */
  poll(): void {
    const gl = this.#gl;
    const extension = this.#extension;
    if (gl === null || extension === null || this.#pending.length === 0) return;

    const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) as boolean;
    const remaining: PendingQuery[] = [];
    for (const entry of this.#pending) {
      const ready = gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!ready) {
        remaining.push(entry);
        continue;
      }
      if (!disjoint) {
        const nanoseconds = gl.getQueryParameter(entry.query, gl.QUERY_RESULT) as number;
        this.#record(entry.name, nanoseconds / 1e6);
      }
      gl.deleteQuery(entry.query);
    }
    this.#pending = remaining;
  }

  #record(name: string, milliseconds: number): void {
    let stats = this.#stats.get(name);
    if (stats === undefined) {
      stats = {
        recent: new Float64Array(WINDOW),
        cursor: 0,
        filled: 0,
        last: 0,
        samples: 0,
      };
      this.#stats.set(name, stats);
    }
    stats.recent[stats.cursor] = milliseconds;
    stats.cursor = (stats.cursor + 1) % WINDOW;
    stats.filled = Math.min(stats.filled + 1, WINDOW);
    stats.last = milliseconds;
    stats.samples++;
  }

  #percentile(stats: PassStats, fraction: number): number {
    const sorted = Array.from(stats.recent.subarray(0, stats.filled)).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
    return sorted[index] as number;
  }

  reset(): void {
    this.#stats.clear();
  }

  /**
   * Robust per-pass cost over the recent window.
   *
   * `floor` is the number to quote. A timer query measures a wall-clock GPU
   * interval, and anything else contending for the GPU -- another browser, a
   * compositor, a second capture session -- lands inside that interval and can
   * only ever inflate it. So the low percentile is the honest estimate of what
   * the pass itself costs, and the spread between `floor` and `median` says how
   * contended the machine was while measuring.
   *
   * This replaced a mean, which is the wrong statistic here for the same
   * reason: one 200ms sample off a contended GPU moved it by 12ms and took
   * forty frames to decay, so a chain that cost 4ms could report 37ms and stay
   * there.
   */
  timings(): Record<
    string,
    { floor: number; median: number; last: number; samples: number; contention: number }
  > {
    const out: Record<
      string,
      { floor: number; median: number; last: number; samples: number; contention: number }
    > = {};
    for (const [name, stats] of this.#stats) {
      const floor = this.#percentile(stats, 0.1);
      const median = this.#percentile(stats, 0.5);
      out[name] = {
        floor: Number(floor.toFixed(3)),
        median: Number(median.toFixed(3)),
        last: Number(stats.last.toFixed(3)),
        samples: stats.samples,
        contention: Number((floor > 0 ? median / floor : 1).toFixed(2)),
      };
    }
    return out;
  }

  dispose(): void {
    const gl = this.#gl;
    if (gl !== null) {
      for (const entry of this.#pending) gl.deleteQuery(entry.query);
    }
    this.#pending = [];
    this.#stats.clear();
  }
}

export interface ProfiledPassHooks {
  onSetSize?(width: number, height: number): void;
  onInit?(ctx: FrameContext): void;
}

/**
 * Wraps a pass so it can be timed and so the chain can observe its size.
 *
 * The pipeline only calls `setSize` on registered passes, which makes the
 * wrapper the natural place to learn the internal render resolution and to
 * get hold of the live `FrameContext`: nothing on `RenderPipeline` exposes
 * either.
 */
export class ProfiledPass implements RenderPass {
  #inner: RenderPass;
  #profiler: PassProfiler;
  #hooks: ProfiledPassHooks;

  constructor(inner: RenderPass, profiler: PassProfiler, hooks: ProfiledPassHooks = {}) {
    this.#inner = inner;
    this.#profiler = profiler;
    this.#hooks = hooks;
  }

  get inner(): RenderPass {
    return this.#inner;
  }

  get name(): string {
    return this.#inner.name;
  }

  get order(): number {
    return this.#inner.order;
  }

  get enabled(): boolean {
    return this.#inner.enabled;
  }

  set enabled(value: boolean) {
    this.#inner.enabled = value;
  }

  init(renderer: THREE.WebGLRenderer, ctx: FrameContext): void {
    this.#profiler.attach(renderer);
    this.#hooks.onInit?.(ctx);
    this.#inner.init?.(renderer, ctx);
  }

  setSize(width: number, height: number): void {
    this.#hooks.onSetSize?.(width, height);
    this.#inner.setSize?.(width, height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    this.#profiler.begin(this.#inner.name);
    this.#inner.render(renderer, ctx, input, output);
    this.#profiler.end();
  }

  dispose(): void {
    this.#inner.dispose?.();
  }
}
