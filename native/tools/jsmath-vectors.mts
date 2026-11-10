/**
 * Test vectors for native/js: inputs and Node's results for the Math functions and number
 * formats that the server's validators use. Run:
 *   node --import tsx native/tools/jsmath-vectors.mts <out.jsonl> [count per function]
 * Each line: {"f": name, "a": [hex bits of the arguments], "r": hex bits of the result} for Math
 * functions, {"f": "fmt:<kind>", "a": [hex bits], "p": digits, "s": text} for formats.
 */
import { writeFileSync } from "node:fs";

const out = process.argv[2];
const count = Number(process.argv[3] ?? 20000);
if (!out) throw new Error("usage: jsmath-vectors.mts <out.jsonl> [count]");

// mulberry32: the vectors are the same on every run
let state = 0x9e3779b9;
const rnd = (): number => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const uni = (lo: number, hi: number) => lo + (hi - lo) * (rnd() + rnd() / 4294967296);
const buf = new DataView(new ArrayBuffer(8));
const hex = (x: number): string => {
  buf.setFloat64(0, x);
  return buf.getBigUint64(0).toString(16).padStart(16, "0");
};
/** Any double: random bits (infinities and NaN included now and then). */
const anyBits = (): number => {
  buf.setUint32(0, (rnd() * 4294967296) >>> 0);
  buf.setUint32(4, (rnd() * 4294967296) >>> 0);
  return buf.getFloat64(0);
};
const logUni = (lo: number, hi: number) => Math.exp(uni(Math.log(lo), Math.log(hi))) * (rnd() < 0.5 ? -1 : 1);
const special = [0, -0, 1, -1, 0.5, -0.5, 2, Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4, Infinity, -Infinity, NaN, 1e-300, 5e-324, 1e300, 1e-9, 1e-11];

const lines: string[] = [];
const one = (name: string, f: (x: number) => number, gens: (() => number)[]) => {
  for (const x of special) lines.push(JSON.stringify({ f: name, a: [hex(x)], r: hex(f(x)) }));
  for (let i = 0; i < count; i++) {
    const x = gens[i % gens.length]();
    lines.push(JSON.stringify({ f: name, a: [hex(x)], r: hex(f(x)) }));
  }
};
const two = (name: string, f: (x: number, y: number) => number, gens: (() => [number, number])[]) => {
  for (const x of special) for (const y of special) lines.push(JSON.stringify({ f: name, a: [hex(x), hex(y)], r: hex(f(x, y)) }));
  for (let i = 0; i < count; i++) {
    const [x, y] = gens[i % gens.length]();
    lines.push(JSON.stringify({ f: name, a: [hex(x), hex(y)], r: hex(f(x, y)) }));
  }
};

