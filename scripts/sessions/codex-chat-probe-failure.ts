import type { ChildExit } from "../executors/types";
import { markReadOnlyCapabilityRefusal } from "./read-only-capability-refusal";

/** Fixed, non-sensitive supervisor facts; provider output and launch fields stay private. */
export function codexChatProbeFailure(
  probe: "version" | "help",
  exit: ChildExit,
  invalidOutput: boolean,
  stdout: string,
): Error {
  const yesNo = (value: boolean) => (value ? "yes" : "no");
  const recognized =
    probe === "version"
      ? /^codex-cli\s+\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?(?:\s|$)/.test(stdout)
      : /(?:^|\s)--(?:stdio|listen)(?=\s|$)/.test(stdout);
  const output =
    stdout.length === 0 ? "empty" : recognized ? "recognized" : "unrecognized";
  return markReadOnlyCapabilityRefusal(
    new Error(
      `The Codex Chat capability probe failed. Probe: ${probe}; ` +
        `exit: ${exit.exitCode ?? "none"}; timed out: ${yesNo(exit.timedOut)}; ` +
        `stopped: ${yesNo(exit.stopped)}; invalid output: ${yesNo(invalidOutput)}; ` +
        `tree release confirmed: ${yesNo(exit.ownedTreeReleased === true)}; ` +
        `stdout: ${output}.`,
    ),
  );
}
