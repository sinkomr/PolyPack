//! node:sqlite's `DatabaseSync`, as the store uses it, over rusqlite.
//!
//! The TypeScript store talks to SQLite through Node's built-in driver, and the driver's own rules
//! are part of what the store does. They are kept here, so that the store's code reads as the
//! source does (`db.prepare(sql).get(...)`, `.all(...)`, `.run(...)`, `db.exec(sql)`):
//!
//!  - **a JavaScript number is bound as a double** (`sqlite3_bind_double`), also when it holds an
//!    integer; the column's affinity then stores 4.0 as the integer 4 in an INTEGER column. NaN is
//!    bound as NULL (SQLite's rule). So every number the store binds is an `f64` here;
//!  - **a value is read by its storage class**: NULL as null, INTEGER and REAL as a number, TEXT as
//!    a string (bytes that are not UTF-8 become U+FFFD), BLOB as bytes. An INTEGER beyond
//!    2^53 - 1 in absolute value is refused with a RangeError, for every column of every row a
//!    statement returns, whether the store uses the column or not;
//!  - `get` steps once and resets; `all` steps to the end; `run` steps once and gives the changes
//!    and the last rowid;
//!  - the connection has **no busy timeout** (Node's default is 0; rusqlite's is 5 s, set back to 0
//!    here), so a statement that meets a lock fails at once, as it does in the source;
//!  - foreign keys are on and double-quoted string literals are off, as Node sets them (the schema
//!    uses neither).
//!
//! A tracer can watch every statement, which the ported tests use where the source's tests wrap
//! `db.prepare` and `db.exec`.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use polypack_js::fmt;
use rusqlite::config::DbConfig;
use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{CachedStatement, Connection, ToSql};

use super::error::{Result, StoreError};

/// A value read from the database, as node:sqlite hands it to JavaScript.
#[derive(Clone, Debug, PartialEq)]
pub enum JsVal {
    Null,
    Num(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// The largest integer node:sqlite reads as a number: Number.MAX_SAFE_INTEGER.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

impl JsVal {
    fn read(v: ValueRef<'_>) -> Result<JsVal> {
        Ok(match v {
            ValueRef::Null => JsVal::Null,
            ValueRef::Integer(i) => {
                if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                    return Err(StoreError::Range(format!(
                        "Value is too large to be represented as a JavaScript number: {i}"
                    )));
                }
                JsVal::Num(i as f64)
            }
            ValueRef::Real(r) => JsVal::Num(r),
            ValueRef::Text(t) => JsVal::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => JsVal::Blob(b.to_vec()),
        })
    }

    /// `typeof value`.
    pub fn type_of(&self) -> &'static str {
        match self {
            JsVal::Null | JsVal::Blob(_) => "object",
            JsVal::Num(_) => "number",
            JsVal::Text(_) => "string",
        }
    }

    /// `String(value)`, also what a template string gives.
    pub fn to_js_string(&self) -> String {
        match self {
            JsVal::Null => "null".into(),
            JsVal::Num(x) => fmt::num(*x),
            JsVal::Text(s) => s.clone(),
            // a Uint8Array prints as its bytes joined by commas
            JsVal::Blob(b) => b.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
        }
    }

    /// JavaScript's truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            JsVal::Null => false,
            JsVal::Num(x) => *x != 0.0 && !x.is_nan(),
            JsVal::Text(s) => !s.is_empty(),
            JsVal::Blob(_) => true,
        }
    }

    /// `value as number`, for a column the server only ever writes numbers to. The TypeScript
    /// would carry any other value on unchecked; here it is an error that names the column.
    pub fn num(&self, column: &str) -> Result<f64> {
        match self {
            JsVal::Num(x) => Ok(*x),
            other => Err(StoreError::Type(format!("column {column} holds a {}, not a number", other.type_of()))),
        }
    }

    /// `value as number | null`.
    pub fn num_or_null(&self, column: &str) -> Result<Option<f64>> {
        match self {
            JsVal::Null => Ok(None),
            other => other.num(column).map(Some),
        }
    }

    /// `value as string`, for a column the server only ever writes text to.
    pub fn text(&self, column: &str) -> Result<String> {
        match self {
            JsVal::Text(s) => Ok(s.clone()),
            other => Err(StoreError::Type(format!("column {column} holds a {}, not a string", other.type_of()))),
        }
    }

    /// `value as string | null`.
    pub fn text_or_null(&self, column: &str) -> Result<Option<String>> {
        match self {
            JsVal::Null => Ok(None),
            other => other.text(column).map(Some),
        }
    }
}

