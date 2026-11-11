//! What reading a submission's body costs beside verifying it: the JSON tree
//! (`polypack_js::json::parse`), `parse_config` on it, the direct reader of src/body.rs in their
//! place, and `evaluate`, for a grid of P squares
//! written as a client writes them. Prints microseconds per board.
//!
//!   cargo run --release -p polypack-server --example parse_cost

use std::time::Instant;

use polypack_flat::config::{evaluate, parse_config, EvaluateOptions};

fn main() {
    for p in [10usize, 50, 250, 500] {
        let cols = (p as f64).sqrt().ceil() as usize;
        let pieces: Vec<String> = (0..p)
            .map(|i| format!("{{\"x\":{},\"y\":{},\"theta\":0.7853981633974483}}", (i % cols) as f64 * 1.000000000123 + 0.123456789012345, (i / cols) as f64 * 1.000000000123 - 0.987654321098765))
            .collect();
        let body = format!("{{\"N\":4,\"M\":4,\"P\":{p},\"pieces\":[{}],\"container_phi\":0,\"name\":\"bench\",\"found_with\":\"external\"}}", pieces.join(","));
        let rounds = 2000;
        let t = Instant::now();
        let mut tree = None;
        for _ in 0..rounds {
            tree = Some(polypack_js::json::parse(body.as_bytes()).unwrap());
        }
        let parse = t.elapsed().as_secs_f64() * 1e6 / rounds as f64;
        let tree = tree.unwrap();
        let t = Instant::now();
        let mut config = None;
        for _ in 0..rounds {
            config = Some(parse_config(&tree).unwrap());
        }
        let read = t.elapsed().as_secs_f64() * 1e6 / rounds as f64;
        let config = config.unwrap();
        // the direct reader (src/body.rs), with parse_config on what is left
        let t = Instant::now();
        for _ in 0..rounds {
            let direct = polypack_server::body::read(body.as_bytes()).unwrap();
            let mut c = parse_config(&serde_json::Value::Object(direct.object)).unwrap();
            c.pieces = direct.pieces.unwrap();
            assert_eq!(c.pieces.len(), p);
        }
        let direct = t.elapsed().as_secs_f64() * 1e6 / rounds as f64;
        let t = Instant::now();
        let mut valid = true;
        for _ in 0..rounds {
            valid &= evaluate(&config, &EvaluateOptions::server(20)).valid;
        }
        let verify = t.elapsed().as_secs_f64() * 1e6 / rounds as f64;
        println!("P = {p:3}: body {:6} bytes; JSON tree {parse:7.1} us, parse_config {read:6.1} us, read directly {direct:6.1} us, evaluate {verify:7.1} us (valid: {valid})", body.len());
    }
}
