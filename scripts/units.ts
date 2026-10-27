// The unit change of 2026-10-27, as the data tools see it: disk pieces (N = 0) had radius 1 and now
// have diameter 1, and a circle container (M = 0) was scored by its radius and is now scored by its
// diameter. Used by scripts/convert-units.ts (which converts the stored files, exactly) and by the
// importers (which now produce site units directly), so both give the same numbers and the same text.
//
// For a 2D record (N, M) the score factor from the old file to the new one is
//   N = 0, M = 0   : 1    (radius-1 disks in a circle of radius r  ->  diameter-1 disks in a circle of diameter r)
//   N = 0, M >= 3  : 1/2  (disks of diameter 1 are half the size, so the polygon container's side halves)
//   N >= 3, M = 0  : 2    (the container is scored by its diameter 2 r instead of its radius r)
//   N >= 3, M >= 3 : 1
// and the centres of disk pieces are multiplied by 1/2 (polygon pieces keep their coordinates).
export const UNITS_DATE = "2026-10-27";
/** The header every converted data file carries (after `generated`). */
export const UNITS_HEADER = { units: "diameter", units_date: UNITS_DATE } as const;

// All factors are powers of two, so every conversion of a binary64 number is exact.

/**
 * The tolerance 10^-display_precision of a literature value, in the unit of the value. The precision describes the
 * uncertainty of the source's printed number in the source's own unit; a polygon-in-circle value is now the container
 * diameter, twice the radius the source printed, so its uncertainty is twice as large (it is the one unit that grew:
 * disks in a polygon halve, and the tolerance stays, which is more generous than the halved uncertainty).
 */
export function sourceTolerance(N: number, M: number, displayPrecision: number): number {
  return 10 ** -displayPrecision * (N > 0 && M === 0 ? 2 : 1);
}

/** The factor for the score (the container size) of an old record, to the new one. */
export function scoreFactor(N: number, M: number): number {
  if (N === 0) return M === 0 ? 1 : 0.5;
  return M === 0 ? 2 : 1;
}

/** The factor for the coordinates of the pieces of a 2D record. */
export const centreFactor = (N: number): number => (N === 0 ? 0.5 : 1);

// ---------- printed decimals ----------
//
// The literature prints values as decimals, often truncated ("3.464+"). The converted value is the exact
// product with the factor, and the printed text is converted by the same exact decimal arithmetic:
//   * halving appends one decimal when the last digit is odd ("3.465+" -> "1.7325+", "3.464+" -> "1.732+");
//   * doubling keeps the number of decimals ("0.577+" -> "1.154+"); the truncation mark "+" stays in both.
// `precision` (display_precision) is the exponent of the tolerance 10^-precision that the site compares scores with
// (beating a record, matching it, accepting coordinates). It is an uncertainty, not a digit count, and it is NOT
// changed by the conversion: halving halves the uncertainty of the printed value, so the tolerance stays valid, and
// the checks of build-records.ts and tests/records.test.ts (|score - value| <= 2 * 10^-precision) keep holding for
// the stored coordinates, whose deviation from the value doubles at most (poly-in-circle, 30 of 56 are above 1 old
// ulp, none above 2). A reversible, simple rule; the source's own citation text is never changed.
// This is the rule of halvePrinted in packages/surface/src/nofold.ts (scripts/test/units.test.ts keeps the two equal).

const PRINTED = /^(-?)(\d+)(?:\.(\d+))?(\+?)$/;

export function halvePrinted(display: string, precision: number): { display: string; precision: number } {
  const m = PRINTED.exec(display);
  if (!m) throw new Error(`cannot halve printed value ${display}`);
  const [, sign, whole, frac = "", plus] = m;
  let decimals = frac.length + 1;
  const text = (BigInt(whole + frac) * 5n).toString().padStart(decimals + 1, "0");
  let out = text.slice(0, text.length - decimals) + "." + text.slice(text.length - decimals);
  if (out.endsWith("0")) {
    out = out.slice(0, -1);
    decimals--;
  }
  if (out.endsWith(".")) out = out.slice(0, -1);
  return { display: sign + out + plus, precision };
}

