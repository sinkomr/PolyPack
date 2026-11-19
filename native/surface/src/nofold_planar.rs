//! Surface problems in the nofold mode on the five Platonic solids, as planar problems of one
//! face: the Auto search of the personal 2D-on-3D client.
//!
//! Faces meet only along edges, so a nofold packing is a planar packing of each face polygon, and
//! the best one puts the best k-piece packing of the face on every face: nofold(H, N, P) = min over
//! k >= ceil(P/F) of the planar value of k pieces in the face polygon. The search therefore packs
//! the fullest face with the flat solver's basin hopping and copies the result onto the faces.
//!
//! Ports, line by line:
//!  - [`pieces_per_face`], [`face_problem`] and [`surface_from_face`] of
//!    `packages/spaces/src/search/nofold.ts` (`piecesPerFace`, `faceProblem`, `surfaceFromFace`);
//!  - [`nofold_planar_auto`], of `apps/web/src/space/nofold-round.ts: runNofoldRound` (the
//!    volunteer client runs the same job), with `parseSearchProblem` and `readSpaceConfig` of
//!    `packages/spaces/src/search/model.ts` for the id and the start. The one difference is the
//!    clock: the flat solver's time budget is the seconds left before the job's deadline, and the
//!    job's stop flag is polled by a watcher thread that aborts the run.
//!
//! A face's frame is PolyPack's container frame: the regular M-gon of side s centred at the origin
//! with a horizontal bottom edge (container_phi = 0).

use crate::parts::SurfacePose;
use crate::validate::{validate_nofold, SurfaceConfig, ValidateOptions};
use polypack_flat::clock::ClockKind;
use polypack_flat::config::{evaluate_parts, EvaluateOptions};
use polypack_flat::enclose::{auto_orient, enclose};
use polypack_flat::shapes::{piece_area, Config, Pose, Problem, MAX_PIECES};
use polypack_flat::{run, Budget, Control, Method, RunOptions, Termination};
use polypack_js::math;
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// `packages/spaces/src/search/methods.ts: NOFOLD_AUTO`. The polygon method Auto runs on the face.
pub const NOFOLD_AUTO: &str = "basin_hopping";
/// `packages/spaces/src/search/methods.ts: NOFOLD_METHOD`. The name a nofold result of Auto is
/// recorded under.
pub const NOFOLD_METHOD: &str = "surface nofold: basin hopping on one face";

/// `packages/spaces/src/search/model.ts: SOLID_FACES`: the faces of each Platonic solid, as (F, M):
/// how many there are and their number of sides.
pub fn solid_faces(solid: &str) -> Option<(usize, u32)> {
    match solid {
        "tetrahedron" => Some((4, 3)),
        "cube" => Some((6, 4)),
        "octahedron" => Some((8, 3)),
        "dodecahedron" => Some((12, 5)),
        "icosahedron" => Some((20, 3)),
        _ => None,
    }
}

/// `packages/spaces/src/search/nofold.ts: NofoldProblem`: a surface problem in the nofold mode on a
/// Platonic solid.
#[derive(Clone, Debug, PartialEq)]
pub struct NofoldProblem {
    pub id: String,
    pub solid: String,
    pub n: u32,
    pub p: usize,
    /// Faces of the solid.
    pub f: usize,
    /// Sides of a face.
    pub m: u32,
}

/// `packages/spaces/src/search/model.ts: parseSearchProblem` for surface ids, then
/// `nofoldOnPolygonEngine`: `Err` for any id that is not a nofold problem of a Platonic solid.
pub fn parse_problem(id: &str) -> Result<NofoldProblem, String> {
    let bad = || format!("not a nofold surface problem of a Platonic solid: {}", id.chars().take(80).collect::<String>());
    if id.len() > 120 {
        return Err(bad());
    }
    let parts: Vec<&str> = id.split('/').collect();
    if parts.len() != 5 || parts[0] != "surface" || parts[2] != "nofold" {
        return Err(bad());
    }
    let digits = |s: &str| (1..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(parts[3]) || !digits(parts[4]) {
        return Err(bad());
    }
    let n: u32 = parts[3].parse().map_err(|_| bad())?;
    let p: usize = parts[4].parse().map_err(|_| bad())?;
    // model.ts: shape() and count()
    if !(n == 0 || (3..=100).contains(&n)) || !(1..=MAX_PIECES).contains(&p) {
        return Err(bad());
    }
    let (f, m) = solid_faces(parts[1]).ok_or_else(bad)?;
    Ok(NofoldProblem { id: id.to_string(), solid: parts[1].to_string(), n, p, f, m })
}

/// `packages/spaces/src/types.ts: SpaceConfig` of a surface problem: `{s, pieces}`, each piece
/// `{face, x, y, theta}`.
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceConfig {
    pub s: f64,
    pub pieces: Vec<SurfacePose>,
}

impl SpaceConfig {
    /// The submission's `config`.
    pub fn to_json(&self) -> Value {
        json!({
            "s": self.s,
            "pieces": self.pieces.iter().map(|q| json!({"face": q.face, "x": q.x, "y": q.y, "theta": q.theta})).collect::<Vec<_>>(),
        })
    }
}

/// `packages/spaces/src/search/model.ts: readSpaceConfig` for a surface problem: a clean copy of a
/// configuration in the problem's format, or None when it is malformed (a positive finite `s`, P
/// pieces of finite numbers with an integer face from 0 to 1000).
pub fn read_space_config(p: &NofoldProblem, v: &Value) -> Option<SpaceConfig> {
    let obj = v.as_object()?;
    let finite = |v: Option<&Value>| match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    };
    let list = obj.get("pieces")?.as_array()?;
    if list.len() != p.p {
        return None;
    }
    let mut pieces = Vec::with_capacity(list.len());
    for q in list {
        let q = q.as_object()?;
        let x = finite(q.get("x"))?;
        let y = finite(q.get("y"))?;
        let theta = finite(q.get("theta"))?;
        let face = finite(q.get("face"))?;
        if face != face.trunc() || !(0.0..=1000.0).contains(&face) {
            return None;
        }
        pieces.push(SurfacePose { face, x, y, theta });
    }
    let s = finite(obj.get("s")).filter(|s| *s > 0.0)?;
    Some(SpaceConfig { s, pieces })
}

