//! `polypack-server`: the PolyPack server (apps/server/src/node.ts in Rust).

use polypack_server::pool::THREAD_STACK_BYTES;

/// The memory allocator: mimalloc, not the C library's malloc. Under glibc each busy thread soon
/// has an arena of its own, and an arena keeps the pages of its busiest moment after they are freed.
/// The server's threads take turns at heavy requests (a holder's page, a snapshot file, a space's
/// check), so every arena came to hold such a moment: on 2026-11-20 the process held 1.4 GB in 24
/// arenas of 64 MB, while its own heap held 6 MB, and with 1 GB the machine had been killed for want
/// of memory. mimalloc gives freed pages back to the system within milliseconds.
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

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
