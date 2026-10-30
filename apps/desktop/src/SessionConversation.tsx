import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { serializeClaudeLaunch } from "../../../scripts/sessions/claude-launch";
import { serializeCodexChat } from "../../../scripts/sessions/codex-app-server-protocol";
import { serializeCodexTask } from "../../../scripts/sessions/codex-task";
import { serializeGeminiTask } from "../../../scripts/sessions/gemini-task";
import type { ConversationObject } from "../../../types/conversation";
import { GeminiTaskActivity } from "./GeminiTaskActivity";
import { KeeperSuggestions } from "./KeeperSuggestions";
import type { KeeperClient } from "./keeper-client";
import { insertKeeperSuggestion, keeperPicker } from "./keeper-context";
import { keeperTurns } from "./keeper-model";
import { desktopHref } from "./navigation";
import {
  SessionActivity,
  SessionOutcome,
  SessionTurnUsage,
} from "./SessionActivity";
import {
  ownedCodexChatOutcome,
  ownedCodexChatUsage,
  ownedSessionLifecycle,
  ownedSessionTurn,
  sessionStateSupport,
} from "./session-activity";
import type { SessionsClient } from "./session-client";
import {
  sessionAttachments,
  validateSessionAttachments,
} from "./session-composer";
import {
  CONTINUATION_SUMMARY_LIMIT,
  canContinueClaudeRateLimit,
  continuationDraftFingerprint,
  continuationDraftIsDirty,
  validContinuationSummary,
} from "./session-continuation";
import "./session.css";
import { CodexChatApprovals } from "./CodexChatApprovals";
import { CodexChatForkPanel } from "./CodexChatForkPanel";
import { CodexChatTerminal } from "./CodexChatTerminal";
import { CodexChatUsage } from "./CodexChatUsage";
import type { CodexChatForkClient } from "./codex-chat-fork-client";
import { GeminiChatConversation } from "./GeminiChatConversation";
import { SessionLibraryControls } from "./SessionLibraryControls";
import { SessionReply } from "./SessionReply";
import type { SessionLibraryClient } from "./session-library-client";
import { useCodexChatDecisions } from "./use-codex-chat-decisions";

