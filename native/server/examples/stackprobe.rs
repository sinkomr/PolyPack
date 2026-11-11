//! How much stack the server's handling of a deeply nested JSON value needs: the measurement
//! behind `pool::THREAD_STACK_BYTES`.
//!
//!   cargo run -p polypack-server --example stackprobe -- OP DEPTH STACK_BYTES
//!
//! runs one operation on a value nested DEPTH levels deep, on a thread whose stack is STACK_BYTES,
//! and prints "ok". A stack that is too small ends the process with a signal, so the smallest
//! stack that works is found from outside, by halving (`stackprobe search DEPTH` does that with
//! copies of itself, for every operation, and prints a table).
//!
//! The operations are the ones that call themselves once per level of a `serde_json::Value`:
//! what a submission whose `method_params` nests as deep as it can goes through, and a stored row
//! on its way out.

use std::process::Command;

use serde_json::Value;

const OPS: [&str; 9] = ["parse", "clone", "flat-stringify", "store-stringify", "store-parse", "answer", "serde-string", "equal", "drop"];

/// `{"a":[[[ ... 1 ... ]]]}` or `{"a":{"a": ... }}`, `depth` levels in all.
fn text(depth: usize, objects: bool) -> String {
    if objects {
        format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth))
    } else {
        format!("{{\"a\":{}1{}}}", "[".repeat(depth - 1), "]".repeat(depth - 1))
    }
}

fn run(op: &str, depth: usize, stack: usize) {
    for objects in [false, true] {
        let text = text(depth, objects);
        // the value is made, and whatever is left of it released, on a stack that is large enough
        let value = on_a_stack_of(1 << 30, {
            let text = text.clone();
            move || polypack_js::json::parse(text.as_bytes()).expect("a text within the limit")
        });
        let op = op.to_string();
        // a second one, equal to it, for the operations that need two
        let twin = on_a_stack_of(1 << 30, {
            let text = text.clone();
            move || polypack_js::json::parse(text.as_bytes()).expect("a text within the limit")
        });
        let op = op.to_string();
        // what is left of the values goes back out, so that only the operation runs on this stack
        let left = on_a_stack_of(stack, move || -> Vec<Value> {
            match op.as_str() {
                "parse" => vec![polypack_js::json::parse(text.as_bytes()).expect("a text within the limit"), value, twin],
                "clone" => vec![value.clone(), value, twin],
                "flat-stringify" => {
                    assert_eq!(polypack_flat::provenance::json_stringify(&value), text);
                    vec![value, twin]
                }
                "store-stringify" => {
                    assert_eq!(polypack_server::store::json::stringify(&value), text);
                    vec![value, twin]
                }
                "store-parse" => vec![polypack_server::store::json::parse(&text).expect("a text within the limit"), value, twin],
                "answer" => {
                    assert_eq!(polypack_js::json::to_vec(&value), text.as_bytes());
                    vec![value, twin]
                }
                "serde-string" => {
                    assert_eq!(value.to_string(), text);
                    vec![value, twin]
                }
                "equal" => {
                    assert!(value == twin);
                    vec![value, twin]
                }
                "drop" => {
                    drop(value);
                    vec![twin]
                }
                other => panic!("no operation {other}: one of {OPS:?}"),
            }
        });
        on_a_stack_of(1 << 30, move || drop(left));
    }
}

fn on_a_stack_of<T: Send + 'static>(bytes: usize, f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new().stack_size(bytes).spawn(f).expect("a thread").join().expect("the operation")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let number = |i: usize| -> usize { args.get(i).and_then(|a| a.parse().ok()).unwrap_or_else(|| panic!("usage: stackprobe OP DEPTH STACK_BYTES | stackprobe search DEPTH")) };
    if args.first().map(String::as_str) == Some("search") {
        let depth = number(1);
        let me = std::env::current_exe().expect("this program");
        println!("depth {depth}: the smallest stack on which each operation works, to 4 KiB");
        for op in OPS {
            let works = |stack: usize| Command::new(&me).args([op, &depth.to_string(), &stack.to_string()]).output().is_ok_and(|o| o.status.success());
            // the smallest stack that works lies in (low, high]
            let (mut low, mut high) = (0usize, 1usize << 30);
            assert!(works(high), "{op} fails even on 1 GiB");
            while high - low > 4096 {
                let mid = (low + high) / 2;
                if works(mid) {
                    high = mid;
                } else {
                    low = mid;
                }
            }
            println!("{op:16} {:8.1} KiB  ({:.0} bytes a level)", high as f64 / 1024.0, high as f64 / depth as f64);
        }
        return;
    }
    run(&args[0], number(1), number(2));
    println!("ok");
}
