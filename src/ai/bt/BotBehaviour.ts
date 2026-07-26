import * as THREE from 'three';
import { Action, Guard, Node, Selector, Sequence } from './BehaviourTree.ts';
import type { Bot } from '../bot/Bot.ts';
import { AGENT, BOT_HEALTH, COMBAT, COVER, PERCEPTION } from '../Tuning.ts';
import { CellFlag } from '../nav/NavGrid.ts';

/**
 * The bot's decision tree.
 *
 * Ordering is the design. Everything is a fallback chain from most urgent to
 * least, so a bot that is reloading cannot be talked into peeking, and a bot
 * whose cover has been flanked deals with that before it thinks about
 * shooting. Leaves never move the character themselves; they write intents
 * that the locomotion layer resolves, which keeps steering, avoidance and
 * separation in exactly one place.
 *
 * Every node here is constructed per call. Composites remember which child is
 * running, so one tree shared across the roster would have each bot stomping
 * the others' state and firing their abort handlers. A tree is a few dozen
 * small objects; one per bot is the right trade.
 */

const _goal = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _right = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function clearMovement(bot: Bot): void {
  bot.moveGoal = null;
  bot.clearPath();
}

/** Walks to a goal; succeeds on arrival, fails when the goal is unreachable. */
function moveTo(
  label: string,
  goalOf: (bot: Bot) => THREE.Vector3 | null,
  speed: (bot: Bot) => number,
  tolerance: number
): Node<Bot> {
  return new Action<Bot>(
    label,
    (bot) => {
      const goal = goalOf(bot);
      if (!goal || bot.isGoalBlocked(goal)) return 'failure';
      bot.moveGoal = goal;
      bot.moveSpeed = speed(bot);
      bot.moveTolerance = tolerance;
      if (bot.distanceToGoal() <= tolerance) {
        clearMovement(bot);
        return 'success';
      }
      if (!bot.pathPending && bot.pathStatus === 'failed') {
        bot.markGoalBlocked(goal);
        return 'failure';
      }
      return 'running';
    },
    clearMovement
  );
}

// -- reload -----------------------------------------------------------------

const reload = (): Node<Bot> => new Guard<Bot>(
  'reload-guard',
  (bot) => bot.marksman.reloading || bot.marksman.needsReload,
  new Action<Bot>('reload', (bot) => {
    bot.state = 'reload';
    bot.marksman.startReload();
    bot.fireIntent = 'hold';
    // Reloading is the one moment a bot should be small and behind something.
    if (bot.cover) {
      bot.moveGoal = bot.cover.point.position;
      bot.moveTolerance = 0.5;
      bot.moveSpeed = AGENT.combatSpeed;
      bot.crouchWanted = bot.distanceToGoal() < 1.2 && !bot.cover.point.standing;
      bot.faceTarget = bot.perception.lastSeenPosition;
    } else {
      clearMovement(bot);
      bot.crouchWanted = true;
      bot.faceTarget = bot.perception.lastSeenPosition;
    }
    return bot.marksman.reloading ? 'running' : 'success';
  })
);

// -- retreat ----------------------------------------------------------------

const retreat = (): Node<Bot> => new Guard<Bot>(
  'retreat-guard',
  (bot) => bot.health < bot.maxHealth * BOT_HEALTH.retreatFraction && bot.perception.contactRecent,
  new Action<Bot>(
    'retreat',
    (bot, dt) => {
      bot.state = 'retreat';
      bot.coverAge += dt;
      if (!bot.cover || bot.coverAge > COVER.reevaluateInterval * 2) bot.evaluateCover(true);
      const cover = bot.cover;
      if (!cover) {
        // Nowhere to break to: make the last stand expensive.
        bot.faceTarget = bot.perception.lastSeenPosition;
        bot.crouchWanted = true;
        bot.fireIntent = bot.perception.visible ? 'aimed' : 'hold';
        return 'running';
      }
      bot.moveGoal = cover.point.position;
      bot.moveSpeed = AGENT.sprintSpeed;
      bot.moveTolerance = 0.7;
      const arrived = bot.distanceToGoal() < 1.2;
      bot.atCover = arrived;
      bot.crouchWanted = arrived;
      bot.faceTarget = arrived ? bot.perception.lastSeenPosition : null;
      bot.fireIntent = arrived && bot.perception.visible ? 'aimed' : 'hold';
      return 'running';
    },
    clearMovement
  )
);

// -- combat -----------------------------------------------------------------

/**
 * Keeps a valid cover position assigned and the bot standing in it.
 *
 * Runs ahead of the shooting behaviour every tick, which is what makes
 * "reposition when flanked" fall out for free: the moment the obstacle stops
 * being between the bot and the threat, the choice is invalidated and the
 * same node walks the bot somewhere new.
 */
