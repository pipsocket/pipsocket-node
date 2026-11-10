// The stream helper through real sockets, against a local fake of the API. Runs on Node (the ws
// package) and on Bun and Deno (their own WebSocket), so a refused key and a dead network are
// covered on every runtime the stream supports.

import { afterEach, describe, expect, test } from "vitest";
import { AuthenticationError, Pipsocket, type ResyncEvent, type StreamEvent } from "../src/index.js";
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

  test("leaving a for-await loop closes the stream", async () => {
    const { server, acct } = await start();
    for await (const event of acct.stream()) {
      expect(event.type).toBe("resync");
      break;
    }
    await waitFor(() => server.connections.length === 1);
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
