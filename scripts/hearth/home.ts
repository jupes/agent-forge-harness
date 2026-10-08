import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { agentForgeHome } from "../agent-forge-home";

/**
 * Machine-local hearth state: `AGENT_FORGE_HOME`, else `~/.agent-forge` — the
 * directory the ledger also lives in (`scripts/agent-forge-home.ts` holds the
 * rule). Tests point this at a temp directory so they never touch the real one.
 */
export function hearthHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return agentForgeHome(env);
}

/** Stable short key for a workspace root; case-folded on Windows paths. */
export function rootKey(root: string): string {
  const slashed = resolve(root).replaceAll("\\", "/");
  const normalized =
    process.platform === "win32" ? slashed.toLowerCase() : slashed;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function lockPath(home: string, root: string): string {
  return join(home, `hearth-${rootKey(root)}.lock`);
}

export function tokenPath(home: string, root: string): string {
  return join(home, "tokens", `${rootKey(root)}.token`);
}
