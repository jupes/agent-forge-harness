import { BASE_ENV_ALLOWLIST } from "../config/defaults";
import type { SpawnRequest } from "./types";

/**
 * The environment a spawned executor receives: the base set it needs to start
 * plus the configured `pass` list, and nothing else. Names match
 * case-insensitively (Windows reports `Path`), and the parent's casing is kept.
 */
export function buildChildEnv(
  parent: Record<string, string | undefined>,
  pass: readonly string[],
): Record<string, string> {
  const allowed = new Set(
    [...BASE_ENV_ALLOWLIST, ...pass].map((name) => name.toLowerCase()),
  );
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && allowed.has(name.toLowerCase())) {
      child[name] = value;
    }
  }
  return child;
}

/** The variables an adapter sets itself; a child never inherits a value for one of them. */
const ADAPTER_VARIABLES: readonly string[] = [
  "AGENT_FORGE_ADAPTER",
  "AGENT_FORGE_BEAD_ID",
  "AGENT_FORGE_SMITH",
  "FORGE_SLUG",
  "AGENT_FORGE_PARENT_SESSION",
];

type Correlation = Pick<
  SpawnRequest,
  "beadId" | "smith" | "runId" | "parentSessionId"
>;

/**
 * What an adapter adds to its child's environment, built from the request:
 * `AGENT_FORGE_ADAPTER=1` tells the harness's session and tool hooks that
 * this session is recorded by its adapter, so they record nothing; the rest
 * tells scripts run inside the child — the quality gate among them, which
 * does not consult the marker — which bead, smith, run and parent session
 * they belong to (`.claude/protocols/agent-onboarding.md`, Correlation).
 */
export function adapterEnv(request: Correlation): Record<string, string> {
  return {
    AGENT_FORGE_ADAPTER: "1",
    AGENT_FORGE_BEAD_ID: request.beadId,
    AGENT_FORGE_SMITH: request.smith.name,
    ...(request.runId ? { FORGE_SLUG: request.runId } : {}),
    ...(request.parentSessionId
      ? { AGENT_FORGE_PARENT_SESSION: request.parentSessionId }
      : {}),
  };
}

/**
 * The environment an adapter starts its child with: the request's (already
 * allowlisted) environment plus `adapterEnv`. A value that arrived under one
 * of the adapter's names — in any letter case, since Windows treats them as
 * one — is dropped first, so the child sees the adapter's value or none.
 */
export function childEnv(
  request: Correlation & Pick<SpawnRequest, "env">,
): Record<string, string> {
  const owned = new Set(ADAPTER_VARIABLES.map((name) => name.toLowerCase()));
  const inherited = Object.fromEntries(
    Object.entries(request.env).filter(
      ([name]) => !owned.has(name.toLowerCase()),
    ),
  );
  return { ...inherited, ...adapterEnv(request) };
}
