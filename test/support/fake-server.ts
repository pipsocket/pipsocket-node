// A local server that answers like the API: REST over HTTP, and the stream as a WebSocket upgrade on
// the same port. Written on node:http, with its own small WebSocket framing, so it runs the same way
// under Node, Bun and Deno.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export interface FakeConnection {
  readonly headers: IncomingMessage["headers"];
  /** Text frames the client sent, in order. */
  readonly received: string[];
  send(message: unknown): void;
  /** Drops the connection without a closing handshake, as a network failure would. */
  drop(): void;
  /** Resolves with the next text frame the client sends that `match` accepts. */
  next(match?: (text: string) => boolean): Promise<string>;
  /** Resolves when the connection is closed, by either side. */
  readonly closed: Promise<void>;
}

export interface FakeServerOptions {
  /** Answers a REST call: return [status, body], or a promise of it to answer late. */
  rest(request: {
    method: string;
    path: string;
    headers: IncomingMessage["headers"];
  }): [number, unknown] | Promise<[number, unknown]>;
  /**
   * Refuse the upgrade with this status and body instead of accepting it. With `stall`, the
   * headers go and the body never comes.
   */
  refuse?: () => { status: number; body: unknown; stall?: boolean } | undefined;
  /** Called for every accepted socket. */
  connected?: (connection: FakeConnection) => void;
}

export interface FakeServer {
  readonly port: number;
  readonly connections: FakeConnection[];
  /** Upgrade requests, accepted or refused. */
  readonly upgrades: number;
  close(): Promise<void>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export async function fakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const connections: FakeConnection[] = [];
  const sockets = new Set<Duplex>();
  let upgrades = 0;
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    const [status, body] = await options.rest({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    upgrades += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const refusal = options.refuse?.();
    if (refusal?.stall) {
      socket.write(
        `HTTP/1.1 ${refusal.status} Refused\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{"err`,
      );
      return;
    }
    if (refusal) {
      const body = JSON.stringify(refusal.body);
      socket.end(
        `HTTP/1.1 ${refusal.status} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
      return;
    }
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    const connection = accepted(socket, request.headers);
    connections.push(connection);
    options.connected?.(connection);
  });
  // Every connection, REST keep-alive ones included, so close() never waits on one.
  server.on("connection", (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connections,
    get upgrades() {
      return upgrades;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);
  return Buffer.concat([head, payload]);
}

function bigLength(length: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(length));
  return out;
}

function accepted(socket: Duplex, headers: IncomingMessage["headers"]): FakeConnection {
  const received: string[] = [];
  /** Frames no next() has taken yet. */
  const unclaimed: string[] = [];
  const waiters: Array<{ match: (text: string) => boolean; resolve: (text: string) => void }> = [];
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = (buffer[0] ?? 0) & 0x0f;
      let length = (buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked)
        for (let i = 0; i < payload.length; i += 1)
          payload[i] = (payload[i] ?? 0) ^ (buffer[maskOffset + (i % 4)] ?? 0);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) {
        const text = payload.toString("utf8");
        received.push(text);
        const index = waiters.findIndex((w) => w.match(text));
        if (index >= 0) waiters.splice(index, 1)[0]?.resolve(text);
        else unclaimed.push(text);
      } else if (opcode === 8) {
        socket.end(frame(8, Buffer.alloc(0)));
      } else if (opcode === 9) {
        socket.write(frame(10, payload));
      }
    }
  });
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  // Node's HTTP server keeps a socket half open after the client ends it: close this side too.
  socket.on("end", () => socket.end());
  return {
    headers,
    received,
    closed,
    send: (message) => {
      const text = typeof message === "string" ? message : JSON.stringify(message);
      if (!socket.destroyed) socket.write(frame(1, Buffer.from(text, "utf8")));
    },
    drop: () => socket.destroy(),
    next: (match = () => true) =>
      new Promise((resolve) => {
        const index = unclaimed.findIndex(match);
        if (index >= 0) {
          resolve(unclaimed.splice(index, 1)[0] ?? "");
          return;
        }
        waiters.push({ match, resolve });
      }),
  };
}
