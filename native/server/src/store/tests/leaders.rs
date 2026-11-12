//! The store parts of apps/server/test/leaders.test.ts. The source's tests ask the route
//! GET /api/leaders, which reads the polygon leaders with `leadersOf` and the space leaders with
//! `spaceLeadersOf`, and compare its answer with the per-problem endpoints, which read `leader` and
//! `spaceLeader`. The store is set up here as there, and the two readings are compared directly.
//! What the route adds (published records, closed problems, unknown keys, limits, compression) is
//! the HTTP layer's and is not ported here.

use super::*;

fn polygon(n: f64, m: f64, p: f64, score: f64, name: &str, verification: &str) -> NewSubmission {
    let mut e = entry(n, m, p, score, name);
    e.pieces = Vec::new();
    e.created_at = "2026-10-12T00:00:00.000Z".to_string();
    e.verification = verification.to_string();
    e
}

fn space_entry(problem: &str, score: f64, name: &str) -> NewSpaceEntry {
    NewSpaceEntry {
        space: problem.split('/').next().unwrap().to_string(),
        problem: problem.to_string(),
        score,
        name: name.to_string(),
        agent_note: String::new(),
        software: None,
        method: None,
        seed: None,
        config: "{}".to_string(),
        created_at: "t".to_string(),
    }
}

fn key(text: &str) -> ProblemKey {
    let parts: Vec<f64> = text.split('/').map(|x| x.parse().unwrap()).collect();
    ProblemKey { n: parts[0], m: parts[1], p: parts[2] }
}

/// beforeEach of describe("GET /api/leaders"), and what its first test reads of the store.
#[test]
fn answers_polygon_and_space_problems_mixed_with_no_leader_left_out() {
    let store = open(":memory:");
    let poly = store.insert(&polygon(4.0, 7.0, 2.0, 2.5, "ada", "none")).unwrap();
    store.insert(&polygon(5.0, 5.0, 2.0, 3.0, "ghost", "none")).unwrap();
    store.space_submit(&space_entry("sphere/3/6", 1.5, "worse")).unwrap();
    let beaten = store.space_submit(&space_entry("sphere/3/7", 0.5, "bea")).unwrap().id;
    store.space_submit(&space_entry("torus/sq/0/2", 100.0, "late")).unwrap();

    let leaders = store.leaders_of(&[key("4/7/2"), key("3/3/5"), key("4/4/3")]).unwrap();
    assert_eq!(leaders, vec![ProblemLeader { n: 4.0, m: 7.0, p: 2.0, id: poly, name: "ada".into(), score: 2.5, verification: "none".into() }]);
    let problems: Vec<SpaceProblem> = ["sphere/3/7", "sphere/3/6", "torus/sq/0/9"]
        .iter()
        .map(|p| SpaceProblem { space: p.split('/').next().unwrap().to_string(), problem: p.to_string() })
        .collect();
    let spaces = store.space_leaders_of(&problems).unwrap();
    // by space and problem id, whatever the order asked; the problem without an entry is left out
    assert_eq!(spaces.iter().map(|l| (l.problem.as_str(), l.name.as_str())).collect::<Vec<_>>(), [("sphere/3/6", "worse"), ("sphere/3/7", "bea")]);
    assert_eq!(spaces[1].id, beaten);
    // 200 keys in one call, as the route allows
    let many: Vec<ProblemKey> = (1..=200).map(|i| ProblemKey { n: 3.0, m: 3.0, p: i as f64 }).collect();
    assert!(store.leaders_of(&many).unwrap().is_empty());
}

