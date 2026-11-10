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
const METHODS: Record<string, { call: (acct: Account) => Promise<unknown>; path: string; answer?: unknown }> = {
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
};

// Trade calls, check and the kill switch's engage and lift arrive in the next milestone.
const NOT_YET = new Set([
  "place_order",
  "check_order",
  "cancel_order",
  "modify_order",
  "set_position_levels",
  "close_position",
  "close_by",
  "engage_kill_switch",
  "lift_kill_switch",
]);

describe("every operation in the document has an SDK method", () => {
  test("no operation is missing from the method table", () => {
    const missing = OPERATIONS.map((op) => op.operationId).filter((id) => !(id in METHODS) && !NOT_YET.has(id));
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
