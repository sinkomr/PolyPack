//! `polypack-server`: the PolyPack server (apps/server/src/node.ts in Rust).

use polypack_server::pool::THREAD_STACK_BYTES;

fn main() {
    // Every thread gets a stack of a set size (see THREAD_STACK_BYTES), the one that starts the
    // server included: the main thread's own is whatever the shell's limit says.
    let server = std::thread::Builder::new()
        .name("server".to_string())
        .stack_size(THREAD_STACK_BYTES)
        .spawn(|| {
            polypack_server::pool::runtime().block_on(polypack_server::node::main());
        })
        .expect("a thread can be started");
    // node::main never returns; a panic in it ends the process as a panic of `main` would
    if server.join().is_err() {
        std::process::exit(101);
    }
}
