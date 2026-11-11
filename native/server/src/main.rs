//! `polypack-server`: the PolyPack server (apps/server/src/node.ts in Rust).

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    polypack_server::node::main().await;
}
