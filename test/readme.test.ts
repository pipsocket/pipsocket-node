// Runs every TypeScript example in README.md, as written, against a mock of the API.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { mockApi } from "./support/mock-api.js";

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
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = new URL(`example-${index + 1}.ts`, folder);
    writeFileSync(file, code.replaceAll('from "pipsocket"', `from ${JSON.stringify(entry)}`));
    await import(file.pathname);
    expect(api.calls.length).toBeGreaterThan(0);
    expect(log).toHaveBeenCalled();
  });
});

describe("the quickstart reports each outcome for what it is", () => {
  const quickstart = examples.find((code) => code.includes("orders.place(") && code.includes("switch (order.kind)"));
  const sent = { action: "deal", symbol: "EURUSD", type: "buy", volume: 0.01 };
  const mt5 = { retcode: 10009, retcode_name: "TRADE_RETCODE_DONE", deal: 771203455, order: 881402311 };
  const cases: Array<[string, number, Record<string, unknown>, string]> = [
    ["completed", 200, { result: mt5 }, "filled: deal"],
    ["partial", 200, { result: mt5 }, "filled: deal"],
    ["placed", 200, { result: { ...mt5, deal: 0 } }, "placed, not filled yet: order"],
    ["rejected", 422, { result: { ...mt5, retcode: 10016, retcode_name: "TRADE_RETCODE_INVALID_STOPS" } }, "rejected:"],
    ["not_sent", 503, { result: { error: "busy", message: "..." } }, "not executed:"],
    [
      "not_executed",
      409,
      { settlement: "evidence", result: { error: "not_executed", message: "..." } },
      "not executed:",
    ],
    [
      "executed",
      200,
      { settlement: "operator", result: { outcome: "executed", settled_by: "a", reason: "b" } },
      "executed, as settled by an owner or admin:",
    ],
    ["superseded", 200, { result: null }, "outcome not known yet:"],
  ];

  test.each(cases)("%s", async (state, status, extra, line) => {
    if (!quickstart) throw new Error("The README has no quickstart with a switch on kind");
    const body = { request: "req_1", state, sent, message: "...", ...extra };
    // Three positions: only the EURUSD one with the quickstart's magic number is the order's.
    const positions = [
      { ticket: 1, identifier: 1, symbol: "GBPUSD", type: "buy", volume: 0.05, magic: 0 },
      { ticket: 2, identifier: 2, symbol: "EURUSD", type: "buy", volume: 0.02, magic: 0 },
      { ticket: 3, identifier: 3, symbol: "EURUSD", type: "buy", volume: 0.01, magic: 4021 },
    ];
    const api = mockApi((method, path) => {
      if (method === "POST" && path.endsWith("/orders")) return { status, body };
      if (method === "GET" && path.endsWith("/positions")) return { status: 200, body: positions };
      return undefined;
    });
    vi.stubEnv("PIPSOCKET_KEY", "psk_example");
    vi.stubGlobal("fetch", api.fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = new URL(`quickstart-${state}.ts`, folder);
    writeFileSync(file, quickstart.replaceAll('from "pipsocket"', `from ${JSON.stringify(entry)}`));
    await import(file.pathname);
    expect(log.mock.calls.map((call) => call[0])).toContain(line);
    const closed = api.calls.filter((call) => call.method === "POST" && call.path.endsWith("/close"));
    // Only a filled order's own position is closed; nothing else, whatever the outcome.
    const filled = state === "completed" || state === "partial";
    expect(closed.map((call) => call.path.split("/").at(-2))).toEqual(filled ? ["3"] : []);
  });
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
