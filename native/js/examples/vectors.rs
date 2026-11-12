//! Checks polypack-js against Node, bit for bit.
//!
//!   vectors <file.bin>            the Math functions against the binary vectors of
//!                                 `native/tools/jsmath-vectors.mts --bin` (a million arguments per
//!                                 function). Exit code 1 on ANY result that is not the same bits
//!                                 (any NaN equals any NaN), except for the functions of
//!                                 `TOLERATED`, which only may not exceed their units in the last
//!                                 place.
//!                                 The reference is Node on x86-64 (the server: Node 24 on Linux).
//!                                 Vectors made by Node on arm64 are a reference only for the
//!                                 functions outside `FUSED`: that build of V8 fuses multiply and
//!                                 add, and its other results differ in the last place for up to
//!                                 0.6% of arguments (see src/fdlibm.rs). For such a file those
//!                                 functions are listed and held to `FUSED_ULPS`, not to equality.
//!   vectors <file.jsonl>          the number formats (and a small sample of the Math functions)
//!                                 against the JSON lines of the same tool without `--bin`.
//!   vectors --compare <a> <b>     two binary files (two platforms, two versions of Node, or the
//!                                 correctly rounded powers of `jsmath-powref.py` as <b>): the
//!                                 arguments must be the same, the results are compared.
//!   vectors --bench               nanoseconds per call, polypack_js::math against the `libm` crate.
//!   vectors --fixture <file.bin>  a few hundred vectors of each function of the file as text, for
//!                                 the tests that run without Node (src/fdlibm_vectors.txt from the
//!                                 file of Node 24 on Linux x86-64, src/math/pow_vectors.txt from
//!                                 the file of jsmath-powref.py).
//!
//!   node native/tools/jsmath-vectors.mts --bin vec.bin
//!   cargo run --release -p polypack-js --example vectors -- vec.bin

use polypack_js::{fmt, math};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};

/// Functions that are not required to give Node's bits, with the largest difference allowed in
/// units in the last place. `pow` is the platform's C library in V8 (`std::pow`), which differs
/// between macOS and Linux; here it is correctly rounded (see `math::pow`).
const TOLERATED: [(&str, u64); 1] = [("pow", 1)];

/// The functions whose bits depend on whether V8's compiler fused `a * b + c`: all of fdlibm's
/// except `log2`. On arm64 it does, and Node's results are not this crate's.
const FUSED: [&str; 19] = [
    "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "atanh", "asinh", "acosh", "cbrt", "exp", "expm1", "sinh", "cosh", "tanh", "log", "log1p",
    "log10",
];
/// The largest difference seen between the two builds of V8 (cosh and tanh).
const FUSED_ULPS: u64 = 3;

enum Fun {
    One(fn(f64) -> f64),
    Two(fn(f64, f64) -> f64),
    Many(fn(&[f64]) -> f64),
}

fn function(name: &str) -> Option<Fun> {
    Some(match name {
        "sin" => Fun::One(math::sin),
        "cos" => Fun::One(math::cos),
        "tan" => Fun::One(math::tan),
        "asin" => Fun::One(math::asin),
        "acos" => Fun::One(math::acos),
        "atan" => Fun::One(math::atan),
        "atanh" => Fun::One(math::atanh),
        "asinh" => Fun::One(math::asinh),
        "acosh" => Fun::One(math::acosh),
        "cbrt" => Fun::One(math::cbrt),
        "exp" => Fun::One(math::exp),
        "expm1" => Fun::One(math::expm1),
        "sinh" => Fun::One(math::sinh),
        "cosh" => Fun::One(math::cosh),
        "tanh" => Fun::One(math::tanh),
        "log" => Fun::One(math::log),
        "log1p" => Fun::One(math::log1p),
        "log2" => Fun::One(math::log2),
        "log10" => Fun::One(math::log10),
        "sqrt" => Fun::One(math::sqrt),
        "round" => Fun::One(math::round),
        "atan2" => Fun::Two(math::atan2),
        "pow" => Fun::Two(math::pow),
        "hypot" => Fun::Many(math::hypot_of),
        _ => return None,
    })
}

