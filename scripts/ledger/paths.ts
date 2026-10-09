/**
 * Where the ledger lives.
 *
 * One ledger per machine, under the user's home. `AGENT_FORGE_HOME` moves the
 * whole directory: tests and sandboxes set it so nothing they do reaches the
 * real ledger.
 */

import { join } from "path";
import { agentForgeHome } from "../agent-forge-home";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `AGENT_FORGE_HOME` when set, else `~/.agent-forge` (the OS home, not `$HOME`).
 * The hearth keeps its lock and token files in the same directory; the rule
 * is written once, in `scripts/agent-forge-home.ts`.
 */
export function ledgerHome(env: Env = process.env): string {
  return agentForgeHome(env);
}

export function ledgerPath(env: Env = process.env): string {
  return join(ledgerHome(env), "ledger.db");
}

export function backupsDir(env: Env = process.env): string {
  return join(ledgerHome(env), "backups");
}
