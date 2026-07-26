/**
 * Typed event bus contract.
 *
 * This is the primary integration surface between subsystems. Adding a new
 * cross-module signal means adding an entry to `GameEvents` — the compiler
 * then enforces the payload shape at both ends.
 */

import type * as THREE from 'three';
import type { DamageInfo, HitResult, SurfaceKind } from './gameplay.ts';

/**
 * The complete set of cross-module signals, keyed by event name.
 *
 * Naming convention: `noun:verb-past-tense` for things that happened,
 * `noun:verb` for requests.
 */
export interface GameEvents {
  // -- lifecycle ------------------------------------------------------------
  'game:ready': void;
  'game:paused': { paused: boolean };
  'game:restart': void;
  /** Emitted once the scene is fully loaded and temporally converged. */
  'game:converged': void;

  // -- weapon ---------------------------------------------------------------
  'weapon:fired': {
    weaponId: string;
    /** Muzzle position in world space. */
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    /** Rounds remaining in the magazine after this shot. */
    ammo: number;
    /** Index of this shot within the current trigger pull, from 0. */
    shotIndex: number;
  };
  'weapon:dry-fired': { weaponId: string };
  'weapon:reload-started': { weaponId: string; tactical: boolean };
  'weapon:reload-finished': { weaponId: string; ammo: number };
  'weapon:ads-changed': { weaponId: string; ads: boolean };
  'weapon:equipped': { weaponId: string };
  /** Fired once per bullet that resolved against the world or an actor. */
  'weapon:impact': HitResult;
  'weapon:shell-ejected': { position: THREE.Vector3; velocity: THREE.Vector3 };

  // -- combat ---------------------------------------------------------------
  'combat:damage-dealt': DamageInfo;
  'combat:actor-died': { actorId: string; killerId: string | null; headshot: boolean };
  'combat:player-damaged': { amount: number; from: THREE.Vector3; health: number };
  'combat:player-healed': { amount: number; health: number };

  // -- player ---------------------------------------------------------------
  'player:landed': { velocity: number; surface: SurfaceKind };
  'player:jumped': void;
  'player:slide-started': void;
  'player:slide-ended': void;
  'player:vault-started': { height: number };
  'player:sprint-changed': { sprinting: boolean };
  'player:footstep': { position: THREE.Vector3; surface: SurfaceKind; running: boolean };

  // -- ai -------------------------------------------------------------------
  'ai:spawned': { actorId: string; position: THREE.Vector3 };
  'ai:alerted': { actorId: string; target: THREE.Vector3 };
  'ai:fired': { actorId: string; origin: THREE.Vector3; direction: THREE.Vector3 };

  // -- ui -------------------------------------------------------------------
  'ui:hitmarker': { headshot: boolean; lethal: boolean };
  'ui:notify': { text: string; durationMs?: number };
  'ui:killfeed': { killer: string; victim: string; headshot: boolean };

  // -- engine ---------------------------------------------------------------
  'engine:resized': { width: number; height: number; dpr: number };
  'engine:quality-changed': { preset: string };
  /** Emitted when the pointer lock state changes. */
  'engine:pointer-lock': { locked: boolean };
}

export type EventName = keyof GameEvents;
export type EventPayload<K extends EventName> = GameEvents[K];
export type EventHandler<K extends EventName> = (payload: EventPayload<K>) => void;

/** Unsubscribe function returned by `on`/`once`. Idempotent. */
export type Unsubscribe = () => void;

export interface EventBus {
  on<K extends EventName>(event: K, handler: EventHandler<K>): Unsubscribe;
  once<K extends EventName>(event: K, handler: EventHandler<K>): Unsubscribe;
  off<K extends EventName>(event: K, handler: EventHandler<K>): void;
  emit<K extends EventName>(
    ...args: EventPayload<K> extends void ? [event: K] : [event: K, payload: EventPayload<K>]
  ): void;
  /** Removes every handler. Used on teardown. */
  clear(): void;
}
