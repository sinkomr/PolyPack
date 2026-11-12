//! Seeded randomness, the same streams as the TypeScript searches: mulberry32 (optim.ts rng and
//! spaces/search/seed.ts seededStream) and the seed mixer of the job rounds (seed.ts mixSeed).

/// mulberry32 draws in [0, 1) from a uint32 seed (a zero seed is replaced as the reference does).
#[derive(Clone, Debug)]
pub struct Rng {
    state: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng {
            state: if seed == 0 { 0x9e3779b9 } else { seed },
        }
    }

    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }

    /// A standard normal draw (Box-Muller, one of the pair).
    pub fn gaussian(&mut self) -> f64 {
        let mut u = 0.0;
        while u == 0.0 {
            u = self.next_f64();
        }
        (-2.0 * libm::log(u)).sqrt() * libm::cos(2.0 * std::f64::consts::PI * self.next_f64())
    }
}

/// A well-mixed uint32 from two inputs (the finaliser of MurmurHash3 over a golden-ratio step).
pub fn mix_seed(a: u32, b: u32) -> u32 {
    let mut h = a ^ b.wrapping_add(1).wrapping_mul(0x9e3779b1);
    h = (h ^ (h >> 16)).wrapping_mul(0x85ebca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2ae35);
    h ^ (h >> 16)
}

/// A job seed as the reference's uint32: seeds below 2^32 are kept, larger ones are folded.
pub fn seed32(seed: u64) -> u32 {
    if seed >> 32 == 0 {
        seed as u32
    } else {
        mix_seed(seed as u32, (seed >> 32) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulberry32_matches_the_reference() {
        // node: rng(1)() three times, mixSeed(7, 3)
        let mut r = Rng::new(1);
        let a = [r.next_f64(), r.next_f64(), r.next_f64()];
        assert_eq!(a, [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
        assert_eq!(mix_seed(7, 3), 3510281238);
        assert_eq!(mix_seed(1, 0), 2980047484);
        assert_eq!(mix_seed(0xffffffff, 5), 213818781);
    }
}
