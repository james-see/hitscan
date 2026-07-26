#!/usr/bin/env node
/**
 * VFX inspection capture.
 *
 * The shared harness in tools/critic captures a frozen scene; VFX only exists
 * while the simulation advances, so this drives `window.__vfxDebug` to spawn
 * effects and `window.__hitscan.step` to advance them a known number of
 * frames before each screenshot. Server and browser setup are reused from the
 * shared harness so both produce comparable images.
 *
 * Usage:
 *   node src/vfx/debug/vfx-capture.mjs [--out captures/vfx-debug] [--only <id>]
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser } from '../../../tools/critic/capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const WIDTH = 2560;
const HEIGHT = 1440;
const SEED = 24189;

/**
 * Framings are the world module's own shot presets, and everything is spawned
 * relative to the camera, so these scenarios survive arena layout changes.
 */
const VIEWS = {
  lane: { shot: 'lane' },
  wall: { shot: 'interior-shadow' },
  detail: { shot: 'material-detail' },
  detailMacro: { shot: 'material-detail', fov: 22 },
  ground: { shot: 'lane', pitch: -0.42, fov: 70 },
  groundClose: { shot: 'lane', pitch: -0.55, fov: 50 },
};

const fire = (page, count, spread) =>
  page.evaluate(
    ({ count, spread }) => window.__vfxDebug.fireForward(count, { spread }),
    { count, spread }
  );

const SCENARIOS = [
  {
    id: 'muzzle-single',
    view: 'lane',
    intent: 'One shot on the frame it fires: core, bloom card, embers, light.',
    run: async (page) => {
      await fire(page, 1, 0);
      await step(page, 1);
    },
  },
  {
    id: 'muzzle-single-late',
    view: 'lane',
    intent: 'The same shot four frames later: flash gone, smoke taking over.',
    run: async (page) => {
      await fire(page, 1, 0);
      await step(page, 4);
    },
  },
  {
    id: 'muzzle-remote',
    view: 'lane',
    intent: 'A burst fired 6m downrange, to read the smoke away from the lens.',
    run: async (page) => {
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const camera = window.engine.camera;
          const forward = new camera.position.constructor(0, 0, -1).applyQuaternion(
            camera.quaternion
          );
          const origin = camera.position.clone().addScaledVector(forward, 6);
          const target = camera.position.clone().addScaledVector(forward, 26);
          window.__vfxDebug.fire(
            [origin.x, origin.y, origin.z],
            [target.x, target.y, target.z],
            1,
            { spread: 0.01 }
          );
        });
        await step(page, 5);
      }
      await step(page, 4);
    },
  },
  {
    id: 'muzzle-burst',
    view: 'lane',
    intent: 'Eight-round burst: smoke accumulation, overlapping flashes.',
    run: async (page) => {
      for (let i = 0; i < 8; i++) {
        await fire(page, 1, 0.012);
        await step(page, 6);
      }
      await fire(page, 1, 0.012);
      await step(page, 1);
    },
  },
  {
    id: 'muzzle-smoke',
    view: 'lane',
    intent: 'Half a second after a burst: lit smoke, soft depth fade, dissipation.',
    run: async (page) => {
      for (let i = 0; i < 10; i++) {
        await fire(page, 1, 0.012);
        await step(page, 5);
      }
      await step(page, 30);
    },
  },
  {
    id: 'impact-macro',
    view: 'detailMacro',
    intent: 'One concrete impact up close, three frames in.',
    run: async (page) => {
      await fire(page, 1, 0);
      await step(page, 3);
    },
  },
  {
    id: 'impact-macro-late',
    view: 'detailMacro',
    intent: 'The same impact 14 frames in: dust plume shape and contact fade.',
    run: async (page) => {
      await fire(page, 1, 0);
      await step(page, 14);
    },
  },
  {
    id: 'surfaces-early',
    view: 'ground',
    intent: 'Every surface kind, three frames in: sparks, chips, plumes, splashes.',
    run: async (page) => {
      await page.evaluate(() => window.__vfxDebug.surfaceRowForward(4.5, 0.8));
      await step(page, 3);
    },
  },
  {
    id: 'surfaces-late',
    view: 'ground',
    intent: 'The same row 22 frames later: soft-particle contact with the floor.',
    run: async (page) => {
      await page.evaluate(() => window.__vfxDebug.surfaceRowForward(4.5, 0.8));
      await step(page, 22);
    },
  },
  {
    id: 'impact-wall',
    view: 'wall',
    intent: 'Concrete impacts on a vertical face straight ahead.',
    run: async (page) => {
      await fire(page, 6, 0.02);
      await step(page, 4);
    },
  },
  {
    id: 'decals-detail',
    view: 'detail',
    intent: 'Bullet holes up close: projection fit and normal-mapped depth.',
    run: async (page) => {
      await fire(page, 10, 0.02);
      await step(page, 120);
    },
  },
  {
    id: 'decals-macro',
    view: 'detailMacro',
    intent: 'Macro read of two holes: conforming projection, normal-mapped depth.',
    run: async (page) => {
      await fire(page, 2, 0.008);
      await step(page, 120);
    },
  },
  {
    id: 'decals-ground',
    view: 'groundClose',
    intent: 'Holes in the floor, read at a grazing angle.',
    run: async (page) => {
      await fire(page, 10, 0.03);
      await step(page, 150);
    },
  },
  {
    id: 'tracer',
    view: 'lane',
    intent: 'Tracers in flight: stretched billboard, distance fade.',
    run: async (page) => {
      await fire(page, 3, 0.01);
      await step(page, 1);
      // A tracer covers 15m per frame; watching it from behind hides the
      // streak entirely, so yaw across its path.
      await page.evaluate(() => {
        const camera = window.engine.camera;
        camera.rotateY(0.55);
        camera.updateMatrixWorld(true);
      });
    },
  },
  {
    id: 'shells',
    view: 'groundClose',
    intent: 'Ejected brass after settling, framed on the ejection side.',
    run: async (page) => {
      await fire(page, 8, 0.02);
      await step(page, 110);
      // Brass leaves to the shooter's right, behind the viewmodel; turn to it.
      await page.evaluate(() => {
        const camera = window.engine.camera;
        camera.rotateY(-0.75);
        camera.rotateX(-0.35);
        camera.updateMatrixWorld(true);
      });
    },
  },
  {
    id: 'combat',
    view: 'lane',
    intent: 'Everything at once: flash, tracer, impact, smoke, brass.',
    run: async (page) => {
      for (let i = 0; i < 14; i++) {
        await fire(page, 1, 0.02);
        await step(page, 4);
      }
      await fire(page, 1, 0.02);
      await step(page, 1);
    },
  },
];