const secureCover = (): Node<Bot> => new Action<Bot>(
  'secure-cover',
  (bot, dt) => {
    bot.coverAge += dt;
    const flanked = bot.cover !== null && !bot.coverStillValid();
    if ((!bot.cover || flanked) && bot.coverAge > COVER.reevaluateInterval) {
      const previous = bot.cover;
      bot.evaluateCover(false);
      if (bot.cover !== previous) bot.atCover = false;
    }
    if (!bot.cover) return 'failure';

    const distance = bot.body.position.distanceTo(bot.cover.point.position);
    // Hysteresis: the peek offset is nearly a metre, so a bot leaning out of
    // its own cover must not read as having abandoned it.
    const threshold = bot.atCover ? COVER.peekOffset + 1.05 : 0.8;
    if (distance <= threshold) {
      bot.atCover = true;
      return 'success';
    }

    bot.state = flanked ? 'reposition' : 'to-cover';
    bot.atCover = false;
    bot.moveGoal = bot.cover.point.position;
    bot.moveSpeed = distance > 6 ? AGENT.sprintSpeed : AGENT.combatSpeed;
    bot.moveTolerance = 0.7;
    bot.crouchWanted = false;
    bot.faceTarget = null;
    // Shoot while relocating only at knife range; anything else is a spray.
    bot.fireIntent = bot.perception.visible && bot.perception.distance < 6 ? 'aimed' : 'hold';
    return 'running';
  },
  clearMovement
);

/**
 * Peek and shoot. The bot alternates between a hidden pose at the cover point
 * and an exposed pose at the peek offset, with randomised window lengths so
 * the player cannot metronome it.
 */
const peekAndShoot = (): Node<Bot> => new Action<Bot>(
  'peek',
  (bot, dt) => {
    const cover = bot.cover;
    if (!cover) return 'failure';

    // Only leave cover when it is this bot's turn to shoot; the rest of the
    // squad stays small and lets the attackers work.
    const cleared = bot.squad.claimAttack(bot.actorId);

    bot.peekTimer -= dt;
    if (bot.peekTimer <= 0) {
      bot.peeking = !bot.peeking && cover.peek !== null && cleared;
      bot.peekTimer = bot.peeking ? bot.rng.range(1.1, 2.3) : bot.rng.range(0.7, 1.7);
    }
    if (!cleared) bot.peeking = false;
    // Never duck back mid-burst; a burst cut in half reads as a hitch.
    if (!bot.peeking && bot.marksman.midBurst) bot.peekTimer = Math.max(bot.peekTimer, 0.12);

    const exposed = bot.peeking && cover.peek !== null;
    bot.state = exposed ? 'peek' : 'in-cover';
    bot.moveGoal = exposed && cover.peek ? cover.peek : cover.point.position;
    bot.moveSpeed = AGENT.walkSpeed;
    bot.moveTolerance = 0.25;
    bot.faceTarget = bot.perception.visible
      ? bot.target.position
      : bot.perception.lastSeenPosition;
    bot.crouchWanted = !exposed && !cover.point.standing;
    bot.fireIntent = bot.perception.visible && cleared ? 'aimed' : 'hold';
    return 'running';
  },
  (bot) => {
    bot.squad.releaseAttack(bot.actorId);
    clearMovement(bot);
  }
);

/** Fire on a remembered position to keep the player's head down. */
const suppress = (): Node<Bot> => new Guard<Bot>(
  'suppress-guard',
  (bot) =>
    !bot.perception.visible &&
    bot.perception.timeSinceSeen < 4.5 &&
    bot.squad.suppressorCount < 3 &&
    bot.perception.lastSeenPosition.distanceTo(bot.body.position) < COMBAT.maxEngageRange,
  new Action<Bot>(
    'suppress',
    (bot) => {
      bot.state = 'suppress';
      bot.squad.claimSuppression(bot.actorId);
      if (bot.cover) {
        bot.moveGoal = bot.cover.peek ?? bot.cover.point.position;
        bot.moveTolerance = 0.3;
        bot.moveSpeed = AGENT.walkSpeed;
      }
      bot.faceTarget = bot.perception.lastSeenPosition;
      bot.crouchWanted = false;
      bot.fireIntent = 'suppress';
      if (bot.perception.timeSinceSeen >= 4.5) {
        bot.squad.releaseSuppression(bot.actorId);
        return 'success';
      }
      return 'running';
    },
    (bot) => {
      bot.squad.releaseSuppression(bot.actorId);
      clearMovement(bot);
    }
  )
);

