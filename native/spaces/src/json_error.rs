//! The message of `JSON.parse` for a text that is not JSON, in V8's words.
//!
//! load.ts logs that message when a records file or a configuration's line cannot be read
//! (`[spaces] sphere records not loaded: Expected property name or '}' in JSON at position 2
//! (line 1 column 3)`), so the words are part of the server's log. This follows V8's parser
//! (src/json/json-parser.cc: ParseJsonValue, ScanJsonString, ParseJsonNumber, ScanLiteral,
//! ReportUnexpectedToken) to the first error it reports, and writes that error as V8 does
//! (src/common/message-template.h: kJsonParse...). native/tools/routes-jsonerr.mts writes the
//! cases of tests/fixtures/json_errors.json from Node.

/// What V8 takes a character for (json-parser.h: JsonToken, one_char_json_tokens).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Token {
    Number,
    String,
    LBrace,
    RBrace,
    LBrack,
    RBrack,
    TrueLiteral,
    FalseLiteral,
    NullLiteral,
    Whitespace,
    Colon,
    Comma,
    Illegal,
    Eos,
}

fn token_of(c: u16) -> Token {
    match c {
        0x22 => Token::String,
        0x2d | 0x30..=0x39 => Token::Number,
        0x7b => Token::LBrace,
        0x7d => Token::RBrace,
        0x5b => Token::LBrack,
        0x5d => Token::RBrack,
        0x74 => Token::TrueLiteral,
        0x66 => Token::FalseLiteral,
        0x6e => Token::NullLiteral,
        0x20 | 0x09 | 0x0a | 0x0d => Token::Whitespace,
        0x3a => Token::Colon,
        0x2c => Token::Comma,
        _ => Token::Illegal,
    }
}

/// The messages that name what was expected (the `errorMessage` of ReportUnexpectedToken).
#[derive(Clone, Copy)]
enum Expected {
    PropNameOrRBrace,
    CommaOrRBrack,
    CommaOrRBrace,
    ColonAfterPropertyName,
    DoubleQuotedPropertyName,
    UnterminatedString,
    BadControlCharacter,
    BadUnicodeEscape,
    BadEscapedCharacter,
    NoNumberAfterMinusSign,
    ExponentPartMissingNumber,
    UnterminatedFractionalNumber,
    NonWhiteSpaceAfterJson,
}

impl Expected {
    fn text(self) -> &'static str {
        match self {
            Expected::PropNameOrRBrace => "Expected property name or '}' in JSON",
            Expected::CommaOrRBrack => "Expected ',' or ']' after array element in JSON",
            Expected::CommaOrRBrace => "Expected ',' or '}' after property value in JSON",
            Expected::ColonAfterPropertyName => "Expected ':' after property name in JSON",
            Expected::DoubleQuotedPropertyName => "Expected double-quoted property name in JSON",
            Expected::UnterminatedString => "Unterminated string in JSON",
            Expected::BadControlCharacter => "Bad control character in string literal in JSON",
            Expected::BadUnicodeEscape => "Bad Unicode escape in JSON",
            Expected::BadEscapedCharacter => "Bad escaped character in JSON",
            Expected::NoNumberAfterMinusSign => "No number after minus sign in JSON",
            Expected::ExponentPartMissingNumber => "Exponent part is missing a number in JSON",
            Expected::UnterminatedFractionalNumber => "Unterminated fractional number in JSON",
            Expected::NonWhiteSpaceAfterJson => "Unexpected non-whitespace character after JSON",
        }
    }
}

/// kMaxContextCharacters: the characters of the text shown on each side of an unexpected one.
const MAX_CONTEXT: usize = 10;

struct Parser {
    /// The text in UTF-16 units: V8's positions count those.
    s: Vec<u16>,
    pos: usize,
}

type Step = Result<(), String>;

impl Parser {
    fn peek(&self) -> Token {
        match self.s.get(self.pos) {
            Some(c) => token_of(*c),
            None => Token::Eos,
        }
    }

    fn skip_whitespace(&mut self) {
        while self.peek() == Token::Whitespace {
            self.pos += 1;
        }
    }

    fn is_digit(&self) -> bool {
        matches!(self.s.get(self.pos), Some(0x30..=0x39))
    }

    fn at(&self, c: u8) -> bool {
        self.s.get(self.pos) == Some(&(c as u16))
    }

