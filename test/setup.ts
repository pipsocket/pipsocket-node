// No test talks to Pipsocket: a fetch or WebSocket to one of its hosts fails the test instead.

import { vi } from "vitest";

function refuseRealHosts(url: string | URL): void {
  const host = new URL(url).hostname;
  if (host === "pipsocket.com" || host.endsWith(".pipsocket.com")) {
    throw new Error(`A test tried to reach ${host}: tests must use mocks and local servers only`);
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  refuseRealHosts(input instanceof Request ? input.url : input);
  return realFetch(input, init);
};

const RealWebSocket = globalThis.WebSocket;
if (RealWebSocket) {
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, ...rest: unknown[]) {
      refuseRealHosts(url);
      super(url, ...(rest as [string]));
    }
  } as typeof WebSocket;
}

// On Bun, "ws" is its own built-in module, which this mock does not replace; the SDK uses the guarded
// global WebSocket there.
vi.mock("ws", async (importOriginal) => {
  const original = (await importOriginal()) as { default: new (url: string, ...rest: unknown[]) => object };
  class GuardedWebSocket extends original.default {
    constructor(url: string, ...rest: unknown[]) {
      refuseRealHosts(url);
      super(url, ...rest);
    }
  }
  return { ...original, default: GuardedWebSocket, WebSocket: GuardedWebSocket };
});
