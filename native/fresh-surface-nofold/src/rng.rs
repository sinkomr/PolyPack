// Adapted from native/fresh-flat (fresh code of the same experiment).
//! A small deterministic generator: SplitMix64 to seed, xoshiro256** to draw.

#[derive(Clone, Debug)]
pub struct Rng {
    s: [u64; 4],
}

fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut st = seed ^ 0x5DEE_CE66_D1CE_4E5B;
        let s = [splitmix(&mut st), splitmix(&mut st), splitmix(&mut st), splitmix(&mut st)];
        Rng { s }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let r = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        r
    }

    /// Uniform in [0, 1).
    #[inline]
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform in [-1, 1).
    #[inline]
    pub fn signed(&mut self) -> f64 {
        2.0 * self.uniform() - 1.0
    }

    /// Uniform in 0..n (n > 0).
    #[inline]
    pub fn below(&mut self, n: usize) -> usize {
        ((self.next_u64() >> 32) * n as u64 >> 32) as usize
    }

    /// Standard normal (Box-Muller, one of the pair).
    pub fn normal(&mut self) -> f64 {
        let u = 1.0 - self.uniform();
        let v = self.uniform();
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }

    /// True with probability p.
    #[inline]
    pub fn chance(&mut self, p: f64) -> bool {
        self.uniform() < p
    }
}
