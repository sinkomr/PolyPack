//! The problems of the balls family with their geometry: the lower bounds of the score and the family's domain.
//! Port of what the server reaches of `packages/balls/src/problems.ts`.
//!
//! Units: balls have radius BALL_RADIUS = 1/2, diameter 1 (catalogue.rs); solids have the polyhedra family's
//! canonical size (edge 1 for the Platonic, Archimedean, prism and antiprism solids). The container is s times
//! the canonical container, centred at the origin: the ball of diameter s (radius s / 2), or the canonical solid
//! scaled by s (the cube [-s/2, s/2]^3 with its faces normal to the axes). The score is s: the container ball's
//! diameter, or the scale of the solid (the cube's edge). A ball of radius r lies in s C iff its centre has
//! N_f . c <= s b_f - r for every face f (container.rs).

use crate::catalogue::{
    ball_container_score, balls_problem_of, format_balls_id, BallsProblem, BALLS_MAX_P, BALLS_MIN_P,
    BALLS_ORIGINAL_CODES, BALLS_PROBLEMS, BALL_DIAMETER, BALL_RADIUS,
};
use crate::container::{container_kind, container_of_problem, ContainerKind};
use crate::extent::enclosing_radius;
use polypack_js::{fmt, math};
use polypack_polyhedra::catalogue::{plural_title, solid_by_name};
use polypack_polyhedra::domain::{DomainBound, DomainField, DomainInfo, Record};
use polypack_polyhedra::get_solid;

/// `problems.ts: TITLES.get(name)`: the title of a solid of the polyhedra catalogue.
fn title_of(name: &str) -> Option<&'static str> {
    solid_by_name(name).map(|s| s.title.as_str())
}

/// `problems.ts: pluralOf`: the pieces' name in the plural: "balls", "tetrahedra", "triangular prisms of height
/// 1.5".
pub fn plural_of(piece: &str) -> String {
    if piece == "ball" {
        "balls".to_string()
    } else {
        plural_title(title_of(piece).unwrap_or(piece))
    }
}

/// `problems.ts: getBallsProblem`: the problem of a code, or None.
pub fn get_balls_problem(code: &str) -> Option<&'static BallsProblem> {
    balls_problem_of(code)
}

/// `problems.ts: pieceVolume`: volume of one piece: 4 pi r^3 / 3 for a ball of radius r = BALL_RADIUS.
pub fn piece_volume(problem: &BallsProblem) -> Result<f64, String> {
    if problem.piece == "ball" {
        Ok((4.0 * math::PI * math::powi(BALL_RADIUS, 3)) / 3.0)
    } else {
        Ok(get_solid(&problem.piece)?.volume)
    }
}

/// `problems.ts: BallsBound`.
#[derive(Clone, Debug, PartialEq)]
pub struct BallsBound {
    pub value: f64,
    /// "volume", "two-piece" or "one piece": which of the bounds is the largest (a listing says "two piece bound").
    pub kind: &'static str,
    /// What it rests on, with its label.
    pub label: String,
}

