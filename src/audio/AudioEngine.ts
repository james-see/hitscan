import * as THREE from 'three';
import type { QualitySettings } from '@/types/settings.ts';
import { TUNING } from './catalog.ts';

/**
 * The mix graph.
 *
 *   spatial + flat voices ─┐
 *                          ├─> sfx bus ─┐
 *   reverb return ─────────┘            ├─> compressor ─> soft clip ─> master
 *   ambience ─> duck ─> music bus ──────┘
 *
 * Two things here are load-bearing. The compressor plus soft clipper is not
 * optional: eight overlapping gunshots each peaking near full scale will sum
 * past 0dBFS and the browser's implicit clip is audibly nasty. And every
 * volume is applied on a bus rather than per voice, so a settings change is
 * one ramp instead of a walk over live sources.
 */
export class AudioEngine {
  readonly ctx: AudioContext;

  /** Dry input for every sound effect. */
  readonly sfxBus: GainNode;
  /** Send bus feeding the convolution reverb. */
  readonly reverbBus: GainNode;
  /** Post-reverb return, summed back into the sfx bus. */
  readonly reverbReturn: GainNode;
  /** Non-diegetic bed: ambience, and music if it is ever added. */
  readonly musicBus: GainNode;

  #sfxGain: GainNode;
  #musicGain: GainNode;
  #musicDuck: GainNode;
  #masterGain: GainNode;
  #compressor: DynamicsCompressorNode;
  #limiter: WaveShaperNode;

  #resumeHandlers: Array<() => void> = [];
  #armed = false;
  #paused = false;

  #listenerPosition = new THREE.Vector3();
  #forward = new THREE.Vector3();
  #up = new THREE.Vector3();

