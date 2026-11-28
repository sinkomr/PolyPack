//! The problem as the search sees it: the piece and the container in internal units, and the poses.
//!
//! Internal units: lengths are divided by the piece's circumradius rho (the largest vertex distance from its
//! centre), so that every piece lies in the unit ball about its centre. The container size s is unitless (the
//! scale of the canonical container) and the same in both units: face g of the container at size s is
//! N_g . x <= s b_g with b_g = B_g / rho (B_g the canonical solid's offset), and the ball container (solids in a
//! ball, s its diameter) is |x| <= s beta with beta = 1 / (2 rho). Positions are converted back (times rho) only
//! when a configuration is written.
//!
//! A pose is a centre and a quaternion q = [w, x, y, z] (any nonzero length): the rotation H(q) / |q|^2, the
//! validator's convention (world = R local).

use polypack_polyhedra::{get_problem, get_solid, volume_bound, Solid};
use polypack_spaces::SpaceName;

/// The rotation of q / |q| (row major, world = R local): H(q) / |q|^2.
#[inline]
pub fn rot(q: &[f64]) -> [f64; 9] {
    let (w, x, y, z) = (q[0], q[1], q[2], q[3]);
    let n2 = w * w + x * x + y * y + z * z;
    let k = 1.0 / n2;
    [
        (w * w + x * x - y * y - z * z) * k,
        2.0 * (x * y - w * z) * k,
        2.0 * (x * z + w * y) * k,
        2.0 * (x * y + w * z) * k,
        (w * w - x * x + y * y - z * z) * k,
        2.0 * (y * z - w * x) * k,
        2.0 * (x * z - w * y) * k,
        2.0 * (y * z + w * x) * k,
        (w * w - x * x - y * y + z * z) * k,
    ]
}

/// R^T u.
#[inline]
pub fn rt_mul(r: &[f64; 9], u: [f64; 3]) -> [f64; 3] {
    [
        r[0] * u[0] + r[3] * u[1] + r[6] * u[2],
        r[1] * u[0] + r[4] * u[1] + r[7] * u[2],
        r[2] * u[0] + r[5] * u[1] + r[8] * u[2],
    ]
}

/// R v.
#[inline]
pub fn r_mul(r: &[f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
        r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
        r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
    ]
}

#[inline]
pub fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The quaternion product a b ([w, x, y, z]).
#[inline]
pub fn qmul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ]
}

/// The unit quaternion of a rotation by the angle |v| about v.
pub fn qexp(v: [f64; 3]) -> [f64; 4] {
    let a = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if a < 1e-300 {
        return [1.0, 0.0, 0.0, 0.0];
    }
    let s = (0.5 * a).sin() / a;
    [(0.5 * a).cos(), v[0] * s, v[1] * s, v[2] * s]
}

pub fn qnormalize(q: &mut [f64]) {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if n > 0.0 && n.is_finite() {
        for v in q.iter_mut() {
            *v /= n;
        }
    } else {
        q.copy_from_slice(&[1.0, 0.0, 0.0, 0.0]);
    }
}

/// The piece in internal units (circumradius 1), vertices in structure-of-arrays form.
#[derive(Clone, Debug)]
pub struct Piece {
    pub solid: &'static Solid,
    /// The canonical solid's circumradius (true units).
    pub rho: f64,
    pub nv: usize,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub vz: Vec<f64>,
    /// Outward unit face normals (local).
    pub nf: usize,
    pub fx: Vec<f64>,
    pub fy: Vec<f64>,
    pub fz: Vec<f64>,
    /// Inradius (internal units): the smallest face offset.
    pub inr: f64,
    /// The canonical solid's volume (true units).
    pub volume: f64,
}