export function doublePrinted(display: string, precision: number): { display: string; precision: number } {
  const m = PRINTED.exec(display);
  if (!m) throw new Error(`cannot double printed value ${display}`);
  const [, sign, whole, frac = "", plus] = m;
  const digits = (BigInt(whole + frac) * 2n).toString().padStart(frac.length + 1, "0");
  const out = frac.length ? digits.slice(0, digits.length - frac.length) + "." + digits.slice(digits.length - frac.length) : digits;
  return { display: sign + out + plus, precision };
}

/** Undo halvePrinted: double, and drop the decimal that halving appended (more decimals than the precision) or a ".0". */
export function unhalvePrinted(display: string, precision: number): { display: string; precision: number } {
  const d = doublePrinted(display, precision);
  const m = PRINTED.exec(d.display)!;
  const frac = m[3] ?? "";
  if (frac.endsWith("0") && (precision >= 12 ? true : frac.length > precision)) {
    const body = (m[1] + m[2] + "." + frac.slice(0, -1)).replace(/\.$/, "");
    return { display: body + m[4], precision };
  }
  return d;
}

/** The printed value after the score factor f (1/2, 1 or 2). */
export function scalePrinted(display: string, precision: number, f: number): { display: string; precision: number } {
  if (f === 1) return { display, precision };
  if (f === 0.5) return halvePrinted(display, precision);
  if (f === 2) return doublePrinted(display, precision);
  throw new Error(`no printed conversion for factor ${f}`);
}

/** The inverse of scalePrinted (up to the last digit of a reversed halving, see unhalvePrinted). */
export function unscalePrinted(display: string, precision: number, f: number): { display: string; precision: number } {
  if (f === 1) return { display, precision };
  if (f === 0.5) return unhalvePrinted(display, precision);
  if (f === 2) return halvePrinted(display, precision);
  throw new Error(`no printed conversion for factor ${f}`);
}

// ---------- the display of a certified score ----------

/**
 * x rounded to the nearest at `digits` decimals from its exact binary64 value, ties to even (Python's
 * Decimal(x).quantize(Decimal("0.000001"), ROUND_HALF_EVEN)), always `digits` decimals.
 */
export function display6(x: number, digits = 6): string {
  if (!Number.isFinite(x)) throw new RangeError("display needs a finite number");
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (expBits === 0) exp = -1074;
  else {
    mant |= 1n << 52n;
    exp = expBits - 1075;
  }
  // |x| = mant * 2^exp; scaled = |x| * 10^digits as a rational num / den
  let num = mant * 10n ** BigInt(digits);
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den = 1n << BigInt(-exp);
  let q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  const s = q.toString().padStart(digits + 1, "0");
  return (x < 0 && q !== 0n ? "-" : "") + s.slice(0, s.length - digits) + "." + s.slice(s.length - digits);
}

// ---------- long decimal strings (certificate bounds) ----------

const DEC = /^(-?)(\d+)(?:\.(\d+))?(?:([eE])([-+]?\d+))?$/;

/** Exactly half of a decimal string ("2.8284271247" -> "1.41421356235"; "1.9996657e-12" -> "9.9983285e-13"). */
export function halveDecimal(s: string): string {
  const m = DEC.exec(s);
  if (!m) throw new Error(`not a decimal: ${s}`);
  const [, sign, whole, frac = "", e, exp] = m;
  if (e === undefined) {
    const h = halvePrinted(whole + (frac ? "." + frac : ""), 99);
    return sign + h.display;
  }
  // scientific: halve the mantissa, renormalise to one leading digit when it drops below 1
  const h = halvePrinted(whole + (frac ? "." + frac : ""), 99).display;
  const digits = h.replace(".", "");
  const lead = h.indexOf(".") === -1 ? h.length : h.indexOf(".");
  // h = 0.d... or d...: value = digits * 10^(lead - digits.length)
  const stripped = digits.replace(/^0+/, "");
  const shift = digits.length - stripped.length; // leading zeros removed
  const newExp = Number(exp) + (lead - 1) - shift;
  const mant = stripped.length > 1 ? stripped[0] + "." + stripped.slice(1) : stripped + (frac.length || h.includes(".") ? ".0" : "");
  const expText = (exp.startsWith("+") ? "+" : "") + String(newExp);
  return sign + mant + e + expText;
}

