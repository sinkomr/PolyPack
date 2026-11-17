//! The Auto search of nofold surface problems on the Platonic solids (src/nofold_planar.rs).
//!
//! The fixtures nofold_planar_convert.jsonl and nofold_planar_search.jsonl were written by
//! `native/tools/nofold-planar-ref.mts` from packages/spaces/src/search/nofold.ts and the
//! polygon solver (packages/solver), under Node 22. The conversion functions must give the
//! TypeScript's doubles exactly; the searches are budgeted by evaluations, so their results are
//! reproducible from the seed, and must reach the TypeScript's score.

use polypack_flat::shapes::{Config, Pose};
use polypack_spaceauto::{AutoJob, AutoResult};
use polypack_surface::nofold_planar::{
    check_config, face_problem, nofold_planar_auto, parse_problem, pieces_per_face, read_space_config, surface_from_face,
    SpaceConfig, NOFOLD_METHOD,
};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn lines(name: &str) -> Vec<Value> {
    let path = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// The same double, up to the sign of a zero (JSON writes -0 as 0).
fn same(a: f64, b: f64) -> bool {
    (a + 0.0).to_bits() == (b + 0.0).to_bits()
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn poses(v: &Value) -> Vec<Pose> {
    v.as_array().unwrap().iter().map(|q| Pose { x: f(&q["x"]), y: f(&q["y"]), theta: f(&q["theta"]) }).collect()
}

fn same_poses(a: &[Pose], b: &[Pose]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(p, q)| same(p.x, q.x) && same(p.y, q.y) && same(p.theta, q.theta))
}

fn start_of(v: &Value, id: &str) -> Option<SpaceConfig> {
    if v.is_null() {
        return None;
    }
    Some(read_space_config(&parse_problem(id).unwrap(), v).expect("a start the reader accepts"))
}

fn same_config(got: &SpaceConfig, want: &Value) -> bool {
    let pieces = want["pieces"].as_array().unwrap();
    same(got.s, f(&want["s"]))
        && got.pieces.len() == pieces.len()
        && got.pieces.iter().zip(pieces).all(|(q, w)| {
            same(q.face, f(&w["face"])) && same(q.x, f(&w["x"])) && same(q.y, f(&w["y"])) && same(q.theta, f(&w["theta"]))
        })
}

#[test]
fn the_face_problem_is_the_typescripts() {
    let cases = lines("nofold_planar_convert.jsonl");
    let mut faces = 0;
    let mut knowns = 0;
    for c in cases.iter().filter(|c| c["kind"] == "face") {
        let id = c["id"].as_str().unwrap();
        let p = parse_problem(id).unwrap();
        let start = start_of(&c["start"], id);
        assert_eq!(pieces_per_face(&p, start.as_ref()), c["k"].as_u64().unwrap() as usize, "{id}: piecesPerFace");
        let fp = face_problem(&p, start.as_ref());
        let want = &c["problem"];
        assert_eq!(
            (fp.problem.n as u64, fp.problem.m as u64, fp.problem.p as u64),
            (want["N"].as_u64().unwrap(), want["M"].as_u64().unwrap(), want["P"].as_u64().unwrap()),
            "{id}: problem"
        );
        assert!(same(fp.area_bound, f(&c["areaBound"])), "{id}: areaBound {} / {}", fp.area_bound, c["areaBound"]);
        match (&fp.known, &c["known"]) {
            (None, Value::Null) => {}
            (Some((config, score)), known) if !known.is_null() => {
                assert!(same_poses(&config.pieces, &poses(&known["pieces"])), "{id}: known pieces");
                assert_eq!(config.phi, 0.0);
                assert!(same(*score, f(&known["score"])), "{id}: known score {score} / {}", known["score"]);
                knowns += 1;
            }
            (got, want) => panic!("{id}: known {:?} / {want}", got.as_ref().map(|k| k.1)),
        }
        faces += 1;
    }
    assert!(faces >= 20 && knowns >= 8, "{faces} cases, {knowns} with a known packing");
}

#[test]
fn the_surface_configuration_is_the_typescripts() {
    let cases = lines("nofold_planar_convert.jsonl");
    let mut made = 0;
    let mut refused = 0;
    for c in cases.iter().filter(|c| c["kind"] == "surface") {
        let id = c["id"].as_str().unwrap();
        let p = parse_problem(id).unwrap();
        let w = &c["face"];
        let face = Config {
            n: w["N"].as_u64().unwrap() as u32,
            m: w["M"].as_u64().unwrap() as u32,
            pieces: poses(&w["pieces"]),
            phi: f(&w["container_phi"]),
        };
        assert_eq!(face.pieces.len() as u64, w["P"].as_u64().unwrap());
        let got = surface_from_face(&p, &face);
        match (&got, &c["config"]) {
            (None, Value::Null) => refused += 1,
            (Some(g), want) if !want.is_null() => {
                assert!(same_config(g, want), "{id}: surfaceFromFace differs");
                // the conversion's result is a valid packing
                assert!(check_config(&p, g).is_some(), "{id}: not valid");
                made += 1;
            }
            (g, want) => panic!("{id}: {:?} / {want}", g.as_ref().map(|g| g.s)),
        }
    }
    assert!(made >= 10 && refused >= 2, "{made} made, {refused} refused");
}

fn job<'a>(id: &'a str, seed: u32, evals: u64, start: Option<&'a Value>, stop: &'a AtomicBool) -> AutoJob<'a> {
    AutoJob { id, start, seed, max_evals: Some(evals), deadline: Instant::now() + Duration::from_secs(3600), stop }
}

