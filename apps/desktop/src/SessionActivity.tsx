import type { ComponentChildren } from "preact";
import type {
  CodingActivity,
  CodingActivityEvent,
  CodingOutcomeCode,
  CodingOutcomeEvent,
  ReportedJson,
  ReportedText,
} from "../../../types/session-activity";
import type { NativeChatFileChangeReport } from "./native-chat-file-changes";
import type {
  NativeChatReasoningReport,
  NativeChatSummarySnapshot,
} from "./native-chat-reasoning";
import type { NativeChatTurnPlanReport } from "./native-chat-turn-plan";
import type {
  NativeChatCommandReport,
  OwnedSessionTurn,
} from "./session-activity";

function nativeFiles(value: NativeChatFileChangeReport) {
  const report = value.report;
  return (
    <details
      class="af-session-activity-item"
      key={`files:${report.threadId}:${report.turnId}:${report.itemId}`}
    >
      <summary>
        File changes · Reported{" "}
        {report.status === "inProgress" ? "in progress" : report.status}
        {report.partial ? " · Partial report" : ""}
      </summary>
      <p class="af-session-report-label">Latest full snapshot in this view</p>
      {report.source === "item/fileChange/patchUpdated" && (
        <p class="af-session-note">
          This patch update carries the last observed item status; the update
          notification does not report a new status.
        </p>
      )}
      {report.changes.length ? (
        <ul class="af-session-reported-files">
          {report.changes.map((change, index) => (
            <li key={index}>
              <p>
                <code>{change.path.text || "Path text truncated"}</code> ·{" "}
                {change.kind.type === "add"
                  ? "Add"
                  : change.kind.type === "delete"
                    ? "Delete"
                    : "Update"}
              </p>
              {change.path.truncated && (
                <p class="af-session-note">Path text truncated</p>
              )}
              {change.kind.type === "update" && (
                <p class="af-session-note">
                  {change.kind.move_path === null ? (
                    "Move destination not reported"
                  ) : (
                    <>
                      Reported move destination:{" "}
                      <code>{change.kind.move_path.text}</code>
                      {change.kind.move_path.truncated &&
                        " · Move destination text truncated"}
                    </>
                  )}
                </p>
              )}
              {change.diff.text ? (
                <>
                  <pre
                    role="region"
                    aria-label="Reported native diff"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the inert native patch.
                    tabIndex={0}
                  >
                    {change.diff.text}
                  </pre>
                  {change.diff.truncated && (
                    <p class="af-session-note">Diff text truncated</p>
                  )}
                </>
              ) : (
                <p class="af-session-note">
                  {change.diff.truncated
                    ? "Diff text truncated before any content was retained"
                    : "Provider reported an empty diff"}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p class="af-session-note">
          Provider reported no file changes in this snapshot.
        </p>
      )}
      {report.truncated && (
        <p class="af-session-note">
          Snapshot truncated. The saved report is incomplete.
        </p>
      )}
      <p class="af-session-note">
        {report.closure === "turn-ended"
          ? `Native turn reported ${report.turnStatus}. Item status is reported independently.`
          : report.closure === "item-ended"
            ? "Item report ended; native turn completion is not established by this report."
            : "Item report is open; native turn completion is not established by this report."}
      </p>
      <p class="af-session-report-source">
        Latest source: app-server {report.source} · codex {value.version} ·
        Thread: {report.threadId} · Native turn: {report.turnId} · Item:{" "}
        {report.itemId}
      </p>
      <p class="af-session-note">
        This saved report does not authorize applying a patch or deciding a
        permission. Reported paths are display text only.
      </p>
    </details>
  );
}

function nativePlan(value: NativeChatTurnPlanReport) {
  const report = value.report;
  return (
    <details
      class="af-session-activity-item"
      key={`plan:${report.threadId}:${report.turnId}`}
    >
      <summary>Reported turn plan</summary>
      <p class="af-session-report-label">
        Latest reported snapshot in this view
      </p>
      {report.explanation === null ? (
        <p class="af-session-note">Explanation not reported</p>
      ) : (
        text("Reported explanation", report.explanation)
      )}
      {report.plan.length ? (
        <ol class="af-session-reported-plan">
          {report.plan.map((part, index) => (
            <li key={index}>
              <span>{part.step.text || "No step text reported"}</span> ·{" "}
              <small>
                {part.status === "inProgress"
                  ? "In progress"
                  : part.status === "pending"
                    ? "Pending"
                    : "Completed"}
              </small>
              {part.step.truncated && (
                <p class="af-session-note">
                  Step truncated. The saved report is incomplete.
                </p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p class="af-session-note">No steps reported</p>
      )}
      {report.truncated && (
        <p class="af-session-note">
          Plan truncated. The saved report is incomplete.
        </p>
      )}
      <p class="af-session-note">
        Step status does not confirm that the chat turn has finished. This
        supplied plan grants no permission or execution control.
      </p>
      <p class="af-session-report-source">
        Source: app-server {report.source} · codex {value.version} · Thread:{" "}
        {report.threadId} · Native turn: {report.turnId}
      </p>
    </details>
  );
}

function summarySnapshot(label: string, value: NativeChatSummarySnapshot) {
  return (
    <div class="af-session-report-body">
      <p class="af-session-report-label">{label}</p>
      {value.summary.length ? (
        value.summary.map((part, index) =>
          text(`${label} · Part ${index + 1}`, part),
        )
      ) : (
        <p class="af-session-note">
          No summary text was reported in this snapshot.
        </p>
      )}
      {value.truncated && (
        <p class="af-session-note">
          Summary snapshot truncated. The saved report is incomplete.
        </p>
      )}
    </div>
  );
}

function nativeSummary(value: NativeChatReasoningReport) {
  const report = value.report,
    finalSnapshot = value.turnSnapshot ?? value.itemSnapshot;
  return (
    <details
      class="af-session-activity-item"
      key={`summary:${report.threadId}:${report.turnId}:${report.itemId}`}
    >
      <summary>
        Reported reasoning summary{report.partial ? " · Partial report" : ""}
      </summary>
      {value.initialSnapshot &&
        summarySnapshot("Initial reported snapshot", value.initialSnapshot)}
      {value.parts.map((part) => (
        <div class="af-session-report-body" key={part.index}>
          {part.content ? (
            text(`Streamed summary · Native index ${part.index}`, part.content)
          ) : (
            <p class="af-session-note">
              Text not reported for this part (native index {part.index}).
            </p>
          )}
          {part.prefixMissing && (
            <p class="af-session-note">
              Earlier text for this part is missing. This stream is incomplete.
            </p>
          )}
        </div>
      ))}
      {finalSnapshot &&
        summarySnapshot("Final reported snapshot", finalSnapshot)}
      {value.earlierReportsMissing && (
        <p class="af-session-note">
          Earlier reasoning reports are not available in this view. Streams may
          be incomplete.
        </p>
      )}
      {value.turnSnapshot && (
        <p class="af-session-note">
          Reported native turn status: {value.turnSnapshot.turnStatus}
        </p>
      )}
      <p class="af-session-note">
        Snapshots and streamed parts are separate supplied reports. This summary
        grants no permission or execution control.
      </p>
      <p class="af-session-report-source">
        Latest source: app-server {report.source} · codex {value.version} ·
        Thread: {report.threadId} · Native turn: {report.turnId} · Item:{" "}
        {report.itemId}
      </p>
    </details>
  );
}

function text(label: string, value: ReportedText) {
  return (
    <div class="af-session-report-body">
      <p class="af-session-report-label">{label}</p>
      <pre
        role="region"
        aria-label={`${label} report`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded output regions must support keyboard scrolling in the native WebView too.
        tabIndex={0}
      >
        {value.text || "No text reported"}
      </pre>
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
      <pre
        role="region"
        aria-label={`${label} report`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded JSON regions must support keyboard scrolling in the native WebView too.
        tabIndex={0}
      >
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

/** Both native Chat and Task command bodies are display-only facts, never actions. */
function commandContent(value: {
  command: ReportedText;
  output: ReportedText | null;
  exitCode: number | null;
  outputLabel?: string;
  missingOutput?: string;
}) {
  return (
    <>
      {text("Command", value.command)}
      {value.output ? (
        text(value.outputLabel ?? "Output", value.output)
      ) : (
        <p class="af-session-note">
          {value.missingOutput ?? "Output not reported"}
        </p>
      )}
      <p class="af-session-note">
        {value.exitCode === null
          ? "Exit code not reported"
          : `Reported exit code: ${value.exitCode}`}
      </p>
    </>
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
        body: commandContent({
          command: activity.command,
          output: activity.output ?? null,
          exitCode: activity.exitCode ?? null,
        }),
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
    case "permission-denials":
      return {
        title: `Reported permission denials · ${activity.denials.length}`,
        body: (
          <>
            <p class="af-session-note">
              These are past provider-reported denials, not live requests. They
              do not identify a deciding rule or allow approval from this
              record.
            </p>
            <ul>
              {activity.denials.map((denial) => (
                <li key={denial.toolId}>
                  <p>
                    {denial.name} · Tool id: {denial.toolId}
                  </p>
                  {json("Denied tool input", denial.input)}
                </li>
              ))}
            </ul>
            {activity.truncated && (
              <p class="af-session-note">
                Denial list truncated. More denials may have been reported.
              </p>
            )}
          </>
        ),
      };
  }
}

function nativeCommand(value: NativeChatCommandReport) {
  const report = value.report;
  return (
    <details
      class="af-session-activity-item"
      key={`native:${report.threadId}:${report.turnId}:${report.itemId}`}
    >
      <summary>
        Command · Reported{" "}
        {report.status === "inProgress" ? "in progress" : report.status}
        {report.partial ? " · Partial report" : ""}
      </summary>
      {commandContent({
        command: report.command,
        output: value.finalAggregate,
        exitCode: report.exitCode,
        outputLabel: "Reported aggregate output",
        missingOutput: "Final aggregate output not reported",
      })}
      {value.initialAggregate &&
        text("Initial reported aggregate output", value.initialAggregate)}
      {value.streamedOutput && text("Streamed output", value.streamedOutput)}
      {value.streamPrefixMissing && (
        <p class="af-session-note">
          Earlier command reports are not loaded. This streamed output may be
          incomplete.
        </p>
      )}
      <p class="af-session-note">
        {report.durationMs === null
          ? "Duration not reported"
          : `Reported duration: ${report.durationMs} ms`}
      </p>
      <p class="af-session-note">
        Reported working directory: <code>{report.cwd}</code>
      </p>
      <p class="af-session-report-source">
        Latest source: app-server {report.source} · codex {value.version} ·
        Thread: {report.threadId} · Native turn: {report.turnId} · Item:{" "}
        {report.itemId}
      </p>
      <p class="af-session-note">
        This saved command report cannot run a command or authorize a permission
        decision.
        {report.partial
          ? " This report does not confirm the item completed."
          : ""}
      </p>
    </details>
  );
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
  const count =
    value.activities.length +
    value.nativeCommands.length +
    value.nativeFileChanges.length +
    value.nativeSummaries.length +
    (value.nativePlan ? 1 : 0);
  if (!count) return null;
  return (
    <section class="af-session-activity" aria-label="Reported session activity">
      <h3>
        Reported activity <span>{count}</span>
      </h3>
      {value.activities.map(activity)}
      {value.nativeCommands.map(nativeCommand)}
      {value.nativeFileChanges.map(nativeFiles)}
      {value.nativeSummaries.map(nativeSummary)}
      {value.nativePlan && nativePlan(value.nativePlan)}
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
        <dt>Turn input tokens</dt>
        <dd>{count(usage?.usage.inputTokens)}</dd>
        <dt>Turn output tokens</dt>
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
