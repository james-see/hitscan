import type { AudioEngine } from './AudioEngine.ts';
import { TUNING } from './catalog.ts';

/**
 * Two-zone convolution reverb.
 *
 * The arena is a walled courtyard containing enclosed pockets — container
 * corridors, the gap behind the raised platform, the shadowed alcoves — and
 * they should not sound the same. Rather than authoring trigger volumes that
 * would have to track another module's level layout, the blend is driven by
 * a geometric enclosure estimate (see `EnclosureProbe`), so it adapts to
 * whatever the world module builds.
 *
 * Both impulses are generated procedurally: exponentially decaying filtered
 * noise with discrete early reflections, rendered offline by
 * `tools/audio/generate.mjs`.
 */
export class ReverbRack {
  #engine: AudioEngine;
  #open: ConvolverNode;
  #enclosed: ConvolverNode;
  #openGain: GainNode;
  #enclosedGain: GainNode;
  #tone: BiquadFilterNode;
  #rumble: BiquadFilterNode;
  #blend = 0;
  #ready = false;

  constructor(engine: AudioEngine) {
    this.#engine = engine;
    const ctx = engine.ctx;

    // Reflected energy is always darker than the direct sound; sending full
    // bandwidth into a convolver makes the tail hiss.
    this.#tone = ctx.createBiquadFilter();
    this.#tone.type = 'lowpass';
    this.#tone.frequency.value = 7500;
    this.#tone.Q.value = 0.7071;

    // And the low end of a reverb send is mud, not space.
    this.#rumble = ctx.createBiquadFilter();
    this.#rumble.type = 'highpass';
    this.#rumble.frequency.value = 130;
    this.#rumble.Q.value = 0.7071;

    engine.reverbBus.connect(this.#tone);
    this.#tone.connect(this.#rumble);

    this.#open = ctx.createConvolver();
    this.#enclosed = ctx.createConvolver();
    this.#openGain = ctx.createGain();
    this.#enclosedGain = ctx.createGain();
    this.#openGain.gain.value = 1;
    this.#enclosedGain.gain.value = 0;

    this.#rumble.connect(this.#open);
    this.#rumble.connect(this.#enclosed);
    this.#open.connect(this.#openGain);
    this.#enclosed.connect(this.#enclosedGain);
    this.#openGain.connect(engine.reverbReturn);
    this.#enclosedGain.connect(engine.reverbReturn);
  }

  get ready(): boolean {
    return this.#ready;
  }

  setImpulses(open: AudioBuffer | null, enclosed: AudioBuffer | null): void {
    // Normalisation is left on so the two impulses are loudness-matched and
    // the crossfade is level-neutral; the perceptual "small rooms are wetter"
    // difference is applied by `reverbReturn` instead.
    this.#open.normalize = true;
    this.#enclosed.normalize = true;
    if (open) this.#open.buffer = open;
    if (enclosed) this.#enclosed.buffer = enclosed;
    this.#ready = Boolean(open ?? enclosed);
  }

  /**
   * `enclosure` is 0 in the open courtyard and 1 in a tight interior.
   *
   * The crossfade is equal-power: two decorrelated reverb tails summed with a
   * linear fade dip by 3dB at the midpoint, which is audible as the player
   * walks through a doorway.
   */
  setEnclosure(enclosure: number): void {
    const t = Math.min(1, Math.max(0, enclosure));
    if (Math.abs(t - this.#blend) < 0.002) return;
    this.#blend = t;
    const now = this.#engine.ctx.currentTime;
    const glide = 0.15;
    this.#openGain.gain.setTargetAtTime(Math.cos((t * Math.PI) / 2), now, glide);
    this.#enclosedGain.gain.setTargetAtTime(Math.sin((t * Math.PI) / 2), now, glide);
    const wet = TUNING.reverbWetOpen + (TUNING.reverbWetEnclosed - TUNING.reverbWetOpen) * t;
    this.#engine.reverbReturn.gain.setTargetAtTime(wet, now, glide);
    // An enclosed space also has a shorter path to the first reflection, so
    // it holds more high frequency than an open one.
    this.#tone.frequency.setTargetAtTime(7500 + 2500 * t, now, glide);
  }

  get blend(): number {
    return this.#blend;
  }
}
