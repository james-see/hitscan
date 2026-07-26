import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { Rng } from '@/types/rng.ts';
import type { Unsubscribe } from '@/types/events.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type { CueId } from './catalog.ts';
import { Priority, TUNING, footstepCue, impactCue } from './catalog.ts';
import { AudioEngine } from './AudioEngine.ts';
import { SoundBank } from './SoundBank.ts';
import { VoicePool } from './VoicePool.ts';
import { ReverbRack } from './Reverb.ts';
import { EnclosureProbe, OcclusionSampler } from './Occlusion.ts';

/** Inspection surface for the runtime verification harness and dev console. */
export interface AudioDebugApi {
  /** Resolves once the bank has finished loading (or failed to). */
  ready(): Promise<void>;
  state(): {
    context: string;
    loaded: boolean;
    bank: { cues: number; buffers: number; failures: number; bytes: number };
    voices: { active: number; started: number; stolen: number; dropped: number };
    enclosure: number;
    reverbBlend: number;
    reverbReady: boolean;
    compression: number;
    /** Cues queued to fire later, e.g. the remainder of a reload sequence. */
    pending: number;
  };
  cues(): string[];
  /** Unsmoothed enclosure estimate at a world position, for zone tuning. */
  enclosureAt(x: number, y: number, z: number): number;
  /** Fires a cue by id, optionally at a world position. */
  play(cue: string, position?: [number, number, number]): boolean;
  /**
   * Emits one of every gameplay event this module listens for, with
   * realistic payloads, so the whole path can be exercised from an automated
   * browser session. Returns the number of events emitted.
   */
  selfTest(): number;
  /** Whether physics scene queries are live; occlusion is inert if not. */
  raycastsWork(): boolean;
}

declare global {
  interface Window {
    __hitscanAudio?: AudioDebugApi;
  }
}

const _v = new THREE.Vector3();
const _landing = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const GRAVITY = 9.81;

/** A cue queued to fire at a future context time. */
interface Scheduled {
  at: number;
  tag: string;
  fire: () => void;
}

/**
 * Owns the Web Audio graph: positional sources, reverb and mixing.
 *
 * Entirely event-driven — no other module is imported and none is read
 * except the camera, which drives the listener. Every entry point is
 * defensive: if the `AudioContext` could not be created, is still suspended
 * because no user gesture has happened, or the bank failed to load, all of
 * this degrades to doing nothing rather than throwing. The screenshot harness
 * never interacts with the page, so silence is a supported mode of operation.
 */
export class AudioModule implements GameModule {
  readonly name = 'audio';
  readonly order: number;

  #engine: AudioEngine | null = null;
  #bank: SoundBank | null = null;
  #voices: VoicePool | null = null;
  #reverb: ReverbRack | null = null;
  #occlusion: OcclusionSampler | null = null;
  #enclosure: EnclosureProbe | null = null;
  #rng: Rng | null = null;

  #unsubscribe: Unsubscribe[] = [];
  #scheduled: Scheduled[] = [];
  #ambience: AudioBufferSourceNode | null = null;
  #ambienceGain: GainNode | null = null;

  #ctx: EngineContext | null = null;
  #readyPromise: Promise<void> = Promise.resolve();
  #lastVolumes = { master: -1, sfx: -1, music: -1 };
  #lastShellAt = 0;
  #lastKillAt = 0;
  #capture = false;

  constructor(order = 40) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    this.#ctx = ctx;
    this.#capture = ctx.capture;
    this.#rng = ctx.rng.fork('audio');

    try {
      this.#engine = new AudioEngine();
    } catch (err) {
      console.warn('[audio] Web Audio unavailable; running silent', err);
      this.#installDebugApi();
      return;
    }

    this.#bank = new SoundBank(this.#engine.ctx, this.#rng);
    this.#voices = new VoicePool(this.#engine);
    this.#reverb = new ReverbRack(this.#engine);
    this.#occlusion = new OcclusionSampler(ctx.physics);
    this.#enclosure = new EnclosureProbe(ctx.physics);

