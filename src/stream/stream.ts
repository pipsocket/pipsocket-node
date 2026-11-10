// The shell around the stream state machine: it opens sockets, runs timers, makes the REST reads
// the machine asks for, and hands events to the caller.

import type { PipsocketError } from "../errors.js";
import { type Action, type Input, type Read, StreamMachine, type TimerName } from "./machine.js";
import type { StreamEvent } from "./messages.js";
import { defaultSocket, type SocketFactory, type StreamSocket } from "./socket.js";

export interface StreamOptions {
  /** Symbols to get tick events for. Change them with `setTicks`. */
  ticks?: string[];
  /**
   * Read the account, positions, pending orders and history on every resync. Defaults to true.
   * With false, a resync event carries only its reason, and the rest is null.
   */
  snapshot?: boolean;
  /** Events held for you before the helper treats the backlog as a gap. Defaults to 10000. */
  queueSize?: number;
  /** A socket adapter for a runtime that needs its own. Defaults to ws on Node, the built-in on Bun and Deno. */
  socket?: SocketFactory;
}

/** What the stream needs from its account: REST reads, the upgrade request, and wait()'s watchers. */
export interface StreamContext {
  url: string;
  headers: () => Record<string, string>;
  random: () => number;
  read: (read: Read, signal: AbortSignal) => Promise<unknown>;
  requestSeen: (request: Record<string, unknown>) => void;
  /** Registers the stream to be told when a read outside it finds the key or account gone. */
  watchFatal: (fail: (error: PipsocketError) => void) => () => void;
}

/**
 * The account's stream: an async iterable of the API's messages, plus `resync` events. It reconnects
 * by itself, sets the ticks again, and resyncs after every gap. Stop it with `close()` (or by leaving
 * a `for await` loop).
 */
export class AccountStream implements AsyncIterable<StreamEvent> {
  readonly #machine: StreamMachine;
  readonly #context: StreamContext;
  readonly #socketFactory: Promise<SocketFactory>;
  readonly #abort = new AbortController();
  readonly #timers = new Map<TimerName, ReturnType<typeof setTimeout>>();
  readonly #ticksCalls = new Map<number, { resolve: () => void; reject: (error: PipsocketError) => void }>();
  #socket: StreamSocket | null = null;
  /** Bumped for every socket, so events from an old one are ignored. */
  #generation = 0;
  #nextTicksId = 1;
  #waiting: (() => void) | null = null;
  #ended = false;
  #error: unknown = null;
  #errorThrown = false;
  readonly #unwatchFatal: () => void;

  constructor(context: StreamContext, options: StreamOptions = {}) {
    this.#context = context;
    this.#machine = new StreamMachine({
      ticks: options.ticks ?? [],
      snapshot: options.snapshot ?? true,
      queueSize: options.queueSize ?? 10_000,
      random: context.random,
    });
    this.#socketFactory = options.socket ? Promise.resolve(options.socket) : defaultSocket();
    this.#unwatchFatal = context.watchFatal((error) => this.#input({ type: "fatal", error }));
    // A missing ws package surfaces from the first read of the stream.
    this.#socketFactory.then(
      () => this.#input({ type: "start" }),
      (error) => this.#end(error),
    );
  }

  /** The current tick set. */
  get ticks(): readonly string[] {
    return this.#machine.ticks;
  }

  /**
   * Replaces the tick set (all the symbols you want, up to 100; [] stops ticks). Resolves when the
   * API has the set, and rejects with its refusal, such as 422 too_many_symbols. The helper keeps
   * the set and sends it again after every reconnect.
   */
  setTicks(symbols: string[]): Promise<void> {
    const id = this.#nextTicksId;
    this.#nextTicksId += 1;
    const settled = new Promise<void>((resolve, reject) => this.#ticksCalls.set(id, { resolve, reject }));
    this.#input({ type: "set_ticks", id, symbols: [...symbols] });
    return settled;
  }

  /** Stops the stream at once: the socket closes and nothing more is read. */
  close(): void {
    this.#input({ type: "close" });
    this.#end(null);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    try {
      for (;;) {
        const event = this.#machine.take();
        if (event) {
          yield event as StreamEvent;
          continue;
        }
        if (this.#ended) {
          if (this.#error && !this.#errorThrown) {
            this.#errorThrown = true;
            throw this.#error;
          }
          return;
        }
        await new Promise<void>((resolve) => {
          this.#waiting = resolve;
        });
      }
    } finally {
      // Leaving the loop early (break, return, throw) closes the stream.
      if (!this.#ended) this.close();
    }
  }

  #input(input: Input): void {
    for (const action of this.#machine.handle(input)) this.#apply(action);
  }

  #apply(action: Action): void {
    switch (action.type) {
      case "connect":
        void this.#connect();
        return;
      case "send":
        this.#socket?.send(action.text);
        return;
      case "close_socket":
        this.#generation += 1;
        this.#socket?.close();
        this.#socket = null;
        return;
      case "set_timer": {
        clearTimeout(this.#timers.get(action.name));
        const timer = setTimeout(() => {
          this.#timers.delete(action.name);
          this.#input({ type: "timer", name: action.name });
        }, action.ms);
        this.#timers.set(action.name, timer);
        return;
      }
      case "cancel_timer":
        clearTimeout(this.#timers.get(action.name));
        this.#timers.delete(action.name);
        return;
      case "read":
        void this.#read(action.id, action.read);
        return;
      case "wake":
        this.#wake();
        return;
      case "ticks_settled": {
        const call = this.#ticksCalls.get(action.id);
        this.#ticksCalls.delete(action.id);
        if (action.error) call?.reject(action.error);
        else call?.resolve();
        return;
      }
      case "request_seen":
        this.#context.requestSeen(action.request);
        return;
      case "failed":
        this.#end(action.error);
        return;
      case "ended":
        this.#end(null);
        return;
    }
  }

  async #connect(): Promise<void> {
    const generation = this.#generation;
    const factory = await this.#socketFactory;
    const current = () => generation === this.#generation && !this.#ended;
    // Closed, or moved on, while the factory loaded: open nothing.
    if (!current()) return;
    this.#socket = factory(this.#context.url, this.#context.headers(), {
      opened: () => current() && this.#input({ type: "opened" }),
      text: (text) => current() && this.#input({ type: "text", text }),
      closed: () => current() && this.#input({ type: "closed" }),
      handshakeFailed: (failure) => current() && this.#input({ type: "handshake_failed", failure }),
    });
  }

  async #read(id: number, read: Read): Promise<void> {
    let input: Input;
    try {
      const value = await this.#context.read(read, this.#abort.signal);
      input = { type: "read_ok", id, value };
    } catch (error) {
      input = { type: "read_failed", id, error };
    }
    if (!this.#ended) this.#input(input);
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.();
  }

  #end(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    this.#unwatchFatal();
    if (this.#machine.state !== "closed" && this.#machine.state !== "failed") this.#input({ type: "close" });
    this.#abort.abort();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#generation += 1;
    this.#socket?.close();
    this.#socket = null;
    this.#wake();
  }
}
