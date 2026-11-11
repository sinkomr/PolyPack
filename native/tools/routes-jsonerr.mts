// Writes what `JSON.parse` says of texts that are not JSON, for native/spaces/src/json_error.rs,
// which writes the same messages (the server logs them when a records file cannot be read):
//
//   node --import tsx native/tools/routes-jsonerr.mts            writes native/spaces/tests/fixtures/json_errors.json
//   node --import tsx native/tools/routes-jsonerr.mts --check    fails when that file is not what this Node says
//   node --import tsx native/tools/routes-jsonerr.mts --out FILE --count N   a larger sample, for a run by hand
//     (POLYPACK_JSON_ERRORS=FILE cargo test -p polypack-spaces --test json_errors)
//
// Each case is { text, message }; message is null for a text that is JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const count = Number(value("--count") ?? 600);
const out = value("--out") ?? resolve(root, "native/spaces/tests/fixtures/json_errors.json");

/** mulberry32: the same cases on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byHand = [
  "{ not json", "", " ", "{", "[", "[1,", "[1", '{"a":1', '{"a"', '{"a":', '{"a":1,', '{"a":1,}', "[1,]", "nul", "nulll", "tru", "-", "-x", "01", "-01", "1.", "1.x",
  "1e", "1e+", '"abc', '"a\\x"', '"a\\u12g4"', '"a\nb"', "1 2", "{} x", "undefined", "NaN", "Infinity", "[object Object]", "abcdefghijklmnopqrstuvwxyz",
  "[1,2,3,4,5,6,7,8,9,10,11,x,13,14,15,16,17,18,19,20]", "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,x]", '{"records": [\n  {"a": 1},\n  {"b": }\n]}',
  "﻿{}", "é", '["\\ud800", é]', '{"a" 1}', "{1:2}", "[1 2]", '"\\', '"\\u12', "-0x", "0x", "1e5x", ".5", "+1", "[1}", '{"a":1]', "tx", "fals", "n", "t", "[,]", ":", "}", "]", ",",
  "t1", 't"', "n ", "f[", "nulx", "truE", '"\\€"', '"\\é"', '{"a\\q":1}', '{"a\nb":1}', '{"a', '{"\\u00zz":1}', "[\r\n1,\r\n2,\r\nx]", "[\r1,\n\rx]", "{\n\n  \"a\": 1,\n  b\n}",
  "12345678901234567890x", "[1e400]", "1e-", "0.", "0e", "0.5e", "-", "--1", "- 1", "1..2", "[\"\\ud83d\\ude00\", 😀]", "😀", "x".repeat(30), " ".repeat(25) + "x",
  "[" + " ".repeat(30) + "]x", '{"a":{"b":[1,2,{"c":null}]}}', "[[[[", "]]]]", '{"a":1}}', "[1,2,3]]", "true false", "nullnull", '""x', '"a" "b"', "{,}", '{"a":}', '{"a":1 "b":2}', '{"a":1,,}', "[1,,2]",
  " []", "[] ", "/* c */ 1", "// c\n1", "'a'", "{'a':1}", "[0x10]", "[1.e3]", "[1e3.5]", "[+1]", "[-]", "[-a]", "[.5]", "[1.]", "[1e]", "[01]", "[-01]", "[00]", "[-0]", "[-0.0e+0]", "0", "-0", '"\\u0000"', '"\u0000"', '"\t"', '"\u001f"', '"\u007f"',
];

const bases = [
  JSON.stringify({ generated: "2026-10-24", records: [{ id: "sphere/3/6", N: 3, P: 6, score_cert: 1.2345678901234567, config: { rho: 1.2345678901234567, pieces: [{ q: [1, 0, -0.5, 2e-7] }] }, status: "best_known", bound: null, ok: true, no: false }] }),
  JSON.stringify({ P: 2, config: { s: 1.5, pieces: [[0, 0, 0, 1, 0, 0, 0], [0.25, -0.75, 1e-9, 0.5, 0.5, 0.5, 0.5]] } }),
  JSON.stringify([{ a: "x\ny\"z\\wé€", b: [true, false, null, -1.5e-3, 0, 12] }, "s", 3], null, 2),
  '{"a" : [ 1 , 2 , { "b" : "c" } ] , "d" : -0.0 , "e" : 1E+2 }',
  JSON.stringify("a string with \\ and \" and \u0001 and 😀"),
  "12.5e-3",
];
const inserts = ["{", "}", "[", "]", ":", ",", '"', "\\", "-", "0", "1", ".", "e", "E", "+", "t", "f", "n", "u", "x", " ", "\n", "\r", "\r\n", "\t", "\u0001", "é", "€", "😀", "\ud800", "true", "null", "\\u", "\\u12", "00", "/"];

const random = rng(20261110);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
const texts = new Set<string>(byHand);
while (texts.size < count) {
  let t = pick(bases);
  const edits = 1 + Math.floor(random() * 2);
  for (let k = 0; k < edits; k++) {
    const at = Math.floor(random() * (t.length + 1));
    const kind = random();
    if (kind < 0.3) t = t.slice(0, at) + t.slice(at + 1 + Math.floor(random() * 3));
    else if (kind < 0.7) t = t.slice(0, at) + pick(inserts) + t.slice(at);
    else if (kind < 0.85) t = t.slice(0, at);
    else t = t.slice(0, at) + pick(inserts) + t.slice(at + 1);
  }
  texts.add(t);
}

const cases = [...texts].map((text) => {
  try {
    JSON.parse(text);
    return { text, message: null as string | null };
  } catch (e) {
    return { text, message: (e as Error).message };
  }
});
// a text with half a surrogate pair cannot be written as UTF-8; such cases are left out of the file
const kept = cases.filter((c) => c.text.isWellFormed() && (c.message === null || c.message.isWellFormed()));
const body = JSON.stringify({ source: "native/tools/routes-jsonerr.mts (the same under Node 24 and 26)", cases: kept }, null, 1) + "\n";
if (flag("--check")) {
  if (readFileSync(out, "utf8") !== body) {
    console.error(`${out} is not what this Node says; write it again with native/tools/routes-jsonerr.mts`);
    process.exit(1);
  }
  console.log(`${out} is up to date (${kept.length} cases)`);
} else {
  writeFileSync(out, body);
  console.log(`${out}: ${kept.length} cases, ${kept.filter((c) => c.message !== null).length} of them not JSON`);
}