fn apply(f: &Fun, a: &[f64]) -> f64 {
    match f {
        Fun::One(f) => f(a[0]),
        Fun::Two(f) => f(a[0], a[1]),
        Fun::Many(f) => f(a),
    }
}

fn bits(v: &serde_json::Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().expect("hex"), 16).expect("hex"))
}

/// Units in the last place between two results: 0 for the same bits and for two NaN, `u64::MAX`
/// when one is NaN or the signs differ (so -0 against +0 counts).
fn ulps(a: f64, b: f64) -> u64 {
    if a.is_nan() && b.is_nan() {
        return 0;
    }
    if a.is_nan() != b.is_nan() || a.is_sign_negative() != b.is_sign_negative() {
        return u64::MAX;
    }
    a.to_bits().abs_diff(b.to_bits())
}

/// Count, different, largest difference in ulps, first examples.
#[derive(Default)]
struct Stat {
    n: u64,
    different: u64,
    max: u64,
    examples: Vec<String>,
}

impl Stat {
    fn add(&mut self, a: &[f64], want: f64, got: f64, names: (&str, &str)) {
        self.n += 1;
        let d = ulps(want, got);
        if d != 0 {
            self.different += 1;
            self.max = self.max.max(d);
            if self.examples.len() < 4 {
                let hex: Vec<String> = a.iter().map(|x| format!("{:016x}", x.to_bits())).collect();
                self.examples.push(format!(
                    "{:?} [{}] -> {} {:e} ({:016x}), {} {:e} ({:016x})",
                    a,
                    hex.join(" "),
                    names.0,
                    want,
                    want.to_bits(),
                    names.1,
                    got,
                    got.to_bits()
                ));
            }
        }
    }
}

fn print_table(stats: &BTreeMap<String, Stat>) {
    println!("{:<18} {:>9} {:>9} {:>10}", "function", "vectors", "different", "max ulps");
    for (f, s) in stats {
        let max = if s.max == u64::MAX { "sign/NaN".to_string() } else { s.max.to_string() };
        println!("{:<18} {:>9} {:>9} {:>10}", f, s.n, s.different, max);
        for e in &s.examples {
            println!("    {e}");
        }
    }
}

/// A binary vector file, read section by section.
struct Sections {
    file: BufReader<std::fs::File>,
    pub meta: serde_json::Value,
}

struct Section {
    name: String,
    arity: usize,
    n: usize,
    args: Vec<f64>,
    results: Vec<f64>,
}

impl Sections {
    fn open(path: &str) -> Self {
        let mut file = BufReader::new(std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}")));
        let mut magic = [0u8; 8];
        file.read_exact(&mut magic).expect("magic");
        assert_eq!(&magic, b"JSMATHV1", "{path} is not a binary vector file");
        let mut s = Sections { file, meta: serde_json::Value::Null };
        s.meta = s.json().expect("header");
        s
    }
    fn json(&mut self) -> Option<serde_json::Value> {
        let mut len = [0u8; 4];
        match self.file.read_exact(&mut len) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return None,
            Err(e) => panic!("read: {e}"),
        }
        let mut text = vec![0u8; u32::from_le_bytes(len) as usize];
        self.file.read_exact(&mut text).expect("json");
        Some(serde_json::from_slice(&text).expect("json"))
    }
    fn doubles(&mut self, n: usize) -> Vec<f64> {
        let mut raw = vec![0u8; 8 * n];
        self.file.read_exact(&mut raw).expect("doubles");
        raw.as_chunks::<8>().0.iter().map(|c| f64::from_le_bytes(*c)).collect()
    }
    fn next(&mut self) -> Option<Section> {
        let head = self.json()?;
        let name = head["name"].as_str().expect("name").to_string();
        let arity = head["arity"].as_u64().expect("arity") as usize;
        let n = head["n"].as_u64().expect("n") as usize;
        let args = self.doubles(n * arity);
        let results = self.doubles(n);
        Some(Section { name, arity, n, args, results })
    }
}

