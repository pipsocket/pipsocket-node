// Runs every case in conformance/*.json through the real client, as conformance/README.md describes.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type Account, Pipsocket } from "../src/index.js";
import { ACCOUNT_ID, API_KEY, FakeClock, type Scripted, type ScriptedAnswer, ScriptedFetch } from "./support/fakes.js";

interface CaseFile {
  defaults: { max_retries: number; retry_deadline: number };
  calls: Record<string, { method: string; path: string; keyed: boolean; body?: unknown }>;
  bodies: Record<string, unknown>;
  cases: ConformanceCase[];
}

interface ConformanceCase {
  id: string;
  title: string;
  call: string;
  options?: { max_retries?: number; retry_deadline?: number };
  idempotency_key?: string;
  attempts: Array<
    (
      | {
          respond: {
            status: number;
            headers?: Record<string, string>;
            body?: unknown;
            text?: string;
            body_error?: true;
          };
        }
      | { fail: "connect" | "after_write" }
    ) & {
      elapsed?: number;
    }
  >;
  expect: {
    attempts: number;
    sleeps?: Array<{ min?: number; max?: number }>;
    return?: { trade_request?: Record<string, unknown>; json?: unknown; json_has?: string[] };
    raise?: Record<string, unknown> & { error: string };
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function load(path: string): CaseFile | undefined {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? (JSON.parse(readFileSync(url, "utf8")) as CaseFile) : undefined;
}

const shared = load("../conformance/call-cases.json");
const extraFile = load("../conformance/extra-cases.json");
// The extra cases use the shared file's defaults, calls and bodies, adding their own if they have any.
const extra: CaseFile | undefined =
  extraFile && shared
    ? {
        ...extraFile,
        defaults: extraFile.defaults ?? shared.defaults,
        calls: { ...shared.calls, ...extraFile.calls },
        bodies: { ...shared.bodies, ...extraFile.bodies },
      }
    : extraFile;

/** How each named call is made through the client. */
const ORDER = { symbol: "EURUSD", type: "buy", volume: 0.1, type_filling: "ioc", sl: 1.079 } as const;
const keyed = (key: string | undefined) => (key === undefined ? {} : { idempotencyKey: key });

const CALLS: Record<string, (acct: Account, key: string | undefined) => Promise<unknown>> = {
  place_order: (acct, key) => acct.orders.place(ORDER, keyed(key)),
  cancel_order: (acct, key) => acct.orders.cancel(881402377, keyed(key)),
  check_order: (acct) => acct.orders.check(ORDER),
  engage_kill_switch: (acct) => acct.killSwitch.engage(),
  get_request: (acct) => acct.requests.get("req_5f0c2a9e41d7b3a8c6e2f190"),
  list_positions: (acct) => acct.positions.list(),
  list_symbols: (acct) => acct.symbols.list(),
  get_tick: (acct) => acct.symbols.tick("EURUSD"),
  history_deals: (acct) => acct.history.deals({ from: 1794009600, to: 1794095999 }),
};

/** Replaces `{"use": name}` with the named body. */
function resolve(file: CaseFile, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "use") return file.bodies[(value as { use: string }).use];
  }
  return value;
}

function script(file: CaseFile, c: ConformanceCase): Scripted[] {
  return c.attempts.map((a) => {
    const answer: ScriptedAnswer =
      "fail" in a ? { fail: a.fail } : { respond: { ...a.respond, body: resolve(file, a.respond.body) } };
    const step: Scripted = { answer };
    if (a.elapsed !== undefined) step.elapsedMs = a.elapsed * 1000;
    return step;
  });
}

const ERROR_NAMES: Record<string, string> = { ArgumentError: "TypeError" };

