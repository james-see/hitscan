#!/usr/bin/env node
/**
 * Renders the procedural sound bank to `public/audio/`.
 *
 * There is no licensed game-audio library available to this project, so every
 * sound is synthesised. Generation happens offline rather than at runtime for
 * three reasons: the DSP here (FFT convolution, per-sample modulated filters,
 * modal banks) costs far more than a frame budget allows; the output is
 * measurable and reviewable as a file; and the browser only pays a decode.
 *
 * Usage:
 *   node tools/audio/generate.mjs                 render + verify + report
 *   node tools/audio/generate.mjs --only weapon   render a subset
 *   node tools/audio/generate.mjs --measure       report on existing files
 */

import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attackMs,
  clippedSamples,
  dB,
  decayTimes,
  decodeWav,
  earlyEnergyRatio,
  encodeWav,
  highBandRatio,
  octaveBands,
  peak,
  rms,
  spectralCentroid,
} from './dsp.mjs';
import { BANK, renderEntry } from './synth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'public', 'audio');
const INDEX_FILE = path.join(OUT_DIR, 'index.json');

const fileNameFor = (id) => `${id.replace(/\./g, '_')}.wav`;
/** Variant suffix `_N` is stripped to form the cue the runtime asks for. */
const cueIdFor = (id) => id.replace(/_\d+$/, '');

function parseArgs(argv) {
  const args = { only: null, measure: false, quiet: false, detail: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--measure') args.measure = true;
    else if (argv[i] === '--detail') args.detail = argv[++i];
    else if (argv[i] === '--quiet') args.quiet = true;
  }
  return args;
}

const BAND_CENTRES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * Per-file spectral breakdown. Used to confirm by measurement what cannot be
 * confirmed by ear: that a gunshot has a sub-millisecond attack, energy in
 * every band from the sub layer to the crack, and a decay in the right range.
 */
