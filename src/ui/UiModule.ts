import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { Unsubscribe } from '@/types/events.ts';
import { HudState, spreadToPixels } from './state.ts';
import { loadPrefs, savePrefs, type UiPrefs } from './prefs.ts';
import { applyShowcase } from './showcase.ts';
import { AmmoCounter } from './widgets/AmmoCounter.ts';
import { Compass } from './widgets/Compass.ts';
import { Crosshair } from './widgets/Crosshair.ts';
import { DamageFeedback } from './widgets/DamageFeedback.ts';
import { Hitmarker } from './widgets/Hitmarker.ts';
import { Killfeed } from './widgets/Killfeed.ts';
import { Notices } from './widgets/Notices.ts';
import { SettingsMenu } from './widgets/SettingsMenu.ts';
import { Vitals } from './widgets/Vitals.ts';
import './hud.css';

/** Height at which the 8px grid is exactly 8 physical pixels. */
const REFERENCE_HEIGHT = 1080;
const SAVE_DEBOUNCE_MS = 300;
/** Window in which a `ui:killfeed` entry suppresses the `combat:actor-died` fallback. */
const FEED_DEDUPE_MS = 250;

/**
 * Owns the heads-up display and menus.
 *
 * The HUD is DOM: text stays crisp at any resolution and layout is free.
 * The cost of that choice is paid back by never touching layout at runtime —
 * per-frame work is limited to writing a handful of custom properties, and
 * only when the underlying value actually moved.
 *
 * Everything is driven off the event bus plus read-only getters on the weapon
 * and player modules; the UI never writes gameplay state.
 */
export class UiModule implements GameModule {
  readonly name = 'ui';
  readonly order: number;

  #root: HTMLElement | null = null;
  #prefs: UiPrefs = loadPrefs();
  #state = new HudState();

  #crosshair!: Crosshair;
  #hitmarker!: Hitmarker;
  #ammo!: AmmoCounter;
  #damage!: DamageFeedback;
  #compass!: Compass;
  #killfeed!: Killfeed;
  #notices!: Notices;
  #vitals!: Vitals;
  #settings: SettingsMenu | null = null;

  #unsubscribes: Unsubscribe[] = [];
  #feedVictims = new Map<string, number>();
  #saveTimer = 0;
  /** Current value of the CSS grid unit, in CSS pixels. */
  #unit = 8;

  constructor(order = 50) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    const host = document.getElementById('hud');
    if (!host) return;
    this.#root = host;

    this.#compass = new Compass(host);
    this.#killfeed = new Killfeed(host);
    this.#vitals = new Vitals(host);
    this.#ammo = new AmmoCounter(host);
    this.#damage = new DamageFeedback(host);
    this.#crosshair = new Crosshair(host);
    this.#hitmarker = new Hitmarker(host);
    this.#notices = new Notices(host);

    this.#state.bind(ctx);
    this.#applyPrefs(ctx);
    this.#applyScale(ctx.viewport.height);

