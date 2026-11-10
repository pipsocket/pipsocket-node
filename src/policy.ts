// What a call does with each error code the API has. Every code in the document has a row: the
// contract tests fail when the document gains a code this table doesn't cover.

import {
  AccountUnavailable,
  APIError,
  type APIErrorFields,
  AuthenticationError,
  BillingHold,
  EngineBusy,
  InvalidRequest,
  KillSwitchEngaged,
  NoPrice,
  NotFound,
  RangeTooLarge,
  SymbolBusy,
  TerminalError,
  TerminalTimeout,
  Unavailable,
} from "./errors.js";
import type { ErrorCode } from "./generated/tables.js";

/**
 * - `stop`: raise the error (or OutcomeUnknown, once a trade call may have been sent).
 * - `retry`: try again with the same key.
 * - `retry_once`: try again, but only once per call.
 * - `retry_after`: try again only when the answer has a Retry-After header.
 * - `maybe_sent`: the call may have reached the host; try again with the same key.
 * - `recorded`: the answer is a recorded request, returned as a result. Without the request in its
 *   body it is malformed, and counts as maybe sent.
 */
export type Step = "stop" | "retry" | "retry_once" | "retry_after" | "maybe_sent" | "recorded";

export type ErrorClass = new (fields: APIErrorFields & { retryAfter: number | null }) => APIError;

export interface CodePolicy {
  /** The error raised for this code on a call that is safe to repeat. */
  error: ErrorClass;
  /** The error raised for this code on a trade call, when it differs. */
  tradeError?: ErrorClass;
  /** On the six keyed trade calls. */
  trade: Step;
  /** On reads, check and the kill switch. */
  safe: Step;
}

// On a trade call, a code the call's operation doesn't document is read as an unknown code, keeping
// its error class: nothing in the document says that answer recorded nothing (see core.ts).
export const CODE_POLICIES: Record<ErrorCode, CodePolicy> = {
  missing_api_key: { error: AuthenticationError, trade: "stop", safe: "stop" },
  invalid_api_key: { error: AuthenticationError, trade: "stop", safe: "stop" },
  no_such_account: { error: NotFound, trade: "stop", safe: "stop" },
  no_such_order: { error: NotFound, trade: "stop", safe: "stop" },
  no_such_position: { error: NotFound, trade: "stop", safe: "stop" },
  no_such_request: { error: NotFound, trade: "stop", safe: "stop" },
  no_such_symbol: { error: NotFound, trade: "stop", safe: "stop" },
  invalid_request: { error: InvalidRequest, trade: "stop", safe: "stop" },
  magic_reserved: { error: InvalidRequest, trade: "stop", safe: "stop" },
  range_too_large: { error: RangeTooLarge, trade: "stop", safe: "stop" },
  trade_rejected: { error: APIError, trade: "recorded", safe: "stop" },
  not_executed: { error: APIError, trade: "recorded", safe: "stop" },
  not_sent: { error: APIError, trade: "recorded", safe: "stop" },
  symbol_busy: { error: SymbolBusy, trade: "retry_after", safe: "stop" },
  kill_switch_engaged: { error: KillSwitchEngaged, trade: "stop", safe: "stop" },
  billing_hold: { error: BillingHold, trade: "stop", safe: "stop" },
  account_not_connected: { error: AccountUnavailable, trade: "stop", safe: "stop" },
  bridge_outdated: { error: AccountUnavailable, trade: "stop", safe: "stop" },
  account_restarting: { error: AccountUnavailable, trade: "stop", safe: "stop" },
  // The terminal's refusals, which the document lists only for reads (a trade the terminal refuses
  // comes back as a not_sent request). The trade column applies only to an operation that documents
  // the code: on any other trade call, a code it doesn't document is read as an unknown one (core.ts).
  bad_command: { error: TerminalError, trade: "stop", safe: "stop" },
  terminal_error: { error: TerminalError, trade: "retry_once", safe: "retry_once" },
  symbol_too_large: { error: TerminalError, trade: "stop", safe: "stop" },
  no_price: { error: NoPrice, trade: "stop", safe: "stop" },
  // Refused by the host before it ran anything.
  engine_busy: { error: EngineBusy, trade: "retry", safe: "retry" },
  // The call may have reached the host before the answer was lost.
  engine_unavailable: { error: Unavailable, tradeError: APIError, trade: "maybe_sent", safe: "retry" },
  engine_timeout: { error: Unavailable, tradeError: APIError, trade: "maybe_sent", safe: "retry" },
  // Only from the fresh read a trade makes before recording anything, checked against the key again.
  terminal_timeout: { error: TerminalTimeout, trade: "retry", safe: "retry" },
};

/** A code the SDK doesn't know: a 5xx may have reached the host, a 4xx was refused. */
export function unknownCodePolicy(status: number): CodePolicy {
  return status >= 500
    ? { error: APIError, trade: "maybe_sent", safe: "retry" }
    : { error: APIError, trade: "stop", safe: "stop" };
}

export function policyFor(code: string, status: number): CodePolicy {
  return Object.hasOwn(CODE_POLICIES, code) ? CODE_POLICIES[code as ErrorCode] : unknownCodePolicy(status);
}
