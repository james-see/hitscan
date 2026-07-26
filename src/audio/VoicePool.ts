import type * as THREE from 'three';
import type { AudioEngine } from './AudioEngine.ts';
import { TUNING } from './catalog.ts';

export interface SpatialRequest {
  buffer: AudioBuffer;
  /** Post-authoring level, before distance attenuation. */
  gain: number;
  priority: number;
  position: THREE.Vector3;
  playbackRate?: number;
  /** Seconds to wait before starting. Used for propagation delay. */
  delay?: number;
  /** Reverb send as a fraction of the dry level. */
  reverbSend?: number;
  /** 0 for clear line of sight, 1 for fully blocked. */
  occlusion?: number;
  loop?: boolean;
}

export interface FlatRequest {
  buffer: AudioBuffer;
  gain: number;
  priority: number;
  playbackRate?: number;
  delay?: number;
  reverbSend?: number;
  loop?: boolean;
}

/** A pooled channel strip. The nodes persist; only the source is per-shot. */
interface Voice {
  filter: BiquadFilterNode | null;
  gain: GainNode;
  panner: PannerNode | null;
  send: GainNode;
  source: AudioBufferSourceNode | null;
  /** Bumped on every reuse so a stale `ended` callback cannot free a live voice. */
  generation: number;
  active: boolean;
  priority: number;
  /** Estimated contribution to the mix, for stealing decisions. */
  audibility: number;
  endsAt: number;
}

/**
 * Fixed-size voice pool with priority stealing.
 *
 * Two things motivate a pool rather than building nodes per shot. An HRTF
 * `PannerNode` is expensive to construct, and a firefight with no cap becomes
 * an undifferentiated wall of noise well before it becomes a CPU problem —
 * capping voices and stealing the least audible one is a mix decision that
 * keeps the shots that matter legible.
 */
export class VoicePool {
  #engine: AudioEngine;
  #spatial: Voice[] = [];
  #flat: Voice[] = [];
  #stolen = 0;
  #dropped = 0;
  #started = 0;

  constructor(engine: AudioEngine) {
    this.#engine = engine;
  }

  get stats(): { active: number; started: number; stolen: number; dropped: number } {
    let active = 0;
    for (const v of this.#spatial) if (v.active) active++;
    for (const v of this.#flat) if (v.active) active++;
    return { active, started: this.#started, stolen: this.#stolen, dropped: this.#dropped };
  }

  playSpatial(req: SpatialRequest): boolean {
    const engine = this.#engine;
    const listener = engine.listenerPosition;
    const distance = req.position.distanceTo(listener);
    const occlusion = req.occlusion ?? 0;

    const attenuation = inverseDistanceGain(distance);
    const audibility = req.gain * attenuation * (1 - occlusion * (1 - TUNING.occlusionGain));
    // Below this a voice cannot be heard over the rest of the mix, so
    // spending a slot on it is pure cost.
    if (audibility < 0.0015) {
      this.#dropped++;
      return false;
    }

    const voice = this.#acquire(this.#spatial, TUNING.maxSpatialVoices, req.priority, audibility, true);
    if (!voice) {
      this.#dropped++;
      return false;
    }

    const ctx = engine.ctx;
    const now = ctx.currentTime;
    const start = now + Math.max(0, req.delay ?? 0);

    setPannerPosition(voice.panner as PannerNode, req.position, now);

    // Air absorption plus occlusion in one filter. Distant sound loses high
    // frequency to the atmosphere; occluded sound loses it to the wall.
    const air = 20000 / (1 + distance / TUNING.airAbsorptionScale);
    const target = Math.min(
      air,
      occlusion > 0 ? TUNING.occlusionCutoff + (1 - occlusion) * (air - TUNING.occlusionCutoff) : air
    );
    const filter = voice.filter as BiquadFilterNode;
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setTargetAtTime(Math.max(180, target), now, TUNING.occlusionGlide);

    const level = req.gain * (1 - occlusion * (1 - TUNING.occlusionGain));
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(level, now);

    // Occluded sound reaches the listener mostly as reflections, so its wet
    // share goes up even as its dry level goes down.
    const send = (req.reverbSend ?? TUNING.reverbSendDry) * (1 + occlusion * 0.6);
    voice.send.gain.setValueAtTime(send, now);

    return this.#start(voice, req.buffer, req.playbackRate ?? 1, start, req.priority, audibility, req.loop ?? false);
  }

  playFlat(req: FlatRequest): boolean {
    const voice = this.#acquire(this.#flat, TUNING.maxFlatVoices, req.priority, req.gain, false);
    if (!voice) {
      this.#dropped++;
      return false;
    }
    const now = this.#engine.ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(req.gain, now);
    voice.send.gain.setValueAtTime(req.reverbSend ?? 0, now);
    return this.#start(
      voice,
      req.buffer,
      req.playbackRate ?? 1,
      now + Math.max(0, req.delay ?? 0),
      req.priority,
      req.gain,
      req.loop ?? false
    );
  }

  #start(
    voice: Voice,
    buffer: AudioBuffer,
    rate: number,
    when: number,
    priority: number,
    audibility: number,
    loop: boolean
  ): boolean {
    const ctx = this.#engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.loop = loop;
    source.connect(voice.filter ?? voice.gain);

    const generation = ++voice.generation;
    source.onended = (): void => {
      if (voice.generation !== generation) return;
      voice.active = false;
      voice.source = null;
      try {
        source.disconnect();
      } catch {
        // Already torn down; nothing to do.
      }
    };

    voice.source = source;
    voice.active = true;
    voice.priority = priority;
    voice.audibility = audibility;
    voice.endsAt = loop ? Number.POSITIVE_INFINITY : when + buffer.duration / rate;
    source.start(when);
    this.#started++;
    return true;
  }

  /**
   * Finds a free voice, growing the pool up to `limit`, then falls back to
   * stealing. A voice is only stolen if it is genuinely less important than
   * the incoming sound: lower priority tier, or the same tier and quieter.
   */
  #acquire(pool: Voice[], limit: number, priority: number, audibility: number, spatial: boolean): Voice | null {
    for (const voice of pool) if (!voice.active) return voice;
    if (pool.length < limit) {
      const voice = this.#build(spatial);
      pool.push(voice);
      return voice;
    }

    let victim: Voice | null = null;
    for (const voice of pool) {
      if (voice.priority > priority) continue;
      if (voice.priority === priority && voice.audibility >= audibility) continue;
      if (!victim || rank(voice) < rank(victim)) victim = voice;
    }
    if (!victim) return null;

    const source = victim.source;
    victim.generation++;
    victim.active = false;
    victim.source = null;
    if (source) {
      try {
        // A hard stop on a ringing tail is a click. 8ms is inaudible as a
        // fade but long enough to reach zero smoothly.
        const now = this.#engine.ctx.currentTime;
        victim.gain.gain.cancelScheduledValues(now);
        victim.gain.gain.setValueAtTime(victim.gain.gain.value, now);
        victim.gain.gain.linearRampToValueAtTime(0, now + 0.008);
        source.stop(now + 0.009);
        source.onended = null;
        setTimeout(() => {
          try {
            source.disconnect();
          } catch {
            // Already disconnected.
          }
        }, 40);
      } catch {
        // Source may already have ended between the check and the stop.
      }
    }
    this.#stolen++;
    return victim;
  }

