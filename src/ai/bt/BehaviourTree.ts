/**
 * A minimal behaviour tree.
 *
 * Chosen over a flat state machine because the bot's priorities are naturally
 * a fallback chain — die, reload, retreat, fight, investigate, patrol — and
 * expressing that as transitions means writing the same "unless something
 * more urgent happened" check in a dozen places. Composites keep the memory
 * of which child was running, so a bot part-way through walking to cover is
 * not restarted every tick by a higher-priority branch that keeps failing.
 */

export type Status = 'success' | 'failure' | 'running';

export abstract class Node<B> {
  /** Set for the leaf currently running; used for debug readouts and tests. */
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  abstract tick(blackboard: B, dt: number): Status;

  /** Called when a previously running branch is abandoned. */
  abort(_blackboard: B): void {}
}

/** Runs children in order until one succeeds. */
export class Selector<B> extends Node<B> {
  #children: Node<B>[];
  #running = -1;

  constructor(label: string, children: Node<B>[]) {
    super(label);
    this.#children = children;
  }

  override tick(blackboard: B, dt: number): Status {
    for (let i = 0; i < this.#children.length; i++) {
      const child = this.#children[i] as Node<B>;
      const status = child.tick(blackboard, dt);
      if (status === 'running') {
        // Priority pre-emption: a lower-index child taking over must tell the
        // interrupted branch to clean up.
        if (this.#running >= 0 && this.#running !== i) {
          (this.#children[this.#running] as Node<B>).abort(blackboard);
        }
        this.#running = i;
        return 'running';
      }
      if (status === 'success') {
        if (this.#running >= 0 && this.#running !== i) {
          (this.#children[this.#running] as Node<B>).abort(blackboard);
        }
        this.#running = -1;
        return 'success';
      }
    }
    if (this.#running >= 0) {
      (this.#children[this.#running] as Node<B>).abort(blackboard);
      this.#running = -1;
    }
    return 'failure';
  }

  override abort(blackboard: B): void {
    if (this.#running >= 0) {
      (this.#children[this.#running] as Node<B>).abort(blackboard);
      this.#running = -1;
    }
  }
}

/**
 * Runs children in order until one fails, re-evaluating every child from the
 * start on every tick.
 *
 * Reactive rather than memorised on purpose: the common shape here is
 * "[keep this precondition true] then [do the thing]", and a memorised
 * sequence stops re-checking the precondition the moment the action starts
 * returning running — which is precisely when it matters.
 */
export class Sequence<B> extends Node<B> {
  #children: Node<B>[];
  #running = -1;

  constructor(label: string, children: Node<B>[]) {
    super(label);
    this.#children = children;
  }

  override tick(blackboard: B, dt: number): Status {
    for (let i = 0; i < this.#children.length; i++) {
      const child = this.#children[i] as Node<B>;
      const status = child.tick(blackboard, dt);
      if (status === 'running') {
        if (this.#running >= 0 && this.#running !== i) {
          (this.#children[this.#running] as Node<B>).abort(blackboard);
        }
        this.#running = i;
        return 'running';
      }
      if (status === 'failure') {
        this.#abortRunning(blackboard);
        return 'failure';
      }
    }
    this.#abortRunning(blackboard);
    return 'success';
  }

  #abortRunning(blackboard: B): void {
    if (this.#running >= 0) {
      (this.#children[this.#running] as Node<B>).abort(blackboard);
      this.#running = -1;
    }
  }

  override abort(blackboard: B): void {
    this.#abortRunning(blackboard);
  }
}

export class Condition<B> extends Node<B> {
  #test: (blackboard: B) => boolean;

  constructor(label: string, test: (blackboard: B) => boolean) {
    super(label);
    this.#test = test;
  }

  override tick(blackboard: B): Status {
    return this.#test(blackboard) ? 'success' : 'failure';
  }
}

export class Action<B> extends Node<B> {
  #run: (blackboard: B, dt: number) => Status;
  #onAbort?: (blackboard: B) => void;

  constructor(
    label: string,
    run: (blackboard: B, dt: number) => Status,
    onAbort?: (blackboard: B) => void
  ) {
    super(label);
    this.#run = run;
    this.#onAbort = onAbort;
  }

  override tick(blackboard: B, dt: number): Status {
    return this.#run(blackboard, dt);
  }

  override abort(blackboard: B): void {
    this.#onAbort?.(blackboard);
  }
}

/** Passes through to the child only while the guard holds. */
export class Guard<B> extends Node<B> {
  #test: (blackboard: B) => boolean;
  #child: Node<B>;

  constructor(label: string, test: (blackboard: B) => boolean, child: Node<B>) {
    super(label);
    this.#test = test;
    this.#child = child;
  }

  override tick(blackboard: B, dt: number): Status {
    if (!this.#test(blackboard)) return 'failure';
    return this.#child.tick(blackboard, dt);
  }

  override abort(blackboard: B): void {
    this.#child.abort(blackboard);
  }
}

/** Rate-limits a subtree so bots cannot re-decide every single tick. */
export class Cooldown<B> extends Node<B> {
  #child: Node<B>;
  #duration: number;
  #remaining = 0;

  constructor(label: string, duration: number, child: Node<B>) {
    super(label);
    this.#child = child;
    this.#duration = duration;
  }

  override tick(blackboard: B, dt: number): Status {
    if (this.#remaining > 0) {
      this.#remaining -= dt;
      return 'failure';
    }
    const status = this.#child.tick(blackboard, dt);
    if (status !== 'running') this.#remaining = this.#duration;
    return status;
  }

  override abort(blackboard: B): void {
    this.#child.abort(blackboard);
  }
}
