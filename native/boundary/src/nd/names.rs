//! The simplex, orthoplex and demicube as containers of the boundary space for d = 5..10 ("4D on
//! 5D" to "9D on 10D", docs/spaces/BOUNDARY.md section 4D): names and sizes.
//! Port of packages/boundary/src/nd/names.ts.
//!
//! A container name is `<d><family>`: "5simplex" .. "10simplex", "5orthoplex" .. "10orthoplex",
//! "5demicube" .. "10demicube". The d-cubes of section 4B keep their names ("5cube" .. "10cube");
//! with these, every dimension d = 5..10 has four containers.

/// packages/boundary/src/nd/names.ts: ND_FAMILIES
pub const ND_FAMILIES: [&str; 3] = ["simplex", "orthoplex", "demicube"];
/// packages/boundary/src/nd/names.ts: ND_DIMS
pub const ND_DIMS: [usize; 6] = [5, 6, 7, 8, 9, 10];

/// The 18 container names, simplex first, then orthoplex, then demicube, each by d.
/// packages/boundary/src/nd/names.ts: ND_NAMES
pub const ND_NAMES: [&str; 18] = [
    "5simplex", "6simplex", "7simplex", "8simplex", "9simplex", "10simplex",
    "5orthoplex", "6orthoplex", "7orthoplex", "8orthoplex", "9orthoplex", "10orthoplex",
    "5demicube", "6demicube", "7demicube", "8demicube", "9demicube", "10demicube",
];

/// packages/boundary/src/nd/names.ts: NDFamily
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NdFamily {
    Simplex,
    Orthoplex,
    Demicube,
}

impl NdFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            NdFamily::Simplex => "simplex",
            NdFamily::Orthoplex => "orthoplex",
            NdFamily::Demicube => "demicube",
        }
    }
}

/// The family and ambient dimension of a name, or None when it is none of the 18
/// (the source's /^(5|6|7|8|9|10)(simplex|orthoplex|demicube)$/).
/// packages/boundary/src/nd/names.ts: ndParse
pub fn nd_parse(name: &str) -> Option<(NdFamily, usize)> {
    for (family, text) in [(NdFamily::Simplex, "simplex"), (NdFamily::Orthoplex, "orthoplex"), (NdFamily::Demicube, "demicube")] {
        if let Some(d) = name.strip_suffix(text) {
            return match d {
                "5" => Some((family, 5)),
                "6" => Some((family, 6)),
                "7" => Some((family, 7)),
                "8" => Some((family, 8)),
                "9" => Some((family, 9)),
                "10" => Some((family, 10)),
                _ => None,
            };
        }
    }
    None
}

/// packages/boundary/src/nd/names.ts: isNDName
pub fn is_nd_name(x: &str) -> bool {
    nd_parse(x).is_some()
}

/// The ambient dimension d of an nD container name, or 0.
/// packages/boundary/src/nd/names.ts: ndDim
pub fn nd_dim(name: &str) -> usize {
    nd_parse(name).map_or(0, |p| p.1)
}

/// Number of cells (facets) of the container.
/// packages/boundary/src/nd/names.ts: ndCellCount
pub fn nd_cell_count(family: NdFamily, d: usize) -> usize {
    match family {
        NdFamily::Simplex => d + 1,
        NdFamily::Orthoplex => 1 << d,
        NdFamily::Demicube => 2 * d + (1 << (d - 1)),
    }
}

/// Pieces: balls only. packages/boundary/src/nd/names.ts: ND_PIECES
pub const ND_PIECES: [&str; 1] = ["ball"];

/// The shape of a configuration on any container of dimension d >= 5.
/// packages/boundary/src/nd/names.ts: highDimShape's result
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HighDimShape {
    pub cells: usize,
    pub dim_u: usize,
}

/// The shape of a configuration on any container of dimension d >= 5, for the registries that read
/// configurations: the number of cells and the number of local coordinates per piece (none of these
/// containers takes rotations). None for the 4-polytopes and unknown names. The d-cubes' names are
/// those of ncube/lattice.rs ("5cube".."10cube").
/// packages/boundary/src/nd/names.ts: highDimShape
pub fn high_dim_shape(name: &str) -> Option<HighDimShape> {
    if let Some((family, d)) = nd_parse(name) {
        return Some(HighDimShape { cells: nd_cell_count(family, d), dim_u: d - 1 });
    }
    // /^(5|6|7|8|9|10)cube$/
    let d: usize = match name.strip_suffix("cube")? {
        "5" => 5,
        "6" => 6,
        "7" => 7,
        "8" => 8,
        "9" => 9,
        "10" => 10,
        _ => return None,
    };
    Some(HighDimShape { cells: 2 * d, dim_u: d - 1 })
}

/// The most pieces of each container's problem set. P = 1..24 for every container: the work caps
/// (ND_MAX_WORK) refuse a check that needs more, they do not shorten the range.
/// packages/boundary/src/nd/names.ts: ND_MAX_P
pub const ND_MAX_P: usize = 24;

/// The title of a container (the problem picker's): "7-demicube".
/// packages/boundary/src/nd/names.ts: ND_TITLES
pub fn nd_title(name: &str) -> Option<String> {
    nd_parse(name).map(|(family, d)| format!("{d}-{}", family.as_str()))
}
