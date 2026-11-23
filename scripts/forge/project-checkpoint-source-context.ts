import {
  type ProjectCheckpointReviewBinding,
  type ProjectCheckpointReviewScope,
  projectCheckpointReviewBindingSchema,
  projectCheckpointReviewScopeSchema,
} from "../../types/project-checkpoint-reviews";
import {
  CHECKPOINT_SOURCE_UNAVAILABLE,
  type ProjectCheckpointSourceContextRead,
  projectCheckpointSourceContextReadSchema,
} from "../../types/project-checkpoint-source-context";
import {
  type ProjectCheckpointSubmissionSnapshot,
  projectCheckpointSourceVersionSchema,
} from "../../types/project-checkpoint-submissions";
import { ConversationError } from "../conversations/error";
import { workspaceKey } from "../projects/scope";
import type {
  ProjectCheckpointReviewAuthorityRequest,
  ProjectCheckpointReviewAuthorityResolver,
  ProjectCheckpointReviewStore,
} from "./project-checkpoint-review-service";
import { createProjectCheckpointSourceCapture } from "./project-checkpoint-source-capture";
import { comparableCheckout } from "./runs";

type Capture = Pick<
  ReturnType<typeof createProjectCheckpointSourceCapture>,
  "capture" | "close"
>;
export type ProjectCheckpointSourceContextOptions = {
  checkout: string;
  workspace: string;
  resolveAuthority: ProjectCheckpointReviewAuthorityResolver;
  resolveCurrentAuthority(
    scope: ProjectCheckpointReviewScope,
  ): Promise<ProjectCheckpointReviewBinding>;
  capture?: Capture;
};
export function createProjectCheckpointSourceContext(
  options: ProjectCheckpointSourceContextOptions,
) {
  const checkout = comparableCheckout(options.checkout);
  const workspace = workspaceKey(options.workspace);
  const capture = (() => {
    try {
      return (
        options.capture ??
        createProjectCheckpointSourceCapture(options.checkout)
      );
    } catch {
      return null;
    }
  })();
  let closing = false;
  let closed: Promise<void> | null = null;
  const pending = new Set<Promise<unknown>>();
  const guard = () => {
    if (closing)
      throw new ConversationError(503, CHECKPOINT_SOURCE_UNAVAILABLE);
  };
  function own<T>(work: () => Promise<T>): Promise<T> {
    if (closing)
      return Promise.reject(
        new ConversationError(503, CHECKPOINT_SOURCE_UNAVAILABLE),
      );
    const task = Promise.resolve().then(() => {
      guard();
      return work();
    });
    pending.add(task);
    return task.finally(() => pending.delete(task));
  }
  function checkedScope(value: ProjectCheckpointReviewScope) {
    const scope = projectCheckpointReviewScopeSchema.parse(value);
    if (workspaceKey(scope.workspacePath) !== workspace)
      throw new ConversationError(
        409,
        "This checkpoint belongs to another workspace.",
      );
    return Object.freeze(scope);
  }
  function checkedBase(
    value: ProjectCheckpointReviewBinding,
    scope: ProjectCheckpointReviewScope,
  ) {
    const binding = projectCheckpointReviewBindingSchema.parse(value);
    if (
      binding.projectId !== scope.projectId ||
      binding.workspacePath !== scope.workspacePath ||
      binding.runSlug !== scope.runSlug ||
      binding.beadId !== scope.beadId ||
      comparableCheckout(binding.checkout) !== checkout
    )
      throw new ConversationError(409, "The checked checkpoint scope changed.");
    return Object.freeze(binding);
  }
  function snapshot(
    value: ProjectCheckpointReviewScope,
  ): Promise<ProjectCheckpointSubmissionSnapshot> {
    const scope = checkedScope(value);
    return own(async () => {
      const before = checkedBase(
        await options.resolveCurrentAuthority(scope),
        scope,
      );
      guard();
      if (!capture)
        throw new ConversationError(503, CHECKPOINT_SOURCE_UNAVAILABLE);
      const sourceVersion = projectCheckpointSourceVersionSchema.parse(
        await capture.capture(),
      );
      guard();
      const after = checkedBase(
        await options.resolveCurrentAuthority(scope),
        scope,
      );
      guard();
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new ConversationError(
          409,
          "The checkpoint changed while its committed source was being checked.",
        );
      return Object.freeze({
        binding: before,
        sourceVersion: Object.freeze(sourceVersion),
      });
    });
  }
  return {
    snapshot,
    read(
      store: ProjectCheckpointReviewStore,
      value: ProjectCheckpointReviewScope,
    ): Promise<ProjectCheckpointSourceContextRead> {
      const scope = checkedScope(value);
      return own(async () => {
        try {
          const context = await store.submissionContext(scope);
          guard();
          return projectCheckpointSourceContextReadSchema.parse({
            available: true,
            context,
          });
        } catch {
          return { available: false, error: CHECKPOINT_SOURCE_UNAVAILABLE };
        }
      });
    },
    reviewAuthority(
      store: ProjectCheckpointReviewStore,
      value: ProjectCheckpointReviewAuthorityRequest,
    ): Promise<ProjectCheckpointReviewBinding> {
      const request = Object.freeze({ ...value });
      return own(async () => {
        const base = projectCheckpointReviewBindingSchema.parse(
          await options.resolveAuthority(request),
        );
        const scope = checkedScope({
          projectId: request.projectId,
          workspacePath: base.workspacePath,
          runSlug: request.runSlug,
          beadId: request.beadId,
        });
        checkedBase(base, scope);
        if (
          base.epicId !== request.expectedEpicId ||
          base.runUpdatedAt !== request.expectedRunUpdatedAt
        )
          throw new ConversationError(
            409,
            "The selected Run changed. Refresh its checkpoint source.",
          );
        guard();
        // Positive legacy provenance is checked before any Git capture.
        if (store.submissionInventory(scope).legacySource === "verified-v1")
          return base;
        const context = await store.submissionContext(scope);
        guard();
        if (
          !context.reviewBinding ||
          context.state !== "current" ||
          JSON.stringify(context.baseBinding) !== JSON.stringify(base)
        )
          throw new ConversationError(
            409,
            "Publish and read the exact current checkpoint source before choosing a Review decision.",
          );
        return projectCheckpointReviewBindingSchema.parse(
          context.reviewBinding,
        );
      });
    },
    close(): Promise<void> {
      if (!closed) {
        closing = true;
        closed = Promise.allSettled([
          Promise.resolve().then(() => capture?.close()),
          ...pending,
        ]).then(() => undefined);
      }
      return closed;
    },
  };
}
