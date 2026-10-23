import type { ComponentChildren } from "preact";
import type {
  CodingActivity,
  CodingActivityEvent,
  CodingOutcomeCode,
  CodingOutcomeEvent,
  ReportedJson,
  ReportedText,
} from "../../../types/session-activity";
import type { OwnedSessionTurn } from "./session-activity";

function text(label: string, value: ReportedText) {
  return (
    <div class="af-session-report-body">
      <p class="af-session-report-label">{label}</p>
      <pre>{value.text || "No text reported"}</pre>
      {value.truncated && (
        <p class="af-session-note">
          {label} truncated. The saved report is incomplete.
        </p>
      )}
    </div>
  );
}

function json(label: string, value: ReportedJson) {
  return (
    <div class="af-session-report-body">
      <p class="af-session-report-label">{label}</p>
      <pre>
        <code>{value.json}</code>
      </pre>
      {value.truncated && (
        <p class="af-session-note">
          {label} truncated{value.omitted ? ` (${value.omitted} limit)` : ""}.
          The saved report is incomplete.
        </p>
      )}
    </div>
  );
}

function content(activity: CodingActivity): {
  title: string;
  body: ComponentChildren;
} {
  switch (activity.kind) {
    case "reasoning":
      return {
        title: `Reported reasoning${activity.redacted ? " · Redacted" : ""}`,
        body: activity.redacted ? (
          <p class="af-session-note">
            Reasoning was redacted by the provider. No hidden content is
            available.
          </p>
        ) : (
          text("Reasoning", activity.content)
        ),
      };
    case "tool":
      return {
        title: `Tool · ${activity.name} · Reported ${activity.state}`,
        body: (
          <>
            {activity.input && json("Input", activity.input)}
            {activity.output && json("Output", activity.output)}
            {activity.error && text("Reported error", activity.error)}
            <p class="af-session-note">
              Tool id: {activity.toolId}. This report is not a permission
              request.
            </p>
          </>
        ),
      };
    case "command":
      return {
        title: `Command · Reported ${activity.state}`,
        body: (
          <>
            {text("Command", activity.command)}
            {activity.output ? (
              text("Output", activity.output)
            ) : (
              <p class="af-session-note">Output not reported</p>
            )}
            <p class="af-session-note">
              {activity.exitCode === undefined
                ? "Exit code not reported"
                : `Reported exit code: ${activity.exitCode}`}
            </p>
          </>
        ),
      };
    case "files":
      return {
        title: `Files changed · ${activity.changes.length} reported · ${activity.state}`,
        body: (
          <>
            {activity.changes.length ? (
              <ul class="af-session-reported-files">
                {activity.changes.map((change, index) => (
                  <li key={`${change.path}:${index}`}>
                    <p>
                      <code>{change.path}</code> · {change.operation}
                    </p>
                    <p class="af-session-note">
                      {change.additions === undefined &&
                      change.deletions === undefined
                        ? "Line counts not reported"
                        : `${change.additions === undefined ? "Additions not reported" : `+${change.additions}`} · ${change.deletions === undefined ? "Deletions not reported" : `−${change.deletions}`}`}
                    </p>
                    {change.diff ? (
                      text("Reported diff", change.diff)
                    ) : (
                      <p class="af-session-note">Diff not reported</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p class="af-session-note">
                The provider reported no file changes in this item.
              </p>
            )}
            {activity.truncated && (
              <p class="af-session-note">
                File list truncated. More paths may have been reported.
              </p>
            )}
          </>
        ),
      };
    case "plan":
      return {
        title: `Plan · ${activity.steps.length} reported steps`,
        body: (
          <>
            <ol class="af-session-reported-plan">
              {activity.steps.map((step, index) => (
                <li key={index}>
                  <span>{step.content.text}</span> · <small>{step.state}</small>
                  {step.content.truncated && (
                    <p class="af-session-note">Step truncated</p>
                  )}
                </li>
              ))}
            </ol>
            {activity.truncated && (
              <p class="af-session-note">
                Plan truncated. More steps may have been reported.
              </p>
            )}
          </>
        ),
      };
    case "structured-output":
      return {
        title: "Structured output",
        body: json("Reported JSON", activity.output),
      };
  }
}

function activity(event: CodingActivityEvent) {
  const report = content(event.activity);
  return (
    <details
      class="af-session-activity-item"
      key={`${event.provider}:${event.version}:${event.activity.kind}:${event.id}`}
    >
      <summary>
        {report.title}
        {event.partial ? " · Partial report" : ""}
      </summary>
      {report.body}
      <p class="af-session-report-source">
        Latest source: {event.source} · {event.provider} {event.version} ·
        Report id: {event.id}
      </p>
      {event.partial && (
        <p class="af-session-note">
          This is a partial report. It does not confirm the operation finished.
        </p>
      )}
    </details>
  );
}

/** All payloads remain inert text; reported paths never trigger local file reads. */
export function SessionActivity({ value }: { value: OwnedSessionTurn }) {
  if (!value.activities.length) return null;
  return (
    <section class="af-session-activity" aria-label="Reported session activity">
      <h3>
        Reported activity <span>{value.activities.length}</span>
      </h3>
      {value.activities.map(activity)}
    </section>
  );
}

const outcomeLabels: Record<CodingOutcomeCode, string> = {
  completed: "Provider turn completed",
  stopped: "Stop confirmed",
  "timed-out": "Process timed out",
  "provider-error": "Provider reported an error",
  "auth-error": "Provider reported an authentication error",
  "rate-limited": "Provider reported a usage limit",
  "cli-exit": "Provider process exited with an error",
  "protocol-error": "Provider reports could not be confirmed",
  "storage-error": "Private activity could not be saved",
};

export function SessionOutcome({
  value,
}: {
  value: CodingOutcomeEvent | null;
}) {
  if (!value) return null;
  return (
    <details class="af-session-outcome">
      <summary>{outcomeLabels[value.code]}</summary>
      <dl>
        <dt>Reported by</dt>
        <dd>
          {value.provider} {value.version}
        </dd>
        <dt>Process exit code</dt>
        <dd>{value.exitCode ?? "Not reported"}</dd>
        {value.reportedCode && (
          <>
            <dt>Provider code</dt>
            <dd>
              <code>{value.reportedCode}</code>
            </dd>
          </>
        )}
        {value.code === "rate-limited" && (
          <>
            <dt>Reset</dt>
            <dd>
              {value.resetAt ? (
                <time dateTime={value.resetAt}>
                  {new Date(value.resetAt).toLocaleString()}
                </time>
              ) : (
                "Not reported. Check Providers for current allowance."
              )}
            </dd>
          </>
        )}
      </dl>
      {value.stopped && value.code !== "stopped" && (
        <p class="af-session-note">
          Supervisor stopped the process
          {value.timedOut ? " at its time limit" : " after an interruption"}.
          This does not confirm an operator Stop.
        </p>
      )}
      {value.message && text("Reported message", value.message)}
      {value.stderrTail.text && text("Process stderr tail", value.stderrTail)}
      <p class="af-session-note">
        This outcome is recorded with the private turn. No request was resent.
      </p>
    </details>
  );
}

function count(value: number | undefined) {
  return value === undefined ? "— · Not reported" : value.toLocaleString();
}

export function SessionTurnUsage({
  value,
  requestedModel,
}: {
  value: OwnedSessionTurn;
  requestedModel: string | null;
}) {
  const usage = value.usage;
  return (
    <details class="af-session-turn-usage">
      <summary>
        Turn model and usage{usage ? " · Reported" : " · Not reported"}
      </summary>
      <dl>
        <dt>Requested model</dt>
        <dd>{requestedModel ?? "Not reported"}</dd>
        <dt>Observed model</dt>
        <dd>{value.observedModel ?? "Not reported"}</dd>
        <dt>Reported input tokens</dt>
        <dd>{count(usage?.usage.inputTokens)}</dd>
        <dt>Reported output tokens</dt>
        <dd>{count(usage?.usage.outputTokens)}</dd>
        {usage?.provider === "codex" && (
          <>
            <dt>Cached input tokens</dt>
            <dd>{count(usage.usage.cachedInputTokens)}</dd>
          </>
        )}
        {usage?.provider === "claude" && (
          <>
            <dt>Cache read tokens</dt>
            <dd>{count(usage.usage.cacheReadInputTokens)}</dd>
            <dt>Cache creation tokens</dt>
            <dd>{count(usage.usage.cacheCreationInputTokens)}</dd>
            <dt>Cumulative provider cost estimate (USD)</dt>
            <dd>
              {usage.cumulativeEstimateUsd === undefined
                ? "— · Not reported"
                : String(usage.cumulativeEstimateUsd)}
            </dd>
            {usage.durationMs !== undefined && (
              <>
                <dt>Reported turn duration (ms)</dt>
                <dd>{count(usage.durationMs)}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {usage?.provider === "claude" && (
        <p class="af-session-note">
          The cost estimate may include earlier resumed turns. It is not this
          turn's charge or remaining allowance.
        </p>
      )}
      <p class="af-session-report-source">
        {usage
          ? `Source: ${usage.source} · ${usage.provider} ${usage.version}`
          : "The provider has not reported usage for this turn. Earlier turns are not substituted."}
      </p>
    </details>
  );
}