fn check_binary(path: &str) -> bool {
    let mut file = Sections::open(path);
    println!("{path}: {}", file.meta);
    let mut stats: BTreeMap<String, Stat> = BTreeMap::new();
    while let Some(s) = file.next() {
        let f = function(&s.name).unwrap_or_else(|| panic!("unknown function {}", s.name));
        let stat = stats.entry(s.name.clone()).or_default();
        for i in 0..s.n {
            let a = &s.args[i * s.arity..(i + 1) * s.arity];
            stat.add(a, s.results[i], apply(&f, a), ("node", "rust"));
        }
    }
    print_table(&stats);
    let fused = file.meta["arch"] == "arm64";
    if fused {
        println!("These vectors come from Node on arm64, whose V8 fuses multiply and add: they are not a reference for");
        println!("{} (held to {FUSED_ULPS} ulp here). The reference is Node on x86-64.", FUSED.join(", "));
    }
    verdict(&stats, fused)
}

/// False when a function that must be exact differs, or a tolerated one differs by too much.
/// `fused`: the vectors are from a build of V8 that fuses multiply and add.
fn verdict(stats: &BTreeMap<String, Stat>, fused: bool) -> bool {
    let mut bad = Vec::new();
    for (f, s) in stats {
        let allowed = match TOLERATED.iter().find(|t| t.0 == f) {
            Some(t) => Some(t.1),
            None if fused && FUSED.contains(&f.as_str()) => Some(FUSED_ULPS),
            None => None,
        };
        match allowed {
            Some(ulps) if s.max <= ulps => {}
            Some(ulps) => bad.push(format!("{f}: off by more than {ulps} ulp")),
            None if s.different == 0 => {}
            None => bad.push(format!("{f}: {} results differ", s.different)),
        }
    }
    if bad.is_empty() {
        let tolerated: Vec<String> = TOLERATED.iter().map(|t| format!("{} within {} ulp", t.0, t.1)).collect();
        if fused {
            println!("identical bits for the functions that do not depend on fusion, except: {}", tolerated.join(", "));
        } else {
            println!("identical bits for every function, except: {}", tolerated.join(", "));
        }
        true
    } else {
        println!("FAILED: {}", bad.join("; "));
        false
    }
}

fn compare(a: &str, b: &str) -> bool {
    let mut fa = Sections::open(a);
    let mut fb = Sections::open(b);
    println!("A = {a}: {}\nB = {b}: {}", fa.meta, fb.meta);
    let mut stats: BTreeMap<String, Stat> = BTreeMap::new();
    let mut same_arguments = true;
    // B may hold only some of A's sections (in the same order): the others of A are passed over
    while let Some(sb) = fb.next() {
        let sa = loop {
            match fa.next() {
                Some(s) if s.name == sb.name && s.arity == sb.arity => break s,
                Some(_) => {}
                None => {
                    println!("section {} of B is not in A", sb.name);
                    return false;
                }
            }
        };
        if sa.n != sb.n {
            println!("section {}: not the same number of vectors", sa.name);
            return false;
        }
        let differing = sa.args.iter().zip(&sb.args).filter(|(x, y)| ulps(**x, **y) != 0).count();
        if differing > 0 {
            println!("section {}: {} arguments differ between the files", sa.name, differing);
            same_arguments = false;
            continue;
        }
        let stat = stats.entry(sa.name.clone()).or_default();
        for i in 0..sa.n {
            stat.add(&sa.args[i * sa.arity..(i + 1) * sa.arity], sa.results[i], sb.results[i], ("A", "B"));
        }
    }
    print_table(&stats);
    let different: Vec<&str> = stats.iter().filter(|(_, s)| s.different > 0).map(|(f, _)| f.as_str()).collect();
    if different.is_empty() {
        println!("the two files have the same results for every function");
    } else {
        println!("the two files differ for: {}", different.join(", "));
    }
    same_arguments
}

/// The first 160 vectors of each section (the special values) and 120 spread over the rest, one a
/// line: the function, the bits of the arguments, the bits of the result.
fn fixture(path: &str) {
    let mut file = Sections::open(path);
    println!("# {}", file.meta);
    while let Some(s) = file.next() {
        if s.name == "hypot" || s.name == "sqrt" || s.name == "round" {
            continue;
        }
        let step = (s.n.saturating_sub(160) / 120).max(1);
        for i in (0..s.n).filter(|i| *i < 160 || (i - 160) % step == 0) {
            let args: Vec<String> = s.args[i * s.arity..(i + 1) * s.arity].iter().map(|x| format!("{:016x}", x.to_bits())).collect();
            println!("{} {} {:016x}", s.name, args.join(" "), s.results[i].to_bits());
        }
    }
}

