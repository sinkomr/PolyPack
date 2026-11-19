//! Seeded randomness of the searches: port of `packages/balls/src/random.ts` (mulberry32, a normal deviate by
//! Box-Muller, Shoemake's random rotation).

use polypack_js::math;

/// `random.ts: mulberry32`: the generator, whose state is the uint32 `a` of the closure.
pub struct Rng {
    a: u32,
}

impl Rng {
    /// `mulberry32(seed)`: `a = seed >>> 0`.
    pub fn new(seed: u32) -> Rng {
        Rng { a: seed }
    }

    #[allow(clippy::should_implement_trait)]
    /// One number in [0, 1). The source's 32-bit integer steps (`Math.imul`, `>>>`, `^`) are the wrapping
    /// u32 operations; `t ^= t + Math.imul(...)` adds two int32 and takes the low 32 bits, which is the
    /// wrapping add.
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// `random.ts: gauss`: a normal deviate (Box-Muller).
pub fn gauss(rng: &mut Rng) -> f64 {
    let u = math::max(rng.next(), 1e-300);
    math::sqrt(-2.0 * math::log(u)) * math::cos(2.0 * math::PI * rng.next())
}

/// `random.ts: randomQuaternion`: a uniformly random rotation as a unit quaternion [w, x, y, z] (Shoemake's method).
pub fn random_quaternion(rng: &mut Rng) -> [f64; 4] {
    let u1 = rng.next();
    let u2 = 2.0 * math::PI * rng.next();
    let u3 = 2.0 * math::PI * rng.next();
    let a = math::sqrt(1.0 - u1);
    let b = math::sqrt(u1);
    [a * math::sin(u2), a * math::cos(u2), b * math::sin(u3), b * math::cos(u3)]
}

/// `random.ts: rotationOf`: the rotation of a unit quaternion [w, x, y, z] as a row-major 3x3 matrix.
pub fn rotation_of(q: &[f64; 4]) -> [f64; 9] {
    let [w, x, y, z] = *q;
    [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y - w * z),
        2.0 * (x * z + w * y),
        2.0 * (x * y + w * z),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z - w * x),
        2.0 * (x * z - w * y),
        2.0 * (y * z + w * x),
        1.0 - 2.0 * (x * x + y * y),
    ]
}