const angle = [() => uni(-7, 7), () => uni(-1, 1), () => uni(-1000, 1000), () => logUni(1e-12, 1e6), () => Math.round(uni(-40, 40)) * (Math.PI / 12) + uni(-1e-9, 1e-9), () => logUni(1e6, 1e18)];
one("sin", Math.sin, angle);
one("cos", Math.cos, angle);
one("tan", Math.tan, angle);
const unit = [() => uni(-1, 1), () => logUni(1e-12, 1), () => (rnd() < 0.5 ? -1 : 1) * (1 - Math.abs(logUni(1e-16, 1e-2)))];
one("asin", Math.asin, unit);
one("acos", Math.acos, unit);
one("atanh", Math.atanh, unit);
const wide = [() => uni(-10, 10), () => logUni(1e-12, 1e12), () => uni(-1, 1)];
one("atan", Math.atan, wide);
one("asinh", Math.asinh, wide);
one("cbrt", Math.cbrt, wide);
const expo = [() => uni(-30, 30), () => uni(-1, 1), () => uni(-700, 700), () => logUni(1e-12, 1)];
one("exp", Math.exp, expo);
one("sinh", Math.sinh, expo);
one("cosh", Math.cosh, expo);
one("tanh", Math.tanh, expo);
const pos = [() => uni(0, 10), () => Math.abs(logUni(1e-300, 1e300)), () => 1 + uni(-1e-3, 1e-3)];
one("log", Math.log, pos);
one("log2", Math.log2, pos);
one("log10", Math.log10, pos);
one("sqrt", Math.sqrt, pos);
one("round", Math.round, [() => uni(-10, 10), () => Math.round(uni(-100, 100)) + 0.5, () => logUni(1e-3, 1e17)]);
two("atan2", Math.atan2, [() => [uni(-5, 5), uni(-5, 5)], () => [logUni(1e-12, 1e6), logUni(1e-12, 1e6)], () => [uni(-1e-9, 1e-9), uni(-2, 2)]]);
two("pow", Math.pow, [
  () => [uni(0, 10), uni(-5, 5)],
  () => [uni(-10, 10), Math.round(uni(-8, 8))],
  () => [Math.abs(logUni(1e-6, 1e6)), uni(-3, 3)],
  () => [uni(0, 4), Math.round(uni(-6, 6)) / 2],
  () => [uni(0, 4), Math.round(uni(-9, 9)) / 3],
  () => [10, Math.round(uni(-30, 30))],
  () => [2, Math.round(uni(-60, 60))],
]);
// hypot: 1 to 6 arguments
for (let i = 0; i < count * 2; i++) {
  const n = 1 + (i % 6);
  const scale = i % 3 === 0 ? 1 : Math.abs(logUni(1e-160, 1e160));
  const a = Array.from({ length: n }, () => (i % 7 === 0 ? logUni(1e-12, 1e3) : uni(-3, 3)) * scale);
  lines.push(JSON.stringify({ f: "hypot", a: a.map(hex), r: hex(Math.hypot(...a)) }));
}
for (const a of [[], [0], [-0], [Infinity, NaN], [NaN, 1], [3, 4], [1e200, 1e200], [1e-200, 1e-200], [-3, -4, -12]])
  lines.push(JSON.stringify({ f: "hypot", a: a.map(hex), r: hex(Math.hypot(...a)) }));

// number formats
const nums = [() => uni(-10, 10), () => logUni(1e-12, 1e3), () => logUni(1e-30, 1e30), () => anyBits(), () => Math.round(uni(-1e6, 1e6)), () => Math.round(uni(-1000, 1000)) / 8, () => Math.round(uni(-100000, 100000)) / 1000, () => logUni(1e-320, 1e-300), () => logUni(1e15, 1e23)];
const fmtSpecial = [...special, 1e21, 1e-7, 1.5e-7, 123456789012345680000, 0.000001, 0.0000001, 1e-6, 999999999999999900000, 0.5, 1.5, 2.5, 0.125, 0.375, 1.005, 1.45, 8.345, 1e21 - 65536, 4.35, 0.045, 25, 35, 0.05, 0.15, 0.25, 0.35, 5e-7];
for (const x of fmtSpecial) lines.push(JSON.stringify({ f: "fmt:string", a: [hex(x)], s: String(x) }));
for (let i = 0; i < count * 3; i++) {
  const x = nums[i % nums.length]();
  lines.push(JSON.stringify({ f: "fmt:string", a: [hex(x)], s: String(x) }));
}
for (const x of fmtSpecial) {
  lines.push(JSON.stringify({ f: "fmt:exponential", a: [hex(x)], p: -1, s: x.toExponential() }));
  for (let p = 0; p <= 20; p++) {
    lines.push(JSON.stringify({ f: "fmt:exponential", a: [hex(x)], p, s: x.toExponential(p) }));
    lines.push(JSON.stringify({ f: "fmt:fixed", a: [hex(x)], p, s: x.toFixed(p) }));
    if (p >= 1) lines.push(JSON.stringify({ f: "fmt:precision", a: [hex(x)], p, s: x.toPrecision(p) }));
  }
}
for (let i = 0; i < count * 3; i++) {
  const x = nums[i % nums.length]();
  const p = Math.floor(rnd() * 21);
  lines.push(JSON.stringify({ f: "fmt:exponential", a: [hex(x)], p: -1, s: x.toExponential() }));
  lines.push(JSON.stringify({ f: "fmt:exponential", a: [hex(x)], p, s: x.toExponential(p) }));
  lines.push(JSON.stringify({ f: "fmt:fixed", a: [hex(x)], p, s: x.toFixed(p) }));
  lines.push(JSON.stringify({ f: "fmt:precision", a: [hex(x)], p: p + 1, s: x.toPrecision(p + 1) }));
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} vectors written to ${out} (node ${process.version}, v8 ${process.versions.v8})`);