    this.#subscribe(ctx);
    this.#installDebugApi();

    // Loading is deliberately not awaited. Blocking `init` would delay the
    // first frame for assets that cannot be heard until the player clicks,
    // and a failure here must never keep the game from booting.
    this.#readyPromise = this.#bank
      .load(ctx.capture)
      .then(() => this.#onBankLoaded())
      .catch((err) => console.warn('[audio] bank load failed', err));
  }

  #onBankLoaded(): void {
    const bank = this.#bank;
    const reverb = this.#reverb;
    if (!bank || !reverb) return;
    reverb.setImpulses(bank.first('ir.courtyard'), bank.first('ir.interior'));
    this.#startAmbience();
  }

  /**
   * The ambience bed is a seamless loop on the music bus, so it obeys the
   * music volume setting and ducks under gunfire. It never starts during a
   * capture: there is nothing to hear and it would only add a live node.
   */
  #startAmbience(): void {
    const engine = this.#engine;
    const bank = this.#bank;
    if (!engine || !bank || this.#capture || this.#ambience) return;
    const buffer = bank.first('ambience.courtyard');
    if (!buffer) return;

    const gain = engine.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(engine.musicBus);

    const source = engine.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();

    // Fade in over two seconds; a bed that snaps on announces itself.
    gain.gain.setTargetAtTime(TUNING.ambienceGain, engine.ctx.currentTime, 0.8);
    this.#ambience = source;
    this.#ambienceGain = gain;
  }

  // -- event wiring ---------------------------------------------------------

  #subscribe(ctx: EngineContext): void {
    const on = ctx.events.on.bind(ctx.events);
    const add = (off: Unsubscribe): void => void this.#unsubscribe.push(off);

    add(on('weapon:fired', ({ origin, shotIndex }) => this.#onPlayerFired(origin, shotIndex)));
    add(on('ai:fired', ({ origin }) => this.#onRemoteFired(origin)));
    add(on('weapon:dry-fired', () => this.#flat('weapon.rifle.dry', Priority.PlayerWeapon)));
    add(on('weapon:impact', (hit) => this.#onImpact(hit.point, hit.surface, hit.actorId !== null)));
    add(on('weapon:shell-ejected', ({ position, velocity }) => this.#onShell(position, velocity)));
    add(on('weapon:reload-started', ({ tactical }) => this.#onReloadStarted(tactical)));
    add(on('weapon:reload-finished', () => this.#onReloadFinished()));
    add(
      on('weapon:ads-changed', ({ ads }) =>
        this.#flat(ads ? 'weapon.rifle.ads.in' : 'weapon.rifle.ads.out', Priority.PlayerBody)
      )
    );

    add(on('player:footstep', ({ position, surface, running }) => this.#onFootstep(position, surface, running)));
    add(on('player:landed', ({ velocity }) => this.#onLanded(velocity)));
    add(on('player:jumped', () => this.#flat('player.jump', Priority.PlayerBody, 0.7)));

    add(on('ui:hitmarker', ({ headshot, lethal }) => this.#onHitmarker(headshot, lethal)));
    add(on('combat:actor-died', () => this.#onActorDied()));
    add(on('combat:player-damaged', () => this.#onPlayerDamaged()));

    add(on('game:paused', ({ paused }) => this.#engine?.setPaused(paused, ctx.settings)));
    add(on('game:restart', () => this.#reset()));
    add(on('engine:pointer-lock', () => this.#engine?.tryResume()));
  }

  // -- weapon ---------------------------------------------------------------

  /**
   * The player's own weapon is played flat rather than positional: it
   * originates a few centimetres from the listener, where HRTF panning has
   * nothing useful to say and only colours the sound. The room's answer to
   * the shot still arrives via the reverb send.
   */
  #onPlayerFired(origin: THREE.Vector3, shotIndex: number): void {
    const engine = this.#engine;
    const bank = this.#bank;
    const voices = this.#voices;
    const rng = this.#rng;
    if (!engine?.running || !bank || !voices || !rng) return;

    const buffer = bank.pick('weapon.rifle.fire.close');
    if (!buffer) return;

    voices.playFlat({
      buffer,
      gain: bank.gainOf('weapon.rifle.fire.close') * this.#gainJitter(rng),
      priority: Priority.PlayerWeapon,
      playbackRate: this.#pitchJitter(rng),
      // Held slightly below the world send: the player's own muzzle blast is
      // dominated by the direct path, and a heavy send makes it sound like it
      // was fired from across the courtyard.
      reverbSend: 0.22,
    });
    engine.duck();

    // Sustained fire is where a static sample gives itself away. Beyond the
    // first few rounds the barrel is also feeding the room, so a touch of the
    // distant layer at very low level thickens the string of shots without
    // adding another close transient.
    if (shotIndex > 2) {
      const tail = bank.pick('weapon.rifle.fire.distant');
      if (tail) {
        voices.playFlat({
          buffer: tail,
          gain: bank.gainOf('weapon.rifle.fire.distant') * 0.16,
          priority: Priority.PlayerWeapon - 5,
          playbackRate: this.#pitchJitter(rng),
          reverbSend: 0.3,
        });
      }
    }
    void origin;
  }

  #onRemoteFired(origin: THREE.Vector3): void {
    this.#playPositionalGunshot(origin, Priority.EnemyWeapon);
  }

  /**
   * Distance-layered gunfire.
   *
   * Close and distant stems are crossfaded by range with an equal-power
   * curve, and the whole event is delayed by the propagation time. A shot
   * from fifty metres should be tail, not a quiet crack: this single split
   * does more for the sense of space than any amount of filtering on one
   * layer, because the spectral *shape* of distant gunfire is different, not
   * just its level.
   */
  #playPositionalGunshot(position: THREE.Vector3, priority: number): void {
    const engine = this.#engine;
    const bank = this.#bank;
    const voices = this.#voices;
    const rng = this.#rng;
    if (!engine?.running || !bank || !voices || !rng) return;

    const distance = position.distanceTo(engine.listenerPosition);
    const t = smoothstep(TUNING.distantFadeStart, TUNING.distantFadeEnd, distance);
    const closeMix = Math.cos((t * Math.PI) / 2);
    const distantMix = Math.sin((t * Math.PI) / 2);

    const delay =
      distance > TUNING.propagationMinDistance
        ? Math.min(distance / TUNING.speedOfSound, TUNING.maxPropagationDelay)
        : 0;
    const occlusion = this.#occlusion?.sample(engine.listenerPosition, position, engine.now) ?? 0;

    if (closeMix > 0.05) {
      const buffer = bank.pick('weapon.rifle.fire.close');
      if (buffer) {
        voices.playSpatial({
          buffer,
          gain: bank.gainOf('weapon.rifle.fire.close') * closeMix * this.#gainJitter(rng),
          priority,
          position,
          playbackRate: this.#pitchJitter(rng),
          delay,
          occlusion,
          reverbSend: 0.34,
        });
      }
    }
    if (distantMix > 0.05) {
      const buffer = bank.pick('weapon.rifle.fire.distant');
      if (buffer) {
        voices.playSpatial({
          buffer,
          // The distant stem is already dark and diffuse, so a wall in the
          // way changes it far less than it changes the direct crack.
          gain: bank.gainOf('weapon.rifle.fire.distant') * distantMix * this.#gainJitter(rng),
          priority: priority - 2,
          position,
          playbackRate: this.#pitchJitter(rng),
          delay,
          occlusion: occlusion * 0.45,
          reverbSend: 0.5,
        });
      }
    }
  }

  /**
   * Reload is a scheduled sequence, not one sample.
   *
   * The event carries no duration, so the timings below are a plausible
   * default and `weapon:reload-finished` compresses whatever is left: if the
   * weapon finished early the remaining step fires immediately, and if it
   * finished late the sequence simply completed first. See the report for the
   * `durationMs` field that would let this be exact.
   */
  #onReloadStarted(tactical: boolean): void {
    this.#cancelScheduled('reload');
    if (tactical) {
      this.#schedule('reload', 0.08, () => this.#flat('weapon.rifle.mag.out', Priority.PlayerBody));
      this.#schedule('reload.final', 0.62, () => this.#flat('weapon.rifle.mag.in', Priority.PlayerBody));
      return;
    }
    this.#schedule('reload', 0.1, () => this.#flat('weapon.rifle.mag.out', Priority.PlayerBody));
    this.#schedule('reload', 0.78, () => this.#flat('weapon.rifle.mag.in', Priority.PlayerBody));
    this.#schedule('reload', 1.18, () => this.#flat('weapon.rifle.charge.pull', Priority.PlayerBody));
    this.#schedule('reload.final', 1.32, () =>
      this.#flat('weapon.rifle.charge.release', Priority.PlayerBody)
    );
  }

  #onReloadFinished(): void {
    const pending = this.#scheduled.filter((s) => s.tag.startsWith('reload'));
    if (pending.length === 0) return;
    const final = pending.find((s) => s.tag === 'reload.final');
    this.#cancelScheduled('reload');
    // The weapon is loaded; the sound has to agree, even if it was mid-way
    // through the mechanical sequence.
    final?.fire();
  }

  // -- world ----------------------------------------------------------------

  #onImpact(point: THREE.Vector3, surface: Parameters<typeof impactCue>[0], onActor: boolean): void {
    const bank = this.#bank;
    const rng = this.#rng;
    if (!this.#engine?.running || !bank || !this.#voices || !rng) return;
    const cue = onActor ? 'impact.flesh' : impactCue(surface);
    const buffer = bank.pick(cue);
    if (!buffer) return;
    this.#voices.playSpatial({
      buffer,
      gain: bank.gainOf(cue) * this.#gainJitter(rng, 1.4),
      priority: Priority.Impact,
      position: point,
      // Impacts get wider pitch variation than gunfire: they are the most
      // repeated sound in the game and the ear latches onto any pattern.
      playbackRate: this.#pitchJitter(rng, 2.6),
      occlusion: this.#occlusion?.sample(this.#engine.listenerPosition, point, this.#engine.now) ?? 0,
    });
  }

  /**
   * Casings are pitched at ejection but heard when they land. Solving the
   * ballistic arc for the landing time and position costs nothing and is the
   * difference between a tinkle glued to the muzzle and one that skitters
   * away across the concrete.
   */
  #onShell(position: THREE.Vector3, velocity: THREE.Vector3): void {
    const engine = this.#engine;
    const bank = this.#bank;
    const rng = this.#rng;
    if (!engine?.running || !bank || !this.#voices || !rng) return;
    if (engine.now - this.#lastShellAt < TUNING.shellMinInterval) return;
    this.#lastShellAt = engine.now;

    const buffer = bank.pick('shell.bounce');
    if (!buffer) return;

    // Ground is approximated as the listener's foot height rather than
    // raycast: a casing lands within a metre or two of the player, and being
    // wrong by a step's worth of elevation is inaudible.
    const height = Math.min(3, Math.max(0.25, position.y - (engine.listenerPosition.y - 1.6)));
    const vy = velocity.y;
    const flight = Math.min(1.2, (vy + Math.sqrt(vy * vy + 2 * GRAVITY * height)) / GRAVITY);
    _landing.set(position.x + velocity.x * flight, position.y - height, position.z + velocity.z * flight);

    this.#voices.playSpatial({
      buffer,
      gain: bank.gainOf('shell.bounce') * this.#gainJitter(rng, 2),
      priority: Priority.Shell,
      position: _landing,
      playbackRate: this.#pitchJitter(rng, 4),
      delay: flight,
      reverbSend: 0.2,
    });
  }

  #onFootstep(
    position: THREE.Vector3,
    surface: Parameters<typeof footstepCue>[0],
    running: boolean
  ): void {
    const bank = this.#bank;
    const rng = this.#rng;
    if (!this.#engine?.running || !bank || !this.#voices || !rng) return;
    const cue = footstepCue(surface);
    const buffer = bank.pick(cue);
    if (!buffer) return;
    this.#voices.playSpatial({
      buffer,
      // A run puts more weight through the heel and shortens the contact,
      // which is louder and slightly brighter, hence the rate bump.
      gain: bank.gainOf(cue) * (running ? 1.45 : 1) * this.#gainJitter(rng, 1.6),
      priority: Priority.Footstep,
      position,
      playbackRate: this.#pitchJitter(rng, 3) * (running ? 1.06 : 1),
      reverbSend: 0.22,
    });
  }

  #onLanded(velocity: number): void {
    const speed = Math.abs(velocity);
    // Below walking-off-a-kerb speed a landing is just another footstep.
    if (speed < 1.5) return;
    const hard = speed > 7;
    this.#flat(
      hard ? 'player.land.hard' : 'player.land.soft',
      Priority.PlayerBody,
      Math.min(1, 0.55 + speed / 18)
    );
  }

  #onHitmarker(headshot: boolean, lethal: boolean): void {
    if (lethal) {
      this.#lastKillAt = this.#engine?.now ?? 0;
      this.#flat('ui.hit.kill', Priority.Ui);
      return;
    }
    this.#flat(headshot ? 'ui.hit.head' : 'ui.hit', Priority.Ui);
  }

  #onActorDied(): void {
    const engine = this.#engine;
    if (!engine?.running) return;
    // The UI usually reports the kill through `ui:hitmarker` with `lethal`
    // set; this is the fallback for deaths that arrive without one, deduped
    // so a kill never ticks twice.
    if (engine.now - this.#lastKillAt < 0.3) return;
    this.#lastKillAt = engine.now;
    this.#flat('ui.hit.kill', Priority.Ui, 0.8);
  }

  #onPlayerDamaged(): void {
    this.#flat('player.hurt', Priority.PlayerBody);
    this.#engine?.duck();
  }

  // -- helpers --------------------------------------------------------------

  #flat(cue: CueId, priority: number, gainScale = 1): boolean {
    const bank = this.#bank;
    const rng = this.#rng;
    if (!this.#engine?.running || !bank || !this.#voices || !rng) return false;
    const buffer = bank.pick(cue);
    if (!buffer) return false;
    return this.#voices.playFlat({
      buffer,
      gain: bank.gainOf(cue) * gainScale * this.#gainJitter(rng),
      priority,
      playbackRate: this.#pitchJitter(rng),
      reverbSend: 0.16,
    });
  }

  /**
   * Per-shot pitch variation. Gaussian rather than uniform so most rounds sit
   * near nominal and the occasional one strays, which is how a real cyclic
   * rate varies; a uniform spread sounds detuned rather than alive.
   */
  #pitchJitter(rng: Rng, scale = 1): number {
    const spread = TUNING.pitchJitter * scale;
    return 1 + Math.max(-3 * spread, Math.min(3 * spread, rng.gaussian(0, spread)));
  }

  #gainJitter(rng: Rng, scale = 1): number {
    return 1 - rng.next() * (1 - TUNING.gainJitter) * scale;
  }

  #schedule(tag: string, delay: number, fire: () => void): void {
    const engine = this.#engine;
    if (!engine) return;
    this.#scheduled.push({ at: engine.now + delay, tag, fire });
  }

  #cancelScheduled(prefix: string): void {
    this.#scheduled = this.#scheduled.filter((s) => !s.tag.startsWith(prefix));
  }

  #reset(): void {
    this.#scheduled.length = 0;
    this.#voices?.stopAll();
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Runs after every other module's update so the listener matches the camera
   * the player is about to see, not the one from the previous frame.
   */
  lateUpdate(dt: number, ctx: EngineContext): void {
    const engine = this.#engine;
    if (!engine) return;

    const settings = ctx.settings;
    if (
      settings.masterVolume !== this.#lastVolumes.master ||
      settings.sfxVolume !== this.#lastVolumes.sfx ||
      settings.musicVolume !== this.#lastVolumes.music
    ) {
      this.#lastVolumes = {
        master: settings.masterVolume,
        sfx: settings.sfxVolume,
        music: settings.musicVolume,
      };
      engine.applySettings(settings);
    }

    if (!engine.running) return;

    engine.updateListener(ctx.camera);
    this.#occlusion?.beginFrame();

    if (ctx.physics.ready && this.#enclosure && this.#reverb) {
      this.#enclosure.update(engine.listenerPosition, Math.max(1 / 240, dt));
      this.#reverb.setEnclosure(this.#enclosure.value);
    }

    if (this.#scheduled.length > 0) {
      const now = engine.now;
      // Iterating backwards lets a fired entry be spliced out in place.
      for (let i = this.#scheduled.length - 1; i >= 0; i--) {
        const entry = this.#scheduled[i];
        if (entry.at > now) continue;
        this.#scheduled.splice(i, 1);
        entry.fire();
      }
    }

    // The bed cannot start until a gesture unlocks the context, which may
    // happen long after the bank finished loading.
    if (!this.#ambience && this.#bank?.loaded) this.#startAmbience();
  }

  #installDebugApi(): void {
    window.__hitscanAudio = {
      ready: (): Promise<void> => this.#readyPromise,
      state: () => ({
        context: this.#engine?.ctx.state ?? 'unavailable',
        loaded: this.#bank?.loaded ?? false,
        bank: this.#bank?.stats() ?? { cues: 0, buffers: 0, failures: 0, bytes: 0 },
        voices: this.#voices?.stats ?? { active: 0, started: 0, stolen: 0, dropped: 0 },
        enclosure: this.#enclosure?.value ?? 0,
        reverbBlend: this.#reverb?.blend ?? 0,
        reverbReady: this.#reverb?.ready ?? false,
        compression: this.#engine?.compression ?? 0,
        pending: this.#scheduled.length,
      }),
      cues: () => this.#bank?.cueIds() ?? [],
      enclosureAt: (x: number, y: number, z: number): number =>
        this.#enclosure?.sampleAt(_v.set(x, y, z)) ?? 0,
      play: (cue: string, position?: [number, number, number]): boolean => {
        const bank = this.#bank;
        if (!bank || !this.#voices || !this.#engine?.running) return false;
        const buffer = bank.pick(cue as CueId);
        if (!buffer) return false;
        if (position) {
          return this.#voices.playSpatial({
            buffer,
            gain: bank.gainOf(cue as CueId),
            priority: Priority.Impact,
            position: _v.set(position[0], position[1], position[2]),
            occlusion:
              this.#occlusion?.sample(this.#engine.listenerPosition, _v, this.#engine.now) ?? 0,
          });
        }
        return this.#voices.playFlat({
          buffer,
          gain: bank.gainOf(cue as CueId),
          priority: Priority.Ui,
          reverbSend: 0.2,
        });
      },
      selfTest: (): number => this.#selfTest(),
      raycastsWork: (): boolean => {
        // Occlusion and reverb zoning both depend on scene queries, so a
        // physics world whose query pipeline is never updated disables them
        // silently. Casting straight down from above the arena is the
        // cheapest unambiguous test that queries return anything at all.
        const physics = this.#ctx?.physics;
        if (!physics) return false;
        return (
          physics.raycast({
            origin: _v.set(0, 40, 0),
            direction: DOWN,
            maxDistance: 80,
            groups: CollisionGroup.World,
          }) !== null
        );
      },
    };
  }

  /**
   * Drives the module through the event bus exactly as the rest of the game
   * would. Positions are placed relative to the listener so the test covers
   * both the close and distant sides of the gunfire crossfade, and both the
   * occluded and clear branches of the spatial path.
   */
  #selfTest(): number {
    const ctx = this.#ctx;
    const engine = this.#engine;
    if (!ctx || !engine) return 0;
    const at = (dx: number, dy: number, dz: number): THREE.Vector3 =>
      new THREE.Vector3(
        engine.listenerPosition.x + dx,
        engine.listenerPosition.y + dy,
        engine.listenerPosition.z + dz
      );
    const events = ctx.events;
    let count = 0;
    const emit = (fn: () => void): void => {
      fn();
      count++;
    };

    for (let i = 0; i < 4; i++) {
      emit(() =>
        events.emit('weapon:fired', {
          weaponId: 'rifle',
          origin: at(0.2, -0.1, -0.4),
          direction: new THREE.Vector3(0, 0, -1),
          ammo: 29 - i,
          shotIndex: i,
        })
      );
      emit(() =>
        events.emit('weapon:shell-ejected', {
          position: at(0.35, -0.05, -0.2),
          velocity: new THREE.Vector3(2.1, 1.4, 0.3),
        })
      );
    }

    emit(() => events.emit('weapon:dry-fired', { weaponId: 'rifle' }));
    emit(() => events.emit('weapon:ads-changed', { weaponId: 'rifle', ads: true }));
    emit(() => events.emit('weapon:reload-started', { weaponId: 'rifle', tactical: false }));

    for (const [surface, offset] of [
      ['concrete', 6],
      ['metal', 14],
      ['wood', 25],
      ['flesh', 9],
    ] as const) {
      emit(() =>
        events.emit('weapon:impact', {
          point: at(offset * 0.4, 0.3, -offset),
          normal: new THREE.Vector3(0, 0, 1),
          distance: offset,
          surface,
          actorId: surface === 'flesh' ? 'bot-1' : null,
          hitbox: surface === 'flesh' ? 'torso' : null,
          direction: new THREE.Vector3(0, 0, -1),
          penetrationDepth: 0,
        })
      );
    }

    emit(() =>
      events.emit('player:footstep', { position: at(0, -1.6, 0), surface: 'concrete', running: true })
    );
    emit(() => events.emit('player:jumped'));
    emit(() => events.emit('player:landed', { velocity: 9.2, surface: 'concrete' }));

    // Near and far, to exercise both ends of the close/distant crossfade and
    // the propagation delay.
    emit(() => events.emit('ai:fired', { actorId: 'bot-1', origin: at(4, 0, -6), direction: new THREE.Vector3(0, 0, 1) }));
    emit(() => events.emit('ai:fired', { actorId: 'bot-2', origin: at(-18, 0, -42), direction: new THREE.Vector3(0, 0, 1) }));

    emit(() => events.emit('ui:hitmarker', { headshot: false, lethal: false }));
    emit(() => events.emit('ui:hitmarker', { headshot: true, lethal: false }));
    emit(() => events.emit('ui:hitmarker', { headshot: false, lethal: true }));
    emit(() =>
      events.emit('combat:player-damaged', { amount: 24, from: at(3, 0, -8), health: 62 })
    );
    return count;
  }

  dispose(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#scheduled.length = 0;
    this.#voices?.stopAll();
    try {
      this.#ambience?.stop();
      this.#ambience?.disconnect();
      this.#ambienceGain?.disconnect();
    } catch {
      // Never started.
    }
    this.#ambience = null;
    this.#ambienceGain = null;
    this.#engine?.dispose();
    this.#engine = null;
    if (window.__hitscanAudio) delete window.__hitscanAudio;
  }
}

/** Hermite ease between two edges; C1 continuous, unlike a linear ramp. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
