import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { BeadWriteResult } from "../../../types/hearth";
import { Button } from "../ds/Button";
import { Field, Textarea } from "../ds/Field";
import {
  actionState,
  applied,
  beadWrites,
  useBeadWrites,
  type WriteOutcome,
} from "./bead-writes";

export interface BeadActionsProps {
  /** The bead these actions are for. */
  id: string;
  /** Its status as far as the page knows: decides which actions are offered. */
  status: string;
}

type Action = "claim" | "comment" | "close";

interface Result {
  /** `unknown`: the change may have been made and the page cannot tell. */
  tone: "done" | "failed" | "unknown";
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
 * Each action is posted once. Its result comes from the answer: what `bd`
 * said is shown here and kept in the page's store, so the views that show
 * this bead can show it too. With no control plane every control is disabled
 * and one line says why.
 */
export function BeadActions({ id, status }: BeadActionsProps): JSX.Element {
  const plane = useBeadWrites();
  const [pending, setPending] = useState<Action | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");

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
  const busy = pending !== null;

  async function run(
    action: Action,
    send: () => Promise<WriteOutcome>,
    sent: { text?: string } = {},
  ): Promise<void> {
    setPending(action);
    setResult(null);
    const outcome = await send();
    if (outcome.ok) {
      applied.record(outcome.data, sent);
      setResult({ tone: "done", message: said(action, outcome.data) });
      if (action === "comment") setComment("");
      if (action === "close") setReason("");
    } else
      setResult({
        tone: outcome.unknown ? "unknown" : "failed",
        message: outcome.error,
      });
    setPending(null);
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
          {result.tone === "unknown" ? "Outcome not known. " : ""}
          {result.message}
        </p>
      ) : null}
    </section>
  );
}