    fn text(&self, from: usize, to: usize) -> String {
        String::from_utf16_lossy(&self.s[from.min(self.s.len())..to.min(self.s.len())])
    }

    /// json-parser.cc: CalculateFileLocation. " (line L column C)" of the current position.
    fn location(&self) -> String {
        let end = self.pos.min(self.s.len());
        let (mut line, mut last_break, mut i) = (1usize, 0usize, 0usize);
        while i < end {
            // \r\n counts as one line terminator
            if self.s[i] == 0x0d && i + 1 < end && self.s[i + 1] == 0x0a {
                i += 1;
            }
            if self.s[i] == 0x0d || self.s[i] == 0x0a {
                line += 1;
                last_break = i + 1;
            }
            i += 1;
        }
        format!(" at position {} (line {line} column {})", self.pos, 1 + end - last_break)
    }

    /// json-parser.cc: ReportUnexpectedToken, with LookUpErrorMessageForJsonToken.
    fn report(&self, token: Token, expected: Option<Expected>) -> String {
        if let Some(e) = expected {
            return format!("{}{}", e.text(), self.location());
        }
        match token {
            Token::Eos => "Unexpected end of JSON input".to_string(),
            Token::Number => format!("Unexpected number in JSON{}", self.location()),
            Token::String => format!("Unexpected string in JSON{}", self.location()),
            _ => {
                let all = self.text(0, self.s.len());
                // IsSpecialString: a value that was turned into text instead of JSON
                if ["[object Object]", "NaN", "Infinity", "undefined"].contains(&all.as_str()) {
                    return format!("\"{all}\" is not valid JSON");
                }
                let (pos, length) = (self.pos, self.s.len());
                let c = self.text(pos, pos + 1);
                if length < 2 * MAX_CONTEXT + 1 {
                    format!("Unexpected token '{c}', \"{all}\" is not valid JSON")
                } else if pos < MAX_CONTEXT {
                    format!("Unexpected token '{c}', \"{}\"... is not valid JSON", self.text(0, pos + MAX_CONTEXT))
                } else if pos < length - MAX_CONTEXT {
                    format!("Unexpected token '{c}', ...\"{}\"... is not valid JSON", self.text(pos - MAX_CONTEXT, pos + MAX_CONTEXT))
                } else {
                    format!("Unexpected token '{c}', ...\"{}\" is not valid JSON", self.text(pos - MAX_CONTEXT, length))
                }
            }
        }
    }

    fn fail(&self, token: Token, expected: Option<Expected>) -> Step {
        Err(self.report(token, expected))
    }

    /// Expect / ExpectNext: the next token must be `token`.
    fn expect(&mut self, token: Token, expected: Expected) -> Step {
        self.skip_whitespace();
        if self.peek() == token {
            self.pos += 1;
            return Ok(());
        }
        self.fail(self.peek(), Some(expected))
    }

    /// json-parser.cc: ScanJsonString, after the opening quote.
    fn scan_string(&mut self) -> Step {
        loop {
            while matches!(self.s.get(self.pos), Some(c) if *c != 0x22 && *c != 0x5c && *c >= 0x20) {
                self.pos += 1;
            }
            let Some(c) = self.s.get(self.pos).copied() else {
                return self.fail(Token::Illegal, Some(Expected::UnterminatedString));
            };
            if c == 0x22 {
                self.pos += 1;
                return Ok(());
            }
            if c != 0x5c {
                return self.fail(Token::Illegal, Some(Expected::BadControlCharacter));
            }
            self.pos += 1;
            match self.s.get(self.pos).copied() {
                // the text ends in the escape
                None => return self.fail(Token::Eos, None),
                Some(0x22 | 0x5c | 0x2f | 0x62 | 0x66 | 0x6e | 0x72 | 0x74) => {}
                Some(0x75) => {
                    for _ in 0..4 {
                        self.pos += 1;
                        let hex = matches!(self.s.get(self.pos), Some(0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66));
                        if !hex {
                            return self.fail(Token::Illegal, Some(Expected::BadUnicodeEscape));
                        }
                    }
                }
                // a character beyond Latin-1 has no place in V8's table of escapes: an unexpected character
                Some(c) if c > 0xff => return self.fail(Token::Illegal, None),
                Some(_) => return self.fail(Token::Illegal, Some(Expected::BadEscapedCharacter)),
            }
            self.pos += 1;
        }
    }

