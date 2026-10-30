import { createHash } from "node:crypto";
import { z } from "zod";
import type { LedgerEventInput } from "../../types/hearth";
import {
  PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES,
  PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES,
  type ProjectCheckpointReviewBinding,
  type ProjectCheckpointReviewMetadata,
  type ProjectCheckpointReviewMetadataRead,
  type ProjectCheckpointReviewOriginal,
  type ProjectCheckpointReviewOriginalRead,
  type ProjectCheckpointReviewPrepareRequest,
  type ProjectCheckpointReviewReceipt,
  type ProjectCheckpointReviewScope,
  projectCheckpointReviewBindingSchema,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalSchema,
} from "../../types/project-checkpoint-reviews";
import { ConversationError } from "../conversations/error";
import { hashText } from "../hash-text";
import type { BdRunner } from "../hearth/routes/dev-api";
import { neverStarted, storeEvent } from "../hearth/tracker-write";
import type { AppendResult } from "../ledger/append";
import type { createProjectCheckpointReviewStore } from "./project-checkpoint-review-store";

const MAX_COMMENT_ROWS = 4096;
const MAX_COMMENT_OUTPUT_BYTES = 16 * 1024 * 1024;

export type ProjectCheckpointReviewAuthorityRequest = {
  projectId: string;
  runSlug: string;
  beadId: string;
  expectedEpicId: string;
  expectedRunUpdatedAt: string;
};
export type ProjectCheckpointReviewAuthorityResolver = (
  request: ProjectCheckpointReviewAuthorityRequest,
) => Promise<ProjectCheckpointReviewBinding>;
export type ProjectCheckpointReviewCommentCount = (
  projectId: string,
  beadId: string,
) => Promise<number | null>;
export type ProjectCheckpointReviewStore = ReturnType<
  typeof createProjectCheckpointReviewStore
>;

type ReviewLocation = Pick<
  ProjectCheckpointReviewScope,
  "projectId" | "runSlug" | "beadId"
>;
type CommitInput = ReviewLocation & {
  workspacePath: string;
  requestId: string;
  intentHash: string;
};
const commentSchema = z
  .object({
    id: z.string().min(1).max(256),
    issue_id: z.string().min(1).max(200),
    author: z.string().max(1024),
    text: z.string().max(64 * 1024),
    created_at: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => Number.isFinite(Date.parse(value))),
  })
  .strict();
const commentsSchema = z.array(commentSchema).max(MAX_COMMENT_ROWS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function scopeFor(
  binding: ProjectCheckpointReviewBinding,
): ProjectCheckpointReviewScope {
  return {
    projectId: binding.projectId,
    workspacePath: binding.workspacePath,
    runSlug: binding.runSlug,
    beadId: binding.beadId,
  };
}

function authorityRequest(
  location: ReviewLocation,
  expectedEpicId: string,
  expectedRunUpdatedAt: string,
): ProjectCheckpointReviewAuthorityRequest {
  return {
    projectId: location.projectId,
    runSlug: location.runSlug,
    beadId: location.beadId,
    expectedEpicId,
    expectedRunUpdatedAt,
  };
}

function verifyBinding(
  binding: ProjectCheckpointReviewBinding,
  request: ProjectCheckpointReviewAuthorityRequest,
): ProjectCheckpointReviewBinding {
  const checked = projectCheckpointReviewBindingSchema.parse(binding);
  if (
    checked.projectId !== request.projectId ||
    checked.runSlug !== request.runSlug ||
    checked.beadId !== request.beadId ||
    checked.epicId !== request.expectedEpicId ||
    checked.runUpdatedAt !== request.expectedRunUpdatedAt
  )
    throw new ConversationError(
      409,
      "The live run or checkpoint changed. Refresh the run before recording a review.",
    );
  return checked;
}

function immutableOriginal(
  requestId: string,
  request: ProjectCheckpointReviewPrepareRequest,
  binding: ProjectCheckpointReviewBinding,
  createdAt: string,
): ProjectCheckpointReviewOriginal {
  const base = {
    schemaVersion: 1 as const,
    requestId,
    binding,
    decision: request.decision,
    note: request.note,
    commentText: "",
    createdAt,
    intentHash: "0".repeat(64),
  };
  base.commentText = projectCheckpointReviewCommentText(base);
  base.intentHash = digest(projectCheckpointReviewIntentJson(base));
  const parsed = projectCheckpointReviewOriginalSchema.parse(base);
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8") >
      PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES ||
    Buffer.byteLength(parsed.commentText, "utf8") >
      PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES
  )
    throw new ConversationError(
      413,
      "The checkpoint review original is too large.",
    );
  return parsed;
}

