//! Seeded randomness of the boundary searches: every random choice comes from one mulberry32 stream.
//! Port of packages/boundary/src/search/random.ts.

/// mulberry32: uniform draws in [0, 1) from a uint32 seed (the solver's own generator).
/// packages/boundary/src/search/random.ts: mulberry32
pub struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Mulberry32 { a: seed }
    }

    /// The next draw. The source's `Math.imul`, `^` and `>>>` are 32-bit, and the sum `t + imul(..)` is
    /// reduced to 32 bits by the `^=` that follows, so every step is a wrapping u32 operation.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }

    /// A uniform integer in [0, n). packages/boundary/src/search/random.ts: randInt
    pub fn int(&mut self, n: usize) -> usize {
        let v = (self.next() * n as f64).floor();
        // Math.min(n - 1, Math.floor(rand() * n))
        let m = n as f64 - 1.0;
        (if v < m { v } else { m }) as usize
    }
}
