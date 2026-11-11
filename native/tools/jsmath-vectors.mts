/**
 * Test vectors for native/js: inputs and Node's results for the Math functions and number
 * formats that the server's validators use.
 *
 * Two outputs:
 *
 *   node native/tools/jsmath-vectors.mts --bin <out.bin> [count per function, default 1000000]
 *     The Math functions, as a binary file (16 bytes per vector of one argument: about 500 MB for
 *     a million per function; keep it in a scratch directory). The arguments are drawn to reach
 *     every branch of V8's algorithms (src/base/ieee754.cc): each threshold a function switches
 *     on, with the neighbouring high words and doubles, multiples of pi/2 and pi/4 and their
 *     neighbours, huge arguments (the large-argument reduction), subnormals, signed zeros,
 *     infinities, NaN, and plain uniform and exponent-uniform draws.
 *     The generator is seeded and uses only operations that every platform computes the same way
 *     (integers, bit patterns, + - * /, decimal literals), never a Math function, so that two
 *     platforms produce the same arguments and their results can be compared one by one
 *     (examples/vectors.rs --compare).
 *
 *   node native/tools/jsmath-vectors.mts <out.jsonl> [count, default 20000]
 *     The number formats (and a small sample of the Math functions) as JSON lines:
 *     {"f": name, "a": [hex bits of the arguments], "r": hex bits of the result} for Math
 *     functions, {"f": "fmt:<kind>", "a": [hex bits], "p": digits, "s": text} for formats, after
 *     a first line {"f": "meta", node, v8, arch, platform}.
 *
 * The file has no TypeScript that needs a compiler (types only), so Node 24 and later run it as it
 * is, without tsx; that is how the vectors of the production platform are made:
 *   docker run --rm --platform linux/amd64 -v $PWD/native/tools:/tools:ro -v <scratch>:/out \
 *     node:24-slim node /tools/jsmath-vectors.mts --bin /out/linux-x64-node24.bin
 *
 * Binary format: "JSMATHV1", then records of JSON behind a u32 (little-endian) length: first
 * {node, v8, arch, platform, count}, then for each section {name, arity, n} followed by n*arity
 * doubles (the arguments, vector by vector) and n doubles (the results), little-endian.
 */
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const binary = args[0] === "--bin";
if (binary) args.shift();
const out = args[0];
const count = Number(args[1] ?? (binary ? 1000000 : 20000));
if (!out || !(count > 0)) throw new Error("usage: jsmath-vectors.mts [--bin] <out> [count]");

// mulberry32: the vectors are the same on every run
let state = 0x9e3779b9;
const rnd = (): number => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const u32 = (): number => (rnd() * 4294967296) >>> 0;
/** A whole number from lo to hi, both included. */
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const uni = (lo: number, hi: number) => lo + (hi - lo) * (rnd() + rnd() / 4294967296);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
const buf = new DataView(new ArrayBuffer(8));
const hex = (x: number): string => {
  buf.setFloat64(0, x);
  return buf.getBigUint64(0).toString(16).padStart(16, "0");
};
/** The double with these high and low words. */
const words = (hi: number, lo: number): number => {
  buf.setUint32(0, hi >>> 0);
  buf.setUint32(4, lo >>> 0);
  return buf.getFloat64(0);
};
const highWord = (x: number): number => {
  buf.setFloat64(0, x);
  return buf.getUint32(0);
};
const lowWord = (x: number): number => {
  buf.setFloat64(0, x);
  return buf.getUint32(4);
};
/** Any double: random bits (infinities and NaN included now and then). */
const anyBits = (): number => words(u32(), u32());
/** x moved by j units in the last place, away from zero for j > 0 (stops at zero). */
const ulps = (x: number, j: number): number => {
  if (x !== x || x === Infinity || x === -Infinity) return x;
  let hi = highWord(x);
  const sign = hi & 0x80000000;
  hi = (hi & 0x7fffffff) >>> 0;
  let lo = lowWord(x) + j;
  while (lo >= 4294967296) {
    lo -= 4294967296;
    hi += 1;
  }
  while (lo < 0) {
    lo += 4294967296;
    hi -= 1;
  }
  if (hi < 0) return words(sign, 0);
  if (hi >= 0x7ff00000) return words(sign | 0x7fefffff, 0xffffffff);
  return words(sign | hi, lo);
};
const sign = (x: number): number => (rnd() < 0.5 ? -x : x);
/** 2 to the e, e from -1074 to 1023 (exact, no Math.pow). */
const pow2 = (e: number): number => (e >= -1022 ? words((e + 1023) << 20, 0) : e >= -1042 ? words(1 << (e + 1042), 0) : words(0, 1 << (e + 1074)));
/** A positive double with a random significand and its exponent drawn evenly from elo to ehi. */
const expo = (elo: number, ehi: number): number => {
  const e = int(elo, ehi);
  if (e >= -1022) return words(((e + 1023) << 20) | (u32() >>> 12), u32());
  // subnormal: leading bit at 2^e, random bits below it
  const p = e + 1074;
  if (p >= 32) return words((1 << (p - 32)) | (u32() >>> (64 - p)), u32());
  return words(0, p === 0 ? 1 : (1 << p) | (u32() >>> (32 - p)));
};
const logUni = (lo: number, hi: number) => Math.exp(uni(Math.log(lo), Math.log(hi))) * (rnd() < 0.5 ? -1 : 1);
const special = [0, -0, 1, -1, 0.5, -0.5, 2, Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4, Infinity, -Infinity, NaN, 1e-300, 5e-324, 1e300, 1e-9, 1e-11];

