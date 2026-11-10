// Packs the package, installs the tarball into an empty project, and imports it there, in both
// JavaScript and TypeScript. Run with the Node version to check: node scripts/pack-check.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "pipsocket-pack-"));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  run("pnpm", ["pack", "--pack-destination", work], root);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  const project = join(work, "project");
  run("mkdir", ["-p", project], work);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", join(work, tarball), `typescript@${process.env.TS_VERSION ?? "5.9.3"}`],
    project,
  );

  writeFileSync(
    join(project, "check.mjs"),
    `import { Pipsocket, OutcomeUnknown, VERSION, isFinal } from "pipsocket";
const ps = new Pipsocket({ apiKey: "psk_example" });
const acct = ps.account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");
if (typeof acct.get !== "function" || typeof isFinal !== "function" || !(new OutcomeUnknown({ idempotencyKey: "k", cause: new Error("x") }) instanceof Error)) {
  throw new Error("The package's exports are incomplete");
}
console.log("Imported pipsocket", VERSION, "on Node", process.versions.node);
`,
  );
  run("node", ["check.mjs"], project);

  writeFileSync(
    join(project, "check.ts"),
    `import { Pipsocket, type AccountView, type TradeRequest } from "pipsocket";
const acct = new Pipsocket({ apiKey: "psk_example" }).account("acc_01m6tx3k9f2qw8r7bznd5yvh4c");
export const read: () => Promise<AccountView> = () => acct.get();
export const kind = (r: TradeRequest) => r.kind;
`,
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        lib: ["ES2023", "DOM"],
      },
    }),
  );
  run("npx", ["tsc", "-p", "."], project);
  console.log("The packed types check under TypeScript.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
