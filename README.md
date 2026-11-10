# pipsocket

TypeScript client for the Pipsocket API: REST and WebSocket access to MetaTrader 5 accounts hosted by Pipsocket.

> This is an alpha. It has every REST call. The stream helper comes in the next release.

## Why

Pipsocket runs each MT5 terminal for you and gives it an API, so your code runs anywhere Node runs.

|         | MetaQuotes' MetaTrader5 package (Python)                                                    | pipsocket                                                               |
| ------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Runs on | Windows only (its wheels on PyPI are all `win_amd64`, version 5.0.6231, checked 9 Nov 2026) | Linux, macOS, Windows, any server runtime                               |
| Needs   | An MT5 terminal running on the same machine                                                 | A Pipsocket account ($15 per account per month); the terminal is hosted |

- One install, no runtime dependencies for REST (it uses the built-in `fetch`).
- Typed answers, generated from the API's own OpenAPI document.
- Retries that are safe: the client knows which answers are worth another try.

## Install

```bash
npm install pipsocket
```

Node 22 or later. ESM only, with type declarations.

## Quickstart

Make your workspace's key on the dashboard's **API key** page, and keep it on your server:

```bash
export PIPSOCKET_KEY=psk_...
```

Then read the account, place an order on a demo account, handle its outcome, and close what it opened. The order carries a `magic` number of your own, so the script closes only its own positions:

```ts
import { Pipsocket } from "pipsocket";

const ps = new Pipsocket(); // reads PIPSOCKET_KEY
const acct = ps.account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");

const account = await acct.get();
console.log(account.status, account.balance, account.currency);

const MAGIC = 4021; // this script's own number, kept by MT5 on its orders, deals and positions

let order = await acct.orders.place({ symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "ioc", magic: MAGIC });
if (order.kind === "pending" || order.kind === "unknown") order = await acct.requests.wait(order.id);

switch (order.kind) {
  case "completed":
  case "partial": {
    console.log("filled: deal", order.result.deal);
    // Close the position this order opened: on this symbol, with this script's magic number.
    for (const position of await acct.positions.list()) {
      if (position.symbol !== "EURUSD" || position.magic !== MAGIC) continue;
      const close = await acct.positions.close(position.ticket, { volume: position.volume, type_filling: "ioc" });
      console.log("close", position.ticket, close.state);
    }
    break;
  }
  case "placed":
    console.log("placed, not filled yet: order", order.result.order);
    break;
  case "rejected":
    console.log("rejected:", order.result.retcode_name);
    break;
  case "not_sent":
  case "not_executed":
    console.log("not executed:", order.message);
    break;
  case "executed":
    console.log("executed, as settled by an owner or admin:", order.message);
    break;
  default:
    // Still pending or unknown after the wait, or a state this version doesn't know: it may have
    // executed, so read positions and history before trading again.
    console.log("outcome not known yet:", order.state);
}
```

Every call is for one account, so the client gives you a handle per account. Field names are the API's own (`type_filling`, `price_open`), as in the [API reference](https://docs.pipsocket.com).

## Every call

