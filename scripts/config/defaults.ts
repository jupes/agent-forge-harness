import type { BenchName, Smith } from "../../types/hearth";

export interface BenchEntry {
  smith: string;
  weight: number;
}

/** Built-in smiths (decision #5 in docs/plans/command-center/05-decisions.md). */
export const BUILTIN_SMITHS: Readonly<Record<string, Smith>> = {
  "claude-master": {
    name: "claude-master",
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    enabled: true,
    tags: ["rank:master"],
  },
  "claude-journeyman": {
    name: "claude-journeyman",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    enabled: true,
    tags: ["rank:journeyman"],
  },
  "claude-apprentice": {
    name: "claude-apprentice",
    provider: "claude",
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    enabled: true,
    tags: ["rank:apprentice"],
  },
  "codex-journeyman": {
    name: "codex-journeyman",
    provider: "codex",
    model: "gpt-5-codex",
    effort: "medium",
    enabled: true,
    tags: ["rank:journeyman"],
  },
};

export const BUILTIN_DEFAULT_CREW = "claude-journeyman";

export const BUILTIN_BENCHES: Readonly<Record<BenchName, BenchEntry[]>> = {
  low: [
    { smith: "claude-apprentice", weight: 70 },
    { smith: "codex-journeyman", weight: 30 },
  ],
  medium: [
    { smith: "claude-journeyman", weight: 70 },
    { smith: "codex-journeyman", weight: 30 },
  ],
  high: [{ smith: "claude-master", weight: 100 }],
};

/**
 * Always passed to spawned executors: without these a child cannot start on
 * Windows (or find itself). Matched case-insensitively. Config `pass` only adds.
 *
 * `AGENT_FORGE_HOME` is here because it names where the ledger and the hearth
 * keep their files: a child that lost it would fall back to the OS home, and
 * the hooks of a session started from a sandbox would write the real ledger.
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "USERPROFILE",
  "HOME",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "AGENT_FORGE_HOME",
];
