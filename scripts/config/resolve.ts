import type { BenchName, Smith } from "../../types/hearth";
import type { ForgeConfig } from "./load";

export interface ResolveInput {
  /** `--smith` on the command line. */
  explicit?: string | undefined;
  /** `smith` metadata on the bead. */
  beadSmith?: string | undefined;
  /** The bead's `complexity:*` label, when it has one. */
  complexity?: BenchName | undefined;
  /** Seed for the deterministic weighted bench pick (the bead id). */
  seed?: string | undefined;
}

export type Resolution =
  | { ok: true; smith: Smith; via: "explicit" | "bead" | "bench" | "default" }
  | { ok: false; error: string };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Weighted pick that is stable for one seed, so a bead keeps its smith across retries. */
export function pickFromBench(
  bench: ReadonlyArray<{ smith: string; weight: number }>,
  seed: string,
): string {
  const total = bench.reduce((sum, e) => sum + e.weight, 0);
  let point = hash(seed) % total;
  for (const entry of bench) {
    if (point < entry.weight) return entry.smith;
    point -= entry.weight;
  }
  return (bench[bench.length - 1] as { smith: string }).smith;
}

/**
 * Smith resolution order (03-target-architecture §9): explicit flag, bead
 * metadata, bench by complexity, `workflow.default_crew`. A named smith that is
 * unknown or disabled is an error, never a silent fall-through.
 */
export function resolveSmith(
  config: ForgeConfig,
  input: ResolveInput,
): Resolution {
  let name: string;
  let via: "explicit" | "bead" | "bench" | "default";
  if (input.explicit) {
    name = input.explicit;
    via = "explicit";
  } else if (input.beadSmith) {
    name = input.beadSmith;
    via = "bead";
  } else if (input.complexity) {
    name = pickFromBench(config.benches[input.complexity], input.seed ?? "");
    via = "bench";
  } else {
    name = config.workflow.defaultCrew;
    via = "default";
  }
  const smith = config.smiths[name];
  if (!smith) return { ok: false, error: `unknown smith "${name}"` };
  if (!smith.enabled)
    return { ok: false, error: `smith "${name}" is disabled` };
  return { ok: true, smith, via };
}
