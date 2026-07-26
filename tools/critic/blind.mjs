#!/usr/bin/env node
/**
 * Blind A/B comparison against reference screenshots.
 *
 * Drop reference images into `refs/` and this builds a randomised, anonymised
 * comparison set: filenames are replaced with opaque labels and the order is
 * shuffled, so the critic scoring them cannot tell which frames are ours.
 * The answer key is written separately and should not be shown to the critic
 * until after it has committed to a verdict.
 *
 * This is the honest version of "compare it side by side with the real game":
 * the comparison is only meaningful if the grader genuinely cannot tell which
 * is which.
 *
 * Usage:
 *   node tools/critic/blind.mjs --ours captures/latest --refs refs --out captures/blind
 */

import { readdir, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function parseArgs(argv) {
  const args = {
    ours: path.join(ROOT, 'captures', 'latest'),
    refs: path.join(ROOT, 'refs'),
    out: path.join(ROOT, 'captures', 'blind'),
    seed: Date.now() & 0xffff,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--ours') args.ours = path.resolve(argv[++i]);
    else if (argv[i] === '--refs') args.refs = path.resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
  }
  return args;
}

async function listImages(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name));
}

/** Deterministic shuffle so a run can be reproduced from its seed. */
function shuffle(items, seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function buildBlindSet({ ours, refs, out, seed }) {
  const ourImages = await listImages(ours);
  const refImages = await listImages(refs);

  if (refImages.length === 0) {
    return {
      ok: false,
      reason:
        `no reference images in ${path.relative(ROOT, refs)}. ` +
        'Add screenshots there to enable blind comparison.',
      ourCount: ourImages.length,
    };
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const tagged = [
    ...ourImages.map((file) => ({ file, origin: 'ours' })),
    ...refImages.map((file) => ({ file, origin: 'reference' })),
  ];
  const ordered = shuffle(tagged, seed);

  const key = [];
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    // Opaque label: no ordering or naming signal about origin.
    const label = createHash('sha256')
      .update(`${seed}:${i}:${entry.file}`)
      .digest('hex')
      .slice(0, 8);
    const dest = path.join(out, `sample_${label}${path.extname(entry.file)}`);
    await copyFile(entry.file, dest);
    key.push({
      label: `sample_${label}`,
      origin: entry.origin,
      source: path.relative(ROOT, entry.file),
    });
  }

  // The key lives outside the image directory so it cannot be picked up by a
  // critic that is simply told to read everything in the folder.
  const keyPath = path.join(path.dirname(out), `${path.basename(out)}.key.json`);
  await writeFile(keyPath, JSON.stringify({ seed, key }, null, 2));

  const prompt = `You are judging still frames from first-person shooters. Some are from a shipped AAA title and some are from a work-in-progress browser game, in randomised order with anonymised filenames. You have NOT been told which is which, and you must not guess based on filename or ordering.

For each image, score overall visual fidelity from 1-10 and state which you believe is the higher-production-value frame. Then rank all frames from best to worst.

Judge only: lighting realism, material response, shadow quality, geometric detail and density, texture fidelity, and post-processing craft.

Return ONLY JSON:
{
  "rankings": ["<label best>", ..., "<label worst>"],
  "scores": { "<label>": { "score": <1-10>, "note": "<one sentence>" } },
  "guesses": { "<label>": "shipped_aaa" | "work_in_progress" }
}

Frames: ${key.map((k) => k.label).join(', ')}`;

  await writeFile(path.join(out, 'PROMPT.txt'), prompt);

  return {
    ok: true,
    out,
    keyPath,
    count: ordered.length,
    ourCount: ourImages.length,
    refCount: refImages.length,
    prompt,
  };
}

/** Scores a blind verdict against the answer key. */
export function scoreBlind(verdict, key) {
  const byLabel = new Map(key.map((k) => [k.label, k.origin]));
  const rankings = verdict.rankings ?? [];

  let correctGuesses = 0;
  let totalGuesses = 0;
  for (const [label, guess] of Object.entries(verdict.guesses ?? {})) {
    const origin = byLabel.get(label);
    if (!origin) continue;
    totalGuesses++;
    const expected = origin === 'ours' ? 'work_in_progress' : 'shipped_aaa';
    if (guess === expected) correctGuesses++;
  }

  // Mean rank of our frames versus the references. Lower is better.
  const rankOf = (label) => rankings.indexOf(label);
  const ourRanks = key.filter((k) => k.origin === 'ours').map((k) => rankOf(k.label));
  const refRanks = key.filter((k) => k.origin === 'reference').map((k) => rankOf(k.label));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  return {
    ourMeanRank: mean(ourRanks),
    refMeanRank: mean(refRanks),
    /** True when our frames outrank the references on average. */
    weWin: mean(ourRanks) < mean(refRanks),
    identificationAccuracy: totalGuesses > 0 ? correctGuesses / totalGuesses : null,
    /**
     * Accuracy near 0.5 means the critic could not tell our frames from the
     * shipped ones, which is the real success signal here.
     */
    indistinguishable:
      totalGuesses > 0 ? Math.abs(correctGuesses / totalGuesses - 0.5) < 0.2 : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  buildBlindSet(args)
    .then((result) => {
      if (!result.ok) {
        console.log(result.reason);
        process.exit(1);
      }
      console.log(
        `blind set: ${result.count} frames ` +
          `(${result.ourCount} ours, ${result.refCount} reference)`
      );
      console.log(`images: ${path.relative(ROOT, result.out)}`);
      console.log(`key:    ${path.relative(ROOT, result.keyPath)}  (do not show the critic)`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
