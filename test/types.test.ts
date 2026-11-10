// Type-level contracts, checked by `pnpm typecheck` (tsc over test/) and by vitest's expectTypeOf.

import { describe, expectTypeOf, test } from "vitest";
import type {
  ErrorBody,
  HandSettlement,
  PlaceOrderBody,
  PositionView,
  SentRequest,
  SymbolView,
  TradeRequest,
  TradeResult,
} from "../src/index.js";

describe("enums", () => {
  test("enums in answers are open: a value the API adds later is still a valid answer", () => {
    expectTypeOf<"a_side_added_later">().toExtend<PositionView["type"]>();
    expectTypeOf<"a_mode_added_later">().toExtend<SymbolView["filling_modes"][number]>();
    expectTypeOf<"a_type_added_later">().toExtend<SentRequest["type"]>();
    // Open, but the known values still autocomplete: the type isn't plain string.
    expectTypeOf<PositionView["type"]>().not.toEqualTypeOf<string>();
  });

  test("enums in requests are closed: a typo is a type error", () => {
    expectTypeOf<"buy">().toExtend<PlaceOrderBody["type"]>();
    expectTypeOf<"bye">().not.toExtend<PlaceOrderBody["type"]>();
    expectTypeOf<"iok">().not.toExtend<PlaceOrderBody["type_filling"]>();
    const order = (body: PlaceOrderBody) => body;
    // @ts-expect-error: "iok" is not a filling mode.
    order({ symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "iok" });
  });
});

describe("TradeRequest", () => {
  test("a switch on kind narrows result", () => {
    const handle = (request: TradeRequest) => {
      switch (request.kind) {
        case "completed":
        case "placed":
        case "partial":
        case "rejected":
          expectTypeOf(request.result).toEqualTypeOf<TradeResult>();
          return request.result.retcode_name;
        case "not_sent":
          expectTypeOf(request.result).toEqualTypeOf<ErrorBody>();
          return request.result.error;
        case "not_executed":
          expectTypeOf(request.result).toEqualTypeOf<ErrorBody | HandSettlement>();
          return request.settlement;
        case "executed":
          expectTypeOf(request.result).toEqualTypeOf<HandSettlement>();
          return request.result.settled_by;
        case "pending":
        case "unknown":
          expectTypeOf(request.result).toEqualTypeOf<null>();
          return null;
        case "unrecognised":
          expectTypeOf(request.result).toEqualTypeOf<unknown>();
          return request.state;
        default: {
          // Exhaustive: every kind is handled above.
          const none: never = request;
          return none;
        }
      }
    };
    expectTypeOf(handle).returns.not.toBeNever();
  });

  test("state stays the wire's plain string", () => {
    expectTypeOf<TradeRequest["state"]>().toEqualTypeOf<string>();
  });
});
