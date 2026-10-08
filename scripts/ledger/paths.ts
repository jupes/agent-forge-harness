/**
 * Where the ledger lives.
 *
 * One ledger per machine, under the user's home. `AGENT_FORGE_HOME` moves the
 * whole directory: tests and sandboxes set it so nothing they do reaches the
 * real ledger.
 */

import { homedir } from "os";
import { join } from "path";

type Env = Readonly<Record<string, string | undefined>>;

/** `AGENT_FORGE_HOME` when set, else `~/.agent-forge` (the OS home, not `$HOME`). */
export function ledgerHome(env: Env = process.env): string {
  const override = env.AGENT_FORGE_HOME;
  return override && override.trim().length > 0
    ? override
    : join(homedir(), ".agent-forge");
}

export function ledgerPath(env: Env = process.env): string {
  return join(ledgerHome(env), "ledger.db");
}

export function backupsDir(env: Env = process.env): string {
  return join(ledgerHome(env), "backups");
}