/// A value bound to a statement, as node:sqlite binds a JavaScript value.
#[derive(Clone, Copy, Debug)]
pub enum Param<'a> {
    Null,
    /// A JavaScript number: always bound as a double.
    Num(f64),
    Text(&'a str),
    Blob(&'a [u8]),
}

impl ToSql for Param<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self {
            Param::Null => ValueRef::Null,
            Param::Num(x) => ValueRef::Real(*x),
            Param::Text(s) => ValueRef::Text(s.as_bytes()),
            Param::Blob(b) => ValueRef::Blob(b),
        }))
    }
}

impl From<f64> for Param<'_> {
    fn from(x: f64) -> Self {
        Param::Num(x)
    }
}
impl<'a> From<&'a str> for Param<'a> {
    fn from(s: &'a str) -> Self {
        Param::Text(s)
    }
}
impl<'a> From<&'a String> for Param<'a> {
    fn from(s: &'a String) -> Self {
        Param::Text(s)
    }
}
impl<'a> From<&'a [u8]> for Param<'a> {
    fn from(b: &'a [u8]) -> Self {
        Param::Blob(b)
    }
}
impl<'a> From<&'a Vec<u8>> for Param<'a> {
    fn from(b: &'a Vec<u8>) -> Self {
        Param::Blob(b)
    }
}
impl From<Option<f64>> for Param<'_> {
    fn from(x: Option<f64>) -> Self {
        x.map_or(Param::Null, Param::Num)
    }
}
impl<'a> From<Option<&'a str>> for Param<'a> {
    fn from(s: Option<&'a str>) -> Self {
        s.map_or(Param::Null, Param::Text)
    }
}
impl<'a> From<&'a Option<String>> for Param<'a> {
    fn from(s: &'a Option<String>) -> Self {
        s.as_deref().map_or(Param::Null, Param::Text)
    }
}
impl<'a> From<&'a JsVal> for Param<'a> {
    fn from(v: &'a JsVal) -> Self {
        match v {
            JsVal::Null => Param::Null,
            JsVal::Num(x) => Param::Num(*x),
            JsVal::Text(s) => Param::Text(s),
            JsVal::Blob(b) => Param::Blob(b),
        }
    }
}

/// One row of a result: its values in the order of the statement's columns.
#[derive(Clone, Debug)]
pub struct Row {
    names: Rc<Vec<String>>,
    values: Vec<JsVal>,
}

impl Row {
    /// `row[name]`; a column the statement does not return reads as null (`undefined ?? null`).
    pub fn get(&self, name: &str) -> &JsVal {
        const NULL: &JsVal = &JsVal::Null;
        self.names.iter().position(|n| n == name).map_or(NULL, |i| &self.values[i])
    }

