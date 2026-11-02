import type { Scheduler } from "../terminal/live";

/**
 * For specs: a terminal stream and a clock, faked. The stream records every write as text, has a
 * size, a backlog and a failure mode set by hand, Node's internal handle (`setBlocking`), and the
 * `error`/`resize` events; its `write` comes from the prototype, as `process.stdout`'s does. The clock
 * moves only when told, firing the timers it passes.
 */

/** How a fake stream's `write` behaves. */
export type FakeWriteMode = "ok" | "throw" | "callback-error";

/** A terminal stream stand-in. */
export class FakeTerminal {
  readonly chunks: string[] = [];
  isTTY: boolean;
  columns: number | undefined = 80;
  rows: number | undefined = 24;
  writableLength = 0;
  destroyed = false;
  mode: FakeWriteMode = "ok";
  /** What `_handle.setBlocking` was called with, in order. */
  readonly blocking: boolean[] = [];
  /** Node's internal handle, as `unblockTerminal` reads it. */
  readonly _handle = {
    setBlocking: (blocking: boolean): number => {
      this.blocking.push(blocking);
      return 0;
    },
  };
  readonly #listeners = new Map<string, Set<(arg?: unknown) => void>>();

  /**
   * @param isTTY - whether it is a terminal.
   */
  constructor(isTTY = true) {
    this.isTTY = isTTY;
  }

  /**
   * Records text or bytes as text; calls back as {@link FakeTerminal.mode} says.
   *
   * @param chunk - what was written.
   * @param encoding - an encoding, or the callback.
   * @param callback - the callback.
   */
  write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (this.mode === "throw") throw new Error("write EIO");
    this.chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    const done = typeof encoding === "function" ? encoding : callback;
    done?.(this.mode === "callback-error" ? new Error("write EPIPE") : null);
    return true;
  }

  /**
   * Listens for an event.
   *
   * @param event - the event's name.
   * @param listener - the listener.
   */
  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  /**
   * Stops listening.
   *
   * @param event - the event's name.
   * @param listener - the listener.
   */
  off(event: string, listener: (arg?: unknown) => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  /**
   * Listens for an event (once, for `console`, which only adds and removes a no-op).
   *
   * @param event - the event's name.
   * @param listener - the listener.
   */
  once(event: string, listener: (arg?: unknown) => void): this {
    return this.on(event, listener);
  }

  /**
   * Stops listening, as {@link FakeTerminal.off}.
   *
   * @param event - the event's name.
   * @param listener - the listener.
   */
  removeListener(event: string, listener: (arg?: unknown) => void): this {
    return this.off(event, listener);
  }

  /**
   * How many listeners an event has.
   *
   * @param event - the event's name.
   */
  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /**
   * Emits an event to its listeners.
   *
   * @param event - the event's name.
   * @param arg - what the listeners get.
   */
  emit(event: string, arg?: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])])
      listener(arg);
  }

  /** Everything written, as one string. */
  get all(): string {
    return this.chunks.join("");
  }
}

/**
 * The process's `exit` event and its stop signals (`SIGTERM`, `SIGHUP`), faked: listeners per event,
 * and `kill` recorded instead of sent.
 */
export class FakeExit {
  readonly #listeners = new Map<string, Set<() => void>>();
  /** The process's id, as `kill` is given it. */
  readonly pid = 4242;
  /** Every `kill(pid, signal)` asked for, in order. */
  readonly kills: [number, string][] = [];

  /**
   * @param event - `exit` or a signal's name.
   * @param listener - the listener.
   */
  on(event: string, listener: () => void): this {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  /**
   * @param event - `exit` or a signal's name.
   * @param listener - the listener.
   */
  off(event: string, listener: () => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  /**
   * How many listen to `event`.
   *
   * @param event - `exit` or a signal's name.
   */
  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /**
   * Records a signal sent to a process.
   *
   * @param pid - the process.
   * @param signal - the signal.
   */
  kill(pid: number, signal: string): true {
    this.kills.push([pid, signal]);
    return true;
  }

  /** How many listen to `exit`. */
  get count(): number {
    return this.listenerCount("exit");
  }

  /** How many listen to anything. */
  get total(): number {
    return [...this.#listeners.values()].reduce((n, set) => n + set.size, 0);
  }

  /**
   * The process exits, or gets a signal.
   *
   * @param event - `exit` by default, or a signal's name.
   */
  emit(event = "exit"): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener();
  }
}

/** A clock that moves only when told; timers fire as it passes them. */
export class FakeScheduler implements Scheduler {
  time = 0;
  #next = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /**
   * Moves the clock by `ms`, firing each due timer in order.
   *
   * @param ms - how far.
   */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
    }
    this.time = end;
  }
}
