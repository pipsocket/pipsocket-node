import { type AttemptResult, attempt, type FetchLike, type HttpRequest } from "./attempt.js";
import { backoffMs, type CallKind, interpret } from "./core.js";
import { AuthenticationError, NotFound, OutcomeUnknown, PipsocketError } from "./errors.js";
import { isFinal, type TradeRequest } from "./trade-request.js";
import type {
  AccountView,
  CheckView,
  CloseByBody,
  ClosePositionBody,
  DealView,
  EngageKillSwitchBody,
  HistoryOrderView,
  KillSwitchOutcome,
  KillSwitchView,
  ModifyOrderBody,
  PendingOrderView,
  PlaceOrderBody,
  PositionLevelsBody,
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
  /**
   * The fetch to use. Defaults to the runtime's own. A custom one must make exactly one attempt per
   * call and not follow redirects; its failures count as possibly sent unless it marks an error
   * with markNotSent.
   */
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

/** Options the six trade calls take, as their last argument. */
export interface TradeCallOptions extends CallOptions {
  /**
   * The key that makes the call safe to repeat. By default each call makes its own (a UUID). Make
   * one with newKey() and save it before sending to survive a crash or a cancellation.
   */
  idempotencyKey?: string;
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

type Send = (spec: CallSpec, options?: TradeCallOptions) => Promise<unknown>;

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
  readonly #transport: { fetch: FetchLike; runtimeFetch: boolean };
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
    this.#transport = {
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      runtimeFetch: options.fetch === undefined,
    };
    this.#clock = options.clock ?? realClock;
    this.#random = options.random ?? Math.random;
    this.#userAgent = `pipsocket-node/${VERSION} ${runtimeName()}`;
  }

  /** A handle for one account, by its id (`acc_` and 26 characters). */
  account(id: string): Account {
    const accountId = nonEmpty("The account id", id);
    return new Account(accountId, {
      send: (spec, options) => this.#send(accountId, spec, options),
      clock: this.#clock,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Sends one call, with retries. */
  async #send(accountId: string, spec: CallSpec, options: TradeCallOptions = {}): Promise<unknown> {
    const trade = spec.call === "trade";
    // One key per call: every attempt sends the same one. Checked before anything is sent.
    const key = trade ? checkKey(options.idempotencyKey) : undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "User-Agent": this.#userAgent,
      Accept: "application/json",
    };
    if (key !== undefined) headers["Idempotency-Key"] = key;
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
    // Once any attempt may have reached the host, the call can only return a recorded request or
    // raise OutcomeUnknown: a later refusal says nothing about that attempt.
    let maybeSent = false;
    const fail = (error: PipsocketError): PipsocketError => {
      if (key === undefined) return error;
      if (maybeSent) return new OutcomeUnknown({ idempotencyKey: key, cause: error });
      // Nothing was sent, but the key is handed back all the same, so a retry later can reuse it.
      error.idempotencyKey = key;
      return error;
    };
    const cancelled = (reason: unknown): unknown => (key === undefined ? reason : withKey(reason, key));

    for (;;) {
      if (signal?.aborted) throw cancelled(signal.reason);
      let result: AttemptResult;
      try {
        result = await attempt(this.#transport, request, timeoutMs, signal);
      } catch (reason) {
        // attempt() throws only the caller's abort reason.
        throw cancelled(reason);
      }
      // A call cancelled while its attempt ran ends with the caller's reason, whatever came back.
      if (signal?.aborted) throw cancelled(signal.reason);
      const verdict = interpret(result, spec.call, key);
      if (verdict.kind === "request") return verdict.request;
      if (verdict.kind === "json") return verdict.value;
      if (verdict.maybeSent) maybeSent = true;
      if (verdict.kind === "stop") throw fail(verdict.error);

      const used = retriesFor.get(verdict.reason) ?? 0;
      if (retries >= maxRetries || (verdict.limit !== undefined && used >= verdict.limit)) throw fail(verdict.error);
      const wait = verdict.retryAfterMs ?? backoffMs(retries + 1, this.#random());
      // A wait that would end after the deadline isn't waited for.
      if (clock.now() + wait > deadline) throw fail(verdict.error);
      try {
        await clock.sleep(wait, signal);
      } catch (reason) {
        throw cancelled(reason);
      }
      if (signal?.aborted) throw cancelled(signal.reason);
      if (clock.now() > deadline) throw fail(verdict.error);
      retries += 1;
      retriesFor.set(verdict.reason, used + 1);
    }
  }
}

/** A new idempotency key (a UUID). Make one, save it, then pass it as `idempotencyKey`. */
export function newKey(): string {
  return crypto.randomUUID();
}

// 1 to 128 visible ASCII characters, not starting with `hk:` (Pipsocket's own keys). Spaces are
// allowed inside a key but not at its ends, where HTTP would strip them and change the key.
const KEY_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/;

function checkKey(key: string | undefined): string {
  if (key === undefined) return newKey();
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new TypeError("idempotencyKey must be 1 to 128 visible ASCII characters, with no space at either end");
  }
  if (key.startsWith("hk:")) {
    throw new TypeError("idempotencyKey must not start with hk:, which Pipsocket's own requests use");
  }
  return key;
}

/**
 * The caller's cancellation reason, unchanged. When it is an ordinary object that can take a new
 * property, the key is set on it too, as a convenience: a string or frozen reason can't carry it, so
 * the dependable way is to make the key with newKey() before sending.
 */
function withKey(reason: unknown, key: string): unknown {
  if (typeof reason === "object" && reason !== null && Object.isExtensible(reason) && !("idempotencyKey" in reason)) {
    try {
      Object.defineProperty(reason, "idempotencyKey", { value: key, enumerable: true, configurable: true });
    } catch {
      // A proxy or exotic object refused it: the reason still passes through unchanged.
    }
  }
  return reason;
}

/** Options for `requests.wait`. */
export interface WaitOptions {
  /** How long to wait for a final state. Defaults to 30000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface AccountContext {
  send: Send;
  clock: Clock;
  timeoutMs: number;
}

/** The calls for one account. Get one with `Pipsocket.account(id)`. */
export class Account {
  readonly id: string;
  readonly #send: Send;
  readonly #context: AccountContext;

  /** Use `Pipsocket.account(id)` rather than this. */
  constructor(id: string, context: AccountContext) {
    this.id = id;
    this.#context = context;
    this.#send = context.send;
  }

  #trade(method: CallSpec["method"], path: string, body: unknown, options?: TradeCallOptions): Promise<TradeRequest> {
    const spec: CallSpec = { call: "trade", method, path };
    if (body !== undefined) spec.body = body;
    return this.#send(spec, options) as Promise<TradeRequest>;
  }

  /** The account: login, status, connection, and balance, equity and margin. */
  async get(options?: CallOptions): Promise<AccountView> {
    return this.#send({ call: "read", method: "GET", path: "" }, options) as Promise<AccountView>;
  }

  readonly positions = {
    /** Open positions. */
    list: async (options?: CallOptions): Promise<PositionView[]> =>
      this.#send({ call: "read", method: "GET", path: "/positions" }, options) as Promise<PositionView[]>,
    /** Sets a position's stop loss and take profit (0 removes one). */
    setLevels: async (ticket: number, levels: PositionLevelsBody, options?: TradeCallOptions): Promise<TradeRequest> =>
      this.#trade("PATCH", ticketPath("/positions", ticket), levels, options),
    /** Closes all or part of a position. */
    close: async (ticket: number, body: ClosePositionBody, options?: TradeCallOptions): Promise<TradeRequest> =>
      this.#trade("POST", `${ticketPath("/positions", ticket)}/close`, body, options),
    /** Closes a position by an opposite one (`position_by`). */
    closeBy: async (ticket: number, body: CloseByBody, options?: TradeCallOptions): Promise<TradeRequest> =>
      this.#trade("POST", `${ticketPath("/positions", ticket)}/close-by`, body, options),
  };

  readonly orders = {
    /** Pending orders. */
    list: async (options?: CallOptions): Promise<PendingOrderView[]> =>
      this.#send({ call: "read", method: "GET", path: "/orders" }, options) as Promise<PendingOrderView[]>,
    /** Sends a trade request: a market order, or a pending order. */
    place: async (order: PlaceOrderBody, options?: TradeCallOptions): Promise<TradeRequest> =>
      this.#trade("POST", "/orders", order, options),
    /** Checks an order without sending it: margin, and whether MT5 would accept it. */
    check: async (order: PlaceOrderBody, options?: CallOptions): Promise<CheckView> =>
      this.#send({ call: "read", method: "POST", path: "/orders/check", body: order }, options) as Promise<CheckView>,
    /** Changes a pending order's price, stops and expiry. */
    modify: async (ticket: number, body: ModifyOrderBody, options?: TradeCallOptions): Promise<TradeRequest> =>
      this.#trade("PATCH", ticketPath("/orders", ticket), body, options),
    /** Deletes a pending order. */
    cancel: async (ticket: number, options?: TradeCallOptions): Promise<TradeRequest> =>
      this.#trade("DELETE", ticketPath("/orders", ticket), undefined, options),
  };

  readonly requests = {
    /** A recorded trade request, by id, whatever its state. */
    get: async (id: string, options?: CallOptions): Promise<TradeRequest> =>
      this.#send(
        { call: "lookup", method: "GET", path: `/requests/${encodeURIComponent(nonEmpty("The request id", id))}` },
        options,
      ) as Promise<TradeRequest>,
    /**
     * Looks the request up until it is final or `timeoutMs` passes, then returns it as it stands
     * (still `pending` or `unknown`, perhaps). It never throws for "still pending" and sends nothing
     * but lookups. A 401 or 404 throws; other failures keep it polling until the timeout.
     */
    wait: async (id: string, options: WaitOptions = {}): Promise<TradeRequest> => this.#wait(id, options),
  };

  async #wait(id: string, { timeoutMs = 30_000, signal }: WaitOptions): Promise<TradeRequest> {
    nonEmpty("The request id", id);
    const { clock } = this.#context;
    const deadline = clock.now() + timeoutMs;
    let interval = 250;
    let latest: TradeRequest | undefined;
    let lastError: unknown;
    for (;;) {
      const remaining = deadline - clock.now();
      if (remaining <= 0) {
        if (latest) return latest;
        throw lastError;
      }
      // Each lookup is one attempt, bounded by the time left.
      const lookupOptions: CallOptions = {
        maxRetries: 0,
        timeoutMs: Math.min(this.#context.timeoutMs, remaining),
      };
      if (signal) lookupOptions.signal = signal;
      try {
        latest = await this.requests.get(id, lookupOptions);
        if (isFinal(latest)) return latest;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof AuthenticationError || error instanceof NotFound) throw error;
        lastError = error;
      }
      const left = deadline - clock.now();
      if (left <= 0) {
        if (latest) return latest;
        throw lastError;
      }
      await clock.sleep(Math.min(interval, left), signal);
      interval = Math.min(interval * 1.5, 2000);
    }
  }

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
    /**
     * Blocks new exposure, then deletes every pending order and closes every position. It takes no
     * key and is safe to repeat: engaging again retries whatever is left.
     */
    engage: async (body?: EngageKillSwitchBody, options?: CallOptions): Promise<KillSwitchOutcome> => {
      const spec: CallSpec = { call: "read", method: "POST", path: "/kill-switch" };
      if (body !== undefined) spec.body = body;
      return this.#send(spec, options) as Promise<KillSwitchOutcome>;
    },
    /** Lifts the kill switch: new orders are allowed again. */
    lift: async (options?: CallOptions): Promise<KillSwitchView> =>
      this.#send({ call: "read", method: "DELETE", path: "/kill-switch" }, options) as Promise<KillSwitchView>,
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

function ticketPath(prefix: string, ticket: number): string {
  return `${prefix}/${wholeNumber("The ticket", ticket)}`;
}

function symbolPath(name: string): string {
  return `/symbols/${encodeURIComponent(nonEmpty("The symbol", name))}`;
}