function validCommentId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function reportedCommentId(stdout: string, beadId: string): string | null {
  if (Buffer.byteLength(stdout, "utf8") > 64 * 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.issue_id !== beadId || typeof raw.id !== "string")
    return null;
  return validCommentId(raw.id) ? raw.id : null;
}

function markerCount(body: string, marker: string): number {
  let count = 0;
  for (
    let at = body.indexOf(marker);
    at >= 0;
    at = body.indexOf(marker, at + marker.length)
  )
    count++;
  return count;
}

function commentsEvidence(
  stdout: string,
  expectedCount: number | null,
  beadId: string,
  requestId: string,
  body: string,
):
  | { kind: "found"; commentId: string; body: string }
  | { kind: "absent" | "incomplete" | "mismatch" } {
  if (
    expectedCount === null ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    expectedCount > MAX_COMMENT_ROWS ||
    Buffer.byteLength(stdout, "utf8") > MAX_COMMENT_OUTPUT_BYTES
  )
    return { kind: "incomplete" };
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { kind: "incomplete" };
  }
  const checked = commentsSchema.safeParse(raw);
  if (
    !checked.success ||
    checked.data.length !== expectedCount ||
    checked.data.some((comment) => comment.issue_id !== beadId) ||
    new Set(checked.data.map((comment) => comment.id)).size !==
      checked.data.length ||
    checked.data.some((comment) => !validCommentId(comment.id))
  )
    return { kind: "incomplete" };
  const marker = `Forge checkpoint review ${requestId}`;
  const occurrences = checked.data.reduce(
    (total, comment) => total + markerCount(comment.text, marker),
    0,
  );
  if (occurrences === 0) return { kind: "absent" };
  if (occurrences !== 1) return { kind: "mismatch" };
  const matching = checked.data.find((comment) =>
    comment.text.includes(marker),
  );
  if (!matching || matching.text !== body) return { kind: "mismatch" };
  return { kind: "found", commentId: matching.id, body: matching.text };
}

