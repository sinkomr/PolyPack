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
    assert_eq!(e.message(), "stored pieces have 25 bytes, not a multiple of 24, and are not packed (they begin with 0)");
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

// ---- describe("packed pieces") --------------------------------------------------------------------

/// What packs well in real entries: rows of a lattice and angles that repeat.
fn lattice(count: usize) -> Vec<Pose> {
    (0..count).map(|i| Pose { x: (i % 17) as f64 * 1.0000000000000002, y: (i / 17) as f64 / 3.0, theta: 0.0 }).collect()
}

/// Deterministic doubles with every byte in use.
fn scattered(count: usize, seed: &mut u32) -> Vec<Pose> {
    let mut next = || {
        *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        *seed as f64 / 4294967296.0
    };
    (0..count).map(|_| Pose { x: (next() - 0.5) * 40.0, y: (next() - 0.5) * 40.0, theta: next() * 6.283 }).collect()
}

#[test]
fn comes_back_bit_for_bit_for_every_count_of_pieces_and_is_told_from_triples_by_its_length_alone() {
    let mut seed = 20261114u32;
    let (mut packed_seen, mut padded_seen) = (0, 0);
    for count in 0..=520 {
        for pieces in [scattered(count, &mut seed), lattice(count)] {
            let triples = encode_pieces(&pieces);
            let stored = pack_pieces(triples.clone()).unwrap();
            assert_eq!(unpack_pieces(&stored).unwrap().as_ref(), &triples[..]);
            assert!(same_bits(&pieces, &decode_pieces(&stored).unwrap()));
            assert!(same_bits(&pieces, &read_pieces(&JsVal::Blob(stored.clone())).unwrap().poses().unwrap()));
            if stored.len() % PIECE_BYTES == 0 {
                // kept as triples: packing did not shorten them
                assert_eq!(stored, triples);
                continue;
            }
            packed_seen += 1;
            assert!(stored.len() < triples.len());
            assert!(stored[0] == 1 || stored[0] == 2);
            if stored[0] == 2 {
                // the padded form: without its last byte, a zero, the length would be a multiple of 24
                padded_seen += 1;
                assert_eq!((stored.len() - 1) % PIECE_BYTES, 0);
                assert_eq!(stored[stored.len() - 1], 0);
            }
        }
    }
    assert!(packed_seen > 900 && padded_seen > 5, "{packed_seen} packed, {padded_seen} padded");
}

#[test]
fn packs_a_lattice_to_a_small_part_and_leaves_a_few_scattered_pieces_as_triples() {
    let big = encode_pieces(&lattice(500));
    assert!(pack_pieces(big.clone()).unwrap().len() < big.len() / 4);
    let few = encode_pieces(&scattered(2, &mut 7));
    assert_eq!(pack_pieces(few.clone()).unwrap(), few);
    assert_eq!(pack_pieces(vec![]).unwrap().len(), 0);
    let e = pack_pieces(vec![0u8; 25]).unwrap_err();
    assert!(matches!(e, StoreError::Range(_)));
    assert_eq!(e.message(), "pieces to pack have 25 bytes, not a multiple of 24");
}

#[test]
fn reads_triples_as_triples_whatever_their_first_bytes_are() {
    // doubles whose bytes begin as a packed value or a zstd frame does
    let mut tricky = vec![0u8; 48];
    tricky[0..8].copy_from_slice(&[1, 0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x30, 0x40]);
    tricky[24..32].copy_from_slice(&[2, 0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0]);
    assert_eq!(unpack_pieces(&tricky).unwrap().as_ref(), &tricky[..]);
    assert_eq!(decode_pieces(&tricky).unwrap().len(), 2);
}

#[test]
fn reads_a_value_packed_in_november_2026() {
    // written by packPieces of 30 lattice pieces; a zstd frame is read the same by every version of zstd
    let text = concat!(
        "01d002000042a4036d28b52ffd60d001dd0200040200000100f03f0040020840011014181c20222426282a2c2e304000005555d53f1900",
        "0d52e86b93825e190c2cfcb91420dc2fcc04d0662a77c031e064c5dd528e012733dd01c78672b2e26ea763c0092003dcb13218043c002c"
    );
    let packed: Vec<u8> = (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect();
    assert!(same_bits(&lattice(30), &decode_pieces(&packed).unwrap()));
    // and today's library writes the same bytes
    assert_eq!(pack_pieces(encode_pieces(&lattice(30))).unwrap(), packed);
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
    // stored packed: a BLOB shorter than the triples, which unpacks to them
    let r = store.db().prepare("SELECT pieces FROM submissions WHERE id = ?").unwrap().get(&[id.into()]).unwrap().unwrap();
    let JsVal::Blob(stored) = r.get("pieces") else {
        panic!("the pieces are stored as {}", r.get("pieces").type_of());
    };
    assert!(stored.len() < awkward().len() * PIECE_BYTES);
    assert_eq!(unpack_pieces(stored).unwrap().as_ref(), &encode_pieces(&awkward())[..]);
}
