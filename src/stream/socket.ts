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
    socket.on("unexpected-response", (_request, response) => {
      // Read the refusal's body for its error code, then drop the connection.
      const status = response.statusCode ?? 0;
      const decoder = new TextDecoder();
      let body = "";
      let reported = false;
      const report = () => {
        if (reported) return;
        reported = true;
        fail({ kind: "refused", status, body: body + decoder.decode() });
        socket.terminate();
      };
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
    socket.on("error", (error) => fail({ kind: "network", error }));
    socket.on("close", () => {
      if (opened) events.closed();
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

/** The adapter for this runtime: Bun's and Deno's own WebSocket, or the ws package on Node. */
export async function defaultSocket(): Promise<SocketFactory> {
  const scope = globalThis as { Bun?: unknown; Deno?: unknown; WebSocket?: unknown };
  if ((scope.Bun || scope.Deno) && typeof scope.WebSocket === "function") {
    return webSocket(scope.WebSocket as WebSocketWithHeaders);
  }
  let module: { default?: unknown; WebSocket?: unknown };
  try {
    module = (await import("ws")) as { default?: unknown; WebSocket?: unknown };
  } catch (error) {
    throw new StreamError(
      "The stream needs the ws package on Node (npm install ws): Node's own WebSocket can't send the key or report why a handshake failed.",
      { cause: error },
    );
  }
  return wsSocket((module.WebSocket ?? module.default) as WsConstructor);
}
