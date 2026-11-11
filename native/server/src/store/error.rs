//! What the store's methods throw in the TypeScript, as one error type.

use std::fmt;

/// An error of the store. The variants are the JavaScript error classes the source throws, so that
/// a caller (and the comparison with the TypeScript) can tell them apart; `message()` is the text
/// of `e.message`.
#[derive(Debug)]
pub enum StoreError {
    /// `RangeError`: a programming error of the caller (too many ids, a bad limit or batch), stored
    /// pieces whose length is not a multiple of 24 bytes, or an INTEGER in the database beyond
    /// 2^53 - 1 (node:sqlite refuses to read it as a number).
    Range(String),
    /// `TypeError`: a stored value of a type the store cannot read.
    Type(String),
    /// `SyntaxError` of `JSON.parse` on a stored text. The message is this port's own: V8's wording
    /// is not reproduced.
    Syntax(String),
    /// An `Error` thrown by node:sqlite; the message is SQLite's own (`sqlite3_errmsg`).
    Sqlite(rusqlite::Error),
    /// Any other `Error`.
    Other(String),
}

impl StoreError {
    /// The name of the JavaScript error class (`e.name`).
    pub fn name(&self) -> &'static str {
        match self {
            StoreError::Range(_) => "RangeError",
            StoreError::Type(_) => "TypeError",
            StoreError::Syntax(_) => "SyntaxError",
            StoreError::Sqlite(_) | StoreError::Other(_) => "Error",
        }
    }

    /// `e.message`.
    pub fn message(&self) -> String {
        match self {
            StoreError::Range(m) | StoreError::Type(m) | StoreError::Syntax(m) | StoreError::Other(m) => m.clone(),
            StoreError::Sqlite(e) => sqlite_message(e),
        }
    }
}

/// SQLite's own message, as node:sqlite puts it in `e.message`. rusqlite adds the statement and an
/// offset to the errors of `prepare`; they are left out here.
fn sqlite_message(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(msg)) => msg.clone(),
        rusqlite::Error::SqlInputError { msg, .. } => msg.clone(),
        other => other.to_string(),
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.name(), self.message())
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;
