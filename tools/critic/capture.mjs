#!/usr/bin/env node
/**
 * Deterministic screenshot capture.
 *
 * Boots the game in real Chrome (not the bundled Chromium headless shell,
 * which falls back to SwiftShader), drives it through `window.__hitscan`, and
 * writes one PNG per camera preset.
 *
 * Real Chrome matters: on this machine it reports
 * `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)`, so captures are
 * GPU-accurate and run at full speed. SwiftShader would be both far slower
 * and visually different.
 *
 * Usage:
 *   node tools/critic/capture.mjs [--out <dir>] [--shot <id>] [--width 2560]
 *                                 [--height 1440] [--seed 24189] [--hud]
 *                                 [--build] [--label <name>]
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Firing variants added to the standard capture set.
 *
 * Every camera preset is a static scene with nobody shooting, so the effects
 * work was being scored on frames that contain no effects at all. Note that
 * the muzzle flash lives only a frame or two, so a capture is not guaranteed
 * to catch one; the longer-lived evidence of a firefight -- smoke, tracers,
 * ejected shells, impact debris and decals -- is what these reliably show.
 * `settle` stays at zero so the frame is photographed at the end of the
 * burst rather than after it has dissipated.
 */
const COMBAT_SHOTS = [
  {
    id: 'lane-firing',
    base: 'lane',
    intent: 'hip-fire burst: muzzle flash, smoke, shell ejection, tracers',
    actions: ['fire'],
    // Long enough for several rounds: a shorter burst reliably produced a
    // frame with an ejected shell and nothing else, which is no more use to
    // the critic than the static preset it was meant to replace.
    frames: 20,
    settle: 0,
  },
  {
    id: 'lane-ads-firing',
    base: 'lane',
    intent: 'sustained ADS fire: recoil climb, sight picture under load, impacts',
    actions: ['aim', 'fire'],
    frames: 22,
    settle: 0,
  },
];

export const DEFAULTS = {
  width: 2560,
  height: 1440,
  seed: 24189,
  /** Frames rendered before capture so TAA and streaming settle. */
  convergeFrames: 32,
  timeoutMs: 90_000,
};

/**
 * Default output for a run that did not ask for a specific directory.
 *
 * Per-process, because `capture()` clears its output directory first: two
 * agents both running with no `--out` would otherwise delete each other's
 * images. `captures/latest` is republished as a symlink once a run finishes,
 * so the stable path the other critic tools default to still resolves.
 */
const DEFAULT_OUT = path.join(ROOT, 'captures', `run-${process.pid}`);

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    shot: null,
    width: DEFAULTS.width,
    height: DEFAULTS.height,
    seed: DEFAULTS.seed,
    hud: false,
    build: false,
    label: null,
    keepOpen: false,
    verify: true,
    query: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--shot') args.shot = argv[++i];
    else if (a === '--width') args.width = Number(argv[++i]);
    else if (a === '--height') args.height = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--hud') args.hud = true;
    else if (a === '--build') args.build = true;
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--keep-open') args.keepOpen = true;
    else if (a === '--no-verify') args.verify = false;
    // Repeatable passthrough for module-specific capture overrides, e.g.
    // --query vm=ads --query vmt=0.5 to photograph a viewmodel pose. Each
    // value is parsed as a query fragment rather than a single pair, so an
    // ampersand-joined "vm=ads&vmdebug=flat" sets both keys instead of
    // encoding the ampersand into one nonsense value.
    else if (a === '--query') {
      for (const pair of new URLSearchParams(String(argv[++i]))) {
        args.query.push(pair);
      }
    }
  }
  return args;
}

async function findFreePort(start) {
  // Randomised start: several capture runs happen concurrently, and scanning
  // from a fixed base makes them all pick the same "free" port.
  const base = start ?? 5300 + Math.floor(Math.random() * 400);
  for (let port = base; port < base + 200; port++) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error('no free port available');
}

/**
 * Starts a Vite server and resolves once it is accepting connections.
 *
 * Retries on bind collisions: probing a port and then spawning leaves a gap
 * in which a concurrent run can claim it, which happens constantly when
 * several agents capture at once.
 */
export async function startServer(options = {}) {
  const attempts = options.attempts ?? 4;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await startServerOnce(options);
    } catch (err) {
      lastError = err;
      if (!/already in use|EADDRINUSE/i.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    }
  }
  throw lastError;
}