  #build(spatial: boolean): Voice {
    const ctx = this.#engine.ctx;
    const gain = ctx.createGain();
    const send = ctx.createGain();
    send.gain.value = 0;

    let filter: BiquadFilterNode | null = null;
    let panner: PannerNode | null = null;

    if (spatial) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 20000;
      filter.Q.value = 0.7071;
      filter.connect(gain);

      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = TUNING.refDistance;
      panner.rolloffFactor = TUNING.rolloffFactor;
      panner.maxDistance = TUNING.maxDistance;
      gain.connect(panner);
      panner.connect(this.#engine.sfxBus);
      panner.connect(send);
    } else {
      gain.connect(this.#engine.sfxBus);
      gain.connect(send);
    }
    send.connect(this.#engine.reverbBus);

    return {
      filter,
      gain,
      panner,
      send,
      source: null,
      generation: 0,
      active: false,
      priority: 0,
      audibility: 0,
      endsAt: 0,
    };
  }

  /** Stops everything. Used on teardown and on restart. */
  stopAll(): void {
    for (const pool of [this.#spatial, this.#flat]) {
      for (const voice of pool) {
        voice.generation++;
        voice.active = false;
        const source = voice.source;
        voice.source = null;
        if (!source) continue;
        try {
          source.onended = null;
          source.stop();
          source.disconnect();
        } catch {
          // Already stopped.
        }
      }
    }
  }
}

const rank = (voice: Voice): number => voice.priority * 1000 + voice.audibility;

/** Mirrors the PannerNode inverse distance model so stealing can predict it. */
function inverseDistanceGain(distance: number): number {
  const ref = TUNING.refDistance;
  const d = Math.min(Math.max(distance, ref), TUNING.maxDistance);
  return ref / (ref + TUNING.rolloffFactor * (d - ref));
}

function setPannerPosition(panner: PannerNode, position: THREE.Vector3, now: number): void {
  if (panner.positionX) {
    panner.positionX.setValueAtTime(position.x, now);
    panner.positionY.setValueAtTime(position.y, now);
    panner.positionZ.setValueAtTime(position.z, now);
    return;
  }
  const legacy = panner as unknown as { setPosition?: (x: number, y: number, z: number) => void };
  legacy.setPosition?.(position.x, position.y, position.z);
}
