import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { GeminiChatOwnedRecord } from "../../../types/gemini-owned-chat";
import { GeminiChatActivity } from "./GeminiChatActivity";
import { GeminiChatApprovals } from "./GeminiChatApprovals";
import { geminiChatOutcome } from "./gemini-chat-presentation";
import { keeperTurns } from "./keeper-model";
import { desktopHref } from "./navigation";
import type { SessionConversationProps } from "./SessionConversation";
import { SessionLibraryControls } from "./SessionLibraryControls";
import { sessionAttachments } from "./session-composer";
import { ownedSessionControls } from "./session-controls";
import { useGeminiChatDecisions } from "./use-gemini-chat-decisions";

/** ACP session notifications may replay history throughout a resumed prompt. Keep that scope visible. */
export function GeminiChatConversation({
  projectId,
  sessionId,
  client,
  writesAllowed,
  library,
  archived = false,
  record,
}: SessionConversationProps & { record: GeminiChatOwnedRecord }) {
  const view = client.session(projectId, sessionId),
    current = view.page?.turns.at(-1),
    rows = keeperTurns(view.page),
    active =
      !!current &&
      ["accepted", "running", "cancelling"].includes(current.phase),
    outcome = current ? geminiChatOutcome(view.page, current.requestId) : null;
  const controls = ownedSessionControls({
    record,
    page: view.page,
    loaded: view.loaded,
    live: view.live,
    pending: !!view.pending,
    stopping: !!view.stopping || view.stopPosting || view.stopUnknown,
    feedInterrupted: view.feedInterrupted,
    readError: view.readError,
  });
  const verified =
    view.loaded && view.live && !view.readError && !view.feedInterrupted;
  const permissionActionable =
    writesAllowed &&
    !archived &&
    verified &&
    controls.permissions.available &&
    !outcome;
  const revision =
    view.page?.frames
      .filter(
        (frame) =>
          frame.turnId === current?.requestId &&
          frame.event.kind === "coding-gemini-chat" &&
          ["approval-offer", "permission-intent", "outcome"].includes(
            frame.event.event.kind,
          ),
      )
      .at(-1)?.seq ?? 0;
  const approvals = useGeminiChatDecisions({
    projectId,
    sessionId,
    turnRequestId: current?.requestId ?? null,
    enabled: true,
    actionable: permissionActionable,
    approvalRevision: revision,
  });
  const prompt = useRef<HTMLTextAreaElement>(null),
    feed = useRef<HTMLDivElement>(null),
    permissions = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const [notice, setNotice] = useState(""),
    [away, setAway] = useState(false),
    [attaching, setAttaching] = useState(false);
  useEffect(() => {
    if (following.current && feed.current)
      feed.current.scrollTop = feed.current.scrollHeight;
    else if (view.page?.nextCursor) setAway(true);
  }, [view.page?.nextCursor]);
  const canSend =
    writesAllowed &&
    !archived &&
    !attaching &&
    controls.resume.available &&
    client.canSend(projectId, sessionId);
  const send = () => {
    // Read mutable private state again; a stale render must not send after a terminal/Stop change.
    const fresh = client.session(projectId, sessionId);
    const checked = ownedSessionControls({
      record,
      page: fresh.page,
      loaded: fresh.loaded,
      live: fresh.live,
      pending: !!fresh.pending,
      stopping: !!fresh.stopping || fresh.stopPosting || fresh.stopUnknown,
      feedInterrupted: fresh.feedInterrupted,
      readError: fresh.readError,
    });
    if (writesAllowed && !archived && !attaching && checked.resume.available)
      void client.send(projectId, sessionId);
  };
  const status =
    view.stopping || current?.phase === "cancelling"
      ? "Stopping…"
      : outcome && active
        ? "Native process ended · saving final conversation status…"
        : !verified
          ? "Private conversation unavailable"
          : current?.phase === "completed"
            ? "Ready for an explicit follow-up"
            : current?.phase === "unknown"
              ? "Delivery unknown · original held"
              : current?.phase === "cancelled"
                ? "Stop confirmed"
                : current?.phase === "failed"
                  ? "Chat could not finish"
                  : permissionActionable && approvals.view()?.pending.length
                    ? "Needs native permission"
                    : active
                      ? "Gemini is answering…"
                      : "No accepted message yet";
  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setNotice("Text copied."))
      .catch(() => setNotice("The text could not be copied."));
  };
  return (
    <section
      class="af-owned-session"
      aria-label="Session conversation"
      data-session-mode="chat"
    >
      <header class="af-owned-session-header">
        <span class="af-keeper-chip">Gm · Gemini</span>
        <h2>Gemini ACP Chat · {record.beadId ?? "Project session"}</h2>
        <p>
          Requested {record.requestedModel ?? "CLI default model"} ·{" "}
          {record.smith}
        </p>
        <p class="af-session-note">
          Execution model and account allowance are not reported. Gemini has no
          native effort option.
        </p>
        <p>{record.worktree}</p>
        <div class="af-session-composer-row">
          <span role="status">{status}</span>
          <Button
            href={desktopHref({
              projectId,
              destination: "sessions",
              selection: null,
            })}
          >
            All sessions
          </Button>
          {active && !outcome && (
            <Button
              disabled={
                !writesAllowed ||
                archived ||
                !verified ||
                !controls.stop.available
              }
              onClick={() => {
                const fresh = client.session(projectId, sessionId);
                if (
                  archived ||
                  !writesAllowed ||
                  fresh.readError ||
                  fresh.feedInterrupted ||
                  geminiChatOutcome(fresh.page, current!.requestId)
                )
                  return;
                approvals.invalidate();
                void client.stop(projectId, sessionId);
              }}
            >
              Stop session
            </Button>
          )}
          {library && (
            <SessionLibraryControls
              record={record}
              session={view}
              library={library}
              writesAllowed={writesAllowed && !archived}
              onContinue={() => prompt.current?.focus()}
              onPermissions={
                permissionActionable
                  ? () =>
                      permissions.current
                        ?.querySelector<HTMLButtonElement>(
                          "button:not(:disabled)",
                        )
                        ?.focus()
                  : undefined
              }
            />
          )}
        </div>
        <details>
          <summary>Session details</summary>
          <dl>
            <dt>Local session</dt>
            <dd>{sessionId}</dd>
            <dt>Native session id</dt>
            <dd>{view.page?.binding?.sessionId ?? "Not reported yet"}</dd>
            <dt>CLI version</dt>
            <dd>{view.page?.binding?.version ?? "Not reported yet"}</dd>
            <dt>Continue Chat</dt>
            <dd>{controls.resume.reason}</dd>
          </dl>
          {controls.commandPreview && <pre>{controls.commandPreview}</pre>}
          <p>
            Saved native-session history and tool reports cannot authorize a
            permission. Only a current protected live offer supplies one-time
            choices.
          </p>
        </details>
      </header>
      {(view.notice || view.readError || notice || view.feedInterrupted) && (
        <div class="af-session-warning" role="status">
          <p>{view.notice || notice}</p>
          {view.readError && <p role="alert">{view.readError}</p>}
          {view.feedInterrupted && (
            <p>The live feed was interrupted. Reconnect before continuing.</p>
          )}
          {view.pending && (
            <>
              <Button
                onClick={() => {
                  void client.check(projectId, sessionId);
                }}
              >
                Check original message
              </Button>
              <Button
                disabled={!writesAllowed || archived || view.posting}
                onClick={() => {
                  void client.retryMessage(projectId, sessionId);
                }}
              >
                Retry original message
              </Button>
            </>
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
              disabled={!writesAllowed || archived || view.stopPosting}
              onClick={() => {
                approvals.invalidate();
                void client.stop(projectId, sessionId, true);
              }}
            >
              Retry original Stop
            </Button>
          )}
          {(!view.live || view.readError || view.feedInterrupted) && (
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
        // biome-ignore lint/a11y/noNoninteractiveTabindex: named bounded transcript supports keyboard scrolling.
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {!view.loaded && !view.readError && (
          <p role="status">Loading the saved Gemini Chat…</p>
        )}
        {view.loaded && !rows.length && (
          <p>
            No accepted message is recorded. Check the original Start before
            another request.
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
                  frame.event.geminiChat?.launch.attachments?.length ? (
                    <p class="af-session-note" key={frame.seq}>
                      Attachments:{" "}
                      {frame.event.geminiChat.launch.attachments
                        .map((item) => item.name)
                        .join(", ")}
                    </p>
                  ) : null,
                )}
            </article>
            <GeminiChatActivity
              page={view.page}
              turnId={row.id}
              streaming={
                row.id === current?.requestId && active && !outcome && view.live
              }
              onCopy={copy}
            />
            {row.turn &&
              ["failed", "unknown", "cancelled"].includes(row.turn.phase) && (
                <p role="status" class="af-session-warning">
                  {row.turn.phase === "unknown"
                    ? "Delivery unknown. This request was not resent."
                    : row.turn.phase === "cancelled"
                      ? "Stop confirmed."
                      : "The Chat could not finish."}{" "}
                  {row.turn.reason}
                </p>
              )}
          </div>
        ))}
        <div class="af-session-chat-controls" ref={permissions}>
          <GeminiChatApprovals
            client={approvals}
            actionable={permissionActionable}
          />
        </div>
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
          {active
            ? "Wait for the current native request to finish."
            : controls.resume.reason}
        </p>
        <label>
          Reply to Gemini
          <textarea
            ref={prompt}
            aria-label="Session reply prompt"
            rows={2}
            maxLength={16_384}
            value={view.draft}
            disabled={archived}
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
                send();
              }
            }}
          />
        </label>
        <label class="af-session-files">
          Attach text
          <input
            type="file"
            multiple
            accept="text/*,.md,.txt,.json,.yaml,.toml"
            disabled={attaching || !!view.pending || archived}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              setAttaching(true);
              void sessionAttachments(files)
                .then((items) => {
                  if (items.some((item) => item.kind !== "text"))
                    throw Error("Images are unavailable for Gemini Chat.");
                  client.editMessage(projectId, sessionId, {
                    attachments: [
                      ...client.session(projectId, sessionId).attachments,
                      ...items,
                    ],
                  });
                })
                .catch((error) =>
                  setNotice(
                    error instanceof Error
                      ? error.message
                      : "Text could not be attached.",
                  ),
                )
                .finally(() => setAttaching(false));
            }}
          />
        </label>
        <div class="af-session-chips">
          {view.attachments.map((item, index) => (
            <span key={`${item.name}:${index}`}>
              {item.name}
              <button
                type="button"
                aria-label={`Remove reply attachment ${item.name}`}
                onClick={() =>
                  client.editMessage(projectId, sessionId, {
                    attachments: view.attachments.filter(
                      (_, at) => at !== index,
                    ),
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div class="af-session-composer-actions">
          <small>
            Ctrl/Cmd+Enter sends · Enter adds a line · closing this view leaves
            its process running
          </small>
          <Button variant="primary" disabled={!canSend} onClick={send}>
            Send session message
          </Button>
        </div>
      </footer>
    </section>
  );
}