/// `problems.ts: ballsBound`: the best of these lower bounds on s, each elementary [EST]. A ball container is
/// scored by its diameter s = 2 rho, rho its radius: the bounds below are on rho (rho = s / 2), converted once at
/// the end of the function:
///  - volume: P pieces of volume v fit only if the container's volume is at least P v: s >= (3 P v / (4 pi))^(1/3)
///    for a ball container, s >= (P v / V)^(1/3) for the canonical solid of volume V (the cube has V = 1);
///  - one piece: a ball container holds a solid only if rho >= the radius of the solid's smallest enclosing ball
///    (its circumradius for the first 94 solids, whose vertex centroid is that ball's centre; extent.rs for the
///    Johnson solids); a solid container s C holds a ball of radius r only if s >= r / rho, rho the radius of the
///    largest ball in C (C's inradius for the first 94 solids; its Chebyshev radius for the Johnson solids);
///  - two pieces (P >= 2): two disjoint balls of radius r have centres at least 2 r apart, inside the container
///    shrunk by r: the ball of radius rho - r (rho >= 2 r), or, for a solid C with all faces at its inradius rho
///    (the tangential solids, among them the cube), the solid (s - r / rho) C, whose diameter is (s - r / rho) D,
///    so s >= r / rho + 2 r / D; for any C the shrunk container's width in each direction is the container's less
///    2 r (its support function is the container's less r on each side), so a pair of centres 2 r apart needs a
///    direction of width 4 r in s C: s >= 4 r / D. Two disjoint solids contain disjoint balls of their inradius r,
///    so a ball container has rho >= 2 r.
///
/// `p` is the number of pieces as the number it is in the source. `Err` (the source throws) for a problem whose
/// solid is not in the table.
pub fn balls_bound(problem: &BallsProblem, p: f64) -> Result<BallsBound, String> {
    let v = piece_volume(problem)?;
    let kind = container_kind(problem);
    let c = if kind == ContainerKind::Polyhedron { container_of_problem(problem)? } else { None };
    let volume = if kind == ContainerKind::Ball {
        math::cbrt((3.0 * p * v) / (4.0 * math::PI))
    } else if let Some(c) = &c {
        math::cbrt((p * v) / c.volume)
    } else {
        math::cbrt(p * v)
    };
    let mut cands: Vec<BallsBound> = vec![BallsBound {
        value: volume,
        kind: "volume",
        label: format!(
            "[EST] the pieces' total volume {} x {} is at most the container's",
            fmt::num(p),
            fmt::precision(v, 6)
        ),
    }];
    let r = BALL_RADIUS;
    let d = fmt::num(BALL_DIAMETER);
    if problem.piece == "ball" {
        if kind == ContainerKind::Ball {
            cands.push(BallsBound {
                value: r,
                kind: "one piece",
                label: format!("[EST] a ball of diameter {d} needs a container of diameter s >= {d}"),
            });
            if p >= 2.0 {
                cands.push(BallsBound {
                    value: BALL_DIAMETER,
                    kind: "two-piece",
                    label: format!(
                        "[EST] two balls of diameter {d} have centres at least {d} apart in the ball of radius s / 2 - {}, so s / 2 >= {d} and s >= {}",
                        fmt::num(r),
                        fmt::num(2.0 * BALL_DIAMETER)
                    ),
                });
            }
        } else if kind == ContainerKind::Cube {
            cands.push(BallsBound {
                value: BALL_DIAMETER,
                kind: "one piece",
                label: format!("[EST] a ball of diameter {d} needs an edge s >= {d}"),
            });
            if p >= 2.0 {
                cands.push(BallsBound {
                    value: BALL_DIAMETER + BALL_DIAMETER / 3.0f64.sqrt(),
                    kind: "two-piece",
                    label: format!(
                        "[EST] two balls of diameter {d} have centres at least {d} apart in the cube of edge s - {d}, whose diameter is (s - {d}) sqrt 3, so s >= {d} + {d} / sqrt 3"
                    ),
                });
            }
        } else {
            let c = c.as_ref().expect("a polyhedron container has its geometry");
            let title = title_of(&problem.container).unwrap_or(&problem.container);
            cands.push(BallsBound {
                value: r / c.chebyshev,
                kind: "one piece",
                label: format!(
                    "[EST] a ball of diameter {d} needs a scale s >= {} / {}, the inradius of the {title}",
                    fmt::num(r),
                    fmt::precision(c.chebyshev, 7)
                ),
            });
            if p >= 2.0 {
                if c.tangential {
                    cands.push(BallsBound {
                        value: r / c.inradius + BALL_DIAMETER / c.diameter,
                        kind: "two-piece",
                        label: format!(
                            "[EST] two balls of diameter {d} have centres at least {d} apart in the {title} of scale s - {} / {}, whose diameter is that times {}",
                            fmt::num(r),
                            fmt::precision(c.inradius, 7),
                            fmt::precision(c.diameter, 7)
                        ),
                    });
                }
                cands.push(BallsBound {
                    value: (2.0 * BALL_DIAMETER) / c.diameter,
                    kind: "two-piece",
                    label: format!(
                        "[EST] two balls of diameter {d} have centres {d} apart in a container shrunk by {}, whose width in each direction is the {title}'s less {d}, so s times its diameter {} is at least {}",
                        fmt::num(r),
                        fmt::precision(c.diameter, 7),
                        fmt::num(2.0 * BALL_DIAMETER)
                    ),
                });
            }
        }
    } else {
        let s = get_solid(&problem.piece)?;
        cands.push(BallsBound {
            value: enclosing_radius(s),
            kind: "one piece",
            label: format!(
                "[EST] a {} needs a ball of radius at least its circumradius {}, so a diameter s of at least twice that",
                s.title,
                fmt::precision(enclosing_radius(s), 7)
            ),
        });
        if p >= 2.0 {
            cands.push(BallsBound {
                value: 2.0 * s.inradius,
                kind: "two-piece",
                label: format!(
                    "[EST] two {} contain disjoint balls of their inradius {}, so s >= twice that",
                    plural_of(&problem.piece),
                    fmt::precision(s.inradius, 7)
                ),
            });
        }
    }
    // a ball container is scored by its diameter: the bounds on its radius are converted once, here
    if kind == ContainerKind::Ball {
        for c in cands.iter_mut() {
            c.value = ball_container_score(c.value);
        }
    }
    // cands.reduce((a, b) => (b.value > a.value ? b : a))
    let mut it = cands.into_iter();
    let mut best = it.next().expect("the volume bound");
    for b in it {
        if b.value > best.value {
            best = b;
        }
    }
    Ok(best)
}

