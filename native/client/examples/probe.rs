use polypack_spaces::*;
use serde_json::json;
fn main() {
    let d = space_domain(SpaceName::Sphere).unwrap();
    let p = parse_space_id(SpaceName::Sphere, "sphere/0/1").unwrap();
    println!("bound {:?}", d.bound(&p));
    for rho in [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0] {
        let v = validate_space_submission(SpaceName::Sphere, "sphere/0/1", &json!({"rho": rho, "pieces": [{"q": [1.0,0.0,0.0,0.0]}]}), &SpaceValidateOptions { no_record: true, ..Default::default() });
        println!("{rho} {} {:?} {:?}", v.valid, v.score, v.reasons);
    }
}