fn check_jsonl(path: &str) -> bool {
    let file = BufReader::new(std::fs::File::open(path).expect("vectors file"));
    let mut stats: BTreeMap<String, Stat> = BTreeMap::new();
    let mut formats_bad = 0u64;
    let mut fused = false;
    for line in file.lines() {
        let line = line.expect("line");
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(&line).expect("json");
        let f = v["f"].as_str().expect("f").to_string();
        if f == "meta" {
            // the first line: where the vectors were made
            println!("{path}: {v}");
            fused = v["arch"] == "arm64";
            continue;
        }
        let a: Vec<f64> = v["a"].as_array().expect("a").iter().map(bits).collect();
        let entry = stats.entry(f.clone()).or_default();
        if let Some(kind) = f.strip_prefix("fmt:") {
            entry.n += 1;
            let want = v["s"].as_str().expect("s");
            let p = v["p"].as_i64().unwrap_or(0);
            let got = match kind {
                "string" => fmt::num(a[0]),
                "exponential" => fmt::exponential(a[0], if p < 0 { None } else { Some(p as usize) }),
                "fixed" => fmt::fixed(a[0], p as usize),
                "precision" => fmt::precision(a[0], p as usize),
                _ => panic!("unknown format {kind}"),
            };
            if got != want {
                entry.different += 1;
                formats_bad += 1;
                if entry.examples.len() < 5 {
                    entry.examples.push(format!("{:e} p={p}: node {want}, rust {got}", a[0]));
                }
            }
            continue;
        }
        let fun = function(&f).unwrap_or_else(|| panic!("unknown function {f}"));
        entry.add(&a, bits(&v["r"]), apply(&fun, &a), ("node", "rust"));
    }
    print_table(&stats);
    if formats_bad > 0 {
        println!("FAILED: {formats_bad} formats differ");
    }
    if fused {
        println!("These vectors come from Node on arm64, whose V8 fuses multiply and add: they are not a reference for");
        println!("{} (held to {FUSED_ULPS} ulp here). The reference is Node on x86-64.", FUSED.join(", "));
    }
    stats.retain(|f, _| !f.starts_with("fmt:"));
    verdict(&stats, fused) && formats_bad == 0
}

/// Nanoseconds per call: best of 7 passes over 4096 arguments, 200 times each.
fn time1(f: impl Fn(f64) -> f64, xs: &[f64]) -> f64 {
    let mut best = f64::INFINITY;
    for _ in 0..7 {
        let start = std::time::Instant::now();
        let mut sum = 0.0;
        for _ in 0..200 {
            for &x in xs {
                sum += f(std::hint::black_box(x));
            }
        }
        std::hint::black_box(sum);
        best = best.min(start.elapsed().as_nanos() as f64 / (200.0 * xs.len() as f64));
    }
    best
}

