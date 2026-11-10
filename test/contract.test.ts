// The SDK against the document: every operation has a method, every error code a policy, every
// request state a kind, and the generated code matches the snapshot.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { OPERATIONS, REQUEST_STATES } from "../src/generated/tables.js";
import type { Account } from "../src/index.js";
import { ERROR_STATUS, isFinal, isOutstanding, Pipsocket, toTradeRequest, VERSION } from "../src/index.js";
import { CODE_POLICIES } from "../src/policy.js";
import { ACCOUNT_ID, API_KEY, ScriptedFetch } from "./support/fakes.js";

const REQUEST = {
  request: "req_5f0c2a9e41d7b3a8c6e2f190",
  state: "completed",
  sent: {},
  result: null,
  message: "...",
};

/** Each operation's SDK method, called with arguments that fill the document's path. */
const ORDER = { symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "ioc" } as const;
const MODIFY = { price: 1.05, sl: 1.04, tp: 1.07, type_time: "gtc" } as const;

interface Method {
  call: (acct: Account) => Promise<unknown>;
  path: string;
  answer?: unknown;
  body?: unknown;
  /** Takes an Idempotency-Key. */
  keyed?: boolean;
}

const METHODS: Record<string, Method> = {
  account: { call: (a) => a.get(), path: "" },
  positions: { call: (a) => a.positions.list(), path: "/positions" },
  pending_orders: { call: (a) => a.orders.list(), path: "/orders" },
  request: { call: (a) => a.requests.get("req_1"), path: "/requests/req_1", answer: REQUEST },
  history_deals: { call: (a) => a.history.deals({ from: 10, to: 20 }), path: "/history/deals?from=10&to=20" },
  history_orders: { call: (a) => a.history.orders({ from: 10, to: 20 }), path: "/history/orders?from=10&to=20" },
  symbols: { call: (a) => a.symbols.list(), path: "/symbols" },
  symbol: { call: (a) => a.symbols.get("EURUSD"), path: "/symbols/EURUSD" },
  tick: { call: (a) => a.symbols.tick("EURUSD"), path: "/symbols/EURUSD/tick" },
  kill_switch: { call: (a) => a.killSwitch.get(), path: "/kill-switch" },
  place_order: { call: (a) => a.orders.place(ORDER), path: "/orders", answer: REQUEST, body: ORDER, keyed: true },
  check_order: { call: (a) => a.orders.check(ORDER), path: "/orders/check", body: ORDER },
  modify_order: {
    call: (a) => a.orders.modify(7, MODIFY),
    path: "/orders/7",
    answer: REQUEST,
    body: MODIFY,
    keyed: true,
  },
  cancel_order: { call: (a) => a.orders.cancel(7), path: "/orders/7", answer: REQUEST, keyed: true },
  set_position_levels: {
    call: (a) => a.positions.setLevels(9, { sl: 1.07, tp: 1.1 }),
    path: "/positions/9",
    answer: REQUEST,
    body: { sl: 1.07, tp: 1.1 },
    keyed: true,
  },
  close_position: {
    call: (a) => a.positions.close(9, { volume: 0.01, type_filling: "ioc" }),
    path: "/positions/9/close",
    answer: REQUEST,
    body: { volume: 0.01, type_filling: "ioc" },
    keyed: true,
  },
  close_by: {
    call: (a) => a.positions.closeBy(9, { position_by: 10 }),
    path: "/positions/9/close-by",
    answer: REQUEST,
    body: { position_by: 10 },
    keyed: true,
  },
  engage_kill_switch: {
    call: (a) => a.killSwitch.engage({ deviation: 20 }),
    path: "/kill-switch",
    body: { deviation: 20 },
  },
  lift_kill_switch: { call: (a) => a.killSwitch.lift(), path: "/kill-switch" },
};

describe("every operation in the document has an SDK method", () => {
  test("no operation is missing from the method table", () => {
    const missing = OPERATIONS.map((op) => op.operationId).filter((id) => !(id in METHODS));
    expect(missing).toEqual([]);
  });

  for (const op of OPERATIONS.filter((o) => o.operationId in METHODS)) {
    test(`${op.operationId}: ${op.method} ${op.path}`, async () => {
      const method = METHODS[op.operationId];
      if (!method) throw new Error("unreachable");
      const answer = method.answer ?? { ok: true };
      const fake = new ScriptedFetch([{ answer: { respond: { status: 200, body: answer } } }]);
      const acct = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch }).account(ACCOUNT_ID);
      await method.call(acct);
      const sent = fake.sent[0];
      expect(sent?.method).toBe(op.method);
      expect(sent?.body === undefined ? undefined : JSON.parse(sent.body)).toEqual(method.body);
      // The calls the document gives an Idempotency-Key header are the ones that send one.
      expect(method.keyed ?? false).toBe(op.keyed);
      expect(sent?.headers["idempotency-key"] !== undefined).toBe(op.keyed);
      expect(sent?.url).toBe(`https://api.pipsocket.com/v1/accounts/${ACCOUNT_ID}${method.path}`);
      // The path the method sends fits the document's template for this operation.
      const template = new RegExp(`^${op.path.replace(/\{[a-z]+\}/g, "[^/?]+")}(\\?.*)?$`);
      expect(new URL(sent?.url ?? "").pathname + new URL(sent?.url ?? "").search).toMatch(template);
    });
  }
});

test("every error code in the document has an error and a retry policy", () => {
  const missing = Object.keys(ERROR_STATUS).filter((code) => !Object.hasOwn(CODE_POLICIES, code));
  expect(missing).toEqual([]);
});

test("every request state in the document has its own kind, final or outstanding", () => {
  for (const state of REQUEST_STATES) {
    const request = toTradeRequest({ ...REQUEST, state });
    expect(request.kind).toBe(state);
    expect(isFinal(request) !== isOutstanding(request)).toBe(true);
  }
});

test("the generated code matches the snapshot", () => {
  execFileSync(process.execPath, ["scripts/generate.mjs", "--check"], { stdio: "pipe" });
});

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(VERSION).toBe(pkg.version);
});