async function detail(match) {
  const index = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
  const header = ['id'.padEnd(30), 'atk(ms)', 'e<20ms', ...BAND_CENTRES.map((c) => `${c >= 1000 ? `${c / 1000}k` : c}`.padStart(6))].join(' ');
  process.stdout.write(`${header}\n${'-'.repeat(header.length)}\n`);
  for (const [cueId, cue] of Object.entries(index.cues)) {
    if (!cueId.includes(match)) continue;
    for (const [i, variant] of cue.variants.entries()) {
      const decoded = decodeWav(await readFile(path.join(ROOT, 'public', variant.url.replace(/^\//, ''))));
      const mono = decoded.channels[0];
      const bands = octaveBands(mono, decoded.sampleRate, BAND_CENTRES);
      const id = cue.variants.length > 1 ? `${cueId}_${i + 1}` : cueId;
      process.stdout.write(
        [
          id.padEnd(30),
          attackMs(mono, decoded.sampleRate).toFixed(2).padStart(7),
          `${(earlyEnergyRatio(mono, decoded.sampleRate, 20) * 100).toFixed(0)}%`.padStart(6),
          ...bands.map((b) => (b < -60 ? '   -' : b.toFixed(1)).padStart(6)),
        ].join(' ') + '\n'
      );
    }
  }
}

/**
 * Numeric confirmation that the layers are actually present. Nobody can
 * listen to these in CI, so the acceptance criteria are spectral: a close
 * gunshot must have a high crest factor (a real transient), a centroid in the
 * kilohertz (the crack survived), and no clipped samples.
 */
function measure(channels, fs) {
  const mono = channels[0];
  const { t20, t60 } = decayTimes(mono, fs);
  return {
    channels: channels.length,
    sampleRate: fs,
    frames: mono.length,
    durationMs: (mono.length / fs) * 1000,
    peak: peak(mono),
    rms: rms(mono),
    crest: peak(mono) / Math.max(1e-9, rms(mono)),
    centroid: spectralCentroid(mono, fs),
    highRatio: highBandRatio(mono, fs, 2000),
    t20,
    t60,
    clipped: channels.reduce((n, c) => n + clippedSamples(c), 0),
  };
}

/**
 * Per-group expectations. These are loose sanity bounds, not a mix spec:
 * they exist to catch a synth that silently rendered noise, silence, or a
 * DC-heavy blob after an edit.
 */
const EXPECT = {
  weapon: { centroid: [700, 7000], crest: [3, 60], minRms: 0.02 },
  impact: { centroid: [500, 9000], crest: [3, 80], minRms: 0.01 },
  step: { centroid: [200, 6000], crest: [2.5, 60], minRms: 0.01 },
  shell: { centroid: [2000, 12000], crest: [4, 90], minRms: 0.004 },
  ui: { centroid: [800, 9000], crest: [2, 40], minRms: 0.02 },
  player: { centroid: [150, 6000], crest: [2.5, 60], minRms: 0.01 },
  ambience: { centroid: [40, 1500], crest: [1.5, 12], minRms: 0.05 },
  ir: { centroid: [200, 6000], crest: [3, 400], minRms: 0.002 },
};

function checkExpectations(entry, m) {
  const rules = EXPECT[entry.group];
  const problems = [];
  if (m.clipped > 0) problems.push(`${m.clipped} clipped samples`);
  if (m.peak < 0.2) problems.push(`peak too low (${m.peak.toFixed(3)})`);
  if (!rules) return problems;
  if (m.centroid < rules.centroid[0] || m.centroid > rules.centroid[1]) {
    problems.push(`centroid ${m.centroid.toFixed(0)}Hz outside ${rules.centroid.join('..')}`);
  }
  if (m.crest < rules.crest[0] || m.crest > rules.crest[1]) {
    problems.push(`crest ${m.crest.toFixed(1)} outside ${rules.crest.join('..')}`);
  }
  if (m.rms < rules.minRms) problems.push(`rms ${m.rms.toFixed(4)} below ${rules.minRms}`);
  return problems;
}

function formatRow(id, m, bytes) {
  return [
    id.padEnd(30),
    String(m.channels).padStart(2),
    `${(m.sampleRate / 1000).toFixed(0)}k`.padStart(4),
    `${m.durationMs.toFixed(0)}ms`.padStart(7),
    `${(bytes / 1024).toFixed(0)}K`.padStart(6),
    `${dB(m.peak).toFixed(1)}`.padStart(6),
    `${dB(m.rms).toFixed(1)}`.padStart(7),
    m.crest.toFixed(1).padStart(6),
    `${m.centroid.toFixed(0)}`.padStart(7),
    `${(m.highRatio * 100).toFixed(0)}%`.padStart(5),
    `${(m.t20 * 1000).toFixed(0)}`.padStart(6),
    `${(m.t60 * 1000).toFixed(0)}`.padStart(6),
  ].join(' ');
}

const HEADER = [
  'id'.padEnd(30),
  'ch',
  '  sr',
  '   dur',
  '  size',
  '  peak',
  '    rms',
  ' crest',
  'centrd',
  ' >2k',
  '   t20',
  '   t60',
].join(' ');

async function generate(args) {
  await mkdir(OUT_DIR, { recursive: true });

  const entries = args.only ? BANK.filter((e) => e.id.includes(args.only)) : BANK;
  if (entries.length === 0) throw new Error(`no bank entries match "${args.only}"`);

  const rows = [];
  const problems = [];
  const cues = {};
  let totalBytes = 0;
  const written = new Set();

  for (const entry of entries) {
    const { channels, fs } = renderEntry(entry);
    const wav = encodeWav(channels, fs);
    const file = fileNameFor(entry.id);
    await writeFile(path.join(OUT_DIR, file), wav);
    written.add(file);
    totalBytes += wav.length;

    // Round-trip through the encoder so what is measured is what ships,
    // including 16-bit quantisation.
    const decoded = decodeWav(await readFile(path.join(OUT_DIR, file)));
    if (decoded.sampleRate !== fs || decoded.channels.length !== channels.length) {
      problems.push(`${entry.id}: decoded header mismatch`);
    }
    const m = measure(decoded.channels, decoded.sampleRate);
    const sourceRms = rms(channels[0]);
    if (Math.abs(dB(m.rms) - dB(sourceRms)) > 0.15) {
      problems.push(`${entry.id}: rms drifted ${dB(sourceRms).toFixed(2)} -> ${dB(m.rms).toFixed(2)}dB`);
    }
    for (const p of checkExpectations(entry, m)) problems.push(`${entry.id}: ${p}`);

    rows.push(formatRow(entry.id, m, wav.length));

    const cueId = cueIdFor(entry.id);
    const cue = (cues[cueId] ??= {
      group: entry.group,
      gain: entry.gain ?? 1,
      loop: entry.loop ?? false,
      variants: [],
    });
    cue.variants.push({
      url: `/audio/${file}`,
      durationMs: Math.round(m.durationMs),
      sampleRate: m.sampleRate,
      channels: m.channels,
    });
  }

  if (!args.only) {
    // A renamed or removed sound would otherwise linger and ship forever.
    for (const name of await readdir(OUT_DIR)) {
      if (name.endsWith('.wav') && !written.has(name)) {
        await unlink(path.join(OUT_DIR, name));
        process.stdout.write(`  removed stale ${name}\n`);
      }
    }
    await writeFile(
      INDEX_FILE,
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString().slice(0, 10),
          note: 'Procedurally synthesised by tools/audio/generate.mjs. No third-party audio.',
          cues,
        },
        null,
        2
      )}\n`
    );
  }

  return { rows, problems, totalBytes, count: entries.length };
}

async function measureExisting(args) {
  if (!existsSync(INDEX_FILE)) throw new Error('no bank generated yet');
  const index = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
  const rows = [];
  const problems = [];
  let totalBytes = 0;
  let count = 0;

  for (const [cueId, cue] of Object.entries(index.cues)) {
    for (const [i, variant] of cue.variants.entries()) {
      const file = path.join(ROOT, 'public', variant.url.replace(/^\//, ''));
      if (args.only && !cueId.includes(args.only)) continue;
      const raw = await readFile(file);
      const decoded = decodeWav(raw);
      const m = measure(decoded.channels, decoded.sampleRate);
      totalBytes += raw.length;
      count++;
      const id = cue.variants.length > 1 ? `${cueId}_${i + 1}` : cueId;
      rows.push(formatRow(id, m, raw.length));
      for (const p of checkExpectations({ group: cue.group }, m)) problems.push(`${id}: ${p}`);
    }
  }
  return { rows, problems, totalBytes, count };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.detail !== null) {
    await detail(args.detail);
    return;
  }
  const result = args.measure ? await measureExisting(args) : await generate(args);

  if (!args.quiet) {
    process.stdout.write(`${HEADER}\n${'-'.repeat(HEADER.length)}\n`);
    for (const row of result.rows) process.stdout.write(`${row}\n`);
  }
  process.stdout.write(
    `\n${result.count} file(s), ${(result.totalBytes / 1024 / 1024).toFixed(2)} MB total\n`
  );

  if (result.problems.length > 0) {
    process.stdout.write(`\n${result.problems.length} problem(s):\n`);
    for (const p of result.problems) process.stdout.write(`  ${p}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('all checks passed\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