fn bench() {
    // the constants of pow are computed at its first call that needs them
    let start = std::time::Instant::now();
    std::hint::black_box(math::pow(std::hint::black_box(1.7), 0.3));
    println!("first call of pow (its tables): {:.2} ms", start.elapsed().as_secs_f64() * 1e3);
    // xorshift: the same arguments on every run
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut rnd = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut uniform = |lo: f64, hi: f64| -> Vec<f64> { (0..4096).map(|_| lo + (hi - lo) * rnd()).collect() };
    let small = uniform(-0.78, 0.78);
    let turn = uniform(-7.0, 7.0);
    let many = uniform(-1000.0, 1000.0);
    let unit = uniform(-1.0, 1.0);
    let expo = uniform(-30.0, 30.0);
    let positive = uniform(0.001, 1000.0);
    let other = uniform(-5.0, 5.0);
    println!("{:<34} {:>12} {:>10} {:>7}", "nanoseconds per call", "polypack_js", "libm", "ratio");
    let row = |name: &str, ours: f64, theirs: f64| println!("{:<34} {:>12.2} {:>10.2} {:>7.2}", name, ours, theirs, ours / theirs);
    row("sin, |x| < pi/4", time1(math::sin, &small), time1(libm::sin, &small));
    row("sin, |x| < 7", time1(math::sin, &turn), time1(libm::sin, &turn));
    row("sin, |x| < 1000", time1(math::sin, &many), time1(libm::sin, &many));
    row("cos, |x| < pi/4", time1(math::cos, &small), time1(libm::cos, &small));
    row("cos, |x| < 7", time1(math::cos, &turn), time1(libm::cos, &turn));
    row("cos, |x| < 1000", time1(math::cos, &many), time1(libm::cos, &many));
    row("tan, |x| < 7", time1(math::tan, &turn), time1(libm::tan, &turn));
    row("asin, |x| < 1", time1(math::asin, &unit), time1(libm::asin, &unit));
    row("acos, |x| < 1", time1(math::acos, &unit), time1(libm::acos, &unit));
    row("atan, |x| < 5", time1(math::atan, &other), time1(libm::atan, &other));
    // atan2(y, x) with x the neighbouring argument
    let pair = |f: &dyn Fn(f64, f64) -> f64, xs: &[f64]| {
        let n = xs.len();
        let mut best = f64::INFINITY;
        for _ in 0..7 {
            let start = std::time::Instant::now();
            let mut sum = 0.0;
            for _ in 0..200 {
                for i in 0..n {
                    sum += f(std::hint::black_box(xs[i]), std::hint::black_box(xs[(i + 1) % n]));
                }
            }
            std::hint::black_box(sum);
            best = best.min(start.elapsed().as_nanos() as f64 / (200.0 * n as f64));
        }
        best
    };
    row("atan2, |x|, |y| < 5", pair(&math::atan2, &other), pair(&libm::atan2, &other));
    row("exp, |x| < 30", time1(math::exp, &expo), time1(libm::exp, &expo));
    row("log, 0.001 < x < 1000", time1(math::log, &positive), time1(libm::log, &positive));
    row("cbrt, |x| < 5", time1(math::cbrt, &other), time1(libm::cbrt, &other));
    let cube = |x: f64| math::pow(x, 3.0);
    let cube_libm = |x: f64| libm::pow(x, 3.0);
    row("pow(x, 3), 0.001 < x < 1000", time1(cube, &positive), time1(cube_libm, &positive));
    let root = |x: f64| math::pow(x, 1.0 / 3.0);
    let root_libm = |x: f64| libm::pow(x, 1.0 / 3.0);
    row("pow(x, 1/3)", time1(root, &positive), time1(root_libm, &positive));
    let inverse = |x: f64| math::pow(x, -3.0);
    let inverse_libm = |x: f64| libm::pow(x, -3.0);
    row("pow(x, -3)", time1(inverse, &positive), time1(inverse_libm, &positive));
    // pow(|y|, x) with the base below 5 and the exponent below 5 in size: no overflow
    let general = |y: f64, x: f64| math::pow(y.abs(), x);
    let general_libm = |y: f64, x: f64| libm::pow(y.abs(), x);
    row("pow(x, y), x < 5, |y| < 5", pair(&general, &other), pair(&general_libm, &other));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ok = match args.first().map(String::as_str) {
        Some("--bench") => {
            bench();
            true
        }
        Some("--compare") if args.len() == 3 => compare(&args[1], &args[2]),
        Some("--fixture") if args.len() == 2 => {
            fixture(&args[1]);
            true
        }
        Some(path) if args.len() == 1 => {
            let mut magic = [0u8; 8];
            let binary = std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"JSMATHV1";
            if binary {
                check_binary(path)
            } else {
                check_jsonl(path)
            }
        }
        _ => {
            eprintln!("usage: vectors <file.bin | file.jsonl> | --compare <a.bin> <b.bin> | --fixture <file.bin> | --bench");
            std::process::exit(2);
        }
    };
    if !ok {
        std::process::exit(1);
    }
}
