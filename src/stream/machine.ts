// The stream helper's state machine. No I/O: it takes inputs (a socket opened, a message, a timer
// fired, a read answered) and returns actions for a shell to carry out. Every transition is a unit
// test without sockets.
//
//   connecting -> syncing    subscribed
//   connecting -> backoff    network error, or a handshake refused in a way that may mend
//   connecting -> failed     refused 401, 404 or 426, or (status unseen) five refusals with the API reachable
//   syncing    -> live       ticks set, snapshot read, history read, watched requests looked up, resync sent
//   syncing    -> syncing    lagged, or the held events overflowed: the resync starts again
//   syncing    -> host_away  engine_disconnected: the resync is thrown away until events flow again
//   syncing    -> failed     401 or 404 on a read
//   syncing    -> backoff    socket closed, no pong, or the resync not done in 120 s
//   live       -> syncing    lagged, the queue overflowed, or the terminal came back
//   live       -> host_away  engine_disconnected
//   host_away  -> syncing    an event arrives, or the probe read answers
//   host_away  -> failed     401 or 404 on the probe read
//   any open   -> backoff    socket closed, or no pong within 10 s of a ping
//   backoff    -> connecting after 0.5 s doubling to 30 s, with jitter
//   any        -> closed     close()

import {
  AccountUnavailable,
  APIError,
  AuthenticationError,
  NotFound,
  PipsocketError,
  RangeTooLarge,
  StreamHandshakeError,
} from "../errors.js";
import type { AccountView, DealView, HistoryOrderView, PendingOrderView, PositionView } from "../types.js";

export type StateName = "connecting" | "syncing" | "live" | "host_away" | "backoff" | "failed" | "closed";

export type ResyncReason = "connected" | "reconnected" | "lagged" | "host_back" | "overflow";

export type HistoryReason = "no_checkpoint" | "account_changed" | "range_too_large" | "unavailable";

/** The one event the helper adds to the API's own messages. */
export interface ResyncEvent {
  type: "resync";
  reason: ResyncReason;
  /** The account as REST showed it after the subscription was live. Null only with `snapshot: false`. */
  account: AccountView | null;
  /** Null means unavailable (the terminal isn't running), which is not the same as empty. */
  positions: PositionView[] | null;
  orders: PendingOrderView[] | null;
  /** Deals and past orders read back since the checkpoint, best effort. Null says why in `history_reason`. */
  history: { deals: DealView[]; orders: HistoryOrderView[]; from: number; to: number } | null;
  history_reason: HistoryReason | null;
}

/** A message from the API, as it came: a JSON object with a `type`. */
export type StreamMessage = { type: string } & Record<string, unknown>;

/** What the machine queues for the caller: the API's messages as they are, and resync events. */
export type QueuedEvent = ResyncEvent | StreamMessage;

/** Why a handshake failed, as far as the socket can tell. */
export type HandshakeFailure =
  /** The server answered the upgrade with this status. */
  | { kind: "refused"; status: number; body?: string }
  /** The network failed before an answer (refused, unreachable, DNS, TLS). */
  | { kind: "network"; error: unknown }
  /** The socket can't say: a browser-style client gives no status. */
  | { kind: "unknown"; error: unknown };

export type Read =
  | { what: "account" }
  | { what: "positions" }
  | { what: "orders" }
  | { what: "deals"; from: number; to: number }
  | { what: "history_orders"; from: number; to: number }
  /** Look up every request a `requests.wait` is waiting on. */
  | { what: "watched" }
  /** The account read that tells a refusal from a network failure, or that the host is back. */
  | { what: "probe" };

export type TimerName = "backoff" | "ping" | "pong" | "probe" | "resync_deadline" | "resync_retry";

export type Input =
  | { type: "start" }
  | { type: "opened" }
  | { type: "handshake_failed"; failure: HandshakeFailure }
  | { type: "closed" }
  | { type: "text"; text: string }
  | { type: "timer"; name: TimerName }
  | { type: "read_ok"; id: number; value: unknown }
  | { type: "read_failed"; id: number; error: unknown }
  | { type: "set_ticks"; id: number; symbols: string[] }
  | { type: "close" }
  /** A read made outside the stream (a wait() lookup) found the key or the account gone. */
  | { type: "fatal"; error: PipsocketError };

export type Action =
  | { type: "connect" }
  | { type: "send"; text: string }
  | { type: "close_socket" }
  | { type: "set_timer"; name: TimerName; ms: number }
  | { type: "cancel_timer"; name: TimerName }
  | { type: "read"; id: number; read: Read }
  /** Events are waiting in the queue for the caller. */
  | { type: "wake" }
  /** A setTicks call is settled: `error` when the API refused the set. */
  | { type: "ticks_settled"; id: number; error?: PipsocketError }
  /** A request seen on the stream, for `requests.wait`. */
  | { type: "request_seen"; request: Record<string, unknown> }
  | { type: "failed"; error: PipsocketError }
  | { type: "ended" };

