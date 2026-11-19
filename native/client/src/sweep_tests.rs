//! End-to-end runs of the sweep against a fake server and a fake searcher.

use crate::options::{parse_options, Machine, Options, Parsed};
use crate::space_engine::SpaceSearcher;
use crate::state::{random_u32, StateDir};
use crate::sweep::run_with;
use crate::volunteer::SOFTWARE;
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the fake server knows and has been told.
#[derive(Default)]
struct Srv {
    problems: HashMap<String, Value>,
    posts: Vec<Value>,
    gets: Vec<String>,
    next_id: i64,
    /// The bulk lists (known.rs): None answers 404 to them, as a server without them would.
    lists: Option<(Vec<Value>, Vec<Value>)>,
}

fn problem_body(id: &str, open: bool, leader: Option<(i64, f64, &str)>) -> Value {
    let mut v = json!({
        "space": "sphere", "id": id, "accepts_submissions": open, "status": "no_record",
        "bound": {"value": 0.1}, "certified": null, "best_score": leader.map(|l| l.1),
        "site_best": leader.map(|l| json!({"id": l.0, "score": l.1, "name": l.2})),
    });
    if let Some(l) = leader {
        v["site_config"] = json!({"rho": l.1, "pieces": [{"q": [1.0, 0.0, 0.0, 0.0]}]});
    }
    v
}

fn serve(srv: Arc<Mutex<Srv>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut c) = conn else { continue };
            let srv = srv.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head_end, len) = loop {
                    let n = c.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_end + len {
                    let n = c.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let first = head.lines().next().unwrap_or("").to_string();
                let (method, path) = (first.split(' ').next().unwrap_or("").to_string(), first.split(' ').nth(1).unwrap_or("").to_string());
                let body: Value = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
                let (status, answer) = {
                    let mut s = srv.lock().unwrap();
                    if method == "GET" {
                        s.gets.push(path.clone());
                        if path.starts_with("/api/spaces/sphere/records") || path.starts_with("/api/spaces/sphere/site-only") {
                            match &s.lists {
                                Some((records, site_only)) => {
                                    let list = if path.contains("records") { records.clone() } else { site_only.clone() };
                                    (200, json!({"space": "sphere", "problems": list, "next": null}))
                                }
                                None => (404, json!({"error": "not here"})),
                            }
                        } else {
                        let id = path.strip_prefix("/api/spaces/sphere/problems/").unwrap_or("");
                        match s.problems.get(id) {
                            Some(p) => (200, p.clone()),
                            None => (404, json!({"error": "unknown problem"})),
                        }
                        }
                    } else {
                        s.posts.push(body.clone());
                        s.next_id += 1;
                        let id = s.next_id;
                        let pid = body["id"].as_str().unwrap_or("").to_string();
                        let rho = body["config"]["rho"].as_f64().unwrap_or(0.0);
                        let name = body["name"].as_str().unwrap_or("").to_string();
                        s.problems.insert(pid.clone(), problem_body(&pid, true, Some((id, rho, &name))));
                        (200, json!({"valid": true, "leader": true, "id": id, "score": rho, "best_score": rho, "beats_certified": false, "reasons": []}))
                    }
                };
                let text = answer.to_string();
                let _ = c.write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len()).as_bytes());
            });
        }
    });
    format!("http://{addr}")
}

/// Answers a rho per problem, sleeping a little as a search does, and notes what it was asked.
struct Fake {
    rho: HashMap<String, f64>,
    calls: Mutex<Vec<(String, bool)>>,
}

impl SpaceSearcher for Fake {
    fn search(&self, space: &str, job: &AutoJob) -> Result<AutoResult, String> {
        assert_eq!(space, "sphere");
        self.calls.lock().unwrap().push((job.id.to_string(), job.start.is_some()));
        std::thread::sleep(Duration::from_millis(40));
        let rho = *self.rho.get(job.id).ok_or("no script for this problem")?;
        Ok(AutoResult { config: Some(json!({"rho": rho, "pieces": [{"q": [1.0, 0.0, 0.0, 0.0]}]})), score: Some(rho), evaluations: 10, stopped: "time".into(), method: "fake auto".into() })
    }
}

