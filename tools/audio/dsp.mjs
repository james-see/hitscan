/**
 * Minimal offline DSP toolkit for procedural game audio.
 *
 * Node has no Web Audio, so everything here operates on plain Float32Array
 * blocks at an explicit sample rate. The primitives are the ones that matter
 * for percussive, transient-heavy game sound: state-variable filters that
 * tolerate per-sample frequency modulation, RBJ biquads for static shaping,
 * damped sinusoid banks for resonant bodies, and saturation.
 */

export const TAU = Math.PI * 2;

// -- deterministic rng -------------------------------------------------------

/**
 * sfc32, matching the runtime engine's generator. Generation must be
 * reproducible: regenerating the bank from the same seed has to yield
 * byte-identical WAVs so the asset diff stays empty across runs.
 */
export function createRng(seed) {
  let h = (seed >>> 0) + 0x9e3779b9;
  const mix = () => {
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
    h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
    return (h ^= h >>> 15) >>> 0;
  };
  let a = mix();
  let b = mix();
  let c = mix();
  let d = mix();
  let spare = null;

  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();

  const rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    /** Signed detune factor in [-amount, amount], useful for variant spread. */
    detune: (amount) => 1 + (next() * 2 - 1) * amount,
    gaussian: (mean = 0, stddev = 1) => {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return mean + stddev * v;
      }
      let u = 0;
      let v = 0;
      let s = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const scale = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * scale;
      return mean + stddev * u * scale;
    },
  };
  return rng;
}

// -- buffers -----------------------------------------------------------------

export const alloc = (n) => new Float32Array(Math.max(1, Math.ceil(n)));
export const seconds = (t, fs) => Math.max(1, Math.round(t * fs));

/** Adds `src * gain` into `dst` starting at sample `offset`, clipping range. */
export function mixInto(dst, src, gain = 1, offset = 0) {
  const start = Math.max(0, Math.round(offset));
  const count = Math.min(src.length, dst.length - start);
  for (let i = 0; i < count; i++) dst[start + i] += src[i] * gain;
  return dst;
}

export function scale(buf, gain) {
  for (let i = 0; i < buf.length; i++) buf[i] *= gain;
  return buf;
}

export function peak(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > p) p = v;
  }
  return p;
}

/** Scales to a target peak. Silent buffers are left alone rather than blown up. */
export function normalize(buf, target = 0.98) {
  const p = peak(buf);
  if (p < 1e-6) return buf;
  return scale(buf, target / p);
}

/**
 * Removes DC and subsonic content. Muzzle-blast sub layers synthesised with
 * fast pitch sweeps leave an offset that eats headroom without being audible.
 */
export function dcBlock(buf, fs, cutoff = 22) {
  const r = 1 - (TAU * cutoff) / fs;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = x - x1 + r * y1;
    x1 = x;
    y1 = y;
    buf[i] = y;
  }
  return buf;
}

/** Raised-cosine fade at both ends; prevents end-of-file clicks. */
export function fadeEdges(buf, fs, fadeInMs = 0.2, fadeOutMs = 6) {
  const nIn = Math.min(buf.length >> 1, seconds(fadeInMs / 1000, fs));
  const nOut = Math.min(buf.length >> 1, seconds(fadeOutMs / 1000, fs));
  for (let i = 0; i < nIn; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / nIn);
  for (let i = 0; i < nOut; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / nOut);
    buf[buf.length - 1 - i] *= g;
  }
  return buf;
}

/** Trims trailing samples below `floor`, keeping a short guard tail. */
export function trimTail(buf, fs, floor = 1.5e-4, guardMs = 12) {
  let last = buf.length - 1;
  while (last > 0 && Math.abs(buf[last]) < floor) last--;
  const end = Math.min(buf.length, last + seconds(guardMs / 1000, fs));
  return buf.subarray(0, Math.max(seconds(0.01, fs), end));
}

// -- sources -----------------------------------------------------------------

