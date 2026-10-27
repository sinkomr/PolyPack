/**
 * The pure parts of the 3D on 4D pages (apps/web/src/boundary-model.ts): the nofold comparison,
 * a configuration and a problem as the server sends them (untrusted input), and the viewer's
 * address. The problems are the real catalogue (data/boundary/records.json), as the server lists it.
 */
import { spaceProblemSummary } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundaryFields,
  foldGain,
  gainText,
  pieceNames,
  piecesText,
  plainNofoldLabel,
  readBoundaryConfig,
  readFoldExtra,
  readViewerProblem,
  viewerHref,
  viewerId,
  viewerPacking,
} from "../src/boundary-model";
import { problemFacts } from "../src/space/facts";
import { DEFAULT_PROBLEM, fieldsOfId, pickProblem } from "../src/space/pick";

const root = resolve(__dirname, "../../..");
const catalogue = loadSpacesIndex(root).boundary!;
/** The research records as the file has them; their values change as better packings are certified, so none is written here. */
const records = new Map<string, { score_float: number; fold_gain: number; nofold: { value: number } }>(
  JSON.parse(readFileSync(resolve(root, "data/boundary/records.json"), "utf8")).records.map((r: { id: string }) => [
    r.id,
    r,
  ]),
);
/** The listing's values of a problem, with no site entry. */
const listed = (id: string) => spaceProblemSummary(catalogue.byId.get(id)!, null);

/** The server's answer for a catalogue problem, with an optional site entry (GET .../problems/<id>). */
function answer(id: string, site?: { score: number; config: unknown }) {
  const p = catalogue.byId.get(id)!;
  const summary = spaceProblemSummary(
    p,
    site ? { id: 3, score: site.score, name: "Ada", created_at: "2026-10-25T09:00:00Z" } : null,
  );
  return {
    ...summary,
    conventions: {},
    certified_config: p.config === null ? null : JSON.parse(p.config),
    site_config: site?.config ?? null,
  };
}

describe("the nofold comparison", () => {
  it("is listed with every problem of the catalogue", () => {
    expect(catalogue.problems.length).toBe(records.size);
    expect(new Set(catalogue.problems.map((p) => p.fields.piece))).toEqual(new Set(["ball", "cube"]));
    for (const p of catalogue.problems) {
      const extra = readFoldExtra(spaceProblemSummary(p, null).extra);
      expect(extra?.nofold?.value, p.id).toBeGreaterThan(0);
      // the server's gain is the research record's; the pages compute the same from the certified value
      const gain = foldGain(p.certified!.score, extra!.nofold!.value)!;
      expect(Math.abs(gain - extra!.fold_gain!), p.id).toBeLessThan(1e-9);
    }
  });

  it("gives the records' gains, over the nofold values of the notes (docs/spaces/BOUNDARY.md 6)", () => {
    for (const p of catalogue.problems) {
      const s = listed(p.id);
      const nofold = readFoldExtra(s.extra)!.nofold!.value;
      // nofold(P) = f(ceil(P / 8)): one piece per cell, then two
      const two = p.P > 8;
      const f = p.fields.piece === "ball" ? (two ? 1 + 1 / Math.sqrt(3) : 1) : two ? 2 : 1;
      expect(nofold, p.id).toBeCloseTo(f, 12);
      // the page's gain is the file's, to the decimal shown (the file's uses the search value)
      const record = records.get(p.id)!;
      expect(gainText(foldGain(s.best_score, nofold)), p.id).toBe(gainText(record.fold_gain));
      expect(Math.abs(record.fold_gain - (1 - record.score_float / record.nofold.value)), p.id).toBeLessThan(1e-12);
    }
    // eight cubes fill the eight cells: folding gains nothing
    expect(gainText(foldGain(listed("boundary/tesseract/cube/8").best_score, 1))).toBe("0.0%");
  });

  it("reads only well-formed values", () => {
    expect(readFoldExtra(undefined)).toBeNull();
    expect(readFoldExtra("x")).toBeNull();
    expect(readFoldExtra({ nofold: { value: -1, label: "x" }, fold_gain: "big" })).toBeNull();
    expect(readFoldExtra({ nofold: { value: 2 }, fold_gain: null })).toEqual({
      nofold: { value: 2, label: "" },
      fold_gain: null,
    });
    expect(readFoldExtra({ nofold: null, fold_gain: 0.25 })).toEqual({ nofold: null, fold_gain: 0.25 });
    expect(readFoldExtra({ nofold: { value: Infinity, label: "x" }, fold_gain: 7 })).toBeNull();
    expect(readFoldExtra({ nofold: { value: 2, label: "y".repeat(5000) } })!.nofold!.label).toHaveLength(600);
  });

  it("computes and words a gain", () => {
    expect(foldGain(1.5, 2)).toBe(0.25);
    expect(foldGain(null, 2)).toBeNull();
    expect(foldGain(1.5, undefined)).toBeNull();
    expect(foldGain(0, 2)).toBeNull();
    expect(gainText(0.25)).toBe("25.0%");
    expect(gainText(0.29609938)).toBe("29.6%");
    expect(gainText(-0.00001)).toBe("0.0%");
    expect(gainText(-0.1)).toBe("−10.0%");
    expect(gainText(null)).toBe("—");
    expect(gainText(NaN)).toBe("—");
  });

  it("says what a nofold value rests on in plain words", () => {
    const label = readFoldExtra(listed("boundary/tesseract/ball/9").extra)!.nofold!.label;
    const plain = plainNofoldLabel(label);
    expect(plain).toMatch(/^Two balls of diameter 1 in one cell: /);
    expect(plain).not.toMatch(/\[(CALC|EST)\]|BOUNDARY\.md/);
    expect(plain).toMatch(/\.$/);
    expect(plainNofoldLabel("[EST] two cubes need edge 2; upper bound [CALC] side by side")).toBe(
      "Two cubes need edge 2; upper bound side by side.",
    );
  });
});

