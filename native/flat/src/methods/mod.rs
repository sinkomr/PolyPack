//! The search methods. Their names are the server's registered method names, which a submission's
//! `method` must be.
//!
//! Each method module has `resolve(given) -> Result<Value, String>` (the parameters with their
//! defaults filled in and checked, as JSON) and `execute(ctx)`. A method a build does not
//! implement answers `resolve` with an error and is never chosen.

pub mod asc;
pub mod basin_hopping;
pub mod common;
pub mod harden;
pub mod lbfgs;
pub mod ls_growth;
pub mod morph;
pub mod penalty_method;
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
        resolve_params(*self, &Value::Null).is_ok()
    }
}

/// Parameters with the defaults filled in; `given` is null or an object. Unknown keys are an
/// error when the parameter struct denies them.
pub fn fill<P: Serialize + DeserializeOwned + Default>(given: &Value) -> Result<(Value, P), String> {
    let p: P = match given {
        Value::Null => P::default(),
        Value::Object(_) => serde_json::from_value(given.clone()).map_err(|e| e.to_string())?,
        _ => return Err("params must be an object".into()),
    };
    let v = serde_json::to_value(&p).map_err(|e| e.to_string())?;
    Ok((v, p))
}

/// The parameters of a running method, read back from the resolved JSON.
pub fn params_of<P: DeserializeOwned>(ctx: &mut Ctx) -> Option<P> {
    match serde_json::from_value(ctx.params().clone()) {
        Ok(p) => Some(p),
        Err(e) => {
            ctx.fail(e.to_string());
            None
        }
    }
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
        Method::Asc => asc::resolve(given),
        Method::Harden => harden::resolve(given),
        Method::LsGrowth => ls_growth::resolve(given),
        Method::Penalty => penalty_method::resolve(given),
        Method::BasinHopping => basin_hopping::resolve(given),
        Method::Morph => morph::resolve(given),
        Method::McCompress => Err("method mc_compress is not available in this build".into()),
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
        Method::Asc => asc::execute(ctx),
        Method::Harden => harden::execute(ctx),
        Method::LsGrowth => ls_growth::execute(ctx),
        Method::Penalty => penalty_method::execute(ctx),
        Method::BasinHopping => basin_hopping::execute(ctx),
        Method::Morph => morph::execute(ctx),
        Method::McCompress => ctx.fail("method mc_compress is not available in this build"),
    }
}