/// `problems.ts: ballsDomain.info`: the 373 codes and P = BALLS_MIN_P to BALLS_MAX_P. The board's menu groups
/// the codes (BallsProblem.group).
pub fn balls_domain_info() -> DomainInfo {
    DomainInfo {
        id: "balls/<code>/<P>".to_string(),
        fields: vec![
            DomainField {
                key: "code".to_string(),
                label: "Problem".to_string(),
                values: Some(BALLS_PROBLEMS.iter().map(|p| p.code.clone()).collect()),
                titles: Some(Record::from_entries(BALLS_PROBLEMS.iter().map(|p| (p.code.clone(), p.title.clone())))),
                groups: Some(Record::from_entries(BALLS_PROBLEMS.iter().map(|p| (p.code.clone(), p.group.clone())))),
                min: None,
                max: None,
            },
            DomainField {
                key: "P".to_string(),
                label: "Pieces (P)".to_string(),
                values: None,
                titles: None,
                groups: None,
                min: Some(BALLS_MIN_P as u64),
                max: Some(BALLS_MAX_P as u64),
            },
        ],
        joined: None,
        problems: (BALLS_PROBLEMS.len() as u64) * ((BALLS_MAX_P - BALLS_MIN_P + 1) as u64),
    }
}

/// `problems.ts: ballsDomain.bound`: each problem with its elementary bound as a listing shows it ("volume bound;
/// [EST] ..."), or None when the code names no problem or P is outside BALLS_MIN_P to BALLS_MAX_P (the source's
/// `undefined`). `p` is the id's P as the number it is in the source.
pub fn balls_domain_bound(code: &str, p: f64) -> Option<DomainBound> {
    let problem = balls_problem_of(code)?;
    if !(p >= BALLS_MIN_P as f64 && p <= BALLS_MAX_P as f64) {
        return None;
    }
    let b = balls_bound(problem, p).ok()?;
    // b.kind.replace("-", " "): the first hyphen
    Some(DomainBound { value: b.value, label: format!("{} bound; {}", b.kind.replacen('-', " ", 1), b.label) })
}

/// `problems.ts: ballsDomain.sample`: small P first, the family's first 7 codes (BALLS_ORIGINAL_CODES) in their
/// first order, as the volunteers' work list offered them until it was removed on 2026-10-29.
pub fn balls_domain_sample(limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut p = BALLS_MIN_P;
    while p <= BALLS_MAX_P && out.len() < limit {
        for code in BALLS_ORIGINAL_CODES {
            if out.len() < limit {
                out.push(format_balls_id(code, p));
            }
        }
        p += 1;
    }
    out
}
