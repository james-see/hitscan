import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { Unsubscribe } from '@/types/events.ts';
import type { MatchPhase, MatchSnapshot, ScoreRow } from '@/match/rules.ts';
import { HudState, spreadToPixels } from './state.ts';
import { loadPrefs, savePrefs, type UiPrefs } from './prefs.ts';
import { applyShowcase } from './showcase.ts';
import { actorName } from './names.ts';
import { AmmoCounter } from './widgets/AmmoCounter.ts';
import { Compass } from './widgets/Compass.ts';
import { Crosshair } from './widgets/Crosshair.ts';
import { DamageFeedback } from './widgets/DamageFeedback.ts';
import { DeathNotice } from './widgets/DeathNotice.ts';
import { Hitmarker } from './widgets/Hitmarker.ts';
import { Killfeed } from './widgets/Killfeed.ts';
import { MatchHud } from './widgets/MatchHud.ts';
import { MatchScreens } from './widgets/MatchScreens.ts';
import { Notices } from './widgets/Notices.ts';
import { Scoreboard } from './widgets/Scoreboard.ts';
import { SettingsMenu } from './widgets/SettingsMenu.ts';
import { Vitals } from './widgets/Vitals.ts';
import './hud.css';

/** The slice of the match module the HUD reads and drives. Duck-typed. */
interface MatchLike {
  readonly snapshot: MatchSnapshot;
  readonly rosterSize: number;
  rows(): ScoreRow[];
  requestStart(): void;
  returnToLobby(): void;
}

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
  #matchHud!: MatchHud;
  #settings: SettingsMenu | null = null;
  #screens: MatchScreens | null = null;
  #scoreboard: Scoreboard | null = null;
  #death: DeathNotice | null = null;
  #match: MatchLike | null = null;
  /** Last phase the overlays were rendered for; drives the transitions. */
  #phase: MatchPhase | null = null;
  /** Mirrors the round's respawn window, so the reticle can go with the body. */
  #dead = false;
  #showcase = false;

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
    // Mounted with the compass rather than last: the scoreline sits directly
    // under it and both have to take the damage vignette the same way, which
    // is decided by paint order against the vignette's own node.
    this.#matchHud = new MatchHud(host);
    this.#killfeed = new Killfeed(host);
    this.#vitals = new Vitals(host);
    this.#ammo = new AmmoCounter(host);
    this.#damage = new DamageFeedback(host);
    this.#crosshair = new Crosshair(host);
    this.#hitmarker = new Hitmarker(host);
    this.#notices = new Notices(host);

    this.#match = ctx.getModule<GameModule & MatchLike>('match') ?? null;

    this.#state.bind(ctx);
    this.#applyPrefs(ctx);
    this.#applyScale(ctx.viewport.height);

    if (!ctx.capture) {
      this.#death = new DeathNotice(host);
      this.#scoreboard = new Scoreboard(host);
      this.#screens = new MatchScreens(host, {
        onDeploy: () => this.#deploy(ctx),
        onPlayAgain: () => this.#deploy(ctx),
        onLobby: () => this.#match?.returnToLobby(),
      });
    }

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

    this.#showcase = isShowcaseRequested(ctx);
    if (this.#showcase) {
      applyShowcase({
        root: host,
        state: this.#state,
        hitmarker: this.#hitmarker,
        damage: this.#damage,
        killfeed: this.#killfeed,
        notices: this.#notices,
        matchHud: this.#matchHud,
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
    this.#updateMatch(ctx);
  }

  /**
   * Round state is polled rather than mirrored from every transition.
   *
   * The phase is the single thing that decides which overlay is up, so reading
   * it once a frame keeps the lobby, the results screen and the HUD from ever
   * disagreeing about what is happening — which is exactly what a second copy
   * of the state machine in the UI would eventually do.
   */
  #updateMatch(ctx: EngineContext): void {
    const match = this.#match;
    // A showcase still pins the whole HUD, including the scoreline, and the
    // phase poll would immediately hide it again.
    if (!match || this.#showcase) return;
    const state = match.snapshot;

    if (state.phase !== this.#phase) {
      this.#phase = state.phase;
      this.#applyPhase(state);
    }

    if (state.awaitingRespawn !== this.#dead) {
      this.#dead = state.awaitingRespawn;
      this.#root?.classList.toggle('is-dead', state.awaitingRespawn);
    }
    if (state.awaitingRespawn) this.#death?.setCountdown(state.respawnIn);

    const board = this.#scoreboard;
    if (board) {
      // Held, not toggled, and only while there is a round to report on.
      board.setOpen(state.phase === 'live' && ctx.input.isDown('scoreboard'));
      board.update(state, match.rows());
    }
  }

  #applyPhase(state: MatchSnapshot): void {
    const match = this.#match;
    if (!match) return;

    switch (state.phase) {
      case 'pregame':
        this.#matchHud.setVisible(false);
        this.#death?.hide();
        this.#scoreboard?.setOpen(false);
        this.#screens?.showPregame(state, match.rosterSize);
        break;
      case 'live':
        this.#screens?.close();
        this.#matchHud.setMode(state.mode);
        this.#matchHud.setVisible(true);
        break;
      case 'ended':
        this.#matchHud.setVisible(false);
        this.#death?.hide();
        this.#scoreboard?.setOpen(false);
        this.#screens?.showResults(state, match.rows());
        break;
      case 'idle':
      default:
        this.#matchHud.setVisible(false);
        this.#screens?.close();
        break;
    }
  }

  /**
   * Enters a round from the lobby or the results screen.
   *
   * Pointer lock is requested from inside the click handler because it needs
   * the user gesture; the round is started first so the player is already
   * spawned and playable by the time the view is captured.
   */
  #deploy(ctx: EngineContext): void {
    this.#match?.requestStart();
    ctx.input.requestPointerLock();
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes = [];
    window.clearTimeout(this.#saveTimer);
    this.#settings?.dispose();
    this.#screens?.dispose();
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
        if (this.#prefs.showKillfeed) this.#pushFeed(entry.killer, entry.victim, entry.headshot);
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
          this.#pushFeed(killerId, actorId, headshot);
        }, 0);
      }),

      on('player:sprint-changed', (payload) => this.#state.onSprintChanged(payload)),

      // -- round ---------------------------------------------------------------
      on('match:started', ({ mode }) => {
        this.#matchHud.setMode(mode);
        this.#matchHud.setScores(0, 0);
        // A second round must not open with the first one's eliminations
        // still ageing out of the feed.
        this.#killfeed.clear();
        this.#feedVictims.clear();
      }),
      on('match:score-changed', ({ playerScore, opponentScore }) => {
        this.#matchHud.setScores(playerScore, opponentScore);
      }),
      on('match:tick', ({ remainingSeconds }) => this.#matchHud.setClock(remainingSeconds)),
      on('player:died', ({ killerId }) => this.#death?.show(killerId)),
      on('player:respawned', () => this.#death?.hide()),

      on('engine:resized', ({ height }) => this.#applyScale(height)),
      on('engine:quality-changed', () => this.#settings?.syncAll()),

      // Escape releases the pointer, which is the pause signal in a
      // pointer-locked game; the menu follows that state rather than
      // second-guessing it.
      on('engine:pointer-lock', ({ locked }) => {
        if (locked) this.#settings?.close();
        else if (this.#settingsAllowed()) this.#settings?.open();
      })
    );
  }

  /**
   * The lobby and the results screen are menus already; stacking the pause
   * menu on top of one would put two overlays in front of the player and steal
   * the buttons underneath.
   */
  #settingsAllowed(): boolean {
    const phase = this.#match?.snapshot.phase;
    return phase === undefined || phase === 'live';
  }

  /** Feed rows carry actor ids; the display name is resolved here. */
  #pushFeed(killerId: string, victimId: string, headshot: boolean): void {
    this.#killfeed.push({
      killer: actorName(killerId),
      victim: actorName(victimId),
      headshot,
    });
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
