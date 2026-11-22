//! Trigonometry of the plane of constant curvature K != 0, written for this crate.
//!
//! With s = sqrt(|K|):
//!   cs(x) = cos(s x) | cosh(s x),   sn(x) = sin(s x)/s | sinh(s x)/s,
//!   vs(x) = (1 - cs(x)) / K  (the versine: x^2/2 for small x).
//! A point of the plane is an ambient vector v = (v0, v1, v2) with v0^2 + K (v1^2 + v2^2) = 1 and
//! v0 > 0 (for K > 0 the sphere of radius 1/sqrt K, O = (1, 0, 0); for K < 0 the hyperboloid). The
//! bilinear form <a, b> = a0 b0 + K (a1 b1 + a2 b2) gives cs(distance).

#[derive(Clone, Copy, Debug)]
pub struct Kf {
    pub k: f64,
    /// sqrt(|K|)
    pub s: f64,
}

impl Kf {
    pub fn new(k: f64) -> Kf {
        assert!(k != 0.0 && k.is_finite());
        Kf { k, s: k.abs().sqrt() }
    }
    #[inline]
    pub fn cs(&self, x: f64) -> f64 {
        if self.k > 0.0 {
            (self.s * x).cos()
        } else {
            (self.s * x).cosh()
        }
    }
    #[inline]
    pub fn sn(&self, x: f64) -> f64 {
        if self.k > 0.0 {
            (self.s * x).sin() / self.s
        } else {
            (self.s * x).sinh() / self.s
        }
    }
    /// (1 - cs(x)) / K = 2 sn(x/2)^2, without cancellation.
    #[inline]
    pub fn vs(&self, x: f64) -> f64 {
        let h = self.sn(x / 2.0);
        2.0 * h * h
    }
    /// Inverse of sn on its monotone branch (argument clamped for K > 0).
    #[inline]
    pub fn asn(&self, y: f64) -> f64 {
        if self.k > 0.0 {
            (self.s * y).clamp(-1.0, 1.0).asin() / self.s
        } else {
            (self.s * y).asinh() / self.s
        }
    }
    /// Inverse of tn = sn / cs; infinity where K < 0 and |sqrt(-K) y| >= 1.
    #[inline]
    pub fn atn(&self, y: f64) -> f64 {
        if self.k > 0.0 {
            (self.s * y).atan() / self.s
        } else {
            let a = self.s * y;
            if a >= 1.0 {
                f64::INFINITY
            } else if a <= -1.0 {
                f64::NEG_INFINITY
            } else {
                a.atanh() / self.s
            }
        }
    }
    /// The length x >= 0 with (sn x, cs x) proportional to (sn, cs) (cs may be negative for K > 0).
    #[inline]
    pub fn ang(&self, sn: f64, cs: f64) -> f64 {
        if self.k > 0.0 {
            (self.s * sn).atan2(cs) / self.s
        } else {
            let a = (cs * cs + self.k * sn * sn).sqrt();
            (self.s * sn / a).asinh() / self.s
        }
    }
    /// Distance from O of an ambient point.
    #[inline]
    pub fn dist_o(&self, v: &[f64]) -> f64 {
        let w = (v[1] * v[1] + v[2] * v[2]).sqrt();
        self.ang(w, v[0])
    }
    /// Distance of two ambient points from their chord: vs(d) = (|dw|^2 + dv0^2 / K) / 2.
    #[inline]
    pub fn dist(&self, a: &[f64], b: &[f64]) -> f64 {
        let d0 = a[0] - b[0];
        let d1 = a[1] - b[1];
        let d2 = a[2] - b[2];
        let vs = (d1 * d1 + d2 * d2 + d0 * d0 / self.k) / 2.0;
        2.0 * self.asn((vs.max(0.0) / 2.0).sqrt())
    }
    /// The ambient point at distance d from O in direction phi.
    #[inline]
    pub fn polar(&self, d: f64, phi: f64) -> [f64; 3] {
        let r = self.sn(d);
        [self.cs(d), r * phi.cos(), r * phi.sin()]
    }
}
