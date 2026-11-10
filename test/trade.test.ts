// Trade calls: keys, cancellation, requests.wait, and the transitions of a trade request that the
// shared conformance cases don't already pin down.

import { describe, expect, test } from "vitest";
import {
  AuthenticationError,
  type Clock,
  isAccepted,
  isFinal,
  isOutstanding,
  NotFound,
  newKey,
  OutcomeUnknown,
  Pipsocket,
  TradeNotAccepted,
  throwForState,
  toTradeRequest,
} from "../src/index.js";
import {
  ACCOUNT_ID,
  API_KEY,
  FakeClock,
  hangUntilAborted,
  networkError,
  type Scripted,
  ScriptedFetch,
} from "./support/fakes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORDER = { symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "ioc" } as const;

function recorded(state: string, extra: Record<string, unknown> = {}) {
  return { request: "req_1", state, sent: {}, result: null, message: "...", ...extra };
}
const answer = (status: number, body: unknown) => ({ answer: { respond: { status, body } } });
const lost: Scripted = { answer: { fail: "after_write" } };
const unavailable = answer(503, { error: "engine_unavailable", message: "..." });

function setUp(script: Scripted[], clock: Clock = new FakeClock()) {
  const fake = new ScriptedFetch(script, clock instanceof FakeClock ? clock : undefined);
  const acct = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, clock, random: () => 0.5 }).account(ACCOUNT_ID);
  return { fake, acct };
}

describe("idempotency keys", () => {
  test("each call makes its own key, and every attempt of a call sends it", async () => {
    const { fake, acct } = setUp([unavailable, answer(200, recorded("completed")), answer(200, recorded("completed"))]);
    const first = await acct.orders.place(ORDER);
    const second = await acct.orders.place(ORDER);
    const keys = fake.sent.map((s) => s.headers["idempotency-key"]);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(first.idempotencyKey).toBe(keys[0]);
    expect(second.idempotencyKey).toBe(keys[2]);
  });

  test("a key made with newKey() before sending is the one sent, and survives a lost answer", async () => {
    const key = newKey();
    expect(key).toMatch(UUID);
    const { fake, acct } = setUp([lost, lost, lost]);
    const error = await acct.orders.place(ORDER, { idempotencyKey: key }).catch((e) => e);
    expect(error).toBeInstanceOf(OutcomeUnknown);
    expect(error.idempotencyKey).toBe(key);
    expect(fake.sent.every((s) => s.headers["idempotency-key"] === key)).toBe(true);
  });

  test.each([
    ["a space at the start", " key"],
    ["a space at the end", "key "],
    ["a character outside ASCII", "clé"],
  ])("a key with %s is refused before anything is sent", async (_label, key) => {
    const { fake, acct } = setUp([]);
    await expect(acct.orders.place(ORDER, { idempotencyKey: key })).rejects.toThrow(TypeError);
    expect(fake.sent).toHaveLength(0);
  });

  test("a key of exactly 128 characters, with a space inside, is sent as it is", async () => {
    const key = `a b${"c".repeat(125)}`;
    const { fake, acct } = setUp([answer(200, recorded("completed"))]);
    await acct.orders.cancel(5, { idempotencyKey: key });
    expect(fake.sent[0]?.headers["idempotency-key"]).toBe(key);
  });

  test("a ticket that isn't a whole number is refused before anything is sent", async () => {
    const { fake, acct } = setUp([]);
    await expect(acct.positions.close(1.5, { volume: 0.01, type_filling: "ioc" })).rejects.toThrow(TypeError);
    await expect(acct.orders.cancel(-1)).rejects.toThrow(TypeError);
    expect(fake.sent).toHaveLength(0);
  });
});

