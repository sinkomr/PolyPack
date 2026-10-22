/**
 * Entry of the search threads in development (tsx, vitest), where it is bundled into a temporary
 * JavaScript file first: see bundle.ts. The single-file bundle does not use it.
 */
import { runSearchThread } from "./worker";

runSearchThread();
