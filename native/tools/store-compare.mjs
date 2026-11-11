// Compares what the TypeScript store and its Rust port did (see store-ref.mts and native/server/examples/storediff.rs).
//
//   node native/tools/store-compare.mjs results A.jsonl B.jsonl [--segments]
//       the result of every call, line by line, as text: one byte of difference is a difference.
//       --segments: B was written by several runs, each of which starts with a line {"open": ...}; the first must equal
//       A's, and every later one must say that the store opened without converting anything
//   node native/tools/store-compare.mjs db A.sqlite B.sqlite
//       the two database files: the settings stored in the file, the schema text of sqlite_master, and every table row
//       by row with the storage class of every value (INTEGER and REAL by their bits, TEXT and BLOB by their bytes)
//
//   node native/tools/store-compare.mjs trace A.trace B.trace
//       the statements the two stores sent to SQLite (STORE_TRACE): the same statements, with the same values bound,
//       in the same order. Runs of white space inside a statement count as one space (the Rust source indents its
//       SQL differently); nothing else is set aside.
//
// Exit status 0 when there is no difference, 1 otherwise. Nothing is rounded and nothing is left out, except the page
// counts of the files, which are printed and not compared: they describe the file, not what it holds.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [mode, a, b, ...flags] = process.argv.slice(2);

function results() {
  const A = readFileSync(a, "utf8").split("\n").filter(Boolean);
  let B = readFileSync(b, "utf8").split("\n").filter(Boolean);
  let bad = 0;
  if (flags.includes("--segments")) {
    const kept = [];
    let opens = 0;
    for (const line of B) {
      if (line.startsWith('{"open":')) {
        if (opens++ === 0) kept.push(line);
        else if (!/^\{"open":\{"unitsReport":null,"log":\[\],"piecesMigrated":(true|false)\}\}$/.test(line)) {
          bad++;
          console.log(`an open in the middle did something: ${line.slice(0, 300)}`);
        }
      } else kept.push(line);
    }
    B = kept;
    console.log(`${opens} segments`);
  }
  let same = 0;
  const kinds = new Map();
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) same++;
    else {
      bad++;
      if (bad <= 8) {
        const x = A[i] ?? "(missing)", y = B[i] ?? "(missing)";
        let at = 0;
        while (at < x.length && x[at] === y[at]) at++;
        console.log(`line ${i} differs at byte ${at}:\n  A ...${x.slice(Math.max(0, at - 60), at + 120)}\n  B ...${y.slice(Math.max(0, at - 60), at + 120)}`);
      }
    }
    const kind = A[i]?.startsWith('{"error"') ? "error" : "ok";
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(`results: ${n} lines (${kinds.get("error") ?? 0} of them refusals), ${same} identical, ${bad} different`);
  return bad;
}

const bits = (x) => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0).toString(16).padStart(16, "0");
};
const cell = (t, v) => {
  if (t === "null") return "null";
  if (t === "integer") return `i:${v}`;
  if (t === "real") return `r:${bits(v)}`;
  return `${t[0]}:${Buffer.from(v).toString("hex")}`;
};

function dump(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const out = new Map();
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  out.set("(settings)", ["page_size", "auto_vacuum", "encoding", "user_version", "application_id", "journal_mode", "schema_version"].map((p) => `${p}=${one(`PRAGMA ${p}`)}`));
  out.set("(integrity)", db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]));
  const master = db.prepare("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name").all();
  out.set("(schema)", master.map((r) => JSON.stringify([r.type, r.name, r.tbl_name, r.rootpage, r.sql])));
  for (const t of master.filter((r) => r.type === "table")) {
    const cols = db.prepare(`PRAGMA table_xinfo("${t.name}")`).all().map((c) => c.name);
    const sel = cols.map((c, i) => `typeof("${c}") AS t${i}, CASE typeof("${c}") WHEN 'text' THEN CAST("${c}" AS BLOB) ELSE "${c}" END AS v${i}`).join(", ");
    const st = db.prepare(`SELECT rowid AS rid, ${sel} FROM "${t.name}" ORDER BY rowid`);
    st.setReadBigInts(true);
    const rows = [];
    for (const r of st.iterate()) rows.push(`${r.rid}|` + cols.map((_, i) => cell(r[`t${i}`], typeof r[`v${i}`] === "bigint" && r[`t${i}`] === "real" ? Number(r[`v${i}`]) : r[`v${i}`])).join("|"));
    out.set(t.name, rows);
  }
  const pages = `${one("PRAGMA page_count")} pages, ${one("PRAGMA freelist_count")} free`;
  db.close();
  return { out, pages };
}

function dbs() {
  const A = dump(a), B = dump(b);
  let bad = 0;
  const names = [...new Set([...A.out.keys(), ...B.out.keys()])];
  const summary = [];
  for (const name of names) {
    const x = A.out.get(name), y = B.out.get(name);
    if (!x || !y) {
      bad++;
      console.log(`${name}: only in ${x ? "A" : "B"}`);
      continue;
    }
    let diff = 0;
    for (let i = 0; i < Math.max(x.length, y.length); i++)
      if (x[i] !== y[i]) {
        diff++;
        if (diff <= 3) console.log(`${name} row ${i} differs:\n  A ${String(x[i]).slice(0, 400)}\n  B ${String(y[i]).slice(0, 400)}`);
      }
    bad += diff;
    summary.push(`${name} ${x.length}${diff ? ` (${diff} DIFFERENT)` : ""}`);
  }
  console.log(`database: ${summary.join(", ")}; ${bad} differences. Pages: A ${A.pages}, B ${B.pages}`);
  return bad;
}

function traces() {
  // a statement's text is a JSON string, in which its line breaks are written \n
  const norm = (line) => line.replace(/\\n/g, " ").replace(/\s+/g, " ").replace(/ "$/, '"').replace(/ " \[/, '" [');
  const A = readFileSync(a, "utf8").split("\n").filter(Boolean).map(norm);
  const B = readFileSync(b, "utf8").split("\n").filter(Boolean).map(norm);
  let bad = 0;
  const kinds = { P: 0, S: 0, E: 0 };
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i]) kinds[A[i][0]]++;
    if (A[i] !== B[i]) {
      bad++;
      if (bad <= 5) console.log(`statement ${i} differs:\n  A ${String(A[i]).slice(0, 500)}\n  B ${String(B[i]).slice(0, 500)}`);
    }
  }
  console.log(`statements: ${kinds.P} prepared, ${kinds.S} stepped, ${kinds.E} executed; ${bad} different`);
  return bad;
}

const bad = mode === "results" ? results() : mode === "db" ? dbs() : mode === "trace" ? traces() : (() => { throw new Error("usage: store-compare.mjs results|db|trace A B"); })();
process.exit(bad ? 1 : 0);
