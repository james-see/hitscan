import type * as THREE from 'three';

const SAMPLE_COUNT = 120;

/**
 * Frame timing overlay.
 *
 * Reports the 1% low alongside the mean, because a 60fps average with a 30fps
 * floor reads as broken in a shooter and a mean alone hides that.
 */
export class PerfHud {
  #renderer: THREE.WebGLRenderer;
  #element: HTMLDivElement;
  #samples = new Float32Array(SAMPLE_COUNT);
  #sampleIndex = 0;
  #filled = 0;
  #frameStart = 0;
  #lastReport = 0;
  #visible = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.#renderer = renderer;
    this.#element = document.createElement('div');
    this.#element.id = 'perf-hud';
    this.#element.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:9999',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#8f8',
      'background:rgba(0,0,0,.62)',
      'padding:6px 9px',
      'border-radius:4px',
      'white-space:pre',
      'pointer-events:none',
      'display:none',
      'backdrop-filter:blur(3px)',
    ].join(';');
    document.body.appendChild(this.#element);
  }

  beginFrame(): void {
    this.#frameStart = performance.now();
  }

  endFrame(visible: boolean): void {
    const ms = performance.now() - this.#frameStart;
    this.#samples[this.#sampleIndex] = ms;
    this.#sampleIndex = (this.#sampleIndex + 1) % SAMPLE_COUNT;
    this.#filled = Math.min(this.#filled + 1, SAMPLE_COUNT);

    if (visible !== this.#visible) {
      this.#visible = visible;
      this.#element.style.display = visible ? 'block' : 'none';
    }
    if (!visible) return;

    // Refresh at 10Hz; updating every frame makes the numbers unreadable.
    const now = performance.now();
    if (now - this.#lastReport < 100) return;
    this.#lastReport = now;
    this.#element.textContent = this.report();
  }

  /** Human-readable timing summary. Also consumed by the capture harness. */
  report(): string {
    const s = this.stats();
    const info = this.#renderer.info;
    return [
      `cpu   ${s.mean.toFixed(2)}ms  (${(1000 / s.mean).toFixed(0)} fps)`,
      `1% lo ${s.low1.toFixed(2)}ms  (${(1000 / s.low1).toFixed(0)} fps)`,
      `calls ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k`,
      `geo   ${info.memory.geometries}  tex ${info.memory.textures}`,
      `progs ${info.programs?.length ?? 0}`,
    ].join('\n');
  }

  /** Frame-time statistics over the sample window, in milliseconds. */
  stats(): { mean: number; low1: number; max: number } {
    if (this.#filled === 0) return { mean: 0, low1: 0, max: 0 };
    const valid = Array.from(this.#samples.slice(0, this.#filled));
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    const sorted = valid.slice().sort((a, b) => a - b);
    // "1% low" is the mean of the slowest 1% of frames, not a percentile.
    const cut = Math.max(1, Math.floor(sorted.length * 0.01));
    const slowest = sorted.slice(-cut);
    const low1 = slowest.reduce((a, b) => a + b, 0) / slowest.length;
    return { mean, low1, max: sorted[sorted.length - 1] as number };
  }

  reset(): void {
    this.#filled = 0;
    this.#sampleIndex = 0;
  }

  dispose(): void {
    this.#element.remove();
  }
}
