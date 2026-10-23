import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { serializeClaudeLaunch } from "../../../scripts/sessions/claude-launch";
import { KeeperMarkdown } from "./KeeperMarkdown";
import { keeperTurns } from "./keeper-model";
import { desktopHref } from "./navigation";
import type { SessionsClient } from "./session-client";
import "./session.css";

export function SessionConversation({
  projectId,
  sessionId,
  client,
  writesAllowed,
}: {
  projectId: string;
  sessionId: string;
  client: SessionsClient;
  writesAllowed: boolean;
}) {
  const view = client.session(projectId, sessionId),
    record = client
      .project(projectId)
      .records.find((item) => item.id === sessionId),
    rows = keeperTurns(view.page),
    current = view.page?.turns.at(-1);
  const running =
    current && ["accepted", "running", "cancelling"].includes(current.phase);
  const observed = [...(view.page?.frames ?? [])]
    .reverse()
    .find((frame) => frame.event.kind === "model")?.event;
  const first = view.page?.frames.find(
    (frame) => frame.event.kind === "user" && frame.event.session,
  )?.event;
  const snapshot = first?.kind === "user" ? first.session : undefined;
  const feed = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const [away, setAway] = useState(false),
    [notice, setNotice] = useState("");
  const lastSequence = view.page?.nextCursor ?? 0;
  useEffect(() => {
    if (following.current && feed.current)
      feed.current.scrollTop = feed.current.scrollHeight;
    else if (lastSequence) setAway(true);
  }, [lastSequence]);
  return (
    <section class="af-owned-session" aria-label="Session conversation">
      <header class="af-owned-session-header">
        <div>
          <span class="af-keeper-chip">Cl · Claude</span>
          <h2>
            {record?.mode === "task" ? "Task" : "Chat"} ·{" "}
            {record?.beadId ?? "Project session"}
          </h2>
        </div>
        <p>
          Requested {record?.requestedModel ?? "model unavailable"} ·{" "}
          {record?.requestedEffort ?? "CLI default effort"} ·{" "}
          {record?.smith ?? "smith unavailable"}
          {observed?.kind === "model" &&
          observed.model !== record?.requestedModel
            ? ` · Observed ${observed.model}`
            : ""}
        </p>
        <p class="af-session-note">
          {record?.worktree ?? "Working directory not reported"}
        </p>
        <div class="af-session-composer-row">
          <span role="status">
            {view.stopping
              ? "Stopping… waiting for confirmation"
              : current
                ? current.phase === "completed"
                  ? record?.mode === "chat"
                    ? "Idle · ready for the next turn"
                    : "Task ended"
                  : current.phase === "cancelled"
                    ? "Stopped"
                    : current.phase === "unknown"
                      ? "Outcome unknown"
                      : current.phase
                : "No admitted turn reported"}
          </span>
          <Button
            href={desktopHref({
              projectId,
              destination: "sessions",
              selection: null,
            })}
          >
            All sessions
          </Button>
          {running && (
            <Button
              disabled={
                !writesAllowed ||
                !view.page?.controllable ||
                !!view.stopping ||
                current.phase === "cancelling"
              }
              onClick={() => {
                void client.stop(projectId, sessionId);
              }}
            >
              Stop session
            </Button>
          )}
        </div>
        <details>
          <summary>Session details</summary>
          <dl>
            <dt>Local session</dt>
            <dd>{sessionId}</dd>
            <dt>Provider session id</dt>
            <dd>{view.page?.binding?.sessionId ?? "Not reported yet"}</dd>
            <dt>CLI version</dt>
            <dd>{view.page?.binding?.version ?? "Not reported yet"}</dd>
            <dt>Permissions</dt>
            <dd>{snapshot?.launch.permissionMode ?? "Not reported yet"}</dd>
          </dl>
          {snapshot && (
            <pre>
              {
                serializeClaudeLaunch(snapshot.launch, snapshot.capabilities)
                  .equivalentCommand
              }
            </pre>
          )}
          <p class="af-session-note">
            Usage, tool details and files changed are not reported by this
            transcript adapter.
          </p>
        </details>
      </header>
      {view.notice && (
        <div class="af-session-warning" role="status">
          <p>{view.notice}</p>
          {view.pending && (
            <div class="af-session-composer-row">
              <Button
                onClick={() => {
                  void client.check(projectId, sessionId);
                }}
              >
                Check original message
              </Button>
              <Button
                disabled={!writesAllowed || view.posting}
                onClick={() => {
                  void client.retryMessage(projectId, sessionId);
                }}
              >
                Retry original message
              </Button>
            </div>
          )}
          {view.stopping && (
            <Button
              onClick={() => {
                void client.check(projectId, sessionId);
              }}
            >
              Check Stop
            </Button>
          )}
          {view.stopUnknown && (
            <Button
              disabled={!writesAllowed || view.stopPosting}
              onClick={() => {
                void client.stop(projectId, sessionId, true);
              }}
            >
              Retry original Stop
            </Button>
          )}
          {!view.live && (
            <Button onClick={() => client.reload(projectId, sessionId)}>
              Reload session conversation
            </Button>
          )}
        </div>
      )}
      <div
        class="af-owned-transcript"
        ref={feed}
        role="region"
        aria-label="Session transcript"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the named transcript region supports keyboard scrolling.
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {!view.loaded && (
          <p role="status">
            {view.page
              ? "Loading earlier session messages…"
              : "Loading the saved session conversation…"}
          </p>
        )}
        {view.loaded && !rows.length && (
          <p>
            No accepted message is recorded yet. Check the original Start before
            trying another request.
          </p>
        )}
        {rows.map((row) => (
          <div class="af-owned-turn" key={row.id}>
            <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
            <article
              class="af-owned-question"
              aria-label="Your session message"
            >
              <p>{row.question}</p>
              {view.page?.frames
                .filter(
                  (frame) =>
                    frame.turnId === row.id && frame.event.kind === "user",
                )
                .map((frame) =>
                  frame.event.kind === "user" &&
                  frame.event.session?.launch.attachments?.length ? (
                    <p class="af-session-note" key={frame.seq}>
                      Attachments:{" "}
                      {frame.event.session.launch.attachments
                        .map((item) => `${item.name} (${item.kind})`)
                        .join(", ")}
                    </p>
                  ) : null,
                )}
            </article>
            {row.reply && (
              <article class="af-owned-reply" aria-label="Session reply">
                <KeeperMarkdown text={row.reply} />
                <Button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(row.reply)
                      .then(() => setNotice("Reply copied."))
                      .catch(() => setNotice("The reply could not be copied."));
                  }}
                >
                  Copy session reply
                </Button>
              </article>
            )}
            {row.turn &&
              ["failed", "unknown", "cancelled"].includes(row.turn.phase) && (
                <p role="status" class="af-session-warning">
                  {row.turn.phase === "unknown"
                    ? "Delivery unknown. This request was not resent."
                    : row.turn.phase === "cancelled"
                      ? "Stop confirmed."
                      : "The session could not finish."}{" "}
                  {row.turn.reason}
                </p>
              )}
          </div>
        ))}
      </div>
      {away && (
        <Button
          onClick={() => {
            following.current = true;
            setAway(false);
            if (feed.current)
              feed.current.scrollTop = feed.current.scrollHeight;
          }}
        >
          Jump to latest session message
        </Button>
      )}
      <footer class="af-owned-session-composer">
        <p role="status">
          {notice ||
            (running
              ? "The provider is answering…"
              : record?.mode === "task"
                ? "This Task accepts one turn. Start another session explicitly."
                : !view.page?.binding
                  ? "No confirmed provider conversation is available. Check the original Start."
                  : "Enter a follow-up for this same provider conversation.")}
        </p>
        <label>
          Reply to Claude
          <textarea
            aria-label="Session reply prompt"
            rows={3}
            maxLength={16_384}
            value={view.draft}
            disabled={record?.mode === "task"}
            onInput={(event) =>
              client.draft(projectId, sessionId, event.currentTarget.value)
            }
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.isComposing
              ) {
                event.preventDefault();
                void client.send(projectId, sessionId);
              }
            }}
          />
        </label>
        <div class="af-session-composer-actions">
          <small>
            Ctrl/Cmd+Enter sends · Enter adds a line · closing this view leaves
            its process running
          </small>
          <Button
            variant="primary"
            disabled={!client.canSend(projectId, sessionId)}
            onClick={() => {
              void client.send(projectId, sessionId);
            }}
          >
            Send session message
          </Button>
        </div>
      </footer>
    </section>
  );
}
