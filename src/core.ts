// What a call does with one attempt's result, and whether it may try again. No I/O here.

import type { AttemptResult } from "./attempt.js";
import { APIConnectionError, APIError, InvalidRequest, isRecord, type PipsocketError } from "./errors.js";
import { type ErrorClass, policyFor, type Step, unknownCodePolicy } from "./policy.js";
import { isRecordedRequest, type TradeRequest, tradeRequestFrom } from "./trade-request.js";

/**
 * - `trade`: one of the six keyed trade calls. Its answer is a recorded request.
 * - `lookup`: `requests.get`. Its answer is a recorded request; the call is safe to repeat.
 * - `read`: any other call that is safe to repeat. Its answer is the JSON as it is.
 */
export type CallKind = "trade" | "lookup" | "read";

export type Verdict =
  | { kind: "request"; request: TradeRequest }
  | { kind: "json"; value: unknown }
  /** Try again if retries and time allow. `limit`: at most this many retries for `reason`. */
  | {
      kind: "retry";
      error: PipsocketError;
      maybeSent: boolean;
      retryAfterMs: number | null;
      reason: string;
      limit?: number;
    }
  | { kind: "stop"; error: PipsocketError; maybeSent: boolean };

/** Nominal waits before each retry: 0.5 s doubling, capped at 8 s. */
export function backoffMs(retry: number, random: number): number {
  const nominal = Math.min(500 * 2 ** (retry - 1), 8000);
  return nominal * (0.5 + random * 0.5);
}

/** A Retry-After header in whole seconds, as milliseconds; null when absent or not whole seconds. */
export function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after")?.trim();
  return value && /^\d+$/.test(value) ? Number(value) * 1000 : null;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * `documented`: for a trade call, the error codes its operation documents. A known code a trade call
 * doesn't document is read as an unknown one (a 5xx may have reached the host), keeping its error
 * class: nothing in the document says that answer recorded nothing.
 */
export function interpret(
  result: AttemptResult,
  call: CallKind,
  idempotencyKey?: string,
  documented?: ReadonlySet<string>,
): Verdict {
  const trade = call === "trade";
  if (result.kind === "no_connection") {
    return { kind: "retry", error: result.error, maybeSent: false, retryAfterMs: null, reason: "network" };
  }
  if (result.kind === "lost") {
    return { kind: "retry", error: result.error, maybeSent: trade, retryAfterMs: null, reason: "network" };
  }

  const { status, headers } = result;
  const wait = retryAfterMs(headers);
  const malformed = (text: string, body: unknown, message: string): Verdict => ({
    kind: "retry",
    error: new APIError({ status, code: null, body, raw: text, message: `${status}: ${message}` }),
    maybeSent: trade,
    retryAfterMs: wait,
    reason: "malformed",
  });

  if (result.kind === "unreadable") {
    // The connection failed part way through the answer: what arrived is kept, with the status.
    const error = new APIConnectionError(`${status}: the answer's body could not be read to the end`, {
      status,
      raw: result.partial,
    });
    return { kind: "retry", error, maybeSent: trade, retryAfterMs: wait, reason: "malformed" };
  }

  const { text } = result;
  const parsed = parseJson(text);
  const body = parsed.ok ? parsed.value : undefined;

  if (call !== "read" && isRecordedRequest(body)) {
    const details = idempotencyKey === undefined ? { httpStatus: status } : { httpStatus: status, idempotencyKey };
    return { kind: "request", request: tradeRequestFrom(body, details) };
  }
  if (status >= 200 && status < 300) {
    if (!parsed.ok) return malformed(text, undefined, "the answer is not JSON");
    if (call !== "read") return malformed(text, body, "the answer is not a recorded request");
    return { kind: "json", value: body };
  }
  if (status === 400 && text === "") {
    const error = new InvalidRequest({
      status,
      code: null,
      body: undefined,
      raw: text,
      message: "400: the API refused the request (a ticket in the path that isn't a whole number)",
    });
    return { kind: "stop", error, maybeSent: false };
  }
  if (status === 403 && /^error code: 1010\b/.test(text.trim())) {
    const error = new APIError({
      status,
      code: null,
      body: undefined,
      raw: text,
      message: "403: Cloudflare refused this client before the API saw the call (error code: 1010)",
    });
    return { kind: "stop", error, maybeSent: false };
  }
  if (!isRecord(body) || typeof body.error !== "string") {
    return malformed(text, body, parsed.ok ? "the answer has no error code" : "the answer is not the API's JSON");
  }

  const code = body.error;
  const policy = policyFor(code, status);
  const undocumented = trade && documented !== undefined && !documented.has(code);
  const step: Step = undocumented ? unknownCodePolicy(status).trade : trade ? policy.trade : policy.safe;
  const errorClass: ErrorClass = (trade && policy.tradeError) || policy.error;
  const error = new errorClass({ status, code, body, raw: text, retryAfter: wait === null ? null : wait / 1000 });
  switch (step) {
    case "stop":
      return { kind: "stop", error, maybeSent: false };
    case "retry":
      return { kind: "retry", error, maybeSent: false, retryAfterMs: wait, reason: code };
    case "retry_once":
      return { kind: "retry", error, maybeSent: false, retryAfterMs: wait, reason: code, limit: 1 };
    case "retry_after":
      return wait === null
        ? { kind: "stop", error, maybeSent: false }
        : { kind: "retry", error, maybeSent: false, retryAfterMs: wait, reason: code };
    case "maybe_sent":
      return { kind: "retry", error, maybeSent: true, retryAfterMs: wait, reason: code };
    case "recorded":
      // The code says the body is a recorded request, but it isn't one.
      return malformed(text, body, "the answer is not a recorded request");
  }
}