impl Piece {
    pub fn new(solid: &'static Solid) -> Piece {
        let nv = solid.nv;
        let mut rho = 0.0f64;
        for i in 0..nv {
            let v = &solid.v[3 * i..3 * i + 3];
            rho = rho.max((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt());
        }
        let (mut vx, mut vy, mut vz) = (Vec::with_capacity(nv), Vec::with_capacity(nv), Vec::with_capacity(nv));
        for i in 0..nv {
            vx.push(solid.v[3 * i] / rho);
            vy.push(solid.v[3 * i + 1] / rho);
            vz.push(solid.v[3 * i + 2] / rho);
        }
        let nf = solid.offsets.len();
        let (mut fx, mut fy, mut fz) = (Vec::with_capacity(nf), Vec::with_capacity(nf), Vec::with_capacity(nf));
        let mut inr = f64::INFINITY;
        for f in 0..nf {
            fx.push(solid.n[3 * f]);
            fy.push(solid.n[3 * f + 1]);
            fz.push(solid.n[3 * f + 2]);
            inr = inr.min(solid.offsets[f] / rho);
        }
        Piece { solid, rho, nv, vx, vy, vz, nf, fx, fy, fz, inr, volume: solid.volume }
    }

    /// The support function: max over the vertices of u . v (u in local coordinates).
    #[inline]
    pub fn support(&self, u: [f64; 3]) -> f64 {
        let mut m = f64::NEG_INFINITY;
        for k in 0..self.nv {
            let d = u[0] * self.vx[k] + u[1] * self.vy[k] + u[2] * self.vz[k];
            if d > m {
                m = d;
            }
        }
        m
    }

    /// Both extremes of u . v over the vertices.
    #[inline]
    pub fn extent(&self, u: [f64; 3]) -> (f64, f64) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for k in 0..self.nv {
            let d = u[0] * self.vx[k] + u[1] * self.vy[k] + u[2] * self.vz[k];
            lo = lo.min(d);
            hi = hi.max(d);
        }
        (lo, hi)
    }
}

/// The container in internal units: the canonical solid's face planes with offsets divided by rho, or a ball.
#[derive(Clone, Debug)]
pub struct Container {
    pub ball: bool,
    /// Ball: the radius at size s is s beta.
    pub beta: f64,
    pub nf: usize,
    pub nx: Vec<f64>,
    pub ny: Vec<f64>,
    pub nz: Vec<f64>,
    /// Offsets at size 1 (internal units).
    pub b: Vec<f64>,
    /// Vertices at size 1 (internal units), flat.
    pub verts: Vec<f64>,
    /// Faces as vertex cycles (for the frames of lattice starts).
    pub faces: Vec<Vec<usize>>,
    /// Volume at size 1, true units.
    pub volume: f64,
    /// Radius at size 1 of the largest ball about the origin inside (internal units).
    pub inr: f64,
    /// Largest vertex distance at size 1 (internal units).
    pub outr: f64,
    pub solid: Option<&'static Solid>,
}