/// describe("GET /api/leaders against the per-problem endpoints and the game's reading"): ties,
/// pending leaders, removals, edits, rows an older version left, disk and circle problems.
#[test]
fn agrees_on_ties_pending_leaders_removals_edits_and_disk_and_circle_problems() {
    let st = open(":memory:");
    let ins = |n: f64, m: f64, p: f64, score: f64, name: &str, v: &str| st.insert(&polygon(n, m, p, score, name, v)).unwrap();
    ins(4.0, 7.0, 2.0, 2.5, "ada", "none");
    ins(4.0, 7.0, 3.0, 3.0 * (1.0 + 5e-10), "early", "none"); // a tie within the tolerance: the earlier entry leads
    ins(4.0, 7.0, 3.0, 3.0, "late", "none");
    ins(4.0, 7.0, 4.0, 4.0, "confirmed", "confirmed"); // a pending leader with a confirmed entry behind it
    ins(4.0, 7.0, 4.0, 3.9, "pending", "pending");
    ins(4.0, 7.0, 5.0, 4.5, "ok", "none");
    ins(4.0, 7.0, 5.0, 4.0, "rej", "rejected"); // a row an older version left
    assert!(st.remove(ins(4.0, 7.0, 6.0, 5.0, "gone", "none")).unwrap());
    assert!(st.edit(ins(4.0, 7.0, 7.0, 5.0, "before", "none"), &EntryEdit { name: Some("after".into()), ..Default::default() }).unwrap());
    ins(4.0, 4.0, 3.0, 4.9, "beats", "none"); // under a published value that stands
    ins(5.0, 5.0, 2.0, 3.0, "ghost", "none"); // closed
    ins(0.0, 4.0, 3.0, 1.1, "disks", "none");
    ins(0.0, 0.0, 7.0, 3.0, "circles", "none");

    // the research records of the source's sphere problems are not the store's business: any scores do
    let ids: Vec<String> = (1..=8).map(|i| format!("sphere/3/{}", i + 3)).collect();
    let rec = |i: usize| 1.0 + i as f64 * 0.125;
    let sub = |problem: &str, score: f64, name: &str| st.space_submit(&space_entry(problem, score, name)).unwrap();
    sub(&ids[0], rec(0) * 1.5, "worse");
    sub(&ids[1], rec(1) * 0.5, "better");
    sub(&ids[2], rec(2), "equal");
    sub(&ids[3], rec(3) * (1.0 + 5e-10), "within-tie");
    sub(&ids[4], rec(4) * 0.5 * (1.0 + 5e-10), "tie-early");
    let late = sub(&ids[4], rec(4) * 0.5, "tie-late");
    assert!(!late.kept);
    assert_eq!(st.space_remove(sub(&ids[5], rec(5) * 0.5, "removed").id).unwrap().map(|r| r.problem), Some(ids[5].clone()));
    let edited = sub(&ids[6], rec(6) * 0.5, "old-name").id;
    assert!(st.space_edit(edited, &SpaceEntryEdit { name: Some("new-name".into()), agent_note: None }).unwrap().is_some());

    let polygons = ["4/7/2", "4/7/3", "4/7/4", "4/7/5", "4/7/6", "4/7/7", "4/4/3", "5/5/2", "3/3/1", "0/4/3", "0/0/7", "3/3/5"];
    let listed = st.leaders_of(&polygons.iter().map(|k| key(k)).collect::<Vec<_>>()).unwrap();
    for k in polygons {
        let q = key(k);
        // what /api/problems reads for the problem, against what /api/leaders reads
        let one = st.leader(q.n, q.m, q.p).unwrap();
        let of = listed.iter().find(|l| l.n == q.n && l.m == q.m && l.p == q.p);
        assert_eq!(
            of.map(|l| (l.score, l.name.clone(), l.id, l.verification.clone())),
            one.map(|b| (b.score, b.name, b.id, b.verification)),
            "{k}"
        );
    }
    let name_of = |k: &str| {
        let q = key(k);
        listed.iter().find(|l| l.n == q.n && l.m == q.m && l.p == q.p).map(|l| (l.name.as_str(), l.verification.as_str()))
    };
    assert_eq!(name_of("4/7/4"), Some(("pending", "pending")));
    assert_eq!(name_of("4/7/3"), Some(("early", "none")));
    assert_eq!(name_of("4/7/5"), Some(("ok", "none")));
    assert_eq!(name_of("4/7/6"), None);
    assert_eq!(name_of("4/7/7"), Some(("after", "none")));
    assert_eq!(name_of("3/3/5"), None);
    // in the order of (N, M, P), whatever the order asked
    let order: Vec<(f64, f64, f64)> = listed.iter().map(|l| (l.n, l.m, l.p)).collect();
    let mut by_key = order.clone();
    by_key.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(order, by_key);

    let problems: Vec<SpaceProblem> = ids.iter().map(|p| SpaceProblem { space: "sphere".into(), problem: p.clone() }).collect();
    let spaces = st.space_leaders_of(&problems).unwrap();
    for p in &problems {
        let one = st.space_leader(&p.space, &p.problem).unwrap();
        assert_eq!(spaces.iter().find(|l| l.problem == p.problem), one.as_ref(), "{}", p.problem);
    }
    let space_name = |i: usize| spaces.iter().find(|l| l.problem == ids[i]).map(|l| l.name.as_str());
    assert_eq!(space_name(4), Some("tie-early"));
    assert_eq!(space_name(5), None);
    assert_eq!(space_name(6), Some("new-name"));
    assert_eq!(space_name(7), None);
    // the whole listings agree with them
    assert_eq!(st.space_best("sphere").unwrap(), st.space_leaders().unwrap());
    assert_eq!(st.space_leaders().unwrap().len(), spaces.len());
    // every problem above but the removed one and the one never entered
    assert_eq!(st.leaders().unwrap().len(), 9);
}
