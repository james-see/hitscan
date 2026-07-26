/**
 * Input contracts.
 *
 * Input is abstracted into named actions so that key rebinding and gamepad
 * support do not leak into gameplay code.
 */

/** Every discrete action the game responds to. */
export type InputAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'melee'
  | 'interact'
  | 'inspect'
  | 'pause'
  | 'scoreboard';

export interface InputState {
  /** True while the action is held. */
  isDown(action: InputAction): boolean;
  /** True only on the frame the action was pressed. */
  wasPressed(action: InputAction): boolean;
  /** True only on the frame the action was released. */
  wasReleased(action: InputAction): boolean;

  /**
   * Accumulated look delta for this frame, in radians, sensitivity applied.
   * x is yaw (positive = left), y is pitch (positive = up).
   */
  readonly look: { x: number; y: number };

  /** Normalised movement input in local space, magnitude clamped to 1. */
  readonly move: { x: number; y: number };

  readonly pointerLocked: boolean;

  /** Requests pointer lock. Must be called from a user gesture. */
  requestPointerLock(): void;
  exitPointerLock(): void;

  /** Radians of view rotation per unit of raw mouse movement. */
  sensitivity: number;
  /** Multiplier applied to `sensitivity` while aiming down sights. */
  adsSensitivityScale: number;
  invertY: boolean;

  rebind(action: InputAction, code: string): void;
  getBinding(action: InputAction): string | undefined;

  /**
   * Suppresses actions at the source, for states where the player is present
   * but must not act — dead, in the lobby, reading the results.
   *
   * Belongs to input rather than to the state that wants it, because
   * consumers hold this object directly. Gating a single module leaves the
   * weapon still reading the trigger and the sights, so a dead player empties
   * a magazine into the floor; suppressing at the reader covers every
   * consumer, including ones added later.
   *
   * `move` and look are suppressed too. Releases are not, so a trigger held
   * through the moment of death does not stay latched after the respawn.
   */
  setLockout(locked: boolean, exempt?: readonly InputAction[]): void;
  readonly lockedOut: boolean;
}
