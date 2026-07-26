import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { InputAction, InputState } from '@/types/input.ts';
import type { PlayerState, WeaponDefinition, WeaponState } from '@/types/gameplay.ts';
import type { Rng } from '@/types/rng.ts';
import { MK4_CARBINE } from './WeaponDefinitions.ts';
import { Ballistics, type ActorLookup } from './Ballistics.ts';
import { RecoilController } from './Recoil.ts';
import { SpreadController } from './Spread.ts';
import { ViewmodelRig, type RigInput } from './ViewmodelRig.ts';
import { DRAW, INSPECT, RELOAD_EMPTY, RELOAD_TACTICAL, WeaponAnimator } from './WeaponAnimator.ts';
import { Spring1, damp, easeOutQuint } from './Springs.ts';

/** The slice of the player module the weapon reads. Duck-typed, never imported. */
interface PlayerLike {
  readonly state: PlayerState;
  readonly yaw: number;
  readonly pitch: number;
  addViewKick(pitchDelta: number, yawDelta: number): void;
}

/** Set by the engine's input implementation; absent from the public contract. */
type SensitivityScalable = InputState & { sensitivityMultiplier?: number };

/** Player speed treated as "full movement" by spread and bob. */
const REFERENCE_SPEED = 7.1;
/** Delay between the shot and the case clearing the port, in seconds. */
const SHELL_EJECT_DELAY = 0.035;
/** Cadence limit on dry-firing, so holding the trigger is not a rattle. */
const DRY_FIRE_INTERVAL = 0.32;
const DRAW_TIME = 0.62;
const INSPECT_TIME = 2.7;

const _direction = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _velocity = new THREE.Vector3();

/**
 * Tracks press/release edges across the fixed step.
 *
 * `wasPressed` is a per-frame signal, and a frame can contain zero or several
 * fixed steps, so consuming it directly would drop or duplicate inputs
 * depending on frame rate. Held state is edge-detected inside the fixed step
 * instead, with a latch that only catches taps short enough to have begun and
 * ended inside a single frame.
 */
class ActionEdge {
  #down = false;
  #latched = false;

  constructor(private readonly action: InputAction) {}

  /** Called once per frame, after the fixed steps. */
  observe(input: InputState): void {
    if (input.wasPressed(this.action) && input.wasReleased(this.action)) this.#latched = true;
  }

  /** Called once per fixed step. */
  poll(input: InputState): { down: boolean; pressed: boolean; released: boolean } {
    const down = input.isDown(this.action);
    const pressed = (down && !this.#down) || this.#latched;
    const released = !down && this.#down;
    this.#latched = false;
    this.#down = down;
    return { down, pressed, released };
  }
}

/**
 * Owns the equipped weapon: viewmodel, animation, state machine and
 * ballistics.
 *
 * Simulation runs entirely in `fixedUpdate` at 120Hz — fire cadence, recoil,
 * spread and every spring in the rig — so the weapon behaves identically at
 * 60 and 240fps. `update` only interpolates the rig pose and applies the
 * camera-side effects (field of view, look sensitivity) that must land on the
 * frame being drawn.
 */
export class WeaponModule implements GameModule {
  readonly name = 'weapon';
  readonly order: number;

  #definition: WeaponDefinition = MK4_CARBINE;
  #rig = new ViewmodelRig();
  #animator = new WeaponAnimator();
  #recoil = new RecoilController();
  #spread = new SpreadController();
  #ballistics!: Ballistics;
  #rng!: Rng;
  #player: PlayerLike | null = null;

  #ammo = MK4_CARBINE.magazineSize;
  #reserve = MK4_CARBINE.reserveAmmo;

  #adsIntent = false;
  #adsProgress = 0;
  #adsEased = 0;

  #reloading = false;
  #reloadTimer = 0;
  #reloadDuration = 0;
  #reloadCommit = 0;
  #reloadTactical = false;

  #cooldown = 0;
  #semiLatched = false;
  #burstRemaining = 0;
  #shotIndex = 0;
  #sinceFire = Infinity;
  #dryFireTimer = 0;
  #firing = false;
  #triggerPull = 0;
  #sprintWeight = 0;

  #fireEdge = new ActionEdge('fire');
  #reloadEdge = new ActionEdge('reload');
  #inspectEdge = new ActionEdge('inspect');

