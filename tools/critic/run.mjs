#!/usr/bin/env node
/**
 * Captures a fresh set of frames and emits the critic briefing for them.
 *
 * This does not call a model itself. It produces the exact image set and
 * prompt that a fresh critic agent should be handed, which keeps the grader
 * stateless: a critic that remembers its previous scores anchors on them and
 * drifts upward over iterations, which would quietly defeat the gate.
 *
 * Usage:
 *   node tools/critic/run.mjs [--label render] [--shot lane] [--iteration 2]
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './capture.mjs';
import { buildCriticPrompt, GATE } from './rubric.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HISTORY = path.join(ROOT, 'captures', 'history.json');

function parseArgs(argv) {
  const args = {
    label: 'overall',
    shot: null,
    iteration: null,
    width: 2560,
    height: 1440,
    hud: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--shot') args.shot = argv[++i];
    else if (argv[i] === '--iteration') args.iteration = Number(argv[++i]);
    else if (argv[i] === '--width') args.width = Number(argv[++i]);
    else if (argv[i] === '--height') args.height = Number(argv[++i]);
    else if (argv[i] === '--hud') args.hud = true;
  }
  return args;
}

async function priorIterations(label) {
  if (!existsSync(HISTORY)) return [];
  try {
    const history = JSON.parse(await readFile(HISTORY, 'utf8'));
    return history.filter((h) => h.label === label);
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const prior = await priorIterations(args.label);
  const iteration = args.iteration ?? prior.length + 1;

  if (iteration > GATE.maxIterations) {
    console.log(
      `iteration ${iteration} exceeds the cap of ${GATE.maxIterations} for "${args.label}". ` +
        'Stop and report what fell short.'
    );
    process.exit(3);
  }

  const outDir = path.join(ROOT, 'captures', args.label, `iter-${iteration}`);
  console.log(`capturing "${args.label}" iteration ${iteration}`);

  const { meta } = await capture({
    out: outDir,
    shot: args.shot,
    width: args.width,
    height: args.height,
    hud: args.hud,
    seed: 24189,
    label: args.label,
    keepOpen: false,
    build: false,
  });

  const shotIds = meta.shots.map((s) => s.id);
  const frameTimes = meta.shots.map((s) => s.stats.mean).filter((m) => m > 0);
  const worstFrameTime = frameTimes.length > 0 ? Math.max(...frameTimes) : 0;
  const fps = worstFrameTime > 0 ? 1000 / worstFrameTime : 0;

  let brief = buildCriticPrompt({ shotIds, iteration });

  if (prior.length > 0) {
    const last = prior[prior.length - 1];
    brief +=
      `\n\nFor context, the previous iteration scored a mean of ${last.mean.toFixed(2)} ` +
      `and its worst problem was: ${last.worstProblem}\n` +
      'Do not let that anchor your scoring. Judge these frames on their own merits.';
  }

  brief +=
    `\n\nImages to review (read each one):\n` +
    meta.shots.map((s) => `  ${path.join(outDir, s.file)}  — ${s.intent}`).join('\n');

  const briefPath = path.join(outDir, 'CRITIC_BRIEF.txt');
  await mkdir(outDir, { recursive: true });
  await writeFile(briefPath, brief);

  console.log(`\n  shots:      ${shotIds.join(', ')}`);
  console.log(`  worst frame: ${worstFrameTime.toFixed(2)}ms (${fps.toFixed(0)} fps)`);
  if (meta.consoleErrors.length > 0) {
    console.log(`  console errors: ${meta.consoleErrors.length}`);
  }
  console.log(`\n  brief:  ${path.relative(ROOT, briefPath)}`);
  console.log(`  images: ${path.relative(ROOT, outDir)}`);
  console.log(
    `\n  next: hand the brief and images to a FRESH critic agent, then run\n` +
      `    node tools/critic/gate.mjs --label ${args.label} ` +
      `--iteration ${iteration} --fps ${fps.toFixed(0)} --verdict <verdict.json>`
  );
}

main().catch((err) => {
  console.error(`critic run failed: ${err.message}`);
  process.exit(1);
});