/// The poses of each face of a start, faces in the order they first appear (a JavaScript Map).
fn poses_by_face(start: &SpaceConfig) -> Vec<(f64, Vec<Pose>)> {
    let mut by_face: Vec<(f64, Vec<Pose>)> = Vec::new();
    for q in &start.pieces {
        let pose = Pose { x: q.x, y: q.y, theta: q.theta };
        match by_face.iter_mut().find(|(f, _)| *f == q.face) {
            Some(entry) => entry.1.push(pose),
            None => by_face.push((q.face, vec![pose])),
        }
    }
    by_face
}

/// `packages/spaces/src/search/nofold.ts: piecesPerFace`. Pieces per face of the planar problem:
/// the start's fullest face, and at least ceil(P/F).
pub fn pieces_per_face(p: &NofoldProblem, start: Option<&SpaceConfig>) -> usize {
    let mut k = p.p.div_ceil(p.f);
    if let Some(start) = start {
        for (_, list) in poses_by_face(start) {
            k = k.max(list.len());
        }
    }
    k.min(p.p)
}

/// What [`face_problem`] gives.
#[derive(Clone, Debug)]
pub struct FaceProblem {
    /// The planar problem: k pieces of shape N in a regular M-gon (`p` is k).
    pub problem: Problem,
    /// A known packing of the face, from the start's fullest face, with its score.
    pub known: Option<(Config, f64)>,
    pub area_bound: f64,
}

/// `packages/spaces/src/search/nofold.ts: faceProblem`. The planar problem and, from the start's
/// fullest face, a known packing with its score.
pub fn face_problem(p: &NofoldProblem, start: Option<&SpaceConfig>) -> FaceProblem {
    let m = p.m;
    let k = pieces_per_face(p, start);
    let problem = Problem { n: p.n, m, p: k };
    // container area M s^2 / (4 tan(pi/M)) holds k pieces at most
    let area_bound = math::sqrt((4.0 * k as f64 * piece_area(p.n) * math::tan(math::PI / m as f64)) / m as f64);
    let Some(start) = start else {
        return FaceProblem { problem, known: None, area_bound };
    };
    let Some((_, full)) = poses_by_face(start).into_iter().find(|(_, list)| list.len() == k) else {
        return FaceProblem { problem, known: None, area_bound };
    };
    let e = evaluate_parts(
        problem.n,
        problem.m,
        problem.p,
        &full,
        0.0,
        &EvaluateOptions { auto_orient: true, max_overlaps: None, stop_when_invalid: false },
    );
    let config = Config { n: problem.n, m: problem.m, pieces: full, phi: 0.0 };
    match (e.valid, e.container) {
        (true, Some(c)) => FaceProblem { problem, known: Some((config, c.size)), area_bound },
        _ => FaceProblem { problem, known: None, area_bound },
    }
}

/// `packages/spaces/src/search/nofold.ts: surfaceFromFace`. The surface configuration with a planar
/// k-piece packing on every face (the last face used may hold fewer), in each face's frame. None
/// when there are too few faces for P pieces.
pub fn surface_from_face(p: &NofoldProblem, face: &Config) -> Option<SpaceConfig> {
    let k = face.pieces.len();
    if k * p.f < p.p || face.m != p.m || face.n != p.n {
        return None;
    }
    // the smallest container, as the server scores planar packings, then moved to the face frame
    let a = enclose(p.n, &face.pieces, p.m, face.phi);
    let b = auto_orient(p.n, &face.pieces, p.m, face.phi);
    let c = if b.size < a.size { b } else { a };
    let co = math::cos(-c.phi);
    let si = math::sin(-c.phi);
    let placed: Vec<Pose> = face
        .pieces
        .iter()
        .map(|q| {
            let dx = q.x - c.cx;
            let dy = q.y - c.cy;
            Pose { x: co * dx - si * dy, y: si * dx + co * dy, theta: q.theta - c.phi }
        })
        .collect();
    let pieces = (0..p.p)
        .map(|i| {
            let q = placed[i % k];
            SurfacePose { face: (i / k) as f64, x: q.x, y: q.y, theta: q.theta }
        })
        .collect();
    Some(SpaceConfig { s: c.size, pieces })
}

