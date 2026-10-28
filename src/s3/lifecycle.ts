/**
 * The life of one S3 instance (design Option 7A): `idle`, `connecting`, `connected`, `ending`.
 * S3 has no session, so the "session" is a generation: each connect() starts one, and
 * disconnect() ends it by firing its signal, which cuts every request in flight, and by awaiting
 * the cleanup tasks (the abort of a multipart upload) before it resolves.
 */

export type LifecycleState = 'idle' | 'connecting' | 'connected' | 'ending';

/** What an operation holds while it runs in one generation. */
export interface OperationScope {
  /** Fires when the generation ends. */
  readonly signal: AbortSignal;
  /** Registers work that disconnect() must await; it is forgotten once it settles. */
  cleanup(task: Promise<unknown>): void;
}

export class Lifecycle {
  #state: LifecycleState = 'idle';
  #controller = new AbortController();
  readonly #cleanups = new Set<Promise<unknown>>();

  get state(): LifecycleState {
    return this.#state;
  }

  /** The signal of the current generation. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Starts a new generation. */
  startConnecting(): AbortSignal {
    this.#controller = new AbortController();
    this.#state = 'connecting';
    return this.#controller.signal;
  }

  connected(): void {
    this.#state = 'connected';
  }

  failedToConnect(): void {
    this.#state = 'idle';
  }

  /** A scope for one operation; `undefined` when the instance is not connected. */
  begin(): OperationScope | undefined {
    if (this.#state !== 'connected') return undefined;
    const signal = this.#controller.signal;
    return {
      signal,
      cleanup: (task) => {
        const tracked = task.then(
          () => undefined,
          () => undefined,
        );
        this.#cleanups.add(tracked);
        void tracked.then(() => this.#cleanups.delete(tracked));
      },
    };
  }

  /** Ends the generation: fires its signal and waits for every cleanup task. */
  async end(): Promise<void> {
    this.#state = 'ending';
    this.#controller.abort();
    while (this.#cleanups.size > 0) {
      await Promise.all([...this.#cleanups]);
    }
    this.#state = 'idle';
  }
}
