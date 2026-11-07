//! The search methods. Their names are the server's registered method names, which a submission's
//! `method` must be.

pub mod common;
pub mod polish;
pub mod seed;
pub mod shrink_repair;

use crate::framework::Ctx;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Method {
    Identity,
    Polish,
    Seed,
    Penalty,
    BasinHopping,
    McCompress,
    Morph,
    Asc,
    LsGrowth,
    Harden,
    ShrinkRepair,
}

pub const ALL: [Method; 11] = [
    Method::Identity,
    Method::Polish,
    Method::Seed,
    Method::Penalty,
    Method::BasinHopping,
    Method::McCompress,
    Method::Morph,
    Method::Asc,
    Method::LsGrowth,
    Method::Harden,
    Method::ShrinkRepair,
];

impl Method {
    pub fn name(&self) -> &'static str {
        match self {
            Method::Identity => "identity",
            Method::Polish => "polish",
            Method::Seed => "seed",
            Method::Penalty => "penalty",
            Method::BasinHopping => "basin_hopping",
            Method::McCompress => "mc_compress",
            Method::Morph => "morph",
            Method::Asc => "asc",
            Method::LsGrowth => "ls_growth",
            Method::Harden => "harden",
            Method::ShrinkRepair => "shrink_repair",
        }
    }

    pub fn from_name(name: &str) -> Option<Method> {
        ALL.iter().copied().find(|m| m.name() == name)
    }

    /// Whether this build implements the method.
    pub fn available(&self) -> bool {
        matches!(self, Method::Identity | Method::Polish | Method::Seed | Method::ShrinkRepair)
    }
}

/// Parameters with the defaults filled in, checked; `given` is null or an object.
fn fill<P: Serialize + DeserializeOwned + Default>(given: &Value) -> Result<(Value, P), String> {
    let p: P = match given {
        Value::Null => P::default(),
        Value::Object(_) => serde_json::from_value(given.clone()).map_err(|e| e.to_string())?,
        _ => return Err("params must be an object".into()),
    };
    let v = serde_json::to_value(&p).map_err(|e| e.to_string())?;
    Ok((v, p))
}

pub fn resolve_params(method: Method, given: &Value) -> Result<Value, String> {
    match method {
        Method::Identity => Ok(serde_json::json!({ "iterations": 1 })),
        Method::Polish => {
            let (v, p) = fill::<polish::Params>(given)?;
            p.check()?;
            Ok(v)
        }
        Method::Seed => {
            let (v, p) = fill::<seed::Params>(given)?;
            p.check()?;
            Ok(v)
        }
        Method::ShrinkRepair => {
            let (v, p) = fill::<shrink_repair::Params>(given)?;
            p.check()?;
            Ok(v)
        }
        other => Err(format!("method {} is not available in this build", other.name())),
    }
}

pub fn execute(method: Method, ctx: &mut Ctx) {
    match method {
        Method::Identity => {
            if let Some(s) = ctx.start().cloned() {
                let _ = ctx.evaluate(&s, true);
            }
        }
        Method::Polish => polish::execute(ctx),
        Method::Seed => seed::execute(ctx),
        Method::ShrinkRepair => shrink_repair::execute(ctx),
        other => ctx.fail(format!("method {} is not available in this build", other.name())),
    }
}
