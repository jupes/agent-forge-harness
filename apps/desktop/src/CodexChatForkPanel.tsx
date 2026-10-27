import { useRef, useState } from "preact/hooks";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type { ConversationPage } from "../../../types/conversation";
import type { CodexChatForkIdentityMetadata } from "../../../types/session-operation-identities";
import type { CodexChatForkClient } from "./codex-chat-fork-client";

const complete = (phase: string) => phase === "completed";

export function CodexChatForkPanel(props: {
  projectId: string;
  parentSessionId: string;
  page: ConversationPage | null;
  record: OwnedCodingSessionRecord;
  client: CodexChatForkClient;
  writesAllowed: boolean;
}) {
  const [open, setOpen] = useState(false),
    [turnId, setTurnId] = useState<string | null>(null),
    [review, setReview] = useState<Awaited<
      ReturnType<typeof props.client.reviewSource>
    > | null>(null),
    [identity, setIdentity] = useState<CodexChatForkIdentityMetadata | null>(
      null,
    ),
    [sourceContext, setSourceContext] = useState<Awaited<
      ReturnType<typeof props.client.readContext>
    > | null>(null),
    [childPage, setChildPage] = useState<ConversationPage | null>(null),
    [approvals, setApprovals] = useState<Awaited<
      ReturnType<typeof props.client.readChildApprovals>
    > | null>(null),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const opener = useRef<HTMLElement>(null),
    selected =
      props.page?.turns.find((turn) => turn.requestId === turnId) ?? null;

  const refreshChild = async (row: CodexChatForkIdentityMetadata) => {
    if (!row.childSessionId) return;
    const [page, permissionPage, context] = await Promise.all([
      (async () => {
        let after = 0;
        const frames: ConversationPage["frames"] = [];
        for (let count = 0; count < 40; count++) {
          const next = await props.client.readChildTurns(
            props.projectId,
            row.childSessionId!,
            row.requestId,
            after,
          );
          frames.push(...next.frames);
          if (frames.length > 2_000)
            throw new Error("The child transcript exceeds its page bound.");
          if (!next.more) return { ...next, frames };
          if (next.nextCursor <= after)
            throw new Error("The child transcript cursor did not advance.");
          after = next.nextCursor;
        }
        throw new Error("The child transcript exceeds its page bound.");
      })(),
      props.client.readChildApprovals(
        props.projectId,
        row.childSessionId,
        row.requestId,
      ),
      props.client
        .readContext(props.projectId, row.requestId)
        .catch(() => null),
    ]);
    setChildPage(page);
    setApprovals(permissionPage);
    setSourceContext(context);
  };

  const openReview = async (requestId: string, event: MouseEvent) => {
    opener.current = event.currentTarget as HTMLElement;
    setOpen(true);
    setTurnId(requestId);
    setReview(null);
    setIdentity(null);
    setChildPage(null);
    setApprovals(null);
    setMessage("Loading the selected saved turn and Fork originals…");
    try {
      const [source, originals] = await Promise.all([
        props.client.reviewSource({
          projectId: props.projectId,
          parentSessionId: props.parentSessionId,
          throughTurnRequestId: requestId,
        }),
        props.client.listOriginals(props.projectId),
      ]);
      setReview(source);
      const previous = originals.find(
        (row) =>
          row.parentSessionId === props.parentSessionId &&
          row.throughTurnRequestId === requestId,
      );
      if (previous) {
        const recovered = await props.client.recoverOriginal(
          props.projectId,
          previous.requestId,
        );
        setIdentity(recovered.original ?? recovered.identity);
        if (recovered.original?.state === "linked")
          await refreshChild(recovered.original);
        setMessage(
          recovered.state === "verified"
            ? "This exact original is verified. Opening it did not retry Fork."
            : "This original is held for inspection. It was not retried.",
        );
      } else {
        setMessage(
          "Review the saved settings and bounded history before reserving a Fork.",
        );
      }
    } catch {
      setMessage(
        "The saved source could not be verified. No Fork was reserved.",
      );
    }
  };

  const openChild = async (event: MouseEvent) => {
    opener.current = event.currentTarget as HTMLElement;
    setOpen(true);
    setReview(null);
    setIdentity(null);
    setChildPage(null);
    setApprovals(null);
    setMessage("Reading the saved Fork identity and child-only transcript…");
    try {
      const rows = await props.client.listOriginals(props.projectId);
      const linked = rows.find(
        (row) =>
          row.state === "linked" &&
          row.childSessionId === props.parentSessionId,
      );
      if (!linked) throw new Error("No linked child identity was found.");
      const recovered = await props.client.recoverOriginal(
        props.projectId,
        linked.requestId,
      );
      const original = recovered.original ?? recovered.identity;
      if (
        !original ||
        original.state !== "linked" ||
        original.childSessionId !== props.parentSessionId
      )
        throw new Error("The exact child identity could not be verified.");
      setIdentity(original);
      await refreshChild(original);
      setMessage(
        "The child transcript and controls were read from this child session. Parent history is a separate read-only view.",
      );
    } catch {
      setMessage(
        "The saved child identity could not be verified. No action was sent.",
      );
    }
  };

  const reserve = async () => {
    if (!review || !turnId) return;
    setBusy(true);
    try {
      const row = await props.client.reserveFork({
        projectId: props.projectId,
        parentSessionId: props.parentSessionId,
        throughTurnRequestId: turnId,
        source: review,
      });
      setIdentity(row);
      setMessage(
        props.client.canDispatchReservedFork(row.requestId)
          ? "Reservation saved. Confirm once to create the native child thread."
          : "Reservation reply was uncertain. This exact original is held; inspect it without retrying.",
      );
    } catch {
      setMessage(
        "The source changed or could not be reserved. Review it again before any new Fork.",
      );
    } finally {
      setBusy(false);
    }
  };

  const dispatch = async () => {
    if (!identity) return;
    setBusy(true);
    try {
      const result = await props.client.dispatchReservedFork(
        props.projectId,
        identity.requestId,
      );
      const recovered = await props.client.recoverOriginal(
        props.projectId,
        identity.requestId,
      );
      setIdentity(recovered.original ?? recovered.identity);
      if (recovered.original?.state === "linked")
        await refreshChild(recovered.original);
      setMessage(
        result.state === "linked"
          ? "The original Fork is linked to its child session."
          : "The native outcome is not confirmed. The original remains held; no retry was sent.",
      );
    } finally {
      setBusy(false);
    }
  };

  const retireNotSent = async () => {
    if (!identity || !props.client.canRetireFork(identity.requestId)) return;
    setBusy(true);
    try {
      const retired = await props.client.retireFork(
        props.projectId,
        identity.requestId,
      );
      setIdentity(retired);
      setMessage(
        "The transport proved this exact Fork request was not sent; its reservation was retired.",
      );
    } catch {
      setMessage(
        "The original could not be safely retired. It remains held for inspection.",
      );
    } finally {
      setBusy(false);
    }
  };

  const sendTurn = async () => {
    if (!identity?.childSessionId || !childPage || !draft.trim()) return;
    setBusy(true);
    try {
      await props.client.sendChildTurn(
        props.projectId,
        identity.childSessionId,
        {
          requestId: crypto.randomUUID(),
          expectedRevision: childPage.revision,
          text: draft,
          about: [],
        },
      );
      setDraft("");
      await refreshChild(identity);
      setMessage(
        "The child turn was submitted once. Check its saved transcript for the result.",
      );
    } catch {
      setMessage(
        "The child turn outcome is uncertain. Inspect this child; do not submit it again automatically.",
      );
    } finally {
      setBusy(false);
    }
  };

  const loadMoreSource = async () => {
    if (!sourceContext?.available || !sourceContext.source || !identity) return;
    const cursor = sourceContext.source.nextCursor;
    if (cursor === null) return;
    try {
      const next = await props.client.readContext(
        props.projectId,
        identity.requestId,
        cursor,
      );
      if (
        !next.available ||
        !next.source ||
        next.requestHash !== sourceContext.requestHash ||
        next.parentSessionId !== sourceContext.parentSessionId ||
        next.throughTurnRequestId !== sourceContext.throughTurnRequestId ||
        next.source.selectedTurnHash !== sourceContext.source.selectedTurnHash
      )
        throw new Error("The inherited source changed between pages.");
      const allFrames = [...sourceContext.source.frames, ...next.source.frames];
      if (
        allFrames.length > 2_000 ||
        new Set(allFrames.map((frame) => frame.seq)).size !== allFrames.length
      )
        throw new Error(
          "The inherited source page is not a bounded continuation.",
        );
      setSourceContext({
        ...next,
        source: { ...next.source, frames: allFrames },
      });
    } catch {
      setMessage(
        "More inherited history could not be verified. The child transcript remains available separately.",
      );
    }
  };

  return (
    <section class="af-session-fork-review" aria-label="Native Codex Forks">
      {props.record.provider === "codex" &&
      props.record.mode === "chat" &&
      props.record.origin ? (
        <button type="button" onClick={(event) => void openChild(event)}>
          Open saved Fork child
        </button>
      ) : (
        <>
          <h3>Fork from a completed Chat turn</h3>
          <p class="af-session-note">
            Review one exact saved turn and its captured settings. Opening this
            panel only reads protected history and original receipts.
          </p>
          <div class="af-session-composer-row">
            {(props.page?.turns ?? [])
              .filter((turn) => complete(turn.phase))
              .map((turn) => (
                <button
                  type="button"
                  key={turn.requestId}
                  onClick={(event) => void openReview(turn.requestId, event)}
                >
                  Review Fork through {turn.requestId.slice(0, 8)}
                </button>
              ))}
          </div>
        </>
      )}
      <Dialog
        open={open}
        title="Review native Codex Fork"
        titleId="codex-chat-fork-review-title"
        onClose={() => setOpen(false)}
        returnFocusRef={opener}
        class="af-session-library-dialog"
      >
        <div
          class="af-session-library-panel"
          role="region"
          aria-label="Fork source review"
        >
          <p role="status">{message}</p>
          {review && (
            <>
              <h3>Captured settings</h3>
              <dl>
                <dt>Model and provider</dt>
                <dd>
                  {review.settings.model} · {review.settings.provider}
                </dd>
                <dt>Service tier</dt>
                <dd>
                  {review.settings.serviceTier.present
                    ? (review.settings.serviceTier.value ?? "Explicitly unset")
                    : "Unavailable"}
                </dd>
                <dt>Effort</dt>
                <dd>{review.settings.effort ?? "Not reported"}</dd>
                <dt>Sandbox and approvals</dt>
                <dd>
                  {review.settings.sandbox.mode} ·{" "}
                  {review.settings.approvalPolicy}
                </dd>
                <dt>Target</dt>
                <dd>
                  {review.target.smith} · {review.target.repository} ·{" "}
                  {review.target.worktree}
                </dd>
                <dt>Provenance</dt>
                <dd>
                  Saved completed parent turn · captured native configuration
                </dd>
              </dl>
              <h3>Saved history through selected turn</h3>
              <div
                class="af-session-fork-history"
                role="region"
                aria-label="Bounded saved Fork history"
              >
                {review.frames.map((frame) => (
                  <article key={frame.seq}>
                    <p>
                      {frame.kind === "user" ? "You" : "Codex"} · {frame.at}
                    </p>
                    <p>{frame.text}</p>
                  </article>
                ))}
              </div>
              {identity && (
                <p>
                  Original {identity.requestId} · {identity.state}
                  {identity.heldReason ? ` · ${identity.heldReason}` : ""}
                </p>
              )}
              {!identity && props.writesAllowed && (
                <button
                  type="button"
                  disabled={busy || !selected || !complete(selected.phase)}
                  onClick={() => void reserve()}
                >
                  Reserve this exact Fork
                </button>
              )}
              {identity?.state === "reserved" &&
                props.client.canDispatchReservedFork(identity.requestId) && (
                  <button
                    type="button"
                    disabled={busy || !props.writesAllowed}
                    onClick={() => void dispatch()}
                  >
                    Create the native child thread once
                  </button>
                )}
              {identity?.state === "reserved" &&
                !props.client.canDispatchReservedFork(identity.requestId) &&
                (props.client.canRetireFork(identity.requestId) ? (
                  <button
                    type="button"
                    disabled={busy || !props.writesAllowed}
                    onClick={() => void retireNotSent()}
                  >
                    Retire verified not-sent original
                  </button>
                ) : (
                  <button type="button" disabled>
                    Original reservation is held
                  </button>
                ))}
              {identity?.state === "linked" && identity.childSessionId && (
                <ForkChildPanel
                  identity={identity}
                  page={childPage}
                  approvals={approvals}
                  draft={draft}
                  setDraft={setDraft}
                  busy={busy}
                  writesAllowed={props.writesAllowed}
                  onRefresh={() => void refreshChild(identity)}
                  onSend={() => void sendTurn()}
                  onDecision={async (approvalId, turnRequestId, decision) => {
                    setBusy(true);
                    try {
                      await props.client.decideChildApproval(
                        props.projectId,
                        identity.childSessionId!,
                        {
                          requestId: crypto.randomUUID(),
                          turnRequestId,
                          approvalId,
                          decision,
                        },
                      );
                      await refreshChild(identity);
                      setMessage(
                        "The permission decision was recorded for this child.",
                      );
                    } catch {
                      setMessage(
                        "The permission decision is uncertain. Read the child receipt before acting again.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                  onStop={async () => {
                    const running = childPage?.turns.find((turn) =>
                      ["accepted", "running", "cancelling"].includes(
                        turn.phase,
                      ),
                    );
                    if (!running) return;
                    setBusy(true);
                    try {
                      await props.client.stopChild(
                        props.projectId,
                        identity.childSessionId!,
                        running.requestId,
                      );
                      await refreshChild(identity);
                    } catch {
                      setMessage(
                        "Stop outcome is uncertain. Inspect this child before sending another action.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              )}
            </>
          )}
          {sourceContext?.available && sourceContext.source && (
            <section
              aria-label="Read-only inherited parent history"
              class="af-session-fork-history"
            >
              <h3>Read-only parent history through the reviewed turn</h3>
              {sourceContext.source.frames.map((frame) => (
                <article key={frame.seq}>
                  <p>
                    {frame.kind === "user" ? "You" : "Codex"} · {frame.at}
                  </p>
                  <p>{frame.text}</p>
                </article>
              ))}
              {!sourceContext.source.complete && (
                <button type="button" onClick={() => void loadMoreSource()}>
                  Load next parent-history page
                </button>
              )}
            </section>
          )}
          {identity?.state === "linked" &&
            identity.childSessionId &&
            !review && (
              <ForkChildPanel
                identity={identity}
                page={childPage}
                approvals={approvals}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                writesAllowed={props.writesAllowed}
                onRefresh={() => void refreshChild(identity)}
                onSend={() => void sendTurn()}
                onDecision={async (approvalId, turnRequestId, decision) => {
                  setBusy(true);
                  try {
                    await props.client.decideChildApproval(
                      props.projectId,
                      identity.childSessionId!,
                      {
                        requestId: crypto.randomUUID(),
                        turnRequestId,
                        approvalId,
                        decision,
                      },
                    );
                    await refreshChild(identity);
                    setMessage(
                      "The permission decision was recorded for this child.",
                    );
                  } catch {
                    setMessage(
                      "The permission decision is uncertain. Read the child receipt before acting again.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                onStop={async () => {
                  const running = childPage?.turns.find((turn) =>
                    ["accepted", "running", "cancelling"].includes(turn.phase),
                  );
                  if (!running) return;
                  setBusy(true);
                  try {
                    await props.client.stopChild(
                      props.projectId,
                      identity.childSessionId!,
                      running.requestId,
                    );
                    await refreshChild(identity);
                  } catch {
                    setMessage(
                      "Stop outcome is uncertain. Inspect this child before acting again.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}
        </div>
      </Dialog>
    </section>
  );
}

function ForkChildPanel(props: {
  identity: CodexChatForkIdentityMetadata;
  page: ConversationPage | null;
  approvals: Awaited<
    ReturnType<CodexChatForkClient["readChildApprovals"]>
  > | null;
  draft: string;
  setDraft(value: string): void;
  busy: boolean;
  writesAllowed: boolean;
  onRefresh(): void;
  onSend(): void;
  onDecision(
    approvalId: string,
    turnRequestId: string,
    decision: "accept" | "decline" | "cancel",
  ): void;
  onStop(): void;
}) {
  const active =
    props.page?.turns.some((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    ) ?? false;
  return (
    <section aria-label="Fork child conversation" class="af-session-fork-child">
      <h3>Child conversation</h3>
      <p>
        Native child session {props.identity.childSessionId}. This transcript is
        read from the child only; the reviewed parent prefix remains separate.
      </p>
      <button type="button" onClick={props.onRefresh}>
        Refresh child transcript and permissions
      </button>
      {props.page?.frames.map((frame) =>
        frame.event.kind === "user" || frame.event.kind === "text" ? (
          <article key={frame.seq}>
            <p>{frame.event.kind === "user" ? "You" : "Codex"}</p>
            <p>{frame.event.text}</p>
          </article>
        ) : null,
      )}
      {props.approvals?.pending.map((item) => (
        <article key={item.approval.id}>
          <h4>Permission request · {item.approval.kind}</h4>
          <p>
            {item.approval.command ??
              item.approval.reason ??
              "Details unavailable"}
          </p>
          {item.approval.availableDecisions.map((decision) => (
            <button
              type="button"
              disabled={!props.writesAllowed || props.busy}
              onClick={() =>
                props.onDecision(item.approval.id, item.turnRequestId, decision)
              }
            >
              {decision}
            </button>
          ))}
        </article>
      ))}
      {active && (
        <button
          type="button"
          disabled={!props.writesAllowed || props.busy}
          onClick={props.onStop}
        >
          Stop this Fork child
        </button>
      )}
      <label>
        Continue this child
        <input
          value={props.draft}
          onInput={(event) =>
            props.setDraft((event.currentTarget as HTMLInputElement).value)
          }
        />
      </label>
      <button
        type="button"
        disabled={
          !props.writesAllowed || props.busy || !props.draft.trim() || active
        }
        onClick={props.onSend}
      >
        Send child turn
      </button>
    </section>
  );
}
