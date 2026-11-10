// Socket adapters: what a WebSocket client must do for the stream helper. The one hard requirement
// is to say why a handshake failed: refused with a status, a network failure, or "can't tell".

import { StreamError } from "../errors.js";
import type { HandshakeFailure } from "./machine.js";

export interface SocketEvents {
  opened(): void;
  text(text: string): void;
  /** The socket closed after it opened. */
  closed(): void;
  /** The socket never opened. Called at most once, and never after `opened`. */
  handshakeFailed(failure: HandshakeFailure): void;
}

export interface StreamSocket {
  send(text: string): void;
  close(): void;
}

/** Opens a socket to `url` with `headers` on the upgrade request, and reports what happens to it. */
export type SocketFactory = (url: string, headers: Record<string, string>, events: SocketEvents) => StreamSocket;

/** The largest refusal body read from a refused handshake. */
const REFUSAL_BODY_LIMIT = 64 * 1024;
/** How long to wait for a refused handshake's body before reporting its status without it. */
const REFUSAL_BODY_WAIT_MS = 1000;

interface WsLike {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "unexpected-response", listener: (request: unknown, response: IncomingLike) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

interface IncomingLike {
  statusCode?: number;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end" | "error" | "close", listener: () => void): void;
}

type WsConstructor = new (
  url: string,
  options: { headers: Record<string, string>; handshakeTimeout: number },
) => WsLike;

/** Node: the ws package, which reports a refused handshake's status (Node's own client doesn't). */
export function wsSocket(WebSocket: WsConstructor): SocketFactory {
  return (url, headers, events) => {
    let opened = false;
    let failed = false;
    const fail = (failure: HandshakeFailure) => {
      if (opened || failed) return;
      failed = true;
      events.handshakeFailed(failure);
    };
    const socket = new WebSocket(url, { headers, handshakeTimeout: 30_000 });
    // Set once the upgrade is refused: from then on, whatever else happens, the status is reported.
    let reportRefusal: (() => void) | null = null;
    socket.on("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      const decoder = new TextDecoder();
      let body = "";
      const report = () => {
        clearTimeout(timer);
        fail({ kind: "refused", status, body: body + decoder.decode() });
        socket.terminate();
      };
      reportRefusal = report;
      // The body carries the error code; a body that stalls doesn't hold the status back for long.
      const timer = setTimeout(report, REFUSAL_BODY_WAIT_MS);
      response.on("data", (chunk) => {
        if (body.length < REFUSAL_BODY_LIMIT) body += decoder.decode(chunk, { stream: true });
      });
      response.on("end", report);
      response.on("error", report);
      response.on("close", report);
    });
    socket.on("open", () => {
      if (failed) return;
      opened = true;
      events.opened();
    });
    socket.on("message", (data, isBinary) => {
      if (opened && !isBinary) events.text(String(data));
    });
    socket.on("error", (error) => (reportRefusal ? reportRefusal() : fail({ kind: "network", error })));
    socket.on("close", () => {
      if (opened) events.closed();
      else if (reportRefusal) reportRefusal();
      else fail({ kind: "network", error: undefined });
    });
    return {
      send: (text) => socket.send(text),
      close: () => socket.terminate(),
    };
  };
}

type WebSocketWithHeaders = new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/**
 * Bun and Deno: their WebSocket takes a `headers` option, but like a browser's it gives no status
 * for a refused handshake. So every failure before opening is reported as "can't tell", and the
 * helper finds out with a REST read.
 */
export function webSocket(WebSocketClass: WebSocketWithHeaders): SocketFactory {
  return (url, headers, events) => {
    let opened = false;
    let failed = false;
    const socket = new WebSocketClass(url, { headers });
    const fail = (error: unknown) => {
      if (opened || failed) return;
      failed = true;
      events.handshakeFailed({ kind: "unknown", error });
    };
    socket.addEventListener("open", () => {
      if (failed) return;
      opened = true;
      events.opened();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (opened && typeof event.data === "string") events.text(event.data);
    });
    socket.addEventListener("error", (event) => fail(event));
    socket.addEventListener("close", () => {
      if (opened) events.closed();
      else fail(undefined);
    });
    return {
      send: (text) => socket.send(text),
      close: () => socket.close(),
    };
  };
}

/**
 * The adapter for this runtime. Node and Deno use the ws package when it is installed: it reports a
 * refused handshake's status, and its close() drops the connection at once. Bun, and Deno without
 * ws, use the runtime's own WebSocket and the weaker contract above. (Deno's own WebSocket also
 * waits for the server to answer its close, so with a peer that never answers, the process stays
 * up until the connection times out: install ws on Deno.)
 */
export async function defaultSocket(): Promise<SocketFactory> {
  const scope = globalThis as { Bun?: unknown; Deno?: unknown; WebSocket?: unknown };
  const builtIn = typeof scope.WebSocket === "function" ? webSocket(scope.WebSocket as WebSocketWithHeaders) : null;
  if (scope.Bun && builtIn) return builtIn;
  let module: { default?: unknown; WebSocket?: unknown };
  try {
    module = (await import("ws")) as { default?: unknown; WebSocket?: unknown };
  } catch (error) {
    if (scope.Deno && builtIn) return builtIn;
    throw new StreamError(
      "The stream needs the ws package on Node (npm install ws): Node's own WebSocket can't send the key or report why a handshake failed.",
      { cause: error },
    );
  }
  return wsSocket((module.WebSocket ?? module.default) as WsConstructor);
}