describe("a configuration and a problem from the server", () => {
  it("reads every record's configuration as it is", () => {
    for (const p of catalogue.problems) {
      const config = JSON.parse(p.config!);
      expect(readBoundaryConfig(config, p.P), p.id).toEqual(config);
    }
  });

  it("refuses a malformed configuration", () => {
    const good = { s: 2, pieces: [{ cell: 0, u: [0, 0, 0] }] };
    expect(readBoundaryConfig(good, 1)).toEqual(good);
    expect(readBoundaryConfig(good, 2)).toBeNull();
    expect(readBoundaryConfig({ ...good, s: 0 }, 1)).toBeNull();
    expect(readBoundaryConfig({ ...good, s: "2" }, 1)).toBeNull();
    for (const piece of [
      { cell: 8, u: [0, 0, 0] },
      { cell: -1, u: [0, 0, 0] },
      { cell: 1.5, u: [0, 0, 0] },
      { cell: 0, u: [0, 0] },
      { cell: 0, u: [0, 0, NaN] },
      { cell: 0, u: [0, 0, 0], q: [1, 0, 0] },
      { cell: 0, u: [0, 0, 0], q: [1, 0, 0, "0"] },
      null,
    ])
      expect(readBoundaryConfig({ s: 2, pieces: [piece] }, 1), JSON.stringify(piece)).toBeNull();
    // a clean copy: nothing but the fields of the format
    const copy = readBoundaryConfig({ s: 2, extra: 1, pieces: [{ cell: 1, u: [1, 2, 3], q: [1, 0, 0, 0], x: 9 }] }, 1);
    expect(copy).toEqual({ s: 2, pieces: [{ cell: 1, u: [1, 2, 3], q: [1, 0, 0, 0] }] });
  });

  it("reads a problem with both of its packings and the values the pages show", () => {
    const id = "boundary/tesseract/ball/9";
    const p = readViewerProblem(id, answer(id));
    if (typeof p === "string") throw new Error(p);
    expect(p).toMatchObject({ polytope: "tesseract", piece: "ball", P: 9, accepts_submissions: true });
    expect(p.configs.certified?.pieces).toHaveLength(9);
    expect(p.configs.site).toBeNull();
    expect(viewerPacking(p, null)).toBe("certified");
    expect(viewerPacking(p, "site")).toBe("certified");
    const facts = Object.fromEntries(problemFacts(p).map((f) => [f.label, f]));
    expect(facts["Without folding"].value).toBe("1.577350");
    expect(facts["Without folding"].details).toBe(true);
    expect(facts["Folding gains"].value).toBe(gainText(1 - p.certified!.score / p.extra!.nofold!.value));
    expect(facts["Certified value"].value).toBe(listed(id).certified!.display);

    // a site entry 1% better is the better packing, and the gain follows it
    const config = p.configs.certified!;
    const site = { s: config.s * 0.99, pieces: config.pieces };
    const q = readViewerProblem(id, answer(id, { score: site.s, config: site }));
    if (typeof q === "string") throw new Error(q);
    expect(q.configs.site).toEqual(site);
    expect(viewerPacking(q, null)).toBe("site");
    expect(viewerPacking(q, "certified")).toBe("certified");
    expect(q.best_score).toBe(site.s);
    expect(Object.fromEntries(problemFacts(q).map((f) => [f.label, f.value]))["Folding gains"]).toBe(
      gainText(1 - site.s / (1 + 1 / Math.sqrt(3))),
    );
  });

  it("refuses an answer that is not the problem, and drops a malformed packing", () => {
    const id = "boundary/tesseract/cube/12";
    const good = answer(id);
    expect(readViewerProblem("boundary/tesseract/cube/13", good)).toMatch(/not this problem/);
    expect(readViewerProblem("sphere/4/12", good)).toMatch(/not a 3D on 4D problem/);
    expect(readViewerProblem(id, null)).toMatch(/not this problem/);
    expect(readViewerProblem(id, { ...good, accepts_submissions: 1 })).toMatch(/malformed/);
    expect(readViewerProblem(id, { ...good, certified: { score: 0 } })).toMatch(/certified/);
    expect(readViewerProblem(id, { ...good, site_best: { id: "x", score: 1 } })).toMatch(/site best/);
    const bad = readViewerProblem(id, { ...good, certified_config: { s: 1.5, pieces: [] } });
    if (typeof bad === "string") throw new Error(bad);
    expect(bad.configs.certified).toBeNull();
    expect(viewerPacking(bad, null)).toBeNull();
    // a site configuration without a site value is not shown
    const stray = readViewerProblem(id, { ...good, site_config: JSON.parse(catalogue.byId.get(id)!.config!) });
    if (typeof stray === "string") throw new Error(stray);
    expect(stray.configs.site).toBeNull();
  });
});

