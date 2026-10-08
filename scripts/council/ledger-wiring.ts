/**
 * The real ledger, as the two functions a council run is handed.
 *
 * This file imports the ledger, which loads Bun's SQLite driver. Only two Bun
 * entry points load it — `cli.ts` and `mcp.ts`, each through a dynamic import
 * where it runs as a command — never `workflow.ts` or `service.ts`, which
 * take these two functions from their caller. The hearth, which serves the
 * dashboard's council routes, does not load it: runs started there are not
 * recorded.
 */

import { appendEvent } from "../ledger/append";
import { resolveAttach } from "../ledger/identity";
import type { CouncilAppend, CouncilAttachResolver } from "./ledger-events";

type Env = Readonly<Record<string, string | undefined>>;

export interface CouncilLedger {
  appendEvent: CouncilAppend;
  resolveAttach: CouncilAttachResolver;
}

/**
 * Council events go to the ledger under `AGENT_FORGE_HOME` (or `opts.path`),
 * attributed to the session working in the caller's worktree and to the bead
 * named by the caller, else by `AGENT_FORGE_BEAD_ID`.
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
