import type { ConversationPage } from "../../../types/conversation";

/** Display native facts verbatim as private data; text delta flags never imply missing message identities. */
export function GeminiTaskActivity({
  page,
  turnId,
}: {
  page: ConversationPage | null;
  turnId: string;
}) {
  const frames =
    page?.frames.filter(
      (frame) =>
        frame.turnId === turnId && frame.event.kind === "coding-gemini-task",
    ) ?? [];
  if (!frames.length) return null;
  return (
    <section aria-label="Gemini Task reports" class="af-session-activity">
      <p class="af-session-note">
        Gemini CLI native reports. Configured model is a selection label;
        per-model usage is reported separately. Account allowance and context
        occupancy are unavailable.
      </p>
      {frames.map((frame) => {
        if (frame.event.kind !== "coding-gemini-task") return null;
        const event = frame.event.event;
        if (event.kind === "text")
          return (
            <article key={frame.seq} aria-label="Gemini native text">
              <small>{event.delta ? "Native text delta" : "Native text"}</small>
              <pre>{event.text}</pre>
            </article>
          );
        if (event.kind === "identity")
          return (
            <p key={frame.seq}>
              Configured model: {event.configuredModel} · Gemini CLI{" "}
              {event.version}
            </p>
          );
        if (event.kind === "process")
          return (
            <details key={frame.seq}>
              <summary>Native process</summary>
              <p>
                PID {event.pid} · {event.smith} · Requested{" "}
                {event.requestedModel ?? "CLI default model"}
              </p>
            </details>
          );
        if (event.kind === "notice")
          return (
            <div key={frame.seq} role="status">
              <p>
                {event.severity}: {event.message.text}
                {event.message.truncated ? " (truncated)" : ""}
              </p>
              {event.reportedType && <small>{event.reportedType}</small>}
            </div>
          );
        if (event.kind === "tool")
          return (
            <details key={frame.seq}>
              <summary>
                {event.name} · {event.state}
              </summary>
              <p>Tool id: {event.id}</p>
              {event.input && (
                <pre>
                  {event.input.json}
                  {event.input.truncated ? " (truncated)" : ""}
                </pre>
              )}
              {event.output && (
                <pre>
                  {event.output.text}
                  {event.output.truncated ? " (truncated)" : ""}
                </pre>
              )}
              {event.error && (
                <p>
                  {event.error.type}: {event.error.message.text}
                  {event.error.message.truncated ? " (truncated)" : ""}
                </p>
              )}
            </details>
          );
        if (event.kind === "usage")
          return (
            <details key={frame.seq} open>
              <summary>Reported Task usage</summary>
              <p>
                {event.usage.inputTokens} input · {event.usage.outputTokens}{" "}
                output · {event.usage.cachedInputTokens} cached input ·{" "}
                {event.usage.uncachedInputTokens} uncached input ·{" "}
                {event.usage.totalTokens} total tokens
              </p>
              <p>
                {event.usage.durationMs} ms · {event.usage.toolCalls} tool calls
              </p>
              <ul>
                {Object.entries(event.usage.models).map(([model, usage]) => (
                  <li key={model}>
                    {model}: {usage.inputTokens} input · {usage.outputTokens}{" "}
                    output · {usage.cachedInputTokens} cached input ·{" "}
                    {usage.uncachedInputTokens} uncached input ·{" "}
                    {usage.totalTokens} total tokens
                  </li>
                ))}
              </ul>
            </details>
          );
        return (
          <details key={frame.seq} open>
            <summary>Native Task outcome: {event.outcome.phase}</summary>
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
      })}
    </section>
  );
}
