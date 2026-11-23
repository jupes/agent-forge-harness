/**
 * What a run's result means: success, or why not in the provider's own words.
 * The words are for a command's output only; the ledger records the fixed
 * `session.ended` reasons `cli-adapter.ts` writes.
 */

import { PRIVATE_CAPTURE_FAILURE } from "./private-capture";
import type { ExecResult } from "./types";

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

/**
 * Why a run did not succeed, or null when it did: the provider exited 0 on
 * its own and reported no error in its stream. After a non-zero exit the
 * reason is the first error the provider reported, else the last line of its
 * stderr. An exit 0 after a reported error is not a success.
 */
export function runFailure(result: ExecResult): string | null {
  if (result.privateCaptureFailed) return PRIVATE_CAPTURE_FAILURE;
  if (result.timedOut) return "timed out";
  const [reported] = result.providerErrors;
  if (result.exitCode !== 0) {
    const said = reported ?? lastLine(result.stderr);
    return said
      ? `provider exited ${result.exitCode}: ${said}`
      : `provider exited ${result.exitCode}`;
  }
  if (reported !== undefined) {
    return `provider exited 0 but reported an error: ${reported}`;
  }
  return null;
}
