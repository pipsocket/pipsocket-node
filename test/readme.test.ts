// Runs every TypeScript example in README.md, as written, against a mock of the API.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
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
