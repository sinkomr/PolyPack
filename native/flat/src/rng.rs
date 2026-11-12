//! Seeded randomness. Every decision of a search draws from one of these streams, never from a
//! clock, so the same seed and the same evaluation budget give the same result.

use crate::math;

/// Mulberry32: the generator of the reference solver, uniform draws in [0, 1) from a u32 state.
#[derive(Clone, Debug)]
pub struct Rng {
    state: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng { state: seed }
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// Uniform in [0, 1).
    #[inline]
    pub fn next(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0
    }

    /// Uniform in [-1, 1).
    #[inline]
    pub fn signed(&mut self) -> f64 {
        2.0 * self.next() - 1.0
    }

    /// Uniform integer in [0, n) (n > 0), as floor(next() * n).
    #[inline]
    pub fn below(&mut self, n: usize) -> usize {
        ((self.next() * n as f64) as usize).min(n.saturating_sub(1))
    }

    /// Standard normal by Box-Muller from two draws (the reference's `gaussian`).
    #[inline]
    pub fn gaussian(&mut self) -> f64 {
        let mut u = 0.0;
        while u == 0.0 {
            u = self.next();
        }
        (-2.0f64 * math::log(u)).sqrt() * math::cos(2.0 * std::f64::consts::PI * self.next())
    }
}

/// A well-mixed u32 from two inputs (MurmurHash3's finaliser over a golden-ratio step).
pub fn mix_seed(a: u32, b: u32) -> u32 {
    let mut h = a ^ (b.wrapping_add(1)).wrapping_mul(0x9e3779b1);
    h = (h ^ (h >> 16)).wrapping_mul(0x85ebca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2ae35);
    h ^ (h >> 16)
}

fn normal(rng: &mut Rng) -> f64 {
    // Box-Muller; 1 - u keeps the logarithm finite
    (-2.0f64 * math::log(1.0 - rng.next())).sqrt() * math::cos(2.0 * std::f64::consts::PI * rng.next())
}

/// Gamma(shape, 1) by Marsaglia and Tsang's squeeze, with the usual boost for shape < 1.
pub fn gamma(rng: &mut Rng, shape: f64) -> f64 {
    if shape < 1.0 {
        let g = gamma(rng, shape + 1.0);
        return g * math::pow(rng.next(), 1.0 / shape);
    }
    let d = shape - 1.0 / 3.0;
    let c = 1.0 / (9.0 * d).sqrt();
    loop {
        let mut x;
        let mut v;
        loop {
            x = normal(rng);
            v = 1.0 + c * x;
            if v > 0.0 {
                break;
            }
        }
        v = v * v * v;
        let u = rng.next();
        if u < 1.0 - 0.0331 * x * x * x * x || math::log(u) < 0.5 * x * x + d * (1.0 - v + math::log(v)) {
            return d * v;
        }
    }
}

/// One draw from Beta(alpha, beta), both positive.
pub fn beta_sample(rng: &mut Rng, alpha: f64, beta: f64) -> f64 {
    let x = gamma(rng, alpha);
    let y = gamma(rng, beta);
    if x + y > 0.0 {
        x / (x + y)
    } else {
        0.5
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_reference_stream() {
        // seededRandom(1) of the reference: first draws
        let mut r = Rng::new(1);
        let a = r.next();
        let b = r.next();
        assert!((a - 0.6270739405881613).abs() < 1e-16, "{a}");
        assert!((b - 0.002735721180215478).abs() < 1e-16, "{b}");
        assert_eq!(mix_seed(1, 0), 2980047484);
        assert_eq!(mix_seed(123456789, 7), 3108084259);
        assert_eq!(mix_seed(u32::MAX, u32::MAX), 2180083513);
    }
}