/// A result that is valid by the validator, with its score, config and bookkeeping in order.
fn check(id: &str, r: &AutoResult) -> f64 {
    check_with(id, r, true)
}

/// As `check`; `even` asks that no face holds more than ceil(P/F) pieces, which a start with more
/// pieces on one face does not give.
fn check_with(id: &str, r: &AutoResult, even: bool) -> f64 {
    let p = parse_problem(id).unwrap();
    assert_eq!(r.method, NOFOLD_METHOD);
    let config = r.config.as_ref().unwrap_or_else(|| panic!("{id}: no config ({})", r.stopped));
    let read = read_space_config(&p, config).expect("a configuration of the problem");
    let score = check_config(&p, &read).expect("valid by the validator");
    assert_eq!(Some(score), r.score);
    assert_eq!(read.pieces.len(), p.p);
    // every face holds at most k pieces
    let k = p.p.div_ceil(p.f);
    for face in 0..p.f {
        let count = read.pieces.iter().filter(|q| q.face == face as f64).count();
        assert!(!even || count <= k, "{id}: face {face} over-full");
    }
    score
}

#[test]
fn searches_give_valid_packings() {
    let stop = AtomicBool::new(false);
    // a cube with squares, a tetrahedron with disks, a dodecahedron with pentagons, small P, a
    // triangle on an icosahedron
    for (id, evals) in [
        ("surface/cube/nofold/4/9", 300),
        ("surface/tetrahedron/nofold/0/9", 300),
        ("surface/dodecahedron/nofold/5/14", 300),
        ("surface/cube/nofold/4/1", 100),
        ("surface/octahedron/nofold/0/2", 100),
        ("surface/icosahedron/nofold/3/21", 200),
    ] {
        let r = nofold_planar_auto(&job(id, 1, evals, None, &stop)).unwrap();
        check(id, &r);
        assert_eq!(r.stopped, "evals", "{id}");
        assert_eq!(r.evaluations, evals, "{id}");
    }
}

#[test]
fn a_warm_search_never_returns_worse_than_its_start() {
    let stop = AtomicBool::new(false);
    for id in ["surface/cube/nofold/4/9", "surface/tetrahedron/nofold/0/9", "surface/dodecahedron/nofold/5/14"] {
        let first = nofold_planar_auto(&job(id, 3, 300, None, &stop)).unwrap();
        let s0 = check(id, &first);
        let warm = nofold_planar_auto(&job(id, 4, 200, first.config.as_ref(), &stop)).unwrap();
        let s1 = check(id, &warm);
        assert!(s1 <= s0, "{id}: warm {s1} worse than its start {s0}");
        // a start with one piece moved to a face of its own is a start too: the fullest face is used
        let mut moved = first.config.clone().unwrap();
        moved["pieces"][0]["face"] = Value::from(3);
        let r = nofold_planar_auto(&job(id, 5, 200, Some(&moved), &stop)).unwrap();
        check_with(id, &r, false);
    }
}

#[test]
fn the_same_seed_and_evaluations_give_the_same_packing() {
    let stop = AtomicBool::new(false);
    let id = "surface/cube/nofold/4/9";
    let a = nofold_planar_auto(&job(id, 9, 250, None, &stop)).unwrap();
    let b = nofold_planar_auto(&job(id, 9, 250, None, &stop)).unwrap();
    assert_eq!(a.config, b.config);
    assert_eq!(a.score, b.score);
}

#[test]
fn ids_the_search_cannot_model_are_refused() {
    let stop = AtomicBool::new(false);
    for id in [
        "surface/cube/fold/4/9",
        "surface/cuboctahedron/nofold/4/9",
        "surface/cube/nofold/2/9",
        "surface/cube/nofold/4/0",
        "surface/cube/nofold/4/501",
        "sphere/4/9",
        "surface/cube/nofold/4",
        "surface/cube/nofold/4/9/1",
        "surface/cube/nofold/-4/9",
    ] {
        assert!(nofold_planar_auto(&job(id, 1, 10, None, &stop)).is_err(), "{id}");
    }
}