describe("names, ids and addresses", () => {
  it("names the pieces", () => {
    expect(pieceNames("ball")).toEqual(["ball", "balls"]);
    expect(pieceNames("cube")).toEqual(["cube", "cubes"]);
    expect(piecesText("ball", 1)).toBe("1 ball");
    expect(piecesText("cube", 12)).toBe("12 cubes");
  });

  it("reads a problem id's fields", () => {
    expect(boundaryFields("boundary/tesseract/ball/9")).toEqual({ polytope: "tesseract", piece: "ball", P: 9 });
    for (const id of ["boundary/tesseract/ball/09", "boundary/tesseract/ball/0", "boundary/tesseract/9", "sphere/4/12"])
      expect(boundaryFields(id), id).toBeNull();
  });

  it("reads the viewer's address, the hash before the query", () => {
    expect(viewerId("?id=boundary/tesseract/ball/9", "")).toBe("boundary/tesseract/ball/9");
    expect(viewerId("", "#id=boundary/tesseract/cube/3")).toBe("boundary/tesseract/cube/3");
    expect(viewerId("?id=boundary/tesseract/ball/9", "#id=boundary/tesseract/cube/3")).toBe(
      "boundary/tesseract/cube/3",
    );
    expect(viewerId("?id=boundary%2Ftesseract%2Fball%2F2", "")).toBe("boundary/tesseract/ball/2");
    expect(viewerId("", "")).toBeNull();
    expect(viewerId("?id=", "#x=1")).toBeNull();
    expect(viewerHref("boundary/tesseract/ball/9")).toBe("/spaces/boundary.html#id=boundary/tesseract/ball/9");
    expect(viewerId("", new URL(viewerHref("boundary/tesseract/ball/9"), "http://x").hash)).toBe(
      "boundary/tesseract/ball/9",
    );
  });

  it("picks problems by polytope, piece and P, from the catalogue only", () => {
    const cubes = catalogue.problems.filter((p) => p.fields.piece === "cube").map((p) => p.P);
    const pick = pickProblem("boundary", catalogue.problems, { polytope: "tesseract", piece: "cube", P: "9999" });
    expect(pick.fields.map((f) => f.label)).toEqual(["Polytope", "Piece", "Pieces (P)"]);
    expect(pick.fields[0].options).toEqual([{ value: "tesseract", text: "Tesseract" }]);
    expect(pick.fields[1].options).toEqual([
      { value: "ball", text: "Balls" },
      { value: "cube", text: "Cubes" },
    ]);
    expect(pick.fields[2].options.map((o) => o.value)).toEqual(cubes.sort((a, b) => a - b).map(String));
    // P = 9999 is not listed: the nearest is
    expect(pick.id).toBe(`boundary/tesseract/cube/${Math.max(...cubes)}`);
  });
});

