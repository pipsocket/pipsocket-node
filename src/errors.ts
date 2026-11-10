import type { Blocking, KillSwitchView } from "./types.js";

/** The base of every error this SDK raises itself. */
export class PipsocketError extends Error {
  /** On every error from a trade call: the key it sent, to retry later with the same one. */
  idempotencyKey?: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The network failed: no usable answer came back. */
export class APIConnectionError extends PipsocketError {}

/** An attempt took longer than its timeout. */
export class APITimeoutError extends APIConnectionError {}

export interface APIErrorFields {
  status: number;
  code: string | null;
  body: unknown;
  raw: string;
  message?: string;
}

/**
 * The API answered with a refusal, or with something that isn't its JSON.
 *
 * `code` is the API's `error` code, or null when the answer had none (such as a 400 with no body,
 * or a page from a proxy). `body` is the parsed JSON, when there was some; `raw` is the body's text.
 */
export class APIError extends PipsocketError {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  readonly raw: string;

  constructor(fields: APIErrorFields) {
    super(fields.message ?? describe(fields));
    this.status = fields.status;
    this.code = fields.code;
    this.body = fields.body;
    this.raw = fields.raw;
  }
}

function describe({ status, code, body }: APIErrorFields): string {
  const apiMessage = isRecord(body) && typeof body.message === "string" ? body.message : undefined;
  const head = code ? `${status} ${code}` : `${status}`;
  return apiMessage ? `${head}: ${apiMessage}` : `${head}: the API's answer had no error message`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 401: the key is missing, wrong, or was rolled. */
export class AuthenticationError extends APIError {}

/** 404: no such account, order, position, request or symbol. */
export class NotFound extends APIError {}

/** 400 with no body, or 422 `invalid_request` and `magic_reserved`. Nothing was sent. */
export class InvalidRequest extends APIError {}

/** 422 `range_too_large`: ask for a shorter history range. */
export class RangeTooLarge extends APIError {}

/** 409 `symbol_busy`: an earlier request on the symbol has no outcome yet. Nothing was sent. */
export class SymbolBusy extends APIError {
  /** The requests it waited for, with their states. */
  readonly blocking: Blocking[];
  /** Seconds to wait before sending again, or null when a blocking request is `unknown`. */
  readonly retryAfter: number | null;

  constructor(fields: APIErrorFields & { retryAfter: number | null }) {
    super(fields);
    const blocking = isRecord(fields.body) ? fields.body.blocking : undefined;
    this.blocking = Array.isArray(blocking) ? (blocking as Blocking[]) : [];
    this.retryAfter = fields.retryAfter;
  }
}

/** 423 `kill_switch_engaged`: lift the kill switch to open new exposure. Nothing was sent. */
export class KillSwitchEngaged extends APIError {}

/** 423 `billing_hold`: the account is close-only until the workspace's payment goes through. */
export class BillingHold extends APIError {}

/**
 * 503 `account_not_connected`, `bridge_outdated` or `account_restarting`.
 *
 * On engaging the kill switch, `killSwitch` is the switch's view: it is engaged all the same.
 */
export class AccountUnavailable extends APIError {
  readonly killSwitch: KillSwitchView | null;

  constructor(fields: APIErrorFields) {
    super(fields);
    const view = isRecord(fields.body) ? fields.body.kill_switch : undefined;
    this.killSwitch = isRecord(view) ? (view as KillSwitchView) : null;
  }
}

/** 503 `engine_busy`: the account's host had too many calls in flight. Nothing was done. */
export class EngineBusy extends APIError {}

/** 503 `engine_unavailable` or 504 `engine_timeout` on a call that is safe to repeat. */
export class Unavailable extends APIError {}

/** 504 `terminal_timeout`: the account's terminal did not answer within 5 seconds. */
export class TerminalTimeout extends APIError {}

/** 503 `terminal_error`, `bad_command` or `symbol_too_large`. */
export class TerminalError extends APIError {}

/** 503 `no_price`: the terminal has no price for the symbol yet. */
export class NoPrice extends APIError {}

export interface OutcomeUnknownFields {
  idempotencyKey: string;
  cause: PipsocketError;
}

/**
 * A trade call may have reached the account's host, and no recorded request came back.
 *
 * The trade may or may not have been sent. Call again with the same `idempotencyKey` (it returns the
 * recorded request, or sends the trade if it never arrived), or read positions and history first.
 * `cause` is the last error the call saw.
 */
export class OutcomeUnknown extends PipsocketError {
  declare idempotencyKey: string;
  declare readonly cause: PipsocketError;
  /** The HTTP status of the last answer, or null when the last attempt got none. */
  readonly status: number | null;
  /** The body of the last answer, as text, or null when the last attempt got none. */
  readonly raw: string | null;

  constructor({ idempotencyKey, cause }: OutcomeUnknownFields) {
    super(
      `The trade may have been sent: retry with the same idempotency key, or check positions and history (${cause.message})`,
      { cause },
    );
    this.idempotencyKey = idempotencyKey;
    this.status = cause instanceof APIError ? cause.status : null;
    this.raw = cause instanceof APIError ? cause.raw : null;
  }
}

/** The SDK's own errors for a stream. */
export class StreamError extends PipsocketError {}

/** A stream's WebSocket upgrade kept failing. */
export class StreamHandshakeError extends StreamError {}
