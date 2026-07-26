#!/usr/bin/env node
/**
 * End-to-end drive of the round layer, in real Chrome.
 *
 * Plays complete rounds rather than unit-testing the module: deploy from the
 * lobby, score kills, take damage, die, respawn, reach the score limit, read
 * the results screen, restart, and check the second round starts from zero.
 * Every assertion is made against the same surfaces a player uses — the HUD
 * DOM and the event bus — so a regression that only breaks the wiring still
 * fails here.
 *
 * Kills and player damage are injected as the exact `combat:*` event pairs
 * that ballistics and `Bot.#fireShot` publish, which is the same path the real
 * weapons take. Nothing else is faked: the match module, the player module and
 * the AI all run normally.
 *
 * Usage: node src/match/e2e/round.mjs [--keep-open]
 */

import { startServer, launchBrowser } from '../../../tools/critic/capture.mjs';

const SCORE_LIMIT = 3;
/** Round clock the drive runs with, in seconds. */
const TIME_LIMIT = 120;
const RESPAWN_SECONDS = 1.2;
const ROSTER = 10;

const LOGGED_EVENTS = [
  'match:started',
  'match:score-changed',
  'match:tick',
  'match:ended',
  'player:died',
  'player:respawned',
  'combat:actor-died',
  'ai:spawned',
  'game:restart',
  'game:paused',
  'weapon:fired',
  'ui:killfeed',
];

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// -- page-side helpers --------------------------------------------------------

/** Subscribes to the event bus and records everything into `window.__log`. */
function installRecorder(names) {
  const log = [];
  window.__log = log;
  const bus = window.engine.events;
  for (const name of names) {
    bus.on(name, (payload) => {
      let copy = null;
      try {
        copy = JSON.parse(JSON.stringify(payload ?? null));
      } catch {
        copy = null;
      }
      log.push({ name, payload: copy, at: performance.now() });
    });
  }
}

/**
 * Reads the round state the way a player does: off the HUD.
 *
 * Deliberately not off the match module's snapshot. A scoreline the module
 * knows about but never renders is exactly the class of bug this run exists to
 * catch.
 */
function readHud() {
  const q = (selector) => document.querySelector(selector);
  const digits = (node) => (node ? node.textContent.trim() : null);
  const on = (selector, className) => q(selector)?.classList.contains(className) ?? false;

  return {
    hudVisible: on('.match', 'is-on'),
    playerScore: digits(q('.match-score.is-mine')),
    opponentScore: digits(q('.match-side:last-of-type .match-score')),
    clock: digits(q('.match-clock')),
    mode: digits(q('.match-mode')),
    health: digits(q('.vitals-value')),
    lobbyOpen: on('.mscreen', 'is-pregame') && on('.mscreen', 'is-open'),
    resultsOpen: on('.mscreen', 'is-results') && on('.mscreen', 'is-open'),
    hostiles: digits(q('.mscreen-rule:last-child .mscreen-rule-value')),
    outcome: digits(q('.mscreen-outcome')),
    finalMine: digits(q('.mscreen-final-mine')),
    finalTheirs: digits(q('.mscreen-final-theirs')),
    reason: digits(q('.mscreen-reason')),
    deathVisible: on('.death', 'is-on'),
    deathKiller: digits(q('.death-killer')),
    deathCountdown: digits(q('.death-respawn')),
    scoreboardOpen: on('.scorebd', 'is-open'),
    scoreboardRows: [...document.querySelectorAll('.scorebd .stable-body .stable-row')].map((row) => ({
      name: row.querySelector('.stable-name')?.textContent.trim(),
      kills: row.querySelectorAll('.stable-num')[0]?.textContent.trim(),
      deaths: row.querySelectorAll('.stable-num')[1]?.textContent.trim(),
      isPlayer: row.classList.contains('is-player'),
    })),
    resultRows: document.querySelectorAll('.mscreen .stable-body .stable-row').length,
    killfeedRows: [...document.querySelectorAll('.kf-row')].map((row) => ({
      killer: row.querySelector('.kf-killer')?.textContent.trim(),
      victim: row.querySelector('.kf-victim')?.textContent.trim(),
      death: row.classList.contains('is-death'),
    })),
    move: { x: window.engine.input.move.x, y: window.engine.input.move.y },
    lockedOut: window.engine.input.lockedOut,
  };
}

