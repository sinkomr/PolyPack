// Reading and writing the data files without disturbing the numbers the unit conversion does not
// touch. Some files are written by Python (json.dump, indent 1: "2.0", "1e-05", \uXXXX escapes), some
// by JavaScript (JSON.stringify). A number written with a "." or an exponent is read as an `F` that
// keeps its source text, so a file that is read and written back unchanged is byte-identical, and a
// converted float is printed in the style of its file ("1.0" for Python, "1" for JavaScript).
// Integers read as plain numbers. F has valueOf, so arithmetic works on it directly.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

export class F {
  constructor(
    public v: number,
    public src?: string,
  ) {}
  valueOf(): number {
    return this.v;
  }
}

/**
 * How a file writes its numbers: `pyExp` is Python's repr for fractions and exponents ("1e-05", decimals down to 1e-4),
 * `pyInt` writes a float with an integral value as "2.0" (some files, such as surface/records.json, write "2").
 */
export type Style = { pyExp: boolean; pyInt: boolean; indent: number; ascii: boolean; newline: boolean };

export const isNum = (x: unknown): x is number | F => typeof x === "number" || x instanceof F;
export const val = (x: number | F): number => (x instanceof F ? x.v : x);
/** x times f (a power of two, so exact), keeping the kind (float or integer) of x. */
export const sc = <T extends number | F>(x: T, f: number): T => (x instanceof F ? (new F(x.v * f) as T) : ((x as number) * f as T));
/** A float (printed as one even when it is integral). */
export const fl = (x: number): F => new F(x);

export function parse(text: string): any {
  // the third argument of a reviver (the number's source text) is in Node 22+ but not yet in TypeScript's lib
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source && /[.eE]/.test(context.source) ? new F(value, context.source) : value;
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
}

/** Python's repr(float), from the shortest round-trip digits. */
export function pyRepr(x: number): string {
  if (!Number.isFinite(x)) throw new Error("not finite");
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [m, e] = x.toExponential().split("e");
  const exp = Number(e);
  const neg = m.startsWith("-");
  const digits = m.replace("-", "").replace(".", "");
  let out: string;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const int = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
      const frac = digits.slice(exp + 1) || "0";
      out = `${int}.${frac}`;
    } else out = `0.${"0".repeat(-exp - 1)}${digits}`;
  } else {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    out = `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return (neg ? "-" : "") + out;
}

function fmtNumber(x: number | F, st: Style): string {
  if (x instanceof F && x.src !== undefined) return x.src;
  const v = x instanceof F ? x.v : x;
  if (Number.isInteger(v)) return x instanceof F && st.pyInt ? pyRepr(v) : JSON.stringify(v);
  return st.pyExp ? pyRepr(v) : JSON.stringify(v);
}

function fmtString(s: string, st: Style): string {
  const j = JSON.stringify(s);
  return st.ascii ? j.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : j;
}

export function stringify(v: any, st: Style, depth = 0): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return String(v);
  if (isNum(v)) return fmtNumber(v, st);
  if (typeof v === "string") return fmtString(v, st);
  const pad = (d: number) => "\n" + " ".repeat(st.indent * d);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const items = v.map((x) => stringify(x, st, depth + 1));
    return st.indent ? "[" + items.map((i) => pad(depth + 1) + i).join(",") + pad(depth) + "]" : "[" + items.join(",") + "]";
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (!keys.length) return "{}";
  const items = keys.map((k) => fmtString(k, st) + (st.indent ? ": " : ":") + stringify(v[k], st, depth + 1));
  return st.indent ? "{" + items.map((i) => pad(depth + 1) + i).join(",") + pad(depth) + "}" : "{" + items.join(",") + "}";
}

/** Guess how a file was written from its text: indent, Python float style, ASCII escapes, final newline. */
export function detectStyle(text: string): Style {
  const m = /^[\[{]\n( +)/.exec(text);
  const indent = m ? m[1].length : 0;
  // Python's json.dump writes floats as "2.0" and exponents with two digits ("1e-05"); JSON.stringify never does either
  const pyExp = /\de[-+]0\d/.test(text);
  const pyInt = /[:\[,]\s*-?\d+\.0\s*(?=[,\]}])/.test(text);
  return { pyExp, pyInt, indent, ascii: /\\u[0-9a-f]{4}/.test(text), newline: text.endsWith("\n") };
}

export interface Loaded<T = any> {
  data: T;
  style: Style;
  text: string;
}

export function readJson<T = any>(path: string, gz = false): Loaded<T> {
  const text = gz ? gunzipSync(readFileSync(path)).toString("utf8") : readFileSync(path, "utf8");
  return { data: parse(text), style: detectStyle(text), text };
}

export function render(l: Loaded): string {
  return stringify(l.data, l.style) + (l.style.newline ? "\n" : "");
}

export function writeJson(path: string, l: Loaded, gz = false): void {
  const out = render(l);
  writeFileSync(path, gz ? gzipSync(Buffer.from(out, "utf8"), { level: 9 }) : out);
}
