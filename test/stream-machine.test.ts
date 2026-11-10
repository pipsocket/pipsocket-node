// The stream helper's state machine, walked without sockets: one test for each transition a stream
// goes through, from first connect to close.

import { describe, expect, test } from "vitest";
import {
  AccountUnavailable,
  APIError,
  AuthenticationError,
  NotFound,
  RangeTooLarge,
  StreamHandshakeError,
  Unavailable,
} from "../src/index.js";
import {
  type Action,
  type Input,
  type QueuedEvent,
  type Read,
  type ResyncEvent,
  StreamMachine,
  TIMING,
} from "../src/stream/machine.js";

const ACCOUNT = {
  id: "acc_1",
  login: 5058427372,
  server: "Broker-Demo",
  status: "connected",
  server_time: 1_794_067_825,
};
const err = (Kind: typeof APIError, status: number, code: string) =>
  new Kind({ status, code, body: { error: code, message: "..." }, raw: "", retryAfter: null } as never);

class Driver {
  readonly machine: StreamMachine;
  actions: Action[] = [];

  constructor(options: Partial<{ ticks: string[]; snapshot: boolean; queueSize: number }> = {}) {
    this.machine = new StreamMachine({
      ticks: options.ticks ?? ["EURUSD"],
      snapshot: options.snapshot ?? true,
      queueSize: options.queueSize ?? 100,
      random: () => 1,
    });
  }

  get state() {
    return this.machine.state;
  }

  feed(input: Input): Action[] {
    const out = this.machine.handle(input);
    this.actions.push(...out);
    return out;
  }

  message(message: Record<string, unknown>): Action[] {
    return this.feed({ type: "text", text: JSON.stringify(message) });
  }

  readonly #answered = new Set<number | string>();

  /** The most recent read the machine asked for that hasn't been answered. */
  pendingRead(what?: Read["what"]): { id: number; read: Read } {
    const reads = this.actions.filter(
      (a): a is Extract<Action, { type: "read" }> => a.type === "read" && !this.#answered.has(a.id),
    );
    const read = reads.filter((r) => !what || r.read.what === what).at(-1);
    if (!read) throw new Error(`No read${what ? ` of ${what}` : ""} was asked for`);
    return read;
  }

  answer(what: Read["what"], value: unknown): Action[] {
    const { id } = this.pendingRead(what);
    this.#answered.add(id);
    return this.feed({ type: "read_ok", id, value });
  }

  refuse(what: Read["what"], error: unknown): Action[] {
    const { id } = this.pendingRead(what);
    this.#answered.add(id);
    return this.feed({ type: "read_failed", id, error });
  }

  /** The last tick set sent on the socket, and its call id. */
  lastTicksCall(): { id: string; symbols: string[] } | undefined {
    const sends = this.actions.filter((a): a is Extract<Action, { type: "send" }> => a.type === "send");
    const call = sends
      .map((s) => s.text)
      .filter((t) => t.startsWith("{"))
      .map((t) => JSON.parse(t))
      .filter((m) => m.path === "/ticks")
      .at(-1);
    return call ? { id: call.id, symbols: call.body.symbols } : undefined;
  }

  answerTicks(status = 200, body: unknown = { symbols: this.lastTicksCall()?.symbols }): Action[] {
    const call = this.lastTicksCall();
    if (!call) throw new Error("No ticks call was sent");
    this.#answered.add(call.id);
    return this.message({ type: "response", id: call.id, status, body });
  }

  /** Connects and subscribes, from connecting. */
  subscribe(): void {
    this.feed({ type: "opened" });
    this.message({ type: "subscribed", account: "acc_1" });
  }

