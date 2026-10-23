import { Button } from "../../../docs/js/ds/Button";
import { desktopHref } from "./navigation";
import type { SessionsClient } from "./session-client";
import type { SessionLibraryClient } from "./session-library-client";

export function OwnedSessions({
  projectId,
  client,
  onNew,
  library,
}: {
  projectId: string;
  client: SessionsClient;
  onNew(): void;
  library?: SessionLibraryClient;
}) {
  const view = client.project(projectId);
  const preferences = library?.project(projectId);
  const records = view.records.filter(
    (record) =>
      preferences?.showArchived ||
      !preferences?.loaded ||
      !!preferences.error ||
      !preferences.entries.find((entry) => entry.sessionId === record.id)
        ?.archived,
  );
  return (
    <section
      class="af-owned-session-list"
      aria-label="Sessions started in the app"
    >
      <h2>Sessions started here</h2>
      <p>
        Private conversations registered in this project. Current status appears
        when you open a session; other observations are listed below.
      </p>
      <Button onClick={onNew}>Start a new session</Button>
      <Button
        disabled={view.loading}
        onClick={() => {
          void client.refresh(projectId);
        }}
      >
        Refresh app sessions
      </Button>
      {view.error && <p role="status">{view.error}</p>}
      {view.notice && <p role="status">{view.notice}</p>}
      {library && (
        <label class="af-session-archive-filter">
          <input
            type="checkbox"
            checked={preferences?.showArchived ?? false}
            onChange={(event) =>
              library.showArchived(event.currentTarget.checked)
            }
          />{" "}
          Show archived app sessions
        </label>
      )}
      {preferences?.error && <p role="status">{preferences.error}</p>}
      {!view.loaded ? (
        <p role="status">Loading registered sessions…</p>
      ) : !view.records.length ? (
        <p>
          No sessions have been registered in this project. Start one
          explicitly.
        </p>
      ) : !records.length ? (
        <p>
          All registered sessions are archived. Show archived app sessions to
          open and restore one.
        </p>
      ) : (
        <ul>
          {records.map((record) => (
            <li key={record.id}>
              <a
                href={desktopHref({
                  projectId,
                  destination: "sessions",
                  selection: { kind: "session", id: record.id },
                })}
              >
                {record.mode === "chat" ? "Chat" : "Task"} ·{" "}
                {record.beadId ?? record.requestedModel}
              </a>{" "}
              · {record.provider === "codex" ? "Codex" : "Claude"} ·{" "}
              {record.smith} ·{" "}
              <time dateTime={record.createdAt}>
                {new Date(record.createdAt).toLocaleString()}
              </time>
              <small> · Status unavailable until opened</small>
              {preferences?.entries.find(
                (entry) => entry.sessionId === record.id,
              )?.archived && <small> · Archived</small>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