/// The server's check of a result (`validate` in nofold mode at PolyPack's touching tolerance, 20
/// reasons): its score, the edge `s`, when the packing is valid.
pub fn check_config(p: &NofoldProblem, config: &SpaceConfig) -> Option<f64> {
    let cfg = SurfaceConfig { solid: p.solid.clone(), n: p.n as f64, s: config.s, pieces: config.pieces.clone() };
    let opts = ValidateOptions { max_errors: 20, ..ValidateOptions::default() };
    let v = validate_nofold(&cfg, &opts);
    (v.ok && config.s.is_finite()).then_some(config.s)
}

/// Keeps `config` in `best` when it is valid and better (`consider` of runNofoldRound).
fn consider(p: &NofoldProblem, config: &SpaceConfig, best: &mut Option<(SpaceConfig, f64)>) {
    if let Some(score) = check_config(p, config) {
        if best.as_ref().map_or(true, |(_, b)| score < *b) {
            *best = Some((config.clone(), score));
        }
    }
}

/// The Auto search of a surface problem in the nofold mode on a Platonic solid
/// (`apps/web/src/space/nofold-round.ts: runNofoldRound`): basin hopping on the planar problem of
/// the fullest face, from the face of the start, copied onto every face. Like the TypeScript it
/// checks the start and the strict result with the validator and returns the better one.
///
/// `Err` for an id that is not a nofold problem of a Platonic solid. A start that is not a
/// configuration of the problem gives an `error:` result, as in the TypeScript.
pub fn nofold_planar_auto(job: &AutoJob) -> Result<AutoResult, String> {
    let p = parse_problem(job.id)?;
    let method = NOFOLD_METHOD.to_string();
    let start = match job.start {
        None => None,
        Some(v) => match read_space_config(&p, v) {
            Some(s) => Some(s),
            None => {
                return Ok(AutoResult {
                    config: None,
                    score: None,
                    evaluations: 0,
                    stopped: "error: the start is not a configuration of this problem".to_string(),
                    method,
                })
            }
        },
    };
    // the best valid configuration: the start, then the search's result
    let mut best: Option<(SpaceConfig, f64)> = None;
    if let Some(s) = &start {
        consider(&p, s, &mut best);
    }
    let face = face_problem(&p, start.as_ref());
    let control = Control::default();
    let done = AtomicBool::new(false);
    let seconds = job.deadline.saturating_duration_since(std::time::Instant::now()).as_secs_f64();
    let result = std::thread::scope(|scope| {
        // the job's stop flag and deadline end the run through the flat solver's abort
        let watcher = scope.spawn(|| {
            while !done.load(Ordering::Relaxed) {
                if job.should_stop() {
                    control.aborted.store(true, Ordering::Relaxed);
                    break;
                }
                std::thread::park_timeout(Duration::from_millis(5));
            }
        });
        let r = run(
            face.problem,
            RunOptions {
                method: Method::BasinHopping,
                params: Value::Null,
                start: face.known.as_ref().map(|(c, _)| c.clone()),
                budget: Budget { evals: job.max_evals, time_s: Some(seconds) },
                seed: job.seed,
                final_polish: true,
                control: &control,
                clock: ClockKind::Wall,
            },
        );
        done.store(true, Ordering::Relaxed);
        watcher.thread().unpark();
        r
    });
    // only a strict result: one that does not rely on the validity tolerance
    if result.valid && result.strict {
        if let Some(face) = &result.best {
            if let Some(config) = surface_from_face(&p, face) {
                consider(&p, &config, &mut best);
            }
        }
    }
    let stopped = if result.termination == Termination::Error {
        format!("error: {}", result.reasons.first().cloned().unwrap_or_else(|| "the search failed".to_string()))
    } else if job.stop.load(Ordering::Relaxed) || result.termination == Termination::Aborted {
        "stop".to_string()
    } else if result.termination == Termination::Evals || (result.termination == Termination::Completed && job.max_evals.is_some()) {
        "evals".to_string()
    } else {
        "time".to_string()
    };
    Ok(AutoResult {
        config: best.as_ref().map(|(c, _)| c.to_json()),
        score: best.as_ref().map(|(_, s)| *s),
        evaluations: result.evaluations,
        stopped,
        method,
    })
}
