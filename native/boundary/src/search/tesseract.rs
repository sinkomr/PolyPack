//! Tesseract fast path: exact "lattice word" developments, an independent method used by the ball
//! search on the tesseract. Port of packages/boundary/src/tesseract.ts (`TesseractWords`, the part
//! the search's word tables read: the words themselves).
//!
//! On the tesseract every ridge is a right angle in R^4, so a chain develops into cubes of the
//! lattice s Z^3 (cells centred at lattice points) and every lattice edge is the image of a
//! tesseract edge. A geodesic from u in cell c0 is a straight segment of the development avoiding
//! the lattice lines; it is determined by the sequence of lattice faces it crosses (a word). Each
//! word has, independently of u, an end cell and an affine map development -> R^4. Words are
//! monotone per lattice axis with |m_k| <= mmax; mmax = 2 covers lengths < 2 for s >= sqrt 2.
//!
//! Crossing rule: in cell (i, sg) (the cell x_i = sg s/2, id 2 i + (sg > 0)), the lattice direction
//! tau e_k maps to a signed 4D axis tj e_j; crossing that face leads to cell (j, tj), and the rotation
//! sends sg e_i -> tj e_j and tj e_j -> -sg e_i, fixing the 2-face.

use std::collections::HashMap;

/// packages/boundary/src/tesseract.ts: Word
#[derive(Clone, Debug)]
pub struct Word {
    /// The lattice planes crossed, in order: axis k and level.
    pub steps: Vec<(usize, i32)>,
    pub m: [i32; 3],
    pub cell: usize,
    /// development (local of the start cell, unit h) -> R^4: x = A y + h b, A is 4 x 3
    pub a: [[f64; 3]; 4],
    pub b: [f64; 4],
}

/// packages/boundary/src/tesseract.ts: axesOf
pub fn axes_of(i: usize) -> [usize; 3] {
    let mut out = [0; 3];
    let mut k = 0;
    for j in 0..4 {
        if j != i {
            out[k] = j;
            k += 1;
        }
    }
    out
}

fn frame(c: usize) -> ([[f64; 3]; 4], [f64; 4]) {
    let i = c >> 1;
    let sg = if c & 1 == 1 { 1.0 } else { -1.0 };
    let mut a = [[0.0; 3]; 4];
    for (k, j) in axes_of(i).into_iter().enumerate() {
        a[j][k] = 1.0;
    }
    let mut b = [0.0; 4];
    b[i] = sg;
    (a, b)
}

fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// packages/boundary/src/tesseract.ts: buildWords
fn build_words(c0: usize, mmax: i32) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::new();
    let (fa, fb) = frame(c0);
    let mut stack: Vec<Word> = vec![Word { steps: vec![], m: [0, 0, 0], cell: c0, a: fa, b: fb }];
    while let Some(w) = stack.pop() {
        for k in 0..3 {
            for tau in [-1i32, 1] {
                if w.m[k] != 0 && w.m[k].signum() != tau {
                    continue;
                }
                if (w.m[k] + tau).abs() > mmax {
                    continue;
                }
                let i = w.cell >> 1;
                let sg = if w.cell & 1 == 1 { 1.0 } else { -1.0 };
                let col: [f64; 4] = [0, 1, 2, 3].map(|r| w.a[r][k] * tau as f64);
                let mut j = 0;
                for r in 1..4 {
                    if col[r].abs() > col[j].abs() {
                        j = r;
                    }
                }
                let tj = sign(col[j]);
                // R: sg e_i -> tj e_j, tj e_j -> -sg e_i; q = sg e_i + tj e_j (unit h)
                let rot = |x: [f64; 4]| -> [f64; 4] {
                    let mut y = x;
                    y[i] = -sg * tj * x[j];
                    y[j] = sg * tj * x[i];
                    y
                };
                let mut a2 = [[0.0; 3]; 4];
                for c in 0..3 {
                    let col2 = rot([0, 1, 2, 3].map(|r| w.a[r][c]));
                    for r in 0..4 {
                        a2[r][c] = col2[r];
                    }
                }
                let mut q = [0.0; 4];
                q[i] = sg;
                q[j] = tj;
                let shifted = rot([0, 1, 2, 3].map(|r| w.b[r] - q[r]));
                let b2: [f64; 4] = [0, 1, 2, 3].map(|r| shifted[r] + q[r]);
                let mut m2 = w.m;
                let level = 2 * w.m[k] + tau;
                m2[k] += tau;
                let mut steps = w.steps.clone();
                steps.push((k, level));
                stack.push(Word { steps, m: m2, cell: 2 * j + if tj > 0.0 { 1 } else { 0 }, a: a2, b: b2 });
            }
        }
        out.push(w);
    }
    out
}

/// The words of every start cell, grouped by (start, end) cell.
/// packages/boundary/src/tesseract.ts: TesseractWords
pub struct TesseractWords {
    by: HashMap<(usize, usize), Vec<Word>>,
}

impl TesseractWords {
    pub fn new(mmax: i32) -> TesseractWords {
        let mut by: HashMap<(usize, usize), Vec<Word>> = HashMap::new();
        for c0 in 0..8 {
            for w in build_words(c0, mmax) {
                by.entry((c0, w.cell)).or_default().push(w);
            }
        }
        TesseractWords { by }
    }

    /// The words from c1 to c2, in the order they were found.
    pub fn list(&self, c1: usize, c2: usize) -> &[Word] {
        self.by.get(&(c1, c2)).map_or(&[], |v| v.as_slice())
    }
}
