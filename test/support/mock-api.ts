// A fetch that answers like the API, from the response examples in the committed OpenAPI document.

import { readFileSync } from "node:fs";

interface MediaType {
  example?: unknown;
  examples?: Record<string, { value: unknown }>;
}
interface Operation {
  responses: Record<string, { content?: Record<string, MediaType> }>;
}

const document = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
};

const routes = Object.entries(document.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => ["get", "post", "patch", "delete", "put"].includes(method))
    .map(([method, operation]) => ({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${path.replace(/\{[a-z]+\}/g, "[^/]+")}$`),
      operation,
    })),
);

/** The first example of the operation's first success answer, by status. */
function successExample(operation: Operation): { status: number; body: unknown } {
  const status = Object.keys(operation.responses)
    .filter((s) => s.startsWith("2"))
    .sort()[0];
  const media = status ? operation.responses[status]?.content?.["application/json"] : undefined;
  const body = media?.example ?? Object.values(media?.examples ?? {})[0]?.value;
  if (!status || body === undefined) throw new Error("The document has no success example for this operation");
  return { status: Number(status), body };
}

export interface MockApi {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  /** A WebSocket class for the stream, in both the ws package's style and the web's. */
  WebSocket: new (
    url: string,
    options?: unknown,
  ) => unknown;
  /** Stream sockets opened so far. */
  sockets: number;
}

/**
 * A mock of the API. The stream says subscribed, answers the tick set, sends one tick and one
 * request event, then drops; from then on the account is gone (404), so a stream ends with
 * NotFound instead of running for ever. `answer` replaces the document's example for the calls it
 * returns an answer for.
 */
export function mockApi(
  answer?: (method: string, path: string) => { status: number; body: unknown } | undefined,
): MockApi {
  const calls: MockApi["calls"] = [];
  let gone = false;
  const api: MockApi = {
    calls,
    sockets: 0,
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const sent = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname + url.search, ...(sent === undefined ? {} : { body: sent }) });
      const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (url.origin !== "https://api.pipsocket.com" || !route) {
        return Response.json({ error: "no_such_route", message: `${method} ${url.pathname}` }, { status: 404 });
      }
      if (gone)
        return Response.json({ error: "no_such_account", message: "There is no such account." }, { status: 404 });
      const { status, body } = answer?.(method, url.pathname) ?? successExample(route.operation);
      return Response.json(body, { status });
    },
    WebSocket: class {
      readonly #ws = new Map<string, Array<(...args: unknown[]) => void>>();
      readonly #web = new Map<string, Array<(event: unknown) => void>>();
      #closed = false;

      constructor(url: string) {
        if (!url.startsWith("wss://wss.pipsocket.com/v1/accounts/")) throw new Error(`Unexpected stream URL ${url}`);
        api.sockets += 1;
        const first = api.sockets === 1;
        setTimeout(() => (first ? this.#accept() : this.#refuse()), 0);
      }

      on(event: string, listener: (...args: unknown[]) => void): void {
        this.#ws.set(event, [...(this.#ws.get(event) ?? []), listener]);
      }

      addEventListener(event: string, listener: (event: unknown) => void): void {
        this.#web.set(event, [...(this.#web.get(event) ?? []), listener]);
      }

      send(text: string): void {
        if (!text.startsWith("{")) return;
        const call = JSON.parse(text);
        this.#text({ type: "response", id: call.id, status: 200, body: call.body });
        this.#text({ type: "tick", symbol: "EURUSD", time_msc: 1794067825123, bid: 1.0841, ask: 1.08412 });
        this.#text({ type: "request", request: "req_1", state: "completed", sent: {}, result: null, message: "Done." });
        setTimeout(() => this.terminate(), 10);
      }

      close(): void {
        this.terminate();
      }

      terminate(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#emit("close", [], {});
      }

      #accept(): void {
        this.#emit("open", [], {});
        this.#text({ type: "subscribed", account: "acc_01m6tx3k9f2qw8r7bznd5yvh4c" });
      }

      #refuse(): void {
        gone = true;
        const body = JSON.stringify({ error: "no_such_account", message: "There is no such account." });
        const response = {
          statusCode: 404,
          on: (event: string, listener: (chunk?: unknown) => void) => {
            if (event === "data") setTimeout(() => listener(new TextEncoder().encode(body)), 0);
            if (event === "end") setTimeout(() => listener(), 1);
          },
        };
        if (this.#ws.has("unexpected-response")) {
          for (const listener of this.#ws.get("unexpected-response") ?? []) listener({}, response);
        } else {
          this.#emit("error", [new Error("refused")], {});
          this.terminate();
        }
      }

      #text(message: unknown): void {
        const text = JSON.stringify(message);
        this.#emit("message", [text, false], { data: text });
      }

      #emit(event: string, wsArgs: unknown[], webEvent: unknown): void {
        for (const listener of this.#ws.get(event) ?? []) listener(...wsArgs);
        for (const listener of this.#web.get(event) ?? []) listener(webEvent);
      }
    },
  };
  return api;
}
