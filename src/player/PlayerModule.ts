import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { CharacterControllerHandle } from '@/types/physics.ts';
import type { PlayerState, SurfaceKind } from '@/types/gameplay.ts';
import type { Unsubscribe } from '@/types/events.ts';
import { BODY, CAMERA, MANTLE, MOVE, SLIDE } from './tuning.ts';
import { CameraRig, type ViewFrame } from './CameraRig.ts';
import {
  hasStandClearance,
  probeLedge,
  probeStepUp,
  sampleGroundSurface,
  type LedgeTarget,
} from './LedgeProbe.ts';

/** Root motion currently being played. Control is locked for its duration. */
interface MantleMotion {
  start: THREE.Vector3;
  target: THREE.Vector3;
  direction: THREE.Vector3;
  duration: number;
  entrySpeed: number;
  elapsed: number;
}

const _wish = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _motion = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tmp = new THREE.Vector3();

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

/**
 * First-person character controller and camera.
 *
 * Simulation runs entirely in `fixedUpdate` at 120Hz so behaviour is identical
 * on any display; look and every camera effect are applied per frame in
 * `update` so aim is never quantised to the simulation rate.
 */
export class PlayerModule implements GameModule {
  readonly name = 'player';
  readonly order: number;

  #controller!: CharacterControllerHandle;
  #rig!: CameraRig;
  #velocity = new THREE.Vector3();
  #position = new THREE.Vector3(-2.5, 1.05, 20);
  #yaw = Math.PI;
  #pitch = 0;

  #grounded = false;
  #crouching = false;
  #sprinting = false;
  #sliding = false;
  #slideTimer = 0;
  #slideCooldown = 0;
  #coyote = 0;
  #jumpBuffered = 0;
  #jumpLatch = false;
  #currentHeight: number = BODY.standHeight;
  #health = 100;
  readonly #maxHealth = 100;

  #mantle: MantleMotion | null = null;
  #mantleCooldown = 0;

  /** Speed cap air control aims for, latched from the ground speed at takeoff
   *  so a sprinting jump does not decay to walk pace in mid-air. */
  #airTarget: number = MOVE.walkSpeed;

  /** Vertical distance still owed to a step-up in progress. */
  #stepLift = 0;

  /** Cumulative horizontal distance actually travelled; drives bob and steps. */
  #travelled = 0;
  #stepDistance = 0;
  #groundSurface: SurfaceKind = 'concrete';
  /** True when the previous step's horizontal motion was substantially blocked. */
  #blocked = false;

  /** Smoothed eye height, so stairs do not jolt the camera. */
  #smoothedY = 0;

  /** Set by the weapon module while aiming. */
  #fovOverride: number | null = null;
  #speedScale = 1;

  #subscriptions: Unsubscribe[] = [];

