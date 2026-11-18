import type { ChildExit } from "../executors/types";
import { markReadOnlyCapabilityRefusal } from "./read-only-capability-refusal";

/** Fixed, non-sensitive supervisor facts; provider output and launch fields stay private. */
export function codexChatProbeFailure(
  probe: "version" | "help",
  exit: ChildExit,
  invalidOutput: boolean,
): Error {
  const yesNo = (value: boolean) => (value ? "yes" : "no");
  return markReadOnlyCapabilityRefusal(
    new Error(
      `The Codex Chat capability probe failed. Probe: ${probe}; ` +
        `exit: ${exit.exitCode ?? "none"}; timed out: ${yesNo(exit.timedOut)}; ` +
        `stopped: ${yesNo(exit.stopped)}; invalid output: ${yesNo(invalidOutput)}; ` +
        `tree release confirmed: ${yesNo(exit.ownedTreeReleased === true)}.`,
    ),
  );
}
