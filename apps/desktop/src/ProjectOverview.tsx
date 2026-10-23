import type { JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { useOperatorRead } from "../../../docs/js/use-stream";
import type { LedgerEventKind } from "../../../types/hearth";
import type { ProjectOverview as Overview } from "../../../types/project-overview";
import { desktopHref } from "./navigation";
import { openProject } from "./projects-model";
import "./overview.css";
import { KeeperBriefPanel } from "./KeeperBrief";
import type { KeeperClient } from "./keeper-client";

export const PROJECT_READ_KINDS: readonly LedgerEventKind[] = [
  "operator.action",
  "bead.transitioned",
  "session.started",
  "session.ended",
  "tool.called",
  "prompt.submitted",
  "reservation.acquired",
  "reservation.released",
  "run.phase.entered",
  "run.phase.completed",
  "shift.started",
  "shift.stopped",
  "review.recorded",
  "gate.ran",
];

/** Keyed by project id by the caller, so a previous scope never paints this view. */
export function ProjectOverview({
  projectId,
  keeper,
}: {
  projectId: string;
  keeper?: KeeperClient;
}): JSX.Element {
  const state = useOperatorRead<Overview>(
    `/projects/${encodeURIComponent(projectId)}/overview`,
    PROJECT_READ_KINDS,
    true,
  );
  const data = state.data?.summary.projectId === projectId ? state.data : null;
  return (
    <ProjectOverviewView
      projectId={projectId}
      data={data}
      error={state.error}
      reload={state.reload}
      keeper={keeper}
    />
  );
}

export function ProjectOverviewView({
  projectId,
  data,
  error,
  reload,
  keeper,
}: {
  projectId: string;
  data: Overview | null;
  error: string | null;
  reload(): void;
  keeper?: KeeperClient | undefined;
}): JSX.Element {
  if (!data)
    return (
      <EmptyState
        title={
          error ? "Project overview unavailable" : "Loading project overview…"
        }
        hint={error ?? "Reading this project's scoped sources."}
      >
        <Button onClick={reload}>Refresh overview</Button>
      </EmptyState>
    );
  const link = (
    destination: "beads" | "sessions" | "workbench" | "runs",
    kind: "bead" | "session" | "run",
    id: string,
  ) => desktopHref({ projectId, destination, selection: { kind, id } });
  const queue = data.summary.queue;
  const days = data.throughput.data;
  return (
    <div class="af-project-overview">
      <div class="af-overview-toolbar">
        <p>
          Hearth sources ·{" "}
          <time dateTime={data.summary.asOf}>
            {new Date(data.summary.asOf).toLocaleString()}
          </time>
        </p>
        <Button onClick={reload}>Refresh overview</Button>
      </div>
      {error && (
        <p role="status">
          Refresh failed: {error}. Showing last-known overview.
        </p>
      )}
      {data.summary.problems.map((problem) => (
        <p key={problem} class="af-overview-problem">
          {problem}
        </p>
      ))}
      {keeper ? (
        <KeeperBriefPanel projectId={projectId} client={keeper} />
      ) : (
        <section
          class="af-overview-panel af-overview-brief"
          aria-label="Keeper brief"
        >
          <h2>Keeper brief</h2>
          <p>No project brief is available yet.</p>
          <Button href={openProject(projectId, "keeper")}>
            Ask the Keeper
          </Button>
          <Button disabled title="Keeper briefs are not available yet">
            Refresh brief
          </Button>
        </section>
      )}
      <section class="af-overview-counts" aria-label="Scoped bead counts">
        {(
          [
            ["Open", data.summary.beads?.open],
            ["In progress", data.summary.beads?.inProgress],
            ["Blocked", data.summary.beads?.blocked],
            ["Closed", data.summary.beads?.closed],
          ] as const
        ).map(([label, count]) => (
          <a key={label} href={openProject(projectId, "beads")}>
            <strong>{count ?? "—"}</strong>
            <span>{label}</span>
          </a>
        ))}
      </section>
      <section class="af-overview-panel" aria-label="Needs you">
        <h2>
          Needs you ·{" "}
          {data.summary.complete ? data.summary.needsYou.length : "partial"}
        </h2>
        {data.summary.needsYou.length ? (
          <ul>
            {data.summary.needsYou.slice(0, 3).map((item) => (
              <li key={`${item.beadId}-${item.state}`}>
                <a href={link("workbench", "bead", item.beadId)}>
                  {item.beadId} · {item.title}
                </a>{" "}
                · {item.state}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No recorded queue approvals, reviews or halted beads in this read.
          </p>
        )}
        {data.summary.needsYou.length > 3 && (
          <Button href={openProject(projectId, "workbench")}>
            See all {data.summary.needsYou.length} queue items
          </Button>
        )}
        <p class="af-overview-muted">
          Permission requests and run checkpoints are not yet included.
        </p>
      </section>
      <section class="af-overview-panel" aria-label="Session observations">
        <h2>Sessions</h2>
        <p>
          {data.summary.sessions.length} observations
          {data.summary.sessionsComplete ? "" : " · partial or unavailable"}.
          Running and idle state are not reported.
        </p>
        <ul>
          {data.summary.sessions.slice(0, 6).map((session) => (
            <li key={session.sessionId}>
              <a href={link("sessions", "session", session.sessionId)}>
                {session.executor?.provider ?? "Unknown provider"} ·{" "}
                {session.beadId ?? session.sessionId}
              </a>{" "}
              · {session.executor?.model ?? "Model not reported"} ·{" "}
              {session.endedAt ? "Ended" : "Observed"}
            </li>
          ))}
        </ul>
        <Button href={openProject(projectId, "sessions")}>All sessions</Button>
      </section>
      <section class="af-overview-panel" aria-label="Workbench snapshot">
        <h2>Workbench</h2>
        <div class="af-overview-queue">
          {(
            [
              "proposed",
              "approved",
              "queued",
              "running",
              "review",
              "halted",
            ] as const
          ).map((state) => (
            <span key={state}>
              {state} <strong>{queue?.[state] ?? "—"}</strong>
            </span>
          ))}
        </div>
        <p>
          File claims observed: {data.reservations.data?.length ?? "—"}
          {data.reservations.complete ? "" : " · partial or unavailable"}
        </p>
        {data.shifts.data?.map((shift) => (
          <p key={shift.shiftId}>
            {shift.shiftId} · {shift.state} · process{" "}
            {shift.alive ? "present" : "not present"} · {shift.beads.length}/
            {shift.options.maxBeads} beads · reported $
            {shift.spentUsd.toFixed(2)}
            {shift.unpriced ? ` · ${shift.unpriced} unpriced` : ""}
          </p>
        ))}
        <p class="af-overview-muted">{data.shifts.reason}</p>
        <Button href={openProject(projectId, "workbench")}>
          Open Workbench
        </Button>
      </section>
      <section class="af-overview-panel" aria-label="Forge run observations">
        <h2>Forge runs</h2>
        {data.summary.runs
          .filter((run) => !run.complete)
          .map((run) => (
            <p key={run.slug}>
              <a href={link("runs", "run", run.slug)}>{run.slug}</a> ·{" "}
              {run.phase} · {run.completed.length}/4 phases complete
              {run.halted ? ` · Halted: ${run.halted.reason}` : ""}
            </p>
          ))}
        <p class="af-overview-muted">
          Observations from this checkout only; other worktrees are not
          reported.
        </p>
      </section>
      <section class="af-overview-panel" aria-label="Epics">
        <h2>Epics</h2>
        {data.epics.length ? (
          data.epics.map((epic) => (
            <div key={epic.id}>
              <a href={link("beads", "bead", epic.id)}>{epic.title}</a>
              <p>
                {epic.closed}/{epic.total} scoped beads closed
              </p>
              <progress
                value={epic.closed}
                max={Math.max(1, epic.total)}
                aria-label={`${epic.title} completion`}
              />
            </div>
          ))
        ) : (
          <p>Epic progress unavailable in this read.</p>
        )}
      </section>
      <section class="af-overview-panel" aria-label="Recorded throughput">
        <h2>Recorded throughput</h2>
        <p>{data.throughput.source}</p>
        {days ? (
          <>
            <p>
              {days[0]?.date} – {days.at(-1)?.date} ·{" "}
              {days.reduce((total, day) => total + day.count, 0)} recorded
              closures
            </p>
            <div
              class="af-throughput-chart"
              role="img"
              aria-label={days
                .map((day) => `${day.date}: ${day.count} closures`)
                .join("; ")}
            >
              {days.map((day) => (
                <span
                  key={day.date}
                  title={`${day.date}: ${day.count} recorded closures`}
                  style={{
                    height: `${Math.max(2, Math.min(90, day.count * 10))}px`,
                  }}
                />
              ))}
            </div>
            <p class="af-overview-muted">
              UTC days · bar heights capped at 9; exact counts in accessible
              chart text.
            </p>
          </>
        ) : (
          <p>History unavailable.</p>
        )}
        <p class="af-overview-muted">{data.throughput.reason}</p>
      </section>
      <section class="af-overview-panel" aria-label="Reported project usage">
        <h2>Reported project usage</h2>
        <p>{data.usage.source}</p>
        {data.usage.data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Input tokens</th>
                <th>Output tokens</th>
                <th>Reported USD</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.data.map((row) => (
                <tr key={row.provider}>
                  <th>{row.provider}</th>
                  <td>{row.usage.inputTokens?.toLocaleString() ?? "—"}</td>
                  <td>{row.usage.outputTokens?.toLocaleString() ?? "—"}</td>
                  <td>{row.usage.costUsd?.toFixed(2) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>Usage — no project usage reported in this read.</p>
        )}
        <p class="af-overview-muted">{data.usage.reason}</p>
        <Button
          href={desktopHref({
            projectId,
            destination: "providers",
            selection: null,
          })}
        >
          Providers &amp; usage
        </Button>
      </section>
    </div>
  );
}