  constructor() {
    // `interactive` asks the platform for the smallest buffer it will give
    // us. A shot that arrives 40ms after the muzzle flash reads as input lag.
    this.ctx = new AudioContext({ latencyHint: 'interactive' });

    this.#masterGain = this.ctx.createGain();
    this.#masterGain.connect(this.ctx.destination);

    // Soft clipper as the last line of defence. The compressor below has no
    // lookahead, so a sub-millisecond transient can still overshoot it.
    this.#limiter = this.ctx.createWaveShaper();
    this.#limiter.curve = makeSoftClipCurve();
    this.#limiter.oversample = '2x';
    this.#limiter.connect(this.#masterGain);

    this.#compressor = this.ctx.createDynamicsCompressor();
    // Slow enough (5ms) to let the crack of a shot through intact, with a
    // wide knee so it leans in gradually instead of pumping on every round.
    this.#compressor.threshold.value = -8;
    this.#compressor.knee.value = 10;
    this.#compressor.ratio.value = 10;
    this.#compressor.attack.value = 0.005;
    this.#compressor.release.value = 0.22;
    this.#compressor.connect(this.#limiter);

    this.#sfxGain = this.ctx.createGain();
    this.#sfxGain.connect(this.#compressor);

    this.#musicGain = this.ctx.createGain();
    this.#musicGain.connect(this.#compressor);

    this.#musicDuck = this.ctx.createGain();
    this.#musicDuck.connect(this.#musicGain);

    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(this.#musicDuck);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.#sfxGain);

    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = TUNING.reverbWetOpen;
    this.reverbReturn.connect(this.sfxBus);

    this.reverbBus = this.ctx.createGain();

    this.#armResume();
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  get listenerPosition(): THREE.Vector3 {
    return this.#listenerPosition;
  }

  /**
   * Browsers refuse to start an `AudioContext` without a user gesture, and
   * the screenshot harness never produces one. Resume is therefore always
   * opportunistic: it is attempted on the first interaction of any kind and
   * a permanent suspension is a supported state, not an error.
   */
  #armResume(): void {
    if (this.#armed) return;
    this.#armed = true;
    const events = ['pointerdown', 'mousedown', 'keydown', 'touchstart'] as const;
    const resume = (): void => {
      void this.ctx.resume().catch(() => undefined);
      if (this.ctx.state === 'running') this.#disarmResume();
    };
    for (const type of events) {
      window.addEventListener(type, resume, { capture: true, passive: true });
      this.#resumeHandlers.push(() => window.removeEventListener(type, resume, { capture: true }));
    }
    this.ctx.addEventListener('statechange', () => {
      if (this.ctx.state === 'running') this.#disarmResume();
    });
  }

  #disarmResume(): void {
    for (const off of this.#resumeHandlers) off();
    this.#resumeHandlers = [];
  }

  /** Called on any explicit interaction the game already knows about. */
  tryResume(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  applySettings(settings: QualitySettings): void {
    const now = this.ctx.currentTime;
    const master = clamp01(settings.masterVolume) * (this.#paused ? 0 : 1);
    // Short ramps rather than direct assignment: a step on a gain node is a
    // discontinuity in the signal, which is a click.
    this.#masterGain.gain.setTargetAtTime(master, now, 0.02);
    this.#sfxGain.gain.setTargetAtTime(clamp01(settings.sfxVolume), now, 0.02);
    this.#musicGain.gain.setTargetAtTime(clamp01(settings.musicVolume), now, 0.02);
  }

  setPaused(paused: boolean, settings: QualitySettings): void {
    this.#paused = paused;
    this.applySettings(settings);
  }

  /**
   * Ducks the ambience bed under gunfire. A shot that does not push
   * everything else out of the way for a moment sounds weightless, and this
   * is far cheaper than a real sidechain.
   */
  duck(): void {
    const now = this.ctx.currentTime;
    const gain = this.#musicDuck.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(1 - TUNING.duckAmount, now + TUNING.duckAttack);
    gain.setTargetAtTime(1, now + TUNING.duckAttack, TUNING.duckRelease / 3);
  }

  /**
   * Pushes the camera transform to the Web Audio listener.
   *
   * Smoothed with a 20ms time constant: HRTF panning recomputes its
   * convolution when the relative angle changes, and snapping the listener
   * every frame during a fast flick produces audible zipper artefacts.
   */
  updateListener(camera: THREE.PerspectiveCamera): void {
    camera.getWorldPosition(this.#listenerPosition);
    this.#forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.#up.set(0, 1, 0).applyQuaternion(camera.quaternion);

    const listener = this.ctx.listener;
    const now = this.ctx.currentTime;
    const smoothing = 0.02;

    if (listener.positionX) {
      listener.positionX.setTargetAtTime(this.#listenerPosition.x, now, smoothing);
      listener.positionY.setTargetAtTime(this.#listenerPosition.y, now, smoothing);
      listener.positionZ.setTargetAtTime(this.#listenerPosition.z, now, smoothing);
      listener.forwardX.setTargetAtTime(this.#forward.x, now, smoothing);
      listener.forwardY.setTargetAtTime(this.#forward.y, now, smoothing);
      listener.forwardZ.setTargetAtTime(this.#forward.z, now, smoothing);
      listener.upX.setTargetAtTime(this.#up.x, now, smoothing);
      listener.upY.setTargetAtTime(this.#up.y, now, smoothing);
      listener.upZ.setTargetAtTime(this.#up.z, now, smoothing);
      return;
    }

    // Pre-AudioParam listener API, still the only one in some Safari builds.
    const legacy = listener as unknown as {
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
    };
    legacy.setPosition?.(this.#listenerPosition.x, this.#listenerPosition.y, this.#listenerPosition.z);
    legacy.setOrientation?.(
      this.#forward.x, this.#forward.y, this.#forward.z,
      this.#up.x, this.#up.y, this.#up.z
    );
  }

  /** Instantaneous gain reduction in dB. Useful for tuning the voice budget. */
  get compression(): number {
    return this.#compressor.reduction;
  }

  dispose(): void {
    this.#disarmResume();
    void this.ctx.close().catch(() => undefined);
  }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * tanh saturation normalised so full-scale input maps just under full-scale
 * output. A WaveShaper clamps inputs beyond +/-1 to the curve's endpoints, so
 * the endpoint value is the hard ceiling; everything below it is bent
 * smoothly rather than cut, which is why this sounds like compression instead
 * of distortion.
 */
// The buffer type is explicit because WaveShaperNode.curve rejects the
// ArrayBufferLike default that a bare Float32Array annotation now infers.
function makeSoftClipCurve(
  samples = 2048,
  drive = 1.9,
  ceiling = 0.985
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = (Math.tanh(drive * x) / norm) * ceiling;
  }
  return curve;
}
