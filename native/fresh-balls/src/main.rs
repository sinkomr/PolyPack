//! fresh-balls: a stub until the search is written; prints the result contract (native/FRESH.md) with no packing.
fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned();
    let id = get("--id").unwrap_or_default();
    let seed: u32 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seconds: f64 = get("--seconds").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    println!("{}", serde_json::json!({"solver": "fresh-balls", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu", "score": null, "config": null, "evaluations": 0, "check_valid": null, "trace": []}));
}