  /** Answers a whole resync: ticks if sent, the snapshot, history if read, watched lookups. */
  completeResync(
    snapshot: { account?: unknown; positions?: unknown; orders?: unknown } = {},
    history: { deals?: unknown[]; orders?: unknown[] } = {},
  ): void {
    if (this.machine.state !== "syncing") throw new Error(`Not syncing: ${this.machine.state}`);
    const call = this.lastTicksCall();
    if (call && !this.#answered.has(call.id)) this.answerTicks();
    this.answer("account", snapshot.account ?? ACCOUNT);
    this.answer("positions", snapshot.positions ?? []);
    this.answer("orders", snapshot.orders ?? []);
    if (this.pendingRead().read.what === "deals") {
      this.answer("deals", history.deals ?? []);
      this.answer("history_orders", history.orders ?? []);
    }
    this.answer("watched", null);
  }

  drain(): QueuedEvent[] {
    const events: QueuedEvent[] = [];
    for (let e = this.machine.take(); e; e = this.machine.take()) events.push(e);
    return events;
  }

  resyncs(): ResyncEvent[] {
    return this.drain().filter((e): e is ResyncEvent => e.type === "resync");
  }

  has(action: Partial<Action>): boolean {
    return this.actions.some((a) => Object.entries(action).every(([k, v]) => (a as Record<string, unknown>)[k] === v));
  }

  timer(name: Extract<Action, { type: "set_timer" }>["name"]): number | undefined {
    const set = this.actions.filter((a): a is Extract<Action, { type: "set_timer" }> => a.type === "set_timer");
    return set.filter((a) => a.name === name).at(-1)?.ms;
  }

  clear(): void {
    this.actions = [];
  }
}

function connectedLive(options?: ConstructorParameters<typeof Driver>[0]): Driver {
  const d = new Driver(options);
  d.feed({ type: "start" });
  d.subscribe();
  d.completeResync();
  d.drain();
  d.clear();
  return d;
}

describe("stream transitions, walked", () => {
  test("1: first connect: subscribed, ticks, snapshot, resync(connected) with no history, then live events", () => {
    const d = new Driver();
    expect(d.feed({ type: "start" })).toEqual([{ type: "connect" }]);
    d.subscribe();
    expect(d.state).toBe("syncing");
    expect(d.lastTicksCall()?.symbols).toEqual(["EURUSD"]);
    // The snapshot is read only once the ticks call is answered.
    expect(() => d.pendingRead("account")).toThrow();
    d.answerTicks();
    d.answer("account", ACCOUNT);
    d.answer("positions", [{ ticket: 1 }]);
    d.answer("orders", []);
    expect(d.pendingRead().read.what).toBe("watched");
    d.answer("watched", null);
    expect(d.state).toBe("live");
    const [resync] = d.drain() as ResyncEvent[];
    expect(resync).toEqual({
      type: "resync",
      reason: "connected",
      account: ACCOUNT,
      positions: [{ ticket: 1 }],
      orders: [],
      history: null,
      history_reason: "no_checkpoint",
    });
    d.message({ type: "deal", deal: { ticket: 9 } });
    expect(d.drain()).toEqual([{ type: "deal", deal: { ticket: 9 } }]);
  });

  describe("2: the handshake is refused", () => {
    test.each([
      [401, AuthenticationError],
      [404, NotFound],
      [426, StreamHandshakeError],
    ])("%i where the status shows: raised, and the helper stops", (status, Kind) => {
      const d = new Driver();
      d.feed({ type: "start" });
      const out = d.feed({ type: "handshake_failed", failure: { kind: "refused", status, body: '{"error":"x"}' } });
      expect(d.state).toBe("failed");
      expect(d.machine.error).toBeInstanceOf(Kind);
      expect(out.some((a) => a.type === "set_timer" && a.name === "backoff")).toBe(false);
    });

    test("where the status can't be seen: a REST read that answers 401 is final", () => {
      const d = new Driver();
      d.feed({ type: "start" });
      d.feed({ type: "handshake_failed", failure: { kind: "unknown", error: null } });
      // The socket's close after the failure doesn't cut the probe short.
      d.feed({ type: "closed" });
      expect(d.state).toBe("connecting");
      d.refuse("probe", err(AuthenticationError, 401, "invalid_api_key"));
      expect(d.state).toBe("failed");
      expect(d.machine.error).toBeInstanceOf(AuthenticationError);
    });

    test("where the status can't be seen: five refusals with the API reachable end as StreamHandshakeError", () => {
      const d = new Driver();
      d.feed({ type: "start" });
      for (let i = 1; i <= TIMING.unseenRefusals; i += 1) {
        d.feed({ type: "handshake_failed", failure: { kind: "unknown", error: null } });
        d.answer("probe", ACCOUNT);
        if (i < TIMING.unseenRefusals) {
          expect(d.state).toBe("backoff");
          d.feed({ type: "timer", name: "backoff" });
        }
      }
      expect(d.state).toBe("failed");
      expect(d.machine.error).toBeInstanceOf(StreamHandshakeError);
    });

    test("a refusal that may mend (such as 503) backs off and tries again", () => {
      const d = new Driver();
      d.feed({ type: "start" });
      d.feed({ type: "handshake_failed", failure: { kind: "refused", status: 503 } });
      expect(d.state).toBe("backoff");
    });
  });

  test("3: a network failure backs off 0.5 s doubling to 30 s, for as long as the stream is kept", () => {
    const d = new Driver();
    d.feed({ type: "start" });
    const waits: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      d.feed({ type: "handshake_failed", failure: { kind: "network", error: null } });
      waits.push(d.timer("backoff") ?? 0);
      d.feed({ type: "timer", name: "backoff" });
      expect(d.state).toBe("connecting");
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test("4: the socket closes: back off, reconnect, set ticks again, snapshot, history since the checkpoint", () => {
    const d = connectedLive();
    d.message({ type: "account", server_time: ACCOUNT.server_time + 60 });
    d.drain(); // the caller took the account event: the checkpoint moves to it
    d.feed({ type: "closed" });
    expect(d.state).toBe("backoff");
    expect(d.has({ type: "close_socket" })).toBe(true);
    d.feed({ type: "timer", name: "backoff" });
    d.subscribe();
    expect(d.lastTicksCall()?.symbols).toEqual(["EURUSD"]);
    d.answerTicks();
    d.answer("account", { ...ACCOUNT, server_time: ACCOUNT.server_time + 120 });
    d.answer("positions", []);
    d.answer("orders", []);
    const deals = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
    expect(deals.from).toBe(ACCOUNT.server_time + 60 - TIMING.historyMarginS);
    expect(deals.to).toBe(ACCOUNT.server_time + 120 + TIMING.historyAheadS);
    d.answer("deals", [{ ticket: 77 }]);
    d.answer("history_orders", [{ ticket: 88 }]);
    d.answer("watched", null);
    const [resync] = d.resyncs();
    expect(resync?.reason).toBe("reconnected");
    expect(resync?.history).toEqual({
      deals: [{ ticket: 77 }],
      orders: [{ ticket: 88 }],
      from: deals.from,
      to: deals.to,
    });
    expect(resync?.history_reason).toBeNull();
  });

  test("5: the socket closes again while syncing: the half-read snapshot is dropped, the checkpoint stays", () => {
    const d = connectedLive();
    d.feed({ type: "closed" });
    d.feed({ type: "timer", name: "backoff" });
    d.subscribe();
    d.answerTicks();
    const stale = d.pendingRead("account");
    d.feed({ type: "closed" });
    expect(d.state).toBe("backoff");
    // The answer to the old socket's read arrives late: ignored.
    expect(d.feed({ type: "read_ok", id: stale.id, value: ACCOUNT })).toEqual([]);
    d.feed({ type: "timer", name: "backoff" });
    d.subscribe();
    d.answerTicks();
    d.answer("account", ACCOUNT);
    d.answer("positions", []);
    d.answer("orders", []);
    const deals = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
    expect(deals.from).toBe(ACCOUNT.server_time - TIMING.historyMarginS);
  });

  test("6: lagged: resync without reconnecting, and without sending the ticks again", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 12 });
    expect(d.state).toBe("syncing");
    expect(d.lastTicksCall()).toBeUndefined();
    expect(d.has({ type: "connect" })).toBe(false);
    d.completeResync();
    const events = d.drain();
    expect(events[0]).toEqual({ type: "lagged", missed: 12 });
    expect((events[1] as ResyncEvent).reason).toBe("lagged");
  });

  test("7: lagged during a resync restarts it, so the snapshot is read after the last gap", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    const first = d.pendingRead("account");
    d.message({ type: "lagged", missed: 2 });
    const second = d.pendingRead("account");
    expect(second.id).not.toBe(first.id);
    expect(d.feed({ type: "read_ok", id: first.id, value: ACCOUNT })).toEqual([]);
    d.feed({ type: "read_ok", id: second.id, value: ACCOUNT });
    expect(d.pendingRead().read.what).toBe("positions");
  });

