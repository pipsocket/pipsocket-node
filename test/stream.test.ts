// The stream helper through real sockets, against a local fake of the API. Runs on Node (the ws
// package) and on Bun and Deno (their own WebSocket), so a refused key and a dead network are
// covered on every runtime the stream supports.

import { afterEach, describe, expect, test } from "vitest";
import { AuthenticationError, Pipsocket, type ResyncEvent, StreamError, type StreamEvent } from "../src/index.js";
import { defaultSocket, type SocketFactory } from "../src/stream/socket.js";
import { type FakeConnection, type FakeServer, type FakeServerOptions, fakeServer } from "./support/fake-server.js";
import { ACCOUNT_ID, API_KEY } from "./support/fakes.js";

const ACCOUNT = {
  id: ACCOUNT_ID,
  login: 5058427372,
  server: "Broker-Demo",
  status: "connected",
  server_time: 1_794_067_825,
};
const UNAUTHORIZED: [number, unknown] = [401, { error: "invalid_api_key", message: "The API key is not valid." }];

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** REST answers for a healthy account. */
function healthyRest({ path }: { path: string }): [number, unknown] {
  const base = `/v1/accounts/${ACCOUNT_ID}`;
  if (path === base) return [200, ACCOUNT];
  if (path === `${base}/positions` || path === `${base}/orders`) return [200, []];
  if (path.startsWith(`${base}/history/`)) return [200, []];
  if (path.startsWith(`${base}/requests/`)) {
    return [200, { request: path.split("/").at(-1), state: "pending", sent: {}, result: null, message: "..." }];
  }
  return [404, { error: "no_such_route", message: path }];
}

/** Says subscribed, and answers every ticks call with the set it was given. */
function behaveLikeTheApi(connection: FakeConnection): void {
  connection.send({ type: "subscribed", account: ACCOUNT_ID });
  const answerTicks = async () => {
    for (;;) {
      const text = await connection.next((t) => t.includes('"/ticks"'));
      const call = JSON.parse(text);
      connection.send({ type: "response", id: call.id, status: 200, body: { symbols: call.body.symbols } });
    }
  };
  void answerTicks();
}

async function start(options: Partial<FakeServerOptions> = {}) {
  server = await fakeServer({ rest: healthyRest, connected: behaveLikeTheApi, ...options });
  const client = new Pipsocket({
    apiKey: API_KEY,
    baseUrl: `http://127.0.0.1:${server.port}`,
    streamUrl: `ws://127.0.0.1:${server.port}`,
  });
  return { server, acct: client.account(ACCOUNT_ID) };
}

async function nextEvent(iterator: AsyncIterator<StreamEvent>): Promise<StreamEvent> {
  const result = await iterator.next();
  if (result.done) throw new Error("The stream ended");
  return result.value;
}

describe("connecting", () => {
  test("sends the key on the upgrade, sets the ticks, resyncs, then yields the API's messages as they are", async () => {
    const { server, acct } = await start();
    const stream = acct.stream({ ticks: ["EURUSD"] });
    const events = stream[Symbol.asyncIterator]();
    const resync = (await nextEvent(events)) as ResyncEvent;
    expect(resync).toMatchObject({ type: "resync", reason: "connected", account: ACCOUNT, positions: [], orders: [] });
    const connection = server.connections[0];
    expect(connection?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(connection?.received.map((t) => JSON.parse(t).body?.symbols)).toContainEqual(["EURUSD"]);

    connection?.send({ type: "deal", deal: { ticket: 7, symbol: "EURUSD" } });
    expect(await nextEvent(events)).toEqual({ type: "deal", deal: { ticket: 7, symbol: "EURUSD" } });

    await stream.setTicks(["EURUSD", "XAUUSD"]);
    expect(stream.ticks).toEqual(["EURUSD", "XAUUSD"]);
    stream.close();
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });

  test("leaving a for-await loop closes the socket", async () => {
    const { server, acct } = await start();
    for await (const event of acct.stream()) {
      expect(event.type).toBe("resync");
      break;
    }
    await server.connections[0]?.closed;
  });

  test("close() before the socket is made opens none, and leaves nothing open", async () => {
    const { acct } = await start();
    const opened: string[] = [];
    const closed: string[] = [];
    const real = await defaultSocket();
    const tracking: SocketFactory = (url, headers, events) => {
      opened.push(url);
      const socket = real(url, headers, events);
      return {
        send: (text) => socket.send(text),
        close: () => {
          closed.push(url);
          socket.close();
        },
      };
    };
    const stream = acct.stream({ socket: tracking });
    await Promise.resolve();
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened.length).toBe(closed.length);
  });
});

