// The stream's messages, as the WebSocket docs describe them. The stream isn't in the OpenAPI
// document, so these are handwritten. They are hints: the helper passes every message on as it came,
// a type it doesn't know included.

import type { DealView, RequestView } from "../types.js";
import type { ResyncEvent, StreamMessage } from "./machine.js";

/** A trade request settled, however it was sent. The fields are a request lookup's. */
export type RequestMessage = { type: "request" } & RequestView;

/** A deal on the account: a fill, a close, a stop loss or take profit, a balance operation. */
export interface DealMessage {
  type: "deal";
  deal: DealView;
}

/** MT5's trade transaction: orders and positions changing. */
export interface TransactionMessage {
  type: "transaction";
  /** MT5's transaction type, such as `deal_add` or `position`. */
  transaction: string | null;
  order: number | null;
  deal: number | null;
  position: number | null;
  position_by: number | null;
  symbol: string | null;
  order_type: string | null;
  order_state: string | null;
  deal_type: string | null;
  volume: number | null;
  price: number | null;
  sl: number | null;
  tp: number | null;
}

/** The account, every second. */
export interface AccountMessage {
  type: "account";
  connected: boolean | null;
  trade_allowed: boolean | null;
  balance: number | null;
  equity: number | null;
  credit: number | null;
  margin: number | null;
  margin_free: number | null;
  positions: number | null;
  orders: number | null;
  /** Broker server time, in seconds. */
  server_time: number | null;
}

/** The account's status changed. */
export interface StatusMessage {
  type: "status";
  status: string;
  detail: string | null;
}

/** A price change of a symbol in the tick set. */
export interface TickMessage {
  type: "tick";
  symbol: string;
  time_msc: number | null;
  bid: number;
  ask: number;
  last: number | null;
  volume: number | null;
  flags: number | null;
}

/** The stream fell behind and dropped events. A resync follows. */
export interface LaggedMessage {
  type: "lagged";
  missed: number;
}

/** The account's host lost its connection to Pipsocket. A resync follows when it is back. */
export interface EngineDisconnectedMessage {
  type: "engine_disconnected";
}

/** The events whose shape this version knows. */
export type KnownEvent =
  | ResyncEvent
  | RequestMessage
  | DealMessage
  | TransactionMessage
  | AccountMessage
  | StatusMessage
  | TickMessage
  | LaggedMessage
  | EngineDisconnectedMessage;

/** What the stream yields: the API's messages as they are, and the helper's resync event. */
export type StreamEvent = KnownEvent | StreamMessage;

/**
 * Narrows an event by its type. A plain `event.type === "tick"` can't narrow, because a message of
 * a type added later is also passed on, typed as any object with a string `type`.
 *
 * ```ts
 * if (isEvent(event, "tick")) console.log(event.bid)
 * ```
 */
export function isEvent<T extends KnownEvent["type"]>(
  event: StreamEvent,
  type: T,
): event is Extract<KnownEvent, { type: T }> {
  return event.type === type;
}
