//! Port of apps/server/src/units-gate.ts: the unit change of 2026-10-27 at the API's edge. A
//! submission to a problem with disk or ball pieces or a circle or ball container must say that it
//! is in the new units, and volunteer clients too old to know are told to update.

use crate::js;
use crate::store::{planar_factors, space_plan, SpaceIds, SpacePlanResult};

/// units-gate.ts: CONVENTIONS_VERSION. Version of the API's conventions: 2 since the unit change
/// (disk and ball pieces have diameter 1).
pub const CONVENTIONS_VERSION: f64 = 2.0;
/// units-gate.ts: UNITS_DATE. The date the unit change was made (the first day of version 2).
pub const UNITS_DATE: &str = "2026-10-27";
/// units-gate.ts: VOLUNTEER_MIN_VERSION. The oldest volunteer client the server answers: 0.3.0
/// draws its problems itself, at random (2026-10-29), where 0.2.x read the work lists that were
/// removed then; 0.2.0 was the first to send `units` and work in diameter units.
pub const VOLUNTEER_MIN_VERSION: &str = "0.3.0";

/// units-gate.ts: UNITS_EXPLANATION.
pub fn units_explanation() -> String {
    format!(
        "Since {UNITS_DATE} (API conventions version {}) disk and ball pieces have diameter 1 (radius 1/2), \
         and a circle or ball container is scored by its diameter. A 2D disk configuration of the old units becomes the new one \
         by multiplying the x and y of every piece by 1/2 (disks in a polygon container: the score also halves; disks in a circle: \
         the score stays; polygons in a circle: the score doubles).",
        polypack_js::fmt::num(CONVENTIONS_VERSION)
    )
}

/// units-gate.ts: UPGRADE_MESSAGE. The sentence an old volunteer client is answered with (426).
pub fn upgrade_message() -> String {
    format!(
        "This volunteer client is out of date. Since 2026-10-29 the client draws each problem at random itself, and the work \
         lists that earlier versions read (/api/targets and /api/spaces/targets) were removed; versions before 0.2.0 also work \
         in the units before {UNITS_DATE}, with disks and balls of radius 1. Update the PolyPack volunteer client to \
         {VOLUNTEER_MIN_VERSION} or later: https://polypack.fly.dev/volunteer.html"
    )
}

/// units-gate.ts: UNITS_MISSING_MESSAGE.
pub fn units_missing_message() -> String {
    format!(
        "this problem has disk or ball pieces or a circle or ball container, and the units changed on {UNITS_DATE}: \
         send \"units\": \"diameter\" to confirm the configuration is in the new units (disk and ball pieces of diameter 1; circle and ball \
         containers scored by their diameter). {} The volunteer client {VOLUNTEER_MIN_VERSION} or later does this.",
        units_explanation()
    )
}