describe("what a custom fetch can and can't prove", () => {
  test("its failures count as possibly sent unless it marks them: it may have retried inside", async () => {
    const { acct } = setUp([{ answer: () => Promise.reject(networkError("ECONNREFUSED")) }]);
    const error = await acct.orders.place(ORDER, { maxRetries: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(OutcomeUnknown);
  });

  test("a response whose body can't be read counts as possibly sent, never as a cancellation", async () => {
    const locked = () => {
      const response = Response.json(recorded("completed"));
      response.body?.getReader();
      return response;
    };
    const { fake, acct } = setUp([{ answer: locked }, { answer: locked }, { answer: locked }]);
    const error = await acct.orders.place(ORDER).catch((e) => e);
    expect(error).toBeInstanceOf(OutcomeUnknown);
    expect(error.cause).toMatchObject({ status: 200 });
    expect(fake.sent).toHaveLength(3);
  });
});

describe("the key on errors", () => {
  test("a refusal that sent nothing still carries the key the call sent", async () => {
    const { fake, acct } = setUp([answer(423, { error: "kill_switch_engaged", message: "..." })]);
    const error = await acct.orders.place(ORDER).catch((e) => e);
    expect(error.name).toBe("KillSwitchEngaged");
    expect(error.idempotencyKey).toBe(fake.sent[0]?.headers["idempotency-key"]);
  });
});

describe("cancelling a trade call", () => {
  test("an Error reason passes through unchanged, carrying the key; nothing more is sent", async () => {
    const controller = new AbortController();
    const reason = new Error("shutting down");
    const { fake, acct } = setUp([
      {
        answer: () => {
          controller.abort(reason);
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        },
      },
      answer(200, recorded("completed")),
    ]);
    const error = await acct.orders.place(ORDER, { signal: controller.signal }).catch((e) => e);
    expect(error).toBe(reason);
    expect(error.idempotencyKey).toBe(fake.sent[0]?.headers["idempotency-key"]);
    expect(fake.sent).toHaveLength(1);
  });

  test.each([
    ["a string", () => "shutting down"],
    ["a frozen object", () => Object.freeze({ why: "shutting down" })],
  ])("%s reason passes through unchanged", async (_label, make) => {
    const reason = make();
    const controller = new AbortController();
    const { fake, acct } = setUp([
      {
        answer: () => {
          controller.abort(reason);
          return Response.json(recorded("completed"));
        },
      },
    ]);
    await expect(acct.orders.place(ORDER, { signal: controller.signal })).rejects.toBe(reason);
    expect(fake.sent).toHaveLength(1);
  });

  test("during the wait before a retry: the reason passes through and the retry is never sent", async () => {
    const controller = new AbortController();
    const clock: Clock = {
      now: () => 0,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
          controller.abort("stop");
        }),
    };
    const { fake, acct } = setUp([lost, answer(200, recorded("completed"))], clock);
    await expect(acct.orders.place(ORDER, { signal: controller.signal })).rejects.toBe("stop");
    expect(fake.sent).toHaveLength(1);
  });
});

