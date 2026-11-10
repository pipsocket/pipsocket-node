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
  calls: Array<{ method: string; path: string }>;
}

export function mockApi(): MockApi {
  const calls: MockApi["calls"] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search });
    const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
    if (url.origin !== "https://api.pipsocket.com" || !route) {
      return Response.json({ error: "no_such_route", message: `${method} ${url.pathname}` }, { status: 404 });
    }
    const { status, body } = successExample(route.operation);
    return Response.json(body, { status });
  };
  return { fetch, calls };
}
