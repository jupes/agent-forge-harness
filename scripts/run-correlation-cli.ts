#!/usr/bin/env bun
/**
 * run-correlation-cli.ts — correlate a run to the Beads issue it works on.
 *
 *   bun run forge:correlate --bead <beads-id> [--run <run-id>] [--checkout <dir>]
 *
 * For work that has no phase gate to do it (`forge:phase-gate --write --bead`
 * writes the same file for a pipeline run). Writes the run's correlation in
 * the checkout and prints where it is; hand that to the quality gate:
 *
 *   bun run quality-gate --correlation <data.correlation.pointer>
 *
 * The bead is given outright, so a run already correlated to another bead is
 * rebound. Without --run a new run id is minted.
 *
 * Output is always a single JSON object: { ok, data, error }.
 * Exit code 0 when ok, 2 when not.
 */

import { RUN_CORRELATION_ENV } from "./run-correlation";
import { correlationReport, initRunCorrelation } from "./run-correlation-store";

export interface CorrelateOutcome {
  code: 0 | 2;
  body: { ok: boolean; data: unknown; error: string | null };
}

/** The value after `--name`, or undefined when the flag is absent or last. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function runCorrelate(
  argv: readonly string[],
  deps: { cwd: string },
): CorrelateOutcome {
  const bead = flagValue(argv, "bead");
  if (bead === undefined) {
    return {
      code: 2,
      body: {
        ok: false,
        data: null,
        error:
          "usage: forge:correlate --bead <beads-id> [--run <run-id>] [--checkout <dir>]",
      },
    };
  }
  const run = flagValue(argv, "run");
  const made = initRunCorrelation({
    checkout: flagValue(argv, "checkout") ?? deps.cwd,
    beadsIssueId: bead,
    ...(run !== undefined ? { executionRunId: run } : {}),
    rebind: true,
  });
  if (!made.ok) {
    return { code: 2, body: { ok: false, data: null, error: made.error } };
  }
  return {
    code: 0,
    body: {
      ok: true,
      data: {
        correlation: correlationReport(made.correlation),
        path: made.path,
        env: { [RUN_CORRELATION_ENV]: made.path },
      },
      error: null,
    },
  };
}

if (import.meta.main) {
  const outcome = runCorrelate(process.argv.slice(2), { cwd: process.cwd() });
  console.log(JSON.stringify(outcome.body, null, 2));
  process.exit(outcome.code);
}
