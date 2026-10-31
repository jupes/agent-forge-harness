import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import type { SessionObservedActivity } from "../../../types/session-observations";
import { desktopHref } from "./navigation";
import { ObjectActivityTabs, ScopedProjectActivity } from "./ProjectActivity";
import type { SessionObservationRow } from "./session-observations";
import type { SessionObservationsClient } from "./session-observations-client";
import "./observed-session.css";

export const observationHref = (projectId: string, id: string | null) =>
  desktopHref({
    projectId,
    destination: "sessions",
    selection: id ? { kind: "session", id } : null,
  });

function Activity({ item }: { item: SessionObservedActivity }) {
  switch (item.kind) {
    case "session.started":
      return <p>Session start recorded</p>;
    case "session.ended":
      return (
        <p>
          Session end recorded · {item.reason ?? "Reason not reported"}
          {item.durationMs !== null && ` · ${item.durationMs} ms`}
        </p>
      );
    case "prompt.submitted":
      return (
        <p>Prompt submitted · {item.length} characters · Text not captured</p>
      );
    case "tool.called":
      return (
        <p>
          <strong>{item.tool}</strong>
          {item.durationMs !== null && ` · ${item.durationMs} ms`} ·{" "}
          {item.exitCode === null
            ? "Exit code not reported"
            : `Reported exit code ${item.exitCode}`}
          <small>Input, command and file paths are not captured.</small>
        </p>
      );
  }
}

