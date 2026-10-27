import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOTE_PAIRS,
  PACKOMANIA,
  convertNote,
  display6,
  doubleDecimal,
  doublePrinted,
  friedmanNote,
  halveDecimal,
  halvePrinted,
  scoreFactor,
  sourceTolerance,
  unhalvePrinted,
} from "../units";
import { readJson, render } from "../units-json";

const ROOT = resolve(import.meta.dirname, "../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const records = JSON.parse(readFileSync(join(ROOT, "data/records.json"), "utf8"));

describe("the unit rules of the 2D records", () => {
  it("has the score factor of each kind of problem", () => {
    expect(scoreFactor(0, 0)).toBe(1);
    expect(scoreFactor(0, 3)).toBe(0.5);
    expect(scoreFactor(5, 0)).toBe(2);
    expect(scoreFactor(5, 6)).toBe(1);
  });

  it("converts a printed decimal by exact decimal arithmetic and keeps the truncation mark", () => {
    expect(halvePrinted("3.464+", 3)).toEqual({ display: "1.732+", precision: 3 });
    expect(halvePrinted("3.465+", 3)).toEqual({ display: "1.7325+", precision: 3 });
    expect(halvePrinted("3", 12)).toEqual({ display: "1.5", precision: 12 });
    expect(doublePrinted("0.577+", 3)).toEqual({ display: "1.154+", precision: 3 });
    expect(doublePrinted("1.5", 1)).toEqual({ display: "3.0", precision: 1 });
    for (const [shown, precision] of [["3.465+", 3], ["3.464+", 3], ["0.100", 3], ["2", 12], ["1.10", 2], ["4.5", 1]] as const) {
      const h = halvePrinted(shown, precision);
      expect(Number(h.display.replace("+", ""))).toBeCloseTo(Number(shown.replace("+", "")) / 2, 12);
    }
  });

  it("halves and doubles the long decimals of a certificate", () => {
    expect(halveDecimal("2.828427124749018273984783")).toBe("1.4142135623745091369923915");
    expect(halveDecimal("1.9996657e-12")).toBe("9.9983285e-13");
    expect(halveDecimal("2.0e-12")).toBe("1.0e-12");
    expect(doubleDecimal("9.9983285e-13")).toBe("1.9996657e-12");
    expect(doubleDecimal("1.4142135623745091369923915")).toBe("2.828427124749018273984783");
  });

  it("rounds a display to the nearest 6 decimals from the exact binary value, ties to even", () => {
    expect(display6(2.000000000002)).toBe("2.000000");
    expect(display6(0.5)).toBe("0.500000");
    // 2^-7 = 0.0078125 is a tie at 6 decimals: the even neighbour is 0.007812
    expect(display6(2 ** -7)).toBe("0.007812");
    expect(display6(1.7320508075688772)).toBe("1.732051");
  });

  it("scales the tolerance of a printed value with the container diameter, not with the disks", () => {
    expect(sourceTolerance(3, 0, 3)).toBe(0.002);
    expect(sourceTolerance(0, 3, 3)).toBe(0.001);
    expect(sourceTolerance(0, 0, 6)).toBe(1e-6);
  });

  it("gives the importers' notes and the converter's the same text", () => {
    for (const [oldText, newText] of NOTE_PAIRS) expect(convertNote(oldText, 1)).toBe(newText);
    for (const [oldText, newText] of NOTE_PAIRS) expect(convertNote(newText, -1)).toBe(oldText);
    // every conversion note of a record of the data starts with the importer's text for its pair, or the Packomania text
    for (const r of records.records as any[]) {
      if (!(r.N === 0 || r.M === 0)) continue;
      const note: string = r.conversion_note;
      const ok =
        note.startsWith(friedmanNote(r.N, r.M)) ||
        note.includes(PACKOMANIA.cci.neu) ||
        note.includes(PACKOMANIA.csq.neu) ||
        note === "None: computed in this site's units.";
      expect(ok, `${r.N}/${r.M}/${r.P}: ${note.slice(0, 80)}`).toBe(true);
    }
  });

  it("reverses a halved printed value, with the decimal that halving appended", () => {
    for (const [shown, precision] of [["3.465+", 3], ["3.464+", 3], ["0.100", 3], ["2", 12], ["4.5", 1], ["2.0", 1]] as const) {
      const h = halvePrinted(shown, precision);
      expect(unhalvePrinted(h.display, h.precision)).toEqual({ display: shown, precision });
    }
  });
});

describe("the data files", () => {
  it("say units: diameter and the date in the header, and read and write back byte for byte", () => {
    for (const f of ["data/records.json", "data/surface/records.json", "data/sphere/records.json", "data/torus/records.json", "data/boundary/records.json", "data/curved/records.json", "data/sources/packomania.json", "data/sources/friedman.json", "data/sources/constructed.json"]) {
      const l = readJson(join(ROOT, f));
      expect(l.data.units, f).toBe("diameter");
      expect(render(l) === l.text, `${f} round trip`).toBe(true);
    }
    for (const f of ["data/records.json", "data/surface/records.json", "data/sphere/records.json", "data/torus/records.json", "data/curved/records.json", "data/sources/packomania.json"]) {
      expect(readJson(join(ROOT, f)).data.units_date, f).toBe("2026-10-27");
    }
  });

  it("refuses to convert twice", () => {
    const r = spawnSync(TSX, [join(ROOT, "scripts/convert-units.ts"), "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to convert twice/);
  });
});

describe("a re-import from data/sources reproduces the converted records", () => {
  it("builds exactly data/records.json from the stored sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "polypack-build-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    cpSync(join(ROOT, "data/sources"), join(dir, "data/sources"), { recursive: true });
    execFileSync(TSX, [join(ROOT, "scripts/build-records.ts"), "--date", records.generated], { cwd: dir, stdio: "pipe" });
    expect(readFileSync(join(dir, "data/records.json"), "utf8") === readFileSync(join(ROOT, "data/records.json"), "utf8")).toBe(true);
  });

  it("imports Packomania's radius table to diameter-1 disks, as the converter converts the old import", () => {
    const dir = mkdtempSync(join(tmpdir(), "polypack-packomania-"));
    mkdirSync(join(dir, "data/sources"), { recursive: true });
    const input = join(dir, "input");
    for (const fam of ["cci", "csq"]) mkdirSync(join(input, `${fam}-coords`), { recursive: true });
    // circles of radius 1/2 in a circle of radius 1 (n = 2); circles of radius 1/4 in a square of side 1 (n = 4)
    writeFileSync(join(input, "cci-radius.txt"), "2  0.5000000000\n");
    writeFileSync(join(input, "cci-ratio.txt"), "2  2.0000000000\n");
    writeFileSync(join(input, "cci-coords", "cci2.txt"), "1 -0.5 0.0\n2 0.5 0.0\n");
    writeFileSync(join(input, "csq-radius.txt"), "4  0.2500000000\n");
    writeFileSync(join(input, "csq-ratio.txt"), "4  4.0000000000\n");
    writeFileSync(join(input, "csq-coords", "csq4.txt"), "1 -0.25 -0.25\n2 0.25 -0.25\n3 -0.25 0.25\n4 0.25 0.25\n");
    execFileSync(TSX, [join(ROOT, "scripts/import-packomania.ts"), input, "2026-10-27"], { cwd: dir, stdio: "pipe" });
    const out = JSON.parse(readFileSync(join(dir, "data/sources/packomania.json"), "utf8"));
    expect(out.units).toBe("diameter");
    const cci = out.records.find((r: any) => r.M === 0 && r.P === 2);
    const csq = out.records.find((r: any) => r.M === 4 && r.P === 4);
    // the old import: value 1 / radius, coordinates divided by the radius, radius-1 note; the converter's rules on it
    const oldNote = (container: string) => `The source fixes the container (${container}) and lists the circle radius. `;
    expect(cci.value).toBe(1 / 0.5);
    expect(cci.pieces.map((p: any) => p.x)).toEqual([-0.5 / (2 * 0.5), 0.5 / (2 * 0.5)]);
    expect(cci.conversion_note).toBe(convertNote(oldNote("radius 1") + PACKOMANIA.cci.old + " " + PACKOMANIA.coordinates.old, 1));
    expect(csq.value).toBe(1 / 0.25 / 2);
    expect(csq.display).toBe("2.0000000000");
    expect(csq.pieces.map((p: any) => p.x)).toEqual([-0.25 / (2 * 0.25), 0.25 / (2 * 0.25), -0.25 / (2 * 0.25), 0.25 / (2 * 0.25)]);
    expect(csq.conversion_note).toBe(convertNote(oldNote("side 1") + PACKOMANIA.csq.old + " " + PACKOMANIA.coordinates.old, 1));
  });
});