fn options(base: &str, dir: &std::path::Path, extra: &[&str]) -> Options {
    let mut args: Vec<String> = [
        "--sweep-2d-on-3d", "--kinds", "sphere", "--N", "0,3-6", "--max-P", "1", "--name", "Tester", "--cores", "1", "--parallel-problems", "1", "--minutes-per-problem", "0.01", "--hours", "0.0015",
        "--no-battery-pause", "--server", base, "--state",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(dir.to_string_lossy().to_string());
    args.extend(extra.iter().map(|s| s.to_string()));
    match parse_options(&args, &Machine { available_parallelism: 2, home: dir.to_path_buf() }) {
        Ok(Parsed::Run(o)) => o,
        _ => panic!("options"),
    }
}

fn temp(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("polypack-sweep-{name}-{}-{:08x}", std::process::id(), random_u32()))
}

#[test]
fn sweeps_submits_a_first_entry_and_an_improvement_and_skips() {
    let dir = temp("e2e");
    let mut srv = Srv::default();
    // loop 1: no leader; loop 2: another holder leads at 1.0; loop 3: led by us; loop 4: closed; loop 5: unknown
    srv.problems.insert("sphere/0/1".into(), problem_body("sphere/0/1", true, None));
    srv.problems.insert("sphere/3/1".into(), problem_body("sphere/3/1", true, Some((7, 1.0, "Someone"))));
    srv.problems.insert("sphere/4/1".into(), problem_body("sphere/4/1", true, Some((8, 1.0, " Tester "))));
    srv.problems.insert("sphere/5/1".into(), problem_body("sphere/5/1", false, Some((9, 1.0, "Someone"))));
    let srv = Arc::new(Mutex::new(srv));
    let base = serve(srv.clone());
    let fake = Arc::new(Fake { rho: HashMap::from([("sphere/0/1".to_string(), 2.0), ("sphere/3/1".to_string(), 0.5), ("sphere/4/1".to_string(), 0.2)]), calls: Mutex::new(Vec::new()) });
    let code = run_with(options(&base, &dir, &[]), fake.clone(), false);
    assert_eq!(code, 0);
    let s = srv.lock().unwrap();
    // two submissions: a first entry, and an improvement on another holder's entry
    assert_eq!(s.posts.len(), 2, "{:?}", s.posts);
    assert!(s.posts[0]["seed"].is_u64());
    assert_eq!(
        s.posts[0],
        json!({"space": "sphere", "id": "sphere/0/1", "config": {"rho": 2.0, "pieces": [{"q": [1.0, 0.0, 0.0, 0.0]}]}, "units": "diameter", "name": "Tester", "software": SOFTWARE, "method": "fake auto", "seed": s.posts[0]["seed"]})
    );
    assert_eq!((s.posts[1]["id"].as_str(), s.posts[1]["config"]["rho"].as_f64()), (Some("sphere/3/1"), Some(0.5)));
    // the leader's packing was the start of the improvement; nothing searched a led, closed or unknown problem
    let calls = fake.calls.lock().unwrap();
    assert!(calls.iter().any(|(id, started)| id == "sphere/3/1" && *started));
    assert!(calls.iter().all(|(id, _)| id == "sphere/0/1" || id == "sphere/3/1"), "{calls:?}");
    assert!(s.gets.iter().any(|g| g.ends_with("sphere/6/1")), "the unknown problem was read: {:?}", s.gets);
    // state: the best files, the history (searched problems only), the position
    let state = StateDir::open(&dir).unwrap();
    assert_eq!(state.read_space_best("sphere/0/1").unwrap()["score"], json!(2.0));
    assert!(state.read_space_best("sphere/4/1").is_none());
    let history = std::fs::read_to_string(dir.join("history.jsonl")).unwrap();
    let lines: Vec<Value> = history.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let ids: Vec<&str> = lines.iter().take(2).map(|l| l["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["sphere/0/1", "sphere/3/1"]);
    assert_eq!((lines[0]["submitted"].clone(), lines[0]["decision"].as_str()), (json!(true), Some("better than the problem's best")));
    assert_eq!(lines[1]["leader_before"]["name"], "Someone");
    assert_eq!(lines[1]["leader_after"]["name"], "Tester");
    let pos: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("sweep.json")).unwrap()).unwrap();
    assert!(pos["pass"].as_u64() >= Some(2) && pos["loop"].as_u64() == Some(1), "{pos}");
    state.close();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn dry_run_and_include_own() {
    let dir = temp("dry");
    let mut srv = Srv::default();
    srv.problems.insert("sphere/0/1".into(), problem_body("sphere/0/1", true, Some((8, 1.0, "Tester"))));
    let srv = Arc::new(Mutex::new(srv));
    let base = serve(srv.clone());
    let fake = Arc::new(Fake { rho: HashMap::from([("sphere/0/1".to_string(), 0.5)]), calls: Mutex::new(Vec::new()) });
    // our own leader is searched again with --include-own; a dry run submits nothing
    let code = run_with(options(&base, &dir, &["--include-own", "--dry-run", "--N", "0"]), fake.clone(), false);
    assert_eq!(code, 0);
    assert!(srv.lock().unwrap().posts.is_empty());
    assert!(fake.calls.lock().unwrap().iter().any(|(id, _)| id == "sphere/0/1"));
    let history = std::fs::read_to_string(dir.join("history.jsonl")).unwrap();
    assert!(history.contains("dry run: would submit"), "{history}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn open_only_passes_over_listed_problems_without_reading_them() {
    let dir = temp("lists");
    let mut srv = Srv::default();
    // 0/1: open and in no list; 3/1: another holder's site entry; 4/1: a research record only;
    // 5/1: closed; 6/1: led by us. Every one can still be read on its own.
    srv.problems.insert("sphere/0/1".into(), problem_body("sphere/0/1", true, None));
    srv.problems.insert("sphere/3/1".into(), problem_body("sphere/3/1", true, Some((7, 1.0, "Someone"))));
    srv.problems.insert("sphere/4/1".into(), json!({"space": "sphere", "id": "sphere/4/1", "accepts_submissions": true, "status": "best_known", "bound": {"value": 0.1}, "certified": {"score": 1.0}, "best_score": 1.0, "site_best": null}));
    srv.problems.insert("sphere/5/1".into(), problem_body("sphere/5/1", false, None));
    srv.problems.insert("sphere/6/1".into(), problem_body("sphere/6/1", true, Some((8, 1.0, "Tester"))));
    srv.lists = Some((
        vec![
            json!({"id": "sphere/4/1", "best_score": 1.0, "accepts_submissions": true, "site_best": null}),
            json!({"id": "sphere/5/1", "best_score": null, "accepts_submissions": false, "site_best": null}),
        ],
        vec![
            json!({"id": "sphere/3/1", "best_score": 1.0, "accepts_submissions": true, "site_best": {"id": 7, "score": 1.0, "name": "Someone"}}),
            json!({"id": "sphere/6/1", "best_score": 1.0, "accepts_submissions": true, "site_best": {"id": 8, "score": 1.0, "name": "Tester"}}),
        ],
    ));
    let srv = Arc::new(Mutex::new(srv));
    let base = serve(srv.clone());
    let fake = Arc::new(Fake { rho: HashMap::from([("sphere/0/1".to_string(), 2.0)]), calls: Mutex::new(Vec::new()) });
    let code = run_with(options(&base, &dir, &["--open-only", "--one-pass"]), fake.clone(), false);
    assert_eq!(code, 0);
    let s = srv.lock().unwrap();
    // the lists were read; of the problems, only the open one was read on its own, searched and sent
    assert!(s.gets.iter().any(|g| g.starts_with("/api/spaces/sphere/records")), "{:?}", s.gets);
    assert!(s.gets.iter().any(|g| g.starts_with("/api/spaces/sphere/site-only?limit=5000")), "{:?}", s.gets);
    let read: Vec<&String> = s.gets.iter().filter(|g| g.starts_with("/api/spaces/sphere/problems/")).collect();
    assert!(read.iter().all(|g| g.ends_with("sphere/0/1")), "{read:?}");
    assert_eq!(s.posts.len(), 1);
    assert_eq!(s.posts[0]["id"], "sphere/0/1");
    assert!(fake.calls.lock().unwrap().iter().all(|(id, _)| id == "sphere/0/1"));
    let _ = std::fs::remove_dir_all(&dir);
}