  test("7: engine_disconnected during a resync throws it away until events flow again", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    const reading = d.pendingRead("account");
    d.message({ type: "engine_disconnected" });
    expect(d.state).toBe("host_away");
    expect(d.feed({ type: "read_ok", id: reading.id, value: ACCOUNT })).toEqual([]);
  });

  test("8: the host goes away, then an event arrives: resync(host_back), with the event held", () => {
    const d = connectedLive();
    d.message({ type: "engine_disconnected" });
    expect(d.state).toBe("host_away");
    expect(d.timer("probe")).toBe(TIMING.probeFirstMs);
    d.message({ type: "deal", deal: { ticket: 5 } });
    expect(d.state).toBe("syncing");
    d.completeResync();
    const events = d.drain();
    expect(events.map((e) => e.type)).toEqual(["engine_disconnected", "resync", "deal"]);
    expect((events[1] as ResyncEvent).reason).toBe("host_back");
  });

  test("8: the host comes back silently: the probe read's first 200 starts the resync", () => {
    const d = connectedLive();
    d.message({ type: "engine_disconnected" });
    d.feed({ type: "timer", name: "probe" });
    d.refuse("probe", err(Unavailable, 503, "engine_unavailable"));
    expect(d.timer("probe")).toBe(TIMING.probeFirstMs * 2);
    d.feed({ type: "timer", name: "probe" });
    d.answer("probe", ACCOUNT);
    expect(d.state).toBe("syncing");
    d.completeResync();
    expect(d.resyncs()[0]?.reason).toBe("host_back");
  });

  test("8a: back, but the account was stopped: positions and orders unavailable, then a resync when it's back", () => {
    const d = connectedLive();
    d.message({ type: "engine_disconnected" });
    d.feed({ type: "timer", name: "probe" });
    d.answer("probe", ACCOUNT);
    d.answer("account", { ...ACCOUNT, status: "stopped" });
    d.refuse("positions", err(AccountUnavailable, 503, "account_not_connected"));
    expect(d.pendingRead().read.what).toBe("watched");
    d.answer("watched", null);
    const [resync] = d.resyncs();
    expect(resync).toMatchObject({ positions: null, orders: null, history: null, history_reason: "unavailable" });
    d.message({ type: "status", status: "connected", detail: null });
    expect(d.state).toBe("syncing");
  });

  test("9: the host goes away and the socket closes: snapshot reads fail and are retried with backoff", () => {
    const d = connectedLive();
    d.message({ type: "engine_disconnected" });
    d.feed({ type: "closed" });
    d.feed({ type: "timer", name: "backoff" });
    d.subscribe();
    d.answerTicks();
    d.refuse("account", err(Unavailable, 503, "engine_unavailable"));
    expect(d.state).toBe("syncing");
    expect(d.timer("resync_retry")).toBe(500);
    d.feed({ type: "timer", name: "resync_retry" });
    d.refuse("account", err(Unavailable, 503, "engine_unavailable"));
    expect(d.timer("resync_retry")).toBe(1000);
    d.feed({ type: "timer", name: "resync_retry" });
    d.answer("account", ACCOUNT);
    expect(d.pendingRead().read.what).toBe("positions");
  });

  test("10: the caller is slow and the queue fills: it is emptied and resync(overflow) runs", () => {
    const d = connectedLive({ queueSize: 3 });
    for (let i = 0; i < 3; i += 1) d.message({ type: "tick", symbol: "EURUSD", time_msc: i });
    expect(d.machine.queued).toBe(3);
    d.message({ type: "tick", symbol: "EURUSD", time_msc: 3 });
    expect(d.machine.queued).toBe(0);
    expect(d.state).toBe("syncing");
    d.completeResync();
    const events = d.drain();
    expect((events[0] as ResyncEvent).reason).toBe("overflow");
    // The newest tick from the resync window is kept and delivered after it.
    expect(events.slice(1)).toEqual([{ type: "tick", symbol: "EURUSD", time_msc: 3 }]);
  });

  test("11: the key was rolled and the socket closes: the reconnect is refused 401, and the helper stops", () => {
    const d = connectedLive();
    d.feed({ type: "closed" });
    d.feed({ type: "timer", name: "backoff" });
    d.feed({ type: "handshake_failed", failure: { kind: "refused", status: 401 } });
    expect(d.state).toBe("failed");
    expect(d.machine.error).toBeInstanceOf(AuthenticationError);
  });

  test("11a: the key was rolled and the socket stays open: the next read's 401 closes it and stops", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    const out = d.refuse("account", err(AuthenticationError, 401, "invalid_api_key"));
    expect(d.state).toBe("failed");
    expect(out).toContainEqual({ type: "close_socket" });
    expect(out.find((a) => a.type === "failed")).toBeTruthy();
  });

  test("11b: a resync not done in 120 s: the socket is closed and the helper reconnects from scratch", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    expect(d.timer("resync_deadline")).toBe(TIMING.resyncDeadlineMs);
    d.feed({ type: "timer", name: "resync_deadline" });
    expect(d.state).toBe("backoff");
    expect(d.has({ type: "close_socket" })).toBe(true);
  });

  test("12: status events pass through as they are; a reconnect refused 404 is raised", () => {
    const d = connectedLive();
    d.message({ type: "status", status: "stopped", detail: "stopped from the dashboard" });
    expect(d.drain()).toEqual([{ type: "status", status: "stopped", detail: "stopped from the dashboard" }]);
    d.feed({ type: "closed" });
    d.feed({ type: "timer", name: "backoff" });
    d.feed({ type: "handshake_failed", failure: { kind: "refused", status: 404 } });
    expect(d.machine.error).toBeInstanceOf(NotFound);
  });

  test("13: the account's login changed: no history read, account_changed on the event", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, login: 1234 });
    d.answer("positions", []);
    d.answer("orders", []);
    expect(d.pendingRead().read.what).toBe("watched");
    d.answer("watched", null);
    expect(d.resyncs()[0]).toMatchObject({ history: null, history_reason: "account_changed" });
  });

  test.each(["backoff", "syncing"])("14: close() during %s stops at once", (state) => {
    const d = connectedLive();
    if (state === "backoff") d.feed({ type: "closed" });
    else d.message({ type: "lagged", missed: 1 });
    expect(d.state).toBe(state);
    d.clear();
    const out = d.feed({ type: "close" });
    expect(d.state).toBe("closed");
    expect(out).toContainEqual({ type: "ended" });
    expect(out).toContainEqual({ type: "cancel_timer", name: "backoff" });
    expect(d.feed({ type: "timer", name: "backoff" })).toEqual([]);
  });

  test("15: an order pending when the stream drops is looked up on resync, and seen events reach wait()", () => {
    const d = connectedLive();
    d.message({ type: "request", request: "req_1", state: "completed" });
    expect(d.has({ type: "request_seen" })).toBe(true);
    d.feed({ type: "closed" });
    d.feed({ type: "timer", name: "backoff" });
    d.subscribe();
    d.answerTicks();
    d.answer("account", ACCOUNT);
    d.answer("positions", []);
    d.answer("orders", []);
    d.answer("deals", []);
    d.answer("history_orders", []);
    // The resync waits for the watched requests' lookups before its event goes out.
    expect(d.pendingRead().read.what).toBe("watched");
    expect(d.state).toBe("syncing");
  });
});

