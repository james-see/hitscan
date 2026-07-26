#!/usr/bin/env node
/**
 * Boots the game in a real browser and verifies the audio runtime.
 *
 * The screenshot harness deliberately never interacts with the page, so the
 * `AudioContext` stays suspended there and the bank is not even decoded. This
 * script covers the other half: it produces a real user gesture, waits for the
 * context to start, confirms every generated file decodes, then drives the
 * module through the event bus and checks that voices actually started, that
 * the pool steals rather than overflows, and that nothing logged an error.
 *
 * Usage: node tools/audio/verify-runtime.mjs
 */

import { launchBrowser, startServer } from '../critic/capture.mjs';

/** Requests the browser makes on its own, which the project does not serve. */
const IGNORED_URLS = [/favicon\.ico/];
/**
 * The console text for a failed subresource carries no URL, so it is filtered
 * here and the failure is reported by the response listener instead, which
 * does know what was requested.
 */
const RESOURCE_ERROR = /^Failed to load resource/;

async function runOnce(server, browser) {
  const checks = [];
  const check = (label, ok, detail = '') => checks.push({ label, ok: Boolean(ok), detail });
  /** For behaviour that cannot be exercised because a dependency is inert. */
  const skip = (label, detail) => checks.push({ label, ok: true, skipped: true, detail });
  const consoleErrors = [];
  const foreignErrors = [];
  const badResponses = [];

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Other agents are editing this repo continuously and every save triggers a
  // dev-server hot reload that destroys the run. The HMR channel is a plain
  // WebSocket, so stubbing one that never connects leaves module loading
  // intact while making the page immune to reloads for the few seconds the
  // checks take.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    class Inert {
      readyState = 0;
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    }
    window.WebSocket = new Proxy(Real, {
      construct: (target, args) =>
        /vite-hmr|[?&]token=/.test(String(args[0])) ? new Inert() : new target(...args),
    });
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (RESOURCE_ERROR.test(text)) return;
    // Other modules are under concurrent development and their logging is not
    // this module's to police, so their errors are counted separately.
    const mine = /\[audio\]/.test(text) || /\/src\/audio\//.test(msg.location().url ?? '');
    (mine ? consoleErrors : foreignErrors).push(text);
  });
  page.on('pageerror', (err) => {
    const mine = /\/src\/audio\//.test(err.stack ?? '');
    (mine ? consoleErrors : foreignErrors).push(`pageerror: ${err.message}`);
  });
  page.on('response', (res) => {
    if (res.status() < 400) return;
    if (IGNORED_URLS.some((re) => re.test(res.url()))) return;
    badResponses.push(`${res.status()} ${res.url()}`);
  });
  // The dev server hot-reloads whenever any file in the repo changes, which
  // destroys the execution context mid-run. Detect it and let the caller retry
  // rather than reporting a spurious failure.
  let navigated = false;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && frame.url() !== 'about:blank') navigated = true;
  });

  try {
    process.stdout.write('  booting\n');
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    navigated = false;
    await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });

    // A keypress is a user gesture, and unlike clicking the start prompt it
    // does not request pointer lock, which fails noisily under automation.
    await page.keyboard.press('ShiftLeft');

    process.stdout.write('  waiting for bank\n');
    await page.waitForFunction(() => window.__hitscanAudio !== undefined, null, { timeout: 20_000 });
    await page.evaluate(() => window.__hitscanAudio.ready());
    await page.waitForFunction(() => window.__hitscanAudio.state().context === 'running', null, {
      timeout: 15_000,
      polling: 100,
    });

    const loaded = await page.evaluate(() => window.__hitscanAudio.state());
    check('audio context running', loaded.context === 'running', loaded.context);
    check('bank loaded', loaded.loaded);
    check('cues decoded', loaded.bank.cues >= 35, `${loaded.bank.cues} cues`);
    check('variants decoded', loaded.bank.buffers >= 70, `${loaded.bank.buffers} buffers`);
    check('no decode failures', loaded.bank.failures === 0, `${loaded.bank.failures} failures`);
    check('reverb impulses installed', loaded.reverbReady);
    check(
      'decoded footprint reasonable',
      loaded.bank.bytes < 24 * 1024 * 1024,
      `${(loaded.bank.bytes / 1024 / 1024).toFixed(1)} MB float`
    );

    const cues = await page.evaluate(() => window.__hitscanAudio.cues());
    check('impulse responses present', cues.includes('ir.courtyard') && cues.includes('ir.interior'));
    check(
      'gunfire stems present',
      cues.includes('weapon.rifle.fire.close') && cues.includes('weapon.rifle.fire.distant')
    );

    process.stdout.write('  driving events\n');
    const emitted = await page.evaluate(() => window.__hitscanAudio.selfTest());
    check('self test emitted events', emitted > 20, `${emitted} events`);
    await page.waitForTimeout(1800);

    const after = await page.evaluate(() => window.__hitscanAudio.state());
    check('voices started', after.voices.started >= 20, `${after.voices.started} started`);
    check('reload sequence drained', after.pending === 0, `${after.pending} pending`);
    check('enclosure probe reporting', Number.isFinite(after.enclosure), after.enclosure.toFixed(3));
    check('reverb blend in range', after.reverbBlend >= 0 && after.reverbBlend <= 1, after.reverbBlend.toFixed(3));
    // Sitting at heavy gain reduction would mean the mix is saturated; a
    // limiter that never moves at all would mean nothing reached it.
    check('limiter sane', after.compression <= 0 && after.compression > -30, `${after.compression.toFixed(1)} dB`);

    process.stdout.write('  stress: sustained fire\n');
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.__hitscanAudio.selfTest());
      await page.waitForTimeout(90);
    }
    const stressed = await page.evaluate(() => window.__hitscanAudio.state());
    check('voice cap respected', stressed.voices.active <= 34, `${stressed.voices.active} active`);
    check(
      'stealing engaged under load',
      stressed.voices.stolen + stressed.voices.dropped > 0,
      `${stressed.voices.stolen} stolen, ${stressed.voices.dropped} dropped`
    );

    // Occlusion and the reverb zone crossfade are both raycast-driven. If the
    // physics query pipeline is inert they read as "open and unoccluded",
    // which is the correct fallback but means the two checks below cannot
    // prove anything, so they are reported as skipped rather than failed.
    const queries = await page.evaluate(() => window.__hitscanAudio.raycastsWork());
    if (queries) {
      const probe = await page.evaluate(() => {
        // Coarse sweep: the arena layout is another module's business, so
        // rather than hard-coding a room, take the extremes of a grid.
        let open = 1;
        let closed = 0;
        for (let x = -36; x <= 36; x += 3) {
          for (let z = -36; z <= 36; z += 3) {
            const e = window.__hitscanAudio.enclosureAt(x, 1.6, z);
            if (e < open) open = e;
            if (e > closed) closed = e;
          }
        }
        return { open, closed };
      });
      check('open ground reads open', probe.open < 0.3, probe.open.toFixed(3));
      check(
        'enclosed ground reads enclosed',
        probe.closed > probe.open + 0.25,
        `${probe.closed.toFixed(3)} vs ${probe.open.toFixed(3)}`
      );
    } else {
      skip('enclosure discriminates', 'physics scene queries return nothing');
      skip('occlusion active', 'physics scene queries return nothing');
    }

    // Whether or not the live world answers queries, the response curves
    // themselves must be right. The modules are re-imported from the dev
    // server and driven against a synthetic world, so this covers the code
    // that will run once scene queries come back.
    const synthetic = await page.evaluate(async () => {
      const { EnclosureProbe, OcclusionSampler } = await import('/src/audio/Occlusion.ts');
      // Both classes only read x/y/z off the positions they are handed, so
      // plain objects stand in for vectors and no bare specifier has to be
      // resolved from page scope.
      const vec = (x, y, z) => ({ x, y, z });

      const empty = { raycast: () => null };
      // A 6x3x6 room around the origin, hit-tested with the slab method.
      const room = {
        raycast: ({ origin, direction, maxDistance }) => {
          let t = Infinity;
          const bounds = [
            [-3, 3],
            [0, 3],
            [-3, 3],
          ];
          const o = [origin.x, origin.y, origin.z];
          const d = [direction.x, direction.y, direction.z];
          for (let i = 0; i < 3; i++) {
            if (Math.abs(d[i]) < 1e-6) continue;
            for (const plane of bounds[i]) {
              const hit = (plane - o[i]) / d[i];
              if (hit > 1e-4 && hit < t) t = hit;
            }
          }
          return t <= maxDistance ? { distance: t } : null;
        },
      };
      const wall = { raycast: ({ maxDistance }) => ({ distance: maxDistance * 0.5 }) };

      const at = vec(0, 1.6, 0);
      const source = vec(0, 1.6, 12);
      const clear = new OcclusionSampler(empty);
      clear.beginFrame();
      const blocked = new OcclusionSampler(wall);
      blocked.beginFrame();
      return {
        outdoors: new EnclosureProbe(empty).sampleAt(at),
        indoors: new EnclosureProbe(room).sampleAt(at),
        clear: clear.sample(at, source, 0),
        blocked: blocked.sample(at, source, 0),
      };
    });
    check('enclosure: open world reads 0', synthetic.outdoors === 0, synthetic.outdoors.toFixed(3));
    check('enclosure: closed room reads high', synthetic.indoors > 0.8, synthetic.indoors.toFixed(3));
    check('occlusion: clear line of sight', synthetic.clear === 0, synthetic.clear.toFixed(2));
    check('occlusion: blocked line of sight', synthetic.blocked === 1, synthetic.blocked.toFixed(2));

    check('no audio requests failed', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));
    check('no audio console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    if (foreignErrors.length) {
      skip('console clean overall', `${foreignErrors.length} from other modules: ${foreignErrors[0].slice(0, 60)}`);
    } else {
      check('console clean overall', true);
    }
    return { checks, navigated: () => navigated, error: null };
  } catch (error) {
    return { checks, navigated: () => navigated, error };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  let result = null;

  try {
    const ATTEMPTS = 4;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const run = await runOnce(server, browser);
      if (!run.navigated() && !run.error) {
        result = run;
        break;
      }
      // Concurrent edits to the repo break a run two ways: a hot reload
      // destroys the execution context, and a half-saved file makes the dev
      // server serve a 500 so the app never boots. Both are transient.
      if (attempt === ATTEMPTS) throw run.error ?? new Error('page kept reloading mid-run');
      process.stdout.write(`  run interrupted (${run.error ? 'boot failed' : 'hot reload'}); retrying\n`);
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (!result) throw new Error('could not complete a clean run');

  let failed = 0;
  let skipped = 0;
  for (const { label, ok, detail, skipped: wasSkipped } of result.checks) {
    if (!ok) failed++;
    if (wasSkipped) skipped++;
    const tag = wasSkipped ? 'SKIP' : ok ? 'PASS' : 'FAIL';
    process.stdout.write(`  ${tag}  ${label.padEnd(30)} ${detail}\n`);
  }
  const total = result.checks.length;
  const tail = skipped ? `, ${skipped} skipped` : '';
  process.stdout.write(`\n${total - failed - skipped}/${total - skipped} checks passed${tail}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify-runtime failed: ${err.message}`);
  process.exit(1);
});
