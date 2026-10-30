import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JOHNSON_SOLID_NAMES, SOLID_NAMES, getSolid, solidNameOfCode } from "../src";
import { JOHNSON_SOLIDS, SOLID_NAMES_LIST } from "../src/catalogue";

/** V, E, F of J1 to J92 (Johnson 1966; python/polyhedra/johnson_table.py). */
const VEF: [number, number, number][] = [
  [5, 8, 5],
  [6, 10, 6],
  [9, 15, 8],
  [12, 20, 10],
  [15, 25, 12],
  [20, 35, 17],
  [7, 12, 7],
  [9, 16, 9],
  [11, 20, 11],
  [9, 20, 13],
  [11, 25, 16],
  [5, 9, 6],
  [7, 15, 10],
  [8, 15, 9],
  [10, 20, 12],
  [12, 25, 15],
  [10, 24, 16],
  [15, 27, 14],
  [20, 36, 18],
  [25, 45, 22],
  [30, 55, 27],
  [15, 33, 20],
  [20, 44, 26],
  [25, 55, 32],
  [30, 65, 37],
  [8, 14, 8],
  [12, 24, 14],
  [16, 32, 18],
  [16, 32, 18],
  [20, 40, 22],
  [20, 40, 22],
  [25, 50, 27],
  [25, 50, 27],
  [30, 60, 32],
  [18, 36, 20],
  [18, 36, 20],
  [24, 48, 26],
  [30, 60, 32],
  [30, 60, 32],
  [35, 70, 37],
  [35, 70, 37],
  [40, 80, 42],
  [40, 80, 42],
  [18, 42, 26],
  [24, 56, 34],
  [30, 70, 42],
  [35, 80, 47],
  [40, 90, 52],
  [7, 13, 8],
  [8, 17, 11],
  [9, 21, 14],
  [11, 19, 10],
  [12, 23, 13],
  [13, 22, 11],
  [14, 26, 14],
  [14, 26, 14],
  [15, 30, 17],
  [21, 35, 16],
  [22, 40, 20],
  [22, 40, 20],
  [23, 45, 24],
  [10, 20, 12],
  [9, 15, 8],
  [10, 18, 10],
  [15, 27, 14],
  [28, 48, 22],
  [32, 60, 30],
  [65, 105, 42],
  [70, 120, 52],
  [70, 120, 52],
  [75, 135, 62],
  [60, 120, 62],
  [60, 120, 62],
  [60, 120, 62],
  [60, 120, 62],
  [55, 105, 52],
  [55, 105, 52],
  [55, 105, 52],
  [55, 105, 52],
  [50, 90, 42],
  [50, 90, 42],
  [50, 90, 42],
  [45, 75, 32],
  [8, 18, 12],
  [16, 40, 26],
  [10, 22, 14],
  [11, 26, 17],
  [12, 28, 18],
  [14, 33, 21],
  [16, 38, 24],
  [14, 26, 14],
  [18, 36, 20],
];