export interface MachineOptions {
  ticks: readonly string[];
  /** Read the snapshot and history on each resync. */
  snapshot: boolean;
  /** Events held for the caller before the helper treats the backlog as a gap of its own. */
  queueSize: number;
  random: () => number;
}

export const TIMING = {
  pingMs: 20_000,
  pongMs: 10_000,
  resyncDeadlineMs: 120_000,
  probeFirstMs: 2_000,
  probeMaxMs: 30_000,
  backoffFirstMs: 500,
  backoffMaxMs: 30_000,
  /** History is read from the checkpoint less this. */
  historyMarginS: 300,
  /** ... to the newest server time known plus this. */
  historyAheadS: 86_400,
  /** A history range is split down to slices this long before giving up on range_too_large. */
  smallestSliceS: 60,
  /** Refused handshakes, with the API reachable, before giving up where the status can't be seen. */
  unseenRefusals: 5,
} as const;

/** Statuses that refuse an upgrade for good: the key, the account, or not a WebSocket request. */
const FINAL_REFUSALS = new Set([401, 404, 426]);
/** Messages held during a resync and delivered after it. */
const HELD_TYPES = new Set(["deal", "request", "transaction", "status"]);
/** How many delivered deal and order tickets to remember, to drop them from history read back. */
const REMEMBERED_TICKETS = 10_000;

interface Checkpoint {
  serverTime: number;
  login: number | undefined;
  server: string | undefined;
}

type Step = "ticks" | "account" | "positions" | "orders" | "deals" | "history_orders" | "watched";

interface Resync {
  reason: ResyncReason;
  step: Step;
  /** The read or ticks call this resync waits on; answers to any other id are stale. */
  waitingOn: number | null;
  retries: number;
  /** Frozen when the resync started; a restarted resync reads from it again. */
  checkpoint: Checkpoint | null;
  account: AccountView | null;
  positions: PositionView[] | null;
  orders: PendingOrderView[] | null;
  history: ResyncEvent["history"];
  historyReason: HistoryReason | null;
  range: { from: number; to: number } | null;
  /** Ranges still to read for the current history step; a range too large is split in two. */
  slices: Array<{ from: number; to: number }>;
  deals: DealView[];
  historyOrders: HistoryOrderView[];
  /** The snapshot showed a different login or server than the last one. */
  identityChanged: boolean;
}

export class StreamMachine {
  state: StateName = "connecting";
  /** The error the stream ended with, once failed. */
  error: PipsocketError | null = null;

  readonly #options: MachineOptions;
  /** The tick set the caller asked for last. */
  #ticks: string[];
  /** The last set the API accepted (on this socket or an earlier one). */
  #acceptedTicks: string[] = [];
  /** The set call on the socket, not answered yet, and the setTicks calls it settles. */
  #ticksCall: { id: number; symbols: string[]; waiters: number[] } | null = null;
  /** setTicks calls not sent yet: settled when a set at least as new as theirs is accepted. */
  #ticksWaiting: number[] = [];
  /** The socket has been subscribed and its tick set not yet sent on it. */
  #freshSocket = true;
  #everLive = false;
  #backoffAttempt = 0;
  #unseenRefusals = 0;
  #probeDelay: number = TIMING.probeFirstMs;
  #probeId: number | null = null;
  #handshakeProbeId: number | null = null;
  #awaitingPong = false;
  #socketOpen = false;
  #resync: Resync | null = null;
  /** Deals, requests, transactions and status messages held during a resync. */
  #held: StreamMessage[] = [];
  /** The newest tick per symbol seen during a resync. */
  #heldTicks = new Map<string, StreamMessage>();
  #queue: QueuedEvent[] = [];
  #checkpoint: Checkpoint | null = null;
  #newestServerTime: number | null = null;
  /** The login and server the last snapshot showed, for the checkpoint. */
  #baseline: { login: number; server: string } | null = null;
  /** The last snapshot found the terminal not running: resync when a status shows it back. */
  #terminalAway = false;
  /** A status event showed the terminal connected while the resync ran. */
  #terminalBackDuringResync = false;
  /** For each resync event queued, the checkpoint to commit when the caller takes it. */
  #checkpointOnTake = new WeakMap<object, Checkpoint>();
  /** Bumped when the account's login or server changes; each queued event keeps the one it came in. */
  #identity = 0;
  #identityOf = new WeakMap<object, number>();
  /**
   * The caller has taken a resync that didn't recover its gap (the terminal away for the snapshot
   * or history): the checkpoint stays put, account events included, until the caller takes one that
   * did. Both are applied in the order the caller takes them, in any state.
   */
  #unrecoveredGap = false;
  /** Resync events queued that didn't recover their gap. */
  #leavesGap = new WeakSet<object>();
  /** A login or server change seen and not yet taken by the caller on a resync event. */
  #identityChangePending = false;
  #deliveredDeals = new Set<number>();
  #deliveredOrders = new Set<number>();
  #nextId = 1;

