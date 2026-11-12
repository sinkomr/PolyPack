//! The catalogues of the repository's data/, the tables and the on-demand loader, checked on their
//! own (no reference answers needed).

mod support;

use polypack_spaces::load::{config_loader_with, load_spaces_index};
use polypack_spaces::*;
use std::path::PathBuf;
use std::sync::Arc;

fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn what_the_server_shares_between_threads_can_be_shared() {
    assert_send_sync::<SpacesIndex>();
    assert_send_sync::<SpaceCatalogue>();
    assert_send_sync::<SpaceProblemEntry>();
    assert_send_sync::<ConfigLoader>();
    assert_send_sync::<SpaceDomain>();
}

#[test]
fn the_surface_solids_of_the_ids_are_the_surface_crate_s() {
    // packages/spaces/src/ids.ts: "The same list as ALL_SOLID_NAMES of @polypack/surface (a test checks it)"
    assert_eq!(surface_solids(), polypack_surface::all_solid_names());
    assert_eq!(surface_platonic().len(), 5);
    assert_eq!(surface_archimedean().len(), 13);
    assert_eq!(surface_catalan().len(), 13);
    assert_eq!(surface_johnson().len(), 92);
    assert_eq!(surface_johnson()[0], "square_pyramid");
}

#[test]
fn the_count_of_curved_problems_is_the_one_kept() {
    // piece-domains.ts keeps the count, since counting takes a while; the two must agree
    assert_eq!(count_curved_problems(), CURVED_PROBLEMS);
}

#[test]
fn the_shipped_records_load_whole() {
    let (log, lines) = support::keeping_log();
    let index = load_spaces_index(&support::repo_root(), log);
    assert_eq!(index.loaded(), SPACE_NAMES.to_vec());
    for space in SPACE_NAMES {
        let cat = index.get(space).unwrap();
        // "Records left out, with the reason (none for the shipped data; a test checks it)"
        assert!(cat.skipped.is_empty(), "{space}: {:?}", cat.skipped);
        // "the largest catalogue P when this was written; a test fails if the catalogue grows beyond it"
        assert!(cat.max_p <= space_max_p(space), "{space}: P up to {}", cat.max_p);
        assert!(cat.problems.windows(2).all(|w| compare_space_problems(&w[0], &w[1]) == std::cmp::Ordering::Less), "{space} is sorted");
        for p in &cat.problems {
            assert_eq!(cat.by_id[&p.id].id, p.id);
            assert_eq!(p.config.is_some(), !p.config_apart && p.certified.is_some(), "{}", p.id);
        }
    }
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 8, "{lines:?}");
    assert!(lines.iter().all(|l| l.starts_with("[spaces] ") && !l.contains("left out")));
    // a configuration kept apart is read on demand, and is the record's
    let polyhedra = index.get(SpaceName::Polyhedra).unwrap();
    let entry = polyhedra.problems.iter().find(|p| p.config_apart).expect("polyhedra keeps its configurations apart");
    let text = entry_config(polyhedra, entry).expect("the configuration of a record");
    assert!(text.starts_with("{\"s\":"));
    assert_eq!(read_entry_config_sync(&support::repo_root(), polyhedra, entry).as_deref(), Some(text.as_str()));
    // and a record's own configuration passes the check it was listed with
    let id = parse_space_id(SpaceName::Polyhedra, &entry.id).unwrap();
    let Parsed::Ok { score, .. } = parse_space_config(&id, Some(&polypack_js::json::parse(text.as_bytes()).unwrap())) else {
        panic!("the record's configuration parses");
    };
    assert_eq!(Some(score), entry.certified.as_ref().map(|c| c.score));
}