describe("TradeRequest", () => {
  const cases: Array<[string, { accepted: boolean; final: boolean; outstanding: boolean; throws: boolean }]> = [
    ["completed", { accepted: true, final: true, outstanding: false, throws: false }],
    ["placed", { accepted: true, final: true, outstanding: false, throws: false }],
    ["partial", { accepted: true, final: true, outstanding: false, throws: false }],
    ["rejected", { accepted: false, final: true, outstanding: false, throws: true }],
    ["not_sent", { accepted: false, final: true, outstanding: false, throws: true }],
    ["not_executed", { accepted: false, final: true, outstanding: false, throws: true }],
    ["executed", { accepted: false, final: true, outstanding: false, throws: false }],
    ["pending", { accepted: false, final: false, outstanding: true, throws: false }],
    ["unknown", { accepted: false, final: false, outstanding: true, throws: false }],
    ["superseded", { accepted: false, final: false, outstanding: false, throws: false }],
  ];

  test.each(cases)("%s", (state, want) => {
    const request = toTradeRequest({ type: "request", ...recorded(state) });
    expect(request.kind).toBe(state === "superseded" ? "unrecognised" : state);
    expect(request.state).toBe(state);
    expect(request.idempotencyKey).toBeUndefined();
    expect(request.httpStatus).toBeUndefined();
    expect(isAccepted(request)).toBe(want.accepted);
    expect(isFinal(request)).toBe(want.final);
    expect(isOutstanding(request)).toBe(want.outstanding);
    if (want.throws) {
      const error = (() => {
        try {
          throwForState(request);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(TradeNotAccepted);
      expect((error as TradeNotAccepted).request).toBe(request);
    } else {
      expect(throwForState(request)).toBe(request);
    }
  });

  test("toTradeRequest refuses a message that isn't a recorded request", () => {
    expect(() => toTradeRequest({ type: "deal", deal: {} })).toThrow(TypeError);
  });
});

describe("requests.wait", () => {
  test("polls at 0.25 s growing by 1.5 times, until the request is final ", async () => {
    const clock = new FakeClock();
    const { fake, acct } = setUp(
      [
        answer(200, recorded("pending")),
        answer(200, recorded("pending")),
        answer(200, recorded("pending")),
        answer(200, recorded("completed")),
      ],
      clock,
    );
    const request = await acct.requests.wait("req_1");
    expect(request.kind).toBe("completed");
    expect(clock.sleeps).toEqual([250, 375, 562.5]);
    expect(fake.sent.every((s) => s.method === "GET" && s.url.endsWith("/requests/req_1"))).toBe(true);
  });

  test("returns the request as it stands at the timeout, unknown included, without throwing ", async () => {
    const clock = new FakeClock();
    const pendingThenUnknown: Scripted[] = Array.from({ length: 40 }, (_, i) =>
      answer(200, recorded(i < 3 ? "pending" : "unknown")),
    );
    const { fake, acct } = setUp(pendingThenUnknown, clock);
    const request = await acct.requests.wait("req_1", { timeoutMs: 10_000 });
    expect(request.kind).toBe("unknown");
    expect(clock.now()).toBe(10_000);
    expect(Math.max(...clock.sleeps)).toBe(2000);
    expect(fake.overrun).toBe(false);
  });

  test("keeps polling through 503s while the host is away ", async () => {
    const { acct } = setUp([
      answer(200, recorded("pending")),
      unavailable,
      unavailable,
      answer(200, recorded("rejected")),
    ]);
    await expect(acct.requests.wait("req_1")).resolves.toMatchObject({ kind: "rejected" });
  });

  test.each([
    [401, "invalid_api_key", AuthenticationError],
    [404, "no_such_request", NotFound],
  ])("a %i stops it", async (status, code, kind) => {
    const { acct } = setUp([answer(200, recorded("pending")), answer(status, { error: code, message: "..." })]);
    await expect(acct.requests.wait("req_1")).rejects.toThrow(kind);
  });

  test("stops at its timeout: a lookup is bounded by the time left, and none starts after it", async () => {
    const fake = new ScriptedFetch([{ answer: answer(200, recorded("pending")).answer }, { answer: hangUntilAborted }]);
    const acct = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch }).account(ACCOUNT_ID);
    const started = performance.now();
    const request = await acct.requests.wait("req_1", { timeoutMs: 300 });
    expect(request.kind).toBe("pending");
    expect(performance.now() - started).toBeLessThan(600);
    expect(fake.overrun).toBe(false);
  });

  test("with no answer at all before the timeout, throws the last failure", async () => {
    const clock = new FakeClock();
    const { acct } = setUp(
      Array.from({ length: 20 }, () => unavailable),
      clock,
    );
    await expect(acct.requests.wait("req_1", { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "engine_unavailable",
    });
  });
});

describe("a trade request's transitions", () => {
  test("answered within 5 s, the request comes back in its state", async () => {
    const { acct } = setUp([answer(200, recorded("partial"))]);
    await expect(acct.orders.place(ORDER)).resolves.toMatchObject({ kind: "partial", httpStatus: 200 });
  });

  test.each(["pending", "unknown", "rejected", "not_sent", "executed"])(
    "after a lost answer, the retry returns the request in any state (%s)",
    async (state) => {
      const status = { pending: 202, unknown: 202, rejected: 422, not_sent: 503, executed: 200 }[state] ?? 200;
      const { fake, acct } = setUp([lost, answer(status, recorded(state))]);
      const request = await acct.orders.place(ORDER);
      expect(request.state).toBe(state);
      expect(request.idempotencyKey).toBe(fake.sent[0]?.headers["idempotency-key"]);
    },
  );

  test("an unknown request that settles later is returned by wait once a lookup shows it", async () => {
    const { acct } = setUp([
      answer(200, recorded("unknown")),
      answer(200, recorded("unknown")),
      answer(200, recorded("not_executed", { settlement: "evidence" })),
    ]);
    await expect(acct.requests.wait("req_1")).resolves.toMatchObject({ kind: "not_executed", settlement: "evidence" });
  });

  test("two calls in flight with one key: each sends that key, and both get the one recorded request", async () => {
    const key = newKey();
    const { fake, acct } = setUp([answer(202, recorded("pending")), answer(202, recorded("pending"))]);
    const [first, second] = await Promise.all([
      acct.orders.place(ORDER, { idempotencyKey: key }),
      acct.orders.place(ORDER, { idempotencyKey: key }),
    ]);
    expect(fake.sent.map((s) => s.headers["idempotency-key"])).toEqual([key, key]);
    expect(first.id).toBe(second.id);
  });

  test("a key reused with a different order: the order is sent as given, and the first request comes back as it is", async () => {
    const key = newKey();
    const firstOrder = recorded("completed", { sent: { symbol: "EURUSD", volume: 0.01 } });
    const { fake, acct } = setUp([answer(200, firstOrder)]);
    const request = await acct.orders.place({ ...ORDER, volume: 0.5 }, { idempotencyKey: key });
    expect(JSON.parse(fake.sent[0]?.body ?? "{}").volume).toBe(0.5);
    expect(request.sent).toEqual({ symbol: "EURUSD", volume: 0.01 });
    expect(request.idempotencyKey).toBe(key);
  });

  test("after a crash: a new client with the saved key gets the request the lost attempt recorded", async () => {
    const recordedByKey = new Map<string, unknown>();
    const server = (request: { headers: Record<string, string> }) => {
      const key = request.headers["idempotency-key"] ?? "";
      if (!recordedByKey.has(key)) recordedByKey.set(key, recorded("completed"));
      return Response.json(recordedByKey.get(key));
    };
    // The host records the trade, then the answer is lost, every time.
    const recordThenLose = (request: { headers: Record<string, string> }) => {
      server(request);
      return Promise.reject(networkError("ECONNRESET"));
    };
    const first = setUp([{ answer: recordThenLose }, { answer: recordThenLose }, { answer: recordThenLose }]);
    const lost = await first.acct.orders.place(ORDER).catch((e) => e);
    expect(lost).toBeInstanceOf(OutcomeUnknown);
    const second = setUp([{ answer: server }]);
    const request = await second.acct.orders.place(ORDER, { idempotencyKey: lost.idempotencyKey });
    expect(request).toMatchObject({ kind: "completed", idempotencyKey: lost.idempotencyKey });
    expect(recordedByKey.size).toBe(1);
  });

  test("a lost answer, then 404 on a close: OutcomeUnknown, never NotFound", async () => {
    const { acct } = setUp([lost, answer(404, { error: "no_such_position", message: "..." })]);
    const error = await acct.positions.close(9, { volume: 0.01, type_filling: "ioc" }).catch((e) => e);
    expect(error).toBeInstanceOf(OutcomeUnknown);
    expect(error.cause).toBeInstanceOf(NotFound);
  });

  test("with no lost answer before it, a 423 is a refusal: nothing was sent", async () => {
    const { acct } = setUp([answer(423, { error: "kill_switch_engaged", message: "..." })]);
    const error = await acct.orders.modify(7, { price: 1, sl: 0, tp: 0, type_time: "gtc" }).catch((e) => e);
    expect(error.name).toBe("KillSwitchEngaged");
  });

  test("wait returns the first final state it sees, and looks no further", async () => {
    const { fake, acct } = setUp([answer(200, recorded("completed")), answer(200, recorded("pending"))]);
    await expect(acct.requests.wait("req_1")).resolves.toMatchObject({ kind: "completed" });
    expect(fake.sent).toHaveLength(1);
  });

  test("blocked by an earlier request: retried after Retry-After, then the blocker turns unknown", async () => {
    const busy = (headers?: Record<string, string>) => ({
      answer: {
        respond: {
          status: 409,
          ...(headers ? { headers } : {}),
          body: {
            error: "symbol_busy",
            message: "...",
            not_sent: true,
            blocking: [{ request: "req_0", state: "unknown" }],
          },
        },
      },
    });
    const clock = new FakeClock();
    const { acct } = setUp([busy({ "Retry-After": "1" }), busy()], clock);
    const error = await acct.positions.setLevels(9, { sl: 1, tp: 2 }).catch((e) => e);
    expect(error.name).toBe("SymbolBusy");
    expect(error.blocking).toEqual([{ request: "req_0", state: "unknown" }]);
    expect(clock.sleeps).toEqual([1000]);
  });

  test("the terminal vanishes between check and send: a not_sent request comes back", async () => {
    const body = recorded("not_sent", { error: "not_sent", result: { error: "not_welcomed", message: "..." } });
    const { acct } = setUp([answer(503, body)]);
    const request = await acct.positions.closeBy(9, { position_by: 10 });
    expect(request.kind).toBe("not_sent");
    if (request.kind === "not_sent") expect(request.result.error).toBe("not_welcomed");
  });

  test("the SDK never reuses a key across calls by itself", async () => {
    const { fake, acct } = setUp([answer(200, recorded("completed")), answer(200, recorded("completed"))]);
    await acct.orders.place(ORDER);
    await acct.orders.place(ORDER);
    expect(fake.sent[0]?.headers["idempotency-key"]).not.toBe(fake.sent[1]?.headers["idempotency-key"]);
  });
});