export function createProjectCheckpointReviewService(options: {
  store: ProjectCheckpointReviewStore;
  resolveAuthority: ProjectCheckpointReviewAuthorityResolver;
  readCommentCount: ProjectCheckpointReviewCommentCount;
  runBd: BdRunner;
  workspace: string;
  appendEvent: (event: LedgerEventInput) => AppendResult;
  bdTimeoutMs?: number;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const pending = new Set<Promise<unknown>>();
  let closing = false;

  function admit<T>(work: () => Promise<T>): Promise<T> {
    if (closing)
      return Promise.reject(
        new ConversationError(503, "Checkpoint review service is closing."),
      );
    const task = Promise.resolve().then(work);
    pending.add(task);
    return task.finally(() => pending.delete(task));
  }

  function readOriginal(
    scope: ProjectCheckpointReviewScope,
    requestId: string,
    intentHash: string,
  ): Promise<ProjectCheckpointReviewOriginalRead> {
    return options.store.original(scope, requestId).then((saved) => {
      if (!saved)
        throw new ConversationError(
          404,
          "This checkpoint review original is not retained.",
        );
      if (saved.original.intentHash !== intentHash)
        throw new ConversationError(
          409,
          "The checkpoint review hash does not match its saved original.",
        );
      if (
        digest(projectCheckpointReviewIntentJson(saved.original)) !== intentHash
      )
        throw new ConversationError(
          503,
          "The saved checkpoint review original failed verification.",
        );
      return saved;
    });
  }

  async function exactReadback(
    saved: ProjectCheckpointReviewOriginalRead,
    auditEventId: number,
  ): Promise<ProjectCheckpointReviewReceipt> {
    let expectedCount: number | null = null;
    try {
      expectedCount = await options.readCommentCount(
        saved.original.binding.projectId,
        saved.original.binding.beadId,
      );
    } catch {
      // An unavailable count cannot establish a complete comment list.
    }
    let evidence: ReturnType<typeof commentsEvidence> = { kind: "incomplete" };
    if (expectedCount !== null) {
      let result: Awaited<ReturnType<BdRunner>>;
      try {
        result = await options.runBd(
          ["--readonly", "comments", saved.original.binding.beadId, "--json"],
          { timeoutMs: options.bdTimeoutMs ?? 15_000 },
        );
      } catch {
        result = { status: null, stdout: "", stderr: "" };
      }
      if (result.status === 0)
        evidence = commentsEvidence(
          result.stdout,
          expectedCount,
          saved.original.binding.beadId,
          saved.original.requestId,
          saved.original.commentText,
        );
    }
    const recorded = await options.store.recordReadback(
      scopeFor(saved.original.binding),
      saved.original.requestId,
      saved.original.intentHash,
      evidence,
      auditEventId,
    );
    const receipt = recorded.receipt;
    // The store assigns this action's auditEventId only to the one locked
    // unknown -> confirmed transition. Concurrent/replayed readbacks receive
    // the winning receipt and therefore cannot append a second event.
    if (
      receipt.state === "confirmed" &&
      receipt.readback === "found" &&
      receipt.auditEventId === auditEventId
    ) {
      try {
        await storeEvent(options.appendEvent, {
          kind: "bead.transitioned",
          workspace: options.workspace,
          beadId: saved.original.binding.beadId,
          payload: {
            action: "comment",
            hash: hashText(saved.original.commentText),
            length: saved.original.commentText.length,
          },
        });
      } catch {
        // Confirmation is already durable; a ledger outage cannot re-open or
        // repeat the tracker write.
      }
    }
    return receipt;
  }

  return {
    async prepare(
      input: {
        projectId: string;
        runSlug: string;
        beadId: string;
        request: ProjectCheckpointReviewPrepareRequest;
      },
      auditEventId: number,
    ): Promise<ProjectCheckpointReviewMetadata> {
      return admit(async () => {
        const request = authorityRequest(
          input,
          input.request.expectedEpicId,
          input.request.expectedRunUpdatedAt,
        );
        const binding = verifyBinding(
          await options.resolveAuthority(request),
          request,
        );
        const scope = scopeFor(binding);
        const prior = await options.store.original(
          scope,
          input.request.requestId,
        );
        const exact = immutableOriginal(
          input.request.requestId,
          input.request,
          binding,
          prior?.original.createdAt ?? now().toISOString(),
        );
        if (prior && !same(prior.original, exact))
          throw new ConversationError(
            409,
            "This UUID is already bound to a different checkpoint review.",
          );
        const ensureCurrent = async () => {
          const current = verifyBinding(
            await options.resolveAuthority(request),
            request,
          );
          if (!same(current, binding))
            throw new ConversationError(
              409,
              "The live project or run changed while preparing this review.",
            );
        };
        let prepared: Awaited<
          ReturnType<ProjectCheckpointReviewStore["prepare"]>
        >;
        try {
          prepared = await options.store.prepare(
            prior?.original ?? exact,
            auditEventId,
          );
        } catch (error) {
          if (
            !(error instanceof ConversationError) ||
            error.status !== 409 ||
            prior
          )
            throw error;
          const raced = await options.store.original(
            scope,
            input.request.requestId,
          );
          if (
            !raced ||
            !same(
              raced.original,
              immutableOriginal(
                input.request.requestId,
                input.request,
                binding,
                raced.original.createdAt,
              ),
            )
          )
            throw error;
          const prepared = await options.store.prepare(
            raced.original,
            auditEventId,
          );
          await ensureCurrent();
          return prepared.metadata;
        }
        await ensureCurrent();
        return prepared.metadata;
      });
    },

    metadata(
      scope: ProjectCheckpointReviewScope,
    ): Promise<ProjectCheckpointReviewMetadataRead> {
      return admit(() => options.store.metadata(scope));
    },

    original(
      scope: ProjectCheckpointReviewScope,
      requestId: string,
    ): Promise<ProjectCheckpointReviewOriginalRead | null> {
      return admit(() => options.store.original(scope, requestId));
    },

    commit(
      input: CommitInput,
      auditEventId: number,
    ): Promise<ProjectCheckpointReviewReceipt> {
      return admit(async () => {
        // Locate the original by its routed scope. Workspace routing is resolved by the caller.
        const scope: ProjectCheckpointReviewScope = {
          projectId: input.projectId,
          workspacePath: input.workspacePath,
          runSlug: input.runSlug,
          beadId: input.beadId,
        };
        const routed = await options.store.original(scope, input.requestId);
        if (!routed)
          throw new ConversationError(
            404,
            "This checkpoint review original is not retained.",
          );
        const saved = await readOriginal(
          scopeFor(routed.original.binding),
          input.requestId,
          input.intentHash,
        );
        // A durable non-prepared record cannot dispatch again. Its receipt is safe to replay
        // even if the live Run has since moved or disappeared.
        if (saved.receipt.state !== "prepared") return saved.receipt;
        const expected = authorityRequest(
          input,
          saved.original.binding.epicId,
          saved.original.binding.runUpdatedAt,
        );
        const before = verifyBinding(
          await options.resolveAuthority(expected),
          expected,
        );
        if (!same(before, saved.original.binding))
          throw new ConversationError(
            409,
            "The live run or checkpoint no longer matches this saved review.",
          );
        const claim = await options.store.claim(
          scopeFor(saved.original.binding),
          input.requestId,
          input.intentHash,
          auditEventId,
        );
        if (claim.kind !== "claimed") return claim.receipt;
        let runnerCalled = false;
        try {
          const after = verifyBinding(
            await options.resolveAuthority(expected),
            expected,
          );
          if (!same(after, saved.original.binding)) {
            return (
              await options.store.finish(
                claim.permit,
                { kind: "refused-before-dispatch" },
                auditEventId,
              )
            ).receipt;
          }
          runnerCalled = true;
          const result = await options.runBd(
            [
              "comments",
              "add",
              "--json",
              "--",
              saved.original.binding.beadId,
              saved.original.commentText,
            ],
            { timeoutMs: options.bdTimeoutMs ?? 30_000 },
          );
          if (result.status === null && neverStarted(result))
            return (
              await options.store.finish(
                claim.permit,
                { kind: "refused-before-dispatch" },
                auditEventId,
              )
            ).receipt;
          const outcome = {
            kind: "unknown" as const,
            reportedCommentId:
              result.status === 0
                ? reportedCommentId(
                    result.stdout,
                    saved.original.binding.beadId,
                  )
                : null,
          };
          await options.store.finish(claim.permit, outcome, auditEventId);
          if (result.status === 0) {
            const receipt = await exactReadback(saved, auditEventId);
            return receipt;
          }
          return (
            (
              await options.store.original(
                scopeFor(saved.original.binding),
                input.requestId,
              )
            )?.receipt ?? claim.receipt
          );
        } catch {
          if (!runnerCalled)
            return (
              await options.store.finish(
                claim.permit,
                { kind: "refused-before-dispatch" },
                auditEventId,
              )
            ).receipt;
          // The persisted dispatching/unknown record is the durable hold.
          return (
            (
              await options.store.original(
                scopeFor(saved.original.binding),
                input.requestId,
              )
            )?.receipt ?? claim.receipt
          );
        }
      });
    },

    retire(
      scope: ProjectCheckpointReviewScope,
      requestId: string,
      intentHash: string,
      auditEventId: number,
    ): Promise<ProjectCheckpointReviewReceipt> {
      return admit(async () => {
        await readOriginal(scope, requestId, intentHash);
        return (
          await options.store.retire(scope, requestId, intentHash, auditEventId)
        ).receipt;
      });
    },

    readback(
      scope: ProjectCheckpointReviewScope,
      requestId: string,
      intentHash: string,
      auditEventId: number,
    ): Promise<ProjectCheckpointReviewReceipt> {
      return admit(async () => {
        const saved = await readOriginal(scope, requestId, intentHash);
        if (["confirmed", "refused", "retired"].includes(saved.receipt.state))
          return saved.receipt;
        if (saved.receipt.state !== "unknown")
          throw new ConversationError(
            409,
            "Only an uncertain checkpoint review can be checked for its comment.",
          );
        return exactReadback(saved, auditEventId);
      });
    },

    async close(): Promise<void> {
      closing = true;
      await Promise.allSettled([...pending]);
    },
  };
}
