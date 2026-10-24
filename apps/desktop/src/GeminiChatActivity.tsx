import type { ConversationPage } from "../../../types/conversation";
import { geminiChatPresentation } from "./gemini-chat-presentation";
import { SessionReply } from "./SessionReply";

/** The journal's capture turn never upgrades resumed session notifications to a current-turn reply. */
export function GeminiChatActivity({
  page,
  turnId,
  streaming = false,
  onCopy,
}: {
  page: ConversationPage | null;
  turnId: string;
  streaming?: boolean;
  onCopy?: (text: string) => void;
}) {
  const reports = geminiChatPresentation(page, turnId);
  return (
    <section aria-label="Gemini ACP Chat reports" class="af-session-activity">
      {reports.map((report) => {
        if (report.kind === "reply")
          return (
            <SessionReply
              key={report.sequence}
              text={report.text}
              streaming={streaming && report.open}
              onCopy={onCopy}
            />
          );
        if (report.kind === "native-text")
          return (
            <section
              key={report.sequence}
              class="af-session-native-history"
              aria-label="Native session history"
            >
              <h4>Native session history · {report.role}</h4>
              <p class="af-session-note">
                Captured during this request. Resumed ACP updates may replay
                earlier messages; their native turn is not reported.
              </p>
              <pre>{report.text}</pre>
              <button type="button" onClick={() => onCopy?.(report.text)}>
                Copy native session text
              </button>
            </section>
          );
        const event = report.event;
        if (event.kind === "tool")
          return (
            <details key={report.sequence}>
              <summary>
                {event.scope === "native-session"
                  ? "Native session tool report"
                  : "Native tool report"}{" "}
                · {event.status}
              </summary>
              {event.scope === "native-session" && (
                <p>Its native turn is not reported.</p>
              )}
              <p>Tool id: {event.toolCallId}</p>
              <pre>
                {event.detail.json}
                {event.detail.truncated ? " (truncated)" : ""}
              </pre>
            </details>
          );
        if (event.kind === "result")
          return (
            <details key={report.sequence} open>
              <summary>Reported prompt result · {event.stopReason}</summary>
              {event.usage ? (
                <dl>
                  <dt>Input tokens</dt>
                  <dd>{event.usage.inputTokens}</dd>
                  <dt>Output tokens</dt>
                  <dd>{event.usage.outputTokens}</dd>
                  <dt>Total tokens</dt>
                  <dd>{event.usage.totalTokens}</dd>
                  {event.usage.cachedReadTokens !== undefined && (
                    <>
                      <dt>Cached read tokens</dt>
                      <dd>{event.usage.cachedReadTokens}</dd>
                    </>
                  )}
                  {event.usage.thoughtTokens !== undefined && (
                    <>
                      <dt>Thought tokens</dt>
                      <dd>{event.usage.thoughtTokens}</dd>
                    </>
                  )}
                </dl>
              ) : (
                <p>Prompt usage was not reported.</p>
              )}
              <p>
                Prompt-result usage is separate from native context occupancy
                and account allowance.
              </p>
            </details>
          );
        if (event.kind === "context")
          return (
            <details key={report.sequence}>
              <summary>Reported native session context</summary>
              <p>
                {event.usedTokens} used tokens · {event.contextTokens} context
                tokens
              </p>
              <p>
                Native session occupancy; no accepted-turn identity is reported.
                This is not account allowance.
              </p>
            </details>
          );
        if (event.kind === "identity")
          return (
            <p key={report.sequence}>
              {event.resumed
                ? "Resumed exact native session"
                : "Created native session"}
              : {event.sessionId}
            </p>
          );
        if (event.kind === "outcome")
          return (
            <details key={report.sequence} open>
              <summary>Native Chat outcome: {event.outcome.phase}</summary>
              <p>{event.outcome.reason}</p>
              <p>
                Exit: {event.exitCode ?? "unavailable"}
                {event.stopped ? " · Stopped" : ""}
                {event.timedOut ? " · Timed out" : ""}
              </p>
              {event.stderr.text && (
                <pre>
                  {event.stderr.text}
                  {event.stderr.truncated ? " (truncated)" : ""}
                </pre>
              )}
            </details>
          );
        if (event.kind === "error")
          return (
            <p key={report.sequence} role="status">
              Native error {event.code}: {event.message.text}
              {event.message.truncated ? " (truncated)" : ""}
            </p>
          );
        if (event.kind === "permission")
          return (
            <details key={report.sequence}>
              <summary>Saved native permission request</summary>
              <pre>
                {event.detail.json}
                {event.detail.truncated ? " (truncated)" : ""}
              </pre>
              <p>
                Read-only history. This report does not provide a live
                permission control.
              </p>
            </details>
          );
        if (event.kind === "permission-intent")
          return (
            <p key={report.sequence}>
              Saved native permission intent: {event.optionId ?? "cancelled"}.
              Delivery and execution are reported separately.
            </p>
          );
        // Process, permission and intent history cannot supply executable approval controls.
        return null;
      })}
    </section>
  );
}
