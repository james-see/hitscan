#!/usr/bin/env node
/**
 * Integration health check.
 *
 * With many agents editing disjoint modules concurrently, the dangerous
 * failures are the ones no single author sees: a syntax error in one module
 * breaks everyone's typecheck, and a module that throws during `init` stops
 * the whole game booting even though every file compiles.
 *
 * This runs the checks that only make sense against the combined tree, and
 * reports which module is at fault so the failure can be routed to its owner.
 *
 * Exit codes: 0 healthy, 1 degraded (boots, but with errors), 2 broken.
 *
 * Usage:
 *   node tools/critic/health.mjs [--quiet] [--json]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Maps a source path to the agent responsible for it. */
function ownerOf(file) {
  const m = file.match(/src\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return 'unknown';
  if (m[1] === 'render') return m[2] === 'post' ? 'post' : 'render';
  return m[1];
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', (code) => resolve({ code, out }));
  });
}

async function checkTypes() {
  const { code, out } = await run('npx', ['tsc', '--noEmit']);
  const errors = out
    .split('\n')
    .filter((l) => /error TS/.test(l))
    .map((line) => {
      const file = line.split('(')[0]?.trim() ?? '';
      return { file, owner: ownerOf(file), line: line.trim() };
    });

  const byOwner = {};
  for (const e of errors) byOwner[e.owner] = (byOwner[e.owner] ?? 0) + 1;
  return { ok: code === 0 && errors.length === 0, count: errors.length, byOwner, errors };
}

