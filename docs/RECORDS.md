# Literature records

`data/records.json` is generated. Do not edit it by hand; rerun the scripts.

Labels: **[EST]** established with a source, **[CALC]** computed or derived here.

## Sources (read 2026-10-07 unless stated)

| Source | What was taken | Units at the source | Conversion |
|---|---|---|---|
| Erich Friedman, Packing Center, https://erich-friedman.github.io/packing/ | 34 pages: circles, triangles, squares, pentagons, hexagons and octagons in circles, triangles, squares, pentagons, hexagons and octagons. 1,557 values, up to n = 50. | Unit pieces (side 1, circle radius 1); container radius r or side s. | None. Each page's own sentence is checked by the importer. |
| David Ellsworth, Squares in Squares, https://kingbird.myphotos.cc/packing/squares_in_squares.html | Squares in squares, n up to 324. | Unit squares; container side s. | None. |
| Eckard Specht, Packomania, http://www.packomania.com/ | Equal circles in a circle and in a square: values to n = 500. Coordinates: circles in a circle to n = 500, circles in a square to n = 100. | Container of radius 1 (or side 1); circle radius listed. | Value = 1 / radius (the source's "ratio" column); coordinates divided by the radius. |

### Circle-in-circle coordinates

The coordinates of circles in a circle for n = 101 to 500 were read on 2026-10-11 from a local copy of Packomania's coordinate archive, `cci_coords.tar`. The archive is not committed (281 MB unpacked). Each file `cci<n>.txt` lists `index x y`: circle centres in a container of radius 1.

- [CALC] The archive holds 2,735 files: every n from 1 to 2600, and 135 further n up to 5000. These are exactly the n of the source's radius table. Only n up to 500, the site's cap on P, is imported. A later increase of the cap finds the rest in the same archive.
- [CALC] For n up to 100 the archive gives, after conversion, bit for bit the coordinates stored on 2026-10-07. It is the same set.
- [CALC] For every n up to 500 the radius implied by the archive (half the smallest centre distance, and 1 minus the largest centre distance) equals the published radius to the digits printed. The archive holds no packing that differs from the published table. The source's radius and ratio tables fetched again on 2026-10-11 are identical to the stored citations for n up to 500, for circles in a circle and in a square.
- [CALC] The source prints 30 decimals for 315 of the n up to 500 and 12 decimals for the other 185 (all above 100), in the coordinates and in the radius alike. After conversion the 12-decimal files reproduce the published value to 3.3e-11 and have contacts that overlap by at most 6.2e-11. The site's rule for a valid configuration allows 1e-9, so all 400 new configurations are stored as printed. None was polished and none was left out. `coordinates_note` gives the number of decimals for each.
- The published `value` and `display` are the source's table entries. Coordinates never change them.

## Status of an entry

The project's rule: a claim of proof that is generally accepted is recorded as proven. In this file that means the source reports the result as proved and the proof is dated before the cut-off year, 2023. A more recent claim stays flagged until its acceptance is confirmed.

- `proven`: the source says "Proved by ..." (before 2023) or "Trivial".
- `proven_unrefereed`: the source says "Proved by ..." in 2023 or later. Whether the proof is peer reviewed was not checked, so these are flagged for caution. [This cut-off year is a rule of this project, not a statement by the sources.] The current build has six: squares in a circle for n = 3 to 7 (claims dated 2026) and two pentagons in a triangle (May 2026).
- `best_known`: the source says "Found by ..." or gives no attribution.
- `trivial_tiling`: a zero-waste tiling exists [CALC]: one piece in a container of its own shape, k² squares in a square, k² triangles in a triangle.

## Rebuilding

The importers read local copies, so that a run is repeatable and the access date is explicit.

```
git clone --depth 1 https://github.com/erich-friedman/erich-friedman.github.io.git friedman
npx tsx scripts/import-friedman.ts friedman 2026-10-07
curl -L -o ellsworth.html https://kingbird.myphotos.cc/packing/squares_in_squares.html
npx tsx scripts/import-ellsworth.ts ellsworth.html 2026-10-07
npx tsx scripts/import-packomania.ts packomania 2026-10-07
mkdir cci_coords
tar -xf cci_coords.tar -C cci_coords
npx tsx scripts/attach-packomania-coords.ts cci_coords 2026-10-11
npx tsx scripts/build-records.ts
```

The Packomania directory layout is described at the top of `scripts/import-packomania.ts`.

- `cci_coords.tar` is supplied locally and is not committed; see "Circle-in-circle coordinates" above. Unpack it into a new, empty directory. The files are read as data only.
- `scripts/attach-packomania-coords.ts` needs only `data/sources/packomania.json` and the unpacked archive, not the radius and ratio tables: each record keeps the source's printed radius in its citation. It attaches coordinates to circles in a circle up to n = 500 and leaves circles in a square alone. A record whose coordinates already equal the archive's is not touched, so a second run changes nothing. The date is the day the archive was read; it goes into `coordinates_note`.
- `scripts/import-packomania.ts` itself also keeps circle-in-circle coordinates to n = 500 when its `cci-coords` directory holds them. Then the attach step finds nothing to do.
- [CALC] The Friedman repository at commit `dc91d31` (2026-10-07) reproduces `data/sources/friedman.json` exactly; a shallow clone gives the newest state of the pages, which may differ.
- `scripts/build-records.ts` stamps the file, and the entries derived here, with the date of the build.

## Checks made by the scripts

- An entry whose number cannot be read is skipped and reported, never guessed.
- Every value must be at or above the area lower bound.
- Stored coordinates must pass this site's own overlap check and reproduce the value to 1e-8. The overlap check is the one used for submissions: a penetration up to 1e-9 counts as contact. No stored configuration is polished. `packages/geometry/test/records.test.ts` repeats the check on the generated file.
- A Packomania coordinate file is used only if every line is `index x y` and the indices run from 1 to n.
- A caption that contains "proved" or "proven" but cannot be read as a proof claim is reported, never stored silently as `best_known`. [An earlier version read "Proved by F. Fodor in 2003." only as far as the initial, so 13 and 19 circles in a circle were stored as `best_known`. Corrected 2026-10-11.]
- Where two sources cover the same problem (circles in a circle or square, n up to 24), their values must agree; disagreements are printed. The current build has none.

## Known gaps

- Friedman's values are printed truncated (for example "2.154+"), to 3 to 5 decimals. They are stored as printed, with `display_precision` set to the number of printed decimals.
- No coordinates for polygon packings from the literature. Friedman publishes pictures only. Ellsworth's SVG files and the `jlevy/squares` registry contain coordinates for squares in squares; they are not imported yet.
- Container shapes other than circle, triangle, square, pentagon, hexagon and octagon, and piece shapes with 7 or more than 8 sides, have no published values in these sources.
- Published papers were not searched one by one. Proofs are recorded as the three sources above report them. Example: Friedman lists 12 and 14 circles in a circle as "Found by", so they are `best_known` here, although Wikipedia's "Circle packing in a circle" (read 2026-10-11) cites proofs by Fodor (2000) and by Ekanayake and LaFountain (2024).
- Packomania coordinates for circles in a square are stored only to n = 100.
