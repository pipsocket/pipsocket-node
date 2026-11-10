import { isRecord, PipsocketError } from "./errors.js";
import { REQUEST_STATES, type RequestState } from "./generated/tables.js";
import type { ErrorBody, HandSettlement, RequestView, SentRequest, TradeResult } from "./types.js";

/** `kind`: a request's state when this SDK knows it, or `"unrecognised"` for a state added later. */
export type TradeRequestKind = RequestState | "unrecognised";

interface TradeRequestBase<Kind extends TradeRequestKind, Result> {
  /** Closed: a `switch` on it narrows `result`. */
  kind: Kind;
  /** The request's id (the wire's `request`). */
  id: string;
  /** The wire's state, untouched: one of the known states, or anything a newer API sends. */
  state: string;
  sent: SentRequest;
  result: Result;
  message: string;
  error?: string | null;
  settlement?: RequestView["settlement"];
  /** The key the trade call sent. Unset on lookups and stream events: the wire never carries it. */
  idempotencyKey?: string;
  /** The HTTP status of the answer it came from. Unset for stream events. */
  httpStatus?: number;
  /** The whole body, untouched. */
  raw: Record<string, unknown>;
}

/**
 * A recorded trade request, whatever its state. A trade call returns one for every answer that is a
 * recorded request, rejections included; an exception means no recorded request is in hand.
 */
export type TradeRequest =
  | TradeRequestBase<"completed", TradeResult>
  | TradeRequestBase<"placed", TradeResult>
  | TradeRequestBase<"partial", TradeResult>
  | TradeRequestBase<"rejected", TradeResult>
  | TradeRequestBase<"not_sent", ErrorBody>
  | TradeRequestBase<"not_executed", ErrorBody | HandSettlement>
  | TradeRequestBase<"executed", HandSettlement>
  | TradeRequestBase<"pending", null>
  | TradeRequestBase<"unknown", null>
  | TradeRequestBase<"unrecognised", unknown>;

const KNOWN_STATES: ReadonlySet<string> = new Set(REQUEST_STATES);
const ACCEPTED: ReadonlySet<TradeRequestKind> = new Set(["completed", "placed", "partial"]);
const OUTSTANDING: ReadonlySet<TradeRequestKind> = new Set(["pending", "unknown"]);
const FINAL: ReadonlySet<TradeRequestKind> = new Set([
  "completed",
  "placed",
  "partial",
  "rejected",
  "not_sent",
  "not_executed",
  "executed",
]);
const NOT_ACCEPTED: ReadonlySet<TradeRequestKind> = new Set(["rejected", "not_sent", "not_executed"]);

/** The one check the SDK makes on a body: a JSON object with a string `request` and `state`. */
export function isRecordedRequest(body: unknown): body is Record<string, unknown> & RequestView {
  return isRecord(body) && typeof body.request === "string" && typeof body.state === "string";
}

export function tradeRequestFrom(
  body: Record<string, unknown> & RequestView,
  details: { httpStatus?: number; idempotencyKey?: string } = {},
): TradeRequest {
  const kind = KNOWN_STATES.has(body.state) ? (body.state as RequestState) : "unrecognised";
  const request = {
    kind,
    id: body.request,
    state: body.state,
    sent: body.sent,
    result: body.result ?? null,
    message: body.message,
    error: body.error,
    settlement: body.settlement,
    raw: body,
  } as TradeRequest;
  if (details.idempotencyKey !== undefined) request.idempotencyKey = details.idempotencyKey;
  if (details.httpStatus !== undefined) request.httpStatus = details.httpStatus;
  return request;
}

/**
 * Turns a stream `request` event into a TradeRequest. It has no idempotency key and no HTTP status.
 * Throws a TypeError if the message isn't a recorded request.
 */
export function toTradeRequest(event: unknown): TradeRequest {
  if (!isRecordedRequest(event)) {
    throw new TypeError("Not a request event: it needs a string request and a string state");
  }
  return tradeRequestFrom(event);
}

/** MT5 took the request: completed, placed or partial. */
export function isAccepted(request: TradeRequest): boolean {
  return ACCEPTED.has(request.kind);
}

/** Nothing more will happen to the request. */
export function isFinal(request: TradeRequest): boolean {
  return FINAL.has(request.kind);
}

/** Sent, with no outcome yet: pending or unknown. */
export function isOutstanding(request: TradeRequest): boolean {
  return OUTSTANDING.has(request.kind);
}

/** Raised by `throwForState` for a request that was rejected, not sent, or settled as not executed. */
export class TradeNotAccepted extends PipsocketError {
  readonly request: TradeRequest;

  constructor(request: TradeRequest) {
    super(`Request ${request.id} was not accepted: ${request.state}: ${request.message}`);
    this.request = request;
  }
}

/** Throws TradeNotAccepted for `rejected`, `not_sent` and `not_executed`; returns the request otherwise. */
export function throwForState<T extends TradeRequest>(
  request: T,
): Exclude<T, { kind: "rejected" | "not_sent" | "not_executed" }> {
  if (NOT_ACCEPTED.has(request.kind)) throw new TradeNotAccepted(request);
  return request as Exclude<T, { kind: "rejected" | "not_sent" | "not_executed" }>;
}
