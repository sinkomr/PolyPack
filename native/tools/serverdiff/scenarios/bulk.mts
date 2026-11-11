// Bulk scenarios from real data: the site's leading entries of the nightly snapshot replayed as
// submissions in a random order, with mutants between them, then every listing read.
import { AUTH, Scenario, rng } from "./dsl.mts";
import { Board, Record_, SPACE_NAMES, SiteEntry, boards, piecesKey, researchRecords, scaled, siteEntries } from "./data.mts";
import { NOLIMIT } from "./flat.mts";
import type { BuildOptions } from "./index.mts";

const enc = encodeURIComponent;

function shuffle<T>(list: T[], random: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function bulkFlat(all: Board[]): Scenario {
  const s = new Scenario("bulk-flat", "bulk: real entries", {
    about: `${all.length} leading boards of the site replayed in a random order against the repository's literature, a mutant after every fourth, then every listing and the snapshot`,
    options: { limits: NOLIMIT, recordsFile: "{repo}/data/records.json", snapshotStartDelayMs: 300 },
    env: { SNAPSHOT_DIR: "{tmp}/snap" },
    timeLabels: false,
  });
  const random = rng(20261110);
  const order = shuffle(all, random);
  // the build at startup (of an empty snapshot) is over before the first entry
  s.wait(1500);
  const pairs = new Map<string, Set<number>>();
  const names = new Map<string, number>();
  order.forEach((b, i) => {
    const pieces = b.pieces.map((p) => ({ x: p[0]!, y: p[1]!, theta: p[2] ?? 0 }));
    const body = {
      N: b.N,
      M: b.M,
      P: b.P,
      pieces,
      container_phi: b.container_phi,
      name: b.name,
      units: "diameter",
      ...(b.found_with === "external" || b.found_with === "hand" ? { found_with: b.found_with } : {}),
    };
    s.submit(body);
    const key = `${b.N}/${b.M}`;
    if (!pairs.has(key)) pairs.set(key, new Set());
    pairs.get(key)!.add(b.P);
    names.set(b.name, (names.get(b.name) ?? 0) + 1);
    const k = i % 20;
    const squeeze = (f: number) => pieces.map((p) => ({ ...p, x: p.x * f, y: p.y * f }));
    if (k === 0 && pieces.length >= 2) s.submit({ ...body, name: "mutant", pieces: pieces.map((p, j) => (j === 1 ? { ...p, x: pieces[0]!.x + 0.01, y: pieces[0]!.y } : p)) });
    else if (k === 4) s.submit({ ...body, name: "mutant", pieces: squeeze(1 - 1e-10) });
    else if (k === 8) s.submit({ ...body, name: "mutant", pieces: squeeze(1 - 3e-9) });
    else if (k === 12) s.submit({ ...body, name: "mutant", P: Math.min(500, b.P + 1) });
    else if (k === 16) s.submit({ ...body, name: "mutant", container_phi: random() * 6.283185307179586 - 3.1 });
    else if (k === 18) s.submit({ ...body, name: "mutant", pieces: squeeze(1 - 1e-6) });
  });
  const gz = { "accept-encoding": "gzip" };
  s.get("/api/records/pairs", 200, gz).get("/api/holders", 200, gz).get("/api/admin/pending", 200, { ...AUTH, ...gz });
  for (const [key, ps] of pairs) {
    const [N, M] = key.split("/");
    s.get(`/api/records?N=${N}&M=${M}`, 200, gz);
    for (let from = 1; from <= 401; from += 100) if ([...ps].some((P) => P >= from && P < from + 100)) s.get(`/api/atlas?N=${N}&M=${M}&from=${from}&to=${from + 99}`, 200, gz);
  }
  const keys = order.map((b) => `${b.N}/${b.M}/${b.P}`);
  for (let i = 0; i < keys.length; i += 200) s.get(`/api/leaders?keys=${keys.slice(i, i + 200).join(",")}`, 200, gz);
  for (const [name] of [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12)) s.get(`/api/holder?name=${enc(name)}`, 200, gz);
  for (let i = 0; i < order.length; i += Math.max(1, Math.floor(order.length / 60))) {
    const b = order[i]!;
    s.get(`/api/leaderboard/${b.N}/${b.M}/${b.P}`, 200).get(`/api/problems/${b.N}/${b.M}/${b.P}`, 200, gz).get(`/api/submissions/${i + 2}`);
  }
  // a day later the snapshot is built again: the manifest and every pair's file
  s.add({ op: "restart", clockAdvanceMs: 26 * 3_600_000 }).wait(4000).get("/api/snapshot", 200);
  for (const key of pairs.keys()) s.get(`/api/snapshot/${key.replace("/", "-")}.json.gz`);
  s.get("/api/holders", 200, gz).get("/api/records/pairs", 200);
  return s;
}

function bulkSpaces(site: SiteEntry[], recs: Record_[]): Scenario {
  const s = new Scenario("bulk-spaces", "bulk: real entries", {
    about: `${site.length} leading entries of the eight spaces and ${recs.length} research records replayed in a random order, a mutant after every fifth, then every listing and the snapshot`,
    options: { limits: NOLIMIT, snapshotStartDelayMs: 300 },
    env: { SNAPSHOT_DIR: "{tmp}/snap" },
    timeLabels: false,
  });
  const random = rng(8);
  const all = shuffle(
    [
      ...site.map((e) => ({ space: e.space, id: e.problem, config: e.config, name: e.name, software: e.software, method: e.method })),
      ...recs.map((r) => ({ space: r.space, id: r.id, config: r.config, name: "the record posted back", software: null, method: null })),
    ],
    random,
  );
  s.wait(1500);
  all.forEach((e, i) => {
    const body = { space: e.space, id: e.id, config: e.config, name: e.name, units: "diameter", software: e.software, method: e.method?.slice(0, 80) ?? null };
    s.spaceSubmit(body);
    const k = i % 25;
    const mutant = (f: number) => s.spaceSubmit({ ...body, name: "mutant", config: scaled(e.space, e.id, e.config, f) });
    if (k === 0) mutant(1 - 1e-10);
    else if (k === 5) mutant(1 - 3e-9);
    else if (k === 10) mutant(1 - 1e-6);
    else if (k === 15) mutant(1.0001);
    else if (k === 20) {
      const key = piecesKey(e.space);
      s.spaceSubmit({ ...body, name: "mutant", config: { ...e.config, [key]: (e.config[key] as unknown[]).slice(1) } });
    }
  });
  const gz = { "accept-encoding": "gzip" };
  for (const space of SPACE_NAMES) s.get(`/api/spaces/${space}/records`, 200, gz).get(`/api/spaces/${space}/site-only?limit=5000`, 200, gz).get(`/api/spaces/${space}/site-only?limit=7`, 200);
  const ids = [...new Set(all.map((e) => e.id))];
  for (let i = 0; i < ids.length; i += 200) s.get(`/api/leaders?keys=${ids.slice(i, i + 200).join(",")}`, 200, gz);
  for (let i = 0; i < all.length; i += Math.max(1, Math.floor(all.length / 120))) {
    const e = all[i]!;
    s.get(`/api/spaces/${e.space}/problems/${e.id}`, 200, gz).get(`/api/spaces/entries/${i + 1}`, undefined, gz);
  }
  s.add({ op: "restart", clockAdvanceMs: 26 * 3_600_000 }).wait(3000).get("/api/snapshot", 200);
  for (const space of SPACE_NAMES) s.get(`/api/snapshot/space-${space}.json.gz`);
  return s;
}

export async function bulkScenarios(o: BuildOptions): Promise<Scenario[]> {
  if (o.bulk <= 0) return [];
  const out: Scenario[] = [];
  const flat = await boards(o.bulk, 5, o.cacheDir);
  if (flat.length) out.push(bulkFlat(flat));
  const site: SiteEntry[] = [];
  const recs: Record_[] = [];
  const perSpace = Math.max(4, Math.floor(o.bulk / 12));
  for (const space of SPACE_NAMES) {
    const random = rng(31);
    const maxP = space === "polyhedra" || space === "ndim" ? 24 : 60;
    const pool = (await siteEntries(space, 6000)).filter((e) => e.P <= maxP).map((e) => [random(), e] as const);
    pool.sort((a, b) => a[0] - b[0]);
    site.push(...pool.slice(0, perSpace).map((x) => x[1]));
    recs.push(...researchRecords(space, Math.floor(perSpace / 3), maxP, 17));
  }
  if (site.length) out.push(bulkSpaces(site, recs));
  return out;
}
