/**
 * The browser suite's stand-in for `scripts/build-pages.ts`
 * (`DASHBOARD_BUILD_SCRIPT` in `playwright.config.ts`). The dashboard runs it
 * whenever it would rebuild the snapshot, with the runtime it runs under.
 *
 * It writes no snapshot: a page in the suite reads one a test serves, or the
 * checkout's own `docs/data/beads.json`, which a run must not replace. It
 * appends one line to `build-stand-in.log` in the run's home, so a test can
 * tell that a rebuild ran, and exits 0, so the dashboard takes it as one that
 * succeeded.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.AGENT_FORGE_HOME;
if (home) appendFileSync(join(home, "build-stand-in.log"), "built\n");
console.log("build stand-in: no snapshot written");