describe("during a resync", () => {
  test("account events are dropped, ticks thinned to the newest per symbol, the rest held in order", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    d.message({ type: "account", balance: 1 });
    d.message({ type: "tick", symbol: "EURUSD", time_msc: 2 });
    d.message({ type: "deal", deal: { ticket: 1 } });
    d.message({ type: "tick", symbol: "EURUSD", time_msc: 1 });
    d.message({ type: "tick", symbol: "XAUUSD", time_msc: 1 });
    d.message({ type: "status", status: "connected" });
    d.completeResync();
    expect(d.drain().map((e) => [e.type, (e as { time_msc?: number }).time_msc])).toEqual([
      ["lagged", undefined],
      ["resync", undefined],
      ["deal", undefined],
      ["status", undefined],
      ["tick", 2],
      ["tick", 1],
    ]);
  });

  test("held events that overflow start the resync again, with reason overflow", () => {
    const d = connectedLive({ queueSize: 2 });
    d.message({ type: "lagged", missed: 1 });
    d.drain();
    d.message({ type: "deal", deal: { ticket: 1 } });
    d.message({ type: "deal", deal: { ticket: 2 } });
    const before = d.pendingRead("account").id;
    d.message({ type: "deal", deal: { ticket: 3 } });
    expect(d.pendingRead("account").id).not.toBe(before);
    d.completeResync();
    expect(d.resyncs()[0]?.reason).toBe("overflow");
  });

  test("history already delivered as deal events is left out of the history read back", () => {
    const d = connectedLive();
    d.message({ type: "account", server_time: ACCOUNT.server_time });
    d.message({ type: "deal", deal: { ticket: 10 } });
    d.drain();
    d.message({ type: "lagged", missed: 1 });
    d.completeResync({}, { deals: [{ ticket: 10 }, { ticket: 11 }] });
    expect(d.resyncs()[0]?.history?.deals).toEqual([{ ticket: 11 }]);
  });

  test("a range too large is split down to 60 s slices, then reported as range_too_large", () => {
    const d = connectedLive();
    d.message({ type: "account", server_time: ACCOUNT.server_time });
    d.drain();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", ACCOUNT);
    d.answer("positions", []);
    d.answer("orders", []);
    let reads = 0;
    let slice = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
    while (slice.to - slice.from + 1 > TIMING.smallestSliceS) {
      d.refuse("deals", err(RangeTooLarge, 422, "range_too_large"));
      slice = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
      reads += 1;
    }
    expect(reads).toBeGreaterThan(5);
    d.refuse("deals", err(RangeTooLarge, 422, "range_too_large"));
    d.answer("watched", null);
    expect(d.resyncs()[0]).toMatchObject({ history: null, history_reason: "range_too_large" });
  });

  test("broker time gone backwards: history is read from the lower of the two, less 300 s", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, server_time: ACCOUNT.server_time - 3600 });
    d.answer("positions", []);
    d.answer("orders", []);
    const deals = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
    expect(deals.from).toBe(ACCOUNT.server_time - 3600 - TIMING.historyMarginS);
  });

  test("with snapshot: false, the resync event carries only its reason", () => {
    const d = new Driver({ snapshot: false });
    d.feed({ type: "start" });
    d.subscribe();
    d.answerTicks();
    d.answer("watched", null);
    expect(d.resyncs()[0]).toEqual({
      type: "resync",
      reason: "connected",
      account: null,
      positions: null,
      orders: null,
      history: null,
      history_reason: null,
    });
  });
});

