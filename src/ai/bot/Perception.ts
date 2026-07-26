import * as THREE from 'three';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type { Rng } from '@/types/rng.ts';
import { PERCEPTION } from '../Tuning.ts';
import type { Squad } from './Squad.ts';

/**
 * Vision and hearing.
 *
 * Awareness is accumulated, not sampled. A target that steps into the far
 * edge of the cone at 40m takes over a second to register; the same target at
 * 8m dead ahead takes a third of that. On top of that sits an explicit
 * reaction delay before the trigger unlocks. Both are deliberate: the moment
 * a bot can see and shoot in the same frame, every death feels unearned no
 * matter how wide its cone of fire is.
 */

export type Awareness = 'unaware' | 'suspicious' | 'alert';

export interface PerceptionTarget {
  /** Ground contact position, not the capsule centre. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Eye height above `position`. */
  eyeHeight: number;
  crouching: boolean;
  alive: boolean;
  health: number;
}

const _toTarget = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _point = new THREE.Vector3();

const COS_HALF_FOV = Math.cos((PERCEPTION.fovDegrees * Math.PI) / 360);
const COS_HALF_FOCUS = Math.cos((PERCEPTION.focusFovDegrees * Math.PI) / 360);

export class Perception {
  awareness = 0;
  /** True on the tick line of sight was confirmed. */
  visible = false;
  /**
   * Age of the best positional fix the bot has, whether it earned that fix
   * itself or inherited it from a squadmate. Infinity when there is none.
   */
  timeSinceSeen = Infinity;
  distance = Infinity;
  /** Last position the target was actually observed at. */
  readonly lastSeenPosition = new THREE.Vector3();
  readonly lastSeenVelocity = new THREE.Vector3();
  /** Position worth investigating: a noise, or a shared contact. */
  readonly interestPoint = new THREE.Vector3();
  hasInterest = false;
  interestTime = -Infinity;

  /** Counts down once alerted; the bot cannot fire until it reaches zero. */
  reactionRemaining = 0;
  #wasAlert = false;

  #losTimer: number;
  #losInterval: number;
  #cachedVisible = false;
  #awarenessScale: number;

  constructor(rng: Rng, awarenessScale: number) {
    this.#losInterval = 1 / PERCEPTION.losHz;
    // Stagger the roster so twelve bots never cast on the same tick.
    this.#losTimer = rng.range(0, this.#losInterval);
    this.#awarenessScale = awarenessScale;
  }

  reset(): void {
    this.awareness = 0;
    this.visible = false;
    this.timeSinceSeen = Infinity;
    this.hasInterest = false;
    this.reactionRemaining = 0;
    this.#wasAlert = false;
    this.#cachedVisible = false;
  }

  get state(): Awareness {
    if (this.awareness >= PERCEPTION.alertThreshold) return 'alert';
    if (this.awareness >= PERCEPTION.suspicionThreshold) return 'suspicious';
    return 'unaware';
  }

  get canFire(): boolean {
    return this.state === 'alert' && this.reactionRemaining <= 0;
  }

  /** Whether `lastSeenPosition` is recent enough to fight over. */
  get contactRecent(): boolean {
    return this.timeSinceSeen < PERCEPTION.memoryDuration;
  }

  /** Directs the bot's attention at a position it did not observe itself. */
  noticeInterest(point: THREE.Vector3, now: number): void {
    this.interestPoint.copy(point);
    this.hasInterest = true;
    this.interestTime = now;
  }

  /** True on the frame the bot transitions into full alert. */
  update(
    dt: number,
    physics: PhysicsWorld,
    eyePosition: THREE.Vector3,
    facing: number,
    target: PerceptionTarget,
    squad: Squad,
    reactionTime: number
  ): boolean {
    this.timeSinceSeen += dt;
    this.reactionRemaining = Math.max(0, this.reactionRemaining - dt);

    _toTarget.copy(target.position);
    _toTarget.y += target.eyeHeight * 0.72;
    _toTarget.sub(eyePosition);
    this.distance = _toTarget.length();

    let gain = 0;
    this.visible = false;

    if (target.alive && this.distance < PERCEPTION.maxRange) {
      _direction.copy(_toTarget).multiplyScalar(1 / Math.max(this.distance, 1e-4));
      const forwardX = -Math.sin(facing);
      const forwardZ = -Math.cos(facing);
      const planar = Math.hypot(_direction.x, _direction.z) || 1e-4;
      const cosAngle = (_direction.x * forwardX + _direction.z * forwardZ) / planar;

      if (cosAngle > COS_HALF_FOV) {
        this.#losTimer -= dt;
        if (this.#losTimer <= 0) {
          this.#losTimer += this.#losInterval;
          this.#cachedVisible = this.#castLineOfSight(physics, eyePosition, target);
        }
        if (this.#cachedVisible) {
          this.visible = true;
          this.timeSinceSeen = 0;
          this.lastSeenPosition.copy(target.position);
          this.lastSeenVelocity.copy(target.velocity);

          // Peripheral contacts resolve slowly; centred ones resolve fast.
          const focus = THREE.MathUtils.clamp(
            (cosAngle - COS_HALF_FOV) / Math.max(COS_HALF_FOCUS - COS_HALF_FOV, 1e-4),
            0,
            1
          );
          const angleFactor = 0.22 + 0.78 * focus * focus;
          const range = THREE.MathUtils.clamp(
            1 -
              (this.distance - PERCEPTION.falloffStart) /
                (PERCEPTION.maxRange - PERCEPTION.falloffStart),
            0.1,
            1
          );
          const speed = Math.hypot(target.velocity.x, target.velocity.z);
          // Movement is the strongest real-world detection cue; a crouched,
          // still target in shadow should be genuinely hard to pick up.
          const motion = 0.55 + Math.min(0.85, speed * 0.14);
          const stance = target.crouching ? 0.68 : 1;
          gain = PERCEPTION.gainRate * angleFactor * range * range * motion * stance;
        }
      }
    }

    if (gain > 0) {
      this.awareness += gain * this.#awarenessScale * dt;
    } else {
      this.awareness -= this.#decayRate(squad.time) * dt;
    }

    this.#hear(dt, eyePosition, squad);
    this.awareness = THREE.MathUtils.clamp(this.awareness, 0, 1.65);

    const alert = this.state === 'alert';
    const became = alert && !this.#wasAlert;
    if (became) {
      this.reactionRemaining = reactionTime;
    }
    this.#wasAlert = alert;

    if (this.visible) {
      squad.reportContact(target.position, true);
      this.noticeInterest(target.position, squad.time);
    } else if (squad.contactFresh && squad.lastKnownTime > this.interestTime) {
      // Trust a squadmate's report, but only as a place to look: a call-out
      // raises suspicion and moves the bot, it never unlocks the trigger.
      this.noticeInterest(squad.lastKnownPosition, squad.lastKnownTime);
      if (this.awareness < PERCEPTION.suspicionThreshold) {
        this.awareness = Math.max(this.awareness, PERCEPTION.suspicionThreshold * 0.85);
      }
      if (squad.contactConfirmed && squad.contactAge < this.timeSinceSeen) {
        // A teammate with eyes on is a better fix than the bot's own stale
        // memory, and it is what makes a squad converge instead of trickle.
        this.lastSeenPosition.copy(squad.lastKnownPosition);
        this.lastSeenVelocity.set(0, 0, 0);
        this.timeSinceSeen = squad.contactAge;
      }
    }

    return became;
  }

