import { workspaceKey } from "../../../scripts/projects/scope";
import {
  type ProjectCheckpointReviewInventoryRead,
  projectCheckpointReviewInventoryJson,
  projectCheckpointReviewInventoryReadSchema,
  projectCheckpointReviewInventoryScopeSchema,
} from "../../../types/project-checkpoint-review-inventory";
import {
  type ProjectCheckpointReviewOriginalRead,
  projectCheckpointReviewIntentJson,
} from "../../../types/project-checkpoint-reviews";
import type {
  InboxSourceFactBase,
  InboxSourceRead,
} from "./inbox-bead-shift-source";
import type { InboxDispositionScope } from "./inbox-dispositions-client";

type Available = Extract<
  ProjectCheckpointReviewInventoryRead,
  { available: true }
>;
export interface InboxRetainedCheckpointFact extends InboxSourceFactBase {
  sourceKind: "checkpoint-review";
  status: "pending";
  reviewStatus: "prepared" | "unknown";
  sourceIdentity: {
    runSlug: string;
    beadId: string;
    originalRead: ProjectCheckpointReviewOriginalRead;
  };
}
export interface InboxRetainedCheckpointProjectionInput {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  inventory: InboxSourceRead<ProjectCheckpointReviewInventoryRead>;
}
export interface InboxRetainedCheckpointProjection {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  facts: readonly InboxRetainedCheckpointFact[];
  history: readonly ProjectCheckpointReviewOriginalRead[];
  snapshot: Available | null;
  coverage: InboxSourceRead<unknown>["coverage"];
  diagnostics: readonly string[];
}
const unavailable =
  "Retained checkpoint Review attention could not be verified. Read the saved reviews before another attempt.";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function capture(raw: unknown): ProjectCheckpointReviewInventoryRead | null {
  try {
    return freeze(
      structuredClone(projectCheckpointReviewInventoryReadSchema.parse(raw)),
    );
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
/** Retained uncertainty is independent of current Run eligibility or a source publication. */
export async function projectInboxRetainedCheckpointSources(
  input: InboxRetainedCheckpointProjectionInput,
): Promise<InboxRetainedCheckpointProjection> {
  const scope = {
      projectId: input.scope.projectId,
      workspace: input.scope.workspace,
    },
    sourceGeneration = input.sourceGeneration,
    catalogRevision = input.catalogRevision,
    coverage = { ...input.inventory.coverage };
  const expected = projectCheckpointReviewInventoryScopeSchema.safeParse({
    projectId: scope.projectId,
    workspacePath: scope.workspace,
  });
  // Both complete inventories and all caller state are captured before the first digest.
  const raw = capture(input.inventory.raw),
    prior = capture(input.inventory.lastVerified);
  const valid =
    expected.success &&
    [sourceGeneration, catalogRevision].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
  const verify = async (
    value: ProjectCheckpointReviewInventoryRead | null,
  ): Promise<Available | null> => {
    if (
      !valid ||
      !value?.available ||
      value.scope.projectId !== scope.projectId ||
      workspaceKey(value.scope.workspacePath) !== workspaceKey(scope.workspace)
    )
      return null;
    try {
      if (
        (await sha256(
          projectCheckpointReviewInventoryJson(value.scope, value.records),
        )) !== value.observationRevision
      )
        return null;
      const active = new Set<string>();
      for (const row of value.records) {
        if (
          (await sha256(projectCheckpointReviewIntentJson(row.original))) !==
          row.original.intentHash
        )
          return null;
        if (
          row.receipt.state === "prepared" ||
          row.receipt.state === "unknown"
        ) {
          const key = JSON.stringify([
            workspaceKey(row.original.binding.workspacePath),
            row.original.binding.beadId,
          ]);
          if (active.has(key)) return null;
          active.add(key);
        }
      }
      return value;
    } catch {
      return null;
    }
  };
  const current = await verify(raw),
    fresh =
      current !== null &&
      coverage.started === true &&
      coverage.settled === true &&
      coverage.complete === true &&
      coverage.fresh === true &&
      coverage.error === null;
  const selected = fresh ? current : await verify(prior);
  const result: InboxRetainedCheckpointProjection = {
    scope,
    sourceGeneration,
    catalogRevision,
    facts: [],
    history: selected?.records ?? [],
    snapshot: selected,
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
    const facts: InboxRetainedCheckpointFact[] = [];
    for (const row of selected.records) {
      const state = row.receipt.state;
      if (state !== "prepared" && state !== "unknown") continue;
      const original = row.original,
        identity = [
          "inbox-source-v1",
          workspaceKey(scope.workspace),
          scope.projectId,
          "checkpoint-review",
          [
            "retained-review",
            original.binding.runSlug,
            original.binding.beadId,
            original.requestId,
            original.intentHash,
          ],
        ];
      const stableItemId = "sha256:" + (await sha256(JSON.stringify(identity))),
        sourceRevision =
          "sha256:" +
          (await sha256(JSON.stringify(["inbox-revision-v1", identity, row])));
      facts.push(
        freeze<InboxRetainedCheckpointFact>({
          ...scope,
          sourceKind: "checkpoint-review",
          status: "pending",
          reviewStatus: state,
          stableItemId,
          sourceRevision,
          title: "Checkpoint review needs recovery",
          detail:
            state === "prepared"
              ? "A saved review is prepared. Open Runs to inspect or retire that exact review."
              : "A review outcome is uncertain. Read back the exact saved review before another attempt.",
          fresh,
          complete: fresh,
          resolved: false,
          unresolvedReason:
            "Reading this saved review does not resolve its prepared or uncertain outcome.",
          sourceIdentity: {
            runSlug: original.binding.runSlug,
            beadId: original.binding.beadId,
            originalRead: row,
          },
        }),
      );
    }
    result.facts = facts;
  } catch {
    result.coverage = {
      ...result.coverage,
      fresh: false,
      complete: false,
      error: unavailable,
    };
    result.diagnostics = [unavailable];
  }
  return freeze(result);
}