| Call                                                                                                                                                                                                                                          | Method                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [The account](https://docs.pipsocket.com/api/account)                                                                                                                                                                                         | `acct.get()`                                                                                                                                                |
| [Positions](https://docs.pipsocket.com/api/positions)                                                                                                                                                                                         | `acct.positions.list()`                                                                                                                                     |
| [Close a position](https://docs.pipsocket.com/api/close-a-position), [close by](https://docs.pipsocket.com/api/close-by), [set stops](https://docs.pipsocket.com/api/set-stops)                                                               | `acct.positions.close(ticket, { volume, type_filling })`, `acct.positions.closeBy(ticket, { position_by })`, `acct.positions.setLevels(ticket, { sl, tp })` |
| [Pending orders](https://docs.pipsocket.com/api/pending-orders)                                                                                                                                                                               | `acct.orders.list()`                                                                                                                                        |
| [Place](https://docs.pipsocket.com/api/place-an-order), [check](https://docs.pipsocket.com/api/check-an-order), [modify](https://docs.pipsocket.com/api/modify-an-order) or [cancel](https://docs.pipsocket.com/api/cancel-an-order) an order | `acct.orders.place(order)`, `acct.orders.check(order)`, `acct.orders.modify(ticket, changes)`, `acct.orders.cancel(ticket)`                                 |
| [Look up a request](https://docs.pipsocket.com/api/look-up-a-request)                                                                                                                                                                         | `acct.requests.get(id)`, and `acct.requests.wait(id)` until it is final                                                                                     |
| [Deal and order history](https://docs.pipsocket.com/api/history)                                                                                                                                                                              | `acct.history.deals({ from, to })`, `acct.history.orders({ from, to })`                                                                                     |
| [Symbols and prices](https://docs.pipsocket.com/api/symbols)                                                                                                                                                                                  | `acct.symbols.list()`, `acct.symbols.get(name)`, `acct.symbols.tick(name)`                                                                                  |
| [Kill switch](https://docs.pipsocket.com/api/kill-switch)                                                                                                                                                                                     | `acct.killSwitch.get()`, `acct.killSwitch.engage({ deviation })`, `acct.killSwitch.lift()`                                                                  |

History ranges are the broker's server time in whole seconds, not UTC, both ends included:

```ts
import { Pipsocket } from "pipsocket";

const acct = new Pipsocket().account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");

const { server_time } = await acct.get();
const now = server_time ?? 0;
const deals = await acct.history.deals({ from: now - 86_400, to: now });
console.log(deals.length, "deals in the last day");
```

Every call takes an options object last: `{ signal, timeoutMs, maxRetries }`, and the six trade calls also `idempotencyKey`.

## Order outcomes

A trade call returns a `TradeRequest` for every answer that is a recorded request, whatever its state, rejections included. `kind` is the state, closed so that a `switch` on it narrows `result`; `state` is the API's own string. See [request ids](https://docs.pipsocket.com/accounts#request-ids) and [errors](https://docs.pipsocket.com/errors).

| `kind`                           | Meaning                                                                           | `result`                                 |
| -------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| `completed`, `placed`, `partial` | MT5 took it. `partial` is final for that request                                  | MT5's answer: `retcode`, `deal`, `order` |
| `rejected`                       | MT5 rejected it. Final: change it and send it again (a new call, a new key)       | MT5's answer: `retcode_name` says why    |
| `pending`                        | No answer from the trade server within 5 s. Never sent again: `requests.wait(id)` | `null`                                   |
| `unknown`                        | No answer within 130 s. It may have executed: check positions and history         | `null`                                   |
| `not_sent`                       | The terminal didn't send it. Call again to send it                                | `{ error, message }`                     |
| `not_executed`                   | Was unknown, settled as never executed (`settlement` says by whom)                | `{ error, message }`, or who settled it  |
| `executed`                       | Was unknown, settled as executed by an owner or admin                             | Who settled it, and why                  |
| `unrecognised`                   | A state this version doesn't know yet: read `state`                               | as sent                                  |

`isAccepted(request)`, `isFinal(request)` and `isOutstanding(request)` answer the common questions, and `throwForState(request)` throws `TradeNotAccepted` for `rejected`, `not_sent` and `not_executed`, if you would rather have exceptions.

`requests.wait(id, { timeoutMs })` looks the request up until it is final or the timeout passes (30 s by default), then returns it as it stands. It never throws for "still pending", and it sends nothing but lookups.

## Retries and idempotency keys

Every trade call sends an `Idempotency-Key`, and every retry inside the call sends the same one, so a trade is never sent twice. Calling the method again is a new trade, with a new key.

When an attempt may have reached the account's host and no recorded request comes back (the connection dropped, `503 engine_unavailable`, `504 engine_timeout`), the call retries with the same key: that returns the request if the host recorded it, and sends it if it never arrived. If the retries run out, it throws `OutcomeUnknown`, with the key on it. The trade may or may not have been sent: call again with `idempotencyKey: error.idempotencyKey` (it returns the request, or sends the trade), or read positions and history first. Once an attempt may have been sent, the call never reports that nothing was sent.

To survive a crash or a cancelled call, make the key yourself and save it before sending:

```ts
import { newKey, OutcomeUnknown, Pipsocket } from "pipsocket";

const acct = new Pipsocket().account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");

const key = newKey();
// Save the key with what it is for (a database row, a file) before sending.
try {
  const order = await acct.orders.place(
    { symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "ioc" },
    { idempotencyKey: key },
  );
  console.log(order.state);
} catch (error) {
  if (!(error instanceof OutcomeUnknown)) throw error;
  // Later, or after a restart: the same call with the same key returns the recorded request.
  const order = await acct.orders.place(
    { symbol: "EURUSD", type: "buy", volume: 0.01, type_filling: "ioc" },
    { idempotencyKey: key },
  );
  console.log(order.state);
}
```

A key matches the first request made with it, whatever the body: never build keys from the order (such as `"buy-eurusd"`), and never reuse one for a different trade. A key protects its request for 7 days after the outcome is known.

## Errors and retries

When a call can't give you its answer, it throws. Every error is a `PipsocketError`, and every error a trade call throws carries the `idempotencyKey` it sent:

| Error                                                       | When                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OutcomeUnknown`                                            | A trade may have been sent and no recorded request came back: see [retries and idempotency keys](#retries-and-idempotency-keys)                         |
| `APIConnectionError`, `APITimeoutError`                     | The network failed, or an attempt took longer than `timeoutMs`                                                                                          |
| `AuthenticationError`                                       | 401: the key is missing, wrong, or was rolled                                                                                                           |
| `NotFound`                                                  | 404: no such account, order, position, request or symbol                                                                                                |
| `InvalidRequest`, `RangeTooLarge`                           | 400 or 422: fix the call. Nothing was sent                                                                                                              |
| `SymbolBusy`                                                | 409: an earlier request on the symbol has no outcome yet. `blocking` lists them; `retryAfter` is null when one is `unknown`. Nothing was sent           |
| `KillSwitchEngaged`, `BillingHold`                          | 423: new exposure is refused. Nothing was sent                                                                                                          |
| `AccountUnavailable`                                        | 503: the account's terminal isn't connected, is restarting, or needs a restart. On engaging the kill switch, `killSwitch` shows it engaged all the same |
| `Unavailable`                                               | 503 `engine_unavailable` or 504 `engine_timeout` on a call that is safe to repeat, after the retries                                                    |
| `EngineBusy`, `TerminalTimeout`, `TerminalError`, `NoPrice` | The host or the terminal couldn't answer                                                                                                                |
| `APIError`                                                  | Any other refusal: `status`, `code`, `body` and `raw` say what came back                                                                                |
| `TradeNotAccepted`                                          | Only from `throwForState(request)`, for a request that was rejected, not sent or not executed                                                           |

```ts
import { AccountUnavailable, Pipsocket } from "pipsocket";

const acct = new Pipsocket().account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");

try {
  console.log(await acct.positions.list());
} catch (error) {
  if (error instanceof AccountUnavailable) console.log("The terminal isn't running:", error.code);
  else throw error;
}
```

The client retries what is worth retrying, twice by default, and starts no new attempt 60 seconds after the first: a lost connection, `503 engine_unavailable`, `504 engine_timeout`, `503 engine_busy`, `504 terminal_timeout`, and `409 symbol_busy` with a `Retry-After`, waiting 0.5 s and then 1 s (with jitter) between attempts, or what `Retry-After` says. It never retries a refusal that won't change, such as a 401 or a 404, and never retries a recorded request: a `rejected` or `not_sent` one is returned. See [Errors and retcodes](https://docs.pipsocket.com/errors) for every code.

| Option            | Default                     |                                                                                                                                                         |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`          | `PIPSOCKET_KEY`             | Never logged and never in an error message                                                                                                              |
| `timeoutMs`       | `40000`                     | Per attempt. The API itself waits up to 30 s for the account's host                                                                                     |
| `maxRetries`      | `2`                         | `0` turns retries off                                                                                                                                   |
| `retryDeadlineMs` | `60000`                     | No new attempt starts this long after the first                                                                                                         |
| `baseUrl`         | `https://api.pipsocket.com` | For a mock server in your own tests                                                                                                                     |
| `fetch`           | the runtime's `fetch`       | A custom one must make one attempt per call and follow no redirects. Its failures count as possibly sent unless it marks them with `markNotSent(error)` |

Cancel a call with an `AbortSignal`: the call throws the signal's reason as it is, and sends nothing more. A trade that was already written may still execute, so for a call you may cancel, make and save the key first, as above.

## Runtimes

| Runtime            | REST          |
| ------------------ | ------------- |
| Node 22 and later  | yes           |
| Bun, Deno          | yes           |
| Cloudflare Workers | yes           |
| Browsers           | no, by design |

The client refuses to start in a browser: the API doesn't answer browsers' cross-origin requests, and an API key in a web page would leak. Call the API from your server.

## Links

- [Quickstart](https://docs.pipsocket.com/quickstart), [API reference](https://docs.pipsocket.com), [WebSocket stream](https://docs.pipsocket.com/websocket), [Errors and retcodes](https://docs.pipsocket.com/errors)
- [Examples](https://github.com/pipsocket/examples)
- [The MCP server](https://github.com/pipsocket/mcp)

## Versioning

Versions follow [semver](https://semver.org) and stay below 1.0 for now, so a minor version may change the API. [CHANGELOG.md](CHANGELOG.md) lists every change and the API document each release was built from.

## Support

Report SDK bugs in [this repository's issues](https://github.com/pipsocket/pipsocket-node/issues). For your account, billing or a trade, write to support@pipsocket.com. Security issues: see [SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).

MetaTrader is a trademark of MetaQuotes Ltd. Pipsocket is not affiliated with MetaQuotes.