#[test]
fn a_start_that_is_not_a_configuration_gives_an_error_result() {
    let stop = AtomicBool::new(false);
    let bad = serde_json::json!({"s": 3, "pieces": [{"face": 0, "x": 0, "y": 0, "theta": 0}]});
    let r = nofold_planar_auto(&job("surface/cube/nofold/4/9", 1, 10, Some(&bad), &stop)).unwrap();
    assert!(r.config.is_none() && r.score.is_none());
    assert_eq!(r.stopped, "error: the start is not a configuration of this problem");
}

#[test]
fn the_stop_flag_and_the_deadline_end_a_search() {
    let id = "surface/dodecahedron/nofold/5/30";
    let stop = AtomicBool::new(false);
    // the deadline: a search with no evaluation cap ends by time, and its packing is valid
    let t0 = Instant::now();
    let r = nofold_planar_auto(&AutoJob {
        id,
        start: None,
        seed: 1,
        max_evals: None,
        deadline: Instant::now() + Duration::from_millis(1500),
        stop: &stop,
    })
    .unwrap();
    assert!(t0.elapsed() < Duration::from_secs(10), "took {:?}", t0.elapsed());
    assert!(r.stopped == "time" || r.stopped == "stop", "{}", r.stopped);
    if r.config.is_some() {
        check(id, &r);
    }
    // the stop flag, set while it runs
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let r = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            stop.store(true, Ordering::Relaxed);
        });
        nofold_planar_auto(&AutoJob {
            id,
            start: None,
            seed: 2,
            max_evals: None,
            deadline: Instant::now() + Duration::from_secs(600),
            stop: &stop,
        })
        .unwrap()
    });
    assert!(t0.elapsed() < Duration::from_secs(10), "took {:?}", t0.elapsed());
    assert_eq!(r.stopped, "stop");
    if r.config.is_some() {
        check(id, &r);
    }
}

/// The searches of the TypeScript (nofold-round.ts's job, evaluation-budgeted): the same
/// evaluations, and the same score up to the flat solver's own difference from the polygon solver.
///
/// Basin hopping in native/flat is a port with known differences from packages/solver
/// (methods/basin_hopping.rs, top), and its final polish ends on contact within a few 1e-13: the
/// scores agree in 12 digits, and in every digit when the packing is an exact one. The face
/// problem and the conversion are exact (the tests above), so the gap is the flat solver's: the
/// test runs the flat solver on the face alone and reports it beside the TypeScript's face score.
#[test]
fn the_search_reaches_the_typescripts_score() {
    let stop = AtomicBool::new(false);
    let mut identical = 0;
    let mut report = Vec::new();
    let cases = lines("nofold_planar_search.jsonl");
    for c in &cases {
        let id = c["id"].as_str().unwrap();
        let start = if c["start"].is_null() { None } else { Some(&c["start"]) };
        let seed = c["seed"].as_u64().unwrap() as u32;
        let evals = c["evals"].as_u64().unwrap();
        let r = nofold_planar_auto(&job(id, seed, evals, start, &stop)).unwrap();
        let score = check(id, &r);
        let want = f(&c["score"]);
        assert_eq!(r.evaluations, c["evaluations"].as_u64().unwrap(), "{id}: evaluations");
        assert_eq!(r.stopped, "evals", "{id}");
        assert!((score - want).abs() <= 1e-11 * want, "{id}: rust {score:?} ts {want:?}");
        // the flat solver alone on the face
        let p = parse_problem(id).unwrap();
        let sc = start.map(|s| read_space_config(&p, s).unwrap());
        let face = face_problem(&p, sc.as_ref());
        let control = polypack_flat::Control::default();
        let flat = polypack_flat::run(
            face.problem,
            polypack_flat::RunOptions {
                method: polypack_flat::Method::BasinHopping,
                params: Value::Null,
                start: face.known.as_ref().map(|(c, _)| c.clone()),
                budget: polypack_flat::Budget { evals: Some(evals), time_s: Some(3600.0) },
                seed,
                final_polish: true,
                control: &control,
                clock: polypack_flat::clock::ClockKind::Wall,
            },
        );
        if same(score, want) {
            identical += 1;
        }
        report.push(format!(
            "{id} seed {seed} evals {evals}: surface rust {score:?} ts {want:?}; face rust {:?} ts {}",
            flat.score.unwrap(),
            c["faceScore"]
        ));
    }
    println!("{identical} of {} identical\n{}", cases.len(), report.join("\n"));
}
