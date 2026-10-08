import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The two servers the suite runs against: where they listen and where the
 * hearth keeps its state. Shared by the Playwright config that starts them,
 * the teardown that cleans up, and the spec that checks they are the ones
 * answering.
 */

/** Dashboard dev server. `PORT` overrides it, as it does for `bun run dashboard`. */
export const DASHBOARD_PORT = Number(process.env["PORT"] ?? 8799);

/**
 * The hearth the suite starts. A fixed port, unlike a supervised hearth's
 * OS-chosen one, so the config can wait on it and a spec can ask it who it is.
 */
export const HEARTH_PORT = Number(process.env["E2E_HEARTH_PORT"] ?? 8798);

export const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
export const HEARTH_URL = `http://127.0.0.1:${HEARTH_PORT}`;

const RUN_HOME_NAME = /^agent-forge-e2e-\d+-\d+$/;

/**
 * A hearth home that exists for this run only.
 *
 * Playwright kills its servers outright, so a hearth never gets to release its
 * lock, and a hearth started directly takes any lock whose pid is alive at its
 * word and exits as "already running". A home shared between runs would
 * therefore stop the suite from starting whenever an old lock's pid had been
 * reused. A new home cannot hold an old lock. It also keeps the suite off the
 * developer's real `~/.agent-forge`.
 *
 * The runner picks the path once; workers evaluate this module again and must
 * arrive at the same one, so it travels in the environment. It is not created
 * here — list mode and every worker would each leave one behind. The hearth
 * creates it.
 */
export const HEARTH_HOME = (process.env["AGENT_FORGE_E2E_HOME"] ??= join(
  tmpdir(),
  `agent-forge-e2e-${process.pid}-${Date.now()}`,
));

/**
 * Whether `path` is a home this module would have generated: the only kind the
 * teardown may delete. A home someone pointed `AGENT_FORGE_E2E_HOME` at is used
 * and left alone.
 */
export function isRunHome(path: string): boolean {
  return (
    resolve(dirname(path)) === resolve(tmpdir()) &&
    RUN_HOME_NAME.test(basename(path))
  );
}
