/**
 * Asserts that two captures of the same shot are byte-identical.
 *
 * The capture harness documents itself as deterministic, and a great deal of
 * analysis in this project has been built on differencing two capture runs.
 * That is only valid if the identity case -- same seed, same shot, nothing
 * changed -- produces the same image. It did not: identical runs differed by
 * a mean of 3.2 to 5.0 across 70 to 93% of pixels, concentrated on geometric
 * edges, which put a noise floor under every screenshot A/B and produced at
 * least one confident conclusion that was pure sampling artefact.
 *
 * This is the control that should have existed before any of those
 * comparisons were trusted. Run it after any change to the capture path.
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { capture, startServer, launchBrowser } from './capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'captures', '_determinism');

/** Per-pixel statistics between two images of identical dimensions. */
async function compare(a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).raw().toBuffer({ resolveWithObject: true }),
    sharp(b).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (ra.data.length !== rb.data.length) throw new Error('dimension mismatch');

  let changed = 0;
  let total = 0;
  let sum = 0;
  let max = 0;
  const channels = ra.info.channels;

  for (let i = 0; i < ra.data.length; i += channels) {
    let delta = 0;
    for (let c = 0; c < Math.min(3, channels); c++) {
      delta = Math.max(delta, Math.abs(ra.data[i + c] - rb.data[i + c]));
    }
    total++;
    if (delta > 0) {
      changed++;
      sum += delta;
      if (delta > max) max = delta;
    }
  }

  return {
    changedPct: (changed / total) * 100,
    meanDelta: changed === 0 ? 0 : sum / changed,
    maxDelta: max,
    identical: changed === 0,
  };
}

async function main() {
  const argv = process.argv;
  const shot = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : null;
  const runs = argv.includes('--runs') ? Number(argv[argv.indexOf('--runs') + 1]) : 2;

  await rm(OUT, { recursive: true, force: true });

  // One server and one browser across all runs, so the only thing varying is
  // the capture path itself rather than process startup.
  const server = await startServer({});
  const browser = await launchBrowser();

  try {
    const sets = [];
    for (let r = 0; r < runs; r++) {
      process.stdout.write(`run ${r + 1} of ${runs}\n`);
      const { results } = await capture({
        out: path.join(OUT, `run${r}`),
        shot,
        server,
        browser,
        label: `determinism-${r}`,
      });
      sets.push(results);
    }

    process.stdout.write('\n');
    let failures = 0;

    // All pairs, not just against run 0. Comparing only against the first run
    // cannot distinguish "every run differs from every other" from "the first
    // run is the odd one out", and those have completely different causes:
    // the first is nondeterminism, the second is a cold-start artefact that a
    // throwaway warmup would fix.
    for (const shotResult of sets[0]) {
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const a = sets[i].find((x) => x.id === shotResult.id);
          const b = sets[j].find((x) => x.id === shotResult.id);
          const stats = await compare(a.file, b.file);
          const verdict = stats.identical ? 'identical' : 'DIFFERS';
          if (!stats.identical) failures++;
          process.stdout.write(
            `  ${shotResult.id.padEnd(20)} run${i} vs run${j}  ${verdict.padEnd(10)}` +
              (stats.identical
                ? '\n'
                : ` ${stats.changedPct.toFixed(2)}% of pixels, mean ${stats.meanDelta.toFixed(3)}, max ${stats.maxDelta}\n`)
          );
        }
      }
    }

    process.stdout.write('\n');
    if (failures > 0) {
      process.stdout.write(
        `FAIL: ${failures} comparison(s) differ. Screenshot-differential A/B is\n` +
          `not valid while this fails, because any measured change smaller than\n` +
          `this floor is indistinguishable from the harness reproducing itself.\n`
      );
      process.exitCode = 1;
    } else {
      process.stdout.write('PASS: captures are byte-identical across runs.\n');
    }
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
