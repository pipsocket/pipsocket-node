// Real sockets on this machine, through the runtime's own fetch: a connection that is refused sent
// nothing, and one reset after the request was written may have sent the trade.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { APIConnectionError, OutcomeUnknown, Pipsocket } from "../src/index.js";
import { ACCOUNT_ID, API_KEY, FakeClock } from "./support/fakes.js";

const ORDER = { symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "ioc" } as const;
let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const created = createServer(handler);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return (created.address() as AddressInfo).port;
}

function client(port: number) {
  return new Pipsocket({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}`, clock: new FakeClock() });
}

test("a refused connection on every attempt is APIConnectionError: nothing was sent", async () => {
  const port = await listen(() => {});
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  const error = await client(port)
    .account(ACCOUNT_ID)
    .orders.place(ORDER)
    .catch((e) => e);
  expect(error).toBeInstanceOf(APIConnectionError);
  expect(error).not.toBeInstanceOf(OutcomeUnknown);
});

test("a connection reset after the request was written is OutcomeUnknown, with the same key each time", async () => {
  const keys: Array<string | undefined> = [];
  const port = await listen((request) => {
    keys.push(request.headers["idempotency-key"] as string | undefined);
    request.on("data", () => {});
    request.on("end", () => request.socket.destroy());
  });
  const error = await client(port)
    .account(ACCOUNT_ID)
    .orders.place(ORDER)
    .catch((e) => e);
  expect(error).toBeInstanceOf(OutcomeUnknown);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(error.idempotencyKey).toBe(keys[0]);
});