describe("a refused key", () => {
  test("is raised from the stream, and the helper stops", async () => {
    const { server, acct } = await start({
      refuse: () => ({ status: 401, body: UNAUTHORIZED[1] }),
      // Bun and Deno can't see the upgrade's status: their REST read gets the same 401.
      rest: () => UNAUTHORIZED,
    });
    const events = acct.stream()[Symbol.asyncIterator]();
    await expect(events.next()).rejects.toBeInstanceOf(AuthenticationError);
    expect(server.upgrades).toBe(1);
  });
});

describe("the stream's REST reads", () => {
  test("are one attempt each: the probe while the host is away doesn't retry inside", async () => {
    let accountReads = 0;
    let hostAway = false;
    const { server, acct } = await start({
      rest: (request) => {
        if (request.path === `/v1/accounts/${ACCOUNT_ID}`) {
          accountReads += 1;
          if (hostAway) return [503, { error: "engine_unavailable", message: "..." }];
        }
        return healthyRest(request);
      },
    });
    const stream = acct.stream();
    const events = stream[Symbol.asyncIterator]();
    await nextEvent(events);
    hostAway = true;
    const before = accountReads;
    server.connections[0]?.send({ type: "engine_disconnected" });
    await nextEvent(events);
    // The first probe goes after 2 s; within 3.5 s there is that one read and no retries of it.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(accountReads - before).toBe(1);
    stream.close();
  }, 10_000);
});

describe("a socket that can't be made", () => {
  test("ends the stream with StreamError, without an unhandled rejection", async () => {
    const client = new Pipsocket({ apiKey: API_KEY, streamUrl: "not-a-url" });
    const events = client.account(ACCOUNT_ID).stream()[Symbol.asyncIterator]();
    await expect(events.next()).rejects.toBeInstanceOf(StreamError);
  });
});

