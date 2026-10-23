import type { CodexChatUsage as NativeUsage } from "../../../types/codex-chat";

/** Native response and thread counters have distinct scopes; neither is an inferred turn sum. */
export function CodexChatUsage({
  usage,
  requestedModel,
}: {
  usage: NativeUsage | null;
  requestedModel?: string | null;
}) {
  return (
    <section class="af-session-chat-usage" aria-label="Native Chat usage">
      <h3>Native Chat usage</h3>
      {requestedModel !== undefined && (
        <dl class="af-session-kv">
          <dt>Requested model</dt>
          <dd>{requestedModel ?? "Not reported"}</dd>
          <dt>Observed model</dt>
          <dd>Not reported</dd>
        </dl>
      )}
      {usage ? (
        <table>
          <thead>
            <tr>
              <th>Reported tokens</th>
              <th>Latest native response</th>
              <th>Native thread total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Input</th>
              <td>{usage.lastResponse.inputTokens ?? "Not reported"}</td>
              <td>{usage.threadTotal.inputTokens ?? "Not reported"}</td>
            </tr>
            <tr>
              <th>Output</th>
              <td>{usage.lastResponse.outputTokens ?? "Not reported"}</td>
              <td>{usage.threadTotal.outputTokens ?? "Not reported"}</td>
            </tr>
            <tr>
              <th>Cached input</th>
              <td>{usage.lastResponse.cachedInputTokens ?? "Not reported"}</td>
              <td>{usage.threadTotal.cachedInputTokens ?? "Not reported"}</td>
            </tr>
            <tr>
              <th>Reasoning output</th>
              <td>
                {usage.lastResponse.reasoningOutputTokens ?? "Not reported"}
              </td>
              <td>
                {usage.threadTotal.reasoningOutputTokens ?? "Not reported"}
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p class="af-session-note">
          Native response and thread usage have not been reported.
        </p>
      )}
    </section>
  );
}