impl Container {
    pub fn of_solid(solid: &'static Solid, rho: f64) -> Container {
        let nf = solid.offsets.len();
        let mut c = Container {
            ball: false,
            beta: 0.0,
            nf,
            nx: Vec::with_capacity(nf),
            ny: Vec::with_capacity(nf),
            nz: Vec::with_capacity(nf),
            b: Vec::with_capacity(nf),
            verts: solid.v.iter().map(|v| v / rho).collect(),
            faces: solid.faces.clone(),
            volume: solid.volume,
            inr: f64::INFINITY,
            outr: 0.0,
            solid: Some(solid),
        };
        for f in 0..nf {
            c.nx.push(solid.n[3 * f]);
            c.ny.push(solid.n[3 * f + 1]);
            c.nz.push(solid.n[3 * f + 2]);
            c.b.push(solid.offsets[f] / rho);
            c.inr = c.inr.min(solid.offsets[f] / rho);
        }
        for v in c.verts.chunks_exact(3) {
            c.outr = c.outr.max((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt());
        }
        c
    }

    pub fn ball(rho: f64) -> Container {
        let beta = 0.5 / rho;
        Container {
            ball: true,
            beta,
            nf: 0,
            nx: Vec::new(),
            ny: Vec::new(),
            nz: Vec::new(),
            b: Vec::new(),
            verts: Vec::new(),
            faces: Vec::new(),
            volume: std::f64::consts::PI / 6.0,
            inr: beta,
            outr: beta,
            solid: None,
        }
    }

    /// The least size whose container holds the ball of radius r about p.
    #[inline]
    pub fn size_for_ball(&self, p: [f64; 3], r: f64) -> f64 {
        if self.ball {
            return ((p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt() + r) / self.beta;
        }
        let mut s = f64::NEG_INFINITY;
        for g in 0..self.nf {
            let d = self.nx[g] * p[0] + self.ny[g] * p[1] + self.nz[g] * p[2] + r;
            s = s.max(d / self.b[g]);
        }
        s
    }

    /// The least size whose container holds the piece at the centre c with rotation r (vertices of `piece`).
    pub fn size_for_piece(&self, piece: &Piece, c: [f64; 3], r: &[f64; 9]) -> f64 {
        if self.ball {
            let mut m = 0.0f64;
            for k in 0..piece.nv {
                let w = r_mul(r, [piece.vx[k], piece.vy[k], piece.vz[k]]);
                let x = [c[0] + w[0], c[1] + w[1], c[2] + w[2]];
                m = m.max(dot(x, x));
            }
            return m.sqrt() / self.beta;
        }
        let mut s = f64::NEG_INFINITY;
        for g in 0..self.nf {
            let n = [self.nx[g], self.ny[g], self.nz[g]];
            let h = piece.support(rt_mul(r, n));
            s = s.max((dot(n, c) + h) / self.b[g]);
        }
        s
    }

    /// A uniformly random point of the container at size s shrunk by `margin` (rejection from the bounding
    /// box); the origin when the shrunk container is (nearly) empty.
    pub fn random_inside(&self, s: f64, margin: f64, rng: &mut crate::rng::Rng) -> [f64; 3] {
        if self.ball {
            let r = (s * self.beta - margin).max(0.0);
            loop {
                let p = [rng.range(-1.0, 1.0), rng.range(-1.0, 1.0), rng.range(-1.0, 1.0)];
                if dot(p, p) <= 1.0 {
                    return [p[0] * r, p[1] * r, p[2] * r];
                }
            }
        }
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for v in self.verts.chunks_exact(3) {
            for k in 0..3 {
                lo[k] = lo[k].min(s * v[k]);
                hi[k] = hi[k].max(s * v[k]);
            }
        }
        for _ in 0..200 {
            let p = [rng.range(lo[0], hi[0]), rng.range(lo[1], hi[1]), rng.range(lo[2], hi[2])];
            if self.size_for_ball(p, margin) <= s {
                return p;
            }
        }
        [0.0; 3]
    }
}

/// A problem the search handles.
#[derive(Clone, Debug)]
pub struct Problem {
    pub id: String,
    pub space: SpaceName,
    pub p: usize,
    pub piece: Piece,
    pub cont: Container,
    /// The problem's lower bound on s (volume bound, or the balls family's bound), true units.
    pub bound: f64,
}

impl Problem {
    /// The problem of an id: `polyhedra/<piece>in<container>/<P>` or `balls/<solid>inball/<P>`. Err for any
    /// other id (balls pieces in a ball or a solid are another engine's).
    pub fn parse(id: &str) -> Result<Problem, String> {
        if let Some(rest) = id.strip_prefix("polyhedra/") {
            let (code, p) = rest.split_once('/').ok_or_else(|| format!("{id}: not a polyhedra id"))?;
            let p: usize = p.parse().map_err(|_| format!("{id}: bad P"))?;
            if !(2..=polypack_polyhedra::POLYHEDRA_MAX_P).contains(&p) {
                return Err(format!("{id}: P out of range"));
            }
            let prob = get_problem(code).ok_or_else(|| format!("{id}: unknown polyhedra problem"))?;
            let ps = get_solid(&prob.piece)?;
            let cs = get_solid(&prob.container)?;
            let piece = Piece::new(ps);
            let cont = Container::of_solid(cs, piece.rho);
            let bound = volume_bound(&prob, p as f64)?;
            return Ok(Problem { id: id.to_string(), space: SpaceName::Polyhedra, p, piece, cont, bound });
        }
        if id.starts_with("balls/") {
            let parsed = polypack_balls::parse_balls_id(id)?;
            let prob = parsed.problem;
            if prob.piece == "ball" || prob.container != "ball" {
                return Err(format!("{id}: only solids in a ball are searched here"));
            }
            let p = parsed.p as usize;
            if !(polypack_balls::BALLS_MIN_P as usize..=polypack_balls::BALLS_MAX_P as usize).contains(&p) {
                return Err(format!("{id}: P out of range"));
            }
            let ps = get_solid(&prob.piece)?;
            let piece = Piece::new(ps);
            let cont = Container::ball(piece.rho);
            let bound = polypack_balls::balls_bound(prob, p as f64)?.value;
            return Ok(Problem { id: id.to_string(), space: SpaceName::Balls, p, piece, cont, bound });
        }
        Err(format!("{id}: not a problem of this engine"))
    }

    /// The size at which P pieces fill the container to the given density.
    pub fn size_at_density(&self, density: f64) -> f64 {
        (self.p as f64 * self.piece.volume / (density * self.cont.volume)).cbrt()
    }
}
