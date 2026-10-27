import { useEffect, useRef, useState } from "preact/hooks";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type { ConversationPage } from "../../../types/conversation";
import type { CodexChatForkIdentityMetadata } from "../../../types/session-operation-identities";
import type { CodexChatForkClient } from "./codex-chat-fork-client";
import { keeperTurns } from "./keeper-model";

const complete = (phase: string) => phase === "completed";
type PanelSelection = {
  epoch: number;
  projectId: string;
  viewedSessionId: string;
  throughTurnRequestId: string | null;
  requestId: string | null;
};

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
    [message, setMessage] = useState(""),
    [childReadState, setChildReadState] = useState<
      "idle" | "loading" | "ready" | "failed"
    >("idle"),
    [identityDiscovery, setIdentityDiscovery] = useState<
      "idle" | "loading" | "ready" | "failed"
    >("idle");
  const opener = useRef<HTMLElement>(null),
    epoch = useRef(0),
    childReadEpoch = useRef(0),
    sourceReadEpoch = useRef(0),
    selection = useRef<PanelSelection | null>(null),
    openRef = useRef(false),
    selected =
      props.page?.turns.find((turn) => turn.requestId === turnId) ?? null;

  const isCurrent = (owner: PanelSelection) =>
    openRef.current &&
    selection.current?.epoch === owner.epoch &&
    props.projectId === owner.projectId &&
    props.parentSessionId === owner.viewedSessionId;
  const isCurrentIdentity = (
    owner: PanelSelection,
    row: CodexChatForkIdentityMetadata,
  ) =>
    isCurrent(owner) &&
    selection.current?.requestId === row.requestId &&
    selection.current?.throughTurnRequestId === row.throughTurnRequestId;
  const beginSelection = (
    throughTurnRequestId: string | null,
    requestId: string | null = null,
  ): PanelSelection => {
    childReadEpoch.current += 1;
    sourceReadEpoch.current += 1;
    const next = {
      epoch: ++epoch.current,
      projectId: props.projectId,
      viewedSessionId: props.parentSessionId,
      throughTurnRequestId,
      requestId,
    };
    selection.current = next;
    openRef.current = true;
    setOpen(true);
    setBusy(false);
    setDraft("");
    setIdentityDiscovery("loading");
    setChildReadState("idle");
    return next;
  };
  const closePanel = () => {
    openRef.current = false;
    epoch.current += 1;
    childReadEpoch.current += 1;
    sourceReadEpoch.current += 1;
    selection.current = null;
    setOpen(false);
    setBusy(false);
    setDraft("");
    setIdentityDiscovery("idle");
    setChildReadState("idle");
  };
  useEffect(() => {
    epoch.current += 1;
    childReadEpoch.current += 1;
    sourceReadEpoch.current += 1;
    selection.current = null;
    openRef.current = false;
    setOpen(false);
    setIdentity(null);
    setReview(null);
    setSourceContext(null);
    setChildPage(null);
    setApprovals(null);
    setDraft("");
    setTurnId(null);
    setIdentityDiscovery("idle");
    setChildReadState("idle");
  }, [props.projectId, props.parentSessionId]);
  useEffect(
    () => () => {
      openRef.current = false;
      epoch.current += 1;
      childReadEpoch.current += 1;
      sourceReadEpoch.current += 1;
      selection.current = null;
    },
    [],
  );

  const refreshChild = async (
    row: CodexChatForkIdentityMetadata,
    owner = selection.current,
  ) => {
    if (!owner || !row.childSessionId || !isCurrentIdentity(owner, row)) return;
    const readEpoch = ++childReadEpoch.current;
    setChildReadState("loading");
    setChildPage(null);
    setApprovals(null);
    let page: ConversationPage,
      permissionPage: Awaited<
        ReturnType<CodexChatForkClient["readChildApprovals"]>
      >,
      context: Awaited<ReturnType<CodexChatForkClient["readContext"]>> | null;
    try {
      [page, permissionPage, context] = await Promise.all([
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
    } catch (error) {
      if (
        isCurrentIdentity(owner, row) &&
        childReadEpoch.current === readEpoch
      ) {
        setChildPage(null);
        setApprovals(null);
        setChildReadState("failed");
      }
      throw error;
    }
    if (!isCurrentIdentity(owner, row) || childReadEpoch.current !== readEpoch)
      return;
    setChildPage(page);
    setApprovals(permissionPage);
    setSourceContext(context);
    setChildReadState("ready");
  };

  const openReview = async (requestId: string, event: MouseEvent) => {
    opener.current = event.currentTarget as HTMLElement;
    const owner = beginSelection(requestId);
    setTurnId(requestId);
    setReview(null);
    setIdentity(null);
    setSourceContext(null);
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
      if (!isCurrent(owner)) return;
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
        if (!isCurrent(owner)) return;
        const original = recovered.original ?? recovered.identity;
        if (!original)
          throw new Error("The exact Fork original is unavailable.");
        selection.current = { ...owner, requestId: original.requestId };
        setIdentity(original);
        setIdentityDiscovery("ready");
        let childReadFailed = false;
        if (recovered.original?.state === "linked") {
          try {
            await refreshChild(recovered.original, owner);
          } catch {
            childReadFailed = true;
            if (isCurrentIdentity(owner, original)) {
              setChildReadState("failed");
              setMessage(
                "The linked child history or permissions could not be verified. Sending is disabled until a complete read succeeds.",
              );
            }
          }
        }
        if (!isCurrent(owner)) return;
        if (!childReadFailed)
          setMessage(
            recovered.state === "verified"
              ? "This exact original is verified. Opening it did not retry Fork."
              : "This original is held for inspection. It was not retried.",
          );
      } else {
        selection.current = { ...owner, requestId: null };
        setIdentityDiscovery("ready");
        setMessage(
          "Review the saved settings and bounded history before reserving a Fork.",
        );
      }
    } catch {
      if (isCurrent(owner)) {
        setReview(null);
        setIdentityDiscovery("failed");
        setMessage(
          "The saved source or existing Fork originals could not be verified. No Fork was reserved.",
        );
      }
    }
  };

  const openChild = async (event: MouseEvent) => {
    opener.current = event.currentTarget as HTMLElement;
    const owner = beginSelection(null);
    setReview(null);
    setIdentity(null);
    setSourceContext(null);
    setChildPage(null);
    setApprovals(null);
    setMessage("Reading the saved Fork identity and child-only transcript…");
    try {
      const rows = await props.client.listOriginals(props.projectId);
      if (!isCurrent(owner)) return;
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
      if (!isCurrent(owner)) return;
      selection.current = {
        ...owner,
        requestId: original.requestId,
        throughTurnRequestId: original.throughTurnRequestId,
      };
      setIdentity(original);
      setIdentityDiscovery("ready");
      try {
        await refreshChild(original, owner);
      } catch {
        if (isCurrentIdentity(owner, original)) {
          setChildReadState("failed");
          setMessage(
            "The child history or permissions could not be verified. Sending is disabled until a complete read succeeds.",
          );
        }
        return;
      }
      if (!isCurrent(owner)) return;
      setMessage(
        "The child transcript and controls were read from this child session. Parent history is a separate read-only view.",
      );
    } catch {
      if (isCurrent(owner)) {
        setIdentity(null);
        setIdentityDiscovery("failed");
        setChildReadState("failed");
        setMessage(
          "The saved child identity could not be verified. No action was sent.",
        );
      }
    }
  };

  const reserve = async () => {
    const owner = selection.current;
    if (
      !owner ||
      !isCurrent(owner) ||
      !review ||
      identityDiscovery !== "ready" ||
      identity ||
      !turnId ||
      owner.throughTurnRequestId !== turnId ||
      owner.requestId !== null ||
      !props.writesAllowed
    )
      return;
    setBusy(true);
    try {
      const row = await props.client.reserveFork({
        projectId: props.projectId,
        parentSessionId: props.parentSessionId,
        throughTurnRequestId: turnId,
        source: review,
      });
      if (!isCurrent(owner)) return;
      selection.current = { ...owner, requestId: row.requestId };
      setIdentity(row);
      setMessage(
        props.client.canDispatchReservedFork(row.requestId)
          ? "Reservation saved. Confirm once to create the native child thread."
          : "Reservation reply was uncertain. This exact original is held; inspect it without retrying.",
      );
    } catch {
      if (isCurrent(owner))
        setMessage(
          "The source changed or could not be reserved. Review it again before any new Fork.",
        );
    } finally {
      if (isCurrent(owner)) setBusy(false);
    }
  };

  const dispatch = async () => {
    const owner = selection.current;
    if (
      !identity ||
      !owner ||
      !isCurrentIdentity(owner, identity) ||
      !props.writesAllowed ||
      !props.client.canDispatchReservedFork(identity.requestId)
    )
      return;
    setBusy(true);
    try {
      const result = await props.client.dispatchReservedFork(
        props.projectId,
        identity.requestId,
      );
      if (!isCurrentIdentity(owner, identity)) return;
      const recovered = await props.client.recoverOriginal(
        props.projectId,
        identity.requestId,
      );
      if (!isCurrentIdentity(owner, identity)) return;
      const original = recovered.original ?? recovered.identity;
      if (!original) throw new Error("The exact Fork original is unavailable.");
      selection.current = { ...owner, requestId: original.requestId };
      setIdentity(original);
      if (recovered.original?.state === "linked") {
        try {
          await refreshChild(recovered.original, owner);
        } catch {
          if (isCurrentIdentity(owner, original)) {
            setChildReadState("failed");
            setMessage(
              "The linked child history or permissions could not be verified. Sending is disabled until a complete read succeeds.",
            );
          }
          return;
        }
      }
      if (!isCurrentIdentity(owner, original)) return;
      setMessage(
        result.state === "linked"
          ? "The original Fork is linked to its child session."
          : "The native outcome is not confirmed. The original remains held; no retry was sent.",
      );
    } catch {
      if (isCurrentIdentity(owner, identity))
        setMessage(
          "The native outcome is uncertain. The original remains held; inspect it without retrying.",
        );
    } finally {
      if (isCurrent(owner)) setBusy(false);
    }
  };

  const retireNotSent = async () => {
    const owner = selection.current;
    if (
      !identity ||
      !owner ||
      !isCurrentIdentity(owner, identity) ||
      !props.writesAllowed ||
      !props.client.canRetireFork(identity.requestId)
    )
      return;
    setBusy(true);
    try {
      const retired = await props.client.retireFork(
        props.projectId,
        identity.requestId,
      );
      if (!isCurrentIdentity(owner, identity)) return;
      selection.current = { ...owner, requestId: retired.requestId };
      setIdentity(retired);
      setMessage(
        "The transport proved this exact Fork request was not sent; its reservation was retired.",
      );
    } catch {
      if (isCurrentIdentity(owner, identity))
        setMessage(
          "The original could not be safely retired. It remains held for inspection.",
        );
    } finally {
      if (isCurrent(owner)) setBusy(false);
    }
  };

  const sendTurn = async () => {
    const owner = selection.current;
    if (
      !identity?.childSessionId ||
      !owner ||
      !isCurrentIdentity(owner, identity) ||
      !props.writesAllowed ||
      childReadState !== "ready" ||
      !childPage ||
      !draft.trim()
    ) {
      if (identity && owner && isCurrentIdentity(owner, identity))
        setMessage(
          "The child transcript and permissions must be verified before sending.",
        );
      return;
    }
    const text = draft;
    const expectedRevision = childPage.revision;
    const requestId = crypto.randomUUID();
    setBusy(true);
    try {
      await props.client.sendChildTurn(
        props.projectId,
        identity.childSessionId,
        {
          requestId,
          expectedRevision,
          text,
          about: [],
        },
      );
      if (!isCurrentIdentity(owner, identity)) return;
      setDraft("");
      await refreshChild(identity, owner);
      if (!isCurrentIdentity(owner, identity)) return;
      setMessage(
        "The child turn was submitted once. Use Refresh child transcript and permissions to check its result or any approvals.",
      );
    } catch {
      if (isCurrentIdentity(owner, identity))
        setMessage(
          "The child turn outcome is uncertain. Inspect this child; do not submit it again automatically.",
        );
    } finally {
      if (isCurrent(owner)) setBusy(false);
    }
  };

  const loadMoreSource = async () => {
    const owner = selection.current;
    const context = sourceContext;
    if (
      !owner ||
      !identity ||
      !isCurrentIdentity(owner, identity) ||
      !context?.available ||
      !context.source
    )
      return;
    const cursor = context.source.nextCursor;
    if (cursor === null) return;
    const readEpoch = ++sourceReadEpoch.current;
    try {
      const next = await props.client.readContext(
        props.projectId,
        identity.requestId,
        cursor,
      );
      if (
        !isCurrentIdentity(owner, identity) ||
        sourceReadEpoch.current !== readEpoch
      )
        return;
      if (
        !next.available ||
        !next.source ||
        next.requestHash !== context.requestHash ||
        next.parentSessionId !== context.parentSessionId ||
        next.throughTurnRequestId !== context.throughTurnRequestId ||
        next.source.selectedTurnHash !== context.source.selectedTurnHash
      )
        throw new Error("The inherited source changed between pages.");
      const allFrames = [...context.source.frames, ...next.source.frames];
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
      if (
        isCurrentIdentity(owner, identity) &&
        sourceReadEpoch.current === readEpoch
      )
        setMessage(
          "More inherited history could not be verified. The child transcript remains available separately.",
        );
    }
  };
  const refreshCurrentChild = async (row: CodexChatForkIdentityMetadata) => {
    const owner = selection.current;
    try {
      await refreshChild(row, owner);
    } catch {
      if (owner && isCurrentIdentity(owner, row))
        setMessage(
          "The child history or permissions could not be verified. Sending is disabled until a complete read succeeds.",
        );
    }
  };
  const decideChild = async (
    approvalId: string,
    turnRequestId: string,
    decision: "accept" | "decline" | "cancel",
  ) => {
    const owner = selection.current;
    const row = identity;
    if (
      !row?.childSessionId ||
      !owner ||
      !isCurrentIdentity(owner, row) ||
      childReadState !== "ready" ||
      !childPage ||
      !props.writesAllowed
    )
      return;
    setBusy(true);
    try {
      await props.client.decideChildApproval(
        props.projectId,
        row.childSessionId,
        {
          requestId: crypto.randomUUID(),
          turnRequestId,
          approvalId,
          decision,
        },
      );
      if (!isCurrentIdentity(owner, row)) return;
      await refreshChild(row, owner);
      if (isCurrentIdentity(owner, row))
        setMessage("The permission decision was recorded for this child.");
    } catch {
      if (isCurrentIdentity(owner, row))
        setMessage(
          "The permission decision is uncertain. Read the child receipt before acting again.",
        );
    } finally {
      if (isCurrent(owner)) setBusy(false);
    }
  };
  const stopChild = async () => {
    const owner = selection.current;
    const row = identity;
    if (
      !row?.childSessionId ||
      !owner ||
      !isCurrentIdentity(owner, row) ||
      childReadState !== "ready" ||
      !childPage ||
      !props.writesAllowed
    )
      return;
    const running = childPage.turns.find((turn) =>
      ["accepted", "running", "cancelling"].includes(turn.phase),
    );
    if (!running) return;
    setBusy(true);
    try {
      await props.client.stopChild(
        props.projectId,
        row.childSessionId,
        running.requestId,
      );
      if (!isCurrentIdentity(owner, row)) return;
      await refreshChild(row, owner);
      if (isCurrentIdentity(owner, row))
        setMessage("The Stop result was read from this Fork child.");
    } catch {
      if (isCurrentIdentity(owner, row))
        setMessage(
          "Stop outcome is uncertain. Inspect this child before sending another action.",
        );
    } finally {
      if (isCurrent(owner)) setBusy(false);
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
        onClose={closePanel}
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
              {!identity &&
                props.writesAllowed &&
                identityDiscovery === "loading" && (
                  <p role="status">Checking saved Fork originals…</p>
                )}
              {!identity &&
                props.writesAllowed &&
                identityDiscovery === "failed" && (
                  <p role="status">
                    Existing Fork originals could not be verified. Close and
                    reopen this review before reserving.
                  </p>
                )}
              {!identity &&
                props.writesAllowed &&
                identityDiscovery === "ready" && (
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
                props.client.canRetireFork(identity.requestId) && (
                  <button
                    type="button"
                    disabled={busy || !props.writesAllowed}
                    onClick={() => void retireNotSent()}
                  >
                    Retire verified not-sent original
                  </button>
                )}
              {identity?.state === "reserved" &&
                !props.client.canDispatchReservedFork(identity.requestId) &&
                !props.client.canRetireFork(identity.requestId) && (
                  <button type="button" disabled>
                    Original reservation is held
                  </button>
                )}
              {identity?.state === "linked" && identity.childSessionId && (
                <ForkChildPanel
                  identity={identity}
                  page={childPage}
                  approvals={approvals}
                  readState={childReadState}
                  draft={draft}
                  setDraft={setDraft}
                  busy={busy}
                  writesAllowed={props.writesAllowed}
                  onRefresh={() => void refreshCurrentChild(identity)}
                  onSend={() => void sendTurn()}
                  onDecision={decideChild}
                  onStop={stopChild}
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
                readState={childReadState}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                writesAllowed={props.writesAllowed}
                onRefresh={() => void refreshCurrentChild(identity)}
                onSend={() => void sendTurn()}
                onDecision={decideChild}
                onStop={stopChild}
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
  readState: "idle" | "loading" | "ready" | "failed";
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
      ) ?? false,
    turns = keeperTurns(props.page);
  return (
    <section aria-label="Fork child conversation" class="af-session-fork-child">
      <h3>Child conversation</h3>
      <p>
        Native child session {props.identity.childSessionId}. This transcript is
        read from the child only; the reviewed parent prefix remains separate.
      </p>
      <button
        type="button"
        disabled={props.busy || props.readState === "loading"}
        onClick={props.onRefresh}
      >
        Refresh child transcript and permissions
      </button>
      {props.readState === "loading" && (
        <p role="status">Verifying child transcript and permissions…</p>
      )}
      {props.readState === "failed" && (
        <p role="status">
          Child transcript and permissions could not be verified. Sending is
          disabled until a complete read succeeds.
        </p>
      )}
      {turns.map((turn) => (
        <div class="af-owned-turn" key={turn.id}>
          {turn.question && (
            <article class="af-owned-question" aria-label="Your child message">
              <p>{turn.question}</p>
            </article>
          )}
          {turn.reply && (
            <article class="af-owned-reply" aria-label="Child reply">
              <p>{turn.reply}</p>
            </article>
          )}
          {turn.turn &&
            ["accepted", "running", "cancelling"].includes(turn.turn.phase) && (
              <p role="status" class="af-session-note">
                This child turn is still in progress; its displayed reply may be
                partial.
              </p>
            )}
          {turn.turn?.phase === "unknown" && (
            <p role="status" class="af-session-warning">
              The child turn outcome is unknown. Its saved reply may be partial;
              no request was resent.
            </p>
          )}
          {turn.turn?.phase === "failed" && (
            <p role="status" class="af-session-warning">
              The child turn could not finish.
            </p>
          )}
          {turn.turn?.phase === "cancelled" && (
            <p role="status" class="af-session-note">
              The child turn was stopped.
            </p>
          )}
        </div>
      ))}
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
              disabled={
                !props.writesAllowed ||
                props.busy ||
                props.readState !== "ready"
              }
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
          disabled={
            !props.writesAllowed || props.busy || props.readState !== "ready"
          }
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
          !props.writesAllowed ||
          props.busy ||
          props.readState !== "ready" ||
          !props.draft.trim() ||
          active
        }
        onClick={props.onSend}
      >
        Send child turn
      </button>
    </section>
  );
}
