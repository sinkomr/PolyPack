//! apps/server/test/pieces.test.ts, case for case.

use std::f64::consts::PI;

use super::*;

/// packages/geometry: MAX_COORD, the largest coordinate a configuration may hold.
const MAX_COORD: f64 = 1e6;

fn awkward() -> Vec<Pose> {
    vec![
        Pose { x: -0.0, y: 0.0, theta: -0.0 },
        Pose { x: MAX_COORD, y: -MAX_COORD, theta: PI },
        Pose { x: 5e-324, y: -5e-324, theta: 5e-324 },
        Pose { x: 0.1 + 0.2, y: 1.0 / 3.0, theta: -PI / 4.0 },
        Pose { x: f64::MAX, y: -f64::MAX, theta: 1e308 },
        Pose { x: 999999.9999999999, y: -2.2250738585072014e-308, theta: 123456.789 },
    ]
}

// ---- describe("binary pieces") --------------------------------------------------------------------

#[test]
fn round_trips_every_double_exactly_minus_zero_included_in_24_bytes_per_piece() {
    let bytes = encode_pieces(&awkward());
    assert_eq!(bytes.len(), awkward().len() * PIECE_BYTES);
    assert!(same_bits(&awkward(), &decode_pieces(&bytes).unwrap()));
    // -0 is exactly what JSON loses
    let through_json = json::parse(&poses_json(&awkward())).unwrap();
    assert!(!through_json[0]["x"].as_f64().unwrap().is_sign_negative());
    assert_eq!(decode_pieces(&encode_pieces(&[])).unwrap(), vec![]);
}

/// A coordinate as the source's fast-check arbitrary draws it: within the coordinate limit, any
/// finite double, or one of the edge values.
fn coord(rng: &mut Rng) -> f64 {
    match rng.int(0, 2) {
        0 => (rng.next() as f64 / u64::MAX as f64 * 2.0 - 1.0) * MAX_COORD,
        1 => loop {
            let x = f64::from_bits(rng.next());
            if x.is_finite() {
                break x;
            }
        },
        _ => rng.pick(&[-0.0, 0.0, MAX_COORD, -MAX_COORD]),
    }
}

#[test]
fn round_trips_arbitrary_finite_doubles_within_the_coordinate_limit_and_beyond() {
    let mut rng = Rng::new(20261018);
    for _ in 0..500 {
        let n = rng.int(0, 50) as usize;
        let pieces: Vec<Pose> =
            (0..n).map(|_| Pose { x: coord(&mut rng), y: coord(&mut rng), theta: coord(&mut rng) }).collect();
        let back = decode_pieces(&encode_pieces(&pieces)).unwrap();
        assert!(same_bits(&pieces, &back));
    }
}

#[test]
fn is_little_endian_whatever_the_machine() {
    // 1.0 is 0x3FF0000000000000; little-endian puts the 0xF0 0x3F last
    assert_eq!(encode_pieces(&[Pose { x: 1.0, y: 0.0, theta: 0.0 }])[0..8], [0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
}

#[test]
fn reads_a_buffer_at_any_offset_as_a_driver_may_hand_it_over() {
    let bytes = encode_pieces(&awkward());
    let mut shifted = vec![0u8; bytes.len() + 3];
    shifted[3..].copy_from_slice(&bytes);
    assert!(same_bits(&awkward(), &decode_pieces(&shifted[3..]).unwrap()));
    let e = decode_pieces(&[0u8; 25]).unwrap_err();
    assert!(matches!(e, StoreError::Range(_)));
    assert_eq!(e.message(), "stored pieces have 25 bytes, not a multiple of 24");
}

#[test]
fn reads_both_stored_forms() {
    assert_eq!(read_pieces(&JsVal::Blob(encode_pieces(&awkward()))).unwrap(), Pieces::Poses(awkward()));
    assert!(same_bits(&awkward(), &read_pieces(&JsVal::Blob(encode_pieces(&awkward()))).unwrap().poses().unwrap()));
    let text = poses_json(&[Pose { x: 1.5, y: -2.0, theta: 0.25 }]);
    assert_eq!(read_pieces(&JsVal::Text(text)).unwrap().poses().unwrap(), vec![Pose { x: 1.5, y: -2.0, theta: 0.25 }]);
    let e = read_pieces(&JsVal::Num(3.0)).unwrap_err();
    assert!(matches!(e, StoreError::Type(_)));
    assert_eq!(e.message(), "unexpected stored pieces of type number");
}

#[test]
fn converts_the_older_json_text_only_when_it_is_exactly_a_list_of_poses() {
    let poses: Vec<Pose> = awkward().into_iter().filter(|p| p.x.abs() <= MAX_COORD).collect();
    let blob = blob_from_json(&poses_json(&poses)).unwrap();
    // JSON wrote -0 as 0, so what comes back is what the text held
    let held = read_pieces(&JsVal::Text(poses_json(&poses))).unwrap().poses().unwrap();
    assert!(same_bits(&decode_pieces(&blob).unwrap(), &held));
    assert_eq!(decode_pieces(&blob_from_json("[]").unwrap()).unwrap(), vec![]);
    for bad in [
        "",
        "{",
        "{}",
        "[1, 2]",
        "[null]",
        "[[1, 2, 3]]",
        r#"[{"x": 1, "y": 2}]"#,
        r#"[{"x": 1, "y": 2, "theta": "3"}]"#,
        r#"[{"x": 1, "y": 2, "theta": 3, "extra": 4}]"#,
        r#"[{"x": 1e999, "y": 2, "theta": 3}]"#,
    ] {
        assert_eq!(blob_from_json(bad), None, "{bad}");
    }
}

// ---- describe("the store keeps pieces exactly") ---------------------------------------------------

#[test]
fn returns_what_was_stored_minus_zero_and_the_coordinate_limit_included() {
    let store = open(":memory:");
    let mut e = entry(4.0, 4.0, awkward().len() as f64, 1.0, "exact");
    e.pieces = awkward();
    let id = store.insert(&e).unwrap();
    assert!(same_bits(&awkward(), &stored_poses(&store.get(id).unwrap().unwrap())));
    assert!(same_bits(&awkward(), &stored_poses(&store.get_many(&[id]).unwrap()[0])));
    let r = store
        .db()
        .prepare("SELECT typeof(pieces) AS t, length(pieces) AS n FROM submissions WHERE id = ?")
        .unwrap()
        .get(&[id.into()])
        .unwrap()
        .unwrap();
    assert_eq!((r.text("t").unwrap().as_str(), r.num("n").unwrap()), ("blob", (awkward().len() * PIECE_BYTES) as f64));
}