  constructor(order = 0) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    this.#controller = ctx.physics.createCharacterController(
      this.#position,
      BODY.radius,
      BODY.standHeight
    );
    this.#rig = new CameraRig(ctx.rng.fork('player'));
    this.#smoothedY = this.#position.y + this.#currentHeight / 2 + BODY.eyeOffset;
    ctx.camera.rotation.order = 'YXZ';

    this.#subscriptions.push(
      ctx.events.on('combat:player-damaged', ({ amount, from, health }) => {
        this.#health = THREE.MathUtils.clamp(
          Number.isFinite(health) ? health : this.#health - amount,
          0,
          this.#maxHealth
        );
        this.#flinch(from, amount);
      }),
      ctx.events.on('combat:player-healed', ({ health }) => {
        if (Number.isFinite(health)) {
          this.#health = THREE.MathUtils.clamp(health, 0, this.#maxHealth);
        }
      })
    );
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    if (ctx.capture) return;

    const input = ctx.input;
    this.#mantleCooldown = Math.max(0, this.#mantleCooldown - dt);
    this.#slideCooldown = Math.max(0, this.#slideCooldown - dt);

    if (input.wasPressed('jump') || this.#jumpLatch) {
      this.#jumpBuffered = MOVE.jumpBuffer;
      this.#jumpLatch = false;
    } else {
      this.#jumpBuffered = Math.max(0, this.#jumpBuffered - dt);
    }

    this.#basis();
    _wish
      .set(0, 0, 0)
      .addScaledVector(_forward, input.move.y)
      .addScaledVector(_right, input.move.x);
    if (_wish.lengthSq() > 1) _wish.normalize();

    if (this.#mantle !== null) {
      this.#advanceMantle(dt, ctx);
      return;
    }

    const speed = Math.hypot(this.#velocity.x, this.#velocity.z);
    const wantsCrouch = input.isDown('crouch');
    const wasSprinting = this.#sprinting;

    this.#updateSlide(dt, ctx, wantsCrouch, speed);

    this.#crouching = wantsCrouch || this.#sliding;
    this.#applyStance(dt, ctx);

    this.#sprinting =
      input.isDown('sprint') &&
      input.move.y > 0.3 &&
      this.#grounded &&
      !this.#crouching &&
      !this.#sliding;
    if (this.#sprinting !== wasSprinting) {
      ctx.events.emit('player:sprint-changed', { sprinting: this.#sprinting });
    }

    // Holding jump keeps asking for a mantle, not just the frame it was
    // pressed: arriving at a ledge with the button already down should vault.
    if (this.#tryMantle(ctx, speed, this.#jumpBuffered > 0 || input.isDown('jump'))) return;

    if (this.#sliding) this.#accelerateSlide(dt);
    else this.#accelerate(dt, speed);

    this.#applyJump(dt, ctx);
    this.#integrate(dt, ctx);
    this.#guardVelocity();
  }

  update(dt: number, ctx: EngineContext): void {
    if (ctx.capture) return;

    const input = ctx.input;
    // Latch here as well as in the fixed step: above 120Hz a frame can render
    // without any fixed step running, and the press flag would be lost.
    if (input.wasPressed('jump')) this.#jumpLatch = true;

    if (input.pointerLocked) {
      this.#yaw += input.look.x;
      this.#pitch = THREE.MathUtils.clamp(
        this.#pitch + input.look.y,
        -MOVE.maxPitch,
        MOVE.maxPitch
      );
    }

    const eyeY = this.#position.y + this.#currentHeight / 2 + BODY.eyeOffset;
    // Falls track exactly so a drop reads as a drop; everything else is
    // smoothed so stairs and stance changes stay level.
    this.#smoothedY =
      this.#grounded || this.#mantle !== null
        ? THREE.MathUtils.damp(this.#smoothedY, eyeY, CAMERA.eyeLambda, dt)
        : eyeY;

    const frame: ViewFrame = {
      dt,
      eye: _eye.set(this.#position.x, this.#smoothedY, this.#position.z),
      yaw: this.#yaw,
      pitch: this.#pitch,
      speed: Math.hypot(this.#velocity.x, this.#velocity.z),
      travelled: this.#travelled,
      strafe: input.move.x,
      grounded: this.#grounded,
      crouching: this.#crouching,
      sprinting: this.#sprinting,
      sliding: this.#sliding,
      mantle: this.#mantle ? this.#mantle.elapsed / this.#mantle.duration : 0,
      baseFov: this.#fovOverride ?? ctx.settings.fov,
      // An overridden FOV means the weapon owns the framing; kicks would fight
      // the aim transition.
      fovKickScale: this.#fovOverride === null ? ctx.settings.fovKickScale : 0,
      shakeScale: ctx.settings.screenShakeScale,
    };
    this.#rig.apply(frame, ctx.camera);

    ctx.viewmodelCamera.position.copy(ctx.camera.position);
    ctx.viewmodelCamera.quaternion.copy(ctx.camera.quaternion);
  }

  // -- movement -------------------------------------------------------------

  /** Refreshes the yaw-aligned forward/right basis vectors. */
  #basis(): void {
    _forward.set(-Math.sin(this.#yaw), 0, -Math.cos(this.#yaw));
    _right.set(-_forward.z, 0, _forward.x);
  }

  #stanceSpeed(): number {
    let target: number = MOVE.walkSpeed;
    if (this.#crouching) target = MOVE.crouchSpeed;
    else if (this.#sprinting) target = MOVE.sprintSpeed;
    return target * this.#speedScale;
  }

  /**
   * Eases the capsule between stances, anchored at the feet.
   *
   * Rapier keeps the collider centred on the body, so growing the capsule
   * without moving the body would drive the feet through the floor and let
   * the solver shove the player upward.
   */
  #applyStance(dt: number, ctx: EngineContext): void {
    let target: number = this.#crouching ? BODY.crouchHeight : BODY.standHeight;
    if (
      target > this.#currentHeight &&
      !hasStandClearance(ctx.physics, this.#position, this.#currentHeight)
    ) {
      target = this.#currentHeight;
    }
    const next = THREE.MathUtils.damp(this.#currentHeight, target, 14, dt);
    const delta = next - this.#currentHeight;
    if (Math.abs(delta) < 1e-5) return;

    // Growing always pushes the crown up (the clearance test above covers it).
    // Shrinking drops the head on the ground and tucks the feet in the air,
    // so a crouch-jump gains the clearance the player expects.
    const anchor = this.#grounded || delta > 0 ? 1 : -1;
    this.#currentHeight = next;
    this.#controller.setHeight(next);
    this.#position.y += (delta / 2) * anchor;
    this.#controller.setPosition(this.#position);
  }

  #accelerate(dt: number, speed: number): void {
    const hasInput = _wish.lengthSq() > 0.01;

    if (!this.#grounded) {
      if (!hasInput) return;
      // Air control as a projection: it redirects existing momentum but can
      // never add speed along a direction already at the cap, so a jump
      // commits without feeling like it is on rails.
      const target = Math.max(this.#stanceSpeed(), this.#airTarget);
      const along = this.#velocity.x * _wish.x + this.#velocity.z * _wish.z;
      const add = Math.min(Math.max(target - along, 0), MOVE.airAccel * dt);
      this.#velocity.x += _wish.x * add;
      this.#velocity.z += _wish.z * add;
      return;
    }

    this.#airTarget = THREE.MathUtils.clamp(speed, MOVE.walkSpeed, MOVE.sprintSpeed);
    const target = this.#stanceSpeed();

    if (speed > target + 0.15) {
      // Momentum out of a slide or mantle sits above the stance cap. Bleed it
      // at a constant rate rather than clamping it, and let the player steer
      // it, which is what makes the speed feel earned.
      const scale = Math.max(target, speed - MOVE.overspeedFriction * dt) / speed;
      this.#velocity.x *= scale;
      this.#velocity.z *= scale;
      if (hasInput) this.#steerHorizontal(_wish, MOVE.overspeedSteerRate * dt);
      return;
    }

    if (!hasInput) {
      // A floor under the friction term makes the last metre per second
      // disappear at a constant rate instead of creeping asymptotically.
      const control = Math.max(speed, MOVE.frictionStopSpeed);
      const drop = control * MOVE.groundFriction * dt;
      const scale = speed > 1e-4 ? Math.max(0, speed - drop) / speed : 0;
      this.#velocity.x *= scale;
      this.#velocity.z *= scale;
      return;
    }

    // Direct pursuit of the desired velocity: walk speed in ~0.07s, which is
    // the responsiveness this genre is judged on.
    _tmp.set(_wish.x * target - this.#velocity.x, 0, _wish.z * target - this.#velocity.z);
    const maxChange = MOVE.groundAccel * dt;
    if (_tmp.lengthSq() > maxChange * maxChange) _tmp.setLength(maxChange);
    this.#velocity.x += _tmp.x;
    this.#velocity.z += _tmp.z;
  }

  /** Rotates horizontal velocity toward `dir` by at most `maxRadians`. */
  #steerHorizontal(dir: THREE.Vector3, maxRadians: number): void {
    const speed = Math.hypot(this.#velocity.x, this.#velocity.z);
    if (speed < 1e-3) return;
    const current = Math.atan2(this.#velocity.x, this.#velocity.z);
    const wanted = Math.atan2(dir.x, dir.z);
    let delta = wanted - current;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const step = THREE.MathUtils.clamp(delta, -maxRadians, maxRadians);
    const angle = current + step;
    this.#velocity.x = Math.sin(angle) * speed;
    this.#velocity.z = Math.cos(angle) * speed;
  }

  // -- slide ----------------------------------------------------------------

  #updateSlide(dt: number, ctx: EngineContext, wantsCrouch: boolean, speed: number): void {
    if (this.#sliding) {
      this.#slideTimer -= dt;
      // Releasing crouch exits early, into a crouch or straight back into a
      // sprint depending on what is still held; both resolve this same tick.
      const expired =
        this.#slideTimer <= 0 || speed < SLIDE.exitSpeed || !this.#grounded || !wantsCrouch;
      if (expired) this.#endSlide(ctx);
      return;
    }

    if (
      wantsCrouch &&
      this.#sprinting &&
      this.#grounded &&
      this.#slideCooldown <= 0 &&
      speed > SLIDE.enterSpeed
    ) {
      this.#sliding = true;
      this.#sprinting = false;
      this.#slideTimer = SLIDE.maxDuration;
      const boosted = Math.min(speed + SLIDE.boost, SLIDE.maxEntrySpeed);
      const scale = boosted / Math.max(speed, 1e-3);
      this.#velocity.x *= scale;
      this.#velocity.z *= scale;
      ctx.events.emit('player:slide-started');
      this.#rig.addTrauma(0.18);
    }
  }

  #endSlide(ctx: EngineContext): void {
    if (!this.#sliding) return;
    this.#sliding = false;
    this.#slideCooldown = SLIDE.cooldown;
    ctx.events.emit('player:slide-ended');
  }

  #accelerateSlide(dt: number): void {
    const normal = this.#controller.groundNormal;
    if (this.#grounded && normal.y > MOVE.walkableCos) {
      // Gravity projected along the surface: downhill accelerates, uphill
      // scrubs speed, which is what makes a slope worth sliding down.
      const gain = MOVE.gravity * normal.y * SLIDE.slopeGravity * dt;
      this.#velocity.x += normal.x * gain;
      this.#velocity.z += normal.z * gain;
    }

    const speed = Math.hypot(this.#velocity.x, this.#velocity.z);
    if (speed > 1e-3) {
      const scale = Math.max(0, speed - SLIDE.decel * dt) / speed;
      this.#velocity.x *= scale;
      this.#velocity.z *= scale;
    }
    if (_wish.lengthSq() > 0.01) this.#steerHorizontal(_wish, SLIDE.steerRate * dt);
  }

  // -- jump, mantle ---------------------------------------------------------

  #applyJump(dt: number, ctx: EngineContext): void {
    this.#coyote = this.#grounded ? MOVE.coyoteTime : Math.max(0, this.#coyote - dt);
    if (this.#jumpBuffered <= 0 || this.#coyote <= 0) return;

    this.#velocity.y = MOVE.jumpVelocity;
    this.#jumpBuffered = 0;
    this.#coyote = 0;
    this.#grounded = false;
    this.#stepLift = 0;
    // Slide-jumping keeps the horizontal speed it built: the canonical way to
    // cross open ground in this genre.
    this.#endSlide(ctx);
    ctx.events.emit('player:jumped');
  }

  /** Returns true when a mantle started and took over this step. */
  #tryMantle(ctx: EngineContext, speed: number, deliberate: boolean): boolean {
    if (this.#mantle !== null || this.#mantleCooldown > 0 || this.#stepLift > 0) return false;

    const automatic =
      this.#blocked && this.#grounded && this.#sprinting && speed > MANTLE.autoMinSpeed;
    if (!deliberate && !automatic) return false;

    _tmp.copy(_wish);
    if (_tmp.lengthSq() < 0.01) {
      if (!deliberate) return false;
      _tmp.copy(_forward);
    }
    _tmp.normalize();

    const maxHeight = deliberate ? MANTLE.maxHeight : MANTLE.autoMaxHeight;
    const ledge = probeLedge(
      ctx.physics,
      this.#position,
      this.#currentHeight,
      _tmp,
      maxHeight
    );
    if (ledge === null) return false;

    this.#beginMantle(ctx, ledge, _tmp, speed);
    return true;
  }

  #beginMantle(
    ctx: EngineContext,
    ledge: LedgeTarget,
    direction: THREE.Vector3,
    speed: number
  ): void {
    // Mantling crouched halves the clearance the move needs, and matches the
    // tucked pose the animation implies.
    const feetY = this.#position.y - this.#currentHeight / 2;
    this.#currentHeight = BODY.crouchHeight;
    this.#controller.setHeight(BODY.crouchHeight);
    this.#position.y = feetY + BODY.crouchHeight / 2;
    this.#controller.setPosition(this.#position);

    this.#endSlide(ctx);
    this.#crouching = false;
    if (this.#sprinting) {
      this.#sprinting = false;
      ctx.events.emit('player:sprint-changed', { sprinting: false });
    }

    const t = THREE.MathUtils.clamp(
      (ledge.height - MANTLE.minHeight) / (MANTLE.maxHeight - MANTLE.minHeight),
      0,
      1
    );
    this.#mantle = {
      start: this.#position.clone(),
      target: ledge.target.clone(),
      direction: direction.clone(),
      duration: THREE.MathUtils.lerp(MANTLE.minDuration, MANTLE.maxDuration, t),
      entrySpeed: speed,
      elapsed: 0,
    };
    this.#velocity.set(0, 0, 0);
    this.#jumpBuffered = 0;
    this.#grounded = false;
    this.#stepLift = 0;
    this.#groundSurface = ledge.surface;
    this.#rig.addTrauma(0.12);
    ctx.events.emit('player:vault-started', { height: ledge.height });
  }

  /**
   * Drives the capsule along the vault arc.
   *
   * Vertical progress leads horizontal, so the player rises clear of the lip
   * before translating over it — the difference between vaulting a crate and
   * clipping through its corner.
   */
  #advanceMantle(dt: number, ctx: EngineContext): void {
    const m = this.#mantle;
    if (m === null) return;

    m.elapsed += dt;
    const u = THREE.MathUtils.clamp(m.elapsed / m.duration, 0, 1);
    const vertical = easeOutCubic(THREE.MathUtils.clamp(u / 0.62, 0, 1));
    const horizontal = easeInOutQuad(THREE.MathUtils.clamp((u - 0.18) / 0.82, 0, 1));

    _motion.copy(this.#position);
    this.#position.set(
      THREE.MathUtils.lerp(m.start.x, m.target.x, horizontal),
      THREE.MathUtils.lerp(m.start.y, m.target.y, vertical) +
        MANTLE.lipClearance * Math.sin(Math.PI * u),
      THREE.MathUtils.lerp(m.start.z, m.target.z, horizontal)
    );
    this.#controller.setPosition(this.#position);

    // Report the arc's real velocity so weapon sway and audio see continuity.
    this.#velocity.subVectors(this.#position, _motion).divideScalar(Math.max(dt, 1e-5));
    this.#travelled += Math.hypot(this.#position.x - _motion.x, this.#position.z - _motion.z);

    if (u < 1) return;

    const exit = Math.min(m.entrySpeed, MANTLE.exitSpeed);
    this.#velocity.set(m.direction.x * exit, 0, m.direction.z * exit);
    this.#mantle = null;
    this.#mantleCooldown = MANTLE.cooldown;
    this.#stepDistance = 0;
    this.#grounded = true;
    this.#groundSurface = sampleGroundSurface(ctx.physics, this.#position, this.#currentHeight);
    ctx.events.emit('player:footstep', {
      position: this.#feet(),
      surface: this.#groundSurface,
      running: false,
    });
  }

  // -- integration ----------------------------------------------------------

  #integrate(dt: number, ctx: EngineContext): void {
    if (this.#grounded && this.#stepLift <= 0) this.#stepLift = this.#stepUp(ctx, dt);
    const lift = Math.min(this.#stepLift, MOVE.stepClimbSpeed * dt);
    this.#stepLift -= lift;

    if (lift > 0) {
      this.#velocity.y = 0;
    } else if (this.#grounded && this.#velocity.y <= 0) {
      // A constant downward bias keeps the capsule pinned to the surface
      // across crests and stair nosings instead of skipping off them.
      this.#velocity.y = -MOVE.groundStickSpeed;
    } else {
      this.#velocity.y = Math.max(
        -MOVE.maxFallSpeed,
        this.#velocity.y - MOVE.gravity * dt
      );
    }
    const impactSpeed = Math.max(0, -this.#velocity.y);

    _motion.set(this.#velocity.x * dt, this.#velocity.y * dt + lift, this.#velocity.z * dt);

    if (this.#grounded && lift <= 0) {
      const normal = this.#controller.groundNormal;
      if (normal.y > MOVE.walkableCos) {
        // Follow the plane downhill rather than launching off it.
        const slopeY =
          -(normal.x * _motion.x + normal.z * _motion.z) / Math.max(normal.y, 0.3);
        if (slopeY < 0) {
          _motion.y = Math.min(_motion.y, slopeY - MOVE.groundStickSpeed * dt);
        }
      }
    }

    const requestedX = _motion.x;
    const requestedZ = _motion.z;
    const requestedY = _motion.y;
    const applied = this.#controller.move(_motion, dt);
    const wasGrounded = this.#grounded;
    // A climb leaves the surface by design; reporting it as airborne would
    // spend the coyote window and fire a landing punch on every stair.
    this.#grounded = this.#controller.grounded || lift > 0;
    this.#controller.getPosition(this.#position);

    if (lift > 0) {
      // Something overhead ate the lift, so the step is not actually
      // climbable. Give up rather than grinding against it.
      if (applied.y < lift * 0.5) this.#stepLift = 0;
      this.#blocked = false;
    } else {
      this.#resolveBlocking(requestedX, requestedY, requestedZ, applied);
    }

    const travelled = Math.hypot(applied.x, applied.z);
    this.#travelled += travelled;

    if (this.#grounded && !wasGrounded) {
      this.#groundSurface = sampleGroundSurface(
        ctx.physics,
        this.#position,
        this.#currentHeight
      );
      this.#stepDistance = 0;
      if (impactSpeed > 1.5) {
        ctx.events.emit('player:landed', {
          velocity: impactSpeed,
          surface: this.#groundSurface,
        });
        this.#rig.punchLanding(impactSpeed);
      }
    }

    this.#updateFootsteps(ctx, travelled);
  }

  /**
   * Removes only the velocity component driving into whatever stopped us.
   *
   * Zeroing the whole axis (the obvious approach) is what makes a capsule
   * catch on corners and refuse to slide along a wall.
   */
  #resolveBlocking(
    requestedX: number,
    requestedY: number,
    requestedZ: number,
    applied: THREE.Vector3
  ): void {
    if (requestedY > 0 && applied.y < requestedY - 1e-4 && this.#velocity.y > 0) {
      this.#velocity.y = 0;
    }

    const shortX = requestedX - applied.x;
    const shortZ = requestedZ - applied.z;
    const shortfall = Math.hypot(shortX, shortZ);
    const requested = Math.hypot(requestedX, requestedZ);
    // Ignore the small shortfall that climbing a slope legitimately produces.
    if (requested < 1e-5 || shortfall < requested * 0.1) {
      this.#blocked = false;
      return;
    }

    this.#blocked = shortfall > requested * 0.35;
    const nx = shortX / shortfall;
    const nz = shortZ / shortfall;
    const into = this.#velocity.x * nx + this.#velocity.z * nz;
    if (into > 0) {
      this.#velocity.x -= nx * into;
      this.#velocity.z -= nz * into;
    }
  }

  /**
   * Vertical lift needed to walk onto stairs and kerbs taller than the
   * controller's own autostep limit, or 0 when there is nothing to climb.
   */
  #stepUp(ctx: EngineContext, dt: number): number {
    if (this.#sliding || this.#mantle !== null) return 0;
    const speed = Math.hypot(this.#velocity.x, this.#velocity.z);
    // Falling back on the wish direction matters: pressed against a riser the
    // capsule has almost no velocity left to take a direction from.
    if (speed > 0.4) _tmp.set(this.#velocity.x / speed, 0, this.#velocity.z / speed);
    else if (_wish.lengthSq() > 0.01) _tmp.copy(_wish).normalize();
    else return 0;

    const probe = Math.max(0.24, speed * dt + 0.12);
    return probeStepUp(ctx.physics, this.#position, this.#currentHeight, _tmp, probe) ?? 0;
  }

  #updateFootsteps(ctx: EngineContext, travelled: number): void {
    if (!this.#grounded || this.#sliding) return;
    const speed = Math.hypot(this.#velocity.x, this.#velocity.z);
    if (speed < 0.7) return;

    this.#stepDistance += travelled;
    const stride = this.#crouching
      ? CAMERA.strideCrouch
      : this.#sprinting
        ? CAMERA.strideSprint
        : CAMERA.strideWalk;
    if (this.#stepDistance < stride) return;

    this.#stepDistance -= stride;
    this.#groundSurface = sampleGroundSurface(ctx.physics, this.#position, this.#currentHeight);
    ctx.events.emit('player:footstep', {
      position: this.#feet(),
      surface: this.#groundSurface,
      running: this.#sprinting,
    });
  }

  #feet(): THREE.Vector3 {
    return new THREE.Vector3(
      this.#position.x,
      this.#position.y - this.#currentHeight / 2,
      this.#position.z
    );
  }

  /** Last line of defence: a non-finite state would corrupt the controller. */
  #guardVelocity(): void {
    const v = this.#velocity;
    if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) return;
    v.set(0, 0, 0);
    console.warn('[player] non-finite velocity recovered');
  }

  #flinch(from: THREE.Vector3, amount: number): void {
    this.#basis();
    _tmp.set(from.x - this.#position.x, 0, from.z - this.#position.z);
    if (_tmp.lengthSq() < 1e-6) {
      this.#rig.punchDamage(0, 1, amount);
      return;
    }
    _tmp.normalize();
    this.#rig.punchDamage(_tmp.dot(_right), _tmp.dot(_forward), amount);
  }

  // -- public surface -------------------------------------------------------

  /** Read-only view of player state, consumed by weapon, audio, UI and AI. */
  get state(): PlayerState {
    return {
      position: this.#position,
      velocity: this.#velocity,
      grounded: this.#grounded,
      crouching: this.#crouching,
      sprinting: this.#sprinting,
      sliding: this.#sliding,
      vaulting: this.#mantle !== null,
      health: this.#health,
      alive: this.#health > 0,
      speed: Math.hypot(this.#velocity.x, this.#velocity.z),
      eyeHeight: this.#currentHeight / 2 + BODY.eyeOffset,
    };
  }

  get yaw(): number {
    return this.#yaw;
  }

  get pitch(): number {
    return this.#pitch;
  }

  /** Surface the player is currently standing on. */
  get groundSurface(): SurfaceKind {
    return this.#groundSurface;
  }

  /** Applies recoil as a view impulse. Called by the weapon module. */
  addViewKick(pitchDelta: number, yawDelta: number): void {
    this.#pitch = THREE.MathUtils.clamp(
      this.#pitch + pitchDelta,
      -MOVE.maxPitch,
      MOVE.maxPitch
    );
    this.#yaw += yawDelta;
  }

  /** Shake impulse in [0,1], for explosions and heavy impacts. */
  addTrauma(amount: number): void {
    this.#rig.addTrauma(amount);
  }

  /**
   * Overrides the base field of view, for aiming down sights. Pass null to
   * hand framing back to the player module. Sprint and slide kicks are
   * suppressed while an override is active.
   */
  setFovOverride(fov: number | null): void {
    this.#fovOverride = fov;
  }

  /** Multiplier on every stance's top speed. Used for the ADS slowdown. */
  setSpeedScale(scale: number): void {
    this.#speedScale = THREE.MathUtils.clamp(scale, 0.1, 1);
  }

  /** Hard reposition, for spawning and teleports. */
  teleport(position: THREE.Vector3, yaw = this.#yaw): void {
    this.#position.copy(position);
    this.#controller.setPosition(position);
    this.#velocity.set(0, 0, 0);
    this.#mantle = null;
    this.#sliding = false;
    this.#stepLift = 0;
    this.#yaw = yaw;
    this.#pitch = 0;
    this.#smoothedY = position.y + this.#currentHeight / 2 + BODY.eyeOffset;
    this.#rig.reset();
  }

  dispose(): void {
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions = [];
    this.#controller?.remove();
  }
}
