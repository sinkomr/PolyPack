//! packages/methods/src/random.ts.

/// mulberry32, as every PolyPack search uses it: a seed in [0, 2^32 - 1] gives a stream in [0, 1).
#[derive(Clone, Debug)]
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Mulberry32 { state: seed }
    }

    /// The next number of the stream, in [0, 1).
    #[inline]
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

/// random.ts: randomInt. A uniform integer in [0, n).
#[inline]
pub fn random_int(rng: &mut Mulberry32, n: usize) -> usize {
    // Math.min(n - 1, Math.floor(rng() * n)): the product is below n except by rounding
    let v = (rng.next() * n as f64).floor();
    if v > (n - 1) as f64 {
        n - 1
    } else {
        v as usize
    }
}

/// random.ts: sample. k distinct integers of [0, n), in random order (k <= n).
pub fn sample(rng: &mut Mulberry32, n: usize, k: usize) -> Vec<usize> {
    let mut a: Vec<usize> = (0..n).collect();
    for i in 0..k {
        let j = i + random_int(rng, n - i);
        a.swap(i, j);
    }
    a.truncate(k);
    a
}