/**
 * Freezes the simulation so single fixed steps can be driven by hand.
 *
 * The deferred death commit is a one-step behaviour, and asserting it against
 * the rAF loop would be asserting against whatever the browser happened to
 * schedule. This is the same mechanism the capture bridge uses: a zero time
 * scale stops the fixed steps while the loop keeps presenting.
 */
function freezeSimulation() {
  window.engine.time.scale = 0;
}

function thawSimulation() {
  window.engine.time.scale = 1;
}

/** Advances exactly one fixed step at 120Hz. */
function stepOnce() {
  const engine = window.engine;
  engine.time.scale = 1;
  engine.stepManual(1 / 120);
  engine.time.scale = 0;
}

/** Kills a bot along the player's attribution path. */
function killBot(actorId) {
  const bus = window.engine.events;
  const point = window.engine.camera.position.clone();
  const direction = point.clone().set(0, 0, -1);
  bus.emit('combat:damage-dealt', {
    targetId: actorId,
    sourceId: 'player',
    amount: 400,
    hitbox: 'head',
    point,
    direction,
    lethal: true,
  });
}

/**
 * Applies damage to the player as a bot's lethal round does: the health-bearing
 * `combat:player-damaged` first, then the attributed `combat:damage-dealt`.
 */
function hurtPlayer({ botId, amount, health }) {
  const bus = window.engine.events;
  const point = window.engine.camera.position.clone();
  point.x += 6;
  point.z += 6;
  const direction = point.clone().set(0.7, 0, 0.7);
  bus.emit('combat:player-damaged', { amount, from: point, health });
  bus.emit('combat:damage-dealt', {
    targetId: 'player',
    sourceId: botId,
    amount,
    hitbox: null,
    point,
    direction,
    lethal: health <= 0,
  });
}

/**
 * Lands a lethal round on the player and the round's final point inside one
 * task, so no fixed step can run between them.
 *
 * This is the shape a one-step deferral is most likely to break on: the death is
 * raised and still uncommitted at the moment the match declares itself over.
 */
function raceDeathWithFinalKill({ killerId, botId }) {
  const bus = window.engine.events;

  const wound = window.engine.camera.position.clone();
  wound.x += 6;
  wound.z += 6;
  bus.emit('combat:player-damaged', { amount: 120, from: wound, health: 0 });
  bus.emit('combat:damage-dealt', {
    targetId: 'player',
    sourceId: killerId,
    amount: 120,
    hitbox: null,
    point: wound,
    direction: wound.clone().set(0.7, 0, 0.7),
    lethal: true,
  });

  const aim = window.engine.camera.position.clone();
  bus.emit('combat:damage-dealt', {
    targetId: botId,
    sourceId: 'player',
    amount: 400,
    hitbox: 'chest',
    point: aim,
    direction: aim.clone().set(0, 0, -1),
    lethal: true,
  });
}

// -- driver -------------------------------------------------------------------

