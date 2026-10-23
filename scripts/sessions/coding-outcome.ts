import type { CodingOutcomeEvent } from "../../types/session-activity";
import type { ChildExit } from "../executors/types";
import { codingOutcomeSchema, reportedText } from "./activity-protocol";
/** Only trusted parser/supervisor facts enter this projection. Error words never classify a failure. */
export function codingOutcome(input: {
  provider: "claude" | "codex";
  version: string;
  exit: ChildExit;
  phase: "completed" | "failed" | "unknown";
  protocolFailure?: boolean;
  storageFailure?: boolean;
  providerFailure?: boolean;
  reportedCode?: string | null;
  message?: string | null;
}): CodingOutcomeEvent {
  const { exit } = input;
  const code = exit.timedOut
    ? "timed-out"
    : input.storageFailure
      ? "storage-error"
      : input.protocolFailure
        ? "protocol-error"
        : exit.stopped
          ? "stopped"
          : input.phase === "completed"
            ? "completed"
            : input.providerFailure
              ? input.provider === "claude" &&
                ["authentication_failed", "oauth_org_not_allowed"].includes(
                  input.reportedCode ?? "",
                )
                ? "auth-error"
                : input.provider === "claude" &&
                    input.reportedCode === "rate_limit"
                  ? "rate-limited"
                  : "provider-error"
              : exit.exitCode !== 0
                ? "cli-exit"
                : "protocol-error";
  return codingOutcomeSchema.parse({
    kind: "coding-outcome",
    provider: input.provider,
    version: input.version,
    code,
    exitCode: exit.exitCode,
    timedOut: exit.timedOut,
    stopped: exit.stopped,
    message: input.message ? reportedText(input.message) : null,
    stderrTail: reportedText(exit.stderr),
    ...(input.reportedCode ? { reportedCode: input.reportedCode } : {}),
  });
}
