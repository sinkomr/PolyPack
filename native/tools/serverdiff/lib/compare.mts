// Compares two transcripts of the same scenario (README.md, "The comparison"). Everything must be
// equal, record for record: status, headers, body text, the order of events, every row of the
// database, every log line. The one allowance is the one native/PORTING.md makes: a number may
// differ in its last digits, and such numbers are counted, never hidden.
//
//   JSON number          equal, or within 1e-12 relative (or 1e-12 absolute, for values near zero)
//   number in a message  (an element of `reasons`, an `error`, a log line): the texts are equal once
//                        each number is replaced by a placeholder, and the numbers agree to 1e-6
//                        relative or 1e-12 absolute
//   coordinates stated by the submitter of a polygon packing (`pieces`, `container_phi` of the
//                        flat family) are passed through: they must be equal bit for bit
import { readFileSync } from "node:fs";

export interface Difference {
  step: number;
  /** What the step was, e.g. "req POST /api/submit". */
  what: string;
  /** Where in the record, e.g. "body.reasons[0]". */
  where: string;
  kind: "value" | "number" | "text" | "format" | "missing" | "extra" | "structure";
  a: string;
  b: string;
}

export interface Comparison {
  scenario: string;
  records: number;
  /** Records equal byte for byte. */
  identical: number;
  /** Records equal except for numbers that differ within the tolerance. */
  close: number;
  /** Records with at least one difference. */
  differing: number;
  /** Numbers that differ within the tolerance, and the largest relative difference among them. */
  closeNumbers: number;
  maxRelative: number;
  differences: Difference[];
}

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const REL = 1e-12;
const ABS = 1e-12;
const MESSAGE_REL = 1e-6;

const short = (v: unknown, at = 0): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "undefined";
  if (s.length <= 240) return s;
  const from = Math.max(0, at - 80);
  return (from ? "…" : "") + s.slice(from, from + 240) + (from + 240 < s.length ? "…" : "");
};
const firstDiff = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};
const looksJson = (s: string) => s.length > 1 && (s[0] === "{" || s[0] === "[");

class Walk {
  differences: Difference[] = [];
  closeNumbers = 0;
  maxRelative = 0;
  step = 0;
  what = "";

  private diff(where: string, kind: Difference["kind"], a: unknown, b: unknown, at = 0): void {
    this.differences.push({ step: this.step, what: this.what, where, kind, a: short(a, at), b: short(b, at) });
  }

  private closeNumber(a: number, b: number, rel: number): boolean {
    const d = Math.abs(a - b);
    const scale = Math.max(Math.abs(a), Math.abs(b));
    if (!(d <= rel * scale || d <= ABS)) return false;
    this.closeNumbers++;
    if (scale > 0 && d <= rel * scale) this.maxRelative = Math.max(this.maxRelative, d / scale);
    return true;
  }

  /** A number of a JSON body or of the database. */
  number(a: number, b: number, where: string, exact: boolean): void {
    if (Object.is(a, b)) return;
    if (exact || !this.closeNumber(a, b, REL)) this.diff(where, "number", a, b);
  }

  /** A text that carries computed numbers: a reason, an error, a log line. */
  message(a: string, b: string, where: string): void {
    if (a === b) return;
    const na = a.match(NUMBER) ?? [];
    const nb = b.match(NUMBER) ?? [];
    if (a.replace(NUMBER, "#") !== b.replace(NUMBER, "#") || na.length !== nb.length)
      return this.diff(where, "text", a, b, firstDiff(a, b));
    for (let i = 0; i < na.length; i++) {
      if (na[i] === nb[i]) continue;
      if (!this.closeNumber(Number(na[i]), Number(nb[i]), MESSAGE_REL)) return this.diff(where, "number", a, b, firstDiff(a, b));
    }
  }