    if (!ctx.capture) {
      this.#settings = new SettingsMenu(host, ctx, this.#prefs, {
        onSettingsChanged: () => {
          ctx.events.emit('engine:quality-changed', { preset: ctx.settings.preset });
          this.#scheduleSave(ctx);
        },
        onPrefsChanged: () => {
          this.#applyPrefs(ctx);
          this.#applyScale(ctx.viewport.height);
          this.#scheduleSave(ctx);
        },
        onResume: () => {
          this.#settings?.close();
          ctx.input.requestPointerLock();
        },
      });
    }

    this.#subscribe(ctx);

    if (isShowcaseRequested(ctx)) {
      applyShowcase({
        root: host,
        state: this.#state,
        hitmarker: this.#hitmarker,
        damage: this.#damage,
        killfeed: this.#killfeed,
        notices: this.#notices,
        setGhost: (fraction) => this.#vitals.setGhostForShowcase(fraction),
      });
    }
  }

  update(dt: number, ctx: EngineContext): void {
    if (!this.#root) return;

    this.#state.update(dt, ctx);
    const snapshot = this.#state.snapshot;
    const now = performance.now();

    this.#crosshair.update(
      spreadToPixels(snapshot.spreadDeg, ctx),
      snapshot.adsProgress,
      snapshot.sprinting,
      this.#unit
    );
    this.#ammo.update(
      snapshot.ammo,
      snapshot.reserve,
      snapshot.magazineSize,
      snapshot.weaponName,
      snapshot.fireMode
    );
    const regenerating = this.#vitals.update(
      snapshot.health,
      snapshot.maxHealth,
      snapshot.sprinting,
      snapshot.crouching,
      now
    );
    this.#damage.setHealth(snapshot.health, snapshot.maxHealth, regenerating);
    this.#damage.update(ctx, now);
    if (this.#prefs.showCompass) this.#compass.update(snapshot.headingDeg);
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes = [];
    window.clearTimeout(this.#saveTimer);
    this.#settings?.dispose();
    if (this.#root) this.#root.replaceChildren();
  }

  // -- wiring -----------------------------------------------------------------

  #subscribe(ctx: EngineContext): void {
    const on = ctx.events.on.bind(ctx.events);

    this.#unsubscribes.push(
      on('weapon:fired', (payload) => {
        this.#state.onFired(payload);
        this.#crosshair.onFired();
      }),
      on('weapon:reload-started', (payload) => {
        this.#state.onReloadStarted();
        this.#ammo.beginReload(this.#state.reloadSeconds(payload.tactical));
      }),
      on('weapon:reload-finished', (payload) => {
        this.#state.onReloadFinished(payload);
        this.#ammo.endReload();
      }),
      on('weapon:ads-changed', (payload) => this.#state.onAdsChanged(payload)),
      on('weapon:equipped', (payload) => this.#state.onWeaponEquipped(payload)),

      on('ui:hitmarker', ({ headshot, lethal }) => {
        this.#hitmarker.trigger(lethal ? 'kill' : headshot ? 'head' : 'hit');
      }),
      on('ui:killfeed', (entry) => {
        this.#feedVictims.set(entry.victim, performance.now());
        if (this.#prefs.showKillfeed) this.#killfeed.push(entry);
      }),
      on('ui:notify', ({ text, durationMs }) => this.#notices.push(text, durationMs)),

      on('combat:player-damaged', (payload) => {
        this.#state.onPlayerDamaged(payload);
        this.#damage.hit(payload.from, performance.now());
      }),
      on('combat:player-healed', (payload) => this.#state.onPlayerHealed(payload)),
      // A death is only logged here if nothing published a richer `ui:killfeed`
      // for it, so combat can own the wording when it wants to.
      on('combat:actor-died', ({ actorId, killerId, headshot }) => {
        if (killerId === null || !this.#prefs.showKillfeed) return;
        window.setTimeout(() => {
          const logged = this.#feedVictims.get(actorId) ?? -Infinity;
          if (performance.now() - logged < FEED_DEDUPE_MS) return;
          this.#killfeed.push({ killer: killerId, victim: actorId, headshot });
        }, 0);
      }),

      on('player:sprint-changed', (payload) => this.#state.onSprintChanged(payload)),

      on('engine:resized', ({ height }) => this.#applyScale(height)),
      on('engine:quality-changed', () => this.#settings?.syncAll()),

      // Escape releases the pointer, which is the pause signal in a
      // pointer-locked game; the menu follows that state rather than
      // second-guessing it.
      on('engine:pointer-lock', ({ locked }) => {
        if (locked) this.#settings?.close();
        else this.#settings?.open();
      })
    );
  }

  #applyPrefs(ctx: EngineContext): void {
    this.#crosshair.applyPrefs(this.#prefs);
    this.#compass.root.style.display = this.#prefs.showCompass ? '' : 'none';
    this.#killfeed.root.style.display = this.#prefs.showKillfeed ? '' : 'none';
    ctx.input.sensitivity = this.#prefs.sensitivity;
    ctx.input.adsSensitivityScale = this.#prefs.adsSensitivityScale;
    ctx.input.invertY = this.#prefs.invertY;
  }

  /**
   * Scales the whole HUD from viewport height with a sub-linear curve, so a
   * 4K display gets a larger HUD without it growing proportionally huge.
   */
  #applyScale(viewportHeight: number): void {
    if (!this.#root) return;
    const base = Math.pow(Math.max(240, viewportHeight) / REFERENCE_HEIGHT, 0.7);
    const scale = Math.min(1.8, Math.max(0.7, base * this.#prefs.hudScale));
    this.#root.style.setProperty('--ui-scale', scale.toFixed(3));
    this.#unit = 8 * scale;
  }

  #scheduleSave(ctx: EngineContext): void {
    window.clearTimeout(this.#saveTimer);
    this.#saveTimer = window.setTimeout(() => {
      ctx.settings.save();
      savePrefs(this.#prefs);
    }, SAVE_DEBOUNCE_MS);
  }
}

function isShowcaseRequested(ctx: EngineContext): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('hudDemo') === '1') return true;
  return ctx.capture && params.get('hud') === '1';
}
