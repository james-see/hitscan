import type { SurfaceKind, SurfaceProfile, WeaponDefinition } from '@/types/gameplay.ts';

/**
 * The MK4 "Vector" carbine — the game's hero primary.
 *
 * Numbers are tuned against the modern-military-shooter reference point: a
 * 700rpm assault rifle that kills in four chest rounds inside 28m, five past
 * it, and three with a head hit. That gives a 257ms optimal time-to-kill,
 * fast enough to feel lethal without removing the reaction window that makes
 * gunfights readable.
 */
export const MK4_CARBINE: WeaponDefinition = {
  id: 'mk4_carbine',
  displayName: 'MK4 Carbine',
  fireRate: 700,
  fireMode: 'auto',
  magazineSize: 30,
  reserveAmmo: 210,
  damage: 26,
  headshotMultiplier: 1.6,
  falloffStart: 28,
  falloffEnd: 55,
  // Five-shot kill at long range rather than six: the extra round mostly
  // punishes players who correctly chose to engage at distance.
  falloffMin: 0.78,
  muzzleVelocity: 880,
  adsTime: 0.22,
  adsFov: 55,
  reloadTime: 2.4,
  reloadTimeTactical: 1.95,

  recoil: {
    // 0.42 deg/shot over a 30-round magazine is ~12.6 degrees of total
    // climb: enough that holding the trigger past ten rounds costs accuracy,
    // little enough that a learned pull-down keeps every round on a torso.
    vertical: 0.42,
    horizontal: 0.2,
    // A quarter of the kick is random. Below ~0.2 the pattern feels like a
    // scripted animation; above ~0.35 it stops being learnable.
    randomness: 0.26,
    recovery: 22,
    recoveryDelay: 0.14,
    adsMultiplier: 0.72,
    /**
     * Horizontal pattern, one entry per shot, cycled. Shaped as a lazy "J":
     * straight up for the first four (so a burst is a free headshot), then a
     * drift right, then a sharper sweep left. Learnable, and distinct enough
     * from a sine wave that muscle memory pays off.
     */
    pattern: [0, 0.1, -0.1, 0.15, 0.45, 0.7, 0.85, 0.6, 0.15, -0.45, -0.8, -1, -0.85, -0.4, 0.1, 0.5],
  },

  spread: {
    // Degrees of cone half-angle. Hip fire is deliberately punishing past
    // ~12m; ADS multiplies down to 0.27 degrees, effectively a laser for the
    // first few rounds.
    base: 1.5,
    max: 6.2,
    perShot: 0.3,
    recovery: 5.5,
    /** Added at full sprint speed, scaled linearly with horizontal speed. */
    movementPenalty: 1.6,
    /** Added while airborne. */
    jumpPenalty: 3.4,
    /** Subtracted while crouched, floored at zero. */
    crouchBonus: 0.45,
    adsMultiplier: 0.18,
  },
};

/**
 * Ballistic response per surface.
 *
 * `penetration` is the fraction of damage a round retains after passing
 * clean through, before the thickness term. Thin sheet metal and wood are
 * the intended "shoot through this" materials; concrete stops rounds after a
 * few centimetres, which keeps hard cover meaningful.
 */
export const SURFACE_PROFILES: Readonly<Record<SurfaceKind, SurfaceProfile>> = {
  concrete: { kind: 'concrete', penetration: 0.32, maxThickness: 0.12, ricochet: 0.08, loudness: 0.85 },
  metal: { kind: 'metal', penetration: 0.55, maxThickness: 0.06, ricochet: 0.22, loudness: 1 },
  wood: { kind: 'wood', penetration: 0.72, maxThickness: 0.25, ricochet: 0.04, loudness: 0.6 },
  dirt: { kind: 'dirt', penetration: 0.25, maxThickness: 0.3, ricochet: 0.02, loudness: 0.4 },
  sand: { kind: 'sand', penetration: 0.18, maxThickness: 0.35, ricochet: 0.01, loudness: 0.35 },
  glass: { kind: 'glass', penetration: 0.92, maxThickness: 0.05, ricochet: 0, loudness: 0.7 },
  water: { kind: 'water', penetration: 0.4, maxThickness: 1.2, ricochet: 0.05, loudness: 0.5 },
  fabric: { kind: 'fabric', penetration: 0.88, maxThickness: 0.4, ricochet: 0, loudness: 0.25 },
  foliage: { kind: 'foliage', penetration: 0.95, maxThickness: 1.5, ricochet: 0, loudness: 0.2 },
  flesh: { kind: 'flesh', penetration: 0.65, maxThickness: 0.45, ricochet: 0, loudness: 0.55 },
};

export function surfaceProfile(kind: SurfaceKind): SurfaceProfile {
  return SURFACE_PROFILES[kind] ?? SURFACE_PROFILES.concrete;
}
