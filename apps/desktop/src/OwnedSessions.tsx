import { Button } from "../../../docs/js/ds/Button";
import { desktopHref } from "./navigation";
import type { SessionsClient } from "./session-client";

export function OwnedSessions({
  projectId,
  client,
  onNew,
}: {
  projectId: string;
  client: SessionsClient;
  onNew(): void;
}) {
  const view = client.project(projectId);
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
      {!view.loaded ? (
        <p role="status">Loading registered sessions…</p>
      ) : !view.records.length ? (
        <p>
          No sessions have been registered in this project. Start one
          explicitly.
        </p>
      ) : (
        <ul>
          {view.records.map((record) => (
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
              · {record.smith} ·{" "}
              <time dateTime={record.createdAt}>
                {new Date(record.createdAt).toLocaleString()}
              </time>
              <small> · Status unavailable until opened</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
