# Contributing

Thanks for helping. Bugs and ideas go in [the issues](https://github.com/pipsocket/pipsocket-node/issues); questions about your account go to support@pipsocket.com.

## Setting up

You need Node 22 or later and pnpm (the version is in `package.json`, `packageManager`).

```bash
pnpm install
pnpm check   # lint, types, generated code, tests
```

No test talks to Pipsocket. They use a scripted `fetch`, a fake clock and a mock of the API built from the document's own examples, so they need no key and no account. Please keep it that way.

## How the code is laid out

- `openapi.json`: a snapshot of the published API document. It changes only through the daily job (`.github/workflows/spec.yml`), which opens a pull request, or by hand with `node scripts/spec.mjs update <file>`.
- `src/generated/`: types and tables generated from the snapshot by `pnpm generate`. Never edit them by hand; CI fails when they are stale.
- Everything else in `src/` is handwritten. It imports the generated code, never the other way round.
  - `attempt.ts`: one HTTP attempt, and whether it reached the server.
  - `core.ts` and `policy.ts`: what each answer means, and whether to try again. No I/O.
  - `client.ts`: the client, the account handle and the retry loop.
  - `trade-request.ts`, `errors.ts`, `types.ts`: what callers get back.
- `conformance/`: language-neutral cases shared with the Python SDK. Every case runs through the real client. Change both copies together; new cases go in `conformance/extra-cases.json`.

## Rules that matter here

- A retry never changes the `Idempotency-Key`, the method, the URL or the body.
- Once an attempt of a trade call may have reached the account's host, the call never reports that nothing was sent.
- Field names stay exactly as the API sends them (`type_filling`, `position_by`).
- When the API document gains an operation, an error code or a request state, a contract test fails until the SDK handles it.

## Pull requests

Keep each one to one change, with its tests, and add a line to `CHANGELOG.md` under the next version (Added, Changed, Fixed or Spec).
