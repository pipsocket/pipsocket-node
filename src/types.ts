// Named types for the API's schemas. Each is an alias of the generated type, so a rename in the
// document shows up here as a type error instead of a silent change for users.

import type { components } from "./generated/schema.js";

type Schemas = components["schemas"];

export type AccountView = Schemas["AccountView"];
export type Blocking = Schemas["Blocking"];
export type CheckResult = Schemas["CheckResult"];
export type CheckView = Schemas["CheckView"];
export type DealView = Schemas["DealView"];
export type ErrorBody = Schemas["ErrorBody"];
export type HandSettlement = Schemas["HandSettlement"];
export type HistoryOrderView = Schemas["HistoryOrderView"];
export type KillSwitchNotConnected = Schemas["KillSwitchNotConnected"];
export type KillSwitchOutcome = Schemas["KillSwitchOutcome"];
export type KillSwitchView = Schemas["KillSwitchView"];
export type PendingOrderView = Schemas["PendingOrderView"];
export type PositionView = Schemas["PositionView"];
export type Remaining = Schemas["Remaining"];
export type RequestView = Schemas["RequestView"];
export type SweptOrder = Schemas["SweptOrder"];
export type SweptPosition = Schemas["SweptPosition"];
export type SymbolBusyBody = Schemas["SymbolBusy"];
export type SymbolSummaryView = Schemas["SymbolSummaryView"];
export type SymbolView = Schemas["SymbolView"];
export type TickView = Schemas["TickView"];
export type TradeResult = Schemas["TradeResult"];
/** The MT5 trade request as Pipsocket sent it (a request's `sent`). */
export type SentRequest = Schemas["TradeRequest"];

// Request bodies: their enums are closed, so a typo is a type error.
export type CloseByBody = Schemas["CloseBy"];
export type ClosePositionBody = Schemas["ClosePosition"];
export type EngageKillSwitchBody = Schemas["EngageKillSwitch"];
export type ModifyOrderBody = Schemas["ModifyOrder"];
export type PlaceOrderBody = Schemas["PlaceOrder"];
export type PositionLevelsBody = Schemas["PositionLevels"];

export type Action = Schemas["Action"];
export type Filling = Schemas["Filling"];
export type OrderType = Schemas["OrderType"];
export type Settlement = Schemas["Settlement"];
export type TypeTime = Schemas["TypeTime"];
