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

interface PassStats {
  /** Exponential moving average in milliseconds. */
  average: number;
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
    const existing = this.#stats.get(name);
    if (existing === undefined) {
      this.#stats.set(name, { average: milliseconds, last: milliseconds, samples: 1 });
      return;
    }
    existing.last = milliseconds;
    existing.samples++;
    existing.average += (milliseconds - existing.average) * 0.06;
  }

  reset(): void {
    this.#stats.clear();
  }

  timings(): Record<string, { average: number; last: number; samples: number }> {
    const out: Record<string, { average: number; last: number; samples: number }> = {};
    for (const [name, stats] of this.#stats) {
      out[name] = {
        average: Number(stats.average.toFixed(3)),
        last: Number(stats.last.toFixed(3)),
        samples: stats.samples,
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