// The board and the viewer both open the problem an address names as pickProblem picks it from the
// catalogue, with the fields of the id (space/mode.ts, boundary-viewer.ts); both then say when it is
// another problem. Their browser tests follow one address that is not listed.
describe("the problem an address opens", () => {
  /** The problem the pages open for an id, from a listing. */
  const opened = (id: string, problems: readonly { id: string }[] = catalogue.problems) =>
    pickProblem("boundary", problems, fieldsOfId("boundary", id)).id;
  const listedP = (problems: readonly { id: string }[], piece: string) =>
    problems.filter((p) => p.id.split("/")[2] === piece).map((p) => Number(p.id.split("/")[3]));
  /** The listed P nearest a number, the smaller of two as near: an oracle apart from pickProblem's. */
  const nearest = (Ps: number[], want: number) => {
    const by = [...Ps].sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b);
    return by[0];
  };

  it("is the problem itself when it is listed, and the starting problem when the address names none", () => {
    for (const p of catalogue.problems) expect(opened(p.id), p.id).toBe(p.id);
    // the pages read a missing id as the starting problem's
    expect(catalogue.byId.has(DEFAULT_PROBLEM.boundary)).toBe(true);
    expect(opened(DEFAULT_PROBLEM.boundary)).toBe(DEFAULT_PROBLEM.boundary);
  });

  it("has the nearest listed P of the piece for any other number, the smaller of two as near", () => {
    for (const piece of ["ball", "cube"]) {
      const Ps = listedP(catalogue.problems, piece);
      for (const P of [0, -3, Math.min(...Ps) - 1, Math.max(...Ps) + 1, 9999, 1e9, 2.5])
        expect(opened(`boundary/tesseract/${piece}/${P}`), `${piece} ${P}`).toBe(
          `boundary/tesseract/${piece}/${nearest(Ps, P)}`,
        );
      // a listed number written otherwise
      expect(opened(`boundary/tesseract/${piece}/0${Ps[0]}`)).toBe(`boundary/tesseract/${piece}/${Ps[0]}`);
    }
    // a sparser listing, with gaps between its P and other P for each piece
    const sparse = catalogue.problems.filter((p) =>
      p.fields.piece === "ball" ? [2, 5, 9, 16].includes(p.P) : [3, 12].includes(p.P),
    );
    expect(sparse.length).toBe(6);
    const cases: [string, number, number][] = [
      ["ball", 1, 2],
      ["ball", 3, 2],
      ["ball", 4, 5],
      // as near to 5 as to 9
      ["ball", 7, 5],
      ["ball", 8, 9],
      ["ball", 13, 16],
      ["ball", 100, 16],
      // 5 is listed for balls only
      ["cube", 5, 3],
      ["cube", 8, 12],
      ["cube", 64, 12],
    ];
    for (const [piece, P, want] of cases) {
      expect(nearest(listedP(sparse, piece), P), `${piece} ${P}`).toBe(want);
      expect(opened(`boundary/tesseract/${piece}/${P}`, sparse), `${piece} ${P}`).toBe(
        `boundary/tesseract/${piece}/${want}`,
      );
    }
  });

  it("takes the starting value of a field it does not list, and the smallest P for one that is not a number", () => {
    const smallest = (piece: string) => Math.min(...listedP(catalogue.problems, piece));
    expect(opened("boundary/tesseract/sphere/9")).toBe("boundary/tesseract/ball/9");
    expect(opened("boundary/cube/cube/9")).toBe("boundary/tesseract/cube/9");
    for (const P of ["x", "", "NaN", "Infinity"])
      expect(opened(`boundary/tesseract/cube/${P}`), P).toBe(`boundary/tesseract/cube/${smallest("cube")}`);
    // an id cut short: its last part is read as P
    expect(opened("boundary/tesseract/cube")).toBe(`boundary/tesseract/cube/${smallest("cube")}`);
    // nothing listed: no problem
    expect(opened(DEFAULT_PROBLEM.boundary, [])).toBeNull();
  });
});
