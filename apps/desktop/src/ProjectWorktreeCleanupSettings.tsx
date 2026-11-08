import { Button } from "../../../docs/js/ds/Button";
import type {
  CleanupBrowserInspection,
  CleanupBrowserRecord,
} from "./project-worktree-cleanup-client";
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

type CleanupRecoveryController = Pick<
  CleanupController,
  | "authorities"
  | "hold"
  | "pending"
  | "presentationWarning"
  | "consumerWarning"
  | "checkOriginal"
  | "refreshRecovery"
>;

function cleanupReceiptFacts(receipt: CleanupBrowserRecord["receipt"]) {
  if (receipt === null)
    return <p role="status">No receipt has been verified.</p>;
  const fields = [
    ["Receipt state", receipt.state],
    ["Reason", receipt.reason ?? "Not recorded"],
    ["Audit event ID", receipt.audit.eventId],
    ["Audit ULID", receipt.audit.ulid],
  ];
  const times = [
    ["Attempted at", receipt.attemptedAt],
    ["Ended at", receipt.endedAt],
    ["Audit recorded at", receipt.audit.ts],
  ];
  return (
    <section aria-label="Verified cleanup receipt">
      <h6>Verified receipt</h6>
      <dl>
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
        {times.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {value === null ? (
                "Not recorded"
              ) : (
                <time dateTime={value}>{value}</time>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Every saved authority stays visible, including originals from deleted projects. */
export function CleanupOriginalRecovery({
  cleanup,
}: {
  cleanup: CleanupRecoveryController;
}) {
  const activity = cleanup.authorities.filter((entry) =>
    ["restoring", "reserving", "dispatching"].includes(entry.view.phase),
  );
  const retained = cleanup.authorities.some(
    (entry) => (entry.view.inventory?.records.length ?? 0) > 0,
  );
  if (
    !retained &&
    !cleanup.hold &&
    !cleanup.pending &&
    !cleanup.presentationWarning &&
    !cleanup.consumerWarning &&
    activity.length === 0
  )
    return null;
  return (
    <section class="af-project-keeper" aria-label="Saved cleanup originals">
      <h3>Saved cleanup originals</h3>
      <p>
        These originals are retained across project changes. Checking an
        original only reads its receipt; it never sends cleanup again.
      </p>
      {activity.map((entry) => (
        <p key={entry.key} role="status">
          Cleanup activity for <code>{entry.repository}</code>:{" "}
          {entry.view.phase}.
        </p>
      ))}
      {cleanup.pending && (
        <p role="status">
          An unresolved original pauses new cleanup confirmations.
        </p>
      )}
      {cleanup.hold && <p role="alert">Recovery metadata: {cleanup.hold}</p>}
      {cleanup.presentationWarning && (
        <p role="alert">Presentation refresh: {cleanup.presentationWarning}</p>
      )}
      {cleanup.consumerWarning && <p role="alert">{cleanup.consumerWarning}</p>}
      <Button onClick={() => void cleanup.refreshRecovery()}>
        Recheck cleanup recovery
      </Button>
      {cleanup.authorities.length === 0 && (
        <p role="status">
          No saved cleanup authorities are currently available.
        </p>
      )}
      {cleanup.authorities.map((entry) => (
        <section
          key={entry.key}
          aria-label={"Cleanup authority " + entry.repository}
        >
          <h4>Repository authority</h4>
          <p>
            <code>{entry.repository}</code>
          </p>
          {!entry.readsAvailable && (
            <p role="status">
              Receipt checks require a verified connection to this exact
              repository authority. Saved originals remain visible.
            </p>
          )}
          {entry.view.inventory?.records.length === 0 && (
            <p>No saved originals for this authority.</p>
          )}
          {entry.view.inventory?.records.map(({ original, receipt }) => {
            const matches = original.request.repository === entry.repository;
            const readable = entry.readsAvailable && matches;
            return (
              <article
                key={original.request.requestId}
                class="af-project-settings-review"
                aria-label={
                  "Saved cleanup original " + original.request.requestId
                }
              >
                <h5>Original cleanup request</h5>
                <dl>
                  <div>
                    <dt>Original UUID</dt>
                    <dd>
                      <code>{original.request.requestId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Original request hash</dt>
                    <dd>
                      <code>{original.requestHash}</code>
                    </dd>
                  </div>
                </dl>
                {cleanupNativeFacts(original.review)}
                {cleanupReceiptFacts(receipt)}
                {!matches && (
                  <p role="alert">
                    This original names a different repository than its labelled
                    authority. Receipt checking is unavailable; the saved
                    original is retained.
                  </p>
                )}
                <Button
                  disabled={!readable}
                  onClick={() => {
                    if (readable)
                      void cleanup.checkOriginal(
                        entry.key,
                        original.request.requestId,
                      );
                  }}
                >
                  Check original receipt
                </Button>
              </article>
            );
          })}
        </section>
      ))}
    </section>
  );
}