  #lastYaw = 0;
  #lastPitch = 0;
  #fovKick = new Spring1(5.5, 0.55);
  #fovOverridden = false;
  #shellQueue: number[] = [];
  #unsubscribe: Array<() => void> = [];
  #poseOverride: string | null = null;

  constructor(order = 10) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    this.#rng = ctx.rng.fork('weapon');
    this.#rig.init(ctx);

    this.#player = ctx.getModule<GameModule & PlayerLike>('player') ?? null;
    this.#lastYaw = this.#player?.yaw ?? 0;
    this.#lastPitch = this.#player?.pitch ?? 0;

    // The AI module owns actors and is built independently; ballistics reads
    // whatever it exposes and resolves world-only hits until it does.
    const ai = ctx.getModule<GameModule & ActorLookup>('ai');
    this.#ballistics = new Ballistics(ctx.physics, ctx.events, ai ?? {});

    this.#unsubscribe.push(
      ctx.events.on('player:landed', ({ velocity }) => this.#rig.addLandingImpact(velocity)),
      ctx.events.on('player:jumped', () => this.#rig.addJumpImpulse())
    );

    this.#animator.play(DRAW, DRAW_TIME);
    ctx.events.emit('weapon:equipped', { weaponId: this.#definition.id });

    if (ctx.capture) this.#applyCapturePose(ctx);
  }

  /**
   * Capture-only pose override.
   *
   * The critic harness drives no input, so the ADS and reload poses are
   * otherwise unphotographable. `?vm=ads|sprint|reload|inspect` forces one of
   * them for the duration of a capture run.
   */
  #applyCapturePose(ctx: EngineContext): void {
    const params = new URLSearchParams(window.location.search);
    const debug = params.get('vmdebug');
    if (debug === 'flat' || debug === 'hide' || debug === 'hands') {
      this.#rig.setDebugSilhouette(debug);
    }
    const requested = params.get('vm');
    if (!requested) return;
    this.#poseOverride = requested;
    this.#animator.cancel();
    switch (requested) {
      case 'ads':
        this.#adsProgress = 1;
        this.#adsEased = 1;
        this.#adsIntent = true;
        break;
      case 'sprint':
        this.#sprintWeight = 1;
        break;
      case 'reload':
        this.#ammo = 0;
        this.#startReload(ctx);
        break;
      case 'inspect':
        this.#animator.play(INSPECT, INSPECT_TIME);
        break;
      default:
        this.#poseOverride = null;
        return;
    }
    // `vmt` scrubs to a normalised point in the clip, since a capture cannot
    // watch an animation play.
    const scrub = Number(params.get('vmt') ?? '0');
    if (scrub > 0 && this.#animator.playing) {
      this.#animator.step(scrub * this.#reloadDuration || scrub * INSPECT_TIME);
    }
    this.#reloading = false;
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    if (this.#poseOverride) {
      this.#stepFrozen(dt, ctx);
      return;
    }
    const input = ctx.input;
    const player = this.#player;
    const playerState = player?.state ?? null;
    const definition = this.#definition;

    const fire = this.#fireEdge.poll(input);
    const reload = this.#reloadEdge.poll(input);
    const inspect = this.#inspectEdge.poll(input);
    const aimDown = input.isDown('aim');

    this.#sinceFire += dt;
    this.#dryFireTimer = Math.max(0, this.#dryFireTimer - dt);
    if (!fire.down) this.#semiLatched = false;

    // -- stance -------------------------------------------------------------
    // The weapon leaves the sprint pose on its own the moment the player
    // shows intent to shoot; waiting for the player module to drop its sprint
    // flag would cost an extra frame on every engagement.
    const wantsSprint =
      (playerState?.sprinting ?? false) &&
      !this.#reloading &&
      !aimDown &&
      !fire.down &&
      this.#sinceFire > 0.22;
    this.#sprintWeight = damp(this.#sprintWeight, wantsSprint ? 1 : 0, wantsSprint ? 8 : 17, dt);

    // -- reload -------------------------------------------------------------
    if (reload.pressed) this.#startReload(ctx);
    this.#stepReload(dt, ctx, fire.pressed);

    // -- inspect ------------------------------------------------------------
    if (inspect.pressed && !this.#reloading && this.#animator.clipId === null) {
      this.#animator.play(INSPECT, INSPECT_TIME);
    }
    if (this.#animator.clipId === 'inspect' && (fire.down || aimDown || reload.pressed)) {
      this.#animator.cancel();
    }

    // -- aim down sights ----------------------------------------------------
    const adsAllowed = !this.#reloading && this.#sprintWeight < 0.55;
    const wantsAds = aimDown && adsAllowed;
    if (wantsAds !== this.#adsIntent) {
      this.#adsIntent = wantsAds;
      ctx.events.emit('weapon:ads-changed', { weaponId: definition.id, ads: wantsAds });
    }
    // Coming out of the sights is quicker than going in, which is what makes
    // a quick-scope-and-reposition feel responsive rather than sticky.
    const adsRate = dt / Math.max(0.01, this.#adsIntent ? definition.adsTime : definition.adsTime * 0.82);
    this.#adsProgress = THREE.MathUtils.clamp(
      this.#adsProgress + (this.#adsIntent ? adsRate : -adsRate),
      0,
      1
    );
    this.#adsEased = easeOutQuint(this.#adsProgress);

    // -- fire control -------------------------------------------------------
    this.#stepFireControl(dt, ctx, fire.down, fire.pressed);

    // -- recoil recovery ----------------------------------------------------
    const correction = { pitch: 0, yaw: 0 };
    this.#recoil.step(dt, definition.recoil, correction);
    if (correction.pitch !== 0 || correction.yaw !== 0) {
      player?.addViewKick(correction.pitch, correction.yaw);
    }

    // -- spread -------------------------------------------------------------
    this.#spread.step(dt, definition.spread, {
      ads: this.#adsEased,
      speed: playerState?.speed ?? 0,
      maxSpeed: REFERENCE_SPEED,
      grounded: playerState?.grounded ?? true,
      crouching: playerState?.crouching ?? false,
    });

