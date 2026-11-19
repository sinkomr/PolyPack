//! The searches of the kinds beyond Flat: each space's Auto search, called through the
//! `SpaceSearcher` trait. The calls are behind the `real-search` feature (on by default), because
//! the functions come from the ports of the spaces' Auto searches in their crates:
//!
//!   surface, nofold, Platonic solid   polypack_surface::nofold_planar::nofold_planar_auto
//!                                     (the planar problem of one face; the TypeScript client runs
//!                                     the polygon engine there)
//!   surface, any other                polypack_surface::surface_auto::surface_auto
//!   curved                            polypack_curved::auto::auto_search
//!   sphere                            polypack_sphere::auto::auto_search
//!   torus                             polypack_torus::auto::auto_search
//!
//! Each has the signature `polypack_spaceauto::AutoSearch`. Which one a problem goes to is `route`,
//! which does not need the feature.

use crate::space_engine::SpaceSearcher;
use polypack_spaces::surface_platonic;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Curved,
    Sphere,
    Torus,
    /// surface/<solid>/fold/N/P, and surface/<solid>/nofold/N/P of a solid that is not Platonic.
    SurfaceAuto,
    /// surface/<Platonic solid>/nofold/N/P.
    NofoldPlanar,
}

/// Which search a problem id goes to; Err for an id of no 2D-on-3D space.
pub fn route(space: &str, id: &str) -> Result<Route, String> {
    let parts: Vec<&str> = id.split('/').collect();
    if parts.first() != Some(&space) {
        return Err(format!("{id} is not a {space} problem"));
    }
    match space {
        "curved" => Ok(Route::Curved),
        "sphere" => Ok(Route::Sphere),
        "torus" => Ok(Route::Torus),
        "surface" => {
            let (solid, mode) = (parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""));
            if mode == "nofold" && surface_platonic().iter().any(|s| s == solid) {
                Ok(Route::NofoldPlanar)
            } else {
                Ok(Route::SurfaceAuto)
            }
        }
        other => Err(format!("this client has no search for {other} yet")),
    }
}

/// The searcher the client runs: every kind's own search; Err when this build has none.
pub fn searcher() -> Result<Arc<dyn SpaceSearcher>, String> {
    #[cfg(feature = "real-search")]
    {
        Ok(Arc::new(real::RealSearcher))
    }
    #[cfg(not(feature = "real-search"))]
    {
        Err("this build has no searches for the other kinds (it was built without the real-search feature)".into())
    }
}

#[cfg(feature = "real-search")]
mod real {
    use super::{route, Route};
    use crate::space_engine::SpaceSearcher;
    use polypack_spaceauto::{AutoJob, AutoResult, AutoSearch};

    pub struct RealSearcher;

    fn function(r: Route) -> AutoSearch {
        match r {
            Route::Curved => polypack_curved::auto::auto_search,
            Route::Sphere => polypack_sphere::auto::auto_search,
            Route::Torus => polypack_torus::auto::auto_search,
            Route::SurfaceAuto => polypack_surface::surface_auto::surface_auto,
            Route::NofoldPlanar => polypack_surface::nofold_planar::nofold_planar_auto,
        }
    }

    impl SpaceSearcher for RealSearcher {
        fn search(&self, space: &str, job: &AutoJob) -> Result<AutoResult, String> {
            function(route(space, job.id)?)(job)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes() {
        assert_eq!(route("sphere", "sphere/4/12"), Ok(Route::Sphere));
        assert_eq!(route("torus", "torus/hex/5/8"), Ok(Route::Torus));
        assert_eq!(route("surface", "surface/cube/fold/4/12"), Ok(Route::SurfaceAuto));
        for solid in ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"] {
            assert_eq!(route("surface", &format!("surface/{solid}/nofold/0/3")), Ok(Route::NofoldPlanar), "{solid}");
            assert_eq!(route("surface", &format!("surface/{solid}/fold/0/3")), Ok(Route::SurfaceAuto), "{solid}");
        }
        assert_eq!(route("surface", "surface/snub_cube/nofold/4/3"), Ok(Route::SurfaceAuto));
        assert_eq!(route("surface", "surface/prism3/nofold/4/3"), Ok(Route::SurfaceAuto));
        assert!(route("sphere", "torus/sq/4/3").is_err());
        assert_eq!(route("curved", "curved/1/3/4/2"), Ok(Route::Curved));
        assert!(route("curved", "sphere/4/3").is_err());
    }
}
