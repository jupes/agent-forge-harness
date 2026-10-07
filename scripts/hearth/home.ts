import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Machine-local hearth state: `AGENT_FORGE_HOME`, else `~/.agent-forge`.
 * Tests point this at a temp directory so they never touch the real one.
 */
export function hearthHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env["AGENT_FORGE_HOME"];
  return override && override.length > 0
    ? override
    : join(homedir(), ".agent-forge");
}

/** Stable short key for a workspace root; case-folded on Windows paths. */
export function rootKey(root: string): string {
  const normalized = resolve(root).replaceAll("\\", "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function lockPath(home: string, root: string): string {
  return join(home, `hearth-${rootKey(root)}.lock`);
}

export function tokenPath(home: string, root: string): string {
  return join(home, "tokens", `${rootKey(root)}.token`);
}
