import { z } from "zod";
import { operatorRead } from "../../../docs/js/operator";
import { projectCheckpointReviewBindingSchema } from "../../../types/project-checkpoint-reviews";
import {
  CHECKPOINT_SOURCE_UNAVAILABLE,
  type ProjectCheckpointSourceContext,
  type ProjectCheckpointSourceContextRead,
  projectCheckpointSourceContextReadSchema,
} from "../../../types/project-checkpoint-source-context";
import { projectCheckpointSubmissionOriginalJson } from "../../../types/project-checkpoint-submissions";
import type { ProjectCheckpointReviewTarget } from "./project-checkpoint-review-client";

const MAX_BYTES = 128 * 1024;
const targetSchema = projectCheckpointReviewBindingSchema.pick({
  projectId: true,
  workspacePath: true,
  checkout: true,
  runSlug: true,
  epicId: true,
  beadId: true,
  runUpdatedAt: true,
});
function capturedTarget(target: ProjectCheckpointReviewTarget) {
  const {
    projectId,
    workspacePath,
    checkout,
    runSlug,
    epicId,
    beadId,
    runUpdatedAt,
  } = target;
  return targetSchema.parse({
    projectId,
    workspacePath,
    checkout,
    runSlug,
    epicId,
    beadId,
    runUpdatedAt,
  });
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}
async function sha256(text: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function readProjectCheckpointSourceContext(
  target: ProjectCheckpointReviewTarget,
  signal: AbortSignal,
  read: typeof operatorRead = operatorRead,
): Promise<ProjectCheckpointSourceContextRead> {
  const path =
    "/__agent-forge/projects/" +
    encodeURIComponent(target.projectId) +
    "/runs/" +
    encodeURIComponent(target.runSlug) +
    "/checkpoints/" +
    encodeURIComponent(target.beadId) +
    "/source-context";
  const response = await read(path, { signal }, { maxBodyBytes: MAX_BYTES });
  const reader = response.body?.getReader();
  if (!reader) throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    try {
      await reader.cancel();
    } catch {
      /* The source body may already be closed. */
    }
    throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
  } finally {
    reader.releaseLock();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
  }
  const envelope = z
    .object({
      ok: z.boolean(),
      data: z.unknown(),
      error: z.string().nullable(),
    })
    .strict()
    .parse(raw);
  if (!response.ok || !envelope.ok || envelope.error !== null)
    throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
  return projectCheckpointSourceContextReadSchema.parse(envelope.data);
}
export interface ProjectCheckpointSourceView {
  target: ProjectCheckpointReviewTarget;
  ready: boolean;
  loading: boolean;
  context: ProjectCheckpointSourceContext | null;
  error: string;
}
export function createProjectCheckpointSourceOwner(
  initial: ProjectCheckpointReviewTarget,
  options: {
    read?(
      target: ProjectCheckpointReviewTarget,
      signal: AbortSignal,
    ): Promise<ProjectCheckpointSourceContextRead>;
    onRevoke?(): void;
    digest?(text: string): Promise<string>;
    active?: boolean;
    writable?: boolean;
  } = {},
) {
  let target = immutable(capturedTarget(initial));
  let active = options.active ?? true,
    writable = options.writable ?? true,
    disposed = false,
    generation = 0;
  let abort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const load = options.read ?? readProjectCheckpointSourceContext;
  const hashText = options.digest ?? sha256;
  let view: ProjectCheckpointSourceView = immutable({
    target,
    ready: false,
    loading: false,
    context: null,
    error: "",
  });
  const paint = (next: ProjectCheckpointSourceView) => {
    view = immutable(next);
    for (const listener of listeners) listener();
  };
  function revoke(loading: boolean) {
    const revokedGeneration = ++generation;
    abort?.abort();
    abort = null;
    view = immutable({
      target,
      ready: false,
      loading,
      context: null,
      error: "",
    });
    try {
      options.onRevoke?.();
    } finally {
      for (const listener of listeners) listener();
    }
    return revokedGeneration;
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    const own = revoke(active && writable);
    if (disposed || generation !== own || !active || !writable)
      return Promise.resolve();
    const checkedTarget = target,
      controller = new AbortController();
    abort = controller;
    const owns = () =>
      !disposed &&
      generation === own &&
      !controller.signal.aborted &&
      active &&
      writable &&
      same(target, checkedTarget);
    return (async () => {
      try {
        const result = projectCheckpointSourceContextReadSchema.parse(
          await load(checkedTarget, controller.signal),
        );
        if (!owns()) return;
        if (!result.available) {
          paint({
            target,
            ready: false,
            loading: false,
            context: null,
            error: CHECKPOINT_SOURCE_UNAVAILABLE,
          });
          return;
        }
        const context = result.context;
        if (!same(capturedTarget(context.baseBinding), checkedTarget))
          throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
        if (context.record) {
          const record = context.record;
          const originalHash = await hashText(
            projectCheckpointSubmissionOriginalJson(record.original),
          );
          if (!owns()) return;
          if (
            record.original.kind !== "publish" ||
            originalHash !== record.originalHash
          )
            throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
          const reviewHash = await hashText(
            JSON.stringify({
              family: "checkpoint-source-submission",
              originalHash,
              schemaVersion: 1,
            }),
          );
          if (!owns()) return;
          if (reviewHash !== record.receipt.reviewScopeHash)
            throw Error(CHECKPOINT_SOURCE_UNAVAILABLE);
        }
        if (!owns()) return;
        paint({
          target,
          ready: context.state === "current" && context.reviewBinding !== null,
          loading: false,
          context,
          error: "",
        });
      } catch {
        if (owns())
          paint({
            target,
            ready: false,
            loading: false,
            context: null,
            error: CHECKPOINT_SOURCE_UNAVAILABLE,
          });
      } finally {
        if (generation === own) abort = null;
      }
    })();
  }
  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isCurrent(value: ProjectCheckpointReviewTarget) {
      return (
        !disposed &&
        active &&
        writable &&
        view.ready &&
        same(target, capturedTarget(value))
      );
    },
    setTarget(
      value: ProjectCheckpointReviewTarget,
      permissions: { active: boolean; writable: boolean },
    ) {
      if (disposed) return;
      const next = immutable(capturedTarget(value));
      if (
        same(target, next) &&
        active === permissions.active &&
        writable === permissions.writable
      )
        return;
      target = next;
      active = permissions.active;
      writable = permissions.writable;
      revoke(false);
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      revoke(false);
      listeners.clear();
    },
  };
}
export type ProjectCheckpointSourceOwner = ReturnType<
  typeof createProjectCheckpointSourceOwner
