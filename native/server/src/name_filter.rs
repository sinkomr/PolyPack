//! name-filter.ts: the names entries may not carry, from data/names.json (its "about" says where each
//! list comes from). Both servers read the same file in the same steps:
//!
//! 1. The name in compatibility form (NFKC), so that full-width and styled letters are plain ones.
//! 2. A run of digits or of the symbols @ $ ! between two ASCII letters stands for letters: 0 o, 1 i,
//!    3 e, 4 a, 5 s, 7 t, @ a, $ s, ! i (n1gger, a55hole). Anywhere else a digit stays a digit
//!    (TighterGamePlayer2717975).
//! 3. Words: a break wherever a lowercase ASCII letter is followed by an uppercase one (CockNballz),
//!    then the ASCII letters in lowercase, split at every other character. An entry of `words` or
//!    `more_words` that is not in `not_words`, made into words the same way, is refused when its words
//!    appear consecutively among the name's. An entry with no ASCII letter (an emoji) is refused
//!    wherever it appears in the name of step 1.
//! 4. Within: the ASCII letters of step 2 alone, in lowercase; an entry of `within` is refused wherever
//!    it appears in them (NIGGERKILLER, F.U.C.K).
//! 5. Removed: a name whose SHA-256 is in `removed` is refused as it is.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use crate::store::sha256::Sha256;

/// name-filter.ts: ANONYMOUS. The name the store gives the entries of a removed name.
pub const ANONYMOUS: &str = "Anonymous";

/// name-filter.ts: NAME_REFUSED. What a refused name is told.
pub const NAME_REFUSED: &str = "this name is not accepted here: choose another name";

#[derive(Deserialize)]
struct NamesFile {
    words: Vec<String>,
    not_words: Vec<String>,
    more_words: Vec<String>,
    within: Vec<String>,
    removed: Vec<String>,
}

fn leet(c: char) -> char {
    match c {
        '0' => 'o',
        '1' | '!' => 'i',
        '3' => 'e',
        '4' | '@' => 'a',
        '5' | '$' => 's',
        '7' => 't',
        other => other,
    }
}

fn is_leet(c: char) -> bool {
    c.is_ascii_digit() || matches!(c, '@' | '$' | '!')
}

/// Step 2.
fn deleet(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if !is_leet(chars[i]) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_leet(chars[i]) {
            i += 1;
        }
        let between = start > 0 && chars[start - 1].is_ascii_alphabetic() && i < chars.len() && chars[i].is_ascii_alphabetic();
        out.extend(chars[start..i].iter().map(|&c| if between { leet(c) } else { c }));
    }
    out
}

/// Step 3, of a name already through steps 1 and 2.
fn words(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut previous: Option<char> = None;
    for c in s.chars() {
        let lower_then_upper = previous.is_some_and(|p| p.is_ascii_lowercase()) && c.is_ascii_uppercase();
        if !c.is_ascii_alphabetic() || lower_then_upper {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        }
        if c.is_ascii_alphabetic() {
            word.push(c.to_ascii_lowercase());
        }
        previous = Some(c);
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// Step 4, of a name already through steps 1 and 2.
fn letters(s: &str) -> String {
    s.chars().filter(char::is_ascii_alphabetic).map(|c| c.to_ascii_lowercase()).collect()
}

/// name-filter.ts: nameHash. SHA-256 of a name's UTF-8 bytes, in hex.
pub fn name_hash(name: &str) -> String {
    let mut h = Sha256::new();
    h.update(name.as_bytes());
    h.hex()
}

/// name-filter.ts: NameFilter. The lists of names.json, ready to match against.
pub struct NameFilter {
    phrases: Vec<Vec<String>>,
    symbols: Vec<String>,
    within: Vec<String>,
    removed: HashSet<String>,
}

impl NameFilter {
    fn new(file: NamesFile) -> NameFilter {
        let left: HashSet<&str> = file.not_words.iter().map(String::as_str).collect();
        let mut phrases = Vec::new();
        let mut symbols = Vec::new();
        for entry in file.words.iter().chain(file.more_words.iter()) {
            if left.contains(entry.as_str()) {
                continue;
            }
            let form: String = entry.nfkc().collect();
            let w = words(&deleet(&form));
            if w.is_empty() {
                symbols.push(form);
            } else {
                phrases.push(w);
            }
        }
        NameFilter { phrases, symbols, within: file.within, removed: file.removed.into_iter().collect() }
    }

    /// Whether a name (as stored: through sanitize_text) is one of the removed names.
    pub fn is_removed(&self, name: &str) -> bool {
        self.removed.contains(&name_hash(name))
    }

    /// Whether entries may not carry `name` (as stored: through sanitize_text).
    pub fn refuses(&self, name: &str) -> bool {
        if self.is_removed(name) {
            return true;
        }
        let form: String = name.nfkc().collect();
        if self.symbols.iter().any(|s| form.contains(s.as_str())) {
            return true;
        }
        let plain = deleet(&form);
        let squashed = letters(&plain);
        if self.within.iter().any(|w| squashed.contains(w.as_str())) {
            return true;
        }
        let w = words(&plain);
        self.phrases.iter().any(|p| w.windows(p.len()).any(|win| win == p.as_slice()))
    }
}

/// name-filter.ts: nameFilter. The filter of data/names.json, built once.
pub fn name_filter() -> &'static NameFilter {
    static FILTER: OnceLock<NameFilter> = OnceLock::new();
    FILTER.get_or_init(|| {
        NameFilter::new(serde_json::from_str(include_str!("../data/names.json")).expect("data/names.json holds the name lists"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_the_words_in_their_disguises() {
        let f = name_filter();
        for name in ["N1GGER", "a55hole", "F.U.C.K", "Nazi", "\u{ff2e}\u{ff29}\u{ff27}\u{ff27}\u{ff25}\u{ff32}", "\u{1f595} hi", "cum", "CockNballz", "Hitler was right"] {
            assert!(f.refuses(name), "{name}");
        }
        for name in ["xXGamerXx", "Peacock", "Dickens", "Cumquat1", "Ignazio", "Gr8 Player", "Rio Negro", "Shrimp", "TighterGamePlayer2717975", "Anonymous", "Michael Sinko"] {
            assert!(!f.refuses(name), "{name}");
        }
    }

    #[test]
    fn knows_the_removed_names_by_their_hash() {
        let f = name_filter();
        assert!(f.is_removed("Cumfart"));
        assert!(f.is_removed("DaddyDongMilker"));
        assert!(!f.is_removed("cumfart"));
        assert_eq!(name_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn digits_stand_for_letters_only_between_letters() {
        assert_eq!(deleet("n1gg3r 2717975 a55hole !x 5"), "nigger 2717975 asshole !x 5");
        assert_eq!(words("CockNballz the_KING"), ["cock", "nballz", "the", "king"]);
        assert_eq!(letters("F.U.C.K 9"), "fuck");
    }
}