export function whiteNoise(n, rng) {
  const out = alloc(n);
  for (let i = 0; i < out.length; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/**
 * Pink noise via the Paul Kellett economy filter. -3dB/octave matches the
 * spectral tilt of real air turbulence and distant rumble far better than
 * white, which reads as hiss.
 */
export function pinkNoise(n, rng) {
  const out = alloc(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.32;
  }
  return out;
}

/**
 * Exponentially damped sinusoid — one resonant mode of a struck body.
 * `drift` bends the frequency over the decay, which is what makes a struck
 * metal panel sound alive rather than like a test tone.
 */
export function dampedSine(n, fs, freq, tau, amp = 1, phase = 0, drift = 0) {
  const out = alloc(n);
  const len = out.length;
  let ph = phase;
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    const f = freq * (1 + drift * (i / len));
    ph += (TAU * f) / fs;
    out[i] = Math.exp(-t / tau) * Math.sin(ph) * amp;
  }
  return out;
}

/**
 * Percussive amplitude envelope.
 *
 * `attack` is a raised-cosine ramp (a linear ramp on a 0.2ms attack produces
 * an audible corner); the decay is exponential with `shape` warping it, where
 * shape > 1 holds the body longer before collapsing.
 */
export function percussive(n, fs, { attack = 0.0005, hold = 0, tau = 0.05, shape = 1 } = {}) {
  const out = alloc(n);
  const a = Math.max(1, seconds(attack, fs));
  const h = seconds(hold, fs);
  for (let i = 0; i < out.length; i++) {
    let g;
    if (i < a) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / a);
    else if (i < a + h) g = 1;
    else g = Math.exp(-(i - a - h) / fs / tau);
    out[i] = shape === 1 ? g : Math.pow(g, 1 / shape);
  }
  return out;
}

export function applyEnv(buf, env) {
  const n = Math.min(buf.length, env.length);
  for (let i = 0; i < n; i++) buf[i] *= env[i];
  for (let i = n; i < buf.length; i++) buf[i] = 0;
  return buf;
}

// -- filters -----------------------------------------------------------------

/**
 * Topology-preserving state-variable filter (Zavalishin). Chosen over a
 * biquad for the modulated stages because its cutoff can be swept per sample
 * without the coefficient discontinuities that make an RBJ biquad zipper or
 * blow up at high Q.
 *
 * `freqAt(i)` returns cutoff in Hz for sample i; `mode` picks the output tap.
 */
export function svf(input, fs, freqAt, q = 0.7071, mode = 'lp') {
  const out = alloc(input.length);
  const k = 1 / q;
  let ic1 = 0;
  let ic2 = 0;
  const nyq = fs * 0.49;
  for (let i = 0; i < input.length; i++) {
    const fc = Math.min(nyq, Math.max(10, freqAt(i)));
    const g = Math.tan((Math.PI * fc) / fs);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const x = input[i];
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    out[i] = mode === 'lp' ? v2 : mode === 'bp' ? v1 : x - k * v1 - v2;
  }
  return out;
}

/** RBJ cookbook coefficients, normalised by a0. */
export function biquadCoeffs(type, fs, f0, Q = 0.7071, gainDb = 0) {
  const w0 = (TAU * Math.min(f0, fs * 0.49)) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sw / (2 * Q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  switch (type) {
    case 'lp':
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'hp':
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'bp':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'peak':
      b0 = 1 + alpha * A;
      b1 = -2 * cw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cw;
      a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cw + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - s;
      break;
    }
    default:
      throw new Error(`unknown filter type ${type}`);
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Direct form I. `passes` cascades identical sections for a steeper slope. */
export function biquad(buf, coeffs, passes = 1) {
  const [b0, b1, b2, a1, a2] = coeffs;
  for (let p = 0; p < passes; p++) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      buf[i] = y;
    }
  }
  return buf;
}

export const lowpass = (buf, fs, f, q = 0.7071, passes = 1) =>
  biquad(buf, biquadCoeffs('lp', fs, f, q), passes);
