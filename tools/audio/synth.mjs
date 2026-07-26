/**
 * Procedural synthesis of the whole sound bank.
 *
 * Every entry declares its own sample rate, playback gain and renderer. The
 * renderer is handed a deterministic RNG seeded from the sound's id, so the
 * bank is byte-reproducible and a single sound can be re-rolled by renaming
 * its variant index.
 *
 * Sample-rate choices are per-category rather than global: footsteps, room
 * impulses and ambience carry almost nothing above 10kHz, so 24kHz halves
 * their size with no audible cost. The browser resamples on decode.
 */

import {
  TAU,
  alloc,
  applyEnv,
  convolve,
  createRng,
  dampedSine,
  dcBlock,
  fadeEdges,
  highpass,
  highshelf,
  lowpass,
  lowshelf,
  mixInto,
  normalize,
  peaking,
  percussive,
  pinkNoise,
  saturate,
  seconds,
  svf,
  trimTail,
  whiteNoise,
} from './dsp.mjs';

const FS_FULL = 48000;
const FS_HALF = 24000;

// -- shared building blocks --------------------------------------------------

/** Exponential glide from `f0` to `f1` with time constant `tau`, in Hz. */
const sweep = (f0, f1, tau, fs) => (i) => f1 + (f0 - f1) * Math.exp(-i / fs / tau);

/**
 * Bank of exponentially damped sinusoids. This is the modal model of a struck
 * body: the partial frequencies set the material's identity (inharmonic and
 * widely spaced for metal, low and closely spaced for wood) and the per-mode
 * decay sets how "ringy" it is.
 */
function modes(n, fs, list, rng) {
  const out = alloc(n);
  for (const m of list) {
    mixInto(
      out,
      dampedSine(
        out.length,
        fs,
        m.f * (rng ? rng.detune(m.spread ?? 0.02) : 1),
        m.tau,
        m.amp ?? 1,
        rng ? rng.next() * TAU : 0,
        m.drift ?? 0
      ),
      1
    );
  }
  return out;
}

/**
 * Granular amplitude envelope: overlapping short raised-cosine grains at a
 * randomised rate. Loose material (gravel, leaves, sand) is not a smooth
 * noise burst, it is a burst of many small independent events, and the ear
 * hears the difference immediately.
 */
function grains(n, fs, rng, { rate = 220, grainMs = 9, jitter = 0.7, floor = 0.08 } = {}) {
  const out = alloc(n);
  out.fill(floor);
  const grainLen = seconds(grainMs / 1000, fs);
  const step = fs / rate;
  for (let pos = 0; pos < out.length; pos += step * rng.range(1 - jitter, 1 + jitter)) {
    const start = Math.round(pos);
    const amp = rng.range(0.35, 1);
    const len = Math.round(grainLen * rng.range(0.5, 1.6));
    for (let i = 0; i < len && start + i < out.length; i++) {
      out[start + i] += amp * (0.5 - 0.5 * Math.cos((TAU * i) / len));
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1.6, out[i]);
  return out;
}

/** Filtered noise burst with a percussive envelope. The workhorse. */
function noiseHit(n, fs, rng, { f0, f1 = f0, sweepTau = 0.02, q = 1.1, mode = 'bp', attack = 0.0004, tau = 0.03, shape = 1, pink = false }) {
  const src = pink ? pinkNoise(n, rng) : whiteNoise(n, rng);
  const filtered = svf(src, fs, sweep(f0, f1, sweepTau, fs), q, mode);
  return applyEnv(filtered, percussive(filtered.length, fs, { attack, tau, shape }));
}

/** Sine whose frequency glides exponentially; the muzzle-blast sub layer. */
function subSweep(n, fs, f0, f1, glideTau, ampTau, attack = 0.001) {
  const out = alloc(n);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = f1 + (f0 - f1) * Math.exp(-i / fs / glideTau);
    phase += (TAU * f) / fs;
    out[i] = Math.sin(phase);
  }
  return applyEnv(out, percussive(out.length, fs, { attack, tau: ampTau, shape: 1.4 }));
}

/**
 * Synthetic room response: predelay, discrete early reflections, then an
 * exponentially decaying diffuse tail whose bandwidth closes over time.
 * Real rooms lose high frequency fastest (air absorption plus soft surfaces),
 * so a tail with a static spectrum sounds like a spring reverb.
 */
function roomIr(fs, rng, {
  rt60,
  predelayMs,
  erCount,
  erSpanMs,
  erGain = 0.55,
  hfStart = 9000,
  hfEnd = 900,
  damping = 0.32,
  seedGain = 1,
}) {
  const n = seconds(rt60 * 1.05 + predelayMs / 1000 + 0.02, fs);
  const out = alloc(n);
  const predelay = seconds(predelayMs / 1000, fs);

  // Diffuse field: noise shaped by the Sabine decay, then progressively
  // lowpassed so late energy is dark.
  const tau = rt60 / 6.908;
  const diffuse = whiteNoise(n, rng);
  for (let i = 0; i < n; i++) diffuse[i] *= Math.exp(-i / fs / tau);
  const shaped = svf(diffuse, fs, sweep(hfStart, hfEnd, damping, fs), 0.7071, 'lp');
  // Build-up: energy in a real room ramps over the first few reflections
  // rather than starting at full density.
  const buildup = seconds(0.012, fs);
  for (let i = 0; i < buildup; i++) shaped[i] *= i / buildup;
  mixInto(out, shaped, seedGain, predelay);

  // Early reflections carry the size and shape cues. Spacing is irregular on
  // purpose: evenly spaced taps comb-filter into a metallic ring.
  for (let k = 0; k < erCount; k++) {
    const t = (k / erCount) ** 0.75 * (erSpanMs / 1000) * rng.range(0.75, 1.25);
    const idx = predelay + seconds(t, fs);
    if (idx >= n - 4) continue;
    const g = erGain * Math.exp(-t / (rt60 * 0.28)) * rng.range(0.4, 1) * (rng.chance(0.35) ? -1 : 1);
    // Each tap is a couple of samples wide rather than a bare impulse, which
    // keeps it from sounding like a click track.
    out[idx] += g;
    out[idx + 1] += g * 0.5;
    out[idx + 2] += g * 0.22;
  }
  return out;
}

// -- weapon: layered gunfire -------------------------------------------------

/**
 * Close-perspective rifle report.
 *
 * Four layers, all keyed to how a real muzzle blast behaves:
 *  1. crack — the shock front. Sub-millisecond attack, mostly above 2kHz.
 *     This is the layer that makes the shot sound *near*.
 *  2. body — the expanding gas ball. Bandpassed noise whose centre frequency
 *     collapses from ~2.4kHz to ~450Hz in 30ms as the blast sphere grows.
 *     Saturated, because a shock wave is by definition nonlinear.
 *  3. sub — chest punch. A sine gliding 170Hz to 50Hz; short, because a rifle
 *     is a snap not a boom.
 *  4. mechanism — bolt unlock and carrier travel, arriving a few ms late.
 * A short near-field tail glues them; the room's contribution is added at
 * runtime by the convolution bus, not baked in here.
 */
