//! A small seeded generator (xoshiro256** seeded through splitmix64), so that the crate needs no external
//! dependency, with the few deviates the search draws: uniforms, normals, unit vectors and rotations.

#[derive(Clone, Debug)]
pub struct Rng {
    s: [u64; 4],
}

fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut st = seed ^ 0x9017_ed2a_5eed_0001;
        Rng { s: [splitmix(&mut st), splitmix(&mut st), splitmix(&mut st), splitmix(&mut st)] }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in [0, 1).
    #[inline]
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform in [a, b).
    #[inline]
    pub fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.uniform()
    }

    /// Uniform integer in 0..n (n > 0).
    #[inline]
    pub fn below(&mut self, n: usize) -> usize {
        (((self.next_u64() >> 32) * n as u64) >> 32) as usize
    }

    /// A standard normal deviate (Box-Muller, one of the pair).
    pub fn normal(&mut self) -> f64 {
        let u = 1.0 - self.uniform();
        let v = self.uniform();
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }

    /// A uniformly random unit quaternion [w, x, y, z] (a uniformly random rotation).
    pub fn quaternion(&mut self) -> [f64; 4] {
        loop {
            let q = [self.normal(), self.normal(), self.normal(), self.normal()];
            let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
            if n > 1e-6 {
                return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
            }
        }
    }

    /// A uniformly random unit vector.
    pub fn unit(&mut self) -> [f64; 3] {
        loop {
            let v = [self.normal(), self.normal(), self.normal()];
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if n > 1e-6 {
                return [v[0] / n, v[1] / n, v[2] / n];
            }
        }
    }
}