/// units-gate.ts: volunteerVersion. The version of a `polypack-volunteer/<version>` User-Agent as
/// [major, minor, patch], or None for any other client. The expression is
/// `/polypack-volunteer\/(\d+)\.(\d+)(?:\.(\d+))?/i`, and each part is read with `Number`.
pub fn volunteer_version(user_agent: Option<&str>) -> Option<[f64; 3]> {
    let text = user_agent.unwrap_or("");
    let lower = text.to_ascii_lowercase();
    let b = lower.as_bytes();
    const NEEDLE: &str = "polypack-volunteer/";
    let mut from = 0;
    // the first place where the whole expression matches
    while let Some(at) = lower[from..].find(NEEDLE) {
        let start = from + at + NEEDLE.len();
        let digits = |i: usize| b[i.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
        let major = digits(start);
        if major > 0 && b.get(start + major) == Some(&b'.') {
            let minor_at = start + major + 1;
            let minor = digits(minor_at);
            if minor > 0 {
                let mut patch = 0.0;
                if b.get(minor_at + minor) == Some(&b'.') {
                    let patch_at = minor_at + minor + 1;
                    let n = digits(patch_at);
                    if n > 0 {
                        patch = js::number(&lower[patch_at..patch_at + n]);
                    }
                }
                return Some([js::number(&lower[start..start + major]), js::number(&lower[minor_at..minor_at + minor]), patch]);
            }
        }
        from = from + at + 1;
    }
    None
}

/// units-gate.ts: isOldVolunteer. True for a volunteer client older than VOLUNTEER_MIN_VERSION.
pub fn is_old_volunteer(user_agent: Option<&str>) -> bool {
    let Some(v) = volunteer_version(user_agent) else {
        return false;
    };
    let min: Vec<f64> = VOLUNTEER_MIN_VERSION.split('.').map(js::number).collect();
    for i in 0..3 {
        if v[i] != min[i] {
            return v[i] < min[i];
        }
    }
    false
}

/// units-gate.ts: planarAffected. True when a 2D problem has disk pieces or a circle container.
pub fn planar_affected(n: f64, m: f64) -> bool {
    planar_factors(n, m).is_some()
}

/// units-gate.ts: spaceAffected. True when a problem of a space has disk or ball pieces or a
/// circle or ball container (curved disks at K != 0 included).
pub fn space_affected(spaces: &dyn SpaceIds, space: &str, id: &str) -> bool {
    if !spaces.is_space_name(space) {
        return false;
    }
    !matches!(space_plan(spaces, space, id), SpacePlanResult::Unaffected)
}

/// units-gate.ts: oldClientMayRead. What a request from an old volunteer may still read: the API
/// page, the health check and the snapshot.
pub fn old_client_may_read(method: &str, path: &str) -> bool {
    if method != "GET" {
        return false;
    }
    path == "/api" || path == "/api/health" || path == "/api/snapshot" || path.starts_with("/api/snapshot/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volunteer_versions() {
        assert_eq!(volunteer_version(Some("polypack-volunteer/0.1.4")), Some([0.0, 1.0, 4.0]));
        assert_eq!(volunteer_version(Some("POLYPACK-VOLUNTEER/0.2")), Some([0.0, 2.0, 0.0]));
        assert_eq!(volunteer_version(Some("Mozilla/5.0 polypack-volunteer/0.1 like")), Some([0.0, 1.0, 0.0]));
        assert_eq!(volunteer_version(Some("polypack-volunteer/00.02.9")), Some([0.0, 2.0, 9.0]));
        assert_eq!(volunteer_version(Some("polypack-volunteer/0.3.")), Some([0.0, 3.0, 0.0]));
        assert_eq!(volunteer_version(Some("polypack-volunteer/abc polypack-volunteer/1.2.3")), Some([1.0, 2.0, 3.0]));
        for ua in ["polypack-volunteer/abc", "polypack-volunteer/", "curl/8", "", "polypack-volunteer/1"] {
            assert_eq!(volunteer_version(Some(ua)), None, "{ua}");
        }
        assert_eq!(volunteer_version(None), None);
    }

    #[test]
    fn old_volunteers() {
        for ua in ["polypack-volunteer/0.1.4", "polypack-volunteer/0.2.0", "polypack-volunteer/0.2.9 (node 22)", "POLYPACK-VOLUNTEER/0.2", "Mozilla/5.0 polypack-volunteer/0.1 like", "polypack-volunteer/00.02.9", "polypack-volunteer/0.2.99999999999999999999"] {
            assert!(is_old_volunteer(Some(ua)), "{ua}");
        }
        for ua in ["polypack-volunteer/0.3.0", "polypack-volunteer/0.10.0", "polypack-volunteer/1.0", "curl/8", "polypack-volunteer/abc", "polypack-volunteer/0.3", "polypack-volunteer/", ""] {
            assert!(!is_old_volunteer(Some(ua)), "{ua}");
        }
        assert!(!is_old_volunteer(None));
    }

    #[test]
    fn what_an_old_client_may_read() {
        assert!(old_client_may_read("GET", "/api"));
        assert!(old_client_may_read("GET", "/api/health"));
        assert!(old_client_may_read("GET", "/api/snapshot"));
        assert!(old_client_may_read("GET", "/api/snapshot/4-4.json.gz"));
        assert!(!old_client_may_read("HEAD", "/api/health"));
        assert!(!old_client_may_read("GET", "/api/snapshotx"));
        assert!(!old_client_may_read("GET", "/api/"));
        assert!(!old_client_may_read("POST", "/api/snapshot"));
    }

    #[test]
    fn the_messages_are_the_sources() {
        assert!(units_missing_message().starts_with("this problem has disk or ball pieces or a circle or ball container, and the units changed on 2026-10-27: send \"units\": \"diameter\" to confirm"));
        assert!(units_missing_message().ends_with("the score doubles). The volunteer client 0.3.0 or later does this."));
        assert!(upgrade_message().ends_with("Update the PolyPack volunteer client to 0.3.0 or later: https://polypack.fly.dev/volunteer.html"));
        assert!(units_explanation().starts_with("Since 2026-10-27 (API conventions version 2) disk and ball pieces have diameter 1 (radius 1/2), and a circle"));
    }
}