describe("keep-alive", () => {
  test("a ping every 20 s; a pong resets it; no pong within 10 s means the socket is dead", () => {
    const d = connectedLive();
    d.feed({ type: "timer", name: "ping" });
    expect(d.has({ type: "send", text: "ping" } as Partial<Action>)).toBe(true);
    expect(d.timer("pong")).toBe(TIMING.pongMs);
    d.feed({ type: "text", text: "pong" });
    expect(d.timer("ping")).toBe(TIMING.pingMs);
    d.feed({ type: "timer", name: "ping" });
    d.feed({ type: "timer", name: "pong" });
    expect(d.state).toBe("backoff");
  });
});

describe("ticks", () => {
  test("setTicks while live sends the whole set and settles when the API answers", () => {
    const d = connectedLive();
    d.feed({ type: "set_ticks", id: 1, symbols: ["EURUSD", "XAUUSD"] });
    expect(d.lastTicksCall()?.symbols).toEqual(["EURUSD", "XAUUSD"]);
    d.answerTicks();
    expect(d.actions).toContainEqual({ type: "ticks_settled", id: 1 });
  });

  test("a refused set (422 too_many_symbols) rejects that call and keeps the set the socket has", () => {
    const d = connectedLive();
    d.feed({ type: "set_ticks", id: 1, symbols: ["TOO", "MANY"] });
    d.answerTicks(422, { error: "too_many_symbols", message: "..." });
    const settled = d.actions.find((a) => a.type === "ticks_settled");
    expect(settled).toMatchObject({ id: 1, error: { code: "too_many_symbols", status: 422 } });
    expect(d.machine.ticks).toEqual(["EURUSD"]);
    expect(d.state).toBe("live");
  });

  test("a set the stream was opened with that the API refuses ends the stream", () => {
    const d = new Driver({ ticks: Array.from({ length: 101 }, (_, i) => `S${i}`) });
    d.feed({ type: "start" });
    d.subscribe();
    d.answerTicks(422, { error: "too_many_symbols", message: "..." });
    expect(d.state).toBe("failed");
    expect(d.machine.error).toMatchObject({ code: "too_many_symbols" });
  });

  test("setTicks during backoff is sent on the next socket, and settles then", () => {
    const d = connectedLive();
    d.feed({ type: "closed" });
    d.feed({ type: "set_ticks", id: 4, symbols: ["XAUUSD"] });
    expect(d.lastTicksCall()).toBeUndefined();
    d.feed({ type: "timer", name: "backoff" });
    d.subscribe();
    expect(d.lastTicksCall()?.symbols).toEqual(["XAUUSD"]);
    d.answerTicks();
    expect(d.actions).toContainEqual({ type: "ticks_settled", id: 4 });
    expect(d.pendingRead().read.what).toBe("account");
  });

  test("two quick setTicks calls: the second waits for the first's answer, then the latest set goes", () => {
    const d = connectedLive();
    d.feed({ type: "set_ticks", id: 1, symbols: ["A"] });
    d.feed({ type: "set_ticks", id: 2, symbols: ["B"] });
    expect(d.lastTicksCall()?.symbols).toEqual(["A"]);
    d.answerTicks();
    expect(d.lastTicksCall()?.symbols).toEqual(["B"]);
    d.answerTicks();
    expect(d.actions.filter((a) => a.type === "ticks_settled")).toEqual([
      { type: "ticks_settled", id: 1 },
      { type: "ticks_settled", id: 2 },
    ]);
  });
});

