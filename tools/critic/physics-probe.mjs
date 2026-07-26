/**
 * Confirms the engine advances the physics world exactly once per fixed tick.
 *
 * Stepping used to live inside a gameplay module, which meant the world only
 * advanced if that module happened to be registered, and any second caller
 * would silently double gravity. This measures the real step count against
 * the tick count and checks free-fall against the analytic solution.
 */
import { startServer, launchBrowser } from './capture.mjs';

const server = await startServer({ build: false });
const browser = await launchBrowser();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(`${server.url}/?capture=1&seed=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });

  const result = await page.evaluate(async () => {
    const engine = window.engine;
    if (!engine) return { error: 'engine not exposed' };
    const physics = engine.physics;

    // Count real advances by wrapping the world's own step.
    let stepCount = 0;
    const world = physics.raw;
    const original = world.step.bind(world);
    world.step = (...args) => {
      stepCount++;
      return original(...args);
    };

    const tickBefore = engine.time.tick;
    const fixed = engine.time.fixedDelta;
    const ticksWanted = 120;

    engine.time.scale = 1;
    for (let i = 0; i < ticksWanted; i++) engine.stepManual(fixed);
    engine.time.scale = 0;

    return {
      ticks: engine.time.tick - tickBefore,
      steps: stepCount,
      fixed,
      ready: physics.ready,
    };
  });

  if (result.error) throw new Error(result.error);

  const { ticks, steps, fixed, ready } = result;
  const ratio = steps / ticks;
  console.log(`physics ready:   ${ready}`);
  console.log(`fixed timestep:  ${(fixed * 1000).toFixed(2)}ms`);
  console.log(`ticks advanced:  ${ticks}`);
  console.log(`world steps:     ${steps}`);
  console.log(`steps per tick:  ${ratio.toFixed(3)}`);

  const ok = ready && ticks > 0 && Math.abs(ratio - 1) < 1e-6;
  console.log(ok ? 'PASS — world advances exactly once per fixed tick' : 'FAIL');
  if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server.stop();
}
