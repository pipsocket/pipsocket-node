import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  APIError,
  APITimeoutError,
  type Clock,
  NotFound,
  Pipsocket,
  PipsocketError,
  Unavailable,
  VERSION,
} from "../src/index.js";
import { ACCOUNT_ID, API_KEY, FakeClock, hangUntilAborted, ScriptedFetch } from "./support/fakes.js";

const unavailable = { respond: { status: 503, body: { error: "engine_unavailable", message: "..." } } } as const;
const ok = (body: unknown = []) => ({ respond: { status: 200, body } }) as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("constructing the client", () => {
  test("reads the key from PIPSOCKET_KEY", async () => {
    vi.stubEnv("PIPSOCKET_KEY", API_KEY);
    const fake = new ScriptedFetch([{ answer: ok() }]);
    await new Pipsocket({ fetch: fake.fetch }).account(ACCOUNT_ID).positions.list();
    expect(fake.sent[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("refuses to start without a key", () => {
    vi.stubEnv("PIPSOCKET_KEY", "");
    expect(() => new Pipsocket()).toThrow(PipsocketError);
  });

  test("refuses to run in a browser, and says why", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => new Pipsocket({ apiKey: API_KEY })).toThrow(/browser.*cross-origin/);
  });

  test.each([
    ["a line break", `${API_KEY}\nX-Other: 1`],
    ["a space", `${API_KEY} `],
  ])("refuses a key with %s, without showing it", (_label, key) => {
    const error = (() => {
      try {
        new Pipsocket({ apiKey: key });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(PipsocketError);
    expect(inspect(error, { showHidden: true, depth: 5 })).not.toContain(API_KEY);
  });

  test("never shows the key when the client is printed", () => {
    const client = new Pipsocket({ apiKey: API_KEY });
    expect(inspect(client, { showHidden: true, depth: 5 })).not.toContain(API_KEY);
    expect(JSON.stringify(client)).not.toContain(API_KEY);
    expect(inspect(client.account(ACCOUNT_ID), { showHidden: true, depth: 5 })).not.toContain(API_KEY);
  });

  test("an account handle needs an id", () => {
    expect(() => new Pipsocket({ apiKey: API_KEY }).account("")).toThrow(TypeError);
  });
});

describe("what each call sends", () => {
  test("the key, a User-Agent naming the SDK and runtime, and JSON", async () => {
    const fake = new ScriptedFetch([{ answer: ok({}) }]);
    await new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch }).account(ACCOUNT_ID).get();
    const headers = fake.sent[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["user-agent"]).toMatch(
      new RegExp(`^pipsocket-node/${VERSION.replaceAll(".", "\\.")} (node|bun|deno)/\\d`),
    );
    expect(headers.accept).toBe("application/json");
    expect(headers["idempotency-key"]).toBeUndefined();
  });

  test("names in the path are escaped, and a base URL may end in a slash", async () => {
    const fake = new ScriptedFetch([{ answer: ok({}) }]);
    const client = new Pipsocket({ apiKey: API_KEY, baseUrl: "http://localhost:8787/", fetch: fake.fetch });
    await client.account(ACCOUNT_ID).symbols.get("US 30/cash");
    expect(fake.sent[0]?.url).toBe(`http://localhost:8787/v1/accounts/${ACCOUNT_ID}/symbols/US%2030%2Fcash`);
  });

  test("a history range must be whole seconds, checked before sending", async () => {
    const fake = new ScriptedFetch([]);
    const acct = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch }).account(ACCOUNT_ID);
    await expect(acct.history.deals({ from: 1.5, to: 2 })).rejects.toThrow(TypeError);
    expect(fake.sent).toHaveLength(0);
  });

  test("the key is never in an error's message", async () => {
    const fake = new ScriptedFetch([
      {
        answer: { respond: { status: 404, body: { error: "no_such_account", message: "There is no such account." } } },
      },
    ]);
    const error = await new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch })
      .account(ACCOUNT_ID)
      .get()
      .catch((e) => e);
    expect(error).toBeInstanceOf(NotFound);
    expect(error.message).toBe("404 no_such_account: There is no such account.");
    expect(inspect(error, { showHidden: true, depth: 5 })).not.toContain(API_KEY);
  });
});