  constructor(options: MachineOptions) {
    this.#options = options;
    this.#ticks = [...options.ticks];
  }

  /** The tick set the helper keeps and sends again after every reconnect. */
  get ticks(): readonly string[] {
    return this.#ticks;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /** The next event for the caller, if one is waiting. */
  take(): QueuedEvent | undefined {
    const event = this.#queue.shift();
    if (event) this.#delivered(event);
    return event;
  }

  /**
   * Bookkeeping for an event the caller has now received: its tickets, for leaving them out of
   * history read back later, and the checkpoint. A resync in progress reads from the checkpoint it
   * started with, so what the caller takes meanwhile doesn't change its range.
   */
  #delivered(event: QueuedEvent): void {
    // An event from before a login change says nothing about the new login.
    if (this.#identityOf.get(event) !== this.#identity) return;
    if (event.type === "deal") this.#rememberDeal(event as StreamMessage);
    if (event.type === "resync") {
      // The caller has the account_changed now: later resyncs read history again.
      if ((event as ResyncEvent).history_reason === "account_changed") this.#identityChangePending = false;
      const history = (event as ResyncEvent).history;
      for (const deal of history?.deals ?? []) this.#rememberTicket(this.#deliveredDeals, deal.ticket);
      for (const order of history?.orders ?? []) this.#rememberTicket(this.#deliveredOrders, order.ticket);
    }
    // The checkpoint follows the order the caller takes events, whatever state the machine is in.
    // A resync in progress isn't affected: it reads from the checkpoint it started with.
    const committed = this.#checkpointOnTake.get(event);
    if (committed) {
      const current = this.#checkpoint;
      this.#checkpoint =
        current && current.login === committed.login && current.server === committed.server
          ? { ...committed, serverTime: Math.max(committed.serverTime, current.serverTime) }
          : committed;
      this.#unrecoveredGap = false;
    } else if (this.#leavesGap.has(event)) {
      this.#unrecoveredGap = true;
    } else {
      this.#advanceCheckpoint(event);
    }
  }

  handle(input: Input): Action[] {
    if (this.state === "closed" || this.state === "failed") {
      // A setTicks after the end settles at once; everything else is ignored.
      if (input.type === "set_ticks") {
        return [{ type: "ticks_settled", id: input.id, error: new PipsocketError("The stream has ended") }];
      }
      return [];
    }
    switch (input.type) {
      case "start":
        return this.#connect();
      case "close":
        return this.#close();
      case "opened":
        if (this.state !== "connecting") return [];
        this.#socketOpen = true;
        // Pings start with the socket, so one that never says subscribed is found dead too.
        return [{ type: "set_timer", name: "ping", ms: TIMING.pingMs }];
      case "handshake_failed":
        return this.#handshakeFailed(input.failure);
      case "closed":
        return this.#socketClosed();
      case "text":
        return this.#text(input.text);
      case "timer":
        return this.#timer(input.name);
      case "read_ok":
        return this.#readOk(input.id, input.value);
      case "read_failed":
        return this.#readFailed(input.id, input.error);
      case "set_ticks":
        return this.#setTicks(input.id, input.symbols);
      case "fatal":
        return this.#fail(input.error);
    }
  }

  // Connecting and the handshake.

  #connect(): Action[] {
    this.state = "connecting";
    this.#freshSocket = true;
    this.#awaitingPong = false;
    return [{ type: "connect" }];
  }