    // -- deferred shell ejection -------------------------------------------
    for (let i = this.#shellQueue.length - 1; i >= 0; i--) {
      const remaining = (this.#shellQueue[i] as number) - dt;
      if (remaining <= 0) {
        this.#shellQueue.splice(i, 1);
        this.#emitShell(ctx);
      } else {
        this.#shellQueue[i] = remaining;
      }
    }

    // -- animation and rig --------------------------------------------------
    const animation = this.#animator.step(dt);
    this.#triggerPull = damp(this.#triggerPull, this.#firing ? 1 : 0, 26, dt);
    this.#fovKick.step(dt);

    const yaw = player?.yaw ?? 0;
    const pitch = player?.pitch ?? 0;
    const rigInput: RigInput = {
      ads: this.#adsEased,
      sprint: this.#sprintWeight,
      speed: playerState?.speed ?? 0,
      maxSpeed: REFERENCE_SPEED,
      grounded: playerState?.grounded ?? true,
      crouching: playerState?.crouching ?? false,
      // Recoil has already been folded into the player's view; measuring the
      // delta after applying it keeps the weapon from swaying at its own kick.
      yawDelta: yaw - this.#lastYaw,
      pitchDelta: pitch - this.#lastPitch,
      velocity: playerState?.velocity ?? _velocity.set(0, 0, 0),
      yaw,
      animation,
      triggerPull: this.#triggerPull,
      swayScale: ctx.settings.viewmodelSwayScale,
      idle: !ctx.capture,
      elapsed: ctx.time.elapsed,
    };
    this.#rig.fixedStep(dt, rigInput, ctx);

    this.#lastYaw = player?.yaw ?? 0;
    this.#lastPitch = player?.pitch ?? 0;
  }

  update(dt: number, ctx: EngineContext): void {
    this.#fireEdge.observe(ctx.input);
    this.#reloadEdge.observe(ctx.input);
    this.#inspectEdge.observe(ctx.input);

    this.#rig.render(ctx.time.alpha, ctx);
    this.#rig.applyFov(ctx, this.#adsEased);
    this.#rig.setReticleIntensity(this.#adsEased);
    this.#applyCameraFov(ctx);

    const input = ctx.input as SensitivityScalable;
    if (input.sensitivityMultiplier !== undefined) {
      // Matching the sensitivity to the zoom keeps the same mouse travel on
      // target whether the player is hip-firing or aimed.
      input.sensitivityMultiplier = damp(
        input.sensitivityMultiplier,
        THREE.MathUtils.lerp(1, ctx.input.adsSensitivityScale, this.#adsEased),
        30,
        dt
      );
    }
  }

  /** Holds the forced capture pose steady while the springs settle. */
  #stepFrozen(dt: number, ctx: EngineContext): void {
    this.#rig.fixedStep(
      dt,
      {
        ads: this.#adsEased,
        sprint: this.#sprintWeight,
        speed: 0,
        maxSpeed: REFERENCE_SPEED,
        grounded: true,
        crouching: false,
        yawDelta: 0,
        pitchDelta: 0,
        velocity: _velocity.set(0, 0, 0),
        yaw: 0,
        animation: this.#animator.output,
        triggerPull: 0,
        swayScale: 0,
        idle: false,
        elapsed: ctx.time.elapsed,
      },
      ctx
    );
  }

