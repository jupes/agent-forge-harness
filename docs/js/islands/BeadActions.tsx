import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { BeadWriteResult } from "../../../types/hearth";
import { Button } from "../ds/Button";
import { Field, Textarea } from "../ds/Field";
import {
  actionState,
  applied,
  beadWrites,
  NO_ROOM,
  useAwaiting,
  useBeadWrites,
  type WriteOutcome,
} from "./bead-writes";
import { NoticePointer } from "./PendingWrites";

export interface BeadActionsProps {
  /** The bead these actions are for. */
  id: string;
  /** Its status as far as the page knows: decides which actions are offered. */
  status: string;
}

type Action = "claim" | "comment" | "close";

/** What the last action here came to. An outcome nobody knows is not one of these: the page's list keeps it. */
interface Result {
  tone: "done" | "failed";
  message: string;
}

/** What the page says once `bd` confirmed a write. */
function said(action: Action, data: BeadWriteResult): string {
  const done =
    action === "claim"
      ? `Claimed ${data.id}${data.assignee ? ` for ${data.assignee}` : ""}.`
      : action === "comment"
        ? `Comment added to ${data.id}.`
        : `Closed ${data.id}.`;
  return data.recorded
    ? done
    : `${done} The write happened, but the ledger did not record it${
        data.recordError ? `: ${data.recordError}` : "."
      }`;
}

/**
 * Claim, comment on and close one bead, through the control plane.
 *
 * Each action is posted once: while one is out, every control here is
 * disabled and a second press does nothing. A write is out as long as the
 * page's store says so, so a block mounted again while one is out (the panel
 * reopened, the view left and come back to) does not offer it again. Its result comes from the answer:
 * what `bd` said is shown here and kept in the page's store, so the views
 * that show this bead can show it too. An answer that leaves the outcome
 * unknown is kept there as well, and listed under Writes to check, as is a
 * refusal that comes back after this block is gone. While the page holds
 * twenty writes out or listed, an action is not sent and the block says so.
 * With no control plane every control is disabled and one line says why.
 */
export function BeadActions({ id, status }: BeadActionsProps): JSX.Element {
  const plane = useBeadWrites();
  const [pending, setPending] = useState<Action | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const awaited = useAwaiting(id);
  // Set before the first await and read before anything else: two presses in
  // one turn of the event loop arrive before the disabled state is drawn.
  const sending = useRef(false);
  // An answer that comes back after this block is gone has nobody to tell.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The writes sent from here: the pointer to the list is for these.
  const [sentKeys] = useState(() => new Set<string>());

  const offers = actionState(
    plane === null
      ? {
          available: false,
          reason: "Looking for the local control plane…",
          status,
        }
      : plane.available
        ? { available: true, status }
        : { available: false, reason: plane.reason, status },
  );
  const live = plane?.available === true;
  const busy = pending !== null || awaited.length > 0;
  const outFromBefore = pending === null ? awaited[0] : undefined;

  async function run(
    action: Action,
    send: () => Promise<WriteOutcome>,
    sent: { text?: string } = {},
  ): Promise<void> {
    if (sending.current) return;
    const key = applied.begin({ action, id });
    if (key === null) {
      setResult({ tone: "failed", message: NO_ROOM });
      return;
    }
    sending.current = true;
    setPending(action);
    setResult(null);
    sentKeys.add(key);
    try {
      const outcome = await send();
      if (outcome.ok) {
        applied.settle(key);
        applied.record(outcome.data, sent);
        setResult({ tone: "done", message: said(action, outcome.data) });
        if (action === "comment") setComment("");
        if (action === "close") setReason("");
      } else if (outcome.unknown) applied.unknown(key, outcome.error);
      else if (!mounted.current) applied.refused(key, outcome.error);
      else {
        applied.settle(key);
        setResult({ tone: "failed", message: outcome.error });
      }
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  // Ids hold dots; an element id and a label's `for` take them as they are.
  const commentId = `bead-comment-${id}`;
  const reasonId = `bead-reason-${id}`;
  const why = (offer: { enabled: boolean; reason?: string }) =>
    offer.enabled ? undefined : offer.reason;
  /** A tooltip only where there is something to say. */
  const titled = (offer: { enabled: boolean; reason?: string }) => {
    const reason = why(offer);
    return reason === undefined ? {} : { title: reason };
  };

  return (
    <section class="af-review af-bead-actions" aria-label={`Actions on ${id}`}>
      <p class="af-section-label">Actions</p>
      {!live ? (
        <p class="af-muted af-bead-unavailable">{why(offers.comment)}</p>
      ) : null}

      <div class="af-button-row">
        <Button
          disabled={!offers.claim.enabled || busy}
          {...titled(offers.claim)}
          onClick={() => void run("claim", () => beadWrites.claim(id))}
        >
          {pending === "claim" ? "Claiming…" : "Claim"}
        </Button>
      </div>
      {live && !offers.claim.enabled ? (
        <p class="af-muted af-bead-why">{why(offers.claim)}</p>
      ) : null}

      <Field label="Comment" id={commentId}>
        <Textarea
          id={commentId}
          value={comment}
          rows={3}
          placeholder="A worklog: line, a decision, what you checked"
          disabled={!offers.comment.enabled || busy}
          onInput={(event) => setComment(event.currentTarget.value)}
        />
      </Field>
      <div class="af-button-row">
        <Button
          disabled={!offers.comment.enabled || busy || !comment.trim()}
          onClick={() =>
            void run("comment", () => beadWrites.comment(id, comment), {
              text: comment,
            })
          }
        >
          {pending === "comment" ? "Adding…" : "Add comment"}
        </Button>
      </div>

      <Field
        label="Reason for closing"
        id={reasonId}
        hint="A bead is not closed without saying why: the evidence, or the reason it is dropped."
      >
        <Textarea
          id={reasonId}
          value={reason}
          rows={2}
          describedBy={`${reasonId}-hint`}
          placeholder="What shows this is done"
          disabled={!offers.close.enabled || busy}
          onInput={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
      <div class="af-button-row">
        <Button
          disabled={!offers.close.enabled || busy || !reason.trim()}
          {...titled(offers.close)}
          onClick={() => void run("close", () => beadWrites.close(id, reason))}
        >
          {pending === "close" ? "Closing…" : "Close issue"}
        </Button>
      </div>
      {live && !offers.close.enabled ? (
        <p class="af-muted af-bead-why">{why(offers.close)}</p>
      ) : null}

      {result ? (
        <p
          role="status"
          class={`af-review-result af-bead-result${
            result.tone === "done" ? "" : " is-error"
          }`}
          data-outcome={result.tone}
        >
          {result.message}
        </p>
      ) : null}
      {outFromBefore !== undefined ? (
        <p class="af-muted af-bead-out">
          A {outFromBefore.action} sent from this page is still out: nothing
          here is offered until it is answered.
        </p>
      ) : null}
      <NoticePointer sent={sentKeys} />
    </section>
  );
}
