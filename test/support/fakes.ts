// A scripted fetch and a clock that never really waits. Used through the real client.

import { type Clock, type FetchLike, markNotSent } from "../../src/index.js";

export interface SentAttempt {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type ScriptedAnswer =
  | { respond: { status: number; headers?: Record<string, string>; body?: unknown; text?: string; body_error?: true } }
  | { fail: "connect" | "after_write" }
  | ((request: SentAttempt, signal: AbortSignal | undefined) => Response | Promise<Response>);

export interface Scripted {
  answer: ScriptedAnswer;
  /** Milliseconds the fake clock moves while this attempt runs. */
  elapsedMs?: number;
}

export class FakeClock implements Clock {
  current = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.sleeps.push(ms);
    this.current += ms;
    return Promise.resolve();
  }
}

/** Errors shaped as Node's fetch gives them: a TypeError whose cause carries the system code. */
export function networkError(code: string): TypeError {
  const cause = Object.assign(new Error(`${code} (fake)`), { code });
  return new TypeError("fetch failed", { cause });
}

function bodyThatFails(): ReadableStream<Uint8Array> {
  // The first read gets the start of a body; the next one fails, as when a connection drops mid-body.
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.error(networkError("ECONNRESET"));
      } else {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"request":"req_'));
      }
    },
  });
}

export function responseFor(respond: Extract<ScriptedAnswer, { respond: unknown }>["respond"]): Response {
  const headers = new Headers(respond.headers);
  if (respond.body_error) return new Response(bodyThatFails(), { status: respond.status, headers });
  if (respond.text !== undefined) return new Response(respond.text, { status: respond.status, headers });
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(respond.body), { status: respond.status, headers });
}

/**
 * A fetch that answers attempt n with `script[n]`. `overrun` turns true if the client makes more
 * attempts than the script has, whatever the client does with the error that follows.
 */
export class ScriptedFetch {
  readonly sent: SentAttempt[] = [];
  overrun = false;
  readonly fetch: FetchLike;

  constructor(
    private readonly script: Scripted[],
    private readonly clock?: FakeClock,
  ) {
    this.fetch = (input, init) => this.handle(input, init);
  }

  private async handle(input: string, init: RequestInit): Promise<Response> {
    const request: SentAttempt = {
      method: init.method ?? "GET",
      url: input,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    const step = this.script[this.sent.length];
    this.sent.push(request);
    if (!step) {
      this.overrun = true;
      throw new Error("The script has no answer for this attempt");
    }
    if (this.clock && step.elapsedMs) this.clock.current += step.elapsedMs;
    const { answer } = step;
    if (typeof answer === "function") return answer(request, init.signal ?? undefined);
    // A connection that never opened is marked so; a reset after writing is any other failure.
    if ("fail" in answer) {
      throw answer.fail === "connect" ? markNotSent(networkError("ECONNREFUSED")) : networkError("ECONNRESET");
    }
    return responseFor(answer.respond);
  }
}

/** An answer that never comes: it rejects only when the attempt is aborted (its timeout, or the caller). */
export function hangUntilAborted(_request: SentAttempt, signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

export const ACCOUNT_ID = "acc_01m6tx3k9f2qw8r7bznd5yvh4c";
export const API_KEY = "psk_test0000000000000000000000000000000000000000";