/** Recorded metadata is inert: this view has no composer or process-control dependency. */
export function ObservedSessionDetail({
  projectId,
  sessionId,
  client,
  row,
}: {
  projectId: string;
  sessionId: string;
  client: SessionObservationsClient;
  row: SessionObservationRow | undefined;
}) {
  const view = client.detail(projectId, sessionId),
    data = view.data,
    summary = data?.observation;
  const [tab, setTab] = useState<"details" | "activity">("details");
  const activityAvailable =
    !view.loading &&
    !view.error &&
    !!view.workspace &&
    view.projectId === projectId &&
    view.sessionId === sessionId &&
    data?.projectId === projectId &&
    data.sessionId === sessionId &&
    data.workspace === view.workspace;
  const showActivity = tab === "activity" && activityAvailable;
  const external = row?.ownership === "external";
  const name = external
    ? "Observed session details"
    : "Session metadata details";
  return (
    <section class="af-observed-session" aria-label={name}>
      <div class="af-observed-toolbar">
        <Button href={observationHref(projectId, null)}>All sessions</Button>
        <Button
          aria-disabled={view.loading || view.capped}
          onClick={() => {
            if (!view.loading && !view.capped) client.refreshDetail();
          }}
        >
          Refresh session metadata
        </Button>
        {view.loading && <span role="status">Reading session metadata…</span>}
      </div>
      <header>
        <p class="af-observed-eyebrow">
          {row?.ownership === "owned"
            ? "App-owned history"
            : external
              ? "Observed · Read-only"
              : "Ownership unavailable"}
        </p>
        <h1>
          {row?.owner?.origin?.kind === "shift"
            ? "Shift session metadata"
            : row?.owner?.origin?.kind === "codex-chat-fork"
              ? "Fork child metadata"
              : "Session metadata"}
        </h1>
        <p class="af-observed-address">{sessionId}</p>
        <p>
          {row?.reason ??
            "Checking this session's project membership and ownership."}
        </p>
      </header>
      <ObjectActivityTabs
        label="Session views"
        detailLabel="Details"
        selected={showActivity ? "activity" : "details"}
        activityAvailable={activityAvailable}
        onSelect={setTab}
      />
      <div
        role="tabpanel"
        aria-label="Session metadata details"
        hidden={showActivity}
      >
        {view.error && (
          <p role="alert" class="af-notice">
            {view.error}
            {data && " Previously read metadata is kept."}
          </p>
        )}
        {!data ? (
          <EmptyState
            title={
              view.loaded
                ? "Session metadata unavailable"
                : "Loading session metadata…"
            }
            hint={
              view.loaded
                ? "Refresh to check its membership in this project. No private conversation was read."
                : "Reading this project's protected observations."
            }
          />
        ) : (
          <>
            <dl class="af-observed-facts">
              <div>
                <dt>Provider / requested model</dt>
                <dd>
                  {row?.provider ??
                    summary?.executor?.provider ??
                    "Provider not reported"}{" "}
                  ·{" "}
                  {row?.owner?.record.requestedModel ??
                    summary?.executor?.model ??
                    "Model not reported"}
                </dd>
              </div>
              <div>
                <dt>Kind / bead</dt>
                <dd>
                  {row?.owner?.origin?.kind === "shift"
                    ? "Shift"
                    : row?.owner?.origin?.kind === "codex-chat-fork"
                      ? "Fork child"
                      : (summary?.kind ?? "Kind not reported")}{" "}
                  ·{" "}
                  {row?.owner?.record.beadId ??
                    summary?.beadId ??
                    "Bead not reported"}
                </dd>
              </div>
              <div>
                <dt>Saved observation</dt>
                <dd>
                  {summary?.endedAt ? "End recorded" : "Running state unknown"}{" "}
                  ·{" "}
                  {summary ? (
                    <time dateTime={summary.lastEventAt}>
                      {new Date(summary.lastEventAt).toLocaleString()}
                    </time>
                  ) : (
                    "No ledger observation"
                  )}
                </dd>
              </div>
              <div>
                <dt>Provider conversation identity</dt>
                <dd>Not verified by this metadata source</dd>
              </div>
              <div>
                <dt>Where</dt>
                <dd>
                  {summary?.worktree ??
                    row?.owner?.record.worktree ??
                    "Worktree not reported"}
                </dd>
              </div>
              {data.parent && (
                <div>
                  <dt>Recorded parent</dt>
                  <dd>
                    {data.parent.available ? (
                      <a href={observationHref(projectId, data.parent.id)}>
                        Open parent {data.parent.id}
                      </a>
                    ) : (
                      <>
                        {data.parent.id}
                        <small>
                          Parent unavailable in this project. The child remains
                          visible.
                        </small>
                      </>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <div class="af-observed-boundary">
              <h2>
                {row?.ownership === "owned"
                  ? "Saved metadata only"
                  : "The conversation is not captured here"}
              </h2>
              <p>
                {row?.ownership === "owned"
                  ? "This view does not provide the private conversation or session controls. Shift conversations require their dedicated view."
                  : "Only activity metadata is available. Messages, reasoning, tool input and file contents are not captured."}
              </p>
              <p>
                Stopping, continuing, forking and permission decisions are
                unavailable in this view.
              </p>
            </div>
            {data.problems.map((problem) => (
              <p key={problem} role="status">
                {problem}
              </p>
            ))}
            <section aria-label="Recorded activity metadata">
              <h2>Recorded activity</h2>
              {view.activity.length ? (
                <ol class="af-observed-activity">
                  {view.activity.map((item) => (
                    <li key={item.id}>
                      <time dateTime={item.at}>
                        {new Date(item.at).toLocaleTimeString()}
                      </time>
                      <Activity item={item} />
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No supported activity metadata was recorded.</p>
              )}
              {view.more && (
                <Button
                  aria-disabled={view.loading || view.capped}
                  onClick={() => {
                    if (!view.loading && !view.capped) client.refreshDetail();
                  }}
                >
                  Load more recorded activity
                </Button>
              )}
              <p class="af-overview-muted">
                {view.more
                  ? "More saved metadata remains."
                  : "All available metadata through this read is shown."}{" "}
                Conversation content is not included.
              </p>
            </section>
          </>
        )}
      </div>
      {showActivity && view.workspace && (
        <div role="tabpanel" aria-label="Session Activity">
          <ScopedProjectActivity
            key={JSON.stringify([view.workspace, projectId, sessionId])}
            projectId={projectId}
            workspace={view.workspace}
            scope={{ sessionId }}
          />
        </div>
      )}
    </section>
  );
}