describe("Johnson solids", () => {
  it("are 92 in the data, named j01 to j92, and the last 92 of the 186 solids of the problems", () => {
    expect(JOHNSON_SOLID_NAMES).toHaveLength(92);
    expect(JOHNSON_SOLIDS).toHaveLength(92);
    expect(JOHNSON_SOLIDS.map((s) => s.name)).toEqual([...JOHNSON_SOLID_NAMES]);
    expect(SOLID_NAMES).toHaveLength(186);
    expect(SOLID_NAMES_LIST).toHaveLength(186);
    expect(SOLID_NAMES.slice(94)).toEqual([...JOHNSON_SOLID_NAMES]);
    expect(SOLID_NAMES_LIST.slice(94)).toEqual([...JOHNSON_SOLIDS]);
    JOHNSON_SOLIDS.forEach((s, i) => {
      expect(s.code).toBe(`j${String(i + 1).padStart(2, "0")}`);
      expect(s.code).not.toContain("in");
      expect(s.family).toBe("johnson");
      expect(s.title).toBe(`J${i + 1} ${s.name.replace(/_/g, " ")}`);
      expect(solidNameOfCode(s.code)).toBe(s.name);
      expect(getSolid(s.name).title).toBe(s.title);
      expect(getSolid(s.name).code).toBe(s.code);
      expect(getSolid(s.name).family).toBe("johnson");
    });
    expect(JOHNSON_SOLIDS[11].title).toBe("J12 triangular bipyramid");
    expect(JOHNSON_SOLIDS[91].title).toBe("J92 triangular hebesphenorotunda");
  });

  it("have unit edges, regular convex faces and the centroid at the origin", () => {
    JOHNSON_SOLID_NAMES.forEach((name, i) => {
      const S = getSolid(name);
      expect([S.nv, S.edges.length, S.faces.length], name).toEqual(VEF[i]);
      expect(S.volume, name).toBeGreaterThan(0);
      // unit edges, in floating point
      for (const [a, b] of S.edges) {
        const l = Math.hypot(S.V[3 * a] - S.V[3 * b], S.V[3 * a + 1] - S.V[3 * b + 1], S.V[3 * a + 2] - S.V[3 * b + 2]);
        expect(Math.abs(l - 1), `${name} edge`).toBeLessThan(1e-13);
      }
      // the centroid of the vertices is the origin
      for (let k = 0; k < 3; k++) {
        let c = 0;
        for (let v = 0; v < S.nv; v++) c += S.V[3 * v + k];
        expect(Math.abs(c / S.nv), `${name} centroid`).toBeLessThan(1e-14);
      }
      // strictly convex: every vertex off a face lies strictly inside its plane; the origin is inside
      for (let f = 0; f < S.faces.length; f++) {
        expect(S.offsets[f], `${name} face ${f}`).toBeGreaterThan(0);
        for (let v = 0; v < S.nv; v++) {
          const d =
            S.N[3 * f] * S.V[3 * v] + S.N[3 * f + 1] * S.V[3 * v + 1] + S.N[3 * f + 2] * S.V[3 * v + 2] - S.offsets[f];
          if (S.faces[f].includes(v)) expect(Math.abs(d), `${name} face ${f}`).toBeLessThan(1e-13);
          else expect(d, `${name} face ${f}`).toBeLessThan(-1e-3);
        }
        // regular: equal sides (above) and one distance from the face centre
        const q = S.faces[f];
        const cen = [0, 1, 2].map((k) => q.reduce((s, v) => s + S.V[3 * v + k], 0) / q.length);
        const r = q.map((v) => Math.hypot(S.V[3 * v] - cen[0], S.V[3 * v + 1] - cen[1], S.V[3 * v + 2] - cen[2]));
        expect(Math.max(...r) - Math.min(...r), `${name} face ${f} circle`).toBeLessThan(1e-13);
        expect(r[0], `${name} face ${f} radius`).toBeCloseTo(1 / (2 * Math.sin(Math.PI / q.length)), 12);
      }
      expect(S.edgeMax, name).toBeCloseTo(1, 12);
    });
  });

  it("have the volumes of the literature for a few solids", () => {
    // volumes at unit edge from the literature (MathWorld, Wikipedia): J1 and J12 sqrt(2)/6 (a bipyramid is two tetrahedra),
    // J6 (45 + 17 sqrt 5)/12, J84 0.85949, J91 (17 + 9 sqrt 5)/12, J92 (15 + 7 sqrt 5)/6
    expect(getSolid("square_pyramid").volume).toBeCloseTo(Math.SQRT2 / 6, 13);
    expect(getSolid("triangular_bipyramid").volume).toBeCloseTo(Math.SQRT2 / 6, 13);
    expect(getSolid("pentagonal_rotunda").volume).toBeCloseTo((45 + 17 * Math.sqrt(5)) / 12, 12);
    expect(getSolid("snub_disphenoid").volume).toBeCloseTo(0.8594936461913, 11);
    expect(getSolid("bilunabirotunda").volume).toBeCloseTo((17 + 9 * Math.sqrt(5)) / 12, 12);
    expect(getSolid("triangular_hebesphenorotunda").volume).toBeCloseTo((15 + 7 * Math.sqrt(5)) / 6, 12);
  });
});

