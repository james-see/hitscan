/**
 * Measures temporal stability of shadowed regions while the engine runs.
 *
 * The capture harness photographs frozen scenes after 72 frames of TAA
 * convergence, which is exactly the condition under which a noisy term looks
 * clean: the jitter averages out and the still is correct. A player sees the
 * opposite -- time advancing, history short, and any per-frame noise reading
 * as a pulse. Nothing else in the harness can see that class of defect.
 *
 * Sampling happens inside the page via readPixels on each presented frame,
 * not by screenshotting. Driving frames from Playwright and reading them back
 * over CDP samples at irregular intervals, which aliases a fast alternation
 * into whatever period the round-trip happens to beat against -- an earlier
 * version of this probe reported a confident 2-frame pulse in every
 * condition, including ones with the suspect disabled, which was the
 * round-trip and not the renderer.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, DEFAULTS } from './capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Frames sampled per condition. At 60Hz the default is two seconds. */
const FRAMES = process.argv.includes('--frames')
  ? Number(process.argv[process.argv.indexOf('--frames') + 1])
  : 120;

/**
 * Conditions to compare. Each disables one suspect, so a condition whose
 * pulse disappears identifies the term responsible.
 */
const CONDITIONS = [
  { id: 'baseline', settings: {} },
  { id: 'frozen-scene', settings: {}, freeze: true },
  { id: 'no-ssao', settings: { ssaoEnabled: false } },
  { id: 'no-taa', settings: { antialias: 'none' } },
  { id: 'no-autoexposure', settings: { autoExposureEnabled: false } },
  { id: 'no-motionblur', settings: { motionBlurEnabled: false } },
  { id: 'no-bloom', settings: { bloomEnabled: false } },
];

/**
 * Runs the engine for n frames and returns per-frame mean luminance of the
 * darkest pixels, measured in-page.
 */
function collectInPage({ frames, freeze }) {
  return new Promise((resolve) => {
    const engine = window.engine;
    const gl = engine.renderer.getContext();
    const canvas = engine.renderer.domElement;

    // A patch rather than the whole target: readPixels is synchronous and
    // stalls the pipeline, and a full 1440p read per frame would dominate the
    // very frame time being characterised.
    const w = 256;
    const h = 256;
    const x = Math.max(0, ((canvas.width - w) / 2) | 0);
    const y = Math.max(0, ((canvas.height - h) / 2) | 0);
    const buf = new Uint8Array(w * h * 4);

    const series = [];
    let mask = null;
    let count = 0;

    const previousScale = engine.time.scale;
    // Frames still render and post still runs when frozen; only the
    // simulation stops. That separates "the scene is changing and exposure is
    // correctly following it" from "the adaptation loop cannot settle".
    engine.time.scale = freeze ? 0 : 1;

    const sample = () => {
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

      if (mask === null) {
        mask = [];
        for (let i = 0; i < buf.length; i += 4) {
          const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
          if (l < 90) mask.push(i);
        }
      }

      if (mask.length >= 200) {
        let sum = 0;
        for (const i of mask) {
          sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
        }
        series.push(sum / mask.length);
      }

      if (++count < frames) {
        requestAnimationFrame(sample);
      } else {
        engine.time.scale = previousScale;
        resolve({ series, maskPixels: mask.length });
      }
    };

    requestAnimationFrame(sample);
  });
}

/**
 * Dominant oscillation in the series, as a period in frames.
 *
 * Autocorrelation is the wrong tool here and was actively misleading: for any
 * smooth series it decays monotonically with lag, so taking its maximum over
 * lag always returns the smallest lag searched. An earlier version reported a
 * confident 2-frame period at strength 0.9 for every condition, which was
 * just a restatement of "the signal is smooth".
 *
 * A DFT over the mean-removed series answers the actual question -- which
 * frequency carries the energy -- and distinguishes a slow pulse from
 * per-frame noise instead of conflating them.
 */