/**
 * Removes snapshot trees whose owning process is gone.
 *
 * A run killed mid-capture never reaches its cleanup, so orphans accumulate.
 * Liveness is checked per directory rather than clearing them all: deleting a
 * running capture's tree out from under its Vite server is the failure this
 * whole mechanism exists to prevent.
 */
function reapOrphanSnapshots() {
  let entries;
  try {
    entries = fs.readdirSync(ROOT);
  } catch {
    return;
  }

  for (const name of entries) {
    const match = /^\.capture-snapshot-(\d+)$/.exec(name);
    if (!match) continue;

    const pid = Number(match[1]);
    if (pid === process.pid) continue;

    try {
      // Signal 0 only probes; EPERM means it exists under another user.
      process.kill(pid, 0);
      continue;
    } catch (err) {
      if (err.code === 'EPERM') continue;
    }
    fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  }
}

/**
 * Copies the tree into a private directory and serves that instead of the
 * working directory.
 *
 * Several agents edit continuously, so the live tree is intermittently
 * half-written: a module that throws on load fails the capture no matter how
 * the browser is driven.
 *
 * The directory is per-process. A single shared path defeats the purpose --
 * concurrent runs rsync --delete into the same place, so one wipes another's
 * tree underneath a live Vite server.
 *
 * The copy is real rather than hardlinked. Hardlinks were near-instant but
 * rested on the assumption that editors replace a file rather than rewriting
 * it in place; the agent edit path does write in place, which mutates the
 * shared inode and changes the "frozen" copy mid-run. The tree is 1.8MB, so
 * an honest copy costs little and is actually immune to concurrent edits.
 */
function makeSnapshot() {
  const dir = path.join(ROOT, `.capture-snapshot-${process.pid}`);
  reapOrphanSnapshots();
  fs.mkdirSync(dir, { recursive: true });

  const sources = ['src', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json'];
  const result = spawnSync('rsync', ['-a', '--delete', ...sources, `${dir}/`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`snapshot failed: ${result.stderr || result.stdout}`);
  }

  // Symlinked rather than copied: it is large, unchanging, and Vite's
  // dependency cache under node_modules/.vite is worth sharing.
  const modules = path.join(dir, 'node_modules');
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(ROOT, 'node_modules'), modules, 'dir');

  return dir;
}

/**
 * Type-checks the snapshot before anything is captured from it.
 *
 * A copy taken while another agent is mid-edit is internally inconsistent --
 * one module renamed, its caller not yet updated. The page then boots, throws
 * on the first frame, and the run reports whatever the symptom happened to be
 * ("zero fixed steps ran", a black frame) as though it were a real defect in
 * the subsystem under test. That misattribution is far more expensive than
 * the few seconds this costs, because it sends an agent chasing a bug that
 * belongs to someone else and is already gone from the tree.
 */
function verifySnapshot(dir) {
  const started = Date.now();
  const result = spawnSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (result.status === 0) return Date.now() - started;

  const errors = (result.stdout || result.stderr || '').trim().split('\n').slice(0, 8);
  throw new Error(
    'snapshot does not type-check, so it was captured mid-edit by another ' +
      'process. This is not a defect in whatever you are testing -- re-run ' +
      'once the tree settles.\n\n' +
      errors.map((l) => `  ${l}`).join('\n')
  );
}