export const highpass = (buf, fs, f, q = 0.7071, passes = 1) =>
  biquad(buf, biquadCoeffs('hp', fs, f, q), passes);
export const bandpass = (buf, fs, f, q = 1, passes = 1) =>
  biquad(buf, biquadCoeffs('bp', fs, f, q), passes);
export const peaking = (buf, fs, f, q, db) => biquad(buf, biquadCoeffs('peak', fs, f, q, db));
export const highshelf = (buf, fs, f, q, db) =>
  biquad(buf, biquadCoeffs('highshelf', fs, f, q, db));
export const lowshelf = (buf, fs, f, q, db) => biquad(buf, biquadCoeffs('lowshelf', fs, f, q, db));

// -- nonlinearity ------------------------------------------------------------

/**
 * Asymmetric soft clip. A real muzzle blast is a shock wave: the pressure
 * front is far steeper than the rarefaction behind it, so a symmetric
 * saturator sounds synthetic. The asymmetry adds even harmonics, which is
 * what gives the shot its "meat" on small speakers.
 */
export function saturate(buf, drive = 2, asymmetry = 0.25) {
  const norm = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] * drive;
    const bias = x > 0 ? 1 : 1 - asymmetry;
    buf[i] = Math.tanh(x * bias) / norm;
  }
  return buf;
}

// -- fft & convolution -------------------------------------------------------

/** In-place iterative radix-2 FFT. `re`/`im` must be power-of-two length. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? TAU : -TAU) / len);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
        const vi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + (len >> 1)] = ur - vr;
        im[i + k + (len >> 1)] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/** Frequency-domain convolution. Time domain would be minutes for a 1.5s IR. */
export function convolve(signal, impulse) {
  const outLen = signal.length + impulse.length - 1;
  const n = nextPow2(outLen);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(signal);
  br.set(impulse);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  const out = alloc(outLen);
  for (let i = 0; i < outLen; i++) out[i] = ar[i];
  return out;
}

// -- measurement -------------------------------------------------------------

export function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, buf.length));
}

export const dB = (x) => (x <= 1e-9 ? -Infinity : 20 * Math.log10(x));

/**
 * Magnitude-weighted mean frequency. A useful single number for confirming a
 * layer is present: a shot missing its transient drops several kHz.
 */
export function spectralCentroid(buf, fs, maxSamples = 1 << 17) {
  const len = Math.min(buf.length, maxSamples);
  const n = nextPow2(len);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < len; i++) {
    // Hann window: an abrupt rectangular cut smears energy across the whole
    // spectrum and biases the centroid upward.
    re[i] = buf[i] * (0.5 - 0.5 * Math.cos((TAU * i) / len));
  }
  fft(re, im);
  let num = 0;
  let den = 0;
  for (let k = 1; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    num += mag * ((k * fs) / n);
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

/** Fraction of spectral energy above `f`. Distinguishes crack from thump. */
export function highBandRatio(buf, fs, f = 2000, maxSamples = 1 << 17) {
  const len = Math.min(buf.length, maxSamples);
  const n = nextPow2(len);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < len; i++) re[i] = buf[i] * (0.5 - 0.5 * Math.cos((TAU * i) / len));
  fft(re, im);
  let hi = 0;
  let all = 0;
  for (let k = 1; k < n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    all += p;
    if ((k * fs) / n >= f) hi += p;
  }
  return all > 0 ? hi / all : 0;
}

/**
 * Decay measurement from a windowed RMS envelope. Returns the time to fall
 * 20dB below the envelope peak, plus a T60 extrapolated from the -5..-25dB
 * slope (the Schroeder-style approach: the true -60dB point is usually below
 * the noise floor of a synthesised tail).
 */