/**
 * Flank a static player.
 *
 * Gated on how long the target has held a position, because breaking cover
 * against someone who is actively moving is how bots die pointlessly.
 * Squad-limited so a group never abandons all its firing positions at once,
 * and cooldown-gated so the dice are rolled every few seconds rather than
 * twenty times a second.
 */
const flank = (): Node<Bot> => new Guard<Bot>(
  'flank-guard',
  (bot) => {
    if (bot.flanking) return true;
    if (bot.flankCooldown > 0) return false;
    if (bot.playerStillFor < 2.5 || bot.perception.timeSinceSeen > 5) return false;
    bot.flankCooldown = 3.5;
    if (!bot.rng.chance(bot.profile.flankAppetite)) return false;
    return bot.squad.claimFlank(bot.actorId);
  },
  new Action<Bot>(
    'flank',
    (bot) => {
      if (!bot.flanking) {
        const goal = pickFlankPosition(bot);
        if (!goal) {
          bot.squad.releaseFlank(bot.actorId);
          return 'failure';
        }
        bot.flankGoal = goal;
        bot.flanking = true;
      }
      const goal = bot.flankGoal;
      if (!goal) {
        bot.flanking = false;
        return 'failure';
      }

      bot.state = 'flank';
      bot.moveGoal = goal;
      bot.moveSpeed = AGENT.sprintSpeed;
      bot.moveTolerance = 1;
      bot.crouchWanted = false;
      bot.faceTarget = null;
      bot.fireIntent =
        bot.perception.visible && bot.perception.distance < 12 ? 'aimed' : 'hold';

      // Abandon the move the moment the reason for it goes away.
      const done =
        bot.distanceToGoal() <= 1 ||
        bot.playerStillFor < 0.4 ||
        (!bot.pathPending && bot.pathStatus === 'failed');
      if (done) {
        bot.flanking = false;
        bot.flankGoal = null;
        bot.squad.releaseFlank(bot.actorId);
        bot.cover = null;
        bot.coverAge = Infinity;
        clearMovement(bot);
        return 'success';
      }
      return 'running';
    },
    (bot) => {
      bot.flanking = false;
      bot.flankGoal = null;
      bot.squad.releaseFlank(bot.actorId);
      clearMovement(bot);
    }
  )
);

/**
 * A standable cell roughly ninety degrees around the target from the bot's
 * current bearing. Arriving from a new angle is the whole point, so the
 * lateral component matters far more than the exact distance.
 */
function pickFlankPosition(bot: Bot): THREE.Vector3 | null {
  const grid = bot.grid;
  const threat = bot.perception.lastSeenPosition;
  _offset.subVectors(bot.body.position, threat).setY(0);
  const distance = _offset.length();
  if (distance < 1) return null;
  _offset.multiplyScalar(1 / distance);
  _right.crossVectors(UP, _offset).normalize();

  const side = bot.rng.chance(0.5) ? 1 : -1;
  const radius = THREE.MathUtils.clamp(distance, 8, 22);
  for (const angle of [1.25, 0.95, 1.55, 0.7]) {
    _goal
      .copy(threat)
      .addScaledVector(_offset, Math.cos(angle) * radius)
      .addScaledVector(_right, side * Math.sin(angle) * radius);
    const cell = grid.nearestAgentCell(_goal.x, _goal.z, 5);
    if (cell < 0) continue;
    if ((grid.flags[cell] & CellFlag.Agent) === 0) continue;
    const point = grid.toWorld(cell, new THREE.Vector3());
    if (point.distanceTo(bot.body.position) < 4) continue;
    return point;
  }
  return null;
}

/** No usable cover: close to the preferred range and fight in the open. */
const advance = (): Node<Bot> => new Action<Bot>(
  'advance',
  (bot) => {
    bot.state = 'advance';
    const threat = bot.perception.visible ? bot.target.position : bot.perception.lastSeenPosition;
    const distance = bot.body.position.distanceTo(threat);
    if (distance > COMBAT.preferredRange) {
      _offset.subVectors(threat, bot.body.position).setY(0).normalize();
      _goal
        .copy(bot.body.position)
        .addScaledVector(_offset, Math.min(distance - COMBAT.preferredRange * 0.6, 12));
      const cell = bot.grid.nearestAgentCell(_goal.x, _goal.z, 4);
      if (cell >= 0) {
        bot.moveGoal = bot.grid.toWorld(cell, _goal);
        bot.moveSpeed = bot.perception.visible ? AGENT.combatSpeed : AGENT.sprintSpeed;
        bot.moveTolerance = 1.2;
      }
    } else {
      clearMovement(bot);
    }
    bot.faceTarget = threat;
    bot.crouchWanted = false;
    const cleared = bot.perception.visible && bot.squad.claimAttack(bot.actorId);
    bot.fireIntent = cleared ? 'aimed' : bot.perception.visible ? 'hold' : 'suppress';
    return 'running';
  },
  (bot) => {
    bot.squad.releaseAttack(bot.actorId);
    clearMovement(bot);
  }
);