async function startServerOnce({ build = false, snapshot = true, verify = true } = {}) {
  const port = await findFreePort();
  const mode = build ? 'preview' : 'dev';
  const cwd = snapshot && !build ? makeSnapshot() : ROOT;

  if (cwd !== ROOT && verify) {
    const ms = verifySnapshot(cwd);
    process.stdout.write(`  snapshot verified in ${(ms / 1000).toFixed(1)}s\n`);
  }

  if (build) {
    await new Promise((resolve, reject) => {
      const proc = spawn('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('build failed'))));
    });
  }

  // Bind explicitly to the loopback IPv4 address: `localhost` resolves to
  // ::1 on this platform, which the probe below would fail to reach.
  const args = build
    ? ['vite', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1']
    : ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'];

  const proc = spawn('npx', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A capture must be a frozen snapshot of the tree. With several agents
    // editing at once, HMR otherwise swaps modules mid-run and the page
    // reloads underneath the harness ("Execution context was destroyed"),
    // or a half-written module throws on re-execution.
    env: { ...process.env, NO_COLOR: '1', HITSCAN_NO_HMR: '1' },
  });

  let log = '';
  proc.stdout.on('data', (d) => (log += d.toString()));
  proc.stderr.on('data', (d) => (log += d.toString()));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`vite ${mode} exited early:\n${log}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        return {
          url,
          port,
          stop: () => {
            try {
              process.kill(-proc.pid, 'SIGTERM');
            } catch {
              proc.kill('SIGTERM');
            }
            // Otherwise one snapshot tree accumulates per run. They are
            // hardlinked so they cost almost nothing on disk, but a hundred
            // stale copies of src/ make every subsequent search noisy.
            if (cwd !== ROOT) fs.rmSync(cwd, { recursive: true, force: true });
          },
          get log() {
            return log;
          },
        };
      }
    } catch {
      // Server not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGTERM');
  throw new Error(`vite ${mode} did not start in time:\n${log}`);
}

/** Launches real Chrome with the GPU enabled. */
export async function launchBrowser() {
  return chromium.launch({
    channel: 'chrome',
    args: [
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      // Never add --disable-frame-rate-limit here. Without vsync the engine's
      // rAF loop saturates the GPU, the compositor never commits a frame, and
      // Page.captureScreenshot blocks indefinitely waiting for one.
      '--disable-features=CalculateNativeWinOcclusion',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });
}

/**
 * Captures every preset (or a single one) and returns metadata about each.
 */
export async function capture(options = {}) {
  const opts = { ...parseArgs([]), ...options };
  const outDir = opts.out;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const server = opts.server ?? (await startServer({ build: opts.build, verify: opts.verify }));
  const ownsServer = !opts.server;
  const browser = opts.browser ?? (await launchBrowser());
  const ownsBrowser = !opts.browser;

  const results = [];
  const consoleErrors = [];

  try {
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    const cdp = await page.context().newCDPSession(page);
    // An occluded or backgrounded tab has its frame production throttled,
    // which stalls screenshot capture.
    await cdp.send('Page.bringToFront').catch(() => {});

    /** Fails fast instead of hanging: a stalled compositor is a bug, not a wait. */
    const withTimeout = (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
      ]);

    const query = new URLSearchParams({
      capture: '1',
      seed: String(opts.seed),
      hud: opts.hud ? '1' : '0',
    });
    for (const [key, value] of opts.query ?? []) query.set(key, value);
    const step = (msg) => process.stdout.write(`  [${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

    step('navigating');
    await page.goto(`${server.url}/?${query}`, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULTS.timeoutMs,
    });

    step('waiting for __READY');
    try {
      // The game signals readiness only after assets load and shaders compile.
      await page.waitForFunction(() => window.__READY === true, null, {
        timeout: 45_000,
        polling: 100,
      });
    } catch (err) {
      // Surface whatever the page managed to report; a bare timeout here is
      // almost always a boot exception that never reached the console hook.
      const diag = await page.evaluate(() => ({
        ready: window.__READY ?? null,
        api: typeof window.__hitscan,
        status: document.getElementById('loader-status')?.textContent ?? null,
        error: document.getElementById('error-text')?.textContent ?? null,
      }));
      throw new Error(
        `__READY never became true.\n  diagnostics: ${JSON.stringify(diag, null, 2)}\n` +
          `  console: ${consoleErrors.slice(0, 5).join('\n           ') || '(none)'}`
      );
    }

    step('reading presets');
    const presets = await page.evaluate(() => window.__hitscan.presets());
    const selected = opts.shot ? presets.filter((p) => p.id === opts.shot) : presets;
    if (selected.length === 0) {
      throw new Error(
        `no matching shot preset${opts.shot ? ` "${opts.shot}"` : ''}; available: ${presets
          .map((p) => p.id)
          .join(', ')}`
      );
    }

    // Combat variants are derived from the static presets rather than
    // registered by the world module, which has no reason to know about
    // weapons. Firing is driven through real input actions, so what gets
    // photographed is a frame a player could actually produce.
    const combat = opts.combat === false ? [] : COMBAT_SHOTS;
    const jobs = [
      ...selected.map((preset) => ({ preset, act: null })),
      ...combat
        .filter((c) => selected.some((p) => p.id === c.base))
        .map((c) => ({
          preset: { ...presets.find((p) => p.id === c.base), id: c.id, intent: c.intent },
          act: c,
        })),
    ];

    // A throwaway pass over the first shot. The first frames after boot differ
    // from every later one by roughly 40% of pixels at mean 7 -- an order of
    // magnitude above any other reproducibility term -- because texture
    // streaming and shader compilation are still finishing. Paying for one
    // discarded shot puts every kept shot on the warm side of that.
    if (jobs.length > 0) {
      step('warmup (discarded)');
      await page.evaluate(async (id) => {
        await window.__hitscan.setShot(id);
        window.__hitscan.converge();
        window.__hitscan.hold();
      }, jobs[0].act ? jobs[0].act.base : jobs[0].preset.id);
      await withTimeout(
        cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
        30_000,
        'warmup screenshot'
      );
    }

    for (const { preset, act } of jobs) {
      step(`shot ${preset.id}`);
      await page.evaluate(async (id) => {
        await window.__hitscan.setShot(id);
      }, act ? act.base : preset.id);

      if (act) {
        await page.evaluate(
          ({ actions, frames, settle }) => window.__hitscan.perform(actions, frames, settle),
          act
        );
      }

      // Extra convergence beyond setShot's own, for slow-settling effects.
      await page.evaluate((frames) => window.__hitscan.converge(frames), DEFAULTS.convergeFrames);

      // Sampled before the settle below, which renders a burst of frames with
      // the simulation frozen. Those are far cheaper than real ones and would
      // otherwise be what the frame time reports.
      const stats = await page.evaluate(() => window.__hitscan.stats());

      // Then settle to a fixed point and pin it. Converging alone left the
      // image free to keep changing during the round trip below, so which
      // frame the compositor happened to hand back decided the pixels.
      const held = await page.evaluate(() => window.__hitscan.hold());
      if (!held.stable) {
        process.stdout.write(
          `    warning: ${preset.id} did not settle in ${held.frames} frames; ` +
            `this capture is not reproducible\n`
        );
      }

      await page.waitForTimeout(120);

      // Two rAF ticks guarantee the compositor has presented the converged
      // frame before it is read back.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      );

      // Capture over CDP rather than page.screenshot: the latter waits for
      // the page to become visually stable, which a WebGL canvas never does.
      const file = path.join(outDir, `${preset.id}.png`);
      const { data } = await withTimeout(
        cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
          fromSurface: true,
        }),
        30_000,
        `screenshot "${preset.id}"`
      );
      await writeFile(file, Buffer.from(data, 'base64'));

      results.push({ ...preset, file, stats });
      process.stdout.write(
        `  captured ${preset.id.padEnd(20)} ${stats.mean.toFixed(2)}ms  ` +
          `${stats.calls} calls  ${(stats.triangles / 1000).toFixed(0)}k tris\n`
      );
    }

    const meta = {
      capturedAt: new Date().toISOString(),
      label: opts.label,
      seed: opts.seed,
      resolution: { width: opts.width, height: opts.height },
      gpu: await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
      }),
      shots: results.map(({ file, ...rest }) => ({ ...rest, file: path.basename(file) })),
      consoleErrors,
    };
    await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

    if (outDir === DEFAULT_OUT) {
      const link = path.join(ROOT, 'captures', 'latest');
      await rm(link, { recursive: true, force: true });
      await symlink(outDir, link, 'dir');
    }

    if (consoleErrors.length > 0) {
      process.stdout.write(`\n  ${consoleErrors.length} console error(s):\n`);
      for (const e of consoleErrors.slice(0, 10)) process.stdout.write(`    ${e}\n`);
    }

    if (!opts.keepOpen) await page.close();
    return { outDir, meta, results };
  } finally {
    if (ownsBrowser) await browser.close();
    if (ownsServer) server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('run npm install first');
    process.exit(1);
  }
  console.log(`capturing at ${args.width}x${args.height} -> ${path.relative(ROOT, args.out)}`);
  capture(args)
    .then(({ outDir, meta }) => {
      console.log(`\ndone: ${meta.shots.length} shot(s) in ${path.relative(ROOT, outDir)}`);
      console.log(`gpu: ${meta.gpu}`);
      process.exit(meta.consoleErrors.length > 0 ? 2 : 0);
    })
    .catch((err) => {
      console.error(`capture failed: ${err.message}`);
      process.exit(1);
    });
}