export interface SessionConversationProps {
  projectId: string;
  sessionId: string;
  client: SessionsClient;
  keeper: KeeperClient;
  writesAllowed: boolean;
  library?: SessionLibraryClient;
  forkClient?: CodexChatForkClient;
  archived?: boolean;
  workspace?: string | null;
  onContinueToChat?(
    summary: string,
    sourceSessionId: string,
    target: "codex" | "gemini",
  ): boolean;
}
export function SessionConversation(props: SessionConversationProps) {
  const record = props.client
    .project(props.projectId)
    .records.find((item) => item.id === props.sessionId);
  return record?.provider === "gemini" && record.mode === "chat" ? (
    <GeminiChatConversation
      key={`${props.projectId}:${props.sessionId}`}
      {...props}
      record={record}
    />
  ) : (
    <StandardSessionConversation {...props} />
  );
}
function StandardSessionConversation({
  projectId,
  sessionId,
  client,
  keeper,
  writesAllowed,
  library,
  forkClient,
  archived = false,
  workspace = null,
  onContinueToChat,
}: SessionConversationProps) {
  const view = client.session(projectId, sessionId),
    record = client
      .project(projectId)
      .records.find((item) => item.id === sessionId),
    rows = keeperTurns(view.page),
    current = view.page?.turns.at(-1);
  const handoff = library?.current();
  const terminalHeld =
    handoff?.record.id === sessionId &&
    (handoff.terminalLocalHold ||
      (!!handoff.terminalAttempt &&
        handoff.terminalAttempt.phase !== "refused"));
  const running =
    current && ["accepted", "running", "cancelling"].includes(current.phase);
  const providerName =
    record?.provider === "gemini"
      ? "Gemini"
      : record?.provider === "codex"
        ? "Codex"
        : "Claude";
  const observed = [...(view.page?.frames ?? [])]
    .reverse()
    .find(
      (frame) =>
        frame.turnId === current?.requestId && frame.event.kind === "model",
    )?.event;
  const first = view.page?.frames.find(
    (frame) => frame.event.kind === "user" && frame.event.session,
  )?.event;
  const snapshot = first?.kind === "user" ? first.session : undefined;
  const codexFirst = view.page?.frames.find(
    (frame) => frame.event.kind === "user" && frame.event.codexTask,
  )?.event;
  const codexSnapshot =
    codexFirst?.kind === "user" ? codexFirst.codexTask : undefined;
  const geminiFirst = view.page?.frames.find(
    (frame) => frame.event.kind === "user" && frame.event.geminiTask,
  )?.event;
  const geminiSnapshot =
    geminiFirst?.kind === "user" ? geminiFirst.geminiTask : undefined;
  const chatFirst = view.page?.frames.find(
    (frame) => frame.event.kind === "user" && frame.event.codexChat,
  )?.event;
  const chatSnapshot =
    chatFirst?.kind === "user" ? chatFirst.codexChat : undefined;
  const isCodexChat =
    record?.provider === "codex" && record.mode === "chat" && !!chatSnapshot;
  const chatOutcome =
    isCodexChat && current
      ? ownedCodexChatOutcome(view.page, current.requestId)
      : null;
  const approvalRevision =
    view.page?.frames
      .filter(
        (frame) =>
          frame.turnId === current?.requestId &&
          frame.event.kind === "coding-chat" &&
          [
            "approval-request",
            "approval-decision",
            "approval-resolved",
            "outcome",
          ].includes(frame.event.event.kind),
      )
      .at(-1)?.seq ?? 0;
  const approvalActionable =
    isCodexChat &&
    writesAllowed &&
    !archived &&
    !!running &&
    !chatOutcome &&
    current?.phase !== "cancelling" &&
    !!view.page?.controllable &&
    !view.stopping &&
    !view.stopPosting &&
    !view.stopUnknown &&
    !view.readError &&
    !view.feedInterrupted;
  const approvals = useCodexChatDecisions({
    projectId,
    sessionId,
    turnRequestId: current?.requestId ?? null,
    enabled: isCodexChat,
    actionable: approvalActionable,
    approvalRevision,
  });
  const lifecycle = ownedSessionLifecycle(view.page, {
    mode: record?.mode ?? null,
    loaded: view.loaded,
    live: view.live,
    stopping: !!view.stopping,
    feedInterrupted: view.feedInterrupted,
    readError: view.readError,
    approvals: approvalActionable ? approvals.view() : null,
  });
  const showLifecycleGuidance =
    ["error", "unknown", "timed-out", "stale", "needs-permission"].includes(
      lifecycle.state,
    ) ||
    !!view.stopping ||
    current?.phase === "cancelling" ||
    (!!running && !view.page?.controllable);
  const usage = view.page?.frames
    .filter(
      (frame) =>
        frame.turnId === current?.requestId &&
        frame.event.kind === "coding-usage",
    )
    .at(-1)?.event;
  const feed = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const prompt = useRef<HTMLTextAreaElement>(null),
    pickerRegion = useRef<HTMLDivElement>(null),
    chatControls = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false),
    [notice, setNotice] = useState("");
  const [continuationReviewOpen, setContinuationReviewOpen] = useState(false),
    [continuationSummary, setContinuationSummary] = useState(""),
    [continuationTarget, setContinuationTarget] = useState<
      "codex" | "gemini" | ""
    >(""),
    [confirmedDraftFingerprint, setConfirmedDraftFingerprint] = useState<
      string | null
    >(null),
    [continuationProblem, setContinuationProblem] = useState("");
  const continuationOpener = useRef<HTMLElement>(null);
  const composerProject = client.project(projectId),
    continuationDraft = composerProject.composer,
    continuationDraftDirty = continuationDraftIsDirty(continuationDraft),
    currentDraftFingerprint = continuationDraftFingerprint(continuationDraft);
  const continuationState = () => {
    const currentView = client.session(projectId, sessionId),
      currentProject = client.project(projectId);
    return {
      projectId,
      workspace,
      writable: writesAllowed,
      archived,
      record:
        currentProject.records.find((item) => item.id === sessionId) ?? null,
      page: currentView.page,
      loaded: currentView.loaded,
      live: currentView.live,
      feedInterrupted: currentView.feedInterrupted,
      readError: currentView.readError,
      stopping: !!currentView.stopping,
      stopPosting: currentView.stopPosting,
      stopUnknown: currentView.stopUnknown,
      pending: !!currentView.pending,
      posting: currentView.posting,
      identity: {
        page: currentProject.identityPage,
        loading: currentProject.identityLoading,
        generation: currentProject.identityGeneration,
        startIdentity: currentProject.startIdentity,
        pendingStart: !!currentProject.pendingStart,
        starting: currentProject.starting,
        startIdentityError: currentProject.startIdentityError,
        legacyIdentityError: currentProject.legacyIdentityError,
        legacyIdentityUnavailable: currentProject.legacyIdentityUnavailable,
        inspection: currentProject.identityInspection,
      },
    };
  };
  const canContinue =
    !!onContinueToChat && canContinueClaudeRateLimit(continuationState());
  const closeContinuationReview = () => {
    setContinuationReviewOpen(false);
    setContinuationProblem("");
  };
  const acceptContinuation = () => {
    const state = continuationState(),
      draft = client.project(projectId).composer,
      dirty = continuationDraftIsDirty(draft),
      fingerprint = continuationDraftFingerprint(draft);
    if (
      !validContinuationSummary(continuationSummary) ||
      !continuationTarget ||
      (dirty && confirmedDraftFingerprint !== fingerprint) ||
      !onContinueToChat ||
      !canContinueClaudeRateLimit(state) ||
      !onContinueToChat(
        continuationSummary.trim(),
        sessionId,
        continuationTarget,
      )
    ) {
      setContinuationProblem(
        "The source or target changed. Review the saved Chat and target identity before continuing.",
      );
      return;
    }
    closeContinuationReview();
  };
  const [caret, setCaret] = useState(0),
    [pickerVisible, setPickerVisible] = useState(false),
    [attaching, setAttaching] = useState(false);
  const copyReply = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setNotice("Reply copied."))
      .catch(() => setNotice("The reply could not be copied."));
  };
  const choose = (value: string, object?: ConversationObject) => {
    const picker = keeperPicker(view.draft, caret);
    if (!picker) return;
    const insertion = insertKeeperSuggestion(view.draft, picker, value),
      changingKind = value.endsWith(":"),
      position = insertion.caret - (changingKind ? 1 : 0);
    client.draft(
      projectId,
      sessionId,
      changingKind
        ? insertion.text.slice(0, position) +
            insertion.text.slice(insertion.caret)
        : insertion.text,
    );
    if (
      object &&
      !view.about.some(
        (item) => item.kind === object.kind && item.id === object.id,
      )
    )
      client.editMessage(projectId, sessionId, {
        about: [...view.about, object],
      });
    setCaret(position);
    setPickerVisible(changingKind);
    requestAnimationFrame(() => {
      prompt.current?.focus();
      prompt.current?.setSelectionRange(position, position);
    });
  };
  const lastSequence = view.page?.nextCursor ?? 0;
  useEffect(() => {
    if (following.current && feed.current)
      feed.current.scrollTop = feed.current.scrollHeight;
    else if (lastSequence) setAway(true);
  }, [lastSequence]);
  return (
    <section
      class="af-owned-session"
      aria-label="Session conversation"
      data-session-mode={record?.mode ?? "unknown"}
    >
      <header class="af-owned-session-header">
        <div>
          <span class="af-keeper-chip">
            {record?.provider === "gemini"
              ? "Gm · Gemini"
              : record?.provider === "codex"
                ? "Cx · Codex"
                : "Cl · Claude"}
          </span>
          <h2>
            {record?.mode === "task" ? "Task" : "Chat"} ·{" "}
            {record?.beadId ?? "Project session"}
          </h2>
        </div>
        <p>
          Requested{" "}
          {record?.requestedModel ??
            (record?.provider === "gemini"
              ? "CLI default model"
              : "model unavailable")}{" "}
          ·{" "}
          {record?.provider === "gemini"
            ? "Effort is not a native Gemini option"
            : (record?.requestedEffort ?? "CLI default effort")}{" "}
          · {record?.smith ?? "smith unavailable"}
          {observed?.kind === "model" &&
          observed.model !== record?.requestedModel
            ? ` · Observed ${observed.model}`
            : ""}
        </p>
        {record?.provider === "codex" && (
          <p class="af-session-note">
            {isCodexChat
              ? "The execution model is not reported by this native Chat protocol. Thread configuration is not execution telemetry."
              : "Observed model is not reported by Codex exec."}
          </p>
        )}
        <p class="af-session-note">
          {record?.worktree ?? "Working directory not reported"}
        </p>
        <div class="af-session-composer-row">
          <span role="status" data-session-state={lifecycle.state}>
            {lifecycle.label}
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
          {running && !chatOutcome && (
            <Button
              disabled={
                !writesAllowed ||
                !view.page?.controllable ||
                !!view.stopping ||
                current.phase === "cancelling"
              }
              onClick={() => {
                approvals.invalidate();
                void client.stop(projectId, sessionId);
              }}
            >
              Stop session
            </Button>
          )}
          {record && library && (
            <SessionLibraryControls
              record={record}
              session={view}
              library={library}
              writesAllowed={writesAllowed}
              onContinue={() => prompt.current?.focus()}
              onPermissions={
                approvalActionable
                  ? () =>
                      chatControls.current
                        ?.querySelector<HTMLButtonElement>(
                          "button:not(:disabled)",
                        )
                        ?.focus()
                  : undefined
              }
              hasDedicatedForkReview={
                isCodexChat &&
                !!forkClient &&
                record?.provider === "codex" &&
                record.mode === "chat" &&
                record.origin?.kind !== "codex-chat-fork"
              }
            />
          )}
        </div>
        {isCodexChat && forkClient && record && (
          <CodexChatForkPanel
            projectId={projectId}
            parentSessionId={sessionId}
            page={view.page}
            record={record}
            client={forkClient}
            writesAllowed={writesAllowed && !archived}
          />
        )}
        {showLifecycleGuidance && (
          <p class="af-session-note">{lifecycle.detail}</p>
        )}
        <details>
          <summary>Session details</summary>
          {!showLifecycleGuidance && (
            <p class="af-session-note">{lifecycle.detail}</p>
          )}
          <dl>
            <dt>Local session</dt>
            <dd>{sessionId}</dd>
            <dt>Provider session id</dt>
            <dd>{view.page?.binding?.sessionId ?? "Not reported yet"}</dd>
            <dt>CLI version</dt>
            <dd>{view.page?.binding?.version ?? "Not reported yet"}</dd>
            <dt>Permissions</dt>
            <dd>
              {geminiSnapshot
                ? `${geminiSnapshot.launch.approvalMode ?? "CLI default approvals"} · ${geminiSnapshot.launch.sandbox === undefined ? "CLI default sandbox" : geminiSnapshot.launch.sandbox ? "Sandbox enabled" : "Sandbox disabled"}`
                : chatSnapshot
                  ? `${chatSnapshot.launch.sandbox} · approvals ${chatSnapshot.launch.approvalPolicy}`
                  : codexSnapshot
                    ? `${codexSnapshot.launch.sandbox} · approvals ${codexSnapshot.launch.approvalPolicy}`
                    : (snapshot?.launch.permissionMode ?? "Not reported yet")}
            </dd>
          </dl>
          {snapshot && (
            <pre>
              {
                serializeClaudeLaunch(snapshot.launch, snapshot.capabilities)
                  .equivalentCommand
              }
            </pre>
          )}
          {codexSnapshot && (
            <pre>
              {
                serializeCodexTask(
                  codexSnapshot.launch,
                  codexSnapshot.capabilities,
                ).equivalentCommand
              }
            </pre>
          )}
          {geminiSnapshot && (
            <pre>
              {
                serializeGeminiTask(
                  geminiSnapshot.launch,
                  geminiSnapshot.capabilities,
                ).equivalentCommand
              }
            </pre>
          )}
          {chatSnapshot && (
            <>
              <p>
                Native Chat initialization · later turns resume only the saved
                native thread.
              </p>
              <pre>
                {
                  serializeCodexChat(
                    chatSnapshot.launch,
                    chatSnapshot.capabilities,
                  ).equivalentCommand
                }
              </pre>
            </>
          )}
          {usage?.kind === "coding-usage" && (
            <dl>
              <dt>Reported input tokens</dt>
              <dd>{usage.usage.inputTokens ?? "Not reported"}</dd>
              <dt>Reported output tokens</dt>
              <dd>{usage.usage.outputTokens ?? "Not reported"}</dd>
              {usage.provider === "codex" &&
                usage.usage.cachedInputTokens !== undefined && (
                  <>
                    <dt>Reported cached input tokens</dt>
                    <dd>{usage.usage.cachedInputTokens}</dd>
                  </>
                )}
            </dl>
          )}
          <p class="af-session-note">
            Reported activity and usage are grouped with each private turn.
            Missing reports remain unavailable.
          </p>
          <details class="af-session-state-support">
            <summary>State support for this route</summary>
            <dl>
              {sessionStateSupport(
                isCodexChat,
                chatSnapshot?.launch.approvalPolicy === "on-request",
              ).map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.reason}</dd>
                </div>
              ))}
            </dl>
          </details>
        </details>
      </header>
      {(view.notice || view.readError) && (
        <div class="af-session-warning" role="status">
          <p>{view.notice}</p>
          {view.readError && <p role="alert">{view.readError}</p>}
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
        {!view.loaded && !view.readError && (
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
        {rows.map((row) => {
          const activity = ownedSessionTurn(view.page, row.id);
          const streaming =
            row.id === current?.requestId && !!running && view.live;
          return (
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
                  .map((frame) => {
                    if (frame.event.kind !== "user") return null;
                    const attachments =
                      frame.event.codexChat?.launch.attachments ??
                      frame.event.codexTask?.launch.attachments ??
                      frame.event.geminiTask?.launch.attachments ??
                      frame.event.session?.launch.attachments;
                    return attachments?.length ? (
                      <p class="af-session-note" key={frame.seq}>
                        Attachments:{" "}
                        {attachments
                          .map((item) => `${item.name} (${item.kind})`)
                          .join(", ")}
                      </p>
                    ) : null;
                  })}
              </article>
              {record?.provider !== "gemini" && (
                <SessionActivity value={activity} />
              )}
              <GeminiTaskActivity
                page={view.page}
                turnId={row.id}
                streaming={streaming}
                onCopy={copyReply}
              />
              {row.reply && (
                <SessionReply
                  text={row.reply}
                  streaming={streaming}
                  onCopy={copyReply}
                />
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
              {record?.provider !== "gemini" && (
                <>
                  <SessionOutcome
                    value={activity.outcome}
                    rateLimitReset={activity.rateLimitReset}
                  />
                  {row.id === current?.requestId && canContinue && (
                    <div class="af-session-note">
                      <p>
                        Continue on another provider with a summary you write.
                        Only that summary and a link to this Chat are carried;
                        its transcript and provider activity are not copied.
                      </p>
                      <Button
                        onClick={(event) => {
                          continuationOpener.current = event.currentTarget;
                          setContinuationSummary("");
                          setContinuationTarget("");
                          setConfirmedDraftFingerprint(null);
                          setContinuationProblem("");
                          setContinuationReviewOpen(true);
                        }}
                      >
                        Continue on another provider
                      </Button>
                    </div>
                  )}
                  {isCodexChat && row.turn && (
                    <CodexChatTerminal
                      value={ownedCodexChatOutcome(
                        view.page,
                        row.turn.requestId,
                      )}
                    />
                  )}
                  {isCodexChat ? (
                    <CodexChatUsage
                      usage={ownedCodexChatUsage(view.page, row.id)}
                      requestedModel={activity.requestedModel}
                    />
                  ) : (
                    <SessionTurnUsage
                      value={activity}
                      requestedModel={activity.requestedModel}
                    />
                  )}
                </>
              )}
            </div>
          );
        })}
        {isCodexChat && (
          <div class="af-session-chat-controls" ref={chatControls}>
            <CodexChatApprovals
              client={approvals}
              actionable={approvalActionable}
            />
          </div>
        )}
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
          {terminalHeld
            ? "A native terminal handoff is open or uncertain. Terminal activity is not synced, so app sends to this Chat are held."
            : notice ||
              (running
                ? chatOutcome
                  ? "The native process ended. Waiting for the final saved conversation status…"
                  : "The provider is answering…"
                : record?.mode === "task"
                  ? "This Task accepts one turn. Start another session explicitly."
                  : !view.page?.binding
                    ? "No confirmed provider conversation is available. Check the original Start."
                    : "Enter a follow-up for this same provider conversation.")}
        </p>
        <label>
          {record?.mode === "task"
            ? "Reply unavailable · Tasks accept one turn"
            : `Reply to ${providerName}`}
          <textarea
            ref={prompt}
            aria-label="Session reply prompt"
            rows={2}
            maxLength={16_384}
            value={view.draft}
            disabled={record?.mode === "task" || terminalHeld}
            onInput={(event) => {
              client.draft(projectId, sessionId, event.currentTarget.value);
              setCaret(event.currentTarget.selectionStart);
              setPickerVisible(true);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                pickerVisible &&
                keeperPicker(view.draft, caret)
              ) {
                event.preventDefault();
                event.stopPropagation();
                setPickerVisible(false);
              }
              if (
                event.key === "ArrowDown" &&
                pickerVisible &&
                keeperPicker(view.draft, caret)
              ) {
                const first =
                  pickerRegion.current?.querySelector<HTMLButtonElement>(
                    "button:not([disabled])",
                  );
                if (first) {
                  event.preventDefault();
                  first.focus();
                }
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !attaching &&
                !event.isComposing
              ) {
                event.preventDefault();
                if (!terminalHeld) void client.send(projectId, sessionId);
              }
            }}
          />
        </label>
        {record?.mode === "chat" && (
          <>
            <KeeperSuggestions
              projectId={projectId}
              client={keeper}
              text={view.draft}
              caret={caret}
              visible={pickerVisible}
              region={pickerRegion}
              aboutCount={view.about.length}
              recipient="this session"
              onChoose={choose}
              onClose={() => {
                setPickerVisible(false);
                prompt.current?.focus();
              }}
            />
            <label class="af-session-files">
              {isCodexChat ? "Attach text" : "Attach text or images"}
              <input
                type="file"
                multiple
                aria-label="Session reply attachments"
                accept={
                  isCodexChat
                    ? ".txt,.md,.json,.csv,.yaml,.yml,.ts,.js,.tsx,.jsx,.py,.rs"
                    : ".txt,.md,.json,.csv,.yaml,.yml,.ts,.js,.tsx,.jsx,.py,.rs,image/png,image/jpeg,image/gif,image/webp"
                }
                disabled={attaching || !!view.pending || terminalHeld}
                onChange={(event) => {
                  const files = [...(event.currentTarget.files ?? [])];
                  event.currentTarget.value = "";
                  setAttaching(true);
                  void sessionAttachments(files)
                    .then((items) => {
                      if (
                        isCodexChat &&
                        items.some((item) => item.kind !== "text")
                      )
                        throw Error(
                          "Images require server-owned staging and are unavailable for Codex Chat.",
                        );
                      const combined = [
                        ...client.session(projectId, sessionId).attachments,
                        ...items,
                      ];
                      validateSessionAttachments(combined);
                      client.editMessage(projectId, sessionId, {
                        attachments: combined,
                      });
                    })
                    .catch((error) =>
                      setNotice(
                        error instanceof Error
                          ? error.message
                          : "The attachments could not be read.",
                      ),
                    )
                    .finally(() => setAttaching(false));
                }}
              />
            </label>
            <div class="af-session-chips">
              {view.attachments.map((item, index) => (
                <span key={`${item.name}:${index}`}>
                  {item.kind} · {item.name}
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
              {view.about.map((item) => (
                <span key={`${item.kind}:${item.id}`}>
                  About {item.kind} {item.id}
                  <button
                    type="button"
                    aria-label={`Remove reply ${item.kind} ${item.id} context`}
                    onClick={() =>
                      client.editMessage(projectId, sessionId, {
                        about: view.about.filter((value) => value !== item),
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </>
        )}
        <div class="af-session-composer-actions">
          {record?.mode !== "task" && (
            <small>
              Ctrl/Cmd+Enter sends · Enter adds a line · closing this view
              leaves its process running
            </small>
          )}
          <Button
            variant="primary"
            disabled={
              terminalHeld || attaching || !client.canSend(projectId, sessionId)
            }
            onClick={() => {
              void client.send(projectId, sessionId);
            }}
          >
            Send session message
          </Button>
        </div>
      </footer>
      <Dialog
        open={continuationReviewOpen}
        title="Review a separate Chat"
        titleId="session-continuation-review-title"
        onClose={closeContinuationReview}
        returnFocusRef={continuationOpener}
        class="af-session-library-dialog"
        initialFocus="content"
        actions={
          <>
            <Button onClick={closeContinuationReview}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                !validContinuationSummary(continuationSummary) ||
                !continuationTarget ||
                (continuationDraftDirty &&
                  confirmedDraftFingerprint !== currentDraftFingerprint)
              }
              onClick={acceptContinuation}
            >
              Accept and open{" "}
              {continuationTarget === "gemini"
                ? "Gemini ACP"
                : continuationTarget === "codex"
                  ? "Codex"
                  : "target"}{" "}
              Chat
            </Button>
          </>
        }
      >
        <div
          class="af-session-library-panel"
          role="region"
          aria-label="Continuation review"
        >
          <p>
            Choose a target Chat and write the context you want to carry. The
            original Claude transcript, tools, files, and settings stay in the
            original Chat.
          </p>
          <label>
            Target Chat
            <select
              aria-label="Target Chat"
              value={continuationTarget}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setContinuationTarget(
                  value === "codex" || value === "gemini" ? value : "",
                );
                setContinuationProblem("");
              }}
            >
              <option value="">Choose a target</option>
              <option value="codex">Codex Chat</option>
              <option value="gemini">Gemini ACP Chat</option>
            </select>
          </label>
          {continuationTarget && (
            <p>
              This starts a separate{" "}
              {continuationTarget === "gemini" ? "Gemini ACP" : "Codex"} Chat.
              Only your reviewed summary and a link to this source are carried;
              the source transcript and provider activity stay in the original
              Chat.
            </p>
          )}
          <p>
            Source:{" "}
            <a
              href={desktopHref({
                projectId,
                destination: "sessions",
                selection: { kind: "session", id: sessionId },
              })}
            >
              Claude Chat {sessionId}
            </a>
          </p>
          <label>
            Handoff summary
            <textarea
              aria-label="Handoff summary"
              rows={6}
              maxLength={CONTINUATION_SUMMARY_LIMIT}
              value={continuationSummary}
              onInput={(event) => {
                setContinuationSummary(event.currentTarget.value);
                setContinuationProblem("");
              }}
              autofocus
            />
          </label>
          <small>
            {continuationSummary.trim().length}/{CONTINUATION_SUMMARY_LIMIT}{" "}
            characters
          </small>
          {continuationDraftDirty && (
            <label>
              <input
                type="checkbox"
                checked={confirmedDraftFingerprint === currentDraftFingerprint}
                onChange={(event) =>
                  setConfirmedDraftFingerprint(
                    event.currentTarget.checked
                      ? currentDraftFingerprint
                      : null,
                  )
                }
              />
              Replace the existing session draft, attachments, and context with
              this reviewed summary and source link.
            </label>
          )}
          {continuationProblem && (
            <p role="status" class="af-session-warning">
              {continuationProblem}
            </p>
          )}
        </div>
      </Dialog>
    </section>
  );
}
