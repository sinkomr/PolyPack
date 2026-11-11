// The corpus of data/corpus/: boards with the scores that every implementation must give them
// (valid ones, invalid ones, and generated ones at the edge of the tolerance). Each is submitted as
// it is saved and again at the orientation its file names, against the repository's own literature.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../lib/runner.mts";
import { Scenario } from "./dsl.mts";
import { NOLIMIT } from "./flat.mts";

interface Saved {
  config: { N: number; M: number; P: number; pieces: unknown[]; container_phi?: number };
  auto_oriented_phi?: number;
}

export function corpusScenario(): Scenario {
  const s = new Scenario("flat-corpus", "flat: submit", {
    about: "every board of data/corpus (valid, invalid, at the edge of the tolerance), as saved and at its best orientation, against the repository's literature",
    options: { limits: NOLIMIT, recordsFile: "{repo}/data/records.json" },
  });
  const root = join(REPO, "data/corpus");
  const seen = new Set<string>();
  for (const dir of ["", "invalid", "generated"]) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".json")).sort()) {
      const saved = JSON.parse(readFileSync(join(root, dir, file), "utf8")) as Saved;
      const name = `${dir ? `${dir}/` : ""}${file}`.slice(0, 40);
      const body = { ...saved.config, name, units: "diameter" };
      s.submit(body);
      if (typeof saved.auto_oriented_phi === "number") s.submit({ ...body, container_phi: saved.auto_oriented_phi, found_with: "external" });
      // without the confirmation of units: refused for disks and circles only
      s.submit({ ...body, units: undefined });
      seen.add(`${saved.config.N}/${saved.config.M}/${saved.config.P}`);
    }
  }
  for (const key of seen) s.get(`/api/leaderboard/${key}`).get(`/api/problems/${key}`, undefined, { "accept-encoding": "gzip" });
  s.get(`/api/leaders?keys=${[...seen].join(",")}`).get("/api/holders").get("/api/records/pairs").get("/api/admin/pending", undefined, { authorization: "Bearer serverdiff-admin-token" });
  s.control({ flushStats: true });
  return s;
}
