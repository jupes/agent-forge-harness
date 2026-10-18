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
    model: "claude-haiku-5-5",
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
 * `[shift]` as builtin, written as a file writes it: the one place each
 * default of a shift lives. The loader starts every `[shift]` from these;
 * `SHIFT_DEFAULTS` (scripts/scheduler/shift.ts) and the host sampler's default
 * threshold (scripts/scheduler/host-load.ts) are read from them. Decision 8
 * for `concurrency`, `for`, `repairs` and `throttle` (a share: 0.85 is 85%);
 * the count and the spend are x1gs.5.4's.
 */
export const BUILTIN_SHIFT = {
  concurrency: 2,
  for: "2h",
  max_beads: 4,
  max_usd: 10,
  repairs: 3,
  throttle: 0.85,
} as const;

/**
 * The bounds of a shift's options that `[shift]` also sets, each a whole
 * number from the first to the second: `shiftOptions` checks a shift's
 * options and the loader checks `[shift]` against these, and no other copy.
 */
export const SHIFT_LIMITS = {
  concurrency: [1, 8],
  forMs: [1, 24 * 60 * 60 * 1000],
  maxBeads: [1, 100],
  repairs: [0, 10],
} as const;

/** The most a shift may be given to spend, in US dollars (`maxUsd`, `[shift] max_usd`). */
export const SHIFT_MAX_USD = 1000;

/**
 * The range of the host threshold (`[shift] throttle`), a share. Below the
 * floor a shift would find any host that is doing anything too busy, and
 * admit nothing until its time ran out.
 */
export const SHIFT_THROTTLE = [0.1, 1] as const;

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