    /// `Object.values(row)`.
    pub fn values(&self) -> &[JsVal] {
        &self.values
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    pub fn num(&self, name: &str) -> Result<f64> {
        self.get(name).num(name)
    }
    pub fn num_or_null(&self, name: &str) -> Result<Option<f64>> {
        self.get(name).num_or_null(name)
    }
    pub fn text(&self, name: &str) -> Result<String> {
        self.get(name).text(name)
    }
    pub fn text_or_null(&self, name: &str) -> Result<Option<String>> {
        self.get(name).text_or_null(name)
    }
}

/// What `run` returns: `changes` and `lastInsertRowid`, as numbers.
#[derive(Clone, Copy, Debug)]
pub struct RunResult {
    pub changes: f64,
    pub last_insert_rowid: f64,
}

/// What a tracer is told, before the store does it.
#[derive(Clone, Copy, Debug)]
pub enum TraceEvent<'a> {
    /// `db.exec(sql)`.
    Exec(&'a str),
    /// `db.prepare(sql)`.
    Prepare(&'a str),
    /// `statement.run`, `.get` or `.all` of the statement prepared from this text, with the values
    /// bound to it.
    Step(&'a str, &'a [Param<'a>]),
}

/// A tracer; an error it returns is thrown in place of the call it was told of.
pub type Tracer = Box<dyn FnMut(&Connection, TraceEvent<'_>) -> Result<()> + Send>;

/// The connection, with node:sqlite's settings.
pub struct Db {
    conn: Connection,
    tracer: RefCell<Option<Tracer>>,
}

impl Db {
    /// `new DatabaseSync(path)`.
    pub fn open(path: &str) -> Result<Db> {
        let conn = Connection::open(path)?;
        // Node's defaults: no busy timeout, foreign keys on, double-quoted strings off
        conn.busy_timeout(Duration::ZERO)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
        // the store's statements are a fixed set, apart from the lists of ids and problems
        conn.set_prepared_statement_cache_capacity(64);
        Ok(Db { conn, tracer: RefCell::new(None) })
    }

    /// The rusqlite connection, for tools and tests that read the file directly.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Watches every statement from now on (None: stops watching).
    pub fn set_tracer(&self, tracer: Option<Tracer>) {
        *self.tracer.borrow_mut() = tracer;
    }

    fn trace(&self, event: TraceEvent<'_>) -> Result<()> {
        match self.tracer.borrow_mut().as_mut() {
            Some(t) => t(&self.conn, event),
            None => Ok(()),
        }
    }

    /// `db.exec(sql)`: every statement of the text, results ignored.
    pub fn exec(&self, sql: &str) -> Result<()> {
        self.trace(TraceEvent::Exec(sql))?;
        self.conn.execute_batch(sql)?;
        Ok(())
    }

    /// `db.prepare(sql)`. The compiled statement is kept by rusqlite and used again for the same
    /// text, which changes nothing but the time.
    pub fn prepare<'a>(&'a self, sql: &'a str) -> Result<Stmt<'a>> {
        self.trace(TraceEvent::Prepare(sql))?;
        let st = self.conn.prepare_cached(sql)?;
        Ok(Stmt { db: self, sql, st })
    }
}

/// A prepared statement (`StatementSync`).
pub struct Stmt<'a> {
    db: &'a Db,
    sql: &'a str,
    st: CachedStatement<'a>,
}

impl Stmt<'_> {
    fn bind(&mut self, params: &[Param<'_>]) -> Result<()> {
        self.db.trace(TraceEvent::Step(self.sql, params))?;
        debug_assert_eq!(self.st.parameter_count(), params.len(), "{}", self.sql);
        for (i, p) in params.iter().enumerate() {
            self.st.raw_bind_parameter(i + 1, p)?;
        }
        Ok(())
    }

    fn names(&self) -> Rc<Vec<String>> {
        Rc::new(self.st.column_names().map(str::to_string).collect())
    }

    fn row(names: &Rc<Vec<String>>, r: &rusqlite::Row<'_>) -> Result<Row> {
        let mut values = Vec::with_capacity(names.len());
        for i in 0..names.len() {
            values.push(JsVal::read(r.get_ref(i)?)?);
        }
        Ok(Row { names: Rc::clone(names), values })
    }

    /// `statement.get(...params)`: the first row, or None.
    pub fn get(&mut self, params: &[Param<'_>]) -> Result<Option<Row>> {
        self.bind(params)?;
        let names = self.names();
        let mut rows = self.st.raw_query();
        match rows.next()? {
            Some(r) => Ok(Some(Self::row(&names, r)?)),
            None => Ok(None),
        }
    }

    /// `statement.all(...params)`.
    pub fn all(&mut self, params: &[Param<'_>]) -> Result<Vec<Row>> {
        self.bind(params)?;
        let names = self.names();
        let mut rows = self.st.raw_query();
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push(Self::row(&names, r)?);
        }
        Ok(out)
    }

    /// `statement.run(...params)`.
    pub fn run(&mut self, params: &[Param<'_>]) -> Result<RunResult> {
        self.bind(params)?;
        let changes = self.st.raw_execute()?;
        Ok(RunResult { changes: changes as f64, last_insert_rowid: self.db.conn.last_insert_rowid() as f64 })
    }
}

/// `Number.isInteger(x)`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.floor() == x
}
