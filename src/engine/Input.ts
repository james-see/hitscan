import type { InputAction, InputState } from '@/types/input.ts';
import type { EventBus } from '@/types/events.ts';

const DEFAULT_BINDINGS: Record<InputAction, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  crouch: 'ControlLeft',
  sprint: 'ShiftLeft',
  fire: 'Mouse0',
  // MouseEvent.button numbers the middle button 1 and the right button 2, so
  // the conventional right-click to aim is Mouse2. Mouse1 bound it to the
  // scroll wheel click, where nobody would ever find it.
  aim: 'Mouse2',
  reload: 'KeyR',
  melee: 'KeyV',
  interact: 'KeyF',
  inspect: 'KeyI',
  pause: 'Escape',
  scoreboard: 'Tab',
};

/**
 * Actions that survive a lockout. Escape has to work or the player is stuck,
 * and the scoreboard is the one thing worth reading while dead.
 */
const LOCKOUT_EXEMPT: readonly InputAction[] = ['pause', 'scoreboard'];

/**
 * Pointer-lock mouse-and-keyboard input, abstracted into named actions.
 *
 * Look deltas accumulate across the frame rather than being sampled, so input
 * resolution is preserved even when the mouse reports faster than the display
 * refreshes.
 */
export class Input implements InputState {
  #down = new Set<string>();
  #pressed = new Set<string>();
  #released = new Set<string>();
  #bindings = new Map<InputAction, string>();
  #reverse = new Map<string, InputAction[]>();

  #lookX = 0;
  #lookY = 0;
  #locked = false;
  #lockedOut = false;
  #exempt: Set<InputAction> = new Set(LOCKOUT_EXEMPT);

  readonly look = { x: 0, y: 0 };
  readonly move = { x: 0, y: 0 };

  sensitivity = 0.0022;
  adsSensitivityScale = 0.7;
  invertY = false;

  /** Scales look deltas; the weapon module lowers this while aiming. */
  sensitivityMultiplier = 1;

  #element: HTMLElement;
  #events: EventBus | null;
  #disposers: Array<() => void> = [];

  constructor(element: HTMLElement, events: EventBus | null = null) {
    this.#element = element;
    this.#events = events;
    for (const [action, code] of Object.entries(DEFAULT_BINDINGS)) {
      this.rebind(action as InputAction, code);
    }
    this.#attach();
  }

  get pointerLocked(): boolean {
    return this.#locked;
  }

  #attach(): void {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Tab and Escape would otherwise leave the canvas.
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.#press(e.code);
    };
    const onKeyUp = (e: KeyboardEvent): void => this.#release(e.code);
    const onMouseDown = (e: MouseEvent): void => this.#press(`Mouse${e.button}`);
    const onMouseUp = (e: MouseEvent): void => this.#release(`Mouse${e.button}`);
    const onMouseMove = (e: MouseEvent): void => {
      if (!this.#locked) return;
      this.#lookX -= e.movementX;
      this.#lookY += this.invertY ? e.movementY : -e.movementY;
    };
    const onContextMenu = (e: Event): void => e.preventDefault();
    const onPointerLockChange = (): void => {
      this.#locked = document.pointerLockElement === this.#element;
      if (!this.#locked) {
        // Drop held keys so the player does not keep moving once unlocked.
        this.#down.clear();
      }
      this.#events?.emit('engine:pointer-lock', { locked: this.#locked });
    };
    const onBlur = (): void => {
      this.#down.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    this.#element.addEventListener('contextmenu', onContextMenu);

    this.#disposers.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      this.#element.removeEventListener('contextmenu', onContextMenu);
    });
  }

  #press(code: string): void {
    if (!this.#down.has(code)) this.#pressed.add(code);
    this.#down.add(code);
  }

  #release(code: string): void {
    if (this.#down.has(code)) this.#released.add(code);
    this.#down.delete(code);
  }

  /** Called once per frame by the engine, before any module updates. */
  beginFrame(): void {
    const scale = this.#lockedOut ? 0 : this.sensitivity * this.sensitivityMultiplier;
    this.look.x = this.#lookX * scale;
    this.look.y = this.#lookY * scale;
    // Cleared either way, so a lockout does not bank mouse movement and fling
    // the camera when it lifts.
    this.#lookX = 0;
    this.#lookY = 0;

    let mx = 0;
    let my = 0;
    if (this.isDown('right')) mx += 1;
    if (this.isDown('left')) mx -= 1;
    if (this.isDown('forward')) my += 1;
    if (this.isDown('back')) my -= 1;
    // Normalise so diagonals are not faster than cardinals.
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    this.move.x = mx;
    this.move.y = my;
  }

  /** Called once per frame by the engine, after all module updates. */
  endFrame(): void {
    this.#pressed.clear();
    this.#released.clear();
  }

  /**
   * Suppresses actions at the source, for states where the player is present
   * but should not be acting — dead, in the lobby, watching the results.
   *
   * It has to live here rather than in the module that wants it, because
   * consumers read this object directly: gating the player module still
   * leaves the weapon reading the trigger, the reload and the sights, so a
   * dead player empties a magazine into the floor. Suppressing at the reader
   * covers everything, including anything added later.
   *
   * Look deltas and `move` are suppressed with the rest. `pause` and
   * `scoreboard` are always exempt, since a lockout the player cannot escape
   * is a hang.
   */
  setLockout(locked: boolean, exempt: readonly InputAction[] = LOCKOUT_EXEMPT): void {
    this.#lockedOut = locked;
    this.#exempt = new Set(exempt);
  }

  get lockedOut(): boolean {
    return this.#lockedOut;
  }

  #suppressed(action: InputAction): boolean {
    return this.#lockedOut && !this.#exempt.has(action);
  }

  isDown(action: InputAction): boolean {
    if (this.#suppressed(action)) return false;
    const code = this.#bindings.get(action);
    return code !== undefined && this.#down.has(code);
  }

  wasPressed(action: InputAction): boolean {
    if (this.#suppressed(action)) return false;
    const code = this.#bindings.get(action);
    return code !== undefined && this.#pressed.has(code);
  }

  wasReleased(action: InputAction): boolean {
    // Not suppressed. A release that happened while locked out still has to
    // reach whoever is holding the corresponding press, or a trigger held
    // through the moment of death stays latched down after the respawn.
    const code = this.#bindings.get(action);
    return code !== undefined && this.#released.has(code);
  }

  requestPointerLock(): void {
    void this.#element.requestPointerLock();
  }

  exitPointerLock(): void {
    document.exitPointerLock();
  }

  rebind(action: InputAction, code: string): void {
    const previous = this.#bindings.get(action);
    if (previous) {
      const list = this.#reverse.get(previous);
      if (list) this.#reverse.set(previous, list.filter((a) => a !== action));
    }
    this.#bindings.set(action, code);
    const list = this.#reverse.get(code) ?? [];
    list.push(action);
    this.#reverse.set(code, list);
  }

  getBinding(action: InputAction): string | undefined {
    return this.#bindings.get(action);
  }

  /** Synthesises a press. Used by the deterministic capture harness. */
  injectPress(action: InputAction): void {
    const code = this.#bindings.get(action);
    if (code) this.#press(code);
  }

  injectRelease(action: InputAction): void {
    const code = this.#bindings.get(action);
    if (code) this.#release(code);
  }

  injectLook(dx: number, dy: number): void {
    this.#lookX += dx;
    this.#lookY += dy;
  }

  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers = [];
  }
}