/// A folder with a records file of four polyhedra problems and their configurations in one file,
/// the third line damaged.
fn loader_root(name: &str) -> (PathBuf, SpaceCatalogue) {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&root);
    let dir = root.join("data/polyhedra/configs");
    std::fs::create_dir_all(&dir).unwrap();
    let mut text = String::new();
    let mut records = Vec::new();
    for p in 2..=5u32 {
        let pieces: Vec<String> = (0..p).map(|k| format!("[{k},0,0,1,0,0,0]")).collect();
        let line = if p == 4 { "{\"P\":4,\"config\":{\"s\":9.5,\"pieces\":[]}}\n".to_string() } else { format!("{{\"P\":{p},\"config\":{{\"s\":{p}.5,\"pieces\":[{}]}}}}\n", pieces.join(",")) };
        records.push(format!(
            "{{\"id\":\"polyhedra/cubintet/{p}\",\"code\":\"cubintet\",\"piece\":\"cube\",\"container\":\"tetrahedron\",\"P\":{p},\"status\":\"best_known\",\"score_cert\":{p}.5,\"display\":\"{p}.500000\",\"config_at\":[{},{}]}}",
            text.len(),
            line.len()
        ));
        text.push_str(&line);
    }
    // a problem whose file is missing
    records.push("{\"id\":\"polyhedra/cubincub/2\",\"code\":\"cubincub\",\"piece\":\"cube\",\"container\":\"cube\",\"P\":2,\"status\":\"best_known\",\"score_cert\":2,\"display\":\"2.000000\",\"config_at\":[0,10]}".to_string());
    std::fs::write(dir.join("cubintet.jsonl"), text).unwrap();
    let file = polypack_js::json::parse(format!("{{\"generated\":\"today\",\"records\":[{}]}}", records.join(",")).as_bytes()).unwrap();
    let cat = build_space_catalogue(SpaceName::Polyhedra, Some(&file), space_domain(SpaceName::Polyhedra));
    assert!(cat.skipped.is_empty(), "{:?}", cat.skipped);
    assert_eq!(cat.problems.len(), 5);
    (root, cat)
}

#[test]
fn the_loader_keeps_the_last_ones_read_and_logs_a_problem_once() {
    let (root, cat) = loader_root("loader-sequential");
    let (log, lines) = support::keeping_log();
    let two = "{\"s\":2.5,\"pieces\":[[0,0,0,1,0,0,0],[1,0,0,1,0,0,0]]}";
    let three = "{\"s\":3.5,\"pieces\":[[0,0,0,1,0,0,0],[1,0,0,1,0,0,0],[2,0,0,1,0,0,0]]}";
    let five = "{\"s\":5.5,\"pieces\":[[0,0,0,1,0,0,0],[1,0,0,1,0,0,0],[2,0,0,1,0,0,0],[3,0,0,1,0,0,0],[4,0,0,1,0,0,0]]}";
    // room for the configurations of P = 2 and P = 5, not for a third
    let loader = config_loader_with(&root, SpaceName::Polyhedra, log, two.len() + five.len() + 10, 2);
    let entry = |id: &str| cat.by_id[id].clone();
    assert_eq!(loader.load(&entry("polyhedra/cubintet/2")).as_deref(), Some(two));
    assert_eq!(loader.load(&entry("polyhedra/cubintet/3")).as_deref(), Some(three));
    assert_eq!(loader.cached(), ["polyhedra/cubintet/2", "polyhedra/cubintet/3"]);
    // a hit makes it the most recently used, and reads nothing
    assert_eq!(loader.load(&entry("polyhedra/cubintet/2")).as_deref(), Some(two));
    assert_eq!(loader.cached(), ["polyhedra/cubintet/3", "polyhedra/cubintet/2"]);
    assert_eq!(loader.stats(), LoaderStats { reads: 2, peak_at_once: 1, bytes: two.len() + three.len() });
    // the least recently used goes first
    assert_eq!(loader.load(&entry("polyhedra/cubintet/5")).as_deref(), Some(five));
    assert_eq!(loader.cached(), ["polyhedra/cubintet/2", "polyhedra/cubintet/5"]);
    // a line that is not the entry's configuration is left out, and said once
    assert_eq!(loader.load(&entry("polyhedra/cubintet/4")), None);
    assert_eq!(loader.load(&entry("polyhedra/cubintet/4")), None);
    // a file that cannot be read is said every time (it may be there the next time)
    assert_eq!(loader.load(&entry("polyhedra/cubincub/2")), None);
    assert_eq!(loader.load(&entry("polyhedra/cubincub/2")), None);
    assert_eq!(loader.stats().reads, 7);
    assert_eq!(loader.cached(), ["polyhedra/cubintet/2", "polyhedra/cubintet/5"]);
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(lines[0], "[spaces] polyhedra/cubintet/4: configuration left out: expected 4 pieces for this problem, got 0");
    assert!(lines[1].starts_with("[spaces] polyhedra/cubincub/2: configuration not read: ENOENT: no such file or directory, open '"), "{}", lines[1]);
    assert_eq!(lines[1], lines[2]);
}