function dominantPeriod(series) {
  const n = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const centred = series.map((v) => v - mean);
  const total = centred.reduce((a, b) => a + b * b, 0);
  if (total === 0) return { periodFrames: 0, share: 0 };

  let best = { k: 0, power: 0 };
  // Up to Nyquist. k=1 is one cycle across the whole window, which is drift
  // rather than a pulse, so it is reported but not treated as periodic.
  for (let k = 1; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      re += centred[t] * Math.cos(a);
      im += centred[t] * Math.sin(a);
    }
    const power = (re * re + im * im) / n;
    if (power > best.power) best = { k, power };
  }

  return {
    periodFrames: best.k === 0 ? 0 : +(n / best.k).toFixed(1),
    share: +(best.power / total).toFixed(3),
  };
}

function summarise(id, series, maskPixels) {
  if (series.length < 8) return { id, error: `only ${series.length} samples` };
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  const range = Math.max(...series) - Math.min(...series);
  const { periodFrames, share } = dominantPeriod(series);
  // Mean absolute frame-to-frame delta: what the eye integrates as flicker,
  // as distinct from a slow drift that shares the same standard deviation.
  let jitter = 0;
  for (let i = 1; i < series.length; i++) jitter += Math.abs(series[i] - series[i - 1]);
  jitter /= series.length - 1;

  return {
    id,
    mean: +mean.toFixed(3),
    sd: +sd.toFixed(4),
    range: +range.toFixed(3),
    jitter: +jitter.toFixed(4),
    periodFrames,
    /** Fraction of the variance carried by that single frequency. */
    share,
    maskPixels,
  };
}

async function main() {
  const argv = process.argv;
  const shot = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : 'interior-shadow';

  const server = await startServer({});
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    const boot = async () => {
      await page.goto(`${server.url}/?capture=1&seed=${DEFAULTS.seed}&hud=0`, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULTS.timeoutMs,
      });
      await page.waitForFunction(() => window.__READY === true, null, {
        timeout: DEFAULTS.timeoutMs,
        polling: 100,
      });
      const hasEngine = await page.evaluate(() => typeof window.engine === 'object');
      if (!hasEngine) throw new Error('window.engine is not exposed; probe needs a dev build');
    };

    await boot();
    process.stdout.write(`flicker probe on "${shot}", ${FRAMES} frames per condition\n\n`);

    const rows = [];
    for (const condition of CONDITIONS) {
      await page.evaluate((settings) => {
        for (const [k, v] of Object.entries(settings)) window.__hitscan.setSetting(k, v);
      }, condition.settings);
      await page.evaluate((id) => window.__hitscan.setShot(id), shot);

      const { series, maskPixels } = await page.evaluate(collectInPage, {
        frames: FRAMES,
        freeze: condition.freeze === true,
      });
      const row = summarise(condition.id, series, maskPixels);
      rows.push(row);

      if (row.error) {
        process.stdout.write(`  ${row.id.padEnd(18)} skipped: ${row.error}\n`);
      } else {
        process.stdout.write(
          `  ${row.id.padEnd(18)} sd ${String(row.sd).padEnd(8)} jitter ${String(row.jitter).padEnd(8)}` +
            ` range ${String(row.range).padEnd(7)} period ${String(row.periodFrames).padStart(6)}f` +
            ` (${(row.share * 100).toFixed(0)}% of variance)\n`,
        );
      }

      // Reload between conditions so a setting that cannot be undone at
      // runtime does not leak into the next measurement.
      await boot();
    }

    const base = rows.find((r) => r.id === 'baseline');
    if (base && !base.error) {
      process.stdout.write('\n  reduction in frame-to-frame jitter versus baseline:\n');
      for (const r of rows) {
        if (r.id === 'baseline' || r.error) continue;
        const drop = ((1 - r.jitter / base.jitter) * 100).toFixed(0);
        process.stdout.write(`    ${r.id.padEnd(18)} ${String(drop).padStart(4)}%\n`);
      }
    }

    void ROOT;
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
