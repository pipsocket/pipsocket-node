// One HTTP attempt, and what it came to: no connection, a lost answer, or an answer.

import { APIConnectionError, APITimeoutError } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type AttemptResult =
  /** The connection never opened, so nothing was written. */
  | { kind: "no_connection"; error: APIConnectionError }
  /** The request may have been written, then the connection failed or timed out. */
  | { kind: "lost"; error: APIConnectionError }
  | { kind: "answer"; status: number; headers: Headers; text: string }
  /** The status and headers arrived, then reading the body failed. `partial` is what did arrive. */
  | { kind: "unreadable"; status: number; headers: Headers; partial: string };

// Error codes that mean the connection never opened (DNS, refused, unreachable, TLS), so nothing
// was written. Node and undici put them on the error's `cause`; Bun on the error itself. Anything not
// listed counts as maybe written: a wrong guess here costs a retry with the same key, not a trade.
const NO_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "FailedToOpenSocket",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** True when every error code found on `error` and its causes says the connection never opened. */
export function neverConnected(error: unknown): boolean {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    const nested = (value as { errors?: unknown }).errors;
    if (Array.isArray(nested)) nested.forEach(visit);
    visit((value as { cause?: unknown }).cause);
  };
  visit(error);
  return codes.length > 0 && codes.every((code) => NO_CONNECTION_CODES.has(code));
}

/**
 * Sends one attempt. Resolves with what it came to; rejects only with the caller's own abort reason,
 * unchanged, when `signal` aborts.
 */
export async function attempt(
  fetchImpl: FetchLike,
  request: HttpRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    signal: controller.signal,
    redirect: "manual",
  };
  if (request.body !== undefined) init.body = request.body;
  try {
    let response: Response;
    try {
      response = await fetchImpl(request.url, init);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut) return { kind: "lost", error: timeoutError(timeoutMs) };
      const wrapped = new APIConnectionError(`The connection failed: ${describe(error)}`, { cause: error });
      return neverConnected(error) ? { kind: "no_connection", error: wrapped } : { kind: "lost", error: wrapped };
    }
    const body = await readBody(response);
    if (body.complete) return { kind: "answer", status: response.status, headers: response.headers, text: body.text };
    if (signal?.aborted) throw signal.reason;
    return { kind: "unreadable", status: response.status, headers: response.headers, partial: body.text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The body as text, or as much of it as arrived before reading failed. */
async function readBody(response: Response): Promise<{ complete: boolean; text: string }> {
  if (!response.body) return { complete: true, text: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { complete: true, text: text + decoder.decode() };
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { complete: false, text: text + decoder.decode() };
  }
}

function timeoutError(timeoutMs: number): APITimeoutError {
  return new APITimeoutError(`No answer within ${timeoutMs / 1000} s`);
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause;
  if (typeof cause?.message === "string") return cause.message;
  return error instanceof Error ? error.message : String(error);
}