async function run(file: CaseFile, c: ConformanceCase): Promise<void> {
  const call = file.calls[c.call];
  const make = CALLS[c.call];
  if (!call || !make) throw new Error(`No way to make the call ${c.call}`);
  const settings = { ...file.defaults, ...c.options };
  const clock = new FakeClock();
  const fake = new ScriptedFetch(script(file, c), clock);
  const client = new Pipsocket({
    apiKey: API_KEY,
    maxRetries: settings.max_retries,
    retryDeadlineMs: settings.retry_deadline * 1000,
    fetch: fake.fetch,
    clock,
    random: () => 0.5,
  });

  let returned: unknown;
  let raised: unknown;
  let threw = false;
  try {
    returned = await make(client.account(ACCOUNT_ID), c.idempotency_key);
  } catch (error) {
    threw = true;
    raised = error;
  }

  expect(fake.overrun, "the client made more attempts than the script has").toBe(false);
  expect(fake.sent).toHaveLength(c.expect.attempts);

  // Every attempt is the same method, URL and body.
  const url = `https://api.pipsocket.com/v1/accounts/${ACCOUNT_ID}${call.path}`;
  for (const sent of fake.sent) {
    expect(sent.method).toBe(call.method);
    expect(sent.url).toBe(url);
    expect(sent.body === undefined ? undefined : JSON.parse(sent.body)).toEqual(call.body);
  }
  const keys = fake.sent.map((sent) => sent.headers["idempotency-key"]);
  let key: string | undefined;
  if (call.keyed && fake.sent.length > 0) {
    key = keys[0];
    expect(new Set(keys).size, "every attempt carries the same Idempotency-Key").toBe(1);
    if (c.idempotency_key !== undefined) expect(key).toBe(c.idempotency_key);
    else expect(key).toMatch(UUID);
  } else {
    for (const k of keys) expect(k).toBeUndefined();
  }

  if (c.expect.sleeps) {
    expect(clock.sleeps).toHaveLength(c.expect.sleeps.length);
    c.expect.sleeps.forEach((range, i) => {
      const seconds = (clock.sleeps[i] ?? Number.NaN) / 1000;
      if (range.min !== undefined) expect(seconds).toBeGreaterThanOrEqual(range.min);
      if (range.max !== undefined) expect(seconds).toBeLessThanOrEqual(range.max);
    });
  }

  if (c.expect.return) {
    if (threw) throw raised;
    const expected = c.expect.return;
    if (expected.trade_request) checkTradeRequest(returned, expected.trade_request, call.keyed ? key : undefined);
    if (expected.json !== undefined) expect(returned).toEqual(resolve(file, expected.json));
    if (expected.json_has) expect(Object.keys(returned as object)).toEqual(expect.arrayContaining(expected.json_has));
  }
  if (c.expect.raise) {
    expect(threw, "the call should have raised").toBe(true);
    checkRaised(raised, c.expect.raise, call.keyed ? key : undefined);
  }
}

function checkTradeRequest(value: unknown, fields: Record<string, unknown>, key: string | undefined): void {
  const request = value as Record<string, unknown> & { result?: Record<string, unknown> };
  for (const [name, want] of Object.entries(fields)) {
    switch (name) {
      case "http_status":
        expect(request.httpStatus).toBe(want);
        break;
      case "idempotency_key":
        expect(request.idempotencyKey).toBe(want);
        break;
      case "retcode":
      case "retcode_name":
        expect(request.result?.[name]).toBe(want);
        break;
      default:
        expect(request[name], name).toBe(want);
    }
  }
  // The answer to a keyed call always carries the key it sent.
  if (key !== undefined) expect(request.idempotencyKey).toBe(key);
}

function checkRaised(error: unknown, fields: Record<string, unknown> & { error: string }, key: string | undefined) {
  const e = error as Record<string, unknown> & { name: string; cause?: Record<string, unknown> & { name: string } };
  expect(e.name).toBe(ERROR_NAMES[fields.error] ?? fields.error);
  for (const [name, want] of Object.entries(fields)) {
    switch (name) {
      case "error":
        break;
      case "code":
      case "status":
        expect(e[name], name).toBe(want);
        break;
      case "cause":
        expect(e.cause?.name).toBe(want);
        break;
      case "cause_code":
        expect(e.cause?.code).toBe(want);
        break;
      case "retry_after":
        expect(e.retryAfter).toBe(want);
        break;
      case "blocking":
        expect((e.blocking as Array<{ request: string }>).map((b) => b.request)).toEqual(want);
        break;
      case "kill_switch":
        expect(e.killSwitch).toMatchObject(want as object);
        break;
      case "idempotency_key":
        expect(e.idempotencyKey).toBe(want);
        break;
      default:
        throw new Error(`The runner doesn't know the field raise.${name}`);
    }
  }
  // Every error the SDK raises from a keyed call carries the key it sent.
  if (key !== undefined && fields.error !== "ArgumentError") expect(e.idempotencyKey).toBe(key);
}

for (const [label, file] of [
  ["call-cases.json", shared],
  ["extra-cases.json", extra],
] as const) {
  if (!file) continue;
  describe(label, () => {
    for (const c of file.cases) {
      const name = `${c.id}: ${c.title}`;
      test(name, () => run(file, c));
    }
  });
}

test("the shared and extra cases are present", () => {
  expect(shared?.cases.length).toBeGreaterThan(0);
  expect(extra?.cases.length).toBeGreaterThan(0);
});