describe("a refusal whose body stalls", () => {
  test("is still raised as the refusal, not retried as a network failure", async () => {
    const { acct } = await start({
      refuse: () => ({ status: 401, body: null, stall: true }),
      rest: () => UNAUTHORIZED,
    });
    const started = Date.now();
    await expect(acct.stream()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(AuthenticationError);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("a dead network", () => {
  test("is retried with backoff, for as long as the stream is kept", async () => {
    const { server, acct } = await start();
    const port = server.port;
    await server.close();
    let attempts = 0;
    const real = await defaultSocket();
    const counting: SocketFactory = (url, headers, events) => {
      attempts += 1;
      return real(url.replace(/:\d+\//, `:${port}/`), headers, events);
    };
    const stream = acct.stream({ socket: counting });
    const events = stream[Symbol.asyncIterator]();
    const next = events.next();
    await waitFor(() => attempts >= 3, 5000);
    stream.close();
    expect(await next).toEqual({ done: true, value: undefined });
  });
});

describe("reconnecting", () => {
  test("after the socket drops: the ticks are set again on the new socket, and resync(reconnected) follows", async () => {
    const { server, acct } = await start();
    const stream = acct.stream({ ticks: ["EURUSD"] });
    const events = stream[Symbol.asyncIterator]();
    expect(((await nextEvent(events)) as ResyncEvent).reason).toBe("connected");
    server.connections[0]?.drop();
    const resync = (await nextEvent(events)) as ResyncEvent;
    expect(resync.reason).toBe("reconnected");
    const second = server.connections[1];
    expect(second?.received.some((t) => t.includes('"symbols":["EURUSD"]'))).toBe(true);
    stream.close();
  });
});

describe("requests.wait and trade answers with a stream open", () => {
  const settled = {
    type: "request",
    request: "req_9",
    state: "completed",
    sent: {},
    result: { deal: 3 },
    message: "Done.",
  };

  test("a lookup in flight doesn't hold the wait once the stream shows the request final", async () => {
    let releaseLookup: () => void = () => {};
    const { server, acct } = await start({
      rest: (request) =>
        request.path.endsWith("/requests/req_9")
          ? new Promise((resolve) => {
              releaseLookup = () => resolve(healthyRest(request) as [number, unknown]);
            })
          : healthyRest(request),
    });
    const stream = acct.stream();
    const events = stream[Symbol.asyncIterator]();
    await nextEvent(events);
    const waiting = acct.requests.wait("req_9", { timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.connections[0]?.send(settled);
    await expect(waiting).resolves.toMatchObject({ kind: "completed" });
    releaseLookup();
    stream.close();
  });

  test("a slower 202 pending for a request the stream already showed final returns it final", async () => {
    let answerPlace: (() => void) | undefined;
    const { server, acct } = await start({
      rest: (request) =>
        request.method === "POST"
          ? new Promise((resolve) => {
              answerPlace = () =>
                resolve([202, { request: "req_9", state: "pending", sent: {}, result: null, message: "..." }]);
            })
          : healthyRest(request),
    });
    const stream = acct.stream();
    const events = stream[Symbol.asyncIterator]();
    await nextEvent(events);
    const placing = acct.orders.place({ symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "ioc" });
    await waitFor(() => answerPlace !== undefined);
    server.connections[0]?.send(settled);
    expect(await nextEvent(events)).toEqual(settled);
    answerPlace?.();
    const order = await placing;
    expect(order).toMatchObject({ kind: "completed", state: "completed", id: "req_9" });
    expect(order.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    stream.close();
  });

  test("a wait whose lookup finds the key rolled ends the open stream too", async () => {
    let rolled = false;
    const { acct } = await start({
      rest: (request) => (rolled ? UNAUTHORIZED : healthyRest(request)),
    });
    const stream = acct.stream();
    const events = stream[Symbol.asyncIterator]();
    await nextEvent(events);
    rolled = true;
    await expect(acct.requests.wait("req_9")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(events.next()).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a pending wait outlives a reconnect: the final event on the new socket ends it", async () => {
    const { server, acct } = await start();
    const stream = acct.stream();
    const events = stream[Symbol.asyncIterator]();
    await nextEvent(events);
    const waiting = acct.requests.wait("req_9", { timeoutMs: 20_000 });
    server.connections[0]?.drop();
    expect(((await nextEvent(events)) as ResyncEvent).reason).toBe("reconnected");
    server.connections[1]?.send(settled);
    await expect(waiting).resolves.toMatchObject({ kind: "completed" });
    stream.close();
  });

  test("a pending wait outlives the stream's close: it goes on polling over REST", async () => {
    let lookups = 0;
    const { acct } = await start({
      rest: (request) => {
        if (!request.path.endsWith("/requests/req_9")) return healthyRest(request);
        lookups += 1;
        const state = lookups >= 3 ? "completed" : "pending";
        return [200, { request: "req_9", state, sent: {}, result: null, message: "..." }];
      },
    });
    const stream = acct.stream();
    await nextEvent(stream[Symbol.asyncIterator]());
    const waiting = acct.requests.wait("req_9", { timeoutMs: 20_000 });
    stream.close();
    await expect(waiting).resolves.toMatchObject({ kind: "completed" });
  });
});

describe("requests.wait with a stream open", () => {
  test("resolves from the request event, before its next lookup", async () => {
    const { server, acct } = await start();
    const stream = acct.stream();
    const events = stream[Symbol.asyncIterator]();
    await nextEvent(events);
    const waiting = acct.requests.wait("req_9", { timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = {
      type: "request",
      request: "req_9",
      state: "completed",
      sent: {},
      result: { deal: 3 },
      message: "Done.",
    };
    server.connections[0]?.send(settled);
    const request = await waiting;
    expect(request).toMatchObject({ kind: "completed", id: "req_9" });
    expect(await nextEvent(events)).toEqual(settled);
    stream.close();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
