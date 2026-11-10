import { attempt, type FetchLike, type HttpRequest } from "./attempt.js";
import { backoffMs, type CallKind, interpret } from "./core.js";
import { PipsocketError } from "./errors.js";
import type { TradeRequest } from "./trade-request.js";
import type {
  AccountView,
  DealView,
  HistoryOrderView,
  KillSwitchView,
  PendingOrderView,
  PositionView,
  SymbolSummaryView,
  SymbolView,
  TickView,
} from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.pipsocket.com";
export const DEFAULT_STREAM_URL = "wss://wss.pipsocket.com";

/** Time for retries and waits. Replace it in tests so nothing really waits. */
export interface Clock {
  /** Milliseconds, from any fixed point. */
  now(): number;
  /** Resolves after `ms`; rejects with `signal.reason`, unchanged, if the signal aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ClientOptions {
  /** Your workspace's API key. Defaults to the PIPSOCKET_KEY environment variable. */
  apiKey?: string;
  /** Defaults to https://api.pipsocket.com. */
  baseUrl?: string;
  /** Defaults to wss://wss.pipsocket.com. */
  streamUrl?: string;
  /** How long one attempt may take. Defaults to 40000 (the API itself waits up to 30 s). */
  timeoutMs?: number;
  /** Retries after the first attempt. Defaults to 2; 0 turns retries off. */
  maxRetries?: number;
  /** No new attempt starts this long after the first one. Defaults to 60000. */
  retryDeadlineMs?: number;
  /** The fetch to use. Defaults to the runtime's own. */
  fetch?: FetchLike;
  /** Defaults to the real clock. */
  clock?: Clock;
  /** A random number from 0 (included) to 1 (excluded), for the jitter between retries. */
  random?: () => number;
}

/** Options every call takes, as its last argument. */
export interface CallOptions {
  /** Aborting it stops the call: the abort reason is thrown as it is, and nothing more is sent. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

function runtimeName(): string {
  const scope = globalThis as {
    Bun?: { version?: string };
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { node?: string } };
    navigator?: { userAgent?: string };
  };
  if (scope.Bun?.version) return `bun/${scope.Bun.version}`;
  if (scope.Deno?.version?.deno) return `deno/${scope.Deno.version.deno}`;
  if (scope.process?.versions?.node) return `node/${scope.process.versions.node}`;
  return scope.navigator?.userAgent ?? "unknown";
}

function keyFromEnvironment(): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.PIPSOCKET_KEY;
  } catch {
    // Deno without --allow-env throws on reading the environment.
    return undefined;
  }
}

function inBrowser(): boolean {
  const scope = globalThis as { window?: unknown; document?: unknown };
  return typeof scope.window !== "undefined" && typeof scope.document !== "undefined";
}

function nonEmpty(name: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function wholeNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a whole number of 0 or more`);
  }
  return value;
}

type Send = (spec: CallSpec, options?: CallOptions) => Promise<unknown>;

/** What one call sends. `path` is under /v1/accounts/{account}. */
export interface CallSpec {
  call: CallKind;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

/**
 * The Pipsocket API client. Every call is for one account: get a handle with `account(id)`.
 *
 * ```ts
 * const ps = new Pipsocket() // reads PIPSOCKET_KEY
 * const acct = ps.account("acc_01m6tx3k9f2qw8r7bznd5yvh4c")
 * console.log(await acct.get())
 * ```
 */
export class Pipsocket {
  readonly baseUrl: string;
  readonly streamUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDeadlineMs: number;
  // Private fields stay out of console.log and util.inspect, so the key is never printed.
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #userAgent: string;

  constructor(options: ClientOptions = {}) {
    if (inBrowser()) {
      throw new PipsocketError(
        "Pipsocket can't run in a browser: the API doesn't answer browsers' cross-origin requests, and an API key in a web page would leak. Call the API from your server.",
      );
    }
    const apiKey = options.apiKey ?? keyFromEnvironment();
    if (!apiKey) {
      throw new PipsocketError("No API key: pass apiKey, or set the PIPSOCKET_KEY environment variable.");
    }
    // Checked here so that a malformed key never reaches fetch, whose header errors quote the value.
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new PipsocketError(
        "The API key isn't valid: it has spaces, line breaks or other characters a key never has.",
      );
    }
    this.#apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.streamUrl = (options.streamUrl ?? DEFAULT_STREAM_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 40_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDeadlineMs = options.retryDeadlineMs ?? 60_000;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#clock = options.clock ?? realClock;
    this.#random = options.random ?? Math.random;
    this.#userAgent = `pipsocket-node/${VERSION} ${runtimeName()}`;
  }