const combat = (): Node<Bot> =>
  new Guard<Bot>(
    'combat-guard',
    (bot) => bot.perception.state === 'alert' && bot.perception.contactRecent,
    new Selector<Bot>('combat', [
      flank(),
      new Sequence<Bot>('fight-from-cover', [secureCover(), peekAndShoot()]),
      suppress(),
      advance(),
    ])
  );

// -- investigate ------------------------------------------------------------

const investigate = (): Node<Bot> => new Guard<Bot>(
  'investigate-guard',
  (bot) =>
    bot.perception.hasInterest &&
    bot.squad.time - bot.perception.interestTime < PERCEPTION.memoryDuration,
  new Sequence<Bot>('investigate', [
    moveTo(
      'approach-noise',
      (bot) => {
        bot.state = 'investigate';
        bot.crouchWanted = false;
        bot.fireIntent = 'hold';
        bot.faceTarget = null;
        // A noise is heard at its source, not at somewhere a soldier can
        // stand: gunfire from a rooftop or through a wall has to resolve to
        // the nearest place the bot could actually walk to.
        const goal = bot.reachable(bot.perception.interestPoint, 9, _goal);
        if (!goal) bot.perception.hasInterest = false;
        return goal;
      },
      () => AGENT.combatSpeed,
      1.8
    ),
    new Action<Bot>(
      'sweep',
      (bot, dt) => {
        bot.state = 'sweep';
        bot.fireIntent = 'hold';
        bot.peekTimer -= dt;
        if (bot.peekTimer <= 0) {
          bot.peekTimer = bot.rng.range(0.8, 1.6);
          // Sweep the area rather than staring at the exact noise position.
          _offset.set(bot.rng.range(-1, 1), 0, bot.rng.range(-1, 1)).normalize();
          _lookAt.copy(bot.perception.interestPoint).addScaledVector(_offset, 6);
          bot.faceTarget = _lookAt;
        }
        bot.sweepTimer += dt;
        if (bot.sweepTimer > 4.5) {
          bot.sweepTimer = 0;
          bot.perception.hasInterest = false;
          return 'success';
        }
        return 'running';
      },
      (bot) => {
        bot.sweepTimer = 0;
      }
    ),
  ])
);

// -- patrol -----------------------------------------------------------------

const patrol = (): Node<Bot> => new Action<Bot>(
  'patrol',
  (bot, dt) => {
    bot.state = 'patrol';
    bot.fireIntent = 'hold';
    bot.crouchWanted = false;
    bot.faceTarget = null;
    bot.moveSpeed = AGENT.walkSpeed;
    bot.moveTolerance = 1.2;

    bot.patrolWait -= dt;
    const needsGoal =
      !bot.moveGoal ||
      bot.distanceToGoal() <= bot.moveTolerance ||
      (!bot.pathPending && bot.pathStatus === 'failed');

    if (needsGoal) {
      if (bot.patrolWait > 0) {
        bot.state = 'idle';
        clearMovement(bot);
        return 'running';
      }
      const goal = pickPatrolPoint(bot);
      if (goal) {
        bot.moveGoal = goal;
        bot.patrolWait = bot.rng.range(1.5, 4.5);
      }
    }
    return 'running';
  },
  clearMovement
);

function pickPatrolPoint(bot: Bot): THREE.Vector3 | null {
  const grid = bot.grid;
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = bot.rng.range(0, Math.PI * 2);
    const radius = bot.rng.range(9, 26);
    _goal.set(
      bot.body.position.x + Math.cos(angle) * radius,
      bot.body.position.y,
      bot.body.position.z + Math.sin(angle) * radius
    );
    const cell = grid.nearestAgentCell(_goal.x, _goal.z, 3);
    if (cell < 0) continue;
    const point = grid.toWorld(cell, new THREE.Vector3());
    if (point.distanceTo(bot.body.position) < 5) continue;
    return point;
  }
  return null;
}

// -- root -------------------------------------------------------------------

/** Builds a fresh tree. One per bot; see the note at the top of the file. */
export function buildBotTree(): Node<Bot> {
  return new Selector<Bot>('root', [
    new Guard<Bot>('dead-guard', (bot) => !bot.alive, new Action<Bot>('dead', () => 'running')),
    reload(),
    retreat(),
    combat(),
    investigate(),
    patrol(),
  ]);
}
