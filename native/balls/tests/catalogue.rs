//! The balls family's names, ids, containers and bounds, without the TypeScript.

use polypack_balls as balls;
use serde_json::json;

#[test]
fn the_373_problems() {
    assert_eq!(balls::BALLS_PROBLEMS.len(), 373);
    assert_eq!(balls::BALLS_CODES[..7], ["ballinball", "ballintet", "ballincub", "ballinoct", "ballindod", "ballinico", "ballintte"]);
    let p = balls::get_balls_problem("ballinpkd").unwrap();
    assert_eq!((p.piece.as_str(), p.container.as_str()), ("ball", "pentakis_dodecahedron"));
    assert_eq!((p.title.as_str(), p.group.as_str()), ("Balls in a pentakis dodecahedron", "Balls in a Catalan solid"));
    let p = balls::get_balls_problem("pr3l15inball").unwrap();
    assert_eq!((p.title.as_str(), p.group.as_str()), ("Triangular prisms of height 1.5 in a ball", "Elongated prisms in a ball"));
    assert!(balls::get_balls_problem("cubintet").is_none());
    for code in balls::BALLS_ORIGINAL_CODES {
        assert!(balls::get_balls_problem(code).is_some());
    }
}

#[test]
fn ids() {
    let id = balls::parse_balls_id("balls/ballinball/13").unwrap();
    assert_eq!((id.code.as_str(), id.p), ("ballinball", 13));
    assert_eq!(balls::format_balls_id("ballinball", 13), "balls/ballinball/13");
    assert!(balls::parse_balls_id("balls/ballinball/013").unwrap_err().starts_with("\"balls/ballinball/013\" is not a balls problem id"));
    assert!(balls::parse_balls_id("balls/nope/3").unwrap_err().starts_with("\"nope\" is not a balls problem code"));
    assert_eq!(balls::parse_balls_id(&"x".repeat(101)).unwrap_err(), "id is too long");
}

#[test]
fn containers_and_bounds() {
    let cube = balls::container_of("cube").unwrap();
    assert_eq!((cube.f, cube.inradius, cube.chebyshev, cube.diameter, cube.tangential), (6, 0.5, 0.5, 3.0f64.sqrt(), true));
    assert_eq!((cube.lo, cube.hi), ([-0.5; 3], [0.5; 3]));
    // a pyramid's largest inscribed ball is not centred at its vertex centroid
    let pyramid = balls::container_of("square_pyramid").unwrap();
    assert!(pyramid.chebyshev > pyramid.inradius * 1.01);
    assert!(pyramid.enclosing < pyramid.circumradius);
    // two balls of diameter 1 need a ball of diameter 2, and a cube of edge 1 + 1 / sqrt 3
    let b = balls::balls_bound(balls::get_balls_problem("ballinball").unwrap(), 2.0).unwrap();
    assert_eq!((b.value, b.kind), (2.0, "two-piece"));
    let b = balls::balls_bound(balls::get_balls_problem("ballincub").unwrap(), 2.0).unwrap();
    assert_eq!((b.value, b.kind), (1.0 + 1.0 / 3.0f64.sqrt(), "two-piece"));
    assert!(balls::balls_domain_bound("ballinball", 1.0).is_none());
    assert!(balls::balls_domain_bound("ballinball", 101.0).is_none());
    assert!(balls::balls_domain_bound("ballinball", 2.0).unwrap().label.starts_with("two piece bound; [EST] two balls of diameter 1 "));
    assert_eq!(balls::balls_domain_info().problems, 373 * 99);
    assert_eq!(balls::balls_domain_sample(8).last().unwrap(), "balls/ballinball/3");
}

#[test]
fn the_validator_on_two_balls() {
    let problem = balls::get_balls_problem("ballinball").unwrap();
    let opts = balls::BallsValidateOptions::default();
    // two touching balls of diameter 1 in the ball of diameter 2
    let touching = balls::BallsConfig { s: 2.0, pieces: vec![vec![-0.5, 0.0, 0.0], vec![0.5, 0.0, 0.0]] };
    let v = balls::validate_balls(problem, &touching, &opts).unwrap();
    assert!(v.valid);
    assert_eq!((v.min_wall_gap, v.min_pair_sep, v.worst_pair), (0.0, 0.0, Some((0, 1))));
    let apart = balls::BallsConfig { s: 2.0, pieces: vec![vec![-0.5, 0.0, 0.0], vec![0.25, 0.0, 0.0]] };
    let v = balls::validate_balls(problem, &apart, &opts).unwrap();
    assert_eq!(v.errors, ["pieces 0 and 1 overlap by 0.25"]);
    // the server's parse: a wrong count is not malformed, a pose of the other kind is
    let raw = json!({"s": 2, "pieces": [[-0.5, 0, 0], [0.5, 0, 0]]});
    assert!(matches!(balls::parse_balls_config(problem, &raw, 2, 20), balls::BallsParsed::Ok { score, .. } if score == 2.0));
    assert_eq!(
        balls::parse_balls_config(problem, &raw, 3, 20),
        balls::BallsParsed::Failed { malformed: false, errors: vec!["expected 3 pieces for this problem, got 2".to_string()] }
    );
    let cubes = balls::get_balls_problem("cubinball").unwrap();
    assert_eq!(
        balls::parse_balls_config(cubes, &raw, 2, 20),
        balls::BallsParsed::Failed {
            malformed: true,
            errors: vec![
                "pieces[0] must be [x, y, z, qw, qx, qy, qz] of finite numbers".to_string(),
                "pieces[1] must be [x, y, z, qw, qx, qy, qz] of finite numbers".to_string()
            ]
        }
    );
}