#[test]
fn the_loader_serves_many_threads() {
    let (root, cat) = loader_root("loader-threads");
    let cat = Arc::new(cat);
    let (log, lines) = support::keeping_log();
    let loader = Arc::new(config_loader_with(&root, SpaceName::Polyhedra, log, 4_000_000, 2));
    let ids = ["polyhedra/cubintet/2", "polyhedra/cubintet/3", "polyhedra/cubintet/4", "polyhedra/cubintet/5", "polyhedra/cubincub/2"];
    let gate = Arc::new(std::sync::Barrier::new(40));
    let handles: Vec<_> = (0..40)
        .map(|k| {
            let (loader, cat, gate) = (loader.clone(), cat.clone(), gate.clone());
            std::thread::spawn(move || {
                gate.wait();
                let id = ids[k % ids.len()];
                (id, loader.load(&cat.by_id[id]))
            })
        })
        .collect();
    for h in handles {
        let (id, served) = h.join().unwrap();
        match id {
            "polyhedra/cubintet/4" | "polyhedra/cubincub/2" => assert_eq!(served, None, "{id}"),
            _ => assert!(served.is_some_and(|t| t.starts_with("{\"s\":")), "{id}"),
        }
    }
    let stats = loader.stats();
    // at most two reads at once; a configuration that was read is read once
    assert!(stats.peak_at_once >= 1 && stats.peak_at_once <= 2, "{stats:?}");
    assert!(stats.reads >= 5 && stats.reads <= 3 + 16, "{stats:?}");
    let mut cached = loader.cached();
    cached.sort();
    assert_eq!(cached, ["polyhedra/cubintet/2", "polyhedra/cubintet/3", "polyhedra/cubintet/5"]);
    let lines = lines.lock().unwrap();
    assert_eq!(lines.iter().filter(|l| l.contains("left out")).count(), 1, "{lines:?}");
}

#[test]
fn a_space_without_a_records_file_has_its_domain() {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("no-data");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("data/sphere")).unwrap();
    std::fs::write(root.join("data/sphere/records.json"), "{\"records\": [").unwrap();
    let (log, lines) = support::keeping_log();
    let index = load_spaces_index(&root, log);
    // a file that is not JSON leaves its space out; the others have their domains
    assert!(index.get(SpaceName::Sphere).is_none());
    assert_eq!(index.loaded().len(), 7);
    let balls = index.get(SpaceName::Balls).unwrap();
    assert!(balls.problems.is_empty() && balls.domain.is_some());
    let id = parse_space_id(SpaceName::Balls, "balls/ballinball/13").unwrap();
    let p = problem_of(balls, &id).unwrap();
    assert_eq!(p.status, SpaceProblemStatus::NoRecord);
    assert!(accepts_submissions(&p) && !has_record(&p) && p.bound.is_some());
    assert!(problem_of(balls, &parse_space_id(SpaceName::Balls, "balls/ballinball/101").unwrap()).is_none());
    let lines = lines.lock().unwrap();
    assert!(lines.iter().any(|l| l.starts_with("[spaces] sphere records not loaded: ")), "{lines:?}");
    assert!(lines.iter().any(|l| l.starts_with("[spaces] balls: a domain of 36927 problems, 0 with a record (no records file)")), "{lines:?}");
}