test("a read that fails for another reason is not fatal: 404 for a request id doesn't stop the stream", () => {
  const d = connectedLive();
  d.message({ type: "lagged", missed: 1 });
  d.answer("account", ACCOUNT);
  d.answer("positions", []);
  d.answer("orders", []);
  d.answer("deals", []);
  d.answer("history_orders", []);
  d.refuse("watched", err(NotFound, 404, "no_such_request"));
  expect(d.state).toBe("live");
});

describe("the checkpoint and what was delivered", () => {
  test("a deal dropped by overflow before the caller took it is not left out of the history read back", () => {
    const d = connectedLive({ queueSize: 2 });
    d.message({ type: "account", server_time: ACCOUNT.server_time });
    d.drain();
    d.message({ type: "deal", deal: { ticket: 41 } });
    d.message({ type: "tick", symbol: "EURUSD", time_msc: 1 });
    d.message({ type: "tick", symbol: "EURUSD", time_msc: 2 }); // overflows: the deal was never taken
    d.completeResync({}, { deals: [{ ticket: 41 }] });
    expect(d.resyncs()[0]?.history?.deals).toEqual([{ ticket: 41 }]);
  });

  test("a resync with the terminal unavailable leaves the checkpoint where it was", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, server_time: ACCOUNT.server_time + 4000 });
    d.refuse("positions", err(AccountUnavailable, 503, "account_not_connected"));
    d.answer("watched", null);
    d.drain();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, server_time: ACCOUNT.server_time + 5000 });
    d.answer("positions", []);
    d.answer("orders", []);
    const deals = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
    expect(deals.from).toBe(ACCOUNT.server_time - TIMING.historyMarginS);
  });

  test("a resync whose batch overflows doesn't move the checkpoint", () => {
    const d = connectedLive({ queueSize: 3 });
    d.message({ type: "lagged", missed: 1 });
    d.message({ type: "deal", deal: { ticket: 1 } });
    d.message({ type: "deal", deal: { ticket: 2 } });
    d.message({ type: "deal", deal: { ticket: 3 } });
    // lagged + resync + 3 held deals is more than the queue holds: the resync starts again.
    d.completeResync({ account: { ...ACCOUNT, server_time: ACCOUNT.server_time + 4000 } });
    expect(d.state).toBe("syncing");
    d.answer("account", { ...ACCOUNT, server_time: ACCOUNT.server_time + 5000 });
    d.answer("positions", []);
    d.answer("orders", []);
    const deals = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
    expect(deals.from).toBe(ACCOUNT.server_time - TIMING.historyMarginS);
  });

  test("a new login forgets the old one's tickets and checkpoint, even with the terminal unavailable", () => {
    const d = connectedLive();
    d.message({ type: "deal", deal: { ticket: 500 } });
    d.drain();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, login: 777 });
    d.refuse("positions", err(AccountUnavailable, 503, "account_not_connected"));
    d.answer("watched", null);
    expect(d.resyncs()[0]).toMatchObject({ history: null, history_reason: "account_changed" });
    d.message({ type: "account", server_time: ACCOUNT.server_time + 10 });
    d.drain();
    d.message({ type: "lagged", missed: 1 });
    d.completeResync({ account: { ...ACCOUNT, login: 777 } }, { deals: [{ ticket: 500 }] });
    expect(d.resyncs()[0]?.history?.deals).toEqual([{ ticket: 500 }]);
  });
});