  // -- fire control ---------------------------------------------------------

  #stepFireControl(dt: number, ctx: EngineContext, held: boolean, pressed: boolean): void {
    const definition = this.#definition;
    const interval = 60 / definition.fireRate;
    this.#cooldown -= dt;

    if (pressed) {
      this.#shotIndex = 0;
      if (definition.fireMode === 'burst') {
        this.#burstRemaining = definition.burstCount ?? 3;
      }
    }

    let wantsShot: boolean;
    switch (definition.fireMode) {
      case 'semi':
        wantsShot = held && !this.#semiLatched;
        break;
      case 'burst':
        wantsShot = this.#burstRemaining > 0;
        break;
      case 'auto':
      default:
        wantsShot = held;
        break;
    }

    // Blocked states still consume the trigger pull, so a player who fires
    // mid-sprint does not get a free stored shot when the weapon comes up.
    const blocked =
      this.#reloading ||
      this.#sprintWeight > 0.3 ||
      (this.#animator.clipId === 'draw' && !this.#animator.cancellable);
    this.#firing = wantsShot && !blocked && this.#ammo > 0;

    if (!wantsShot || blocked) {
      if (this.#cooldown < 0) this.#cooldown = 0;
      return;
    }

    if (this.#ammo <= 0) {
      if (this.#reserve > 0) {
        this.#startReload(ctx);
      } else if (pressed || (held && this.#dryFireTimer <= 0)) {
        ctx.events.emit('weapon:dry-fired', { weaponId: definition.id });
        this.#dryFireTimer = DRY_FIRE_INTERVAL;
      }
      this.#semiLatched = true;
      this.#burstRemaining = 0;
      if (this.#cooldown < 0) this.#cooldown = 0;
      return;
    }

    if (this.#cooldown > 0) return;

    this.#fireRound(ctx);
    this.#semiLatched = true;
    if (definition.fireMode === 'burst') {
      this.#burstRemaining--;
      // A burst reloads its own trigger faster than a fresh pull can.
      this.#cooldown += this.#burstRemaining > 0 ? interval : interval * 2.2;
    } else {
      // Carrying the remainder rather than resetting keeps the cadence exact:
      // an 85.7ms interval on an 8.3ms step would otherwise round to 640rpm.
      this.#cooldown += interval;
    }
  }

  #fireRound(ctx: EngineContext): void {
    const definition = this.#definition;
    const player = this.#player;
    const yaw = player?.yaw ?? 0;
    const pitch = player?.pitch ?? 0;

    // Aim is taken before this shot's kick lands: the round leaves the barrel
    // before the weapon moves, which is what makes the first shot trustworthy.
    const cosPitch = Math.cos(pitch);
    _direction.set(-Math.sin(yaw) * cosPitch, Math.sin(pitch), -Math.cos(yaw) * cosPitch).normalize();
    this.#spread.applyCone(_direction, this.#spread.degrees, this.#rng);

    this.#ammo--;
    this.#spread.onShot(definition.spread);
    this.#sinceFire = 0;

    const adsFactor = THREE.MathUtils.lerp(1, definition.recoil.adsMultiplier, this.#adsEased);
    const impulse = this.#recoil.fire(definition.recoil, adsFactor, this.#rng);
    player?.addViewKick(impulse.pitch, impulse.yaw);
    this.#rig.addRecoil(impulse.strength, this.#adsEased, this.#rng);
    this.#fovKick.impulse(-9 * ctx.settings.fovKickScale * (1 - 0.5 * this.#adsEased));

    this.#rig.markerToWorld(this.#rig.parts.muzzle, ctx, _muzzle);
    ctx.events.emit('weapon:fired', {
      weaponId: definition.id,
      origin: _muzzle.clone(),
      direction: _direction.clone(),
      ammo: this.#ammo,
      shotIndex: this.#shotIndex,
    });
    this.#shotIndex++;

    // Hit resolution starts at the eye, not the muzzle: a round that spawns
    // at the barrel would clip cover the player can see past.
    this.#ballistics.fire({
      origin: ctx.camera.position,
      direction: _direction,
      definition,
      shooterId: 'player',
    });

    this.#shellQueue.push(SHELL_EJECT_DELAY);

    if (this.#ammo === 0 && this.#reserve > 0) this.#startReload(ctx);
  }

  #emitShell(ctx: EngineContext): void {
    this.#rig.markerToWorld(this.#rig.parts.ejectionPort, ctx, _muzzle);
    _right.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
    _up.set(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
    _direction.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);

    _velocity
      .copy(_right)
      .multiplyScalar(this.#rng.range(2.1, 3.2))
      .addScaledVector(_up, this.#rng.range(0.9, 1.7))
      .addScaledVector(_direction, this.#rng.range(-0.6, 0.1));
    const playerVelocity = this.#player?.state.velocity;
    if (playerVelocity) _velocity.add(playerVelocity);

    ctx.events.emit('weapon:shell-ejected', {
      position: _muzzle.clone(),
      velocity: _velocity.clone(),
    });
  }

  // -- reload ---------------------------------------------------------------

  #startReload(ctx: EngineContext): void {
    if (this.#reloading) return;
    if (this.#reserve <= 0 || this.#ammo >= this.#definition.magazineSize) return;
    if (this.#animator.clipId === 'draw' && !this.#animator.cancellable) return;

    const tactical = this.#ammo > 0;
    const duration = tactical
      ? this.#definition.reloadTimeTactical
      : this.#definition.reloadTime;
    const clip = tactical ? RELOAD_TACTICAL : RELOAD_EMPTY;

    this.#reloading = true;
    this.#reloadTactical = tactical;
    this.#reloadTimer = 0;
    this.#reloadDuration = duration;
    this.#reloadCommit = duration * (clip.cancelAfter ?? 1);
    this.#animator.play(clip, duration);
    ctx.events.emit('weapon:reload-started', { weaponId: this.#definition.id, tactical });
  }

  #stepReload(dt: number, ctx: EngineContext, firePressed: boolean): void {
    if (!this.#reloading) return;
    this.#reloadTimer += dt;

    // Interrupting before the magazine is committed abandons the reload and
    // keeps whatever was in the weapon — the standard reload-cancel that lets
    // a player answer a sudden threat.
    if (firePressed && this.#ammo > 0 && this.#reloadTimer < this.#reloadCommit) {
      this.#reloading = false;
      this.#animator.cancel();
      ctx.events.emit('weapon:reload-finished', {
        weaponId: this.#definition.id,
        ammo: this.#ammo,
      });
      return;
    }

    if (this.#reloadTimer >= this.#reloadCommit) {
      const wanted = this.#definition.magazineSize - this.#ammo;
      const loaded = Math.min(wanted, this.#reserve);
      this.#ammo += loaded;
      this.#reserve -= loaded;
      this.#reloading = false;
      ctx.events.emit('weapon:reload-finished', {
        weaponId: this.#definition.id,
        ammo: this.#ammo,
      });
    }
  }

  // -- camera ---------------------------------------------------------------

  #applyCameraFov(ctx: EngineContext): void {
    const base = ctx.settings.fov;
    const target =
      THREE.MathUtils.lerp(base, this.#definition.adsFov, this.#adsEased) + this.#fovKick.value;
    const active = this.#adsEased > 5e-4 || Math.abs(this.#fovKick.value) > 0.01;
    // Only touch the camera while an effect is actually running, so capture
    // presets that set their own field of view are left alone.
    if (!active && !this.#fovOverridden) return;
    ctx.camera.fov = active ? target : base;
    ctx.camera.updateProjectionMatrix();
    this.#fovOverridden = active;
  }

  // -- public state ---------------------------------------------------------

  /** Live weapon state, consumed by the HUD. */
  get state(): WeaponState {
    return {
      definition: this.#definition,
      ammo: this.#ammo,
      reserve: this.#reserve,
      ads: this.#adsIntent,
      adsProgress: this.#adsEased,
      reloading: this.#reloading,
      firing: this.#firing,
      spread: this.#spread.degrees,
    };
  }

  get definition(): WeaponDefinition {
    return this.#definition;
  }

  dispose(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#rig.dispose();
  }
}
