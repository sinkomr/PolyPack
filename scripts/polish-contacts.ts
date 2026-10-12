import { readFileSync } from "node:fs";
import { evaluate, parseConfig } from "@polypack/geometry";
import { identifyContacts } from "@polypack/solver";

const path = process.argv[2];
if (!path || path === "--help") {
  console.log(
    "Usage: node --import tsx scripts/polish-contacts.ts config.json > contacts.json\nExports the server-oriented container and active contacts for python/polish_mp.py.",
  );
} else {
  const parsed = parseConfig(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const config = parsed.config;
  const container = evaluate(config, { autoOrient: true }).container;
  if (!container) throw new Error("configuration has no enclosing container");
  console.log(JSON.stringify({ config, container, contacts: identifyContacts(config, container) }, null, 2));
}