  /** Two JSON texts: equal as text, or equal as values up to the last digits of their numbers. */
  jsonText(a: string, b: string, where: string): void {
    if (a === b) return;
    let va: unknown;
    let vb: unknown;
    try {
      va = JSON.parse(a);
      vb = JSON.parse(b);
    } catch {
      return this.diff(where, "text", a, b, firstDiff(a, b));
    }
    const before = this.differences.length;
    const closeBefore = this.closeNumbers;
    this.json(va, vb, where, false, false);
    // the same values written differently (order of keys aside, which `json` checks): the bytes differ
    if (this.differences.length === before && a.replace(NUMBER, "#") !== b.replace(NUMBER, "#"))
      this.diff(where, "format", a, b, firstDiff(a, b));
    else if (this.differences.length === before && this.closeNumbers === closeBefore)
      // numbers written differently that parse to the same double ("1.0" and "1")
      this.diff(where, "format", a, b, firstDiff(a, b));
  }

  /** Values of a JSON body. `message`: under `reasons` or `error`; `exact`: under the flat family's `pieces`. */
  json(a: unknown, b: unknown, where: string, message: boolean, exact: boolean): void {
    if (typeof a === "number" && typeof b === "number") return this.number(a, b, where, exact);
    if (typeof a === "string" && typeof b === "string") {
      if (message) return this.message(a, b, where);
      // a configuration kept as JSON text inside a JSON body
      if (a !== b && looksJson(a) && looksJson(b)) return this.jsonText(a, b, where);
      if (a !== b) this.diff(where, "value", a, b, firstDiff(a, b));
      return;
    }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      if (a !== b) this.diff(where, "value", a, b);
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return this.diff(where, "structure", a, b);
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return this.diff(`${where}.length`, "structure", a.length, b.length);
      for (let i = 0; i < a.length; i++) this.json(a[i], b[i], `${where}[${i}]`, message, exact);
      return;
    }
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return this.diff(`${where} (keys)`, "structure", ka, kb);
    // A polygon entry (it has `container_phi`, which no space's entry has) carries its pieces and its
    // orientation as they were sent: no arithmetic touches them, so they are equal bit for bit.
    const flat = "container_phi" in (a as object);
    for (const k of ka)
      this.json(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${where}.${k}`,
        k === "reasons" || k === "error",
        exact || (flat && (k === "pieces" || k === "container_phi")),
      );
  }

  /** A text of the transcript: a body, a line of a stream, a file. */
  text(a: string, b: string, where: string): void {
    if (a === b) return;
    if (looksJson(a) && looksJson(b)) return this.jsonText(a, b, where);
    this.diff(where, "text", a, b, firstDiff(a, b));
  }

  /** The structure of a transcript record; `kind` says what the strings and numbers below are. */
  record(a: unknown, b: unknown, where: string, kind: "plain" | "log" | "db" | "sse"): void {
    if (typeof a === "string" && typeof b === "string") {
      if (kind === "log") return this.message(a, b, where);
      if (kind === "sse" && a.startsWith("data: ") && b.startsWith("data: "))
        return this.text(a.slice(6), b.slice(6), where);
      if (kind === "db") return this.text(a, b, where);
      if (a !== b) this.diff(where, "value", a, b, firstDiff(a, b));
      return;
    }
    if (typeof a === "number" && typeof b === "number") {
      if (kind === "db") return this.number(a, b, where, false);
      if (a !== b) this.diff(where, "value", a, b);
      return;
    }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      if (a !== b) this.diff(where, "value", a, b);
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return this.diff(where, "structure", a, b);
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) this.record(a[i], b[i], `${where}[${i}]`, kind);
      for (let i = n; i < a.length; i++) this.diff(`${where}[${i}]`, "missing", a[i], undefined);
      for (let i = n; i < b.length; i++) this.diff(`${where}[${i}]`, "extra", undefined, b[i]);
      return;
    }
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    // an answer: its body first, since whether Content-Length must agree depends on it
    let lengthFree = false;
    if (typeof oa.body === "string" && typeof ob.body === "string") {
      const before = this.differences.length;
      const closeBefore = this.closeNumbers;
      this.text(oa.body, ob.body, `${where}.body`);
      // numbers that differ in their last digits may be written with a different number of digits
      lengthFree = this.differences.length === before && this.closeNumbers > closeBefore;
    }
    for (const k of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
      const path = where ? `${where}.${k}` : k;
      if (k === "body" && typeof oa.body === "string" && typeof ob.body === "string") continue;
      if (!(k in ob)) this.diff(path, "missing", oa[k], undefined);
      else if (!(k in oa)) this.diff(path, "extra", undefined, ob[k]);
      else if (k === "headers" && lengthFree) {
        const { "content-length": _la, ...ha } = oa[k] as Record<string, unknown>;
        const { "content-length": _lb, ...hb } = ob[k] as Record<string, unknown>;
        this.record(ha, hb, path, "plain");
      } else
        this.record(
          oa[k],
          ob[k],
          path,
          k === "stdout" || k === "stderr" ? "log" : k === "database" ? "db" : k === "events" ? "sse" : k === "files" ? "db" : kind,
        );
    }
  }
}

export function compareTranscripts(fileA: string, fileB: string): Comparison {
  const read = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => l !== "");
  const la = read(fileA);
  const lb = read(fileB);
  const head = JSON.parse(la[0] ?? "{}") as { scenario?: string };
  const result: Comparison = {
    scenario: head.scenario ?? "?",
    records: 0,
    identical: 0,
    close: 0,
    differing: 0,
    closeNumbers: 0,
    maxRelative: 0,
    differences: [],
  };
  const walk = new Walk();
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    result.records++;
    const ta = la[i];
    const tb = lb[i];
    if (ta === tb) {
      result.identical++;
      continue;
    }
    const before = walk.differences.length;
    const closeBefore = walk.closeNumbers;
    if (ta === undefined || tb === undefined) {
      walk.step = i - 1;
      walk.what = "(a transcript ends here)";
      walk.differences.push({ step: i - 1, what: walk.what, where: "", kind: ta === undefined ? "extra" : "missing", a: short(ta ?? ""), b: short(tb ?? "") });
    } else {
      const ra = JSON.parse(ta) as Record<string, unknown>;
      const rb = JSON.parse(tb) as Record<string, unknown>;
      walk.step = typeof ra.i === "number" ? ra.i : i - 1;
      walk.what = `${String(ra.op ?? "header")}${ra.request ? ` ${String(ra.request)}` : ""}`;
      walk.record(ra, rb, "", "plain");
    }
    if (walk.differences.length > before) result.differing++;
    else if (walk.closeNumbers > closeBefore) result.close++;
    else {
      // the lines differ and the walk found nothing: that would be a hole in this comparator
      result.differing++;
      walk.differences.push({ step: walk.step, what: walk.what, where: "", kind: "format", a: short(ta, firstDiff(ta!, tb!)), b: short(tb, firstDiff(ta!, tb!)) });
    }
  }
  result.closeNumbers = walk.closeNumbers;
  result.maxRelative = walk.maxRelative;
  result.differences = walk.differences;
  return result;
}

export function describe(c: Comparison, limit = 20): string {
  const head =
    `${c.scenario}: ${c.records} records, ${c.identical} identical, ${c.close} equal up to the last digits ` +
    `(${c.closeNumbers} numbers, largest relative difference ${c.maxRelative.toExponential(1)}), ${c.differing} different`;
  const lines = c.differences.slice(0, limit).map(
    (d) => `  step ${d.step} [${d.what}] ${d.where} (${d.kind})\n      a: ${d.a}\n      b: ${d.b}`,
  );
  if (c.differences.length > limit) lines.push(`  ... and ${c.differences.length - limit} more`);
  return [head, ...lines].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: node --import tsx native/tools/serverdiff/lib/compare.mts A.transcript.jsonl B.transcript.jsonl");
    process.exit(2);
  }
  const c = compareTranscripts(a, b);
  console.log(describe(c, 200));
  process.exit(c.differing ? 1 : 0);
}
