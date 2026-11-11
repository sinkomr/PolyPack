//! The domain of a space: the problems it has, defined by parameter ranges (which pieces or
//! containers, which P) rather than by an enumerated catalogue or by its records. Port of what the
//! server reaches of packages/spaces/src/domain.ts (`SPACE_DOMAINS`, `domainMaxP`) and of
//! `impossibleReason`.
//!
//! A space with a domain has problems without a research record (status `no_record`): any id of
//! the domain is a problem, answered with its lower bound, open to entries; its research records,
//! where they exist, are stored as before (records.rs) and take precedence.
//!
//! The interface, for each space (`space_domain`):
//!  - `info`: what /api/spaces says about the domain (`SpaceDomainInfo`): the id pattern, its fields
//!    (a list of values, or a range of integers) and how many problems it holds. It is kept as the
//!    JSON it is sent as, key for key in the order each package's source writes its object;
//!  - `bound(id)`: the lower bound of a problem of the domain (`Some(None)` when it has none), or
//!    `None` (the source's `undefined`) when the id is the space's but lies outside the domain. Ids
//!    are first read by `parse_space_id`;
//!  - `sample(limit)`: at most `limit` ids of the domain in a fixed order.
//!
//! `withJoined`, `splitJoined` and `domainId` of the source are the board's (apps/web); the
//! server's bundle does not keep them and they are not ported.

use crate::ids::ParsedSpaceId;
use crate::piece_domains::{curved_domain, sphere_domain, torus_domain};
use crate::types::{Bound, SpaceName, SPACE_NAMES};
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;

/// What a domain's `menu` answers: the values or the range a field of the board's picker offers.
#[derive(Clone, Debug, PartialEq)]
pub enum DomainMenu {
    /// `{ values }`
    Values(Vec<String>),
    /// `{ range: [min, max] }`
    Range(f64, f64),
}

/// A domain's `menu`: the key of a field and the values chosen before it, by key.
type MenuFn = fn(&str, &[(String, String)]) -> Option<DomainMenu>;

/// domain.ts: `SpaceDomain`.
pub struct SpaceDomain {
    /// domain.ts: `SpaceDomainInfo`, as the JSON /api/spaces sends.
    pub info: Value,
    pub(crate) bound: fn(&ParsedSpaceId) -> Option<Option<Bound>>,
    pub(crate) sample: fn(usize) -> Vec<String>,
    pub(crate) menu: Option<MenuFn>,
    pub(crate) impossible: Option<fn(&ParsedSpaceId) -> Option<String>>,
}

impl SpaceDomain {
    /// The lower bound of a problem of the domain (`Some(None)`: none known), or `None` when `id`
    /// is outside the domain (the source's `undefined`).
    pub fn bound(&self, id: &ParsedSpaceId) -> Option<Option<Bound>> {
        (self.bound)(id)
    }

    /// At most `limit` ids of the domain, in a fixed order (that of the volunteers' work list,
    /// removed 2026-10-29).
    pub fn sample(&self, limit: usize) -> Vec<String> {
        (self.sample)(limit)
    }

    /// The values or range a field of the board's picker offers, given the values chosen in the
    /// fields before it (by key), or None for the field's own. Only the curved domain has one.
    pub fn menu(&self, key: &str, chosen: &[(String, String)]) -> Option<DomainMenu> {
        self.menu.and_then(|f| f(key, chosen))
    }

    /// A plain sentence saying why the id, which is inside the domain's ranges, cannot be a problem
    /// (no bound), or None. Only the curved domain has one.
    pub fn impossible(&self, id: &ParsedSpaceId) -> Option<String> {
        self.impossible.and_then(|f| f(id))
    }

    /// `info.problems`: how many problems the domain holds.
    pub fn problems(&self) -> f64 {
        self.info.get("problems").and_then(Value::as_f64).unwrap_or(f64::NAN)
    }
}

/// A family crate's description of its domain as the JSON it is sent as: its own serializer writes
/// the keys in the source's order, and serde_json keeps them (`preserve_order`).
fn info_json<T: Serialize>(info: &T) -> Value {
    serde_json::to_value(info).expect("a domain's description is JSON")
}

fn bound_of(value: f64, label: String) -> Option<Option<Bound>> {
    Some(Some(Bound { value, label }))
}

// The domains of the families, each read from the id's fields as its source reads them.

fn polyhedra_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    let b = polypack_polyhedra::polyhedra_domain_bound(&id.fields.js_string("code"), id.p as f64)?;
    bound_of(b.value, b.label)
}

fn balls_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    let b = polypack_balls::balls_domain_bound(&id.fields.js_string("code"), id.p as f64)?;
    bound_of(b.value, b.label)
}

