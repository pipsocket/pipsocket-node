# pipsocket

TypeScript client for the Pipsocket API: REST and WebSocket access to MetaTrader 5 accounts hosted by Pipsocket.

> This is an alpha. It has every read call: the account, positions, pending orders, history, symbols, prices, the kill switch's state and request lookups. Trade calls and the stream helper come in the next releases.

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

```ts
import { Pipsocket } from "pipsocket";

const ps = new Pipsocket(); // reads PIPSOCKET_KEY
const acct = ps.account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");

const account = await acct.get();
console.log(account.status, account.balance, account.currency);

const eurusd = await acct.symbols.get("EURUSD");
console.log(eurusd.filling_modes, eurusd.volume_min);

const tick = await acct.symbols.tick("EURUSD");
console.log(tick.bid, tick.ask);

for (const position of await acct.positions.list()) {
  console.log(position.ticket, position.symbol, position.type, position.volume);
}
```

Every call is for one account, so the client gives you a handle per account. Field names are the API's own (`type_filling`, `price_open`), as in the [API reference](https://docs.pipsocket.com).

## Every call

| Call                                                                  | Method                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [The account](https://docs.pipsocket.com/api/account)                 | `acct.get()`                                                               |
| [Positions](https://docs.pipsocket.com/api/positions)                 | `acct.positions.list()`                                                    |
| [Pending orders](https://docs.pipsocket.com/api/pending-orders)       | `acct.orders.list()`                                                       |
| [Look up a request](https://docs.pipsocket.com/api/look-up-a-request) | `acct.requests.get(id)`                                                    |
| [Deal and order history](https://docs.pipsocket.com/api/history)      | `acct.history.deals({ from, to })`, `acct.history.orders({ from, to })`    |
| [Symbols and prices](https://docs.pipsocket.com/api/symbols)          | `acct.symbols.list()`, `acct.symbols.get(name)`, `acct.symbols.tick(name)` |
| [Kill switch](https://docs.pipsocket.com/api/kill-switch)             | `acct.killSwitch.get()`                                                    |

History ranges are the broker's server time in whole seconds, not UTC, both ends included:

```ts
import { Pipsocket } from "pipsocket";

const acct = new Pipsocket().account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");

const { server_time } = await acct.get();
const now = server_time ?? 0;
const deals = await acct.history.deals({ from: now - 86_400, to: now });
console.log(deals.length, "deals in the last day");
```

Every call takes an options object last: `{ signal, timeoutMs, maxRetries }`.

## Errors and retries

When a call can't give you its answer, it throws. Every error is a `PipsocketError`:

| Error                                                       | When                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `APIConnectionError`, `APITimeoutError`                     | The network failed, or an attempt took longer than `timeoutMs`                 |
| `AuthenticationError`                                       | 401: the key is missing, wrong, or was rolled                                  |
| `NotFound`                                                  | 404: no such account, request or symbol                                        |
| `InvalidRequest`, `RangeTooLarge`                           | 400 or 422: fix the call                                                       |
| `AccountUnavailable`                                        | 503: the account's terminal isn't connected, is restarting, or needs a restart |
| `Unavailable`                                               | 503 `engine_unavailable` or 504 `engine_timeout`, after the retries            |
| `EngineBusy`, `TerminalTimeout`, `TerminalError`, `NoPrice` | The host or the terminal couldn't answer                                       |
| `APIError`                                                  | Any other refusal: `status`, `code`, `body` and `raw` say what came back       |

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

The client retries what is worth retrying, twice by default, and starts no new attempt 60 seconds after the first: a lost connection, `503 engine_unavailable`, `504 engine_timeout`, `503 engine_busy` and `504 terminal_timeout`, waiting 0.5 s and then 1 s (with jitter) between attempts. It never retries a refusal that won't change, such as a 401 or a 404. See [Errors and retcodes](https://docs.pipsocket.com/errors) for every code.

| Option            | Default                     |                                                                     |
| ----------------- | --------------------------- | ------------------------------------------------------------------- |
| `apiKey`          | `PIPSOCKET_KEY`             | Never logged and never in an error message                          |
| `timeoutMs`       | `40000`                     | Per attempt. The API itself waits up to 30 s for the account's host |
| `maxRetries`      | `2`                         | `0` turns retries off                                               |
| `retryDeadlineMs` | `60000`                     | No new attempt starts this long after the first                     |
| `baseUrl`         | `https://api.pipsocket.com` | For a mock server in your own tests                                 |
| `fetch`           | the runtime's `fetch`       |                                                                     |

Cancel a call with an `AbortSignal`: the call throws the signal's reason as it is, and sends nothing more.

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
- [The MCP server](https://github.com/pipsocket/mcp), for AI apps

## Versioning

Versions follow [semver](https://semver.org) and stay below 1.0 for now, so a minor version may change the API. [CHANGELOG.md](CHANGELOG.md) lists every change and the API document each release was built from.

## Support

Report SDK bugs in [this repository's issues](https://github.com/pipsocket/pipsocket-node/issues). For your account, billing or a trade, write to support@pipsocket.com. Security issues: see [SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).

MetaTrader is a trademark of MetaQuotes Ltd. Pipsocket is not affiliated with MetaQuotes.