  /**
   * Three distinct situations that would otherwise collapse into one number.
   *
   * A bot working a fresh noise stays switched on, because calming down while
   * walking toward the thing you heard is what makes an enemy feel scripted.
   * A bot that lost a confirmed contact long ago sheds awareness fast. A bot
   * that has never seen anything decays at the base rate — treating "never
   * saw him" as "lost him ages ago" makes hearing unable to out-run the decay
   * and leaves gunfire in the next room having no effect at all.
   */
  #decayRate(now: number): number {
    if (this.hasInterest && now - this.interestTime < 3) return PERCEPTION.decayRate * 0.25;
    const hadContact = this.timeSinceSeen < 1e6;
    if (hadContact && this.timeSinceSeen > PERCEPTION.memoryDuration) {
      return PERCEPTION.decayRate * 2.5;
    }
    return PERCEPTION.decayRate;
  }

  #hear(dt: number, eyePosition: THREE.Vector3, squad: Squad): void {
    // Hearing may only ever raise awareness, and only as far as its own
    // ceiling. Capping the running total instead would let audible gunfire
    // hold a bot below alert while it is staring straight at the shooter.
    const ceiling = Math.max(this.awareness, PERCEPTION.alertThreshold * 0.96);

    for (const noise of squad.noises) {
      const distance = eyePosition.distanceTo(noise.position);
      if (distance > noise.radius) continue;
      const attenuation = 1 - distance / noise.radius;
      if (noise.hostile) {
        // Hearing gives a bearing, not a fix, so it drives suspicion and an
        // investigation point but never unlocks the trigger on its own.
        const gain = attenuation * noise.loudness * 1.9 * this.#awarenessScale * dt;
        this.awareness = Math.min(this.awareness + gain, ceiling);
        if (squad.time > this.interestTime) {
          this.interestPoint.copy(noise.position);
          this.hasInterest = true;
          this.interestTime = squad.time;
        }
      } else {
        // Allied fire only makes a bot switch on, not look anywhere specific.
        const ceiling = PERCEPTION.suspicionThreshold * 1.15;
        if (this.awareness < ceiling) {
          this.awareness = Math.min(ceiling, this.awareness + attenuation * 0.8 * dt);
        }
      }
    }
  }

  #castLineOfSight(
    physics: PhysicsWorld,
    eyePosition: THREE.Vector3,
    target: PerceptionTarget
  ): boolean {
    // Chest first, then head: a target behind waist-high cover should be
    // seen, a target fully behind a container should not.
    const heights = [target.eyeHeight * 0.62, target.eyeHeight * 0.98];
    for (const height of heights) {
      _point.copy(target.position);
      _point.y += height;
      _direction.subVectors(_point, eyePosition);
      const distance = _direction.length();
      if (distance < 0.2) return true;
      _direction.multiplyScalar(1 / distance);
      const hit = physics.raycast({
        origin: eyePosition,
        direction: _direction,
        maxDistance: distance - 0.08,
        groups: CollisionGroup.World,
      });
      if (!hit) return true;
    }
    return false;
  }

  /** Eye position for a bot standing at `position` with the given stance. */
  static eyeOf(
    position: THREE.Vector3,
    standHeight: number,
    crouch: number,
    out: THREE.Vector3
  ): THREE.Vector3 {
    return out.set(
      position.x,
      position.y + THREE.MathUtils.lerp(standHeight, standHeight * 0.68, crouch) - 0.16,
      position.z
    );
  }
}
