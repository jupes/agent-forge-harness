import { useLayoutEffect } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type {
  ProjectCheckpointReviewOwner,
  ProjectCheckpointReviewTarget,
} from "./project-checkpoint-review-client";
import { canStartProjectCheckpointReview } from "./project-checkpoint-review-client";
import { useProjectCheckpointReview } from "./use-project-checkpoint-review";

export function ProjectCheckpointReview({
  target,
  owner,
  writable,
  active,
}: {
  target: ProjectCheckpointReviewTarget;
  owner: ProjectCheckpointReviewOwner;
  writable: boolean;
  active: boolean;
}) {
  const view = useProjectCheckpointReview(owner);
  useLayoutEffect(() => {
    owner.setTarget(target);
    return () => owner.invalidatePending();
  }, [owner, JSON.stringify(target), active, writable]);
  const locked =
    view.busy || !writable || !canStartProjectCheckpointReview(view);
  return (
    <section
      class="af-checkpoint-review"
      aria-label={`Checkpoint review ${target.beadId}`}
    >
      <h5>Review checkpoint</h5>
      {active ? (
        <>
          <label for={`checkpoint-review-note-${target.beadId}`}>
            Review note
          </label>
          <textarea
            id={`checkpoint-review-note-${target.beadId}`}
            value={view.note}
            rows={3}
            maxLength={2000}
            disabled={view.busy}
            onInput={(event) => owner.setNote(event.currentTarget.value)}
          />
          <div class="af-runs-actions">
            <Button
              disabled={locked}
              onClick={() => void owner.submit("approve")}
            >
              Approve checkpoint
            </Button>
            <Button
              disabled={locked || view.note.trim().length === 0}
              onClick={() => void owner.submit("request-changes")}
            >
              Request changes
            </Button>
          </div>
          <small>
            This records a review comment only. It does not change Beads status
            or approve a Council review.
          </small>
        </>
      ) : (
        <p>
          This checkpoint is not currently in progress. You can inspect a saved
          review below.
        </p>
      )}
      {view.phase === "loading" && (
        <p role="status">Checking saved checkpoint reviews…</p>
      )}
      {view.busy && (
        <p role="status">{view.error || "Verifying the checkpoint review…"}</p>
      )}
      {view.error && !view.busy && <p role="alert">{view.error}</p>}
      {!view.busy && (view.phase !== "loading" || !!view.error) && (
        <Button onClick={() => void owner.refresh()}>
          Refresh saved reviews
        </Button>
      )}
      {view.original && (
        <section aria-label="Verified saved review">
          <p>
            Verified{" "}
            {view.original.original.decision === "approve"
              ? "approval"
              : "request for changes"}{" "}
            for {view.original.original.binding.beadId}.
          </p>
          <p>Recorded note: {view.original.original.note || "No note."}</p>
          {view.phase === "prepared" && (
            <>
              <p role="status">
                Prepared only. Recording this saved decision requires a separate
                confirmation.
              </p>
              <Button
                disabled={view.busy || !writable}
                onClick={() => void owner.recordSaved()}
              >
                Record saved decision
              </Button>
              <Button
                disabled={view.busy || !writable}
                onClick={() => void owner.retirePrepared()}
              >
                Retire prepared review
              </Button>
            </>
          )}
          {view.original.metadata.state === "unknown" && (
            <>
              <p role="status">
                The comment outcome is unknown. Check this exact recorded
                comment before retrying.
              </p>
              <Button
                disabled={view.busy || !writable}
                onClick={() => void owner.checkRecordedComment()}
              >
                Check recorded comment
              </Button>
            </>
          )}
          {view.phase === "confirmed" && (
            <p role="status">Review comment recorded and verified.</p>
          )}
          {view.phase === "refused" && (
            <p role="status">The review comment was refused.</p>
          )}
          {view.phase === "retired" && (
            <p role="status">Prepared review retired.</p>
          )}
        </section>
      )}
      {!!view.metadata?.items.length && (
        <details>
          <summary>Saved reviews ({view.metadata.items.length})</summary>
          <ul>
            {view.metadata.items.map((item) => (
              <li key={item.requestId}>
                {item.state} · {item.requestId}{" "}
                <Button
                  disabled={view.busy}
                  onClick={() => void owner.openSaved(item.requestId)}
                >
                  Read saved decision
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
