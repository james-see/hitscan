#!/usr/bin/env node
/**
 * Applies the quality gate to a critic verdict and records the result.
 *
 * Exit code 0 means the gate passed and the iteration loop for that subsystem
 * can stop; exit code 1 means another iteration is warranted. This is what
 * makes the loop terminate on evidence rather than on vibes.
 *
 * Usage:
 *   node tools/critic/gate.mjs --verdict verdict.json [--label render] [--fps 92]
 *   cat verdict.json | node tools/critic/gate.mjs --label render
 */

import { readFile, writeFile, mkdir, open, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, GATE, evaluate, validateVerdict } from './rubric.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HISTORY = path.join(ROOT, 'captures', 'history.json');

function parseArgs(argv) {
  const args = { verdict: null, label: 'overall', fps: undefined, iteration: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--verdict') args.verdict = path.resolve(argv[++i]);
    else if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--fps') args.fps = Number(argv[++i]);
    else if (argv[i] === '--iteration') args.iteration = Number(argv[++i]);
  }
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length > 0 ? text : null;
}

function bar(score) {
  const filled = Math.round(score);
  return '#'.repeat(filled) + '.'.repeat(10 - filled);
}

async function loadHistory() {
  if (!existsSync(HISTORY)) return [];
  try {
    return JSON.parse(await readFile(HISTORY, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Appends one entry to the shared history under an exclusive lock.
 *
 * The loop is meant to run per subsystem in parallel, so two gates can finish
 * at once. Each holds an array it read minutes earlier, before scoring, and a
 * plain write-back would silently drop the other's entry. Re-reading inside
 * the lock keeps the append honest.
 */
async function appendHistory(entry) {
  await mkdir(path.dirname(HISTORY), { recursive: true });
  const lock = `${HISTORY}.lock`;

  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      handle = await open(lock, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!handle) throw new Error(`could not acquire ${lock} after 5s`);

  try {
    const history = await loadHistory();
    history.push(entry);
    await writeFile(HISTORY, JSON.stringify(history, null, 2));
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = args.verdict ? await readFile(args.verdict, 'utf8') : await readStdin();
  if (!raw) {
    console.error('provide a verdict via --verdict <file> or on stdin');
    process.exit(2);
  }

  let verdict;
  try {
    verdict = validateVerdict(raw);
  } catch (err) {
    console.error(`malformed verdict: ${err.message}`);
    process.exit(2);
  }

  const result = evaluate(verdict, { fps: args.fps });

  const history = await loadHistory();
  const priorForLabel = history.filter((h) => h.label === args.label);
  const iteration = args.iteration ?? priorForLabel.length + 1;
  const previous = priorForLabel[priorForLabel.length - 1];

  console.log(`\n  ${args.label}  —  iteration ${iteration}\n`);
  for (const category of CATEGORIES) {
    const entry = verdict.scores[category.id];
    const flag = entry.score < GATE.minCategoryScore ? ' <-- below gate' : '';
    const delta = previous?.scores?.[category.id]
      ? entry.score - previous.scores[category.id].score
      : null;
    const trend = delta === null || delta === 0 ? '   ' : delta > 0 ? ` +${delta}` : ` ${delta}`;
    console.log(
      `  ${category.id.padEnd(16)} ${String(entry.score).padStart(2)}/10 ` +
        `[${bar(entry.score)}]${trend}${flag}`
    );
    if (entry.note) console.log(`  ${''.padEnd(16)} ${entry.note}`);
  }

  console.log(`\n  mean ${result.mean.toFixed(2)} (gate ${GATE.minMeanScore})`);
  if (args.fps !== undefined) console.log(`  fps  ${args.fps.toFixed(0)} (gate ${GATE.minFps})`);
  if (verdict.disqualifiers.length > 0) {
    console.log(`  disqualifiers: ${verdict.disqualifiers.join(', ')}`);
  }

  if (result.passed) {
    console.log(`\n  PASS — quality gate met\n`);
  } else {
    console.log(`\n  FAIL — ${result.reasons.join('; ')}`);
    if (verdict.worstProblem) console.log(`  worst: ${verdict.worstProblem}`);
    if (verdict.fixes.length > 0) {
      console.log('  next fixes:');
      for (const fix of verdict.fixes.slice(0, 6)) console.log(`    - ${fix}`);
    }
    if (iteration >= GATE.maxIterations) {
      console.log(
        `\n  iteration cap (${GATE.maxIterations}) reached — stop looping and ` +
          'report what fell short rather than continuing.'
      );
    }
    console.log('');
  }

  await appendHistory({
    label: args.label,
    iteration,
    at: new Date().toISOString(),
    mean: result.mean,
    passed: result.passed,
    fps: args.fps ?? null,
    scores: verdict.scores,
    disqualifiers: verdict.disqualifiers,
    worstProblem: verdict.worstProblem,
    fixes: verdict.fixes,
  });

  // Exit code drives the loop: 0 stops, 1 iterates again.
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
