import type { CodexChatOutcome } from "../../../types/codex-chat";

/** Saved native facts explain an ended turn; they never grant process or reply authority. */
export function CodexChatTerminal({
  value,
}: {
  value: CodexChatOutcome | null;
}) {
  if (!value) return null;
  return (
    <section class="af-session-chat-outcome" aria-label="Native Chat outcome">
      <h3>Native Chat outcome</h3>
      <p>
        {value.phase === "completed"
          ? "Completed"
          : value.phase === "failed"
            ? "Failed"
            : "Outcome unknown"}
      </p>
      <p>{value.reason}</p>
      <dl>
        <dt>Process exit code</dt>
        <dd>{value.exitCode ?? "Not reported"}</dd>
        <dt>Time limit reached</dt>
        <dd>{value.timedOut ? "Yes" : "No"}</dd>
        <dt>Supervisor stopped the process</dt>
        <dd>{value.stopped ? "Yes" : "No"}</dd>
        <dt>Native turn</dt>
        <dd>{value.turnId ?? "Not reported"}</dd>
      </dl>
    </section>
  );
}
