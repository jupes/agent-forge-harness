import { Button } from "../../../docs/js/ds/Button";
import type { CleanupBrowserInspection } from "./project-worktree-cleanup-client";
import type { useProjectWorktreeCleanup } from "./use-project-worktree-cleanup";

type CleanupController = ReturnType<typeof useProjectWorktreeCleanup>;

/** The exact owner observation; the live controller owns confirmation. */
export function CleanupEligibleReview({
  inspection,
  canConfirm,
  onConfirm,
}: {
  inspection: Extract<CleanupBrowserInspection, { phase: "eligible-review" }>;
  canConfirm: boolean;
  onConfirm: CleanupController["confirmReviewed"];
}) {
  const review = inspection.review;
  const fields = [
    ["Project ID", review.projectId],
    ["Worktree ID", review.worktreeId],
    ["Repository", review.repository],
    ["Worktree path", review.expectedRecord.path],
    ["Branch", review.expectedRecord.branch],
    ["Bead ID", review.expectedRecord.beadId],
    ["Catalog revision", review.expectedCatalogRevision],
    ["Full HEAD", review.expectedHead],
  ];
  return (
    <section
      class="af-project-settings-review"
      aria-label="Worktree cleanup review"
    >
      <h4>Review worktree cleanup</h4>
      <p>
        This is an advisory observation. Removal authorized: false. Reviewing
        does not remove anything. Deliberate confirmation checks the current
        native guards before attempting to remove this exact worktree.
      </p>
      <dl class="af-project-settings-current">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
        <div>
          <dt>Worktree created at</dt>
          <dd>
            <time dateTime={review.expectedRecord.createdAt}>
              {review.expectedRecord.createdAt}
            </time>
          </dd>
        </div>
        <div>
          <dt>Observed at</dt>
          <dd>
            <time dateTime={review.asOf}>{review.asOf}</time>
          </dd>
        </div>
      </dl>
      {inspection.notice && <p role="status">{inspection.notice}</p>}
      {!canConfirm && (
        <p role="status">
          Confirmation is unavailable until the current cleanup gates are
          satisfied.
        </p>
      )}
      <Button
        disabled={!canConfirm}
        onClick={() => {
          if (canConfirm) void onConfirm();
        }}
      >
        Remove reviewed worktree
      </Button>
    </section>
  );
}
