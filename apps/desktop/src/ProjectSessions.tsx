import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { useOperatorRead } from "../../../docs/js/use-stream";
import type { SessionSummary } from "../../../types/hearth";
import type { ProjectOverview } from "../../../types/project-overview";
import { ProviderMonogram } from "./DesktopFrame";
import { desktopHref } from "./navigation";
import { PROJECT_READ_KINDS } from "./ProjectOverview";
import {
  SESSION_GROUPS,
  type SessionFilters,
  sessionRows,
} from "./sessions-model";

export function ProjectSessions({
  projectId,
  selectedId,
}: {
  projectId: string;
  selectedId: string | null;
}): JSX.Element {
  const read = useOperatorRead<ProjectOverview>(
    `/projects/${encodeURIComponent(projectId)}/overview`,
    PROJECT_READ_KINDS,
    true,
  );
  const [filters, setFilters] = useState<SessionFilters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(
      read.data?.summary.sessions.map((session) => session.sessionId),
    );
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [read.data?.summary.sessions]);
  const data = read.data?.summary.projectId === projectId ? read.data : null;
  if (!data)
    return (
      <EmptyState
        title={read.error ? "Sessions unavailable" : "Loading sessions…"}
        hint={read.error ?? "Reading this project's observations."}
      >
        <Button onClick={read.reload}>Refresh sessions</Button>
      </EmptyState>
    );
  const sessions = data.summary.sessions;
  const rows = sessionRows(sessions, filters, data.summary.asOf);
  const options = (key: "provider" | "kind" | "bead" | "smith") =>
    [
      ...new Set(
        sessions
          .map((session) =>
            key === "provider"
              ? session.executor?.provider
              : key === "kind"
                ? session.kind
                : key === "bead"
                  ? session.beadId
                  : session.executor?.smith,
          )
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort();
  const href = (id: string) =>
    desktopHref({
      projectId,
      destination: "sessions",
      selection: { kind: "session", id },
    });
  return (
    <div class="af-project-sessions">
      <div class="af-projects-toolbar">
        <label>
          Find sessions
          <input
            type="search"
            value={filters.search ?? ""}
            onInput={(event) =>
              setFilters({ ...filters, search: event.currentTarget.value })
            }
          />
        </label>
        {(["provider", "kind", "bead", "smith"] as const).map((key) => (
          <label key={key}>
            {key}
            <select
              aria-label={`Session ${key}`}
              value={filters[key] ?? ""}
              onChange={(event) =>
                setFilters({ ...filters, [key]: event.currentTarget.value })
              }
            >
              <option value="">All {key}s</option>
              {options(key).map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          Status
          <select
            aria-label="Session status"
            value={filters.group ?? ""}
            onChange={(event) =>
              setFilters({ ...filters, group: event.currentTarget.value })
            }
          >
            <option value="">All reported states</option>
            {SESSION_GROUPS.map((group) => (
              <option value={group.id} key={group.id}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={read.reload}>Refresh sessions</Button>
      </div>
      {read.error && (
        <p role="status">
          Refresh failed: {read.error}. Showing last-known sessions.
        </p>
      )}
      <p class="af-overview-muted">
        Ledger observations as of {new Date(data.summary.asOf).toLocaleString()}
        {data.summary.sessionsComplete ? "" : " · partial or unavailable"}.
        Running, idle, permission and per-session usage are not reported by this
        source.
      </p>
      <p>
        <Button disabled title="Session control is not available in this build">
          Stop selected
        </Button>{" "}
        {selected.size} selected. Observed sessions are read-only.
      </p>
      {!sessions.length ? (
        <EmptyState
          title="No scoped sessions observed"
          hint="Only sessions explicitly bound to this project's beads appear here."
        />
      ) : !rows.length ? (
        <EmptyState
          title="No matching sessions"
          hint="Change the filters or search."
        />
      ) : null}
      {SESSION_GROUPS.map((group) => {
        const grouped = rows.filter((row) => row.group === group.id);
        return grouped.length ? (
          <section key={group.id} aria-label={group.label}>
            <h2>
              {group.label} · {grouped.length}
            </h2>
            <div class="af-session-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Provider / session</th>
                    <th>Model / effort / smith</th>
                    <th>Kind / bead</th>
                    <th>Where</th>
                    <th>State / last activity</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(({ session, depth }) => (
                    <tr
                      key={session.sessionId}
                      aria-selected={selectedId === session.sessionId}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${session.sessionId}`}
                          checked={selected.has(session.sessionId)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.currentTarget.checked)
                              next.add(session.sessionId);
                            else next.delete(session.sessionId);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td style={{ paddingInlineStart: `${8 + depth * 12}px` }}>
                        <ProviderMonogram
                          provider={
                            session.executor?.provider ??
                            "Provider not reported"
                          }
                        />
                        <a href={href(session.sessionId)}>
                          {session.sessionId}
                        </a>
                        {session.parentSessionId && (
                          <small>Parent: {session.parentSessionId}</small>
                        )}
                        <small>Title not reported</small>
                      </td>
                      <td>
                        {session.executor?.model ?? "Model —"}
                        <small>
                          Effort: {session.executor?.effort ?? "—"} · Smith:{" "}
                          {session.executor?.smith ?? "—"}
                        </small>
                      </td>
                      <td>
                        {session.kind ?? "Kind —"}
                        <small>{session.beadId ?? "Bead —"}</small>
                      </td>
                      <td>
                        {session.worktree ?? "Worktree —"}
                        <small>Branch — not reported</small>
                      </td>
                      <td>
                        {session.endedAt ? "Ended" : "Observed"}
                        <small>
                          <time dateTime={session.lastEventAt}>
                            {new Date(session.lastEventAt).toLocaleString()}
                          </time>
                        </small>
                      </td>
                      <td>
                        <Button href={href(session.sessionId)}>
                          Open {session.sessionId}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null;
      })}
    </div>
  );
}

export function SessionInspector({
  projectId,
  session,
  onAskKeeper,
}: {
  projectId: string;
  session: SessionSummary | undefined;
  onAskKeeper?: () => void;
}): JSX.Element {
  if (!session)
    return (
      <EmptyState
        title="Session unavailable in this project"
        hint="Choose a scoped session to inspect its metadata."
      />
    );
  return (
    <section aria-label="Selected session">
      <h3>{session.sessionId}</h3>
      <p>
        {session.executor?.provider ?? "Provider —"} ·{" "}
        {session.executor?.model ?? "Model —"}
      </p>
      <p>{session.beadId ?? "Bead —"}</p>
      <p>{session.endedAt ? "Ended" : "Observed; running state unknown"}</p>
      <p>{session.worktree ?? "Worktree —"}</p>
      <p>Last event: {new Date(session.lastEventAt).toLocaleString()}</p>
      <Button
        href={desktopHref({
          projectId,
          destination: "sessions",
          selection: { kind: "session", id: session.sessionId },
        })}
      >
        Open session
      </Button>
      {onAskKeeper && (
        <Button onClick={onAskKeeper} aria-haspopup="dialog">
          Ask Keeper about this session
        </Button>
      )}
    </section>
  );
}