describe("more transitions", () => {
  test("the terminal coming back during a resync that found it away starts another resync", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", ACCOUNT);
    d.refuse("positions", err(AccountUnavailable, 503, "account_not_connected"));
    d.message({ type: "status", status: "connected", detail: null });
    d.answer("watched", null);
    expect(d.state).toBe("syncing");
    expect(d.resyncs()).toHaveLength(1);
  });

  test("a refused set doesn't undo a newer one waiting behind it", () => {
    const d = connectedLive();
    d.feed({ type: "set_ticks", id: 1, symbols: ["A"] });
    d.feed({ type: "set_ticks", id: 2, symbols: ["B"] });
    d.answerTicks(422, { error: "invalid_request", message: "..." });
    expect(d.lastTicksCall()?.symbols).toEqual(["B"]);
    d.answerTicks();
    expect(d.machine.ticks).toEqual(["B"]);
    expect(d.actions.filter((a) => a.type === "ticks_settled").map((a) => [a.id, "error" in a])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  test("a ticks answer from before a reconnect is ignored", () => {
    const d = connectedLive();
    d.feed({ type: "set_ticks", id: 1, symbols: ["A"] });
    const stale = d.lastTicksCall();
    d.feed({ type: "closed" });
    d.feed({ type: "timer", name: "backoff" });
    d.subscribe();
    const fresh = d.lastTicksCall();
    expect(fresh?.id).not.toBe(stale?.id);
    expect(d.message({ type: "response", id: stale?.id, status: 200, body: { symbols: ["A"] } })).toEqual([]);
    expect(d.state).toBe("syncing");
  });

  test("a second subscribed message changes nothing", () => {
    const d = connectedLive();
    expect(d.message({ type: "subscribed", account: "acc_1" })).toEqual([]);
    expect(d.state).toBe("live");
  });

  test("a 401 on the probe while the host is away stops the helper", () => {
    const d = connectedLive();
    d.message({ type: "engine_disconnected" });
    d.feed({ type: "timer", name: "probe" });
    d.refuse("probe", err(AuthenticationError, 401, "invalid_api_key"));
    expect(d.state).toBe("failed");
  });

  test.each(["connecting", "host_away"])("close() while %s stops at once", (state) => {
    const d = state === "connecting" ? new Driver() : connectedLive();
    if (state === "connecting") d.feed({ type: "start" });
    else d.message({ type: "engine_disconnected" });
    const out = d.feed({ type: "close" });
    expect(d.state).toBe("closed");
    expect(out).toContainEqual({ type: "close_socket" });
    expect(out).toContainEqual({ type: "cancel_timer", name: "probe" });
  });

  test("a fatal error found outside the stream (a wait() lookup) stops it", () => {
    const d = connectedLive();
    d.feed({ type: "fatal", error: err(AuthenticationError, 401, "invalid_api_key") });
    expect(d.state).toBe("failed");
    expect(d.machine.error).toBeInstanceOf(AuthenticationError);
  });
});

describe("recovery that falls short", () => {
  test("history unavailable keeps the checkpoint, and the terminal coming back resyncs", () => {
    const d = connectedLive();
    d.message({ type: "account", server_time: ACCOUNT.server_time });
    d.drain();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, server_time: ACCOUNT.server_time + 10_000 });
    d.answer("positions", []);
    d.answer("orders", []);
    d.refuse("deals", err(AccountUnavailable, 503, "account_not_connected"));
    d.answer("watched", null);
    expect(d.resyncs()[0]).toMatchObject({ history: null, history_reason: "unavailable" });
    d.message({ type: "status", status: "connected", detail: null });
    expect(d.state).toBe("syncing");
    d.answer("account", { ...ACCOUNT, server_time: ACCOUNT.server_time + 20_000 });
    d.answer("positions", []);
    d.answer("orders", []);
    const deals = d.pendingRead("deals").read as Extract<Read, { what: "deals" }>;
    expect(deals.from).toBe(ACCOUNT.server_time - TIMING.historyMarginS);
  });

  test("events queued before a login change don't count as delivered for the new login", () => {
    const d = connectedLive();
    d.message({ type: "deal", deal: { ticket: 500 } }); // the old login's deal, not taken yet
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, login: 777 });
    d.answer("positions", []);
    d.answer("orders", []);
    d.answer("watched", null);
    d.drain();
    d.message({ type: "account", server_time: ACCOUNT.server_time });
    d.drain();
    d.message({ type: "lagged", missed: 1 });
    d.completeResync({ account: { ...ACCOUNT, login: 777 } }, { deals: [{ ticket: 500 }] });
    expect(d.resyncs()[0]?.history?.deals).toEqual([{ ticket: 500 }]);
  });

  test("a login change is still reported after the resync that saw it restarts", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    d.answer("account", { ...ACCOUNT, login: 777 });
    d.message({ type: "lagged", missed: 2 });
    d.completeResync({ account: { ...ACCOUNT, login: 777 } });
    expect(d.resyncs()[0]).toMatchObject({ history: null, history_reason: "account_changed" });
  });

  test("a 401 from a read already superseded still stops the helper", () => {
    const d = connectedLive();
    d.message({ type: "engine_disconnected" });
    d.feed({ type: "timer", name: "probe" });
    const probe = d.pendingRead("probe");
    d.message({ type: "deal", deal: { ticket: 1 } }); // the host is back: a resync starts
    d.completeResync();
    expect(d.state).toBe("live");
    d.feed({ type: "read_failed", id: probe.id, error: err(AuthenticationError, 401, "invalid_api_key") });
    expect(d.state).toBe("failed");
  });
});

describe("held events and fatal reads", () => {
  test("an event held under the old login keeps that login through a restart and a login change", () => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    d.message({ type: "deal", deal: { ticket: 500 } }); // held, under the old login
    d.message({ type: "lagged", missed: 2 });
    d.completeResync({ account: { ...ACCOUNT, login: 777 } });
    d.drain();
    d.message({ type: "account", server_time: ACCOUNT.server_time });
    d.drain();
    d.message({ type: "lagged", missed: 3 });
    d.completeResync({ account: { ...ACCOUNT, login: 777 } }, { deals: [{ ticket: 500 }] });
    expect(d.resyncs()[0]?.history?.deals).toEqual([{ ticket: 500 }]);
  });

  test.each([
    [401, "brand_new_code", "failed"],
    [401, null, "failed"],
    [404, "gone_for_good", "failed"],
    [404, "no_such_request", "syncing"],
  ])("a %i with code %s on a resync read: %s", (status, code, state) => {
    const d = connectedLive();
    d.message({ type: "lagged", missed: 1 });
    const error = new APIError({ status, code, body: code ? { error: code } : undefined, raw: "" });
    d.refuse("account", error);
    expect(d.state).toBe(state);
  });
});