fn ndim_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    // `Number(id.fields.d)`: a dimension that is not a whole number names no shapes
    let d = id.fields.get("d").map_or(f64::NAN, |f| f.js_number());
    if !(d >= 0.0 && d == d.trunc() && d <= u32::MAX as f64) {
        return None;
    }
    let b = polypack_ndim::space::ndim_domain_bound(d as u32, &id.fields.js_string("piece"), &id.fields.js_string("container"), id.p)?;
    bound_of(b.value, b.label)
}

fn surface_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    // inDomain asks that solid and mode are strings and N a number
    let (solid, mode, n) = (id.fields.get("solid")?.as_text()?, id.fields.get("mode")?.as_text()?, id.fields.get("N")?.as_number()?);
    let b = polypack_surface::domain_bound(solid, mode, n, id.p as f64)?;
    bound_of(b.value, b.label)
}

fn boundary_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    let (polytope, piece) = (id.fields.get("polytope")?.as_text()?, id.fields.get("piece")?.as_text()?);
    let b = polypack_boundary::boundary_domain_bound(polytope, piece, id.p as f64)?;
    bound_of(b.value, b.label)
}

fn boundary_sample(limit: usize) -> Vec<String> {
    polypack_boundary::boundary_domain_sample(limit as f64)
}

/// domain.ts: `SPACE_DOMAINS`, in the order of `SPACE_NAMES`. Built once and read from any thread.
static SPACE_DOMAINS: LazyLock<[SpaceDomain; 8]> = LazyLock::new(|| {
    SPACE_NAMES.map(|space| match space {
        // 2D on 3D, polyhedral surfaces: 141 solids, fold and nofold, N = 0 and 3 to 100, P = 1 to 100; records
        // for the Platonic solids with N in {0, 3, 4, 5, 6, 8} (docs/spaces/SURFACE.md)
        SpaceName::Surface => SpaceDomain {
            info: info_json(&polypack_surface::domain_info()),
            bound: surface_bound,
            sample: polypack_surface::domain_sample,
            menu: None,
            impossible: None,
        },
        SpaceName::Curved => curved_domain(),
        SpaceName::Sphere => sphere_domain(),
        SpaceName::Torus => torus_domain(),
        // 3D on 4D, polytope boundaries (docs/spaces/BOUNDARY.md)
        SpaceName::Boundary => SpaceDomain {
            info: info_json(&polypack_boundary::boundary_domain_info()),
            bound: boundary_bound,
            sample: boundary_sample,
            menu: None,
            impossible: None,
        },
        // 3D in 3D, polyhedra: every ordered pair of the 186 solids, P = 2 to 500; records for 150 pairs, through P = 100
        SpaceName::Polyhedra => SpaceDomain {
            info: info_json(&polypack_polyhedra::polyhedra_domain_info()),
            bound: polyhedra_bound,
            sample: polypack_polyhedra::polyhedra_domain_sample,
            menu: None,
            impossible: None,
        },
        // 3D in 3D, balls: P = 2 to 100, without records (docs/spaces/BALLS.md)
        SpaceName::Balls => SpaceDomain {
            info: info_json(&polypack_balls::balls_domain_info()),
            bound: balls_bound,
            sample: polypack_balls::balls_domain_sample,
            menu: None,
            impossible: None,
        },
        // nD in nD, d = 4 to 10: every ordered pair of the dimension's polytopes and the ball, P = 2 to 40 / 32 / 24 / 20;
        // records for the regular polytopes in 4D to 6D (docs/spaces/NDIM.md)
        SpaceName::Ndim => SpaceDomain {
            info: info_json(&polypack_ndim::space::ndim_domain_info()),
            bound: ndim_bound,
            sample: polypack_ndim::space::ndim_domain_sample,
            menu: None,
            impossible: None,
        },
    })
});

/// domain.ts: `SPACE_DOMAINS[space]`. The domain of a space; every space has one.
pub fn space_domain(space: SpaceName) -> Option<&'static SpaceDomain> {
    Some(&SPACE_DOMAINS[space.index()])
}

/// domain.ts: `impossibleReason`. Why an id of a space's domain cannot be a problem (the domain's
/// `impossible`), or None.
pub fn impossible_reason(space: SpaceName, parsed: &ParsedSpaceId) -> Option<String> {
    space_domain(space)?.impossible(parsed)
}

/// domain.ts: `domainMaxP`. The largest P of a domain (its field P's range), or 0.
pub fn domain_max_p(d: &SpaceDomain) -> f64 {
    let fields = d.info.get("fields").and_then(Value::as_array);
    let f = fields.and_then(|list| list.iter().find(|x| x.get("key").and_then(Value::as_str) == Some("P")));
    f.and_then(|f| f.get("max")).and_then(Value::as_f64).unwrap_or(0.0)
}
