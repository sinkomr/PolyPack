//! The PolyPack server in Rust, ported from apps/server (TypeScript).
//!
//! | source (apps/server/src)   | module                                              |
//! |----------------------------|-----------------------------------------------------|
//! | app.ts                     | `app`                                               |
//! | leaders.ts                 | `leaders`                                           |
//! | limits.ts                  | `limits` (`readBodyWithin` is `hono::read_body_within`) |
//! | load.ts                    | `load` (`LoopDelay` is `pool::Pool`'s delay)        |
//! | snapshot.ts                | `snapshot`                                          |
//! | docs.ts                    | `docs` (its texts: data/docs.json)                  |
//! | units-gate.ts              | `units_gate`                                        |
//! | node.ts                    | `node`, and `main.rs`                               |
//! | spaces.ts                  | `spaces`                                            |
//! | packages/spaces            | the crate `polypack-spaces`; `spaces_port` is what the other modules read of it |
//! | store.ts, sqlite-store.ts, pieces.ts, units-migration.ts | `store`               |
//!
//! And what the source has from its libraries and its language:
//!
//! | what                                             | module         |
//! |--------------------------------------------------|----------------|
//! | Hono and @hono/node-server, as far as it shows   | `hono`         |
//! | `serveStatic` of @hono/node-server               | `serve_static` |
//! | the URL of a request (WHATWG URL, Hono's readers)| `url`          |
//! | `Number()`, UTF-16 strings, `decodeURI`, `Date`  | `js`           |
//! | the clock (and the test clock)                   | `clock`        |
//! | the workers that verify submissions              | `pool`         |
//! | a submission's body read without a JSON tree     | `body`         |

pub mod app;
pub mod body;
pub mod clock;
pub mod docs;
pub mod hono;
pub mod js;
pub mod leaders;
pub mod limits;
pub mod load;
pub mod node;
pub mod pool;
pub mod serve_static;
pub mod snapshot;
pub mod spaces;
pub mod spaces_port;
pub mod store;
pub mod units_gate;
pub mod url;
