import { workspaceKey } from "../../../scripts/projects/scope";
import {
  type ProjectCheckpointInboxContextRead,
  projectCheckpointInboxContextReadSchema,
} from "../../../types/project-checkpoint-inbox-context";
import {
  type ProjectCheckpointReviewBinding,
  type ProjectCheckpointReviewOriginalRead,
  projectCheckpointReviewBindingSchema,
  projectCheckpointReviewIntentJson,
} from "../../../types/project-checkpoint-reviews";
import {
  type ProjectCheckpointSubmissionRecord,
  projectCheckpointSubmissionOriginalJson,
} from "../../../types/project-checkpoint-submissions";
import type {
  InboxSourceFactBase,
  InboxSourceRead,
} from "./inbox-bead-shift-source";
import type { InboxDispositionScope } from "./inbox-dispositions-client";

type Target = Omit<
  ProjectCheckpointReviewBinding,
  "catalogRevision" | "scopeHash"
>;
type Available = Extract<
  ProjectCheckpointInboxContextRead,
  { available: true }
>;
type ReviewStatus = "awaiting-review" | "recovery-required" | "recorded-review";
export interface InboxCheckpointFact extends InboxSourceFactBase {
  sourceKind: "checkpoint-review";
  status: "pending" | "informational";
  reviewStatus: ReviewStatus;
  sourceIdentity: {
    runSlug: string;
    beadId: string;
    publication: ProjectCheckpointSubmissionRecord;
    binding: ProjectCheckpointReviewBinding;
    records: readonly ProjectCheckpointReviewOriginalRead[];
    active: ProjectCheckpointReviewOriginalRead | null;
    latestAttempt: ProjectCheckpointReviewOriginalRead | null;
    latestRecordedReview: ProjectCheckpointReviewOriginalRead | null;
    blockedElsewhere: boolean;
  };
}
export interface InboxCheckpointProjectionInput {
  scope: InboxDispositionScope;
  target: Target;
  sourceGeneration: number;
  catalogRevision: number;
  association: InboxSourceRead<ProjectCheckpointInboxContextRead>;
}
export interface InboxCheckpointProjection {
  scope: InboxDispositionScope;
  target: Target | null;
  sourceGeneration: number;
  catalogRevision: number;
  status: ReviewStatus | "not-current" | "unverified";
  facts: readonly InboxCheckpointFact[];
  coverage: InboxSourceRead<unknown>["coverage"];
  diagnostics: readonly string[];
}
const targetSchema = projectCheckpointReviewBindingSchema.omit({
  catalogRevision: true,
  scopeHash: true,
});
const unavailable =
  "The current checkpoint source and review association could not be verified.";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function capture<T>(
  schema: { parse(value: unknown): T },
  raw: unknown,
): T | null {
  try {
    return freeze(structuredClone(schema.parse(raw)));
  } catch {
    return null;
  }
}
async function sha256(text: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
type Verified = {
  data: Available;
  publication: ProjectCheckpointSubmissionRecord;
  binding: ProjectCheckpointReviewBinding;
  reviewStatus: ReviewStatus;
  active: ProjectCheckpointReviewOriginalRead | null;
  latestAttempt: ProjectCheckpointReviewOriginalRead | null;
  latestRecordedReview: ProjectCheckpointReviewOriginalRead | null;
};
type Joined = {
  status: InboxCheckpointProjection["status"];
  verified: Verified | null;
};
/** Per-target source facts only: no global inventory, action or resolution authority. */
export async function projectInboxCheckpointSource(
  input: InboxCheckpointProjectionInput,
): Promise<InboxCheckpointProjection> {
  const scope = {
      projectId: input.scope.projectId,
      workspace: input.scope.workspace,
    },
    target = capture(targetSchema, input.target),
    sourceGeneration = input.sourceGeneration,
    catalogRevision = input.catalogRevision,
    coverage = { ...input.association.coverage };
  // Capture both complete bundles, including nested originals, before any digest awaits.
  const raw = capture(
      projectCheckpointInboxContextReadSchema,
      input.association.raw,
    ),
    prior = capture(
      projectCheckpointInboxContextReadSchema,
      input.association.lastVerified,
    );
  const epochsValid = [sourceGeneration, catalogRevision].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  const scopeValid =
    target !== null &&
    typeof scope.workspace === "string" &&
    scope.projectId === target.projectId &&
    workspaceKey(scope.workspace) === workspaceKey(target.workspacePath);
  const join = async (
    data: ProjectCheckpointInboxContextRead | null,
  ): Promise<Joined> => {
    if (!epochsValid || !scopeValid || !target || !data?.available)
      return { status: "unverified", verified: null };
    try {
      const {
        catalogRevision: _catalog,
        scopeHash: _hash,
        ...location
      } = data.context.baseBinding;
      if (JSON.stringify(location) !== JSON.stringify(target))
        return { status: "unverified", verified: null };
      const context = data.context;
      if (
        context.state !== "current" ||
        context.continuity !== "anchored" ||
        !data.association.complete
      )
        return { status: "not-current", verified: null };
      const publication = context.record,
        binding = context.reviewBinding;
      if (!publication || publication.original.kind !== "publish" || !binding)
        return { status: "unverified", verified: null };
      const originalHash = await sha256(
        projectCheckpointSubmissionOriginalJson(publication.original),
      );
      if (originalHash !== publication.originalHash)
        return { status: "unverified", verified: null };
      const reviewHash = await sha256(
        JSON.stringify({
          family: "checkpoint-source-submission",
          originalHash,
          schemaVersion: 1,
        }),
      );
      if (
        reviewHash !== publication.receipt.reviewScopeHash ||
        reviewHash !== binding.scopeHash
      )
        return { status: "unverified", verified: null };
      for (const row of data.association.records)
        if (
          (await sha256(projectCheckpointReviewIntentJson(row.original))) !==
          row.original.intentHash
        )
          return { status: "unverified", verified: null };
      const active =
        data.association.records.find(
          (row) =>
            row.receipt.state === "prepared" || row.receipt.state === "unknown",
        ) ?? null;
      const latestRecordedReview =
        data.association.records
          .filter(
            (row) =>
              row.receipt.state === "confirmed" &&
              row.receipt.readback === "found",
          )
          .at(-1) ?? null;
      const reviewStatus: ReviewStatus =
        active || data.association.blockedElsewhere
          ? "recovery-required"
          : latestRecordedReview
            ? "recorded-review"
            : "awaiting-review";
      return {
        status: reviewStatus,
        verified: {
          data,
          publication,
          binding,
          reviewStatus,
          active,
          latestAttempt: data.association.records.at(-1) ?? null,
          latestRecordedReview,
        },
      };
    } catch {
      return { status: "unverified", verified: null };
    }
  };
  const current = await join(raw);
  const readsCurrent =
    coverage.started === true &&
    coverage.settled === true &&
    coverage.complete === true &&
    coverage.fresh === true &&
    coverage.error === null;
  const fresh =
    readsCurrent &&
    current.verified !== null &&
    current.verified.data.context.baseBinding.catalogRevision ===
      catalogRevision;
  const selected = fresh ? current.verified : (await join(prior)).verified;
  const result: InboxCheckpointProjection = {
    scope,
    target,
    sourceGeneration,
    catalogRevision,
    status: fresh
      ? current.status
      : readsCurrent && current.status === "not-current"
        ? "not-current"
        : "unverified",
    facts: [],
    coverage: {
      ...coverage,
      complete: fresh,
      fresh,
      error: fresh ? null : unavailable,
    },
    diagnostics: fresh ? [] : [unavailable],
  };
  if (!selected) return freeze(result);
  try {
    const {
      data,
      publication,
      binding,
      reviewStatus,
      active,
      latestAttempt,
      latestRecordedReview,
    } = selected;
    const identity = [
      "inbox-source-v1",
      workspaceKey(scope.workspace),
      scope.projectId,
      "checkpoint-review",
      [
        binding.runSlug,
        binding.beadId,
        publication.original.requestId,
        publication.originalHash,
      ],
    ];
    const stableItemId = "sha256:" + (await sha256(JSON.stringify(identity)));
    const sourceRevision =
      "sha256:" +
      (await sha256(
        JSON.stringify([
          "inbox-revision-v1",
          identity,
          data.context,
          data.association,
        ]),
      ));
    result.facts = [
      freeze<InboxCheckpointFact>({
        ...scope,
        sourceKind: "checkpoint-review",
        status:
          reviewStatus === "recorded-review" ? "informational" : "pending",
        reviewStatus,
        stableItemId,
        sourceRevision,
        title:
          reviewStatus === "recovery-required"
            ? "Checkpoint review needs recovery"
            : reviewStatus === "recorded-review"
              ? "Checkpoint review recorded"
              : "Checkpoint awaiting review",
        detail:
          reviewStatus === "recovery-required"
            ? "An unresolved review is retained. Open Runs to recover its exact original before another review."
            : reviewStatus === "recorded-review"
              ? "A human review was recorded for this source. This history does not verify the current comment or complete the bead."
              : "An exact committed source publication awaits human review in Runs.",
        fresh,
        complete: fresh,
        resolved: false,
        unresolvedReason:
          "No independent resolution or current comment verification was supplied.",
        sourceIdentity: {
          runSlug: binding.runSlug,
          beadId: binding.beadId,
          publication,
          binding,
          records: data.association.records,
          active,
          latestAttempt,
          latestRecordedReview,
          blockedElsewhere: data.association.blockedElsewhere,
        },
      }),
    ];
  } catch {
    result.coverage = {
      ...result.coverage,
      complete: false,
      fresh: false,
      error: unavailable,
    };
    result.diagnostics = [unavailable];
    result.status = "unverified";
  }
  return freeze(result);
}