export function decayTimes(buf, fs, windowMs = 4) {
  const w = seconds(windowMs / 1000, fs);
  const frames = Math.max(2, Math.floor(buf.length / w));
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const v = buf[f * w + i] || 0;
      sum += v * v;
    }
    env[f] = Math.sqrt(sum / w);
  }
  let peakIdx = 0;
  for (let f = 0; f < frames; f++) if (env[f] > env[peakIdx]) peakIdx = f;
  const p = env[peakIdx];
  if (p <= 0) return { t20: 0, t60: 0 };

  const frameTime = w / fs;
  const findDrop = (db) => {
    const target = p * Math.pow(10, -db / 20);
    for (let f = peakIdx; f < frames; f++) if (env[f] <= target) return (f - peakIdx) * frameTime;
    return null;
  };
  const t20 = findDrop(20);
  const a = findDrop(5);
  const b = findDrop(25);
  const t60 = a !== null && b !== null && b > a ? ((b - a) * 60) / 20 : (t20 ?? 0) * 3;
  return { t20: t20 ?? frames * frameTime, t60 };
}

/** Third-octave-ish band energies in dB, relative to total. */
export function octaveBands(buf, fs, centres = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
  const len = Math.min(buf.length, 1 << 17);
  const n = nextPow2(len);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < len; i++) re[i] = buf[i] * (0.5 - 0.5 * Math.cos((TAU * i) / len));
  fft(re, im);
  const bands = centres.map(() => 0);
  let total = 0;
  for (let k = 1; k < n / 2; k++) {
    const f = (k * fs) / n;
    const p = re[k] * re[k] + im[k] * im[k];
    total += p;
    for (let b = 0; b < centres.length; b++) {
      if (f >= centres[b] / Math.SQRT2 && f < centres[b] * Math.SQRT2) {
        bands[b] += p;
        break;
      }
    }
  }
  return bands.map((p) => (total > 0 ? 10 * Math.log10(Math.max(1e-12, p / total)) : -Infinity));
}

/**
 * Time from 5% to 100% of the peak envelope, in ms. A convincing gunshot
 * transient is well under a millisecond; anything above ~3ms reads as a
 * "whoosh" rather than a crack.
 */
export function attackMs(buf, fs) {
  let peakIdx = 0;
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > p) {
      p = v;
      peakIdx = i;
    }
  }
  if (p <= 0) return 0;
  let start = peakIdx;
  while (start > 0 && Math.abs(buf[start]) > p * 0.05) start--;
  return ((peakIdx - start) / fs) * 1000;
}

/** Energy fraction inside the first `ms` milliseconds. */
export function earlyEnergyRatio(buf, fs, ms = 20) {
  const n = Math.min(buf.length, seconds(ms / 1000, fs));
  let early = 0;
  let total = 0;
  for (let i = 0; i < buf.length; i++) {
    const p = buf[i] * buf[i];
    total += p;
    if (i < n) early += p;
  }
  return total > 0 ? early / total : 0;
}

export function clippedSamples(buf, threshold = 0.999) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) >= threshold) n++;
  return n;
}

// -- wav i/o -----------------------------------------------------------------

/**
 * 16-bit PCM RIFF. 16-bit is transparent for this material and halves the
 * download versus float32; the bank is decoded to float by the browser anyway.
 * TPDF dither would only add noise to synthetic sources with no dither-worthy
 * low-level detail, so quantisation is plain rounding with saturation.
 */
export function encodeWav(channels, fs) {
  const chCount = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * chCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(chCount, 22);
  buffer.writeUInt32LE(fs, 24);
  buffer.writeUInt32LE(fs * chCount * 2, 28);
  buffer.writeUInt16LE(chCount * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chCount; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buffer.writeInt16LE(Math.round(v * 32767), offset);
      offset += 2;
    }
  }
  return buffer;
}

/** Reads back a PCM16 WAV so generated files can be verified as decoded. */
export function decodeWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('expected 16-bit PCM');

  const frames = Math.floor(data.length / (2 * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      channels[c][i] = data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    }
  }
  return { sampleRate: fmt.sampleRate, channels, frames };
}