/**
 * Which solid each name is. V, E and F do not tell the ortho and gyro forms, the para and meta forms or the gyrate
 * rhombicosidodecahedra apart, so each solid is pinned by a hash of its sorted squared vertex distances (6 decimals).
 * The values were taken after an independent check that every solid is congruent to published coordinates
 * (D. McCooey's tables; J12 to J17 rebuilt independently), and all 92 differ.
 */
const DISTANCE_HASH: Record<string, string> = {
  square_pyramid: "a0c006ca96dcfe33",
  pentagonal_pyramid: "58aa16aa81c5b9cf",
  triangular_cupola: "5b925d8330fb1395",
  square_cupola: "b5a701618256f63d",
  pentagonal_cupola: "2603cb7dc159c41d",
  pentagonal_rotunda: "40ed813154d8b96a",
  elongated_triangular_pyramid: "60435f2c201abcc0",
  elongated_square_pyramid: "3db21fa368a7ec88",
  elongated_pentagonal_pyramid: "426748656f72ecc4",
  gyroelongated_square_pyramid: "1ebeeb6c3a0f1675",
  gyroelongated_pentagonal_pyramid: "c02f5ebc42a3f545",
  triangular_bipyramid: "e6e7323f37c718a9",
  pentagonal_bipyramid: "b1b5b1f5d13ec268",
  elongated_triangular_bipyramid: "82883f2395b561a6",
  elongated_square_bipyramid: "04fbeb1367750ae1",
  elongated_pentagonal_bipyramid: "20df8028256b0af1",
  gyroelongated_square_bipyramid: "98367d16957be04d",
  elongated_triangular_cupola: "31477bafc84977d2",
  elongated_square_cupola: "695986573e921552",
  elongated_pentagonal_cupola: "b2d11f2b3d77e4ee",
  elongated_pentagonal_rotunda: "25d88e6582650c52",
  gyroelongated_triangular_cupola: "68e9effcdfaca65c",
  gyroelongated_square_cupola: "57fb20b7d4c30182",
  gyroelongated_pentagonal_cupola: "519d15785e00712a",
  gyroelongated_pentagonal_rotunda: "9f7c79610a86c721",
  gyrobifastigium: "b6b069c396690387",
  triangular_orthobicupola: "99ff59e7bc918a22",
  square_orthobicupola: "d55bbfc0769bbdde",
  square_gyrobicupola: "2ad940c33ae1ea72",
  pentagonal_orthobicupola: "d7985f00b85de165",
  pentagonal_gyrobicupola: "6fd56cf902c83c34",
  pentagonal_orthocupolarotunda: "3a83f89707bd6656",
  pentagonal_gyrocupolarotunda: "ef4b175a7d3eee94",
  pentagonal_orthobirotunda: "1e690f95b5aa5ccf",
  elongated_triangular_orthobicupola: "df5f31c4f0a5811f",
  elongated_triangular_gyrobicupola: "6dd86daec0b3d770",
  elongated_square_gyrobicupola: "f834eb8235cf296e",
  elongated_pentagonal_orthobicupola: "1133423669e45069",
  elongated_pentagonal_gyrobicupola: "f1ccd4b53cb4b5cf",
  elongated_pentagonal_orthocupolarotunda: "ea4b2fbbae753556",
  elongated_pentagonal_gyrocupolarotunda: "570018bd79404b01",
  elongated_pentagonal_orthobirotunda: "39683fc3367a2301",
  elongated_pentagonal_gyrobirotunda: "9ee358884e90ad7a",
  gyroelongated_triangular_bicupola: "c0a262c38e65b66a",
  gyroelongated_square_bicupola: "1dbf6edb08c3fefd",
  gyroelongated_pentagonal_bicupola: "0a90a0d94fbb2b23",
  gyroelongated_pentagonal_cupolarotunda: "bc761cde08ec5682",
  gyroelongated_pentagonal_birotunda: "83017fc767b84e1e",
  augmented_triangular_prism: "1b765fcb71dc5839",
  biaugmented_triangular_prism: "e649a8cb69f72087",
  triaugmented_triangular_prism: "29d0905a905f9884",
  augmented_pentagonal_prism: "3745cf9483d91272",
  biaugmented_pentagonal_prism: "205ae889cd202f32",
  augmented_hexagonal_prism: "7e86795ee00afe17",
  parabiaugmented_hexagonal_prism: "421a2b4a7bb07a06",
  metabiaugmented_hexagonal_prism: "a35b1dd637527a43",
  triaugmented_hexagonal_prism: "248be3b68cb8ec74",
  augmented_dodecahedron: "22f23657a2432b35",
  parabiaugmented_dodecahedron: "f3631df3d5cb2588",
  metabiaugmented_dodecahedron: "6843fe7ea7d96fe1",
  triaugmented_dodecahedron: "0aba350b2a73ff16",
  metabidiminished_icosahedron: "46ed254ab01d86c7",
  tridiminished_icosahedron: "31e82f62d716ea79",
  augmented_tridiminished_icosahedron: "9599b3eece98d7e9",
  augmented_truncated_tetrahedron: "d8e80babac65b72b",
  augmented_truncated_cube: "78e664c34db05bf1",
  biaugmented_truncated_cube: "28d4768c5f1f4ff4",
  augmented_truncated_dodecahedron: "949c54f726fa36dc",
  parabiaugmented_truncated_dodecahedron: "867a19984d5e8bc9",
  metabiaugmented_truncated_dodecahedron: "2efb192625da61ca",
  triaugmented_truncated_dodecahedron: "e2498780f8ca6fb9",
  gyrate_rhombicosidodecahedron: "5282bc573d9d58e4",
  parabigyrate_rhombicosidodecahedron: "5a099f1dec995334",
  metabigyrate_rhombicosidodecahedron: "75efcfcb9dd98223",
  trigyrate_rhombicosidodecahedron: "d763dfce77f0b0b4",
  diminished_rhombicosidodecahedron: "6df861ab184cadfe",
  paragyrate_diminished_rhombicosidodecahedron: "0995a37eededdb2c",
  metagyrate_diminished_rhombicosidodecahedron: "ba8524bc1a55680e",
  bigyrate_diminished_rhombicosidodecahedron: "2cfa2f6ea42f5130",
  parabidiminished_rhombicosidodecahedron: "613ba01e3ab327e4",
  metabidiminished_rhombicosidodecahedron: "2bcc083fd6aa71b3",
  gyrate_bidiminished_rhombicosidodecahedron: "800fa7c79dda8c83",
  tridiminished_rhombicosidodecahedron: "73d4bccdf425a610",
  snub_disphenoid: "f67dfb87f6e27d86",
  snub_square_antiprism: "189e9dd41e285ec5",
  sphenocorona: "0718fc4193bd57f9",
  augmented_sphenocorona: "bb9961754a0ad865",
  sphenomegacorona: "5c1d82fbaa93de79",
  hebesphenomegacorona: "dd93444b6e23c7d3",
  disphenocingulum: "fa3a125ad00daef5",
  bilunabirotunda: "7a4d5ea0d3cef5cc",
  triangular_hebesphenorotunda: "08f69b1e9b4df375",
};

const distanceHash = (name: string): string => {
  const V = getSolid(name).V;
  const n = V.length / 3;
  const d: string[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = V[3 * i] - V[3 * j];
      const dy = V[3 * i + 1] - V[3 * j + 1];
      const dz = V[3 * i + 2] - V[3 * j + 2];
      d.push((dx * dx + dy * dy + dz * dz).toFixed(6));
    }
  d.sort();
  return createHash("sha256").update(d.join(",")).digest("hex").slice(0, 16);
};

describe("Johnson solids are the solids their names say", () => {
  it("each has its pinned distance hash, and no two share one", () => {
    expect(Object.keys(DISTANCE_HASH)).toEqual([...JOHNSON_SOLID_NAMES]);
    for (const name of JOHNSON_SOLID_NAMES) expect(distanceHash(name), name).toBe(DISTANCE_HASH[name]);
    expect(new Set(Object.values(DISTANCE_HASH)).size).toBe(92);
  });
});
