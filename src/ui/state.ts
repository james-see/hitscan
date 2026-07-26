import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { PlayerState, WeaponState } from '@/types/gameplay.ts';
import type { GameEvents } from '@/types/events.ts';

/**
 * The HUD reads live state from its siblings when they publish it, and falls
 * back to an event-derived model when they do not. That keeps the display
 * correct today, while the weapon and player workstreams are still landing,
 * without the UI ever writing to state it does not own.
 */

interface WeaponModuleLike extends GameModule {
  readonly state?: WeaponState;
}

interface PlayerModuleLike extends GameModule {
  readonly state?: PlayerState;
}

/** Stand-in ballistics used only while no weapon module publishes state. */
const FALLBACK = {
  magazineSize: 30,
  reserve: 240,
  spreadBase: 1.5,
  spreadMax: 7.5,
  spreadPerShot: 0.62,
  /** Degrees recovered per second. */
  spreadRecovery: 7,
  /** Extra cone at full sprint speed, in degrees. */
  spreadMovement: 2.4,
  adsSeconds: 0.22,
  reloadSeconds: 2.1,
  reloadSecondsTactical: 1.6,
} as const;

export interface HudSnapshot {
  weaponName: string;
  fireMode: string;
  ammo: number;
  magazineSize: number;
  reserve: number;
  ads: boolean;
  adsProgress: number;
  reloading: boolean;
  /** Cone-of-fire half-angle in degrees. */
  spreadDeg: number;
  health: number;
  maxHealth: number;
  sprinting: boolean;
  crouching: boolean;
  speed: number;
  /** Compass bearing in degrees, 0 = -Z, increasing clockwise. */
  headingDeg: number;
}

export class HudState {
  readonly snapshot: HudSnapshot = {
    weaponName: 'PRIMARY',
    fireMode: 'AUTO',
    ammo: FALLBACK.magazineSize,
    magazineSize: FALLBACK.magazineSize,
    reserve: FALLBACK.reserve,
    ads: false,
    adsProgress: 0,
    reloading: false,
    spreadDeg: FALLBACK.spreadBase,
    health: 100,
    maxHealth: 100,
    sprinting: false,
    crouching: false,
    speed: 0,
    headingDeg: 0,
  };

  #weapon: WeaponModuleLike | undefined;
  #player: PlayerModuleLike | undefined;

  #simSpread: number = FALLBACK.spreadBase;
  #simAds = 0;
  #simAdsTarget = 0;
  #simAmmo: number = FALLBACK.magazineSize;
  #simReserve: number = FALLBACK.reserve;
  #simReloading = false;
  #simHealth = 100;
  #simSprinting = false;
  #showcase = false;

  #forward = new THREE.Vector3();

  bind(ctx: EngineContext): void {
    this.#weapon = ctx.getModule<WeaponModuleLike>('weapon');
    this.#player = ctx.getModule<PlayerModuleLike>('player');
  }

  // -- event ingestion --------------------------------------------------------

  onFired(payload: GameEvents['weapon:fired']): void {
    this.#simAmmo = payload.ammo;
    this.#simSpread = Math.min(FALLBACK.spreadMax, this.#simSpread + FALLBACK.spreadPerShot);
  }

  onReloadStarted(): void {
    this.#simReloading = true;
  }

