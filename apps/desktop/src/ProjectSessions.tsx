import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import type { SessionSummary } from "../../../types/hearth";
import { ProviderMonogram } from "./DesktopFrame";
import { KeeperSessionControl } from "./KeeperSessionControl";
import type { KeeperClient } from "./keeper-client";
import { desktopHref } from "./navigation";
import type { SessionObservationRow } from "./session-observations";
import type { SessionObservationsClient } from "./session-observations-client";
import type { SessionFilters } from "./sessions-model";

const GROUPS = [
  { id: "unverified", label: "Status unavailable" },
  { id: "observed", label: "Observed" },
  { id: "ended-today", label: "Ended today" },
  { id: "older", label: "Older" },
] as const;

export function ProjectSessions({
  projectId,
  selectedId,
  keeper,
  writesAllowed,
  client,
  representedIds,
}: {
  projectId: string;
  selectedId: string | null;
  keeper: KeeperClient;
  writesAllowed: boolean;
  client: SessionObservationsClient;
  representedIds: readonly string[];
}): JSX.Element {
  const read = client.project(projectId);
  const allRows = client
    .rows(projectId)
    .filter((row) => !representedIds.includes(row.id));
  const [filters, setFilters] = useState<SessionFilters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(allRows.map((row) => row.id));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [read.data, representedIds.join("|")]);
  const data = read.data;
  const reload = () => {
    if (!read.loading) client.refreshIndex();
  };
  const controls = (
    <KeeperSessionControl
      projectId={projectId}
      client={keeper}
      writesAllowed={writesAllowed}
      observedSelected={selected.size}
    />
  );
  if (!data)
    return (
      <div class="af-project-sessions">
        {controls}
        <EmptyState
          title={read.error ? "Sessions unavailable" : "Loading sessions…"}
          hint={read.error || "Reading this project's observations."}
        >
          <Button aria-disabled={read.loading} onClick={reload}>
            Refresh sessions
          </Button>
        </EmptyState>
      </div>
    );
  const sessions = allRows
    .map((row) => row.observation)
    .filter((session) => session !== null);
  const query = filters.search?.trim().toLocaleLowerCase() ?? "";
  const rows = allRows.filter(
    (row) =>
      (!filters.provider || row.provider === filters.provider) &&
      (!filters.kind || row.observation?.kind === filters.kind) &&
      (!filters.bead ||
        (row.owner?.record.beadId ?? row.observation?.beadId) ===
          filters.bead) &&
      (!filters.smith ||
        (row.owner?.record.smith ?? row.observation?.executor?.smith) ===
          filters.smith) &&
      (!filters.group || row.status === filters.group) &&
      (!query ||
        [
          row.id,
          row.title,
          row.provider,
          row.owner?.record.requestedModel,
          row.observation?.executor?.model,
          row.observation?.worktree,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
  );
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
            {GROUPS.map((group) => (
              <option value={group.id} key={group.id}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <Button aria-disabled={read.loading} onClick={reload}>
          Refresh sessions
        </Button>
      </div>
      {read.error && (
        <p role="status">
          Refresh failed: {read.error}. Showing last-known sessions.
        </p>
      )}
      <p class="af-overview-muted">
        Ledger observations as of {new Date(data.asOf).toLocaleString()}
        {data.observationsComplete ? "" : " · partial or unavailable"}. Running,
        idle, permission and per-session usage are not reported by this source.
      </p>
      {controls}
      {!allRows.length ? (
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
      {!data.ownership.available && (
        <p role="status">
          Ownership unavailable: {data.ownership.reason} Previously verified
          ownership is kept.
        </p>
      )}
      {data.problems.map((problem) => (
        <p key={problem} role="status">
          {problem}
        </p>
      ))}
      {GROUPS.map((group) => {
        const grouped = rows.filter((row) => row.status === group.id);
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
                  {grouped.map((row) => {
                    const session = row.observation,
                      record = row.owner?.record;
                    return (
                      <tr key={row.id} aria-selected={selectedId === row.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.id}`}
                            checked={selected.has(row.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.currentTarget.checked) next.add(row.id);
                              else next.delete(row.id);
                              setSelected(next);
                            }}
                          />
                        </td>
                        <td
                          style={{
                            paddingInlineStart: `${8 + row.depth * 12}px`,
                          }}
                        >
                          <ProviderMonogram provider={row.provider} />
                          <a href={href(row.id)}>{row.id}</a>
                          {session?.parentSessionId && (
                            <small>Parent: {session.parentSessionId}</small>
                          )}
                          <small>
                            {row.ownership === "owned"
                              ? row.title
                              : "Title not reported"}
                          </small>
                        </td>
                        <td>
                          {record?.requestedModel ??
                            session?.executor?.model ??
                            "Model —"}
                          <small>
                            Effort:{" "}
                            {record?.requestedEffort ??
                              session?.executor?.effort ??
                              "—"}{" "}
                            · Smith:{" "}
                            {record?.smith ?? session?.executor?.smith ?? "—"}
                          </small>
                        </td>
                        <td>
                          {row.owner?.origin?.kind === "shift"
                            ? "Shift"
                            : row.owner?.origin?.kind === "codex-chat-fork"
                              ? "Fork child"
                              : (session?.kind ?? "Kind —")}
                          <small>
                            {record?.beadId ?? session?.beadId ?? "Bead —"}
                          </small>
                        </td>
                        <td>
                          {record?.worktree ??
                            session?.worktree ??
                            "Worktree —"}
                          <small>Branch — not reported</small>
                        </td>
                        <td>
                          {row.ownership === "owned"
                            ? "App-owned · Status unavailable"
                            : row.ownership === "unavailable"
                              ? "Ownership unavailable"
                              : session?.endedAt
                                ? "Ended"
                                : "Observed"}
                          <small>{row.reason}</small>
                          <small>
                            <time
                              dateTime={
                                session?.lastEventAt ?? record?.createdAt
                              }
                            >
                              {new Date(
                                session?.lastEventAt ??
                                  record?.createdAt ??
                                  data.asOf,
                              ).toLocaleString()}
                            </time>
                          </small>
                        </td>
                        <td>
                          <Button href={href(row.id)}>Open {row.id}</Button>
                        </td>
                      </tr>
                    );
                  })}
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
  row,
}: {
  projectId: string;
  session: SessionSummary | undefined;
  onAskKeeper?: () => void;
  row?: SessionObservationRow | undefined;
}): JSX.Element {
  if (!session && row?.owner)
    return (
      <section aria-label="Selected session">
        <h3>{row.id}</h3>
        <p>App-owned history</p>
        <p>
          {row.provider} · {row.owner.record.requestedModel}
        </p>
        <p>{row.reason}</p>
        <p>
          No ledger observation is available. Current status is not reported by
          this source.
        </p>
        <Button
          href={desktopHref({
            projectId,
            destination: "sessions",
            selection: { kind: "session", id: row.id },
          })}
        >
          Open session
        </Button>
      </section>
    );
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
      <p>
        {row?.ownership === "owned"
          ? "App-owned; status unavailable until opened"
          : row?.ownership === "unavailable"
            ? "Ownership unavailable"
            : session.endedAt
              ? "Ended"
              : "Observed; running state unknown"}
      </p>
      {row && <p>{row.reason}</p>}
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