  /** A handle for one account, by its id (`acc_` and 26 characters). */
  account(id: string): Account {
    const accountId = nonEmpty("The account id", id);
    return new Account(accountId, (spec, options) => this.#send(accountId, spec, options));
  }

  /** Sends one call, with retries. */
  async #send(accountId: string, spec: CallSpec, options: CallOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "User-Agent": this.#userAgent,
      Accept: "application/json",
    };
    const request: HttpRequest = {
      method: spec.method,
      url: `${this.baseUrl}/v1/accounts/${encodeURIComponent(accountId)}${spec.path}`,
      headers,
    };
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(spec.body);
    }
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const { signal } = options;
    const clock = this.#clock;
    const deadline = clock.now() + this.retryDeadlineMs;
    const retriesFor = new Map<string, number>();
    let retries = 0;

    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const result = await attempt(this.#fetch, request, timeoutMs, signal);
      // A call cancelled while its attempt ran ends with the caller's reason, whatever came back.
      if (signal?.aborted) throw signal.reason;
      const verdict = interpret(result, spec.call);
      if (verdict.kind === "request") return verdict.request;
      if (verdict.kind === "json") return verdict.value;
      if (verdict.kind === "stop") throw verdict.error;

      const used = retriesFor.get(verdict.reason) ?? 0;
      if (retries >= maxRetries || (verdict.limit !== undefined && used >= verdict.limit)) throw verdict.error;
      const wait = verdict.retryAfterMs ?? backoffMs(retries + 1, this.#random());
      // A wait that would end after the deadline isn't waited for.
      if (clock.now() + wait > deadline) throw verdict.error;
      await clock.sleep(wait, signal);
      if (clock.now() > deadline) throw verdict.error;
      retries += 1;
      retriesFor.set(verdict.reason, used + 1);
    }
  }
}

/** The calls for one account. Get one with `Pipsocket.account(id)`. */
export class Account {
  readonly id: string;
  readonly #send: Send;

  /** Use `Pipsocket.account(id)` rather than this. */
  constructor(id: string, send: Send) {
    this.id = id;
    this.#send = send;
  }

  /** The account: login, status, connection, and balance, equity and margin. */
  async get(options?: CallOptions): Promise<AccountView> {
    return this.#send({ call: "read", method: "GET", path: "" }, options) as Promise<AccountView>;
  }

  readonly positions = {
    /** Open positions. */
    list: async (options?: CallOptions): Promise<PositionView[]> =>
      this.#send({ call: "read", method: "GET", path: "/positions" }, options) as Promise<PositionView[]>,
  };

  readonly orders = {
    /** Pending orders. */
    list: async (options?: CallOptions): Promise<PendingOrderView[]> =>
      this.#send({ call: "read", method: "GET", path: "/orders" }, options) as Promise<PendingOrderView[]>,
  };

  readonly requests = {
    /** A recorded trade request, by id, whatever its state. */
    get: async (id: string, options?: CallOptions): Promise<TradeRequest> =>
      this.#send(
        { call: "lookup", method: "GET", path: `/requests/${encodeURIComponent(nonEmpty("The request id", id))}` },
        options,
      ) as Promise<TradeRequest>,
  };

  readonly history = {
    /** Deals from `from` to `to`, both broker server time in whole seconds, both included. */
    deals: async (range: HistoryRange, options?: CallOptions): Promise<DealView[]> =>
      this.#send({ call: "read", method: "GET", path: `/history/deals${historyQuery(range)}` }, options) as Promise<
        DealView[]
      >,
    /** Past orders from `from` to `to`, both broker server time in whole seconds, both included. */
    orders: async (range: HistoryRange, options?: CallOptions): Promise<HistoryOrderView[]> =>
      this.#send({ call: "read", method: "GET", path: `/history/orders${historyQuery(range)}` }, options) as Promise<
        HistoryOrderView[]
      >,
  };

  readonly symbols = {
    /** Every symbol the broker has. */
    list: async (options?: CallOptions): Promise<SymbolSummaryView[]> =>
      this.#send({ call: "read", method: "GET", path: "/symbols" }, options) as Promise<SymbolSummaryView[]>,
    /** A symbol's specification, by its name exactly as the broker writes it. */
    get: async (name: string, options?: CallOptions): Promise<SymbolView> =>
      this.#send({ call: "read", method: "GET", path: symbolPath(name) }, options) as Promise<SymbolView>,
    /** A symbol's current price. */
    tick: async (name: string, options?: CallOptions): Promise<TickView> =>
      this.#send({ call: "read", method: "GET", path: `${symbolPath(name)}/tick` }, options) as Promise<TickView>,
  };

  readonly killSwitch = {
    /** Whether the account's kill switch is engaged. */
    get: async (options?: CallOptions): Promise<KillSwitchView> =>
      this.#send({ call: "read", method: "GET", path: "/kill-switch" }, options) as Promise<KillSwitchView>,
  };
}

/** A history range: broker server time in whole seconds, both ends included. */
export interface HistoryRange {
  from: number;
  to: number;
}

function historyQuery({ from, to }: HistoryRange): string {
  return `?from=${wholeNumber("from", from)}&to=${wholeNumber("to", to)}`;
}

function symbolPath(name: string): string {
  return `/symbols/${encodeURIComponent(nonEmpty("The symbol", name))}`;
}
