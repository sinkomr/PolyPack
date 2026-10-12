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

`docs/RECORDS.md` describes what was taken from each and how it was converted.

## Atlas layout

The records page's atlas layout is inspired by The Squares Project
(<https://jlevy.github.io/squares/>). No code, styles or drawings from that
project are included.
