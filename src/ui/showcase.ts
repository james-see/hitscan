import type { DamageFeedback } from './widgets/DamageFeedback.ts';
import type { Hitmarker } from './widgets/Hitmarker.ts';
import type { Killfeed } from './widgets/Killfeed.ts';
import type { Notices } from './widgets/Notices.ts';
import type { HudState } from './state.ts';
import { setMotionFrozen } from './motion.ts';

/**
 * Representative HUD state for still captures.
 *
 * A screenshot of an idle HUD only shows the persistent widgets, so the
 * review harness would never see the hitmarker or the damage indicators. This
 * populates the transient layers and holds each animation at a chosen frame,
 * so a still can be judged on the moment the player actually experiences.
 *
 * Only ever runs behind the capture flag or ?hudDemo=1.
 */

export interface ShowcaseWidgets {
  root: HTMLElement;
  state: HudState;
  hitmarker: Hitmarker;
  damage: DamageFeedback;
  killfeed: Killfeed;
  notices: Notices;
  setGhost(fraction: number): void;
}

/** Holds a CSS animation at `seconds` into its timeline. */
function holdAt(node: Element, seconds: number): void {
  (node as HTMLElement).style.animationDelay = `-${seconds}s`;
}

export function applyShowcase(w: ShowcaseWidgets): void {
  w.root.classList.add('is-frozen');
  setMotionFrozen(true);

  w.state.overrideForShowcase({
    weaponName: 'MK-18',
    fireMode: 'AUTO',
    ammo: 12,
    magazineSize: 30,
    reserve: 186,
    health: 41,
    maxHealth: 100,
    spreadDeg: 2.4,
    adsProgress: 0,
    ads: false,
    reloading: false,
    sprinting: false,
    crouching: false,
  });
  // Depict the moment just after a burst landed: the trailing bar has not
  // caught up with the real health value yet.
  w.setGhost(0.68);

  for (const entry of [
    { killer: 'RAVEN-02', victim: 'HOSTILE 07', headshot: false },
    { killer: 'HOSTILE 04', victim: 'RAVEN-05', headshot: false },
    { killer: 'YOU', victim: 'HOSTILE 11', headshot: true },
  ]) {
    w.killfeed.push(entry, Number.POSITIVE_INFINITY);
  }
  for (const row of Array.from(w.killfeed.root.children)) holdAt(row, 0.3);

  w.notices.push('HOSTILE SQUAD INBOUND', Number.POSITIVE_INFINITY);
  for (const notice of Array.from(w.notices.root.children)) holdAt(notice, 0.25);

  // Just past the snap-in, where the marker is at full weight.
  w.hitmarker.trigger('head');
  holdAt(w.hitmarker.root, 0.05);
  const ring = w.hitmarker.root.querySelector('.hm-ring');
  if (ring) holdAt(ring, 0.09);

  holdAt(w.damage.pin(-118), 0.28);
}
