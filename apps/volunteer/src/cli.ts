/**
 * Entry point of the volunteer client:
 *
 *   npx tsx apps/volunteer/src/cli.ts --help          (development)
 *   node polypack-volunteer.mjs --help                 (the single-file bundle, see build.ts)
 *
 * In the bundle the search threads run this same file; their workerData tells them apart, so
 * they serve jobs instead of starting the client.
 */
import { main } from "./main";
import { isSearchThread, runSearchThread } from "./worker";

if (isSearchThread()) runSearchThread();
else {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  // The threads are gone and the state is saved; an idle keep-alive connection must not hold the
  // process. A plain exit would cut output still queued for a pipe, hence the unref'd timer.
  setTimeout(() => process.exit(code), 1000).unref();
}