  #handshakeFailed(failure: HandshakeFailure): Action[] {
    if (this.state !== "connecting") return [];
    if (failure.kind === "refused") {
      if (FINAL_REFUSALS.has(failure.status)) return this.#fail(handshakeError(failure.status, failure.body));
      return this.#backoff();
    }
    if (failure.kind === "network") return this.#backoff();
    // The status can't be seen: one REST read with the same key tells a refused key or account apart.
    const id = this.#id();
    this.#handshakeProbeId = id;
    return [{ type: "read", id, read: { what: "probe" } }];
  }

  #handshakeProbeAnswered(ok: boolean, error: unknown): Action[] {
    this.#handshakeProbeId = null;
    if (!ok) {
      if (isFatal(error)) return this.#fail(error as PipsocketError);
      return this.#backoff();
    }
    this.#unseenRefusals += 1;
    if (this.#unseenRefusals >= TIMING.unseenRefusals) {
      return this.#fail(
        new StreamHandshakeError(
          "The API is reachable and the key is good, but the stream's upgrade keeps failing; its status can't be seen in this runtime.",
        ),
      );
    }
    return this.#backoff();
  }

  #backoff(): Action[] {
    const actions = this.#leaveSocket();
    this.state = "backoff";
    this.#backoffAttempt += 1;
    const nominal = Math.min(TIMING.backoffFirstMs * 2 ** (this.#backoffAttempt - 1), TIMING.backoffMaxMs);
    actions.push({ type: "set_timer", name: "backoff", ms: jitter(nominal, this.#options.random()) });
    return actions;
  }

  /** Drops everything tied to the current socket. The checkpoint and held events stay. */
  #leaveSocket(): Action[] {
    this.#resync = null;
    this.#probeId = null;
    this.#handshakeProbeId = null;
    this.#awaitingPong = false;
    this.#socketOpen = false;
    const actions: Action[] = [
      { type: "close_socket" },
      ...(["ping", "pong", "probe", "resync_deadline", "resync_retry"] as const).map(
        (name): Action => ({ type: "cancel_timer", name }),
      ),
    ];
    if (this.#ticksCall) {
      // Unanswered: the set goes again, whole, on the next socket.
      this.#ticksWaiting.unshift(...this.#ticksCall.waiters);
      this.#ticksCall = null;
    }
    return actions;
  }

  #socketClosed(): Action[] {
    // Closed after a refused handshake: the probe read decides what happens next.
    if (this.state === "backoff" || this.#handshakeProbeId !== null) return [];
    if (this.state === "connecting") return this.#handshakeFailed({ kind: "network", error: undefined });
    return this.#backoff();
  }

  #close(): Action[] {
    const actions = this.#leaveSocket();
    actions.push({ type: "cancel_timer", name: "backoff" });
    actions.push(...this.#settleWaiting(new PipsocketError("The stream was closed")));
    this.state = "closed";
    actions.push({ type: "ended" });
    return actions;
  }

  #fail(error: PipsocketError): Action[] {
    const actions = this.#leaveSocket();
    actions.push({ type: "cancel_timer", name: "backoff" });
    actions.push(...this.#settleWaiting(error));
    this.state = "failed";
    this.error = error;
    actions.push({ type: "failed", error });
    return actions;
  }

  // Messages.

  #text(text: string): Action[] {
    if (text === "pong") {
      if (!this.#awaitingPong) return [];
      this.#awaitingPong = false;
      return [
        { type: "cancel_timer", name: "pong" },
        { type: "set_timer", name: "ping", ms: TIMING.pingMs },
      ];
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return [];
    }
    if (typeof message !== "object" || message === null || typeof (message as { type?: unknown }).type !== "string") {
      return [];
    }
    return this.#message(message as StreamMessage);
  }

  #message(message: StreamMessage): Action[] {
    const type = message.type;
    if (type === "subscribed") return this.#subscribed();
    if (type === "response" || type === "error") return this.#callAnswered(message);
    if (this.state === "connecting" || this.state === "backoff") return [];
    if (type === "account") this.#noteServerTime(message);

    if (type === "lagged") {
      const actions = this.#enqueue(message);
      if (this.state === "syncing") return [...actions, ...this.#restartResync()];
      if (this.state === "live") return [...actions, ...this.#startResync("lagged")];
      return actions;
    }
    if (type === "engine_disconnected") {
      const actions = this.#enqueue(message);
      return [...actions, ...this.#hostAway()];
    }
    if (this.state === "host_away") {
      // The first event after the host went away: it is back.
      const actions = this.#startResync("host_back");
      return [...actions, ...this.#duringResync(message)];
    }
    if (this.state === "syncing") return this.#duringResync(message);

    // Live.
    const actions: Action[] = [];
    if (type === "request") actions.push({ type: "request_seen", request: message });
    actions.push(...this.#enqueue(message));
    if (this.state === "live" && type === "status" && this.#terminalAway && message.status === "connected") {
      actions.push(...this.#startResync("host_back"));
    }
    return actions;
  }

  #duringResync(message: StreamMessage): Action[] {
    const type = message.type;
    if (type === "account") return [];
    if (type === "tick") {
      const symbol = typeof message.symbol === "string" ? message.symbol : "";
      const kept = this.#heldTicks.get(symbol);
      if (!kept || timeOf(message) >= timeOf(kept)) {
        this.#heldTicks.set(symbol, message);
        this.#identityOf.set(message, this.#identity);
      }
      return [];
    }
    const actions: Action[] = [];
    if (type === "request") actions.push({ type: "request_seen", request: message });
    if (type === "status" && message.status === "connected") this.#terminalBackDuringResync = true;
    if (!HELD_TYPES.has(type)) return [...actions, ...this.#enqueue(message)];
    if (this.#held.length >= this.#options.queueSize) {
      // The held events overflowed: a gap of the helper's own, so the resync starts again.
      this.#held = [];
      this.#heldTicks.clear();
      return [...actions, ...this.#restartResync("overflow")];
    }
    // Held under the login it arrived with: a login change found later doesn't relabel it.
    this.#identityOf.set(message, this.#identity);
    this.#held.push(message);
    return actions;
  }

  #subscribed(): Action[] {
    if (this.state !== "connecting") return [];
    this.#unseenRefusals = 0;
    const reason: ResyncReason = this.#everLive ? "reconnected" : "connected";
    return this.#startResync(reason);
  }

  // Ticks.

  #setTicks(id: number, symbols: string[]): Action[] {
    this.#ticks = [...symbols];
    this.#ticksWaiting.push(id);
    const subscribed = this.state === "live" || this.state === "host_away" || this.state === "syncing";
    // On a fresh socket the resync's first step sends the set; otherwise send it now, unless a set
    // call is already in flight (then the newest set follows its answer).
    if (!subscribed || this.#ticksCall || this.#resync?.step === "ticks") {
      if (this.#resync?.step === "ticks" && !this.#ticksCall) return this.#sendTicks();
      return [];
    }
    return this.#sendTicks();
  }

  /** Sends the caller's latest set, settling every setTicks call waiting on it. */
  #sendTicks(): Action[] {
    const id = this.#id();
    this.#ticksCall = { id, symbols: this.#ticks, waiters: this.#ticksWaiting };
    this.#ticksWaiting = [];
    if (this.#resync?.step === "ticks") this.#resync.waitingOn = id;
    return [{ type: "send", text: ticksMessage(id, this.#ticks) }];
  }

  #callAnswered(message: StreamMessage): Action[] {
    const call = this.#ticksCall;
    if (!call || message.id !== String(call.id)) return [];
    this.#ticksCall = null;
    const refused = message.type === "error" || typeof message.status !== "number" || message.status >= 300;
    const error = refused ? ticksError(message) : undefined;
    const actions: Action[] = call.waiters.map(
      (id): Action => (error ? { type: "ticks_settled", id, error } : { type: "ticks_settled", id }),
    );
    const inResync = this.#resync?.step === "ticks" && this.#resync.waitingOn === call.id;
    if (error) {
      // The socket keeps the set it had. With no setTicks call to reject, the refused set is the one
      // the stream was opened with or kept from before: the stream can't serve it, so it ends.
      if (call.waiters.length === 0) return [...actions, ...this.#fail(error)];
      // Roll back to the accepted set, unless a newer set is already waiting to go.
      if (this.#ticksWaiting.length === 0) this.#ticks = [...this.#acceptedTicks];
    } else {
      this.#acceptedTicks = call.symbols;
      this.#freshSocket = false;
    }
    if (this.#ticksWaiting.length) return [...actions, ...this.#sendTicks()];
    if (inResync && this.#resync) {
      if (error && this.#freshSocket && this.#ticks.length) return [...actions, ...this.#sendTicks()];
      this.#freshSocket = false;
      return [...actions, ...this.#nextStep(this.#resync)];
    }
    return actions;
  }

  #settleWaiting(error: PipsocketError): Action[] {
    const ids = [...(this.#ticksCall?.waiters ?? []), ...this.#ticksWaiting];
    this.#ticksWaiting = [];
    this.#ticksCall = null;
    return ids.map((id): Action => ({ type: "ticks_settled", id, error }));
  }

  // Resync.

  #startResync(reason: ResyncReason): Action[] {
    const entering = this.state !== "syncing";
    this.state = "syncing";
    this.#probeId = null;
    this.#resync = this.#newResync(reason);
    this.#terminalBackDuringResync = false;
    const actions: Action[] = [
      { type: "cancel_timer", name: "probe" },
      { type: "cancel_timer", name: "resync_retry" },
    ];
    if (entering) actions.push({ type: "set_timer", name: "resync_deadline", ms: TIMING.resyncDeadlineMs });
    return [...actions, ...this.#runStep(this.#resync)];
  }

  #restartResync(reason?: ResyncReason): Action[] {
    const previous = this.#resync;
    return this.#startResync(reason ?? previous?.reason ?? "lagged");
  }

  #newResync(reason: ResyncReason): Resync {
    const sendTicks = this.#freshSocket && (this.#ticks.length > 0 || this.#ticksWaiting.length > 0);
    return {
      reason,
      step: sendTicks ? "ticks" : "account",
      waitingOn: null,
      retries: 0,
      checkpoint: this.#identityChangePending ? null : this.#checkpoint,
      account: null,
      positions: null,
      orders: null,
      history: null,
      historyReason: null,
      range: null,
      slices: [],
      deals: [],
      historyOrders: [],
      identityChanged: this.#identityChangePending,
    };
  }

  #runStep(resync: Resync): Action[] {
    if (resync.step === "ticks") {
      if (this.#ticksCall) {
        resync.waitingOn = this.#ticksCall.id;
        return [];
      }
      return this.#sendTicks();
    }
    if (!this.#options.snapshot && resync.step !== "watched") {
      resync.step = "watched";
    }
    const read = this.#readFor(resync);
    if (!read) return this.#nextStep(resync);
    const id = this.#id();
    resync.waitingOn = id;
    return [{ type: "read", id, read }];
  }

  #readFor(resync: Resync): Read | null {
    switch (resync.step) {
      case "account":
        return { what: "account" };
      case "positions":
        return { what: "positions" };
      case "orders":
        return { what: "orders" };
      case "deals":
      case "history_orders": {
        const slice = resync.slices[0];
        if (!slice) return null;
        return resync.step === "deals"
          ? { what: "deals", from: slice.from, to: slice.to }
          : { what: "history_orders", from: slice.from, to: slice.to };
      }
      case "watched":
        return { what: "watched" };
      default:
        return null;
    }
  }

  #nextStep(resync: Resync): Action[] {
    resync.retries = 0;
    switch (resync.step) {
      case "ticks":
        resync.step = "account";
        break;
      case "account":
        resync.step = "positions";
        break;
      case "positions":
        resync.step = "orders";
        break;
      case "orders":
        this.#planHistory(resync);
        break;
      case "deals":
        resync.step = "history_orders";
        resync.slices = resync.range ? [resync.range] : [];
        break;
      case "history_orders":
        if (resync.range) {
          resync.history = {
            deals: resync.deals.filter((d) => !this.#deliveredDeals.has(d.ticket)),
            orders: resync.historyOrders.filter((o) => !this.#deliveredOrders.has(o.ticket)),
            from: resync.range.from,
            to: resync.range.to,
          };
        }
        resync.step = "watched";
        break;
      case "watched":
        return this.#finishResync(resync);
    }
    return this.#runStep(resync);
  }

  /** Works out the history range from the frozen checkpoint, or why there is none. */
  #planHistory(resync: Resync): void {
    const account = resync.account;
    const checkpoint = resync.checkpoint;
    resync.step = "watched";
    if (resync.identityChanged) {
      resync.historyReason = "account_changed";
      return;
    }
    if (resync.positions === null || resync.orders === null) {
      resync.historyReason = "unavailable";
      return;
    }
    if (!checkpoint) {
      resync.historyReason = "no_checkpoint";
      return;
    }
    const now = typeof account?.server_time === "number" ? account.server_time : null;
    const lowest = now === null ? checkpoint.serverTime : Math.min(checkpoint.serverTime, now);
    const newest = Math.max(checkpoint.serverTime, now ?? 0, this.#newestServerTime ?? 0);
    const range = { from: Math.max(0, lowest - TIMING.historyMarginS), to: newest + TIMING.historyAheadS };
    resync.range = range;
    resync.slices = [range];
    resync.step = "deals";
  }

  #finishResync(resync: Resync): Action[] {
    const event: ResyncEvent = {
      type: "resync",
      reason: resync.reason,
      account: resync.account,
      positions: resync.positions,
      orders: resync.orders,
      history: resync.history,
      history_reason: resync.history ? null : resync.historyReason,
    };
    // The terminal away for the snapshot or for the history: nothing recovered past the checkpoint.
    const unavailable = resync.positions === null || resync.orders === null || resync.historyReason === "unavailable";
    if (resync.account) this.#terminalAway = unavailable;
    // The checkpoint moves only when the caller takes a resync that recovered the account: one
    // with the terminal unavailable reads from the same checkpoint next time.
    const account = resync.account;
    if (account && !unavailable && typeof account.server_time === "number") {
      this.#checkpointOnTake.set(event, {
        serverTime: Math.max(account.server_time, resync.checkpoint?.serverTime ?? 0),
        login: account.login,
        server: account.server,
      });
    }
    // Marked whatever checkpoint this resync started with: the caller may take an earlier resync
    // that sets one before it takes this one.
    if (unavailable) this.#leavesGap.add(event);
    const terminalBack = unavailable && this.#terminalBackDuringResync;
    this.#resync = null;
    this.state = "live";
    this.#everLive = true;
    this.#backoffAttempt = 0;
    const held = this.#held;
    const ticks = [...this.#heldTicks.values()];
    this.#held = [];
    this.#heldTicks.clear();
    const actions: Action[] = [
      { type: "cancel_timer", name: "resync_deadline" },
      { type: "cancel_timer", name: "resync_retry" },
    ];
    // The resync and the held events go in together: if they overflow, the resync starts again.
    const batch: QueuedEvent[] = [event, ...held, ...ticks];
    if (this.#queue.length + batch.length > this.#options.queueSize) {
      this.#queue = [];
      return [...actions, ...this.#startResync("overflow")];
    }
    for (const queued of batch) if (!this.#identityOf.has(queued)) this.#identityOf.set(queued, this.#identity);
    this.#queue.push(...batch);
    actions.push({ type: "wake" });
    // The terminal came back while this resync found it away: read again now it is there.
    if (terminalBack) actions.push(...this.#startResync("host_back"));
    return actions;
  }

  #readOk(id: number, value: unknown): Action[] {
    if (id === this.#handshakeProbeId && this.state === "connecting") return this.#handshakeProbeAnswered(true, null);
    if (id === this.#probeId && this.state === "host_away") {
      this.#probeId = null;
      if (isRecordObject(value)) this.#noteServerTime(value);
      return this.#startResync("host_back");
    }
    const resync = this.#resync;
    if (this.state !== "syncing" || !resync || resync.waitingOn !== id) return [];
    resync.waitingOn = null;
    switch (resync.step) {
      case "account": {
        const account = value as AccountView;
        resync.account = account;
        const baseline = this.#baseline;
        if (baseline && (account.login !== baseline.login || account.server !== baseline.server)) {
          // Another login now: nothing from the old one says anything about this one.
          this.#forgetAccount();
          this.#identity += 1;
          this.#identityChangePending = true;
          resync.checkpoint = null;
          resync.identityChanged = true;
        }
        this.#baseline = { login: account.login, server: account.server };
        if (isRecordObject(value)) this.#noteServerTime(value);
        break;
      }
      case "positions":
        resync.positions = value as PositionView[];
        break;
      case "orders":
        resync.orders = value as PendingOrderView[];
        break;
      case "deals":
        resync.deals.push(...(value as DealView[]));
        resync.slices.shift();
        if (resync.slices.length) return this.#runStep(resync);
        break;
      case "history_orders":
        resync.historyOrders.push(...(value as HistoryOrderView[]));
        resync.slices.shift();
        if (resync.slices.length) return this.#runStep(resync);
        break;
      case "watched":
        break;
      case "ticks":
        return [];
    }
    return this.#nextStep(resync);
  }

  #readFailed(id: number, error: unknown): Action[] {
    // A rolled key or a missing account ends the stream, even when the read was superseded.
    if (isFatal(error)) return this.#fail(error as PipsocketError);
    if (id === this.#handshakeProbeId && this.state === "connecting") return this.#handshakeProbeAnswered(false, error);
    if (id === this.#probeId && this.state === "host_away") {
      this.#probeId = null;
      if (isFatal(error)) return this.#fail(error as PipsocketError);
      this.#probeDelay = Math.min(this.#probeDelay * 2, TIMING.probeMaxMs);
      return [{ type: "set_timer", name: "probe", ms: this.#probeDelay }];
    }
    const resync = this.#resync;
    if (this.state !== "syncing" || !resync || resync.waitingOn !== id) return [];
    resync.waitingOn = null;
    if (isFatal(error)) return this.#fail(error as PipsocketError);
    const unavailable = error instanceof AccountUnavailable;
    if (resync.step === "positions" && unavailable) {
      resync.positions = null;
      resync.orders = null;
      resync.step = "orders";
      return this.#nextStep(resync);
    }
    if (resync.step === "orders" && unavailable) {
      resync.positions = null;
      resync.orders = null;
      return this.#nextStep(resync);
    }
    if ((resync.step === "deals" || resync.step === "history_orders") && unavailable) {
      resync.range = null;
      resync.historyReason = "unavailable";
      resync.step = "watched";
      return this.#runStep(resync);
    }
    if ((resync.step === "deals" || resync.step === "history_orders") && error instanceof RangeTooLarge) {
      const slice = resync.slices.shift();
      if (!slice || slice.to - slice.from + 1 <= TIMING.smallestSliceS) {
        resync.range = null;
        resync.historyReason = "range_too_large";
        resync.step = "watched";
        return this.#runStep(resync);
      }
      const middle = Math.floor((slice.from + slice.to) / 2);
      resync.slices.unshift({ from: slice.from, to: middle }, { from: middle + 1, to: slice.to });
      return this.#runStep(resync);
    }
    if (resync.step === "watched") {
      // wait() polls over REST anyway: a failed lookup doesn't hold the resync up.
      return this.#nextStep(resync);
    }
    // Anything else is retried with backoff, until the resync deadline.
    resync.retries += 1;
    const nominal = Math.min(TIMING.backoffFirstMs * 2 ** (resync.retries - 1), TIMING.backoffMaxMs);
    return [{ type: "set_timer", name: "resync_retry", ms: jitter(nominal, this.#options.random()) }];
  }

  // Host away.

  #hostAway(): Action[] {
    if (this.state !== "live" && this.state !== "syncing" && this.state !== "host_away") return [];
    const actions: Action[] = [];
    if (this.state === "syncing") {
      actions.push({ type: "cancel_timer", name: "resync_deadline" }, { type: "cancel_timer", name: "resync_retry" });
    }
    this.#resync = null;
    this.state = "host_away";
    this.#probeDelay = TIMING.probeFirstMs;
    this.#probeId = null;
    actions.push({ type: "set_timer", name: "probe", ms: this.#probeDelay });
    return actions;
  }

  // Timers.

  #timer(name: TimerName): Action[] {
    switch (name) {
      case "backoff":
        return this.state === "backoff" ? this.#connect() : [];
      case "ping":
        if (!this.#socketOpen) return [];
        this.#awaitingPong = true;
        return [
          { type: "send", text: "ping" },
          { type: "set_timer", name: "pong", ms: TIMING.pongMs },
        ];
      case "pong":
        // No pong within 10 s: the socket is dead.
        return this.#awaitingPong ? this.#backoff() : [];
      case "probe": {
        if (this.state !== "host_away") return [];
        const id = this.#id();
        this.#probeId = id;
        return [{ type: "read", id, read: { what: "probe" } }];
      }
      case "resync_deadline":
        // A resync not done in 120 s: start again from a fresh connection.
        return this.state === "syncing" ? this.#backoff() : [];
      case "resync_retry":
        return this.state === "syncing" && this.#resync ? this.#runStep(this.#resync) : [];
    }
  }

  // The caller's queue and the checkpoint.

  #enqueue(event: QueuedEvent): Action[] {
    if (this.#queue.length >= this.#options.queueSize) {
      // The caller fell behind: the helper's own gap, which the server can't see. Resync.
      this.#queue = [];
      if (this.state !== "syncing" && this.state !== "live") return [];
      // The event that overflowed is handled as any event during the resync is.
      const actions = this.state === "syncing" ? this.#restartResync("overflow") : this.#startResync("overflow");
      return [...actions, ...this.#duringResync(event as StreamMessage)];
    }
    this.#identityOf.set(event, this.#identity);
    this.#queue.push(event);
    return [{ type: "wake" }];
  }

  #advanceCheckpoint(event: QueuedEvent): void {
    if (event.type !== "account" || typeof event.server_time !== "number" || !this.#baseline) return;
    const current = this.#checkpoint;
    // A gap not yet recovered holds the checkpoint where it is; with none yet, this sets the first.
    if (this.#unrecoveredGap && current) return;
    if (current && (current.login !== this.#baseline.login || current.server !== this.#baseline.server)) return;
    this.#checkpoint = {
      serverTime: Math.max(event.server_time, current?.serverTime ?? 0),
      login: this.#baseline.login,
      server: this.#baseline.server,
    };
  }

  #forgetAccount(): void {
    this.#checkpoint = null;
    // The old login's gap can't be recovered for the new one.
    this.#unrecoveredGap = false;
    this.#newestServerTime = null;
    this.#deliveredDeals.clear();
    this.#deliveredOrders.clear();
  }

  #noteServerTime(message: Record<string, unknown>): void {
    if (typeof message.server_time === "number") {
      this.#newestServerTime = Math.max(this.#newestServerTime ?? 0, message.server_time);
    }
  }

  #rememberDeal(message: StreamMessage): void {
    const deal = message.deal as { ticket?: unknown } | undefined;
    if (typeof deal?.ticket === "number") this.#rememberTicket(this.#deliveredDeals, deal.ticket);
  }

  #rememberTicket(set: Set<number>, ticket: number): void {
    set.add(ticket);
    if (set.size > REMEMBERED_TICKETS) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }

  #id(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }
}

function jitter(nominal: number, random: number): number {
  return nominal * (0.5 + random * 0.5);
}

function timeOf(message: StreamMessage): number {
  return typeof message.time_msc === "number" ? message.time_msc : 0;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A 401, or a 404 for the account: these don't mend, so the helper stops. Judged by the status, so
 * a refusal with a code this version doesn't know, or no JSON at all, counts too.
 */
export function isFatal(error: unknown): boolean {
  if (!(error instanceof APIError)) return false;
  if (error.status === 401) return true;
  return error.status === 404 && error.code !== "no_such_request";
}

function ticksMessage(id: number, symbols: readonly string[]): string {
  return JSON.stringify({ id: String(id), method: "PUT", path: "/ticks", body: { symbols } });
}

function ticksError(message: StreamMessage): PipsocketError {
  const body = isRecordObject(message.body) ? message.body : message;
  const code = typeof body.error === "string" ? body.error : null;
  const status = typeof message.status === "number" ? message.status : 0;
  return new APIError({ status, code, body, raw: JSON.stringify(message) });
}

function handshakeError(status: number, body: string | undefined): PipsocketError {
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }
  const code = isRecordObject(parsed) && typeof parsed.error === "string" ? parsed.error : null;
  const fields = { status, code, body: parsed, raw: body ?? "" };
  if (status === 401) return new AuthenticationError(fields);
  if (status === 404) return new NotFound(fields);
  return new StreamHandshakeError(`The stream's upgrade was refused with ${status}${code ? ` ${code}` : ""}`);
}
