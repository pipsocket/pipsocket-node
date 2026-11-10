// Runs every TypeScript example in README.md, as written, against a mock of the API.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { NotFound } from "../src/index.js";
import { mockApi } from "./support/mock-api.js";

// Every WebSocket an example opens is the mock's: the ws package on Node, the global one on Bun and Deno.
const sockets = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("ws", () => {
  function WebSocket(url: string, options: unknown) {
    const Mock = sockets.current as new (url: string, options: unknown) => unknown;
    return new Mock(url, options);
  }
  return { default: WebSocket, WebSocket };
});

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const examples = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
const folder = new URL("./.readme/", import.meta.url);
const entry = new URL("../src/index.ts", import.meta.url).pathname;

beforeAll(() => mkdirSync(folder, { recursive: true }));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the README has examples", () => {
  expect(examples.length).toBeGreaterThan(0);
});

examples.forEach((code, index) => {
  test(`README example ${index + 1} runs`, async () => {
    const api = mockApi();
    vi.stubEnv("PIPSOCKET_KEY", "psk_example");
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("WebSocket", api.WebSocket);
    sockets.current = api.WebSocket;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = new URL(`example-${index + 1}.ts`, folder);
    writeFileSync(file, code.replaceAll('from "pipsocket"', `from ${JSON.stringify(entry)}`));
    const streams = code.includes(".stream(");
    const outcome = await import(file.pathname).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (streams) {
      // The mock's stream drops once, then the account is gone: the loop ends with NotFound.
      expect(outcome).toBeInstanceOf(NotFound);
      expect(api.sockets).toBe(2);
      expect(log.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["baseline", "EURUSD", "request"]));
    } else {
      expect(outcome).toBeUndefined();
    }
    expect(api.calls.length).toBeGreaterThan(0);
    expect(log).toHaveBeenCalled();
  });
});

describe("the quickstart reports each outcome for what it is", () => {
  const quickstart = examples.find((code) => code.includes("orders.place(") && code.includes("switch (order.kind)"));
  const sent = { action: "deal", symbol: "EURUSD", type: "buy", volume: 0.01 };
  const mt5 = { retcode: 10009, retcode_name: "TRADE_RETCODE_DONE", deal: 771203455, order: 881402311 };
  // [state, HTTP status, fields of the answer, the line the quickstart prints, whether it filled]
  const cases: Array<[string, number, Record<string, unknown>, string, boolean]> = [
    ["completed", 200, { result: mt5 }, "filled: deal", true],
    ["completed", 200, { result: { ...mt5, deal: 0 } }, "placed, not filled: order", false],
    ["partial", 200, { result: { ...mt5, retcode: 10010 } }, "filled: deal", true],
    ["placed", 200, { result: { ...mt5, retcode: 10008, deal: 0 } }, "placed, not filled: order", false],
    [
      "rejected",
      422,
      { result: { ...mt5, retcode: 10016, retcode_name: "TRADE_RETCODE_INVALID_STOPS" } },
      "rejected:",
      false,
    ],
    ["not_sent", 503, { result: { error: "busy", message: "..." } }, "not executed:", false],
    [
      "not_executed",
      409,
      { settlement: "evidence", result: { error: "not_executed", message: "..." } },
      "not executed:",
      false,
    ],
    [
      "executed",
      200,
      { settlement: "operator", result: { outcome: "executed", settled_by: "a", reason: "b" } },
      "executed, as settled by an owner or admin:",
      false,
    ],
    ["superseded", 200, { result: null }, "outcome not known yet:", false],
  ];
  // The symbol allows only fok, and at least 0.02: the quickstart must use those.
  const symbol = { name: "EURUSD", filling_modes: ["fok"], volume_min: 0.02, volume_step: 0.01 };

  test.each(cases)("%s, printing %s", async (state, status, extra, line, filled) => {
    if (!quickstart) throw new Error("The README has no quickstart with a switch on kind");
    const body = { request: "req_1", state, sent, message: "...", ...extra };
    // Three positions: only the EURUSD one with the quickstart's magic number is the order's.
    const positions = [
      { ticket: 1, identifier: 1, symbol: "GBPUSD", type: "buy", volume: 0.05, magic: 0 },
      { ticket: 2, identifier: 2, symbol: "EURUSD", type: "buy", volume: 0.02, magic: 0 },
      { ticket: 3, identifier: 3, symbol: "EURUSD", type: "buy", volume: 0.02, magic: 4021 },
    ];
    const api = mockApi((method, path) => {
      if (method === "POST" && path.endsWith("/orders")) return { status, body };
      if (method === "GET" && path.endsWith("/positions")) return { status: 200, body: positions };
      if (method === "GET" && path.endsWith("/symbols/EURUSD")) return { status: 200, body: symbol };
      return undefined;
    });
    vi.stubEnv("PIPSOCKET_KEY", "psk_example");
    vi.stubGlobal("fetch", api.fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = new URL(`quickstart-${state}-${filled}.ts`, folder);
    writeFileSync(file, quickstart.replaceAll('from "pipsocket"', `from ${JSON.stringify(entry)}`));
    await import(file.pathname);
    expect(log.mock.calls.map((call) => call[0])).toContain(line);
    const placed = api.calls.find((call) => call.method === "POST" && call.path.endsWith("/orders"));
    expect(placed?.body).toMatchObject({ symbol: "EURUSD", type_filling: "fok", volume: 0.02 });
    const closed = api.calls.filter((call) => call.method === "POST" && call.path.endsWith("/close"));
    // Only a filled order's own position is closed, with the symbol's filling mode; nothing else.
    expect(closed.map((call) => call.path.split("/").at(-2))).toEqual(filled ? ["3"] : []);
    for (const call of closed) expect(call.body).toMatchObject({ type_filling: "fok" });
  });
});

test("the quickstart refuses a symbol that allows neither fok nor ioc, and sends nothing", async () => {
  const quickstart = examples.find((code) => code.includes("orders.place(") && code.includes("switch (order.kind)"));
  if (!quickstart) throw new Error("The README has no quickstart with a switch on kind");
  const api = mockApi((method, path) =>
    method === "GET" && path.endsWith("/symbols/EURUSD")
      ? { status: 200, body: { name: "EURUSD", filling_modes: ["boc"], volume_min: 0.01, volume_step: 0.01 } }
      : undefined,
  );
  vi.stubEnv("PIPSOCKET_KEY", "psk_example");
  vi.stubGlobal("fetch", api.fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const file = new URL("quickstart-boc-only.ts", folder);
  writeFileSync(file, quickstart.replaceAll('from "pipsocket"', `from ${JSON.stringify(entry)}`));
  await expect(import(file.pathname)).rejects.toThrow(/neither fok nor ioc/);
  expect(api.calls.some((call) => call.method === "POST")).toBe(false);
});

test("the README examples type-check against the package's types", () => {
  const files = examples.map((code, index) => {
    const file = new URL(`check-${index + 1}.ts`, folder).pathname;
    writeFileSync(file, `${code.replaceAll('from "pipsocket"', `from ${JSON.stringify(entry)}`)}\nexport {};\n`);
    return file;
  });
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: ["node"],
  });
  const problems = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(problems).toEqual([]);
});
