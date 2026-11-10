// Compares a copy of the published OpenAPI document with the committed snapshot, as parsed JSON (the
// published document is minified and writes whole numbers without a decimal point, so bytes differ).
//
//   node scripts/spec.mjs compare <live.json>   exit 0 when the same; else print the x-pipsocket diff, exit 1
//   node scripts/spec.mjs update <live.json>    replace openapi.json with the live document

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const snapshotPath = fileURLToPath(new URL("../openapi.json", import.meta.url));
const [command, livePath] = process.argv.slice(2);
if (!["compare", "update"].includes(command) || !livePath) {
  console.error("usage: node scripts/spec.mjs compare|update <live.json>");
  process.exit(2);
}

const live = JSON.parse(readFileSync(livePath, "utf8"));
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

if (command === "update") {
  writeFileSync(snapshotPath, `${JSON.stringify(live, null, 2)}\n`);
  console.log("Updated openapi.json.");
  process.exit(0);
}

if (isDeepStrictEqual(live, snapshot)) {
  console.log("The published document matches openapi.json.");
  process.exit(0);
}

console.log(extensionDiff(snapshot["x-pipsocket"] ?? {}, live["x-pipsocket"] ?? {}));
process.exit(1);

/** What changed in the error codes and retcodes, which a general OpenAPI diff doesn't read. */
function extensionDiff(before, after) {
  const lines = ["### x-pipsocket", ""];
  const byKey = (list, key) => new Map((list ?? []).map((item) => [item[key], item]));
  const compare = (label, oldList, newList, key, fields) => {
    const older = byKey(oldList, key);
    const newer = byKey(newList, key);
    for (const [id, item] of newer) {
      if (!older.has(id)) lines.push(`- ${label} added: \`${id}\` ${JSON.stringify(item)}`);
    }
    for (const [id, item] of older) {
      const now = newer.get(id);
      if (!now) {
        lines.push(`- ${label} removed: \`${id}\``);
        continue;
      }
      for (const field of fields) {
        if (!isDeepStrictEqual(item[field], now[field])) {
          lines.push(`- ${label} \`${id}\`: ${field} ${JSON.stringify(item[field])} -> ${JSON.stringify(now[field])}`);
        }
      }
    }
  };
  compare("Error code", before.errors, after.errors, "code", ["status", "from", "meaning"]);
  compare("Retcode", before.retcodes, after.retcodes, "code", ["name", "message"]);
  const known = new Set(["errors", "retcodes"]);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!known.has(key) && !isDeepStrictEqual(before[key], after[key])) lines.push(`- \`${key}\` changed`);
  }
  if (lines.length === 2) lines.push("No changes.");
  return lines.join("\n");
}