describe("a lookup", () => {
  test("returns the request with its kind and status, and no key", async () => {
    const body = { request: "req_1", state: "pending", sent: {}, result: null, message: "Waiting." };
    const fake = new ScriptedFetch([{ answer: ok(body) }]);
    const request = await new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch })
      .account(ACCOUNT_ID)
      .requests.get("req_1");
    expect(request).toMatchObject({ kind: "pending", id: "req_1", state: "pending", httpStatus: 200, raw: body });
    expect(request.idempotencyKey).toBeUndefined();
  });
});

describe("per-call options", () => {
  test("maxRetries on a call overrides the client's", async () => {
    const fake = new ScriptedFetch([{ answer: unavailable }]);
    const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, clock: new FakeClock() });
    await expect(client.account(ACCOUNT_ID).positions.list({ maxRetries: 0 })).rejects.toThrow(Unavailable);
    expect(fake.sent).toHaveLength(1);
  });

  test("an attempt that takes longer than timeoutMs fails as a timeout, and is retried", async () => {
    const fake = new ScriptedFetch([{ answer: hangUntilAborted }, { answer: ok() }]);
    const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, clock: new FakeClock(), timeoutMs: 20 });
    await expect(client.account(ACCOUNT_ID).positions.list()).resolves.toEqual([]);
    expect(fake.sent).toHaveLength(2);
  });

  test("a timeout on the last attempt is an APITimeoutError", async () => {
    const fake = new ScriptedFetch([{ answer: hangUntilAborted }]);
    const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, maxRetries: 0, timeoutMs: 20 });
    await expect(client.account(ACCOUNT_ID).get()).rejects.toThrow(APITimeoutError);
  });
});

describe("cancelling a call with an AbortSignal", () => {
  const reasons: Array<[string, () => unknown]> = [
    ["an error", () => new Error("caller stopped")],
    ["a string", () => "caller stopped"],
    ["a frozen object", () => Object.freeze({ why: "caller stopped" })],
  ];

  for (const [label, make] of reasons) {
    test(`passes ${label} reason through unchanged, during an attempt`, async () => {
      const reason = make();
      const controller = new AbortController();
      const fake = new ScriptedFetch([
        {
          answer: () => {
            controller.abort(reason);
            return new Response("[]", { status: 200 });
          },
        },
      ]);
      const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, clock: new FakeClock() });
      const error = await client
        .account(ACCOUNT_ID)
        .positions.list({ signal: controller.signal })
        .catch((e) => e);
      expect(error).toBe(reason);
    });
  }

  test("during the wait between attempts, and nothing more is sent", async () => {
    const controller = new AbortController();
    const clock: Clock = {
      now: () => 0,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
          controller.abort("stop");
        }),
    };
    const fake = new ScriptedFetch([{ answer: unavailable }, { answer: ok() }]);
    const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, clock });
    await expect(client.account(ACCOUNT_ID).positions.list({ signal: controller.signal })).rejects.toBe("stop");
    expect(fake.sent).toHaveLength(1);
  });

  test("already aborted: nothing is sent", async () => {
    const fake = new ScriptedFetch([]);
    const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch });
    await expect(client.account(ACCOUNT_ID).get({ signal: AbortSignal.abort("early") })).rejects.toBe("early");
    expect(fake.sent).toHaveLength(0);
  });
});

test("a body that breaks off keeps what did arrive on the error", async () => {
  const cut = { respond: { status: 200, body_error: true } } as const;
  const fake = new ScriptedFetch([{ answer: cut }, { answer: cut }, { answer: cut }]);
  const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, clock: new FakeClock() });
  const error = await client
    .account(ACCOUNT_ID)
    .positions.list()
    .catch((e) => e);
  expect(error).toBeInstanceOf(APIError);
  expect(error).toMatchObject({ status: 200, code: null, raw: '{"request":"req_' });
});

test("an answer that isn't JSON is retried, then raised with its status and text", async () => {
  const page = { respond: { status: 502, text: "<html>Bad gateway</html>" } } as const;
  const fake = new ScriptedFetch([{ answer: page }, { answer: page }, { answer: page }]);
  const client = new Pipsocket({ apiKey: API_KEY, fetch: fake.fetch, clock: new FakeClock() });
  const error = await client
    .account(ACCOUNT_ID)
    .get()
    .catch((e) => e);
  expect(error).toBeInstanceOf(APIError);
  expect(error).toMatchObject({ status: 502, code: null, raw: "<html>Bad gateway</html>" });
});