    /// json-parser.cc: ParseJsonNumber.
    fn parse_number(&mut self) -> Step {
        if self.at(b'-') {
            self.pos += 1;
        }
        if self.at(b'0') {
            self.pos += 1;
            // a zero is the only digit before a point or an exponent
            if self.is_digit() {
                return self.fail(Token::Number, None);
            }
        } else {
            let start = self.pos;
            while self.is_digit() {
                self.pos += 1;
            }
            if self.pos == start {
                return self.fail(Token::Illegal, Some(Expected::NoNumberAfterMinusSign));
            }
        }
        if self.at(b'.') {
            self.pos += 1;
            if !self.is_digit() {
                return self.fail(Token::Illegal, Some(Expected::UnterminatedFractionalNumber));
            }
            while self.is_digit() {
                self.pos += 1;
            }
        }
        if self.at(b'e') || self.at(b'E') {
            self.pos += 1;
            if self.at(b'-') || self.at(b'+') {
                self.pos += 1;
            }
            if !self.is_digit() {
                return self.fail(Token::Illegal, Some(Expected::ExponentPartMissingNumber));
            }
            while self.is_digit() {
                self.pos += 1;
            }
        }
        Ok(())
    }

    /// json-parser.h: ScanLiteral. The first character was looked at already.
    fn scan_literal(&mut self, word: &str) -> Step {
        let word: Vec<u16> = word.encode_utf16().collect();
        self.pos += 1;
        for expected in &word[1..] {
            match self.s.get(self.pos) {
                None => return self.fail(Token::Eos, None),
                Some(c) if c != expected => return self.fail(token_of(*c), None),
                Some(_) => self.pos += 1,
            }
        }
        Ok(())
    }

    /// A property's key and its colon.
    fn key(&mut self, expected: Expected) -> Step {
        self.expect(Token::String, expected)?;
        self.scan_string()?;
        self.expect(Token::Colon, Expected::ColonAfterPropertyName)
    }

    /// json-parser.cc: ParseJson with ParseJsonValue.
    fn parse(&mut self) -> Step {
        // the containers that are open: an object (true) or an array (false)
        let mut open: Vec<bool> = Vec::new();
        loop {
            // produce a value: on until one is complete, or a first member begins
            loop {
                self.skip_whitespace();
                match self.peek() {
                    Token::String => {
                        self.pos += 1;
                        self.scan_string()?;
                    }
                    Token::Number => self.parse_number()?,
                    Token::LBrace => {
                        self.pos += 1;
                        self.skip_whitespace();
                        if self.peek() == Token::RBrace {
                            self.pos += 1;
                        } else {
                            open.push(true);
                            self.key(Expected::PropNameOrRBrace)?;
                            continue;
                        }
                    }
                    Token::LBrack => {
                        self.pos += 1;
                        self.skip_whitespace();
                        if self.peek() == Token::RBrack {
                            self.pos += 1;
                        } else {
                            open.push(false);
                            continue;
                        }
                    }
                    Token::TrueLiteral => self.scan_literal("true")?,
                    Token::FalseLiteral => self.scan_literal("false")?,
                    Token::NullLiteral => self.scan_literal("null")?,
                    other => return self.fail(other, None),
                }
                break;
            }
            // consume it: on while containers end
            loop {
                self.skip_whitespace();
                match open.last() {
                    None => {
                        if self.peek() != Token::Eos {
                            return self.fail(self.peek(), Some(Expected::NonWhiteSpaceAfterJson));
                        }
                        return Ok(());
                    }
                    Some(true) => {
                        if self.peek() == Token::Comma {
                            self.pos += 1;
                            self.key(Expected::DoubleQuotedPropertyName)?;
                            break;
                        }
                        self.expect(Token::RBrace, Expected::CommaOrRBrace)?;
                        open.pop();
                    }
                    Some(false) => {
                        if self.peek() == Token::Comma {
                            self.pos += 1;
                            break;
                        }
                        self.expect(Token::RBrack, Expected::CommaOrRBrack)?;
                        open.pop();
                    }
                }
            }
        }
    }
}

/// The message of the `SyntaxError` that `JSON.parse(text)` throws, or None when V8's grammar
/// finds nothing wrong with the text.
pub fn v8_json_error(text: &str) -> Option<String> {
    let mut parser = Parser { s: text.encode_utf16().collect(), pos: 0 };
    parser.parse().err()
}
