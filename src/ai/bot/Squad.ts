import * as THREE from 'three';
import { SQUAD } from '../Tuning.ts';

/**
 * Shared squad knowledge.
 *
 * Bots that each rediscover the player independently look like a crowd of
 * strangers. Bots that all know everything instantly look like a hive mind.
 * The middle ground — one bot's contact becomes everyone's *last known
 * position*, decaying over a few seconds, with no velocity and no guarantee
 * it is still true — is what makes a group read as a trained squad.
 */

export interface NoiseEvent {
  position: THREE.Vector3;
  /** Relative loudness in [0,1]; scales the radius the noise carries. */
  loudness: number;
  radius: number;
  /** Simulation time the noise was made. */
  time: number;
  /** Set when the noise came from the player rather than another bot. */
  hostile: boolean;
}

export class Squad {
  /** Best current estimate of where the player is. */
  readonly lastKnownPosition = new THREE.Vector3();
  lastKnownTime = -Infinity;
  /** True while at least one bot has direct line of sight. */
  contact = false;
  contactCount = 0;

  time = 0;

  #noises: NoiseEvent[] = [];
  #flankers = new Set<string>();
  #suppressors = new Set<string>();
  /** actorId -> time the attacker slot was taken. */
  #attackers = new Map<string, number>();
  /** actorId -> time the slot was handed back. */
  #yielded = new Map<string, number>();
  #confirmed = false;

  advance(dt: number): void {
    this.time += dt;
    // Noises are consumed by perception within a tick or two; anything older
    // is stale by definition.
    if (this.#noises.length > 0) {
      this.#noises = this.#noises.filter((n) => this.time - n.time < 0.6);
    }
    this.contact = this.contactCount > 0;
    this.contactCount = 0;
  }

  reportNoise(position: THREE.Vector3, radius: number, loudness: number, hostile: boolean): void {
    if (this.#noises.length > 48) return;
    this.#noises.push({
      position: position.clone(),
      radius,
      loudness,
      time: this.time,
      hostile,
    });
  }

  get noises(): readonly NoiseEvent[] {
    return this.#noises;
  }

  /**
   * Shares a position. `direct` separates "I can see him" from "I was shot
   * from over there", so the rest of the squad knows whether to trust the fix
   * enough to shoot at it or only enough to walk toward it.
   */
  reportContact(position: THREE.Vector3, direct: boolean): void {
    if (direct) this.contactCount++;
    // An eyes-on report always wins; a guess only fills a vacuum.
    if (!direct && this.#confirmed && this.contactAge < 1.5) return;
    if (this.time >= this.lastKnownTime) {
      this.lastKnownPosition.copy(position);
      this.lastKnownTime = this.time;
      this.#confirmed = direct;
    }
  }

  get contactAge(): number {
    return this.time - this.lastKnownTime;
  }

  /** Whether the shared fix came from a direct sighting. */
  get contactConfirmed(): boolean {
    return this.#confirmed;
  }

  get contactFresh(): boolean {
    return this.contactAge < SQUAD.contactShareDuration;
  }

  /** Reserves one of the limited flanking slots. */
  claimFlank(actorId: string): boolean {
    if (this.#flankers.has(actorId)) return true;
    if (this.#flankers.size >= SQUAD.maxFlankers) return false;
    this.#flankers.add(actorId);
    return true;
  }

  releaseFlank(actorId: string): void {
    this.#flankers.delete(actorId);
  }

  /**
   * Reserves one of the limited aimed-fire slots, rotating holders so the
   * same bots do not monopolise the engagement. Returns false when the bot
   * should keep its head down and let someone else shoot.
   */
  claimAttack(actorId: string): boolean {
    const held = this.#attackers.get(actorId);
    if (held !== undefined) {
      if (this.time - held < SQUAD.attackHold) return true;
      this.#attackers.delete(actorId);
      this.#yielded.set(actorId, this.time);
      return false;
    }
    const yielded = this.#yielded.get(actorId);
    if (yielded !== undefined) {
      if (this.time - yielded < SQUAD.attackYield) return false;
      this.#yielded.delete(actorId);
    }
    if (this.#attackers.size >= SQUAD.maxAttackers) return false;
    this.#attackers.set(actorId, this.time);
    return true;
  }

  releaseAttack(actorId: string): void {
    this.#attackers.delete(actorId);
  }

  get attackerCount(): number {
    return this.#attackers.size;
  }

  claimSuppression(actorId: string): void {
    this.#suppressors.add(actorId);
  }

  releaseSuppression(actorId: string): void {
    this.#suppressors.delete(actorId);
  }

  get suppressorCount(): number {
    return this.#suppressors.size;
  }

  forget(actorId: string): void {
    this.#flankers.delete(actorId);
    this.#suppressors.delete(actorId);
    this.#attackers.delete(actorId);
    this.#yielded.delete(actorId);
  }

  reset(): void {
    this.#noises.length = 0;
    this.#flankers.clear();
    this.#suppressors.clear();
    this.#attackers.clear();
    this.#yielded.clear();
    this.lastKnownTime = -Infinity;
    this.contact = false;
    this.contactCount = 0;
    this.#confirmed = false;
  }
}
