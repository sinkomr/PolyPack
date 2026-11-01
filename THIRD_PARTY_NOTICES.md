# Third-party notices

PolyPack's own code is released under the MIT licence in `LICENSE`. That licence
covers the code written for this project. It does not relicense the material
below, which belongs to its authors and is included or referenced with thanks.

## Soft-to-rigid hardening

The `harden` method (`packages/solver/src/methods/harden.ts` and
`packages/solver/src/methods/harden/`) implements soft-to-rigid hardening by
Yohei Nakajima and follows his reference engine's schedule and constants
(<https://github.com/yoheinakajima/soft-to-rigid>). His work is distributed
under the following licence:

```
MIT License

Copyright (c) 2026 Yohei Nakajima

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Published packing records

`data/sources/*.json` and `data/records.json` hold values, citations and
coordinates compiled from the sources below. Each record names its source and
the date it was read. The records remain the work of their authors and of the
people credited in each citation; they are not covered by this project's MIT
licence. Please credit the original source when reusing them.

- Erich Friedman, Packing Center, <https://erich-friedman.github.io/packing/>
- David Ellsworth, Squares in Squares, <https://kingbird.myphotos.cc/packing/squares_in_squares.html>
- Eckard Specht, Packomania, <http://www.packomania.com/>
- T. Berthold, D. Kamp, G. Mexi, S. Pokutta, I. Polik, "Out-of-the-Box Global
  Optimization for Packing Problems: New Models and Improved Solutions",
  submitted to the Journal of Global Optimization, 2026, arXiv:2605.04850; online
  supplement "Packing Solutions", <https://github.com/DominikKamp/Packing> at
  commit `27f71632d8655ae4b6a049410a401976748b94e3`, directory `polygon/`
  (`data/sources/kamp.json`). The repository states no licence; the data is
  used here with citation to the paper and the repository.

`docs/RECORDS.md` describes what was taken from each and how it was converted.

## Convex polytopes in 4 to 10 dimensions

The ndim package (`packages/ndim`, `python/ndim`, `docs/spaces/NDIM.md`) is PolyPack's own code. It uses
`python/polyhedra/algebraic.py` (vendored above) for interval arithmetic and integer square roots. None of upstream's
nD tools (`polytopes_nd.py` and `.json`, `certify_nd.py`, `ndsim.py`, `ndslp.py` of alejandrozu/platonic-packing) is
included, and none was used to build the catalogue. An independent review afterwards compared the catalogue with
upstream's `polytopes_nd.json` (all 12 polytopes the two share agree); that was a check, nothing of it is vendored. The polytopes are the regular, demi- and Gosset polytopes of H. S. M. Coxeter's _Regular
Polytopes_ and T. Gosset's 1900 paper, with their literature counts; the E8 root system of Conway and Sloane's _Sphere
Packings, Lattices and Groups_. No third-party data is included.

## Atlas layout

The records page's atlas layout is inspired by The Squares Project
(<https://jlevy.github.io/squares/>). No code, styles or drawings from that
project are included.

## Polyhedra in polyhedra

The polyhedra space (`packages/polyhedra`, `python/polyhedra`, `data/polyhedra`)
uses the code and data of polyhedrainpolyhedra.wiki, the repository
<https://github.com/alejandrozu/platonic-packing> at commit
`cbf76f2f6fb33a0380b9a283c00c6e62cce22e78` (22 October 2026). Its records rest
in part on the further sources listed after it; `docs/spaces/POLYHEDRA.md`
says which records use which source, and every record of
`data/polyhedra/records.json` names its sources (`sources`, `source`).
The balls space (`python/balls`, `packages/balls`; balls of diameter 1 since 2026-10-27) uses the same vendored
certifier and solids (it imports `python/polyhedra/certify_general.py` and the
solids of `packages/polyhedra`); none of its records rests on upstream's data.

### alejandrozu/platonic-packing

Used: `certify_general.py`, `algebraic.py` and `multiquad.py`, copied into
`python/polyhedra/` with their headers (`certify_general.py` changed only in the
path of the solids file, marked "PolyPack:"); `src/solids_exact.json`, copied
unchanged to `python/polyhedra/solids_exact.json` (PolyPack appends its own
prisms and antiprisms with 7, 9, 10 and 11 sides after upstream's 56 solids), from
which `packages/polyhedra/src/solids.data.ts` is generated; `src/geom.js` and
`src/sim.js`, ported to TypeScript in `packages/polyhedra/src/sim/` with their
header comments (changes listed there); the problem names and codes of
`scripts/engine.py`; the record files under `records/` (configurations, credits
and lineage) and `docs/external_records.json` (published values); and the
selection of records and reference values of the site's data bundle
<https://polyhedrainpolyhedra.wiki/data/records.json> (build of 21 October
2026). Licence:

```
MIT License

Copyright (c) 2026 Yohei Nakajima (soft-to-rigid-packing: method, simulator, tightening and checker design)
Copyright (c) 2026 Alejandro Zarzuelo (generalization to Platonic solids in Platonic containers)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Community submissions to that repository (by PingYou Ltd, konoha-ily2 and
Stian) were made through its submission form, which grants permission to
publish them under the repository's MIT licence; their credits are kept in the
records' `found_by` and `certificate_refined_by` fields.

### Berthold, Kamp, Mexi, Pokutta and Polik

T. Berthold, D. Kamp, G. Mexi, S. Pokutta, I. Polik, "Out-of-the-Box Global
Optimization for Packing Problems: New Models and Improved Solutions",
submitted to the Journal of Global Optimization, 2026, arXiv:2605.04850. Online
supplement: <https://github.com/DominikKamp/Packing>, as frozen by upstream at
commit `27f71632d8655ae4b6a049410a401976748b94e3` (directory `platonic/`).
Upstream converted these packings to its format and searched further from
them; the records here that rest on them say so ("derived from Berthold,
Kamp, Mexi, Pokutta and Polik 2026"). The repository states no licence; the
data is used here with citation to the paper and the repository.

### Hyra-results (Tencent)

Haowei Lin (Tencent Hunyuan), Hyra-results,
<https://github.com/Tencent-Hunyuan/Hyra-results>, commit
`09b2d2e3c362c67a78f544c836bd8e4b54a05527`, files
`AI4Science/packing_records/records/cubincub_n11.json`, `cubincub_n12.json`,
`octincub_n21.json` and `octincub_n24.json`, licensed under the Apache License,
Version 2.0; a copy of the licence is in `LICENSES/Apache-2.0.txt`. Their
notices:

```
Tencent is pleased to support the community by making hyra-results available.

Copyright (C) 2026 Tencent. All rights reserved.

Unless otherwise specified, all Tencent-authored materials in this repository are licensed under the Apache License, Version 2.0.
```

The repository has no NOTICE file at that commit. The data were modified:
upstream converted Lin's arrangements to unit-edge coordinates with the
container centred at the origin and a clearance of 1e-7, and its search (and,
for some, Sam Scott's tightening below) moved the pieces and reduced the
container; PolyPack stores the result in its own record format without
changing the coordinates. Each record that rests on this data says so in its
`notes`.

### hyra-packing-audit (Sam Scott)

<https://github.com/shepard5/hyra-packing-audit>, commit
`c107fda33c2f02df83e9d549fb839b4fd5a7bfbc`, `tightened/` (tightened versions of
the Hyra-results arrangements above). Licence and notice:

```
MIT License

Copyright (c) 2026 Sam Scott

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The files in tightened/ are derived from Apache-2.0 data; see NOTICE.
```

```
The files in tightened/ are modified versions of records from Tencent-Hunyuan/Hyra-results
(https://github.com/Tencent-Hunyuan/Hyra-results), Copyright (C) 2026 Tencent, licensed under the
Apache License, Version 2.0. Modification: each arrangement was tightened by local optimization
(the pieces were moved slightly and the container was reduced), with 1e-6 clearance.
```

### cubes-in-cube-n13 (@BuilderOfAgents)

<https://github.com/tronford/cubes-in-cube-n13>, commit
`1f0c75401b2da4850b7e9f14de7d7b9cbe5e461a`, `claims/cubincub_n13` and
`claims/cubincub_n14` (cubes in a cube, as imported by upstream). These are
candidates of the records build; at present the wiki's own records of those
cases are smaller, so no record uses their coordinates. Licence:

```
MIT License

Copyright (c) 2026 Yohei Nakajima (soft-to-rigid method, simulator, solver, checkers)
Copyright (c) 2026 @BuilderOfAgents (n = 13 runs, re-melt and insert moves, video)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### konoha-ily2 (Hirotaka Nakano)

Exact certificates of cubes in a cube for n = 28, 34, 35 and 36, posted in
<https://github.com/alejandrozu/platonic-packing/issues/1> (11 October 2026)
and imported by upstream. The post states no licence; the data is used here
with citation to the post. (konoha-ily2's later submissions through the
repository's form are covered by its MIT permission, above.)

### Ryan Xu

<https://github.com/ry-xu/square_packing>, commit
`9535d65d84cc33f20f4e26329f8da12bdcef216e`, `cube_packing_records.json` (cubes in
a cube, n = 34, 35, 36, as imported by upstream). The repository states no
licence; the data is used here with citation to the repository. The records of
cubes in a cube for P = 34, 35 and 36 are these packings as upstream imported
them, and say so ("derived from Ryan Xu").

### Other sources upstream lists

Yohei Nakajima's 12 cubes in a cube (soft-to-rigid-packing, commit
`efe7a920142350a4f0678633490c3e3dbed71fa0`, MIT, Copyright (c) 2026 Yohei
Nakajima) is listed only as a published value: the wiki's record of that case
is smaller. Upstream's reconstruction of Erich Friedman's 33 cubes in a cube
(coordinates made by upstream, MIT; the construction is Friedman's) is the
record of that case and credits him.

### Published values without coordinates

Erich Friedman's Packing Center (<https://erich-friedman.github.io/packing/>)
lists values for cubes and octahedra in a cube by Erich Friedman, Ríain Walsh,
Haowei Lin and others; upstream's registry `docs/external_records.json` records
them with links, and `data/polyhedra/records.json` lists them as published
values (number, author, link) without coordinates. No images or animations are
copied.

## three.js

The board draws 3D in 3D and 3D on 4D packings with three.js
(<https://threejs.org>, npm package `three` 0.186.1, in a chunk of the website's
code that only those kinds load, and in the 3D on 4D viewer). Its licence:

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