if (binary) {
  if (new Uint8Array(new Float64Array([1]).buffer)[7] !== 0x3f) throw new Error("a little-endian machine is expected");
  const PIO2 = 1.5707963267948966;
  const LN2 = 0.6931471805599453;
  /** Values every function is given, both signs. */
  const everywhere = [
    0, 1, 2, 3, 4, 5, 8, 10, 16, 22, 100, 1000, 0.5, 0.25, 0.75, 1.5, 2.5, 0.1, 0.2, 0.3, 0.7, 0.9, 1 / 3, 2 / 3,
    Infinity, NaN, 5e-324, 1e-323, 2.2250738585072014e-308, 2.225073858507201e-308, 1.7976931348623157e308,
    8.98846567431158e307, 1e-300, 1e300, 1e-9, 1e-11, 1e-16, 1e16, 1e22, 4503599627370496, 9007199254740992,
    PIO2, PIO2 * 2, PIO2 / 2, PIO2 * 3, PIO2 * 4, PIO2 / 3, PIO2 * 2 / 3, PIO2 * 2 / 5, PIO2 * 2 / 6, PIO2 * 2 / 180, LN2, LN2 / 2, LN2 * 1.5,
    2.718281828459045, 1.4142135623730951, 0.7071067811865476, 1.7320508075688772, 0.8660254037844386,
    709.782712893384, 709.7827128933841, 709.7822265625, 710.4758600739439, 710.475860073944, -745.1332191019411, -745.1332191019412,
    -708.3964185322641, 38.816242111356935, 0.34657359027997264, 1.0397207708399179,
    // arguments known to be hard for the reduction modulo pi/2 (many leading zeros of the remainder)
    5.319372648326541e255, 1.2246467991473532e-16, 6.123233995736766e-17,
    3.141592653589793, 6.283185307179586, 1.5707963267948966, 4.71238898038469, 823549.6645826459, 823549.664582646, 1647099.3291652957,
  ];
  type Gen = () => number;
  /** A high word of the list or a neighbour of it, with a random low word or a boundary one. */
  const nearHigh = (list: readonly number[], signed = true): Gen => () => {
    const hi = pick(list) + int(-2, 2);
    const lo = rnd() < 0.7 ? u32() : pick([0, 1, 2, 0xffffffff, 0xfffffffe, 0x80000000]);
    const x = words(Math.max(0, Math.min(0x7ff80000, hi)), lo);
    return signed ? sign(x) : x;
  };
  /** A double of the list or one a few units in the last place from it. */
  const nearValue = (list: readonly number[], signed = true): Gen => () => {
    const x = ulps(pick(list), rnd() < 0.5 ? int(-3, 3) : int(-600, 600));
    return signed ? sign(x) : x;
  };
  /** n*c for a whole n up to nmax, exactly or a little off (units in the last place, or relative 2^-30 or so). */
  const nearMultiple = (c: number, nmax: number): Gen => () => {
    const n = rnd() < 0.5 ? int(1, Math.min(nmax, 256)) : int(1, nmax);
    const x = n * c;
    const r = rnd();
    return sign(r < 0.4 ? ulps(x, int(-3, 3)) : r < 0.7 ? ulps(x, int(-2000, 2000)) : x * (1 + uni(-1, 1) * pick([1e-6, 1e-9, 1e-12])));
  };
  const wide: Gen = () => sign(expo(-1074, 1023));
  const moderate: Gen = () => sign(expo(-60, 60));
  const eighths: Gen = () => int(-4000, 4000) / pick([1, 2, 4, 8, 3, 5, 10, 100]);
  const fixed: Gen = () => sign(pick(everywhere));
  /** Draws from the generators in proportion to their weights. */
  const mix = (parts: readonly (readonly [number, Gen])[]): Gen => {
    const total = parts.reduce((s, p) => s + p[0], 0);
    return () => {
      let r = rnd() * total;
      for (const [w, g] of parts) {
        r -= w;
        if (r < 0) return g();
      }
      return parts[parts.length - 1][1]();
    };
  };
  const common: readonly (readonly [number, Gen])[] = [[1, anyBits], [3, wide], [3, moderate], [2, eighths], [1, fixed]];

  // sin, cos, tan: kernels on [-pi/4, pi/4] and their thresholds, the three reductions
  const npio2hw = [0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb, 0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb];
  const angle = mix([
    ...common,
    [12, () => uni(-0.7853981633974483, 0.7853981633974483)],
    [10, () => uni(-7, 7)],
    [8, () => uni(-100, 100)],
    [6, () => uni(-823550, 823550)],
    [6, () => sign(expo(-30, 0))],
    [6, () => sign(expo(19, 60))],
    [6, () => sign(expo(60, 1023))],
    [8, nearHigh([0x3fe921fb, 0x4002d97c, 0x3ff921fb, 0x413921fb, 0x7ff00000, 0x3e400000, 0x3e300000, 0x3fd33333, 0x3fe90000, 0x3fe59428])],
    [6, nearHigh(npio2hw)],
    [8, nearMultiple(PIO2, 40)],
    [8, nearMultiple(PIO2, 524288)],
    [5, nearMultiple(PIO2, 4294967295)],
    [4, nearMultiple(PIO2 / 2, 2000000)],
    [4, nearMultiple(PIO2 / 6, 1000)], // multiples of 15 degrees
    [3, nearMultiple(PIO2 / 90, 100000)], // whole degrees
    [3, () => sign(int(1, 100000) * PIO2 * pow2(int(1, 900)))], // a multiple of pi/2 scaled up: long cancellation in the large reduction
  ]);
  const unit = mix([
    [1, anyBits], [1, wide], [1, fixed], [2, eighths],
    [14, () => uni(-1, 1)],
    [6, () => sign(expo(-60, -1))],
    [6, () => sign(1 - expo(-53, -2))],
    [3, () => uni(-1.001, 1.001)],
    [8, nearHigh([0x3ff00000, 0x3fe00000, 0x3e400000, 0x3e300000, 0x3c600000, 0x3fef3333])],
    [3, nearValue([1, 0.5, 0.975, 0.7071067811865476, 0.8660254037844386])],
  ]);
  const real = mix([
    ...common,
    [10, () => uni(-10, 10)],
    [8, () => uni(-1, 1)],
    [6, () => sign(expo(-30, 30))],
    [4, () => sign(expo(25, 70))],
    [8, nearHigh([0x44100000, 0x3fdc0000, 0x3e400000, 0x3e300000, 0x3ff30000, 0x3fe60000, 0x40038000, 0x7ff00000, 0x41b00000, 0x40000000, 0x3ff00000])],
    [3, nearValue([0.4375, 0.6875, 1.1875, 2.4375, 1, 2, 268435456])],
  ]);
  const cube = mix([
    ...common,
    [10, () => uni(-10, 10)],
    [10, wide],
    [5, () => sign(expo(-1074, -1000))],
    [5, () => { const n = int(1, 200000); return sign(n * n * n); }], // exact cubes
    [3, () => { const n = int(1, 2000); return sign((n * n * n) / pick([8, 64, 512, 4096])); }],
    [3, nearHigh([0x7ff00000, 0x00100000, 0x3ff00000])],
  ]);
  // exp, expm1, sinh, cosh, tanh
  const expHigh = [0x40862e42, 0x7ff00000, 0x3fd62e42, 0x3fd62e43, 0x3ff0a2b2, 0x3e300000, 0x4043687a, 0x3c900000, 0x3c800000, 0x40360000, 0x3ff00000, 0x40874910];
  const expArg = mix([
    ...common,
    [10, () => uni(-1, 1)],
    [10, () => uni(-40, 40)],
    [10, () => uni(-750, 750)],
    [4, () => uni(700, 712)],
    [4, () => uni(-750, -700)],
    [6, () => sign(expo(-60, -1))],
    [8, nearHigh(expHigh)],
    [6, nearMultiple(LN2 / 2, 2200)],
    [4, nearMultiple(LN2, 1100)],
    [4, nearValue([1, 22, 0.5, 0.25, 709.782712893384, 709.7822265625, 710.4758600739439, 745.1332191019411, 707.7032713517042, 708.3964185322641, 38.816242111356935, 0.34657359027997264, 1.0397207708399179, 3.725290298461914e-9])],
  ]);
  // log, log2, log10: positive, every exponent, significands at the thresholds
  const mant = [0x00000, 0x00001, 0x00002, 0xffffe, 0xfffff, 0x6a09c, 0x6a09e, 0x6147a, 0x6b851, 0x6a09b, 0x95f64];
  const positive = mix([
    [1, anyBits], [1, fixed], [1, eighths],
    [10, () => uni(0, 10)],
    [10, () => expo(-1074, 1023)],
    [8, () => expo(-10, 10)],
    [6, () => 1 + uni(-1e-3, 1e-3)],
    [3, () => 1 + uni(-1, 1) * pow2(int(-52, -10))],
    [8, () => words(((int(-1022, 1023) + 1023) << 20) | ((pick(mant) + int(-2, 2)) & 0xfffff), rnd() < 0.7 ? u32() : pick([0, 1, 0xffffffff]))],
    [3, () => ulps(pow2(int(-1074, 1023)), int(-3, 3))],
    [3, () => Number("1e" + int(-323, 308))],
    [2, () => ulps(Number("1e" + int(-323, 308)), int(-3, 3))],
    [2, () => expo(-1074, -1023)],
    [1, () => -expo(-1074, 1023)],
    [2, () => int(1, 1000000)],
  ]);
  const log1pArg = mix([
    ...common,
    [10, () => uni(-1, 1)],
    [8, () => uni(-1, 10)],
    [6, () => sign(expo(-60, 0))],
    [6, () => expo(0, 1023)],
    [6, nearHigh([0x3fda827a, 0x3ff00000, 0x3e200000, 0x3c900000, 0x3fd2bec4, 0x7ff00000, 0x43400000, 0x43300000])],
    [6, () => pow2(int(-30, 60)) * (1 + uni(-1, 1) * pow2(int(-40, -18))) - 1], // 1+x next to a power of two
    [4, () => (1.4142135623730951 * pow2(int(-3, 60))) * (1 + uni(-1e-5, 1e-5)) - 1], // 1+x next to sqrt(2) times a power of two
    [3, nearValue([-1, 0.41421356237309515, -0.2928932188134524, 1, 3])],
  ]);
  const acoshArg = mix([
    [1, anyBits], [1, fixed], [1, eighths], [1, wide],
    [10, () => uni(1, 2)],
    [8, () => uni(1, 100)],
    [8, () => expo(0, 1023)],
    [6, () => 1 + expo(-52, 0)],
    [4, () => expo(20, 35)],
    [6, nearHigh([0x3ff00000, 0x41b00000, 0x7ff00000, 0x40000000], false)],
    [2, nearValue([1, 2, 268435456], false)],
  ]);
  const rounding = mix([
    [3, () => uni(-10, 10)], [3, () => int(-100000, 100000) + 0.5], [2, wide], [1, anyBits], [1, fixed],
    [2, () => sign(ulps(int(0, 100000) + 0.5, int(-2, 2)))], [2, () => sign(expo(48, 54))],
  ]);

  // each section is written as soon as it is made: {name, arity, n} as JSON behind a u32 length, the arguments, the results
  const fd = openSync(out, "w");
  const u32le = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const json = (v: unknown) => {
    const b = Buffer.from(JSON.stringify(v));
    writeSync(fd, u32le(b.length));
    writeSync(fd, b);
  };
  writeSync(fd, Buffer.from("JSMATHV1"));
  json({ node: process.version, v8: process.versions.v8, arch: process.arch, platform: process.platform, count });
  let total = 0;
  let sectionCount = 0;
  const section = (s: { name: string; arity: number; n: number; a: Float64Array; r: Float64Array }) => {
    json({ name: s.name, arity: s.arity, n: s.n });
    writeSync(fd, new Uint8Array(s.a.buffer, 0, 8 * s.arity * s.n));
    writeSync(fd, new Uint8Array(s.r.buffer, 0, 8 * s.n));
    total += s.n;
    sectionCount++;
  };
  const one = (name: string, f: (x: number) => number, gen: Gen) => {
    const extra = [...everywhere, ...everywhere.map((x) => -x)];
    const n = count + extra.length;
    const a = new Float64Array(n);
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = i < extra.length ? extra[i] : gen();
    for (let i = 0; i < n; i++) r[i] = f(a[i]);
    section({ name, arity: 1, n, a, r });
  };
  const two = (name: string, f: (x: number, y: number) => number, gen: () => [number, number]) => {
    const sp = [0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3, 1.5, 1 / 3, 10, Infinity, -Infinity, NaN, 5e-324, -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308, 1e-300, 1e300, 0.9999999999999999, 1.0000000000000002, 1024, 1023, -1074, 1e22, 9007199254740992, 9007199254740993, -9007199254740991];
    const n = count + sp.length * sp.length;
    const a = new Float64Array(2 * n);
    const r = new Float64Array(n);
    let i = 0;
    for (const x of sp) for (const y of sp) {
      a[2 * i] = x;
      a[2 * i + 1] = y;
      i++;
    }
    for (; i < n; i++) {
      const [x, y] = gen();
      a[2 * i] = x;
      a[2 * i + 1] = y;
    }
    for (i = 0; i < n; i++) r[i] = f(a[2 * i], a[2 * i + 1]);
    section({ name, arity: 2, n, a, r });
  };

  one("sin", Math.sin, angle);
  one("cos", Math.cos, angle);
  one("tan", Math.tan, angle);
  one("asin", Math.asin, unit);
  one("acos", Math.acos, unit);
  one("atanh", Math.atanh, unit);
  one("atan", Math.atan, real);
  one("asinh", Math.asinh, real);
  one("cbrt", Math.cbrt, cube);
  one("exp", Math.exp, expArg);
  one("expm1", Math.expm1, expArg);
  one("sinh", Math.sinh, expArg);
  one("cosh", Math.cosh, expArg);
  one("tanh", Math.tanh, expArg);
  one("log", Math.log, positive);
  one("log2", Math.log2, positive);
  one("log10", Math.log10, positive);
  one("log1p", Math.log1p, log1pArg);
  one("acosh", Math.acosh, acoshArg);
  one("sqrt", Math.sqrt, positive);
  one("round", Math.round, rounding);

  // atan2(y, x): every quadrant, lattice points, quotients at the thresholds of atan and at 2^+-60
  const pairs: (() => [number, number])[] = [
    () => [uni(-5, 5), uni(-5, 5)],
    () => [uni(-5, 5), uni(-5, 5)],
    () => [int(-50, 50), int(-50, 50)],
    () => [int(-2000, 2000) / pick([1, 2, 4, 8, 10]), int(-2000, 2000) / pick([1, 2, 4, 8, 10])],
    () => [sign(expo(-40, 40)), sign(expo(-40, 40))],
    () => [wide(), wide()],
    () => { const x = wide(); return [x * sign(pow2(int(-70, 70))) * uni(0.5, 2), x]; },
    () => { const x = sign(expo(-300, 300)); return [x * pick([0.4375, 0.6875, 1.1875, 2.4375, 1, 0.5, 1.5]) * (1 + uni(-1, 1) * pick([0, 1e-15, 1e-9, 1e-3])), x]; },
    () => [moderate(), sign(ulps(1, int(-2, 2)))],
    () => [uni(-1e-9, 1e-9), uni(-2, 2)],
    () => [uni(-2, 2), uni(-1e-9, 1e-9)],
    () => [anyBits(), anyBits()],
    () => [fixed(), moderate()],
    () => [moderate(), fixed()],
    () => [fixed(), fixed()],
    () => { const t = uni(-1, 1) * pick([1, 20, 1e6]), r = uni(0, 3) / (1 + t * t); return [r * (2 * t), r * (1 - t * t)]; }, // points of a circle
  ];
  two("atan2", Math.atan2, () => pick(pairs)());

  // pow(x, y)
  const powers: (() => [number, number])[] = [
    () => [uni(0, 10), uni(-5, 5)],
    () => [uni(0, 2), uni(-50, 50)],
    () => [uni(-10, 10), int(-8, 8)],
    () => [uni(-10, 10), int(3, 4)],
    () => [expo(-20, 20), uni(-3, 3)],
    () => [expo(-1074, 1023), uni(-2, 2)],
    () => [expo(-1074, 1023), sign(expo(-10, 10))],
    () => [uni(0, 4), int(-6, 6) / 2],
    () => [uni(0, 4), int(-9, 9) / 3],
    () => [uni(0, 100), pick([1.5, 2.5, -0.5, -1.5, 1 / 3, 2 / 3, 0.25, 0.75, -1, 3, 4, 5, 6, -2, -3, 1])],
    () => [10, int(-330, 310)],
    () => [2, int(-1080, 1030)],
    () => [int(2, 20), int(-40, 40)],
    () => [int(1, 1000) / pick([1, 2, 4, 8, 10]), int(-12, 12)],
    () => [int(-1000, 1000), int(0, 20)],
    () => [1 + uni(-1, 1) * pow2(int(-52, -5)), sign(expo(0, 60))], // near 1 to a large power: overflow and underflow
    () => [uni(0.5, 2), uni(-1100, 1100)],
    () => [expo(-1074, 1023), int(-3, 3) + pick([0, 0.5])],
    () => [wide(), wide()],
    () => [anyBits(), anyBits()],
    () => [fixed(), moderate()],
    () => [moderate(), fixed()],
    () => [fixed(), fixed()],
    () => [-uni(0, 10), int(-1000, 1000) / 2], // negative base: whole exponents and halves
    () => [sign(expo(-1074, 1023)), sign(int(0, 2000))],
    () => [uni(0, 10), 2],
    () => [expo(-600, 600), 0.5],
    () => [sign(uni(0, 3)), sign(expo(50, 64))], // exponents too large to be odd
  ];
  two("pow", Math.pow, () => pick(powers)());

  // hypot: 1 to 6 arguments
  for (let k = 1; k <= 6; k++) {
    const n = Math.ceil(count / 6);
    const a = new Float64Array(k * n);
    const r = new Float64Array(n);
    const list: number[] = new Array(k);
    for (let i = 0; i < n; i++) {
      const kind = i % 8;
      const scale = kind < 3 ? 1 : pow2(int(-530, 530));
      for (let j = 0; j < k; j++) {
        list[j] = kind === 7 ? (i % 16 === 7 ? pick([0, -0, Infinity, -Infinity, NaN, 1, 3, 4]) : wide()) : kind === 6 ? int(-20, 20) : kind === 5 ? sign(expo(-40, 10)) * scale : uni(-3, 3) * scale;
        a[k * i + j] = list[j];
      }
      r[i] = Math.hypot(...list);
    }
    section({ name: "hypot", arity: k, n, a, r });
  }

  closeSync(fd);
  console.log(`${total} vectors of ${sectionCount} sections written to ${out} (node ${process.version}, v8 ${process.versions.v8}, ${process.platform} ${process.arch})`);
  process.exit(0);
}

// the first line says where the vectors were made: Node on arm64 is not a reference for most Math functions
const lines: string[] = [JSON.stringify({ f: "meta", node: process.version, v8: process.versions.v8, arch: process.arch, platform: process.platform })];
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
const expo2 = [() => uni(-30, 30), () => uni(-1, 1), () => uni(-700, 700), () => logUni(1e-12, 1)];
one("exp", Math.exp, expo2);
one("expm1", Math.expm1, expo2);
one("sinh", Math.sinh, expo2);
one("cosh", Math.cosh, expo2);
one("tanh", Math.tanh, expo2);
const pos = [() => uni(0, 10), () => Math.abs(logUni(1e-300, 1e300)), () => 1 + uni(-1e-3, 1e-3)];
one("log", Math.log, pos);
one("log2", Math.log2, pos);
one("log10", Math.log10, pos);
one("log1p", Math.log1p, [() => uni(-1, 10), () => logUni(1e-12, 1e12), () => uni(-1e-3, 1e-3)]);
one("acosh", Math.acosh, [() => uni(1, 10), () => 1 + Math.abs(logUni(1e-12, 1e12))]);
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