function rifleClose(rng, fs) {
  const n = seconds(0.42, fs);
  const out = alloc(n);

  const crackTau = 0.0035 * rng.range(0.85, 1.2);
  const crack = noiseHit(seconds(0.05, fs), fs, rng, {
    f0: 4400 * rng.detune(0.1),
    f1: 2000,
    sweepTau: 0.005,
    q: 0.6,
    mode: 'hp',
    attack: 0.00003,
    tau: crackTau,
  });
  // A resonant peak in the 4-6kHz "presence" band is what reads as barrel
  // report on small speakers, which is where most players will hear this.
  peaking(crack, fs, 5200 * rng.detune(0.08), 1.1, 6);
  mixInto(out, crack, 1.3);

  // Snap: the 2-6kHz band sustained for ~15ms rather than the crack's 3.
  // Without it the shot has an impressive click and then nothing up top, and
  // reads as a door slam. This is the layer that makes it sound like a rifle.
  const snap = noiseHit(seconds(0.09, fs), fs, rng, {
    f0: 4000 * rng.detune(0.08),
    f1: 1700,
    sweepTau: 0.014,
    q: 0.9,
    mode: 'bp',
    attack: 0.00008,
    tau: 0.017 * rng.range(0.85, 1.2),
    shape: 1.15,
  });
  mixInto(out, snap, 0.75);

  const body = noiseHit(seconds(0.24, fs), fs, rng, {
    f0: 2400 * rng.detune(0.08),
    f1: 440 * rng.detune(0.1),
    sweepTau: 0.03 * rng.range(0.85, 1.15),
    q: 1.35,
    mode: 'bp',
    attack: 0.0004,
    tau: 0.05 * rng.range(0.85, 1.2),
    shape: 1.25,
  });
  saturate(body, 2.4, 0.3);
  mixInto(out, body, 1);

  // A second, wider band under the body fills the 300-900Hz gap that a single
  // high-Q sweep leaves; without it the shot sounds hollow.
  const lowBody = noiseHit(seconds(0.22, fs), fs, rng, {
    f0: 900,
    f1: 190,
    sweepTau: 0.055,
    q: 0.7,
    mode: 'lp',
    attack: 0.0008,
    tau: 0.07 * rng.range(0.9, 1.15),
  });
  mixInto(out, lowBody, 0.6);

  // Sub: deliberately restrained and stopped at 70Hz rather than 50. A rifle
  // is a snap, not an explosion, and a sine that settles below 60Hz dominates
  // the peak (costing headroom every other layer needs) while being inaudible
  // on the speakers most players use.
  mixInto(out, subSweep(seconds(0.24, fs), fs, 230 * rng.detune(0.07), 88, 0.018, 0.055), 0.34);

  // Mechanism: unlock at ~13ms, carrier hitting the buffer at ~40ms. Offsets
  // vary per variant because the cyclic rate is never perfectly repeatable.
  const unlock = modes(seconds(0.05, fs), fs, [
    { f: 1180, tau: 0.011, amp: 1 },
    { f: 2360, tau: 0.007, amp: 0.6 },
    { f: 4150, tau: 0.004, amp: 0.35 },
  ], rng);
  applyEnv(unlock, percussive(unlock.length, fs, { attack: 0.0002, tau: 0.012 }));
  mixInto(out, unlock, 0.16, seconds(0.013 * rng.range(0.8, 1.2), fs));

  const carrier = modes(seconds(0.08, fs), fs, [
    { f: 620, tau: 0.03, amp: 1 },
    { f: 1450, tau: 0.018, amp: 0.5 },
    { f: 3100, tau: 0.008, amp: 0.28 },
  ], rng);
  applyEnv(carrier, percussive(carrier.length, fs, { attack: 0.0003, tau: 0.028 }));
  mixInto(out, carrier, 0.12, seconds(0.04 * rng.range(0.85, 1.15), fs));

  // Near-field tail: the first few metres of reflected energy. Kept short and
  // quiet so the runtime reverb is what defines the space.
  const tail = noiseHit(seconds(0.3, fs), fs, rng, {
    f0: 5200,
    f1: 1100,
    sweepTau: 0.08,
    q: 0.6,
    mode: 'lp',
    attack: 0.006,
    tau: 0.1,
    pink: true,
  });
  mixInto(out, tail, 0.16);

  dcBlock(out, fs, 28);
  // 12dB/oct at 55Hz: below this there is nothing but headroom cost.
  highpass(out, fs, 55, 0.7071, 2);
  peaking(out, fs, 155, 1.0, 2.5);
  // Slight cut where layered noise piles up and turns boxy.
  peaking(out, fs, 780, 1.2, -3);
  highshelf(out, fs, 6000, 0.7071, 4);
  saturate(out, 1.25, 0.12);
  normalize(out, 0.97);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

/**
 * Distant-perspective report, crossfaded in by distance at runtime.
 *
 * At range the direct shock front is largely absorbed by air (which is a
 * lowpass increasing with distance) and what survives is the reflected tail.
 * The result is a dull thump followed by a long slap-and-diffusion decay,
 * which is exactly why distant gunfire in games sounds wrong when it is just
 * a quieter close shot.
 */
function rifleDistant(rng, fs) {
  const n = seconds(1.25, fs);
  const out = alloc(n);

  const thump = noiseHit(seconds(0.2, fs), fs, rng, {
    f0: 750 * rng.detune(0.12),
    f1: 210,
    sweepTau: 0.03,
    q: 0.85,
    mode: 'lp',
    attack: 0.0015,
    tau: 0.055 * rng.range(0.85, 1.2),
  });
  saturate(thump, 1.6, 0.2);
  mixInto(out, thump, 1);

  // What is left of the crack: still present, but 20dB down and dark.
  const residual = noiseHit(seconds(0.06, fs), fs, rng, {
    f0: 3200,
    f1: 1600,
    sweepTau: 0.01,
    q: 0.7,
    mode: 'bp',
    attack: 0.0002,
    tau: 0.006,
  });
  mixInto(out, residual, 0.22);

  mixInto(out, subSweep(seconds(0.35, fs), fs, 120, 42, 0.03, 0.1), 0.35);

  // Tail by convolution with a wide-outdoor impulse: discrete slapbacks off
  // hard surfaces followed by diffusion. Synthesising this additively never
  // gets the density right; convolution does it for free.
  const ir = roomIr(fs, rng, {
    rt60: 0.95 * rng.range(0.85, 1.2),
    predelayMs: 22,
    erCount: 14,
    erSpanMs: 260,
    erGain: 0.5,
    hfStart: 4200,
    hfEnd: 480,
    damping: 0.18,
    seedGain: 0.5,
  });
  const exciter = noiseHit(seconds(0.03, fs), fs, rng, {
    f0: 1800,
    f1: 500,
    sweepTau: 0.008,
    q: 0.8,
    mode: 'lp',
    attack: 0.0006,
    tau: 0.012,
  });
  const tail = convolve(exciter, ir);
  normalize(tail, 1);
  mixInto(out, tail, 0.55);

  dcBlock(out, fs, 30);
  highpass(out, fs, 55, 0.7071);
  // Air absorption over a few hundred metres: everything above ~6kHz is gone.
  lowpass(out, fs, 6200, 0.7071, 2);
  peaking(out, fs, 190, 0.9, 2.5);
  normalize(out, 0.92);
  return { data: fadeEdges(trimTail(out, fs), fs, 0.2, 25), fs };
}

// -- weapon: mechanical ------------------------------------------------------

function dryFire(rng, fs) {
  const n = seconds(0.16, fs);
  const out = alloc(n);
  // Sear release: tiny, very bright, almost no body.
  const sear = noiseHit(seconds(0.02, fs), fs, rng, {
    f0: 5200,
    f1: 3000,
    sweepTau: 0.003,
    q: 1.4,
    mode: 'bp',
    attack: 0.00005,
    tau: 0.0022,
  });
  mixInto(out, sear, 0.55);
  // Hammer striking an empty chamber: hollow because nothing fires.
  const hammer = modes(seconds(0.1, fs), fs, [
    { f: 940, tau: 0.02, amp: 1 },
    { f: 1980, tau: 0.012, amp: 0.55 },
    { f: 3700, tau: 0.006, amp: 0.3 },
    { f: 6400, tau: 0.003, amp: 0.18 },
  ], rng);
  applyEnv(hammer, percussive(hammer.length, fs, { attack: 0.0001, tau: 0.018 }));
  mixInto(out, hammer, 0.9, seconds(0.004, fs));
  highpass(out, fs, 220, 0.7071);
  normalize(out, 0.85);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

function magOut(rng, fs) {
  const n = seconds(0.42, fs);
  const out = alloc(n);
  // Magazine catch.
  const latch = modes(seconds(0.04, fs), fs, [
    { f: 3200, tau: 0.005, amp: 1 },
    { f: 5400, tau: 0.003, amp: 0.5 },
  ], rng);
  applyEnv(latch, percussive(latch.length, fs, { attack: 0.00005, tau: 0.004 }));
  mixInto(out, latch, 0.7);

  // Polymer body dragging out of the well: broadband friction, granular.
  const dragLen = seconds(0.13, fs);
  const drag = svf(whiteNoise(dragLen, rng), fs, sweep(2600, 1100, 0.05, fs), 1.1, 'bp');
  applyEnv(drag, grains(dragLen, fs, rng, { rate: 300, grainMs: 6, jitter: 0.8, floor: 0.25 }));
  applyEnv(drag, percussive(dragLen, fs, { attack: 0.004, tau: 0.06, shape: 1.6 }));
  mixInto(out, drag, 0.38, seconds(0.02, fs));

  // Magazine clearing the well and swinging free.
  const clear = modes(seconds(0.12, fs), fs, [
    { f: 420, tau: 0.035, amp: 1 },
    { f: 1150, tau: 0.02, amp: 0.45 },
    { f: 2600, tau: 0.008, amp: 0.25 },
  ], rng);
  applyEnv(clear, percussive(clear.length, fs, { attack: 0.0004, tau: 0.03 }));
  mixInto(out, clear, 0.5, seconds(0.15, fs));

  highpass(out, fs, 160, 0.7071);
  normalize(out, 0.85);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

function magIn(rng, fs) {
  const n = seconds(0.42, fs);
  const out = alloc(n);
  // Approach: hand and magazine brushing the receiver.
  const approach = svf(pinkNoise(seconds(0.09, fs), rng), fs, sweep(1800, 700, 0.04, fs), 0.9, 'bp');
  applyEnv(approach, percussive(approach.length, fs, { attack: 0.012, tau: 0.03, shape: 1.8 }));
  mixInto(out, approach, 0.28);

  // Seating clunk: heavy, low, the loudest part of a reload.
  const seat = modes(seconds(0.18, fs), fs, [
    { f: 300, tau: 0.055, amp: 1 },
    { f: 640, tau: 0.035, amp: 0.6 },
    { f: 1320, tau: 0.018, amp: 0.4 },
    { f: 2900, tau: 0.007, amp: 0.22 },
  ], rng);
  applyEnv(seat, percussive(seat.length, fs, { attack: 0.0003, tau: 0.045 }));
  saturate(seat, 1.5, 0.2);
  mixInto(out, seat, 1, seconds(0.085, fs));
  mixInto(out, subSweep(seconds(0.12, fs), fs, 130, 70, 0.02, 0.04), 0.25, seconds(0.085, fs));

  // Catch snapping over the mag body, a few ms after the seat.
  const catchClick = noiseHit(seconds(0.03, fs), fs, rng, {
    f0: 4300,
    f1: 2600,
    sweepTau: 0.004,
    q: 1.5,
    mode: 'bp',
    attack: 0.00005,
    tau: 0.0035,
  });
  mixInto(out, catchClick, 0.45, seconds(0.11, fs));

  highpass(out, fs, 90, 0.7071);
  normalize(out, 0.9);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

function chargePull(rng, fs) {
  const n = seconds(0.3, fs);
  const out = alloc(n);
  // Friction of the carrier on its rails: a rising bandpass because the
  // contact area shrinks and the rattle brightens as it accelerates.
  const len = seconds(0.13, fs);
  const scrape = svf(whiteNoise(len, rng), fs, sweep(900, 3000, 0.06, fs), 2.2, 'bp');
  applyEnv(scrape, grains(len, fs, rng, { rate: 420, grainMs: 4, jitter: 0.9, floor: 0.3 }));
  applyEnv(scrape, percussive(len, fs, { attack: 0.006, tau: 0.09, shape: 2 }));
  mixInto(out, scrape, 0.55);

  // Carrier bottoming out at the rear of its travel.
  const stop = modes(seconds(0.09, fs), fs, [
    { f: 560, tau: 0.022, amp: 1 },
    { f: 1300, tau: 0.013, amp: 0.5 },
    { f: 2750, tau: 0.006, amp: 0.3 },
  ], rng);
  applyEnv(stop, percussive(stop.length, fs, { attack: 0.0002, tau: 0.02 }));
  mixInto(out, stop, 0.8, seconds(0.115, fs));

  highpass(out, fs, 180, 0.7071);
  normalize(out, 0.85);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

function chargeRelease(rng, fs) {
  const n = seconds(0.3, fs);
  const out = alloc(n);
  // Spring-driven forward slam: louder and lower than the pull, with a
  // recoil-spring ring on top.
  const slam = modes(seconds(0.16, fs), fs, [
    { f: 380, tau: 0.04, amp: 1 },
    { f: 810, tau: 0.026, amp: 0.65 },
    { f: 1640, tau: 0.014, amp: 0.42 },
    { f: 3400, tau: 0.006, amp: 0.25 },
  ], rng);
  applyEnv(slam, percussive(slam.length, fs, { attack: 0.0002, tau: 0.033 }));
  saturate(slam, 1.8, 0.25);
  mixInto(out, slam, 1);

  const spring = dampedSine(seconds(0.2, fs), fs, 5300 * rng.detune(0.06), 0.03, 1, 0, -0.35);
  applyEnv(spring, percussive(spring.length, fs, { attack: 0.0006, tau: 0.035 }));
  mixInto(out, spring, 0.12, seconds(0.002, fs));

  const click = noiseHit(seconds(0.02, fs), fs, rng, {
    f0: 4800,
    f1: 3000,
    sweepTau: 0.003,
    q: 1.2,
    mode: 'bp',
    attack: 0.00004,
    tau: 0.002,
  });
  mixInto(out, click, 0.5);

  highpass(out, fs, 140, 0.7071);
  normalize(out, 0.9);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

/** Gear and fabric movement for the sight transition. Deliberately soft. */
function adsMove(rng, fs, up) {
  const n = seconds(0.26, fs);
  const out = alloc(n);
  const len = seconds(0.16, fs);
  const cloth = svf(
    pinkNoise(len, rng),
    fs,
    sweep(up ? 900 : 700, up ? 2200 : 1500, 0.06, fs),
    0.8,
    'bp'
  );
  applyEnv(cloth, grains(len, fs, rng, { rate: 130, grainMs: 18, jitter: 0.9, floor: 0.4 }));
  applyEnv(cloth, percussive(len, fs, { attack: 0.02, tau: 0.05, shape: 2.2 }));
  mixInto(out, cloth, 0.6);

  const tick = modes(seconds(0.04, fs), fs, [
    { f: 2600, tau: 0.006, amp: 1 },
    { f: 4900, tau: 0.003, amp: 0.4 },
  ], rng);
  applyEnv(tick, percussive(tick.length, fs, { attack: 0.0001, tau: 0.005 }));
  mixInto(out, tick, up ? 0.3 : 0.2, seconds(up ? 0.075 : 0.05, fs));

  highpass(out, fs, 250, 0.7071);
  normalize(out, 0.6);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

// -- impacts -----------------------------------------------------------------

/**
 * Per-surface impact response.
 *
 * Every impact shares a bright arrival transient (the round itself, identical
 * regardless of what it hits) plus a material-specific body. Splitting it
 * this way is what keeps twenty different impacts sounding like one weapon
 * hitting twenty things rather than twenty unrelated noises.
 */
const IMPACTS = {
  concrete: (out, fs, rng) => {
    mixInto(out, noiseHit(seconds(0.06, fs), fs, rng, {
      f0: 3400, f1: 1600, sweepTau: 0.006, q: 1.1, mode: 'bp', attack: 0.00005, tau: 0.008,
    }), 0.9);
    // Spall and dust: broadband, no pitch, decaying fast.
    const spall = noiseHit(seconds(0.16, fs), fs, rng, {
      f0: 5000, f1: 900, sweepTau: 0.04, q: 0.65, mode: 'lp', attack: 0.0006, tau: 0.045,
    });
    mixInto(out, spall, 0.55);
    mixInto(out, subSweep(seconds(0.1, fs), fs, 175, 100, 0.012, 0.028), 0.22);
    // Loose grit landing a few tens of ms later.
    const grit = svf(whiteNoise(seconds(0.16, fs), rng), fs, () => 4200, 1.4, 'bp');
    applyEnv(grit, grains(grit.length, fs, rng, { rate: 90, grainMs: 3, jitter: 1, floor: 0 }));
    applyEnv(grit, percussive(grit.length, fs, { attack: 0.01, tau: 0.06, shape: 2 }));
    mixInto(out, grit, 0.22, seconds(0.03, fs));
  },

  metal: (out, fs, rng) => {
    mixInto(out, noiseHit(seconds(0.05, fs), fs, rng, {
      f0: 6000, f1: 3000, sweepTau: 0.004, q: 1.2, mode: 'bp', attack: 0.00004, tau: 0.005,
    }), 0.8);
    // Inharmonic, long-decaying modes: a thin steel panel, not a bell. The
    // spread is wide (8%) because a container wall, a barrel and a stair
    // tread should not ring at the same pitch; 2% left the variants
    // measurably identical.
    const ring = modes(seconds(0.5, fs), fs, [
      { f: 520, tau: 0.11, amp: 0.55, spread: 0.09 },
      { f: 1180, tau: 0.2, amp: 1, drift: -0.03, spread: 0.08 },
      { f: 2270, tau: 0.15, amp: 0.7, drift: -0.02, spread: 0.08 },
      { f: 3460, tau: 0.1, amp: 0.5, spread: 0.07 },
      { f: 5180, tau: 0.065, amp: 0.35, spread: 0.06 },
      { f: 7400, tau: 0.04, amp: 0.22, spread: 0.06 },
    ], rng);
    applyEnv(ring, percussive(ring.length, fs, { attack: 0.0002, tau: 0.16 * rng.range(0.7, 1.3), shape: 1.2 }));
    mixInto(out, ring, 0.75);
    mixInto(out, subSweep(seconds(0.08, fs), fs, 240, 140, 0.01, 0.022), 0.16);
  },

  wood: (out, fs, rng) => {
    mixInto(out, noiseHit(seconds(0.06, fs), fs, rng, {
      f0: 3600, f1: 1400, sweepTau: 0.006, q: 0.9, mode: 'bp', attack: 0.00006, tau: 0.009,
    }), 1.15);
    // Low, fast-decaying modes: wood is heavily damped and inharmonic.
    const body = modes(seconds(0.2, fs), fs, [
      { f: 250, tau: 0.07, amp: 1, spread: 0.07 },
      { f: 470, tau: 0.045, amp: 0.6, spread: 0.07 },
      { f: 910, tau: 0.028, amp: 0.42, spread: 0.06 },
      { f: 1750, tau: 0.014, amp: 0.25, spread: 0.06 },
    ], rng);
    applyEnv(body, percussive(body.length, fs, { attack: 0.0003, tau: 0.055 * rng.range(0.8, 1.2) }));
    mixInto(out, body, 0.62);
    // Splinters.
    const splinter = svf(whiteNoise(seconds(0.14, fs), rng), fs, () => 3400, 1.3, 'bp');
    applyEnv(splinter, grains(splinter.length, fs, rng, { rate: 160, grainMs: 3, jitter: 1, floor: 0 }));
    applyEnv(splinter, percussive(splinter.length, fs, { attack: 0.002, tau: 0.04 }));
    mixInto(out, splinter, 0.55);
    lowpass(out, fs, 11000, 0.7071);
  },

  dirt: (out, fs, rng) => {
    mixInto(out, noiseHit(seconds(0.04, fs), fs, rng, {
      f0: 2200, f1: 900, sweepTau: 0.005, q: 0.9, mode: 'bp', attack: 0.0002, tau: 0.006,
    }), 0.35);
    const puff = noiseHit(seconds(0.16, fs), fs, rng, {
      f0: 1500, f1: 350, sweepTau: 0.03, q: 0.7, mode: 'lp', attack: 0.0015, tau: 0.05,
    });
    mixInto(out, puff, 1);
    mixInto(out, subSweep(seconds(0.1, fs), fs, 150, 88, 0.018, 0.03), 0.22);
    const debris = svf(whiteNoise(seconds(0.18, fs), rng), fs, () => 2400, 1.2, 'bp');
    applyEnv(debris, grains(debris.length, fs, rng, { rate: 70, grainMs: 5, jitter: 1, floor: 0 }));
    applyEnv(debris, percussive(debris.length, fs, { attack: 0.012, tau: 0.06, shape: 2 }));
    mixInto(out, debris, 0.25, seconds(0.025, fs));
  },

  sand: (out, fs, rng) => {
    const puff = noiseHit(seconds(0.14, fs), fs, rng, {
      f0: 4200, f1: 1400, sweepTau: 0.025, q: 0.6, mode: 'bp', attack: 0.001, tau: 0.038,
    });
    mixInto(out, puff, 1);
    // Sand has effectively no resonant body, only a hiss and a soft thud.
    mixInto(out, subSweep(seconds(0.07, fs), fs, 95, 62, 0.015, 0.024), 0.18);
    lowpass(out, fs, 9000, 0.7071);
  },

  glass: (out, fs, rng) => {
    mixInto(out, noiseHit(seconds(0.04, fs), fs, rng, {
      f0: 7000, f1: 4000, sweepTau: 0.003, q: 1.3, mode: 'bp', attack: 0.00003, tau: 0.004,
    }), 0.85);
    const plate = modes(seconds(0.3, fs), fs, [
      { f: 2950, tau: 0.09, amp: 1, spread: 0.07 },
      { f: 4380, tau: 0.06, amp: 0.7, spread: 0.07 },
      { f: 1560, tau: 0.05, amp: 0.42, spread: 0.08 },
      { f: 6120, tau: 0.04, amp: 0.5, spread: 0.06 },
      { f: 8300, tau: 0.025, amp: 0.32, spread: 0.06 },
    ], rng);
    applyEnv(plate, percussive(plate.length, fs, { attack: 0.0001, tau: 0.07 * rng.range(0.8, 1.25) }));
    mixInto(out, plate, 0.6);
    // Pane flex: a bullet hole in glass has a low, brief body under the
    // brightness, without which it sounds like a wind chime.
    const flex = modes(seconds(0.14, fs), fs, [
      { f: 380, tau: 0.03, amp: 1, spread: 0.08 },
      { f: 760, tau: 0.02, amp: 0.5, spread: 0.08 },
    ], rng);
    applyEnv(flex, percussive(flex.length, fs, { attack: 0.0004, tau: 0.025 }));
    mixInto(out, flex, 0.28);
    // Shards falling: a handful of independent short high pings.
    for (let k = 0; k < 9; k++) {
      const t = rng.range(0.03, 0.34);
      const shard = modes(seconds(0.06, fs), fs, [
        { f: rng.range(3200, 9000), tau: rng.range(0.008, 0.025), amp: 1 },
      ], rng);
      applyEnv(shard, percussive(shard.length, fs, { attack: 0.0001, tau: 0.012 }));
      mixInto(out, shard, rng.range(0.05, 0.2), seconds(t, fs));
    }
    highpass(out, fs, 260, 0.7071);
  },

  water: (out, fs, rng) => {
    // Rising sine: a collapsing cavity's resonant frequency climbs as it
    // shrinks. This upward glide is the entire identity of a water plop.
    const bubble = alloc(seconds(0.12, fs));
    let ph = 0;
    for (let i = 0; i < bubble.length; i++) {
      const f = 780 - 520 * Math.exp(-i / fs / 0.028);
      ph += (TAU * f) / fs;
      bubble[i] = Math.sin(ph);
    }
    applyEnv(bubble, percussive(bubble.length, fs, { attack: 0.001, tau: 0.035 }));
    mixInto(out, bubble, 0.55);
    const splash = noiseHit(seconds(0.25, fs), fs, rng, {
      f0: 5200, f1: 1200, sweepTau: 0.05, q: 0.6, mode: 'bp', attack: 0.0008, tau: 0.07, shape: 1.3,
    });
    mixInto(out, splash, 0.8);
    // Droplets.
    for (let k = 0; k < 5; k++) {
      const drop = modes(seconds(0.04, fs), fs, [{ f: rng.range(1400, 3600), tau: 0.006, amp: 1 }], rng);
      applyEnv(drop, percussive(drop.length, fs, { attack: 0.0003, tau: 0.005 }));
      mixInto(out, drop, rng.range(0.04, 0.11), seconds(rng.range(0.08, 0.26), fs));
    }
  },

  fabric: (out, fs, rng) => {
    const thud = noiseHit(seconds(0.14, fs), fs, rng, {
      f0: 900, f1: 260, sweepTau: 0.02, q: 0.7, mode: 'lp', attack: 0.001, tau: 0.04,
    });
    mixInto(out, thud, 1);
    const tear = noiseHit(seconds(0.1, fs), fs, rng, {
      f0: 2800, f1: 1600, sweepTau: 0.02, q: 0.9, mode: 'bp', attack: 0.0008, tau: 0.02,
    });
    mixInto(out, tear, 0.22);
    mixInto(out, subSweep(seconds(0.09, fs), fs, 145, 88, 0.018, 0.026), 0.16);
    lowpass(out, fs, 5000, 0.7071);
  },

  foliage: (out, fs, rng) => {
    const len = seconds(0.28, fs);
    const rustle = svf(whiteNoise(len, rng), fs, sweep(5200, 2200, 0.09, fs), 1.1, 'bp');
    applyEnv(rustle, grains(len, fs, rng, { rate: 190, grainMs: 5, jitter: 1, floor: 0.05 }));
    applyEnv(rustle, percussive(len, fs, { attack: 0.0015, tau: 0.075, shape: 1.4 }));
    mixInto(out, rustle, 1);
    // A single stem snapping.
    const snap = noiseHit(seconds(0.03, fs), fs, rng, {
      f0: 3800, f1: 2200, sweepTau: 0.004, q: 1.4, mode: 'bp', attack: 0.00006, tau: 0.004,
    });
    mixInto(out, snap, 0.4);
    highpass(out, fs, 500, 0.7071);
  },

  flesh: (out, fs, rng) => {
    // Wet slap plus a short low thump: damped, no ring, everything gone in
    // under 100ms. Anything longer reads as comic.
    mixInto(out, subSweep(seconds(0.1, fs), fs, 205, 105, 0.011, 0.026), 0.42);
    const wet = noiseHit(seconds(0.1, fs), fs, rng, {
      f0: 1900, f1: 460, sweepTau: 0.018, q: 0.85, mode: 'bp', attack: 0.0004, tau: 0.032,
    });
    saturate(wet, 1.8, 0.3);
    mixInto(out, wet, 1);
    const slap = noiseHit(seconds(0.035, fs), fs, rng, {
      f0: 4200, f1: 2200, sweepTau: 0.005, q: 1, mode: 'bp', attack: 0.00006, tau: 0.006,
    });
    mixInto(out, slap, 0.55);
    lowpass(out, fs, 7000, 0.7071);
  },
};

function impact(surface) {
  return (rng, fs) => {
    const out = alloc(seconds(0.55, fs));
    IMPACTS[surface](out, fs, rng);
    dcBlock(out, fs, 30);
    highpass(out, fs, 55, 0.7071);
    normalize(out, 0.94);
    return { data: fadeEdges(trimTail(out, fs), fs), fs };
  };
}

// -- footsteps ---------------------------------------------------------------

/**
 * Footsteps are a heel transient plus a surface body plus a scuff. Only the
 * relative weighting of those three changes between surfaces, which keeps
 * them coherent as a set; the runtime adds pitch and gain variation on top.
 */
const FOOTSTEPS = {
  concrete: (out, fs, rng) => {
    // The heel is the loudest part of a boot on concrete. It was previously
    // buried under the sub, which pushed the attack out past 2ms and made the
    // step read as a distant thud rather than a footfall next to the player.
    mixInto(out, noiseHit(seconds(0.05, fs), fs, rng, {
      f0: 3400, f1: 1500, sweepTau: 0.006, q: 0.9, mode: 'bp', attack: 0.0001, tau: 0.009,
    }), 1.35);
    mixInto(out, noiseHit(seconds(0.1, fs), fs, rng, {
      f0: 1600, f1: 430, sweepTau: 0.02, q: 0.7, mode: 'lp', attack: 0.0008, tau: 0.03,
    }), 0.65);
    mixInto(out, subSweep(seconds(0.09, fs), fs, 185, 108, 0.015, 0.03), 0.2);
  },
  metal: (out, fs, rng) => {
    mixInto(out, noiseHit(seconds(0.04, fs), fs, rng, {
      f0: 4600, f1: 2400, sweepTau: 0.005, q: 1, mode: 'bp', attack: 0.0001, tau: 0.007,
    }), 0.85);
    const plate = modes(seconds(0.22, fs), fs, [
      { f: 470, tau: 0.055, amp: 0.5, spread: 0.08 },
      { f: 870, tau: 0.075, amp: 1, spread: 0.07 },
      { f: 1490, tau: 0.055, amp: 0.6, spread: 0.07 },
      { f: 2410, tau: 0.035, amp: 0.42, spread: 0.06 },
      { f: 3720, tau: 0.02, amp: 0.25, spread: 0.06 },
    ], rng);
    applyEnv(plate, percussive(plate.length, fs, { attack: 0.0003, tau: 0.06 * rng.range(0.8, 1.25) }));
    mixInto(out, plate, 0.8);
    mixInto(out, subSweep(seconds(0.08, fs), fs, 170, 105, 0.014, 0.026), 0.2);
  },
  wood: (out, fs, rng) => {
    mixInto(out, noiseHit(seconds(0.05, fs), fs, rng, {
      f0: 3000, f1: 1300, sweepTau: 0.005, q: 0.75, mode: 'bp', attack: 0.0002, tau: 0.009,
    }), 1.4);
    // A boxed-in air volume under the planks: two low modes, quickly damped.
    const hollow = modes(seconds(0.2, fs), fs, [
      { f: 178, tau: 0.075, amp: 1, spread: 0.06 },
      { f: 336, tau: 0.05, amp: 0.55, spread: 0.06 },
      { f: 520, tau: 0.035, amp: 0.45, spread: 0.06 },
      { f: 720, tau: 0.025, amp: 0.4, spread: 0.05 },
      { f: 1290, tau: 0.014, amp: 0.22, spread: 0.05 },
    ], rng);
    applyEnv(hollow, percussive(hollow.length, fs, { attack: 0.0006, tau: 0.055 * rng.range(0.8, 1.2) }));
    mixInto(out, hollow, 0.7);
    lowpass(out, fs, 9000, 0.7071);
  },
  dirt: (out, fs, rng) => {
    const len = seconds(0.14, fs);
    const crunch = svf(whiteNoise(len, rng), fs, sweep(3000, 600, 0.03, fs), 0.7, 'bp');
    applyEnv(crunch, grains(len, fs, rng, { rate: 260, grainMs: 4, jitter: 1, floor: 0.1 }));
    applyEnv(crunch, percussive(len, fs, { attack: 0.0008, tau: 0.035 }));
    mixInto(out, crunch, 0.9);
    mixInto(out, subSweep(seconds(0.09, fs), fs, 150, 90, 0.016, 0.028), 0.3);
  },
  sand: (out, fs, rng) => {
    const shh = noiseHit(seconds(0.16, fs), fs, rng, {
      f0: 3800, f1: 1500, sweepTau: 0.035, q: 0.6, mode: 'bp', attack: 0.004, tau: 0.045, shape: 1.5,
    });
    mixInto(out, shh, 1);
    mixInto(out, subSweep(seconds(0.07, fs), fs, 135, 84, 0.016, 0.022), 0.2);
  },
  water: (out, fs, rng) => {
    const splash = noiseHit(seconds(0.2, fs), fs, rng, {
      f0: 4600, f1: 1100, sweepTau: 0.04, q: 0.6, mode: 'bp', attack: 0.0015, tau: 0.055, shape: 1.3,
    });
    mixInto(out, splash, 1);
    const bubble = alloc(seconds(0.09, fs));
    let ph = 0;
    for (let i = 0; i < bubble.length; i++) {
      const f = 620 - 340 * Math.exp(-i / fs / 0.03);
      ph += (TAU * f) / fs;
      bubble[i] = Math.sin(ph);
    }
    applyEnv(bubble, percussive(bubble.length, fs, { attack: 0.002, tau: 0.03 }));
    mixInto(out, bubble, 0.3, seconds(0.01, fs));
  },
  foliage: (out, fs, rng) => {
    const len = seconds(0.22, fs);
    const rustle = svf(whiteNoise(len, rng), fs, sweep(4800, 2000, 0.07, fs), 1.1, 'bp');
    applyEnv(rustle, grains(len, fs, rng, { rate: 170, grainMs: 6, jitter: 1, floor: 0.08 }));
    applyEnv(rustle, percussive(len, fs, { attack: 0.002, tau: 0.06, shape: 1.5 }));
    mixInto(out, rustle, 1);
    mixInto(out, subSweep(seconds(0.07, fs), fs, 140, 88, 0.016, 0.024), 0.2);
  },
};

function footstep(surface) {
  return (rng, fs) => {
    const out = alloc(seconds(0.3, fs));
    FOOTSTEPS[surface](out, fs, rng);
    dcBlock(out, fs, 35);
    highpass(out, fs, 60, 0.7071);
    // Footsteps sit under everything else; a gentle presence dip keeps them
    // from competing with gunfire for the same band.
    peaking(out, fs, 2600, 1.0, -1);
    normalize(out, 0.9);
    return { data: fadeEdges(trimTail(out, fs), fs), fs };
  };
}

// -- shells ------------------------------------------------------------------

/**
 * Brass on concrete: a bounce train. Intervals shrink geometrically with the
 * coefficient of restitution, each contact is shorter and therefore brighter,
 * and the whole thing is tiny and very high-passed.
 */
function shellBounce(rng, fs) {
  const out = alloc(seconds(0.7, fs));
  let t = rng.range(0.0, 0.02);
  let gain = 1;
  let interval = rng.range(0.075, 0.115);
  const restitution = rng.range(0.55, 0.68);
  const pitch = rng.detune(0.12);

  for (let b = 0; b < 6 && gain > 0.03; b++) {
    const tighten = 1 + b * 0.14;
    const ring = modes(seconds(0.12, fs), fs, [
      { f: 3150 * pitch * tighten, tau: 0.035 / tighten, amp: 1 },
      { f: 4720 * pitch * tighten, tau: 0.026 / tighten, amp: 0.65 },
      { f: 6280 * pitch, tau: 0.018 / tighten, amp: 0.45 },
      { f: 8410 * pitch, tau: 0.011 / tighten, amp: 0.3 },
    ], rng);
    applyEnv(ring, percussive(ring.length, fs, { attack: 0.00006, tau: 0.028 / tighten }));
    mixInto(out, ring, gain, seconds(t, fs));

    const tick = noiseHit(seconds(0.015, fs), fs, rng, {
      f0: 7000, f1: 4500, sweepTau: 0.002, q: 1.4, mode: 'bp', attack: 0.00003, tau: 0.0015,
    });
    mixInto(out, tick, gain * 0.35, seconds(t, fs));

    t += interval;
    interval *= restitution;
    gain *= rng.range(0.42, 0.58);
  }
  highpass(out, fs, 1200, 0.7071, 2);
  normalize(out, 0.7);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

// -- ui ----------------------------------------------------------------------

/**
 * Hitmarkers are pure information, not simulation. They are short, dry,
 * centred and pitched well above the gunfire band so they cut through a
 * firefight; the headshot variant is a fifth higher with a second tick.
 */
function hitTick(rng, fs, { f, bright, double = 0, body = 0 }) {
  const out = alloc(seconds(double ? 0.16 : 0.09, fs));
  const one = (offset, gain, pitch) => {
    // A wide, short click on top of the tone. The tone alone is a single
    // narrow partial that vanishes underneath sustained fire; the click is
    // what makes the marker legible mid-firefight.
    const click = noiseHit(seconds(0.014, fs), fs, rng, {
      f0: bright, f1: bright * 0.5, sweepTau: 0.0025, q: 0.6, mode: 'bp', attack: 0.00003, tau: 0.0022,
    });
    mixInto(out, click, 1.15 * gain, seconds(offset, fs));
    const ping = modes(seconds(0.06, fs), fs, [
      { f: f * pitch, tau: 0.016, amp: 1, spread: 0 },
      { f: f * pitch * 2.01, tau: 0.008, amp: 0.35, spread: 0 },
    ], { detune: () => 1, next: () => 0, chance: () => false, range: () => 0 });
    applyEnv(ping, percussive(ping.length, fs, { attack: 0.0002, tau: 0.014 }));
    mixInto(out, ping, 0.8 * gain, seconds(offset, fs));
  };
  one(0, 1, 1);
  if (double) one(double, 0.75, 0.72);
  if (body) {
    const low = modes(seconds(0.12, fs), fs, [{ f: body, tau: 0.03, amp: 1, spread: 0 }], null);
    applyEnv(low, percussive(low.length, fs, { attack: 0.0006, tau: 0.028 }));
    mixInto(out, low, 0.35);
  }
  highpass(out, fs, 300, 0.7071);
  normalize(out, 0.8);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

// -- player ------------------------------------------------------------------

function land(rng, fs, hard) {
  const out = alloc(seconds(0.5, fs));
  // Boot on concrete: the same components as a footstep, scaled up, with a
  // deeper and longer sub because the whole body mass is decelerating.
  mixInto(out, noiseHit(seconds(0.08, fs), fs, rng, {
    f0: hard ? 4200 : 3000, f1: 1300, sweepTau: 0.008, q: 0.85, mode: 'bp', attack: 0.0001, tau: hard ? 0.014 : 0.009,
  }), hard ? 1.5 : 0.9);
  mixInto(out, noiseHit(seconds(0.2, fs), fs, rng, {
    f0: 1800, f1: 320, sweepTau: 0.03, q: 0.7, mode: 'lp', attack: 0.0008, tau: hard ? 0.06 : 0.035,
  }), hard ? 1.1 : 0.75);
  // Landing sub is held above 70Hz for the same reason as the muzzle blast:
  // below that it is peak-meter weight the player cannot hear.
  const sub = subSweep(seconds(0.3, fs), fs, hard ? 165 : 175, hard ? 74 : 96, 0.025, hard ? 0.08 : 0.045);
  if (hard) saturate(sub, 1.6, 0.25);
  mixInto(out, sub, hard ? 0.55 : 0.32);

  // Gear rattle: sling hardware and magazines, a few short metallic ticks.
  const rattleCount = hard ? 5 : 3;
  for (let k = 0; k < rattleCount; k++) {
    const tick = modes(seconds(0.06, fs), fs, [
      { f: rng.range(1800, 5200), tau: rng.range(0.006, 0.018), amp: 1 },
    ], rng);
    applyEnv(tick, percussive(tick.length, fs, { attack: 0.0002, tau: 0.008 }));
    mixInto(out, tick, rng.range(0.05, hard ? 0.18 : 0.1), seconds(rng.range(0.01, 0.14), fs));
  }
  // Cloth.
  const cloth = svf(pinkNoise(seconds(0.18, fs), rng), fs, sweep(1600, 600, 0.05, fs), 0.8, 'bp');
  applyEnv(cloth, percussive(cloth.length, fs, { attack: 0.004, tau: 0.05, shape: 1.6 }));
  mixInto(out, cloth, hard ? 0.28 : 0.18);

  dcBlock(out, fs, 26);
  highpass(out, fs, 40, 0.7071);
  normalize(out, hard ? 0.96 : 0.75);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

function jumpEffort(rng, fs) {
  const out = alloc(seconds(0.3, fs));
  const cloth = svf(pinkNoise(seconds(0.16, fs), rng), fs, sweep(700, 2000, 0.05, fs), 0.8, 'bp');
  applyEnv(cloth, grains(cloth.length, fs, rng, { rate: 120, grainMs: 16, jitter: 0.9, floor: 0.35 }));
  applyEnv(cloth, percussive(cloth.length, fs, { attack: 0.008, tau: 0.05, shape: 1.8 }));
  mixInto(out, cloth, 0.7);
  for (let k = 0; k < 2; k++) {
    const tick = modes(seconds(0.05, fs), fs, [
      { f: rng.range(2200, 4800), tau: rng.range(0.005, 0.012), amp: 1 },
    ], rng);
    applyEnv(tick, percussive(tick.length, fs, { attack: 0.0002, tau: 0.006 }));
    mixInto(out, tick, rng.range(0.05, 0.14), seconds(rng.range(0.005, 0.07), fs));
  }
  highpass(out, fs, 300, 0.7071);
  normalize(out, 0.5);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

/**
 * Taking a round: a body thump for the impact, a bright sting for the pain
 * cue, and a brief high ring standing in for the adrenaline/tinnitus response
 * that shooters use to sell damage without a voice line.
 */
function playerHurt(rng, fs) {
  const out = alloc(seconds(0.6, fs));
  mixInto(out, subSweep(seconds(0.2, fs), fs, 175, 90, 0.018, 0.05), 0.5);
  const thump = noiseHit(seconds(0.15, fs), fs, rng, {
    f0: 1900, f1: 340, sweepTau: 0.02, q: 0.75, mode: 'lp', attack: 0.0006, tau: 0.045,
  });
  saturate(thump, 1.7, 0.25);
  mixInto(out, thump, 1.1);
  const sting = noiseHit(seconds(0.12, fs), fs, rng, {
    f0: 4200, f1: 2400, sweepTau: 0.02, q: 1, mode: 'bp', attack: 0.0004, tau: 0.03,
  });
  mixInto(out, sting, 0.55);
  const ring = dampedSine(seconds(0.45, fs), fs, 3100, 0.16, 1, 0, -0.02);
  applyEnv(ring, percussive(ring.length, fs, { attack: 0.006, tau: 0.14 }));
  mixInto(out, ring, 0.09);
  dcBlock(out, fs, 26);
  highpass(out, fs, 45, 0.7071);
  normalize(out, 0.9);
  return { data: fadeEdges(trimTail(out, fs), fs), fs };
}

// -- ambience ----------------------------------------------------------------

/**
 * Seamless wind-and-harbour bed.
 *
 * Rendered one crossfade-length longer than the loop, then the overhang is
 * folded back over the head with an equal-power crossfade, so the loop point
 * is continuous in both amplitude and (statistically) spectrum.
 */
function ambience(rng, fs) {
  const loopSec = 6;
  const xfadeSec = 0.75;
  const total = seconds(loopSec + xfadeSec, fs);

  const wind = pinkNoise(total, rng);
  // Slow, irregular cutoff drift models gusting; three incommensurate LFOs
  // avoid an audible period inside the loop.
  const gustPhase = [rng.next() * TAU, rng.next() * TAU, rng.next() * TAU];
  const shaped = svf(
    wind,
    fs,
    (i) => {
      const t = i / fs;
      const m =
        0.5 +
        0.28 * Math.sin(TAU * (1 / loopSec) * t + gustPhase[0]) +
        0.15 * Math.sin(TAU * (2 / loopSec) * t + gustPhase[1]) +
        0.07 * Math.sin(TAU * (3 / loopSec) * t + gustPhase[2]);
      return 190 + 620 * Math.max(0, Math.min(1, m));
    },
    0.65,
    'lp'
  );
  const out = alloc(total);
  mixInto(out, shaped, 1);

  // Amplitude gusting, deliberately out of phase with the spectral drift.
  for (let i = 0; i < out.length; i++) {
    const t = i / fs;
    const g =
      0.62 +
      0.24 * Math.sin(TAU * (1 / loopSec) * t + gustPhase[2]) +
      0.11 * Math.sin(TAU * (2 / loopSec) * t + gustPhase[0]);
    out[i] *= Math.max(0.15, g);
  }

  // Distant harbour wash: a narrow mid band, very quiet, adds a sense of an
  // outdoors that extends past the arena walls.
  const wash = svf(pinkNoise(total, rng), fs, () => 900, 0.5, 'bp');
  for (let i = 0; i < wash.length; i++) {
    wash[i] *= 0.55 + 0.45 * Math.sin(TAU * (1 / loopSec) * 2 * (i / fs) + gustPhase[1]);
  }
  mixInto(out, wash, 0.1);

  const xfade = seconds(xfadeSec, fs);
  const loopLen = seconds(loopSec, fs);
  const looped = alloc(loopLen);
  looped.set(out.subarray(0, loopLen));
  for (let i = 0; i < xfade; i++) {
    const x = i / xfade;
    // Equal-power: a linear crossfade of two decorrelated noise fields dips
    // by 3dB in the middle, which is audible as a hole at the loop point.
    const a = Math.cos((x * Math.PI) / 2);
    const b = Math.sin((x * Math.PI) / 2);
    looped[i] = looped[i] * b + out[loopLen + i] * a;
  }

  dcBlock(looped, fs, 18);
  highpass(looped, fs, 45, 0.7071);
  lowshelf(looped, fs, 160, 0.7071, 3);
  normalize(looped, 0.55);
  return { data: looped, fs, loop: true };
}

// -- impulse responses -------------------------------------------------------

/** Stereo IR with decorrelated channels sharing one decay law. */
function stereoIr(rng, fs, params) {
  const left = roomIr(fs, rng, params);
  const right = roomIr(fs, rng, { ...params, predelayMs: params.predelayMs * 1.13 });
  const n = Math.max(left.length, right.length);
  const l = alloc(n);
  const r = alloc(n);
  l.set(left);
  r.set(right);
  return [l, r];
}

function courtyardIr(rng, fs) {
  const [l, r] = stereoIr(rng, fs, {
    // A ~70m walled yard: long enough to be obviously outdoors and enclosed,
    // short enough not to smear a 700rpm cyclic rate into mush.
    rt60: 1.55,
    predelayMs: 17,
    erCount: 20,
    erSpanMs: 110,
    erGain: 0.5,
    hfStart: 8500,
    hfEnd: 850,
    damping: 0.42,
  });
  for (const ch of [l, r]) {
    // Open air has no low-frequency buildup; walls reflect the mids.
    highpass(ch, fs, 110, 0.7071);
    peaking(ch, fs, 700, 0.8, 2);
    normalize(ch, 0.85);
  }
  return { data: [l, r], fs };
}

function interiorIr(rng, fs) {
  const [l, r] = stereoIr(rng, fs, {
    // Container or hard-walled interior: short, dense, strongly coloured.
    rt60: 0.52,
    predelayMs: 5,
    erCount: 26,
    erSpanMs: 38,
    erGain: 0.72,
    hfStart: 6000,
    hfEnd: 620,
    damping: 0.14,
  });
  for (const ch of [l, r]) {
    highpass(ch, fs, 75, 0.7071);
    // Axial room modes of a small box; this coloration is the main cue that
    // tells the player they moved indoors.
    peaking(ch, fs, 172, 3.5, 5);
    peaking(ch, fs, 318, 3, 4);
    peaking(ch, fs, 540, 2.5, 3);
    normalize(ch, 0.85);
  }
  return { data: [l, r], fs };
}

// -- bank --------------------------------------------------------------------

const variants = (prefix, count, render, opts) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    render,
    ...opts,
  }));

/**
 * `gain` is the authored playback level relative to the loudest cue in the
 * bank. Files are individually peak-normalised during generation (so 16-bit
 * quantisation noise stays as low as possible), and the intended mix balance
 * lives here instead.
 */
export const BANK = [
  ...variants('weapon.rifle.fire.close', 4, rifleClose, { fs: FS_FULL, gain: 1, group: 'weapon' }),
  ...variants('weapon.rifle.fire.distant', 3, rifleDistant, { fs: FS_FULL, gain: 0.9, group: 'weapon' }),
  ...variants('weapon.rifle.dry', 2, dryFire, { fs: FS_FULL, gain: 0.5, group: 'weapon' }),
  { id: 'weapon.rifle.mag.out', render: magOut, fs: FS_FULL, gain: 0.55, group: 'weapon' },
  { id: 'weapon.rifle.mag.in', render: magIn, fs: FS_FULL, gain: 0.6, group: 'weapon' },
  { id: 'weapon.rifle.charge.pull', render: chargePull, fs: FS_FULL, gain: 0.5, group: 'weapon' },
  { id: 'weapon.rifle.charge.release', render: chargeRelease, fs: FS_FULL, gain: 0.6, group: 'weapon' },
  { id: 'weapon.rifle.ads.in', render: (r, fs) => adsMove(r, fs, true), fs: FS_FULL, gain: 0.35, group: 'weapon' },
  { id: 'weapon.rifle.ads.out', render: (r, fs) => adsMove(r, fs, false), fs: FS_FULL, gain: 0.3, group: 'weapon' },

  ...variants('impact.concrete', 3, impact('concrete'), { fs: FS_FULL, gain: 0.75, group: 'impact' }),
  ...variants('impact.metal', 3, impact('metal'), { fs: FS_FULL, gain: 0.7, group: 'impact' }),
  ...variants('impact.wood', 3, impact('wood'), { fs: FS_FULL, gain: 0.7, group: 'impact' }),
  ...variants('impact.dirt', 2, impact('dirt'), { fs: FS_FULL, gain: 0.65, group: 'impact' }),
  ...variants('impact.sand', 2, impact('sand'), { fs: FS_FULL, gain: 0.6, group: 'impact' }),
  ...variants('impact.glass', 2, impact('glass'), { fs: FS_FULL, gain: 0.7, group: 'impact' }),
  ...variants('impact.water', 2, impact('water'), { fs: FS_FULL, gain: 0.65, group: 'impact' }),
  ...variants('impact.fabric', 2, impact('fabric'), { fs: FS_FULL, gain: 0.55, group: 'impact' }),
  ...variants('impact.foliage', 2, impact('foliage'), { fs: FS_FULL, gain: 0.6, group: 'impact' }),
  ...variants('impact.flesh', 3, impact('flesh'), { fs: FS_FULL, gain: 0.8, group: 'impact' }),

  ...variants('step.concrete', 3, footstep('concrete'), { fs: FS_HALF, gain: 0.4, group: 'step' }),
  ...variants('step.metal', 3, footstep('metal'), { fs: FS_HALF, gain: 0.4, group: 'step' }),
  ...variants('step.wood', 3, footstep('wood'), { fs: FS_HALF, gain: 0.4, group: 'step' }),
  ...variants('step.dirt', 2, footstep('dirt'), { fs: FS_HALF, gain: 0.38, group: 'step' }),
  ...variants('step.sand', 2, footstep('sand'), { fs: FS_HALF, gain: 0.34, group: 'step' }),
  ...variants('step.water', 2, footstep('water'), { fs: FS_HALF, gain: 0.42, group: 'step' }),
  ...variants('step.foliage', 2, footstep('foliage'), { fs: FS_HALF, gain: 0.36, group: 'step' }),

  ...variants('shell.bounce', 4, shellBounce, { fs: FS_FULL, gain: 0.3, group: 'shell' }),

  { id: 'ui.hit', render: (r, fs) => hitTick(r, fs, { f: 1250, bright: 2600 }), fs: FS_FULL, gain: 0.35, group: 'ui' },
  { id: 'ui.hit.head', render: (r, fs) => hitTick(r, fs, { f: 1870, bright: 4200, double: 0.026 }), fs: FS_FULL, gain: 0.4, group: 'ui' },
  { id: 'ui.hit.kill', render: (r, fs) => hitTick(r, fs, { f: 1480, bright: 3200, double: 0.055, body: 220 }), fs: FS_FULL, gain: 0.45, group: 'ui' },

  ...variants('player.land.soft', 2, (r, fs) => land(r, fs, false), { fs: FS_FULL, gain: 0.5, group: 'player' }),
  ...variants('player.land.hard', 2, (r, fs) => land(r, fs, true), { fs: FS_FULL, gain: 0.8, group: 'player' }),
  { id: 'player.jump', render: jumpEffort, fs: FS_FULL, gain: 0.4, group: 'player' },
  ...variants('player.hurt', 2, playerHurt, { fs: FS_FULL, gain: 0.85, group: 'player' }),

  { id: 'ambience.courtyard', render: ambience, fs: FS_HALF, gain: 1, group: 'ambience', loop: true },

  { id: 'ir.courtyard', render: courtyardIr, fs: FS_HALF, gain: 1, group: 'ir' },
  { id: 'ir.interior', render: interiorIr, fs: FS_HALF, gain: 1, group: 'ir' },
];

/** FNV-1a over the id, so each sound's noise is stable and independent. */
export function seedFor(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export function renderEntry(entry) {
  const rng = createRng(seedFor(entry.id));
  const result = entry.render(rng, entry.fs);
  const channels = Array.isArray(result.data) ? result.data : [result.data];
  return { channels, fs: result.fs ?? entry.fs };
}