async function main() {
  // Snapshotted. The snapshot directory used to be shared between concurrent
  // runs, which is why this drive served the live tree instead; it is now
  // per-process, and serving a tree that another agent is mid-edit in cost
  // this drive two runs to spurious failures. The snapshot is also
  // type-checked first, so a break elsewhere is reported as such rather than
  // as a round-layer regression.
  const server = await startServer();
  const browser = await launchBrowser();

  const consoleErrors = [];
  let page;

  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark' });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    const query = new URLSearchParams({
      bots: String(ROSTER),
      matchScore: String(SCORE_LIMIT),
      matchTime: String(TIME_LIMIT),
      matchRespawn: String(RESPAWN_SECONDS),
    });

    const boot = async (extra = {}) => {
      const params = new URLSearchParams(query);
      for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
      await page.goto(`${server.url}/?${params}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });

      // `__READY` only means a frame was presented; it does not mean the loop
      // survived. An exception out of the render pipeline kills the rAF loop
      // while the page still looks alive, and every fixed-timestep assertion
      // below then fails for a reason that has nothing to do with the round.
      // Several agents edit this tree continuously, so that is a real state to
      // land in rather than a hypothetical one.
      try {
        await page.waitForFunction(
          (since) => window.engine.time.tick > since,
          await page.evaluate(() => window.engine.time.tick),
          { timeout: 5_000, polling: 50 }
        );
      } catch {
        throw new Error(
          'the engine loop is not advancing: the served tree is broken, not the round layer.\n' +
            `  console: ${consoleErrors.slice(0, 3).join('\n           ') || '(none)'}`
        );
      }

      await page.evaluate(installRecorder, LOGGED_EVENTS);
    };

    /**
     * Waits for a DOM condition instead of a fixed pause.
     *
     * The overlays are driven from `update`, so they land a frame or two after
     * the event that causes them. A flat timeout is fine on an idle machine and
     * a coin toss on a loaded one, and the failure it produces reads as the
     * transition never happening.
     */
    const settle = async (predicate) => {
      try {
        await page.waitForFunction(predicate, null, { timeout: 10_000, polling: 50 });
        return true;
      } catch {
        return false;
      }
    };

    const resultsClosed = () =>
      !(document.querySelector('.mscreen')?.classList.contains('is-open') ?? false);
    const roundHudUp = () =>
      document.querySelector('.match')?.classList.contains('is-on') ?? false;
    const lobbyUp = () => {
      const s = document.querySelector('.mscreen');
      return (s?.classList.contains('is-open') && s.classList.contains('is-pregame')) ?? false;
    };

    const hud = () => page.evaluate(readHud);
    const log = () => page.evaluate(() => window.__log);
    const waitFor = (name, timeout = 15_000) =>
      page.waitForFunction(
        (wanted) => window.__log.some((entry) => entry.name === wanted),
        name,
        { timeout, polling: 50 }
      );
    const clearLog = () => page.evaluate(() => (window.__log.length = 0));
    const countOf = async (name) => (await log()).filter((e) => e.name === name).length;
    const last = async (name) => {
      const entries = (await log()).filter((e) => e.name === name);
      return entries.length > 0 ? entries[entries.length - 1] : null;
    };

    // -- boot into the lobby -------------------------------------------------
    section('lobby');
    await boot();

    let view = await hud();
    check('lobby is open on boot', view.lobbyOpen);
    check('results screen is not open', !view.resultsOpen);
    check('round HUD is hidden before deploy', !view.hudVisible);
    equal('lobby reports the full roster', view.hostiles, String(ROSTER));
    equal('no round has started', await countOf('match:started'), 0);
    equal('player starts at full health', view.health, '100');

    // The lobby freezes the player, so gameplay keys must do nothing.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(150);
    view = await hud();
    check('movement is locked out in the lobby', view.move.x === 0 && view.move.y === 0, JSON.stringify(view.move));
    check('the lobby holds an input lockout', view.lockedOut);
    await page.keyboard.up('KeyW');

    // -- round one -----------------------------------------------------------
    section('round one');
    await page.click('.mscreen-panel--pregame .mscreen-cta');
    await waitFor('match:started');
    await page.waitForTimeout(120);

    view = await hud();
    check('lobby closes on deploy', !view.lobbyOpen);
    check('round HUD appears', view.hudVisible);
    equal('mode is free-for-all', view.mode, 'FREE-FOR-ALL');
    equal('score opens at zero', view.playerScore, '0');
    equal('opponent score opens at zero', view.opponentScore, '0');

    const started = await last('match:started');
    equal('match:started carries the score limit', started.payload.scoreLimit, SCORE_LIMIT);

    // Clock runs on the fixed timestep and is published once a second.
    const clockAtStart = view.clock;
    await page.waitForTimeout(2200);
    view = await hud();
    check('round clock counts down', view.clock !== clockAtStart, `${clockAtStart} -> ${view.clock}`);
    const ticks = (await log()).filter((e) => e.name === 'match:tick').map((e) => e.payload.remainingSeconds);
    check(
      'match:tick is monotonic and once per second',
      ticks.length >= 2 && ticks.every((v, i) => i === 0 || v === ticks[i - 1] - 1),
      JSON.stringify(ticks)
    );

    // Two kills on the player's attribution path.
    await page.evaluate(killBot, 'bot-03');
    await page.waitForTimeout(80);
    await page.evaluate(killBot, 'bot-07');
    await page.waitForTimeout(200);

    view = await hud();
    equal('player score follows bot deaths', view.playerScore, '2');
    equal('opponent score is untouched', view.opponentScore, '0');
    check(
      'killfeed names the player and the bot',
      view.killfeedRows.some((row) => row.killer === 'YOU' && row.victim === 'HOTEL'),
      JSON.stringify(view.killfeedRows)
    );

    // Damage, short of lethal.
    await page.evaluate(hurtPlayer, { botId: 'bot-01', amount: 58, health: 42 });
    await page.waitForTimeout(200);
    view = await hud();
    equal('health reflects the hit', view.health, '42');
    equal('a wound is not a death', view.opponentScore, '0');

    // -- death -------------------------------------------------------------
    section('death and respawn');
    // Cleared first: deploying already published a `player:respawned` for the
    // initial spawn, and waiting on the name alone would match that one and
    // assert against a player who is still lying on the floor.
    await clearLog();
    await page.evaluate(hurtPlayer, { botId: 'bot-01', amount: 42, health: 0 });
    await waitFor('player:died');
    await page.waitForTimeout(150);

    const died = await last('player:died');
    equal('player:died credits the shooter', died.payload.killerId, 'bot-01');

    view = await hud();
    check('death notice appears', view.deathVisible);
    equal('death notice names the killer', view.deathKiller, 'BRAVO');
    check('respawn countdown is shown', /RESPAWNING/.test(view.deathCountdown ?? ''), view.deathCountdown);
    equal('opponent scores the kill', view.opponentScore, '1');
    equal('health reads zero', view.health, '0');
    check(
      'the player death is styled as a death in the feed',
      view.killfeedRows.some((row) => row.death && row.victim === 'YOU'),
      JSON.stringify(view.killfeedRows)
    );

    // Input and firing are both locked out while dead.
    const firedBeforeDeath = await countOf('weapon:fired');
    await page.keyboard.down('KeyW');
    await page.mouse.down();
    await page.waitForTimeout(250);
    view = await hud();
    check('movement is locked out while dead', view.move.x === 0 && view.move.y === 0, JSON.stringify(view.move));
    check('death holds an input lockout', view.lockedOut);
    equal('firing is locked out while dead', await countOf('weapon:fired'), firedBeforeDeath);
    await page.mouse.up();
    await page.keyboard.up('KeyW');

    await waitFor('player:respawned');
    await page.waitForTimeout(200);
    const respawned = await last('player:respawned');
    check(
      'respawn position is a real point in the arena',
      Number.isFinite(respawned.payload.position.x) && Number.isFinite(respawned.payload.position.z),
      JSON.stringify(respawned.payload.position)
    );
    check(
      'respawn moved the player away from where they died',
      Math.hypot(respawned.payload.position.x, respawned.payload.position.z) > 0.5
    );

    view = await hud();
    check('death notice clears on respawn', !view.deathVisible);
    equal('respawn restores full health', view.health, '100');
    check('respawn lifts the lockout', !view.lockedOut);

    // Movement is live again.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(150);
    view = await hud();
    check('movement is restored after respawn', view.move.y > 0.5, JSON.stringify(view.move));
    await page.keyboard.up('KeyW');

    // Spend ammo while alive. Round two asserts the magazine refills, and that
    // check is vacuous unless something actually empties it first -- every
    // other shot in this drive is fired while dead and locked out.
    const firedBeforeBurst = await countOf('weapon:fired');
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.waitForTimeout(150);
    check(
      'firing works again after respawn',
      (await countOf('weapon:fired')) > firedBeforeBurst,
      `fired ${await countOf('weapon:fired')}, was ${firedBeforeBurst}`
    );

    // -- scoreboard --------------------------------------------------------
    section('scoreboard');
    await page.keyboard.down('Tab');
    await page.waitForTimeout(200);
    view = await hud();
    check('Tab opens the scoreboard', view.scoreboardOpen);
    equal('scoreboard lists the player and every bot', view.scoreboardRows.length, ROSTER + 1);
    const playerRow = view.scoreboardRows.find((row) => row.isPlayer);
    equal('scoreboard shows the player kills', playerRow?.kills, '2');
    equal('scoreboard shows the player deaths', playerRow?.deaths, '1');
    await page.keyboard.up('Tab');
    await page.waitForTimeout(200);
    view = await hud();
    check('scoreboard closes on release', !view.scoreboardOpen);

    // -- score limit -------------------------------------------------------
    section('score limit and results');
    await page.evaluate(killBot, 'bot-05');
    await waitFor('match:ended');
    await page.waitForTimeout(250);

    const ended = await last('match:ended');
    equal('outcome is a victory', ended.payload.outcome, 'victory');
    equal('reason is the score limit', ended.payload.reason, 'score-limit');
    equal('final player score', ended.payload.playerScore, SCORE_LIMIT);
    equal('final opponent score', ended.payload.opponentScore, 1);

    view = await hud();
    check('results screen opens', view.resultsOpen);
    equal('results headline the outcome', view.outcome, 'VICTORY');
    equal('results show the player score', view.finalMine, String(SCORE_LIMIT));
    equal('results show the opponent score', view.finalTheirs, '1');
    equal('results explain why the round ended', view.reason, 'SCORE LIMIT REACHED');
    equal('results table lists everyone', view.resultRows, ROSTER + 1);
    check('round HUD is hidden behind the results', !view.hudVisible);
    check('the results screen holds an input lockout', view.lockedOut);

    // A finished round must stay finished.
    const scoreEventsAtEnd = await countOf('match:score-changed');
    await page.evaluate(killBot, 'bot-02');
    await page.waitForTimeout(250);
    equal('kills after the final one do not score', await countOf('match:score-changed'), scoreEventsAtEnd);

    // Read before the restart so the check below is not vacuous: it only
    // proves anything if round one actually left the weapon dirty.
    const weaponAtEnd = await page.evaluate(() => {
      const s = window.engine.ctx.getModule('weapon').state;
      return {
        ammo: s.ammo,
        reserve: s.reserve,
        magazineSize: s.definition.magazineSize,
        reserveAmmo: s.definition.reserveAmmo,
      };
    });

    // -- round two ---------------------------------------------------------
    section('round two: reset');
    await clearLog();
    await page.click('.mscreen-panel--results .btn--primary');
    await waitFor('match:started');
    await settle(resultsClosed);
    await settle(roundHudUp);
    await page.waitForTimeout(300);

    equal('restarting resets the world', await countOf('game:restart'), 1);
    equal('every bot respawns on restart', await countOf('ai:spawned'), ROSTER);

    view = await hud();
    check('results screen closes', !view.resultsOpen);
    check('round HUD is back', view.hudVisible);
    equal('player score resets', view.playerScore, '0');
    equal('opponent score resets', view.opponentScore, '0');
    equal('player health resets', view.health, '100');

    check(
      'round one left the weapon dirty, so the reload check below means something',
      weaponAtEnd.ammo < weaponAtEnd.magazineSize || weaponAtEnd.reserve < weaponAtEnd.reserveAmmo,
      JSON.stringify(weaponAtEnd)
    );
    const weaponAfter = await page.evaluate(() => {
      const s = window.engine.ctx.getModule('weapon').state;
      return { ammo: s.ammo, reserve: s.reserve, reloading: s.reloading };
    });
    equal('magazine refills on restart', weaponAfter.ammo, weaponAtEnd.magazineSize);
    equal('reserve refills on restart', weaponAfter.reserve, weaponAtEnd.reserveAmmo);
    check('no reload carries into the new round', !weaponAfter.reloading);

    const firstTick = (await log()).find((e) => e.name === 'match:tick');
    equal('clock resets to the full round', firstTick?.payload.remainingSeconds, TIME_LIMIT);
    check('nothing carried over into the death notice', !view.deathVisible);
    equal('killfeed is cleared', view.killfeedRows.length, 0);

    await page.keyboard.down('Tab');
    await page.waitForTimeout(200);
    view = await hud();
    equal('scoreboard roster is intact', view.scoreboardRows.length, ROSTER + 1);
    check(
      'every scoreboard tally resets',
      view.scoreboardRows.every((row) => row.kills === '0' && row.deaths === '0'),
      JSON.stringify(view.scoreboardRows)
    );
    await page.keyboard.up('Tab');

    // Losing the second round, to exercise the other outcome and prove the
    // opposing score is not still holding round one's value.
    section('round two: defeat');
    for (let i = 0; i < SCORE_LIMIT; i++) {
      await clearLog();
      await page.evaluate(hurtPlayer, { botId: 'bot-04', amount: 100, health: 0 });
      await waitFor('player:died');
      if (i < SCORE_LIMIT - 1) await waitFor('player:respawned');
    }
    await waitFor('match:ended');
    await page.waitForTimeout(250);

    const lost = await last('match:ended');
    equal('outcome is a defeat', lost.payload.outcome, 'defeat');
    equal('player score is zero', lost.payload.playerScore, 0);
    equal('opponent score is the limit', lost.payload.opponentScore, SCORE_LIMIT);
    view = await hud();
    equal('results headline the defeat', view.outcome, 'DEFEAT');
    equal('results show the losing score', view.finalTheirs, String(SCORE_LIMIT));

    // -- back to the lobby -------------------------------------------------
    section('return to lobby');
    await page.click('.mscreen-panel--results .mscreen-actions .btn:not(.btn--primary)');
    await settle(lobbyUp);
    view = await hud();
    check('lobby reopens', view.lobbyOpen);
    check('results screen closes', !view.resultsOpen);
    equal('roster is still reported', view.hostiles, String(ROSTER));

    // -- time limit --------------------------------------------------------
    section('time limit');
    await boot({ matchTime: '5', matchScore: '99' });
    await page.click('.mscreen-panel--pregame .mscreen-cta');
    await waitFor('match:started');
    await waitFor('match:ended', 20_000);
    const expired = await last('match:ended');
    equal('reason is the time limit', expired.payload.reason, 'time-limit');
    equal('a scoreless expiry is a draw', expired.payload.outcome, 'draw');
    view = await hud();
    equal('results explain the expiry', view.reason, 'TIME EXPIRED');

    // -- pause -------------------------------------------------------------
    section('pause stops the clock');
    await boot();
    await page.click('.mscreen-panel--pregame .mscreen-cta');
    await waitFor('match:started');
    await page.waitForTimeout(1500);
    // Releasing the pointer is this game's pause. Emitted directly because
    // headless Chrome does not grant pointer lock, so there is nothing to
    // release; the module's contract is with the event either way.
    await page.evaluate(() => window.engine.events.emit('engine:pointer-lock', { locked: false }));
    await page.waitForTimeout(200);
    const clockWhenPaused = (await hud()).clock;
    await page.waitForTimeout(2000);
    equal('the clock does not move while paused', (await hud()).clock, clockWhenPaused);
    const pausedEvent = await last('game:paused');
    equal('pause is published', pausedEvent?.payload.paused, true);
    await page.evaluate(() => window.engine.events.emit('engine:pointer-lock', { locked: true }));
    await page.waitForTimeout(2000);
    check(
      'the clock resumes',
      (await hud()).clock !== clockWhenPaused,
      `${clockWhenPaused} -> ${(await hud()).clock}`
    );

    // -- deferred death commit ---------------------------------------------
    // The one behaviour in here that is genuinely a single-step property, so it
    // is driven a step at a time rather than asserted against the rAF loop.
    section('death commits one step late, with the right killer');
    await boot();
    await page.click('.mscreen-panel--pregame .mscreen-cta');
    await waitFor('match:started');
    // Frozen with no settling wait, so the only fixed steps this section sees
    // are the ones it drives. Left running even briefly, ten live bots can put
    // the player down first, and every assertion below then reads as a failure
    // of the deferral rather than of the setup.
    await page.evaluate(freezeSimulation);
    await clearLog();

    view = await hud();
    check('the player is alive before the deferral is tested', view.health === '100' && !view.deathVisible, JSON.stringify({ health: view.health, dead: view.deathVisible }));

    // A previous attacker, so a death committed too early has something wrong
    // to attribute itself to.
    await page.evaluate(hurtPlayer, { botId: 'bot-06', amount: 40, health: 60 });
    await page.evaluate(stepOnce);
    equal('a survivable wound raises no death', await countOf('player:died'), 0);

    await page.evaluate(hurtPlayer, { botId: 'bot-09', amount: 60, health: 0 });
    equal(
      'death is not committed inside the damage handler',
      await countOf('player:died'),
      0
    );
    const beforeStep = await page.evaluate(() => ({
      tick: window.engine.time.tick,
      scale: window.engine.time.scale,
      health: document.querySelector('.vitals-value')?.textContent.trim(),
    }));
    await page.evaluate(stepOnce);
    const afterStep = await page.evaluate(() => ({ tick: window.engine.time.tick }));
    check(
      'the manual step advanced the simulation exactly once',
      afterStep.tick === beforeStep.tick + 1,
      JSON.stringify({ beforeStep, afterStep })
    );
    check(
      'death commits on the next fixed step',
      (await countOf('player:died')) === 1,
      JSON.stringify({ beforeStep, log: (await log()).map((e) => e.name) })
    );
    // combat:player-damaged carries the health but not the shooter, and arrives
    // first. Committing in that handler would name bot-06 here.
    equal(
      'the killer is the lethal shooter, not the previous one',
      (await last('player:died'))?.payload.killerId,
      'bot-09'
    );

    // The lockout's default exemptions, checked where they matter: a dead player
    // who cannot read the scoreboard or release the pointer is stuck.
    await page.keyboard.down('Tab');
    await page.waitForTimeout(150);
    view = await hud();
    check('the scoreboard is exempt from the lockout', view.scoreboardOpen);
    await page.keyboard.up('Tab');

    await page.evaluate(thawSimulation);

    // -- a death on the step the round ends ---------------------------------
    section('killing blow on the same step as the score limit');
    await boot();
    await page.click('.mscreen-panel--pregame .mscreen-cta');
    await waitFor('match:started');
    // Frozen for the same reason, and because everything this section asserts
    // resolves synchronously: scoring, the win check and the end of the round
    // all happen inside the emit, so no fixed step is needed to observe them.
    await page.evaluate(freezeSimulation);
    await clearLog();
    await page.evaluate(killBot, 'bot-03');
    await page.evaluate(killBot, 'bot-05');

    await page.evaluate(raceDeathWithFinalKill, { killerId: 'bot-08', botId: 'bot-07' });
    await waitFor('match:ended');

    const raced = await log();
    const deathIndex = raced.findIndex((e) => e.name === 'player:died');
    const endIndex = raced.findIndex((e) => e.name === 'match:ended');
    check('the pending death still lands', deathIndex !== -1);
    check('it lands before the round is declared over', deathIndex < endIndex, `${deathIndex} vs ${endIndex}`);
    const racedEnd = raced[endIndex];
    equal('the round is still won on the final point', racedEnd.payload.playerScore, SCORE_LIMIT);
    equal('a death on the final step does not score', racedEnd.payload.opponentScore, 0);
    equal('the outcome is unaffected', racedEnd.payload.outcome, 'victory');

    // The state that a one-step deferral usually strands: a raised-but-uncommitted
    // death leaking into the next round and firing on its first step.
    section('the next round inherits no pending death');
    await page.evaluate(thawSimulation);
    await clearLog();
    await page.click('.mscreen-panel--results .btn--primary');
    await waitFor('match:started');
    // Stepped by hand rather than waited out: a stranded flag would fire on one
    // of the first steps of the new round, and driving those steps is the only
    // way to tell that apart from a bot getting a lucky first burst in.
    await page.evaluate(freezeSimulation);
    await clearLog();
    for (let i = 0; i < 12; i++) await page.evaluate(stepOnce);

    equal('no death carries into the new round', await countOf('player:died'), 0);
    view = await hud();
    equal('opponent score starts at zero', view.opponentScore, '0');
    equal('the player starts the round alive', view.health, '100');
    check('the death notice is not showing', !view.deathVisible);
    // Asserted on the lockout itself here rather than by driving a key: the
    // round before this one released the pointer, and re-acquiring it is
    // Chromium's business, not the round layer's.
    check('the new round hands input back', !view.lockedOut);
    await page.evaluate(thawSimulation);

    // -- capture mode ------------------------------------------------------
    section('capture mode is untouched');
    await page.goto(`${server.url}/?capture=1&seed=24189&bots=${ROSTER}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });
    const captureState = await page.evaluate(() => ({
      lobby: document.querySelector('.mscreen') !== null,
      hudOn: document.querySelector('.match')?.classList.contains('is-on') ?? false,
      death: document.querySelector('.death') !== null,
      scoreboard: document.querySelector('.scorebd') !== null,
      frozen: window.engine.time.scale === 0,
      lockedOut: window.engine.input.lockedOut,
    }));
    check('no lobby overlay under capture', !captureState.lobby);
    check('no round HUD under capture', !captureState.hudOn);
    check('no death notice under capture', !captureState.death);
    check('no scoreboard under capture', !captureState.scoreboard);
    check('simulation is still frozen under capture', captureState.frozen);
    check('input is not locked out under capture', !captureState.lockedOut);

    // The lockout now lives on shared engine state rather than on a wrapper the
    // match owns, so "the round layer is inert" has to mean the capture bridge
    // can still drive real input. It produces the firing shots that way.
    const captureFired = await page.evaluate(() => {
      // The draw animation has to finish first: the simulation is frozen from
      // boot under capture, so a page that has not been stepped still has the
      // weapon coming up and will refuse to fire. The real harness pays for
      // this in `setShot`/`converge` before it ever calls `perform`.
      window.__hitscan.step(120);
      let fired = 0;
      const off = window.engine.events.on('weapon:fired', () => fired++);
      window.__hitscan.perform(['fire'], 12, 0);
      off();
      return fired;
    });
    check('capture can still drive real input actions', captureFired > 0, `fired ${captureFired}`);

    section('console');
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  } finally {
    if (page && !process.argv.includes('--keep-open')) await page.close().catch(() => {});
    await browser.close();
    server.stop();
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`round drive failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