/** Exactly twice a decimal string; the inverse of halveDecimal when the input came from it. */
export function doubleDecimal(s: string): string {
  const m = DEC.exec(s);
  if (!m) throw new Error(`not a decimal: ${s}`);
  const [, sign, whole, frac = "", e, exp] = m;
  const digits = (BigInt(whole + frac) * 2n).toString().padStart(frac.length + 1, "0");
  let body = frac.length ? digits.slice(0, digits.length - frac.length) + "." + digits.slice(digits.length - frac.length) : digits;
  if (frac.length) body = body.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
  if (e !== undefined) {
    // renormalise "20.0e-13" style mantissas
    const mm = /^(\d+)(?:\.(\d*))?$/.exec(body)!;
    if (mm[1].length > 1) {
      const all = mm[1] + (mm[2] ?? "");
      const nm = all[0] + "." + (all.slice(1).replace(/0+$/, "") || "0");
      return sign + nm + e + (exp.startsWith("+") ? "+" : "") + String(Number(exp) + mm[1].length - 1);
    }
    return sign + body + e + exp;
  }
  return sign + body;
}

// ---------- the text of 2D conversion notes ----------

/** The sentences of the Packomania notes (import-packomania.ts, attach-packomania-coords.ts), in the old and the new unit. */
export const PACKOMANIA = {
  cci: {
    old: `This site fixes the circle radius at 1, so the container radius is 1 / radius, the source's "ratio" column.`,
    neu: `This site fixes the circle diameter at 1, so the container diameter is 1 / radius, the source's "ratio" column.`,
  },
  csq: {
    old: `This site fixes the circle radius at 1, so the container side is 1 / radius, the source's "ratio" column.`,
    neu: `This site fixes the circle diameter at 1, so the container side is 1 / (2 radius), half the source's "ratio" column.`,
  },
  coordinates: {
    old: "Coordinates are the source's, divided by the circle radius.",
    neu: "Coordinates are the source's, divided by the circle diameter (twice the radius).",
  },
  attached: {
    old: " decimals and divided by the circle radius.",
    neu: " decimals and divided by the circle diameter (twice the radius).",
  },
} as const;

export const ONE_DISK = {
  old: "[CALC] One circle fills a circle of the same radius, so r = 1.",
  neu: "[CALC] One disk fills a circle of the same diameter, so the container diameter is 1.",
} as const;

/** [old text, new text] pairs; applied by convert-units.ts, and produced directly by the importers. */
export const NOTE_PAIRS: readonly (readonly [string, string])[] = [
  ["None needed: the source uses container radius r for unit pieces (radius 1), as this site does.", friedmanNote(0, 0)],
  ["None needed: the source uses container side s for unit pieces (radius 1), as this site does.", friedmanNote(0, 3)],
  ["None needed: the source uses container radius r for unit pieces (side 1), as this site does.", friedmanNote(3, 0)],
  [PACKOMANIA.cci.old, PACKOMANIA.cci.neu],
  [PACKOMANIA.csq.old, PACKOMANIA.csq.neu],
  [PACKOMANIA.coordinates.old, PACKOMANIA.coordinates.neu],
  [PACKOMANIA.attached.old, PACKOMANIA.attached.neu],
  [ONE_DISK.old, ONE_DISK.neu],
];

/**
 * The conversion note of a Friedman value: his units are radius 1 for disks and side 1 for polygons, with the
 * container radius r or side s, so the factor depends on the pair.
 */
export function friedmanNote(N: number, M: number): string {
  const container = M === 0 ? "container radius r" : "container side s";
  const piece = N === 0 ? "radius" : "side";
  if (N === 0 && M === 0)
    return `The source's disks have radius 1 in a container of radius r; this site's disks have diameter 1 and a circle is scored by its diameter, so the same packing at half the scale has container diameter r: the value is unchanged.`;
  if (N === 0)
    return `The source's disks have radius 1 in a container of side s; this site's disks have diameter 1, so the side is s / 2 (exact halving).`;
  if (M === 0) return `The source gives the container radius r for unit pieces; this site scores a circle by its diameter, 2 r (exact doubling).`;
  return `None needed: the source uses ${container} for unit pieces (${piece} 1), as this site does.`;
}

export function convertNote(text: string | undefined, direction: 1 | -1): string | undefined {
  if (text === undefined) return text;
  let out = text;
  for (const [oldText, newText] of NOTE_PAIRS) out = direction === 1 ? out.split(oldText).join(newText) : out.split(newText).join(oldText);
  return out;
}