  onReloadFinished(payload: GameEvents['weapon:reload-finished']): void {
    const consumed = Math.max(0, payload.ammo - this.#simAmmo);
    this.#simReserve = Math.max(0, this.#simReserve - consumed);
    this.#simAmmo = payload.ammo;
    this.#simReloading = false;
  }

  onAdsChanged(payload: GameEvents['weapon:ads-changed']): void {
    this.#simAdsTarget = payload.ads ? 1 : 0;
  }

  onSprintChanged(payload: GameEvents['player:sprint-changed']): void {
    this.#simSprinting = payload.sprinting;
  }

  onPlayerDamaged(payload: GameEvents['combat:player-damaged']): void {
    this.#simHealth = payload.health;
  }

  onPlayerHealed(payload: GameEvents['combat:player-healed']): void {
    this.#simHealth = payload.health;
  }

  onWeaponEquipped(payload: GameEvents['weapon:equipped']): void {
    this.snapshot.weaponName = payload.weaponId.replace(/[-_]/g, ' ').toUpperCase();
  }

  // -- per-frame resolve ------------------------------------------------------

  update(dt: number, ctx: EngineContext): void {
    const s = this.snapshot;
    const weapon = this.#weapon?.state;
    const player = this.#player?.state;

    const speed = player?.speed ?? 0;
    const sprinting = player?.sprinting ?? this.#simSprinting;

    if (weapon) {
      const def = weapon.definition;
      s.weaponName = def.displayName.toUpperCase();
      s.fireMode = def.fireMode.toUpperCase();
      s.magazineSize = def.magazineSize;
      s.ammo = weapon.ammo;
      s.reserve = weapon.reserve;
      s.ads = weapon.ads;
      s.adsProgress = weapon.adsProgress;
      s.reloading = weapon.reloading;
      s.spreadDeg = weapon.spread;
    } else if (!this.#showcase) {
      // Bleed the simulated cone back down, then re-apply the movement penalty
      // so walking never reads as tighter than standing still.
      this.#simSpread = Math.max(
        FALLBACK.spreadBase,
        this.#simSpread - FALLBACK.spreadRecovery * dt
      );
      this.#simAds += THREE.MathUtils.clamp(
        (this.#simAdsTarget - this.#simAds) * (dt / FALLBACK.adsSeconds) * 3,
        -1,
        1
      );
      this.#simAds = THREE.MathUtils.clamp(this.#simAds, 0, 1);

      const movement = THREE.MathUtils.clamp(speed / 7.1, 0, 1) * FALLBACK.spreadMovement;
      s.ammo = this.#simAmmo;
      s.magazineSize = FALLBACK.magazineSize;
      s.reserve = this.#simReserve;
      s.ads = this.#simAdsTarget > 0.5;
      s.adsProgress = this.#simAds;
      s.reloading = this.#simReloading;
      s.spreadDeg = (this.#simSpread + movement) * (1 - 0.6 * this.#simAds);
    }

    if (!this.#showcase) {
      s.health = player?.health ?? this.#simHealth;
      s.sprinting = sprinting;
      s.crouching = player?.crouching ?? false;
      s.speed = speed;
    }

    ctx.camera.getWorldDirection(this.#forward);
    const bearing = Math.atan2(this.#forward.x, -this.#forward.z) * THREE.MathUtils.RAD2DEG;
    s.headingDeg = (bearing + 360) % 360;
  }

  /** Reload duration in seconds, from the weapon definition when available. */
  reloadSeconds(tactical: boolean): number {
    const def = this.#weapon?.state?.definition;
    if (def) return tactical ? def.reloadTimeTactical : def.reloadTime;
    return tactical ? FALLBACK.reloadSecondsTactical : FALLBACK.reloadSeconds;
  }

  /**
   * Pins the snapshot for a still capture. Only the heading keeps updating,
   * so the compass still reads the framing the shot preset chose.
   */
  overrideForShowcase(patch: Partial<HudSnapshot>): void {
    Object.assign(this.snapshot, patch);
    this.#showcase = true;
  }
}

/**
 * Converts a cone half-angle into the on-screen radius its edge projects to.
 * Uses the live camera FOV, so the reticle stays truthful through the ADS
 * transition without the UI needing to know the weapon's zoom.
 */
export function spreadToPixels(spreadDeg: number, ctx: EngineContext): number {
  const halfHeight = ctx.viewport.height / 2;
  const halfFov = Math.tan((ctx.camera.fov * THREE.MathUtils.DEG2RAD) / 2);
  if (halfFov <= 0) return 0;
  return (halfHeight * Math.tan(spreadDeg * THREE.MathUtils.DEG2RAD)) / halfFov;
}