>;

export function captureProjectCheckpointSourceReview(
  owner: ProjectCheckpointSourceOwner,
  value: ProjectCheckpointReviewTarget,
  permissions: { active: boolean; writable: boolean },
  isLive: () => boolean = () => true,
) {
  const target = immutable(capturedTarget(value));
  const observed = owner.get();
  const matches = () => same(capturedTarget(observed.target), target);
  const isSourceCurrent = () =>
    isLive() &&
    owner.get() === observed &&
    matches() &&
    permissions.active &&
    permissions.writable &&
    owner.isCurrent(target);
  const sourceReady = isSourceCurrent();
  const binding = sourceReady ? observed.context?.reviewBinding : null;
  const reviewTarget: ProjectCheckpointReviewTarget = binding
    ? { ...target, expectedSubmissionScopeHash: binding.scopeHash }
    : target;
  return {
    target: reviewTarget,
    sourceReady,
    context: matches() ? observed.context : null,
    loading: matches() && observed.loading,
    error: matches() ? observed.error : "",
    isSourceCurrent,
    refresh: () =>
      isLive() && owner.get() === observed && matches()
        ? owner.refresh()
        : Promise.resolve(),
  };
}

export function focusProjectCheckpointReviewEntry(
  candidates: readonly (
    | { focus(): void; disabled?: boolean }
    | null
    | undefined
  )[],
  activeElement: () => unknown,
): boolean {
  for (const candidate of candidates) {
    if (!candidate || candidate.disabled) continue;
    candidate.focus();
    if (activeElement() === candidate) return true;
  }
  return false;
}
