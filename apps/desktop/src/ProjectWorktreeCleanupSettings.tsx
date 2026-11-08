import { Button } from "../../../docs/js/ds/Button";
import type { CleanupBrowserInspection } from "./project-worktree-cleanup-client";
import type { useProjectWorktreeCleanup } from "./use-project-worktree-cleanup";

type CleanupController = ReturnType<typeof useProjectWorktreeCleanup>;

function cleanupNativeFacts(
  review: Extract<
    CleanupBrowserInspection,
    { phase: "eligible-review" }
  >["review"],
) {
  const fields = [
    ["Project ID", review.projectId],
    ["Worktree ID", review.worktreeId],
    ["Repository", review.repository],
    ["Worktree path", review.expectedRecord.path],
    ["Branch", review.expectedRecord.branch],
    ["Bead ID", review.expectedRecord.beadId ?? "Not recorded"],
    ["Catalog revision", review.expectedCatalogRevision],
    ["Full HEAD", review.expectedHead],
  ];
  return (
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
  );
}

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

  return (
    <section
      class="af-project-settings-review"
      aria-label="Worktree cleanup review"
    >
      <h4>Review worktree cleanup</h4>
      <p>
        This is an advisory observation. Removal authorized: false. Reviewing
        does not remove anything. Confirmation checks this exact worktree again
        before removal.
      </p>
      {cleanupNativeFacts(review)}
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

type SelectedCleanupController = Pick<
  CleanupController,
  | "projectId"
  | "project"
  | "candidate"
  | "notice"
  | "canConfirm"
  | "canReview"
  | "reviewCandidate"
  | "confirmReviewed"
>;

/** Selected-project observations are separate from the global original inventory. */
export function CleanupSelectedInspection({
  projectId,
  cleanup,
}: {
  projectId: string | null;
  cleanup: SelectedCleanupController;
}) {
  const current = projectId !== null && cleanup.projectId === projectId;
  const observed = cleanup.project?.inspection;
  const inspection =
    current &&
    observed &&
    observed.phase !== "idle" &&
    observed.selection.projectId === projectId
      ? observed
      : null;
  const candidate =
    current && cleanup.candidate?.scope.projectId === projectId
      ? cleanup.candidate
      : null;
  const readable = candidate !== null && cleanup.canReview(candidate.scope);
  return (
    <section aria-label="Selected project cleanup inspection">
      {!inspection && (
        <p role="status">
          Choose a reported managed worktree to review cleanup.
        </p>
      )}
      {inspection?.phase === "checking-review" && (
        <p role="status">Checking the selected worktree…</p>
      )}
      {inspection?.phase === "review-changed" && (
        <p role="status">
          The cleanup review changed. Review the current worktree again.
        </p>
      )}
      {inspection && inspection.phase !== "eligible-review" && (
        <>
          <p>
            Project <code>{inspection.selection.projectId}</code> · worktree{" "}
            <code>{inspection.selection.worktreeId}</code> · repository{" "}
            <code>{inspection.selection.repository}</code>.
          </p>
          {inspection.notice && <p role="status">{inspection.notice}</p>}
          {(inspection.phase === "review-refused" ||
            inspection.phase === "review-unknown") && (
            <>
              <p role="status">
                Cleanup review:{" "}
                {inspection.phase === "review-refused" ? "refused" : "unknown"}.
              </p>
              {inspection.review && (
                <>
                  <p>
                    Observed at{" "}
                    <time dateTime={inspection.review.asOf}>
                      {inspection.review.asOf}
                    </time>
                    .
                  </p>
                  <ul>
                    {inspection.review.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
      {inspection?.phase === "eligible-review" && (
        <CleanupEligibleReview
          inspection={inspection}
          canConfirm={cleanup.canConfirm}
          onConfirm={cleanup.confirmReviewed}
        />
      )}
      {current && cleanup.notice && <p role="status">{cleanup.notice}</p>}
      {candidate && (
        <Button
          disabled={!readable}
          onClick={() => {
            if (cleanup.canReview(candidate.scope))
              void cleanup.reviewCandidate(candidate.scope);
          }}
        >
          Review this worktree again
        </Button>
      )}
    </section>
  );
}
