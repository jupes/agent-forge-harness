/**
 * The real ledger, as the two functions a council run is handed.
 *
 * This file imports the ledger, which loads Bun's SQLite driver. Three Bun
 * entry points load it — `cli.ts`, `mcp.ts` and the hearth's `server.ts`, each
 * through a dynamic import where it runs as a command — never `workflow.ts` or
 * `service.ts`, which take these two functions from their caller. A host that
 * hands in nothing records nothing: that is what every test of the service
 * and of the hearth relies on.
 */

import { appendEvent } from "../ledger/append";
import { resolveAttach } from "../ledger/identity";
import { resolveCheckout } from "../ledger/workspace";
import type { CouncilAppend, CouncilAttachResolver } from "./ledger-events";

type Env = Readonly<Record<string, string | undefined>>;

export interface CouncilLedger {
  appendEvent: CouncilAppend;
  resolveAttach: CouncilAttachResolver;
}

/**
 * For a caller that is a session, or runs inside one (the CLI, the MCP
 * server): council events go to the ledger under `AGENT_FORGE_HOME` (or
 * `opts.path`), attributed to the session working in the caller's worktree and
 * to the bead named by the caller, else by `AGENT_FORGE_BEAD_ID`.
 */
export function councilLedger(
  env: Env,
  opts: { path?: string } = {},
): CouncilLedger {
  return {
    appendEvent: (event) => appendEvent(event, opts),
    resolveAttach: ({ cwd, beadId }) =>
      resolveAttach({
        cwd,
        env,
        explicit: beadId !== undefined ? { beadId } : {},
        ...(opts.path !== undefined ? { path: opts.path } : {}),
      }),
  };
}

/**
 * For a host that is not a session (the hearth): council events carry the
 * workspace and the bead the caller named, and nothing inferred.
 *
 * A run started from the dashboard is started by the operator. The agent
 * session whose mirror file happens to sit in the checkout did not start it,
 * and the hearth's environment was fixed when it launched, so neither may be
 * read as who or what the run belongs to: no session, no executor, no bead or
 * run from the environment.
 */
export function operatorCouncilLedger(
  opts: { path?: string } = {},
): CouncilLedger {
  return {
    appendEvent: (event) => appendEvent(event, opts),
    resolveAttach: ({ cwd, beadId }) => ({
      workspace: resolveCheckout(cwd).workspace,
      ...(beadId !== undefined ? { beadId } : {}),
    }),
  };
}
