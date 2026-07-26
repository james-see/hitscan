import * as THREE from 'three';
import type { EngineContext } from '@/types/engine.ts';
import { ICONS, el, icon, retrigger, setVar } from '../dom.ts';

const MAX_INDICATORS = 6;
const INDICATOR_MS = 1250;

interface Indicator {
  root: HTMLElement;
  inner: HTMLElement;
  source: THREE.Vector3;
  expiresAt: number;
  angle: number;
  /** Showcase indicators hold a literal bearing instead of tracking a source. */
  pinned: boolean;
}

/**
 * Screen-space damage response: a directional arc per hit, a single-frame
 * flash, and a blood vignette that deepens as health falls.
 *
 * Indicators keep their world-space source and are re-projected every frame,
 * so turning toward an attacker sweeps the arc around to the top of the
 * screen instead of leaving it frozen where the hit landed.
 */
export class DamageFeedback {
  #vignette: HTMLElement;
  #flash: HTMLElement;
  #container: HTMLElement;
  #pool: Indicator[] = [];
  #active: Indicator[] = [];

  #forward = new THREE.Vector3();
  #toSource = new THREE.Vector3();
  #hurt = -1;
  #critical = false;
  #regenerating = false;

  constructor(parent: Element) {
    this.#vignette = el('div', 'vignette', parent);
    this.#flash = el('div', 'hurt-flash', parent);
    this.#container = el('div', 'dmg-dirs', parent);
  }

  hit(source: THREE.Vector3, now: number): void {
    retrigger(this.#flash, 'is-hit');

    const indicator = this.#acquire();
    indicator.source.copy(source);
    indicator.expiresAt = now + INDICATOR_MS;
    indicator.angle = Number.NaN;
    indicator.pinned = false;
    retrigger(indicator.inner, 'is-on');
    this.#active.push(indicator);
  }

  /** Places a non-expiring indicator at a literal bearing, for still captures. */
  pin(angleDeg: number): HTMLElement {
    const indicator = this.#acquire();
    indicator.expiresAt = Number.POSITIVE_INFINITY;
    indicator.pinned = true;
    indicator.angle = angleDeg;
    setVar(indicator.root, '--angle', `${angleDeg}deg`);
    retrigger(indicator.inner, 'is-on');
    this.#active.push(indicator);
    return indicator.inner;
  }

  /** @param regenerating true while health is climbing back, not falling. */
  setHealth(health: number, maxHealth: number, regenerating: boolean): void {
    const fraction = maxHealth > 0 ? THREE.MathUtils.clamp(health / maxHealth, 0, 1) : 0;
    const hurt = Math.pow(THREE.MathUtils.clamp((0.85 - fraction) / 0.85, 0, 1), 1.3);
    if (regenerating !== this.#regenerating) {
      this.#regenerating = regenerating;
      this.#vignette.classList.toggle('is-regen', regenerating);
    }
    if (Math.abs(hurt - this.#hurt) > 0.005) {
      this.#hurt = hurt;
      setVar(this.#vignette, '--hurt', hurt.toFixed(3));
    }
    const critical = fraction < 0.25;
    if (critical !== this.#critical) {
      this.#critical = critical;
      this.#vignette.classList.toggle('is-critical', critical);
    }
  }

  update(ctx: EngineContext, now: number): void {
    if (this.#active.length === 0) return;

    ctx.camera.getWorldDirection(this.#forward);
    const fx = this.#forward.x;
    const fz = this.#forward.z;
    // Right-hand normal of the flattened view direction.
    const rx = -fz;
    const rz = fx;

    for (let i = this.#active.length - 1; i >= 0; i--) {
      const indicator = this.#active[i] as Indicator;
      if (indicator.pinned) continue;
      if (now >= indicator.expiresAt) {
        indicator.root.style.display = 'none';
        indicator.inner.classList.remove('is-on');
        this.#active.splice(i, 1);
        this.#pool.push(indicator);
        continue;
      }
      this.#toSource.subVectors(indicator.source, ctx.camera.position);
      const dx = this.#toSource.x;
      const dz = this.#toSource.z;
      if (dx * dx + dz * dz < 1e-6) continue;
      const angle =
        Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * THREE.MathUtils.RAD2DEG;
      if (!(Math.abs(angle - indicator.angle) < 0.4)) {
        indicator.angle = angle;
        setVar(indicator.root, '--angle', `${angle.toFixed(1)}deg`);
      }
    }
  }

  #acquire(): Indicator {
    const recycled = this.#pool.pop();
    if (recycled) {
      recycled.root.style.display = '';
      return recycled;
    }
    if (this.#active.length >= MAX_INDICATORS) {
      // Oldest first: the newest hit is the one the player must react to.
      const oldest = this.#active.shift() as Indicator;
      return oldest;
    }
    const root = el('div', 'dmg-dir', this.#container);
    const inner = el('div', 'dmg-dir-inner', root);
    inner.appendChild(icon('', '0 0 64 18', ...ICONS.arc));
    return {
      root,
      inner,
      source: new THREE.Vector3(),
      expiresAt: 0,
      angle: Number.NaN,
      pinned: false,
    };
  }
}
