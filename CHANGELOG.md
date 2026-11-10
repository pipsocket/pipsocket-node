# Changelog

Every release names the snapshot of the API document it was built from: the date it was fetched from https://docs.pipsocket.com/openapi.json, and the SHA-256 of that file as published.

## 0.1.0 (10 Nov 2026)

API document: fetched 9 Nov 2026, SHA-256 `49150e755dd081e7923f245174a88360561066076f8a89e637b9e91c69d10d75` (unchanged, and checked against the published document on 10 Nov 2026).

The first full release: every REST call and the stream helper. Versions stay 0.x for now, so a minor release may still change the API.

### Added

- The six trade calls: `orders.place`, `orders.modify`, `orders.cancel`, `positions.setLevels`, `positions.close` and `positions.closeBy`. Each returns a `TradeRequest` for every recorded request, rejections included, and sends one `Idempotency-Key` on every attempt.
- `orders.check`, `killSwitch.engage` and `killSwitch.lift`.
- `requests.wait(id, { timeoutMs })`: looks a request up until it is final or the timeout passes.
- `newKey()`, and `idempotencyKey` on the trade calls, to save a key before sending.
- `acct.stream({ ticks })`: the account's events as an async iterable, with `setTicks` and `close`. It reconnects with backoff, sets the ticks again, keeps the socket alive, and after every connect and gap yields a `resync` event with a fresh snapshot and the history read back since its checkpoint. On Node it uses the `ws` package, an optional peer dependency.
- `OutcomeUnknown`: a trade call that may have reached the account's host, with no recorded request back, throws it with the key.

### Changed

- A trade call reads an error code its operation doesn't document as an unknown code: a 5xx may have reached the account's host, so it is retried with the same key and ends as `OutcomeUnknown`.
- An answer that breaks off part way is an `APIConnectionError` carrying `status` and the part of the body that arrived.

### Fixed

- After `stream.close()`, the stream yields nothing more: events still queued are dropped, and a `for await` loop that calls `close()` ends on its next turn.
- The README no longer treats `completed` as filled (a pending order, a modify or a cancel can be `completed` too; a fill has a non-zero `result.deal`), and its examples take the filling mode and volume from the symbol instead of hardcoding them.

## 0.1.0-alpha.1

API document: fetched 9 Nov 2026, SHA-256 `49150e755dd081e7923f245174a88360561066076f8a89e637b9e91c69d10d75`.

### Added

- `Pipsocket`, the client, and `ps.account(id)`, a handle for one account.
- Every read call: `get`, `positions.list`, `orders.list`, `requests.get`, `history.deals`, `history.orders`, `symbols.list`, `symbols.get`, `symbols.tick` and `killSwitch.get`.
- Types for every answer, generated from the API document. Enums in answers are open, so a value the API adds later still type-checks.
- `TradeRequest`, a union closed on `kind`, with `isAccepted`, `isFinal`, `isOutstanding`, `throwForState` and `toTradeRequest`.
- An error class for every error code the API has, and retries for the answers worth another try.
