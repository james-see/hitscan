import { el, setVar, text } from '../dom.ts';
import { RollingNumber } from './RollingNumber.ts';

/** How long the bar keeps its regeneration treatment after healing stops. */
const REGEN_HOLD_MS = 900;

/**
 * Health readout, bottom left.
 *
 * A trailing "ghost" fill drains behind the real one, so a burst of damage
 * stays legible for a beat after it lands rather than only on the frame it
 * happened.
 */
export class Vitals {
  readonly root: HTMLElement;

  #value: RollingNumber;
  #fill: HTMLElement;
  #ghost: HTMLElement;
  #sprint: HTMLElement;
  #crouch: HTMLElement;

  #fraction = -1;
  #hurtState = false;
  #criticalState = false;
  #regenUntil = 0;
  #regenState = false;
  #sprintState = false;
  #crouchState = false;
  #ghostPinned = false;

  constructor(parent: Element) {
    this.root = el('div', 'vitals', parent);

    const head = el('div', 'vitals-head', this.root);
    text('span', 'label', 'HEALTH', head);
    this.#value = new RollingNumber(head, 'vitals-value');

    const bar = el('div', 'vitals-bar', this.root);
    this.#ghost = el('i', 'vitals-ghost', bar);
    this.#fill = el('i', 'vitals-fill', bar);

    const status = el('div', 'vitals-status', this.root);
    this.#sprint = text('span', 'chip is-accent', 'SPRINT', status);
    this.#crouch = text('span', 'chip', 'CROUCH', status);

    this.#value.set(100, false);
  }

  update(
    health: number,
    maxHealth: number,
    sprinting: boolean,
    crouching: boolean,
    now: number
  ): boolean {
    const fraction = maxHealth > 0 ? Math.min(1, Math.max(0, health / maxHealth)) : 0;

    if (Math.abs(fraction - this.#fraction) > 0.001) {
      if (fraction > this.#fraction && this.#fraction >= 0) this.#regenUntil = now + REGEN_HOLD_MS;
      this.#fraction = fraction;
      this.#value.set(Math.ceil(health));
      const scale = fraction.toFixed(3);
      setVar(this.#fill, '--hp', scale);
      if (!this.#ghostPinned) setVar(this.#ghost, '--hp', scale);

      const hurt = fraction < 0.999;
      if (hurt !== this.#hurtState) {
        this.#hurtState = hurt;
        this.root.classList.toggle('is-hurt', hurt);
      }
      const critical = fraction < 0.25;
      if (critical !== this.#criticalState) {
        this.#criticalState = critical;
        this.root.classList.toggle('is-critical', critical);
      }
    }

    const regenerating = now < this.#regenUntil && fraction < 1;
    if (regenerating !== this.#regenState) {
      this.#regenState = regenerating;
      this.root.classList.toggle('is-regen', regenerating);
    }

    if (sprinting !== this.#sprintState) {
      this.#sprintState = sprinting;
      this.#sprint.classList.toggle('is-on', sprinting);
    }
    if (crouching !== this.#crouchState) {
      this.#crouchState = crouching;
      this.#crouch.classList.toggle('is-on', crouching);
    }

    return regenerating;
  }

  /** Pins the trailing fill, so a still can depict damage mid-recovery. */
  setGhostForShowcase(fraction: number): void {
    this.#ghostPinned = true;
    setVar(this.#ghost, '--hp', fraction.toFixed(3));
    this.#ghost.style.transition = 'none';
  }
}