async function checkBoot() {
  let server;
  let browser;
  try {
    server = await startServer({ build: false });
  } catch (err) {
    return { ok: false, stage: 'server', message: err.message.slice(0, 400) };
  }

  try {
    browser = await chromium.launch({
      channel: 'chrome',
      args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    const consoleErrors = [];
    const pageErrors = [];
    /** Response bodies still being read when the page finishes loading. */
    const pending = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)));
    // Chrome's console line for a bad fetch omits the URL, which makes a 404
    // impossible to act on. Record the actual request that failed.
    page.on('response', (r) => {
      if (r.status() < 400) return;
      const line = `HTTP ${r.status()} ${r.url()}`;
      consoleErrors.push(line);
      // A 500 here is Vite failing to transform a module, and the reason only
      // exists in the body. Without it this surfaces as a bare 500 plus a
      // __READY timeout, which has twice sent someone hunting for a type error
      // that tsc cannot see -- an unterminated GLSL template literal being the
      // repeat offender. Pull the transform message out so it is diagnosable.
      if (r.status() === 500) {
        pending.push(
          readBody(r)
            .then((body) => {
              const detail = transformError(body);
              if (detail) consoleErrors.push(`  ${detail}`);
            })
            .catch(() => {}),
        );
      }
    });

    await page.goto(`${server.url}/?capture=1&seed=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    let booted = true;
    try {
      await page.waitForFunction(() => window.__READY === true, null, {
        timeout: 45_000,
        polling: 100,
      });
    } catch {
      booted = false;
    }

    const diag = await page.evaluate(() => ({
      ready: window.__READY ?? false,
      status: document.getElementById('loader-status')?.textContent ?? null,
      fatal: document.getElementById('error-text')?.textContent?.slice(0, 400) || null,
      presets: typeof window.__hitscan === 'object' ? window.__hitscan.presets().length : 0,
    }));

    let stats = null;
    if (booted) {
      // Advance a little so per-frame code paths actually execute; a module
      // that throws only in update() would otherwise look healthy.
      await page.evaluate(() => window.__hitscan.step(30));
      stats = await page.evaluate(() => window.__hitscan.stats());
    }

    await Promise.all(pending);

    return {
      ok: booted && pageErrors.length === 0,
      booted,
      stage: booted ? 'ok' : 'boot',
      diag,
      stats,
      consoleErrors,
      pageErrors,
    };
  } catch (err) {
    return { ok: false, stage: 'browser', message: err.message.slice(0, 400) };
  } finally {
    if (browser) await browser.close();
    if (server) server.stop();
  }
}

/**
 * Body of a failed response, refetched over HTTP if the browser will not give
 * it up. Playwright discards the body of a module request whose script never
 * executed, which is exactly the case here.
 */
async function readBody(response) {
  try {
    const body = await response.text();
    // Resolving empty rather than rejecting is the case that matters here, so
    // an empty body has to be treated as a miss or the refetch never happens.
    if (body.trim()) return body;
  } catch {
    // Fall through to the refetch.
  }
  const again = await fetch(response.url());
  return await again.text();
}

/**
 * The human-readable reason out of a Vite 500. The page is an HTML shell with
 * the real message JSON-encoded inside a script tag, so the newlines that make
 * it readable are escaped and it prints as one unbroken line unless decoded.
 */
function transformError(body) {
  const encoded = /"message":"((?:[^"\\]|\\.)*)"/.exec(body);
  const text = encoded ? JSON.parse(`"${encoded[1]}"`) : body;
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  return line.slice(0, 300);
}

/** True when a failure is the harness racing an HMR reload, not a real fault. */
function isTransientNavigation(result) {
  const text = `${result.message ?? ''}`;
  return (
    /Execution context was destroyed/i.test(text) ||
    /Target closed/i.test(text) ||
    /frame was detached/i.test(text)
  );
}

/**
 * Agents save files continuously, and each save triggers an HMR reload that
 * can destroy the page mid-evaluation. Retry before blaming the code, or the
 * watchdog cries wolf often enough to be ignored.
 */
async function checkBootResilient(attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await checkBoot();
    if (last.ok || !isTransientNavigation(last)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ...last, transient: true };
}

async function main() {
  const quiet = process.argv.includes('--quiet');
  const asJson = process.argv.includes('--json');

  const types = await checkTypes();
  const boot = await checkBootResilient();

  const healthy = types.ok && boot.ok;
  const broken = !boot.booted;

  if (asJson) {
    console.log(JSON.stringify({ healthy, types, boot }, null, 2));
  } else {
    const parts = [];
    parts.push(types.ok ? 'types ok' : `types FAIL (${types.count})`);
    parts.push(boot.booted ? 'boot ok' : `boot FAIL (${boot.stage})`);
    if (boot.stats) parts.push(`${boot.stats.mean.toFixed(1)}ms`);
    if (boot.consoleErrors?.length) parts.push(`console ${boot.consoleErrors.length}`);
    if (boot.pageErrors?.length) parts.push(`throws ${boot.pageErrors.length}`);

    const status = healthy ? 'HEALTHY' : broken ? 'BROKEN' : 'DEGRADED';
    console.log(`HEALTH ${status} — ${parts.join(', ')}`);

    if (!quiet || !healthy) {
      if (!types.ok) {
        const blame = Object.entries(types.byOwner)
          .sort((a, b) => b[1] - a[1])
          .map(([owner, n]) => `${owner}(${n})`)
          .join(' ');
        console.log(`  type errors by owner: ${blame}`);
        for (const e of types.errors.slice(0, 8)) console.log(`    ${e.line}`);
      }
      for (const e of (boot.pageErrors ?? []).slice(0, 5)) console.log(`  throw: ${e}`);
      for (const e of (boot.consoleErrors ?? []).slice(0, 5)) console.log(`  console: ${e}`);
      if (boot.diag?.fatal) console.log(`  fatal: ${boot.diag.fatal}`);
      if (!boot.booted && boot.diag) console.log(`  stalled at: ${boot.diag.status}`);
      if (boot.message) console.log(`  ${boot.message}`);
    }
  }

  process.exit(healthy ? 0 : broken ? 2 : 1);
}

main().catch((err) => {
  console.log(`HEALTH BROKEN — harness error: ${err.message}`);
  process.exit(2);
});
