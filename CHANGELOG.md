# Changelog

Every release names the snapshot of the API document it was built from: the date it was fetched from https://docs.pipsocket.com/openapi.json, and the SHA-256 of that file as published.

## Unreleased

### Added

- The six trade calls: `orders.place`, `orders.modify`, `orders.cancel`, `positions.setLevels`, `positions.close` and `positions.closeBy`. Each returns a `TradeRequest` for every recorded request, rejections included, and sends one `Idempotency-Key` on every attempt.
- `orders.check`, `killSwitch.engage` and `killSwitch.lift`.
- `requests.wait(id, { timeoutMs })`: looks a request up until it is final or the timeout passes.
- `newKey()`, and `idempotencyKey` on the trade calls, to save a key before sending.
- `OutcomeUnknown`: a trade call that may have reached the account's host, with no recorded request back, throws it with the key.

## 0.1.0-alpha.1

API document: fetched 9 Nov 2026, SHA-256 `49150e755dd081e7923f245174a88360561066076f8a89e637b9e91c69d10d75`.

### Added

- `Pipsocket`, the client, and `ps.account(id)`, a handle for one account.
- Every read call: `get`, `positions.list`, `orders.list`, `requests.get`, `history.deals`, `history.orders`, `symbols.list`, `symbols.get`, `symbols.tick` and `killSwitch.get`.
- Types for every answer, generated from the API document. Enums in answers are open, so a value the API adds later still type-checks.
- `TradeRequest`, a union closed on `kind`, with `isAccepted`, `isFinal`, `isOutstanding`, `throwForState` and `toTradeRequest`.
- An error class for every error code the API has, and retries for the answers worth another try.