function step(page, frames) {
  return page.evaluate((n) => window.__hitscan.step(n, 1 / 60), frames);
}

/**
 * Vite re-optimises dependencies whenever a new bare import appears in the tree,
 * and that forces a full reload which destroys any execution context mid-run.
 * Other agents are editing imports concurrently, so wait for reloads to stop.
 */
// A reload either kills the execution context outright or leaves the globals
// briefly undefined; both mean "retry the scenario", not "the effect is broken".
const NAV_ERROR =
  /Execution context was destroyed|frame was detached|Target closed|Cannot read properties of undefined/;

async function settle(page, nav) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = nav.count;
    try {
      await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });
    } catch (err) {
      if (!NAV_ERROR.test(err.message)) throw err;
      continue;
    }
    await page.waitForTimeout(1500);
    if (nav.count === before) return;
  }
  throw new Error('page kept reloading; dev server never settled');
}

function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'captures', 'vfx-debug'), only: null, depth: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--depth') args.depth = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  await rm(args.out, { recursive: true, force: true });
  await mkdir(args.out, { recursive: true });

  const server = await startServer({ build: false });
  const browser = await launchBrowser();
  const consoleErrors = [];

  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const nav = { count: 0 };
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) nav.count++;
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.bringToFront').catch(() => {});

    const query = new URLSearchParams({
      capture: '1',
      seed: String(SEED),
      hud: '0',
      vfx: 'debug',
    });
    if (args.depth) query.set('vfxdepth', args.depth);
    await page.goto(`${server.url}/?${query}`, { waitUntil: 'domcontentloaded' });
    await settle(page, nav);

    const hasDebug = await page.evaluate(() => typeof window.__vfxDebug === 'object');
    if (!hasDebug) throw new Error('__vfxDebug not installed; is the ?vfx=debug gate wired up?');

    const scenarios = args.only ? SCENARIOS.filter((s) => s.id === args.only) : SCENARIOS;
    const results = [];

    const runScenario = async (scenario) => {
      await page.evaluate(() => window.__vfxDebug.reset());
      const view = VIEWS[scenario.view];
      await page.evaluate((id) => window.__hitscan.setShot(id), view.shot);
      if (view.pitch !== undefined || view.fov !== undefined) {
        await page.evaluate((v) => {
          const camera = window.engine.camera;
          if (v.pitch !== undefined) camera.rotateX(v.pitch);
          if (v.fov !== undefined) {
            camera.fov = v.fov;
            camera.updateProjectionMatrix();
          }
          camera.updateMatrixWorld(true);
        }, view);
      }

      await page.evaluate(() => window.__hitscan.converge(8));
      await scenario.run(page);
      await page.evaluate(() => window.__hitscan.converge(2));
      await page.waitForTimeout(80);
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      );

      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      });
      const stats = await page.evaluate(() => ({
        ...window.__hitscan.stats(),
        ...window.__vfxDebug.counts(),
      }));
      return { data, stats };
    };

    for (const scenario of scenarios) {
      let shot;
      for (let attempt = 0; ; attempt++) {
        try {
          shot = await runScenario(scenario);
          break;
        } catch (err) {
          if (attempt >= 3 || !NAV_ERROR.test(err.message)) throw err;
          await settle(page, nav);
        }
      }

      const file = path.join(args.out, `${scenario.id}.png`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));

      const stats = shot.stats;
      results.push({ id: scenario.id, intent: scenario.intent, stats });
      process.stdout.write(
        `  ${scenario.id.padEnd(18)} ${stats.mean.toFixed(2)}ms  ${stats.calls} calls  ` +
          `${stats.particles}p (${stats.alpha}a/${stats.additive}add)  decals ${stats.decalsPlaced}ok/` +
          `${stats.decalsNoTarget}notgt/${stats.decalsNoClip}noclip  ${stats.shells} shells  ` +
          `depth${stats.depthMode}\n`
      );
    }

    await writeFile(
      path.join(args.out, 'meta.json'),
      JSON.stringify({ seed: SEED, results, consoleErrors }, null, 2)
    );
    if (consoleErrors.length > 0) {
      process.stdout.write(`\n  ${consoleErrors.length} console error(s):\n`);
      for (const e of consoleErrors.slice(0, 12)) process.stdout.write(`    ${e}\n`);
    }
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch((err) => {
  console.error(`vfx capture failed: ${err.message}`);
  process.exit(1);
});
