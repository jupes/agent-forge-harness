/**
 * The machine-local Agent Forge directory: `AGENT_FORGE_HOME`, else
 * `~/.agent-forge`.
 *
 * The one place that rule is written. The ledger (`scripts/ledger/paths.ts`)
 * and the hearth (`scripts/hearth/home.ts`) both resolve their directory here,
 * so a moved home moves both. A leaf module — two built-ins and nothing of the
 * harness — because the hooks load it on every tool call and Vite loads it
 * under Node.
 */

import { homedir } from "os";
import { join } from "path";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `AGENT_FORGE_HOME` when it is set to more than whitespace, else
 * `~/.agent-forge` under the OS home (not `$HOME`). The override is returned
 * as given: not trimmed, not resolved.
 */
export function agentForgeHome(env: Env = process.env): string {
  const override = env["AGENT_FORGE_HOME"];
  return override !== undefined && override.trim().length > 0
    ? override
    : join(homedir(), ".agent-forge");
}
