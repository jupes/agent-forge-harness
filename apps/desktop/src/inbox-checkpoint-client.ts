import { z } from "zod";
import { type OperatorRead, operatorRead } from "../../../docs/js/operator";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import {
  MAX_PROJECT_RUN_BYTES,
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../../scripts/projects/run-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import {
  CHECKPOINT_INBOX_CONTEXT_MAX_BYTES,
  type ProjectCheckpointInboxContextRead,
  projectCheckpointInboxContextReadSchema,
} from "../../../types/project-checkpoint-inbox-context";
import {
  CHECKPOINT_REVIEW_INVENTORY_MAX_BYTES,
  projectCheckpointReviewInventoryReadSchema,
} from "../../../types/project-checkpoint-review-inventory";
import { projectCheckpointReviewBindingSchema } from "../../../types/project-checkpoint-reviews";
import { projectCheckpointSubmissionOriginalJson } from "../../../types/project-checkpoint-submissions";
import type {
  ProjectRunDetail,
  ProjectRunsPage,
} from "../../../types/project-runs";
import type { InboxSourceRead } from "./inbox-bead-shift-source";
import {
  type InboxRetainedCheckpointFact,
  type InboxRetainedCheckpointProjection,
  projectInboxRetainedCheckpointSources,
} from "./inbox-checkpoint-retained-source";
import type { InboxCheckpointProjectionInput } from "./inbox-checkpoint-source";
import {
  type InboxCheckpointFact,
  projectInboxCheckpointSource,
} from "./inbox-checkpoint-source";
import { deriveProjectRunCheckpoints } from "./project-run-checkpoints";

type CheckpointTarget = InboxCheckpointProjectionInput["target"];
const targetSchema = projectCheckpointReviewBindingSchema.omit({
  catalogRevision: true,
  scopeHash: true,
});
const unavailable =
  "Checkpoint sources could not be verified. Refresh before another attempt.";
const envelopeSchema = z
  .object({ ok: z.boolean(), data: z.unknown(), error: z.string().nullable() })
  .strict();
/** Fixed protected routes; domain verification belongs to the source owner. */
export function createInboxCheckpointReads(
  projectIdInput: string,
  reader: OperatorRead = operatorRead,
) {
  const projectId =
      projectCheckpointReviewBindingSchema.shape.projectId.parse(
        projectIdInput,
      ),
    root = "/__agent-forge/projects/" + encodeURIComponent(projectId);
  const read = async (
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (signal.aborted) throw Error(unavailable);
    const response = await reader(
      path,
      { method: "GET", signal },
      { maxBodyBytes: maxBytes },
    );
    const stream = response.body?.getReader();
    if (!stream) throw Error(unavailable);
    let cancellation: Promise<void> | null = null;
    const cancel = () => {
      if (cancellation === null)
        cancellation = Promise.resolve()
          .then(() => stream.cancel())
          .then(
            () => {},
            () => {
              /* The body may already be closed. */
            },
          );
      return cancellation;
    };
    const abort = () => {
      void cancel();
    };
    signal.addEventListener("abort", abort, { once: true });
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      if (signal.aborted) throw Error(unavailable);
      for (;;) {
        const part = await stream.read();
        if (signal.aborted) throw Error(unavailable);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw Error(unavailable);
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw Error(unavailable);
      }
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 3
      )
        throw Error(unavailable);
      const envelope = envelopeSchema.parse(raw);
      if (!response.ok || !envelope.ok || envelope.error !== null)
        throw Error(unavailable);
      return envelope.data;
    } catch {
      await cancel();
      throw Error(unavailable);
    } finally {
      signal.removeEventListener("abort", abort);
      stream.releaseLock();
    }
  };
  return {
    runs: async (signal: AbortSignal) =>
      read(root + "/runs", MAX_PROJECT_RUN_BYTES + 1024, signal),
    beads: async (signal: AbortSignal) =>
      read(root + "/beads", 4 * 1024 * 1024, signal),
    detail: async (slugInput: string, signal: AbortSignal) => {
      const slug =
        projectCheckpointReviewBindingSchema.shape.runSlug.parse(slugInput);
      return read(
        root + "/runs/" + encodeURIComponent(slug),
        MAX_PROJECT_RUN_BYTES + 1024,
        signal,
      );
    },
    association: async (targetInput: CheckpointTarget, signal: AbortSignal) => {
      const target = targetSchema.parse(targetInput);
      if (target.projectId !== projectId) throw Error(unavailable);
      return read(
        root +
          "/runs/" +
          encodeURIComponent(target.runSlug) +
          "/checkpoints/" +
          encodeURIComponent(target.beadId) +
          "/source-review-context",
        CHECKPOINT_INBOX_CONTEXT_MAX_BYTES,
        signal,
      );
    },
    retained: async (signal: AbortSignal) =>
      read(
        root + "/checkpoint-reviews",
        CHECKPOINT_REVIEW_INVENTORY_MAX_BYTES,
        signal,
      ),
  };
}
export type InboxCheckpointReads = ReturnType<
  typeof createInboxCheckpointReads
>;

const contextSchema = z
  .object({
    projectId: projectCheckpointReviewBindingSchema.shape.projectId,
    workspace: projectCheckpointReviewBindingSchema.shape.workspacePath,
    catalogRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    archived: z.boolean(),
    active: z.boolean(),
  })
  .strict();
export type InboxCheckpointContext = z.infer<typeof contextSchema>;
type Coverage = InboxSourceRead<unknown>["coverage"];
type PublicationState = {
  facts: readonly InboxCheckpointFact[];
  coverage: Coverage & { applicable: boolean };
};
type PublicationBundle = {
  context: InboxCheckpointContext;
  page: ProjectRunsPage;
  beads: ProjectBeadsPage;
  details: readonly ProjectRunDetail[];
  associations: readonly ProjectCheckpointInboxContextRead[];
  facts: readonly InboxCheckpointFact[];
};
export interface InboxCheckpointView {
  context: InboxCheckpointContext | null;
  generation: number;
  active: boolean;
  loading: boolean;
  publications: PublicationState;
  retained: InboxRetainedCheckpointProjection | null;
  facts: readonly (InboxCheckpointFact | InboxRetainedCheckpointFact)[];
  complete: boolean;
  diagnostics: readonly string[];
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sameScope = (a: InboxCheckpointContext, b: InboxCheckpointContext) =>
  a.projectId === b.projectId &&
  workspaceKey(a.workspace) === workspaceKey(b.workspace);
const pendingCoverage = (started = false): Coverage => ({
  started,
  settled: false,
  complete: false,
  fresh: false,
  error: unavailable,
});
const freshCoverage = (): Coverage => ({
  started: true,
  settled: true,
  complete: true,
  fresh: true,
  error: null,
});
const staleFacts = <T extends { fresh: boolean; complete: boolean }>(
  facts: readonly T[],
): T[] => facts.map((fact) => ({ ...fact, fresh: false, complete: false }));
async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function readPool() {
  type Entry = {
    signal: AbortSignal;
    running: boolean;
    cancelled: boolean;
    start(): void;
    cancel(): void;
  };
  const queue: Entry[] = [],
    waiters = new Set<() => void>();
  let active = 0;
  const notify = () => {
    if (active === 0 && queue.length === 0) {
      for (const done of waiters) done();
      waiters.clear();
    }
  };
  const pump = () => {
    while (active < 4 && queue.length) {
      const entry = queue.shift();
      if (!entry) break;
      if (entry.signal.aborted) entry.cancel();
      else entry.start();
    }
    notify();
  };
  return {
    run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          reject(Error(unavailable));
          return;
        }
        const entry: Entry = {
          signal,
          running: false,
          cancelled: false,
          start() {
            if (entry.cancelled) return;
            entry.running = true;
            active++;
            Promise.resolve()
              .then(() => {
                if (signal.aborted) throw Error(unavailable);
                return work();
              })
              .then(resolve, reject)
              .finally(() => {
                active--;
                signal.removeEventListener("abort", entry.cancel);
                pump();
              });
          },
          cancel() {
            if (entry.running || entry.cancelled) return;
            entry.cancelled = true;
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            signal.removeEventListener("abort", entry.cancel);
            reject(Error(unavailable));
            pump();
          },
        };
        queue.push(entry);
        signal.addEventListener("abort", entry.cancel, { once: true });
        if (signal.aborted) entry.cancel();
        else pump();
      });
    },
    drain: () =>
      active === 0 && queue.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.add(resolve)),
  };
}
/** Read-only scoped owner. Catalog context is supplied by the independently current app catalog. */
export function createInboxCheckpointClient(
  initial: InboxCheckpointContext | null = null,
  deps: { reads?: (projectId: string) => InboxCheckpointReads } = {},
) {
  const parseContext = (value: unknown) => {
    const parsed = contextSchema.safeParse(value);
    return parsed.success ? freeze(structuredClone(parsed.data)) : null;
  };
  let context = parseContext(initial),
    generation = 0,
    disposed = false,
    loading = false,
    abort: AbortController | null = null;
  let cachedPublications: PublicationBundle | null = null,
    cachedRetained: {
      context: InboxCheckpointContext;
      value: InboxRetainedCheckpointProjection;
    } | null = null;
  let publications: PublicationState = {
      facts: [],
      coverage: { ...pendingCoverage(), applicable: true },
    },
    retained: InboxRetainedCheckpointProjection | null = null;
  const listeners = new Set<() => void>(),
    pending = new Set<Promise<void>>(),
    pool = readPool();
  let view: InboxCheckpointView;
  const oldPublications = (scope: InboxCheckpointContext | null) =>
    scope && cachedPublications && sameScope(scope, cachedPublications.context)
      ? cachedPublications.facts
      : scope === null
        ? publications.facts
        : [];
  const oldRetained = (scope: InboxCheckpointContext | null) =>
    scope && cachedRetained && sameScope(scope, cachedRetained.context)
      ? cachedRetained.value
      : scope === null
        ? retained
        : null;
  function publish(notify = true) {
    const diagnostics = [
      ...(publications.coverage.error ? [publications.coverage.error] : []),
      ...(retained?.diagnostics ?? []),
    ];
    const both =
      publications.coverage.fresh &&
      publications.coverage.complete &&
      retained?.coverage.fresh === true &&
      retained.coverage.complete;
    const folded = new Set<string>();
    let contradiction = false;
    if (both && retained) {
      const key = (
        row: InboxRetainedCheckpointFact["sourceIdentity"]["originalRead"],
      ) =>
        JSON.stringify([
          row.original.requestId,
          row.original.intentHash,
          row.original.binding,
        ]);
      const observed = new Map<string, Set<string>>();
      for (const publication of publications.facts)
        for (const row of publication.sourceIdentity.records) {
          const id = key(row),
            values = observed.get(id) ?? new Set<string>();
          values.add(JSON.stringify(row));
          observed.set(id, values);
        }
      for (const fact of retained.facts) {
        const saved = fact.sourceIdentity.originalRead,
          values = observed.get(key(saved));
        if (values) {
          if (values.size === 1 && values.has(JSON.stringify(saved)))
            folded.add(fact.stableItemId);
          else contradiction = true;
        }
      }
    }
    if (contradiction) {
      folded.clear();
      diagnostics.push(
        "Checkpoint reads observed different saved receipts. Refresh before acting.",
      );
    }
    const facts = [
      ...publications.facts,
      ...(retained?.facts.filter((fact) => !folded.has(fact.stableItemId)) ??
        []),
    ];
    view = freeze({
      context,
      generation,
      active: !!context?.active && !disposed,
      loading,
      publications,
      retained,
      facts,
      complete:
        !!context?.active && !disposed && !loading && both && !contradiction,
      diagnostics: [...new Set(diagnostics)],
    });
    if (!notify) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A subscriber does not own source lifetime. */
      }
    }
  }
  type Frame = {
    own: number;
    scope: InboxCheckpointContext | null;
    controller: AbortController | null;
  };
  const isCurrent = (frame: Frame) =>
    generation === frame.own &&
    context === frame.scope &&
    abort === frame.controller;
  function revoke(started = false): Frame {
    const previousAbort = abort,
      own = ++generation,
      scope = context;
    const controller =
      started && scope?.active && !disposed ? new AbortController() : null;
    abort = controller;
    loading = started && !!scope?.active && !disposed;
    const previous = oldRetained(scope);
    publications = {
      facts: scope?.archived ? [] : staleFacts(oldPublications(scope)),
      coverage: {
        ...pendingCoverage(started),
        applicable: scope?.archived !== true,
      },
    };
    retained = previous
      ? {
          ...previous,
          facts: staleFacts(previous.facts),
          coverage: pendingCoverage(started),
          diagnostics: [unavailable],
        }
      : scope
        ? {
            scope: { projectId: scope.projectId, workspace: scope.workspace },
            sourceGeneration: own,
            catalogRevision: scope.catalogRevision,
            facts: [],
            history: [],
            snapshot: null,
            coverage: pendingCoverage(started),
            diagnostics: [unavailable],
          }
        : null;
    if (started && scope?.active && scope.archived)
      publications = {
        facts: [],
        coverage: { ...freshCoverage(), applicable: false },
      };
    // Make revocation readable before AbortSignal listeners can inspect or re-enter.
    publish(false);
    previousAbort?.abort();
    return { own, scope, controller };
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    const frame = revoke(true);
    if (!isCurrent(frame)) return Promise.resolve();
    publish();
    const { own, scope, controller } = frame;
    if (!isCurrent(frame) || !scope?.active || !controller)
      return Promise.resolve();
    const owns = () =>
      !disposed && isCurrent(frame) && !controller.signal.aborted;
    let reads: InboxCheckpointReads;
    try {
      reads = (deps.reads ?? createInboxCheckpointReads)(scope.projectId);
    } catch {
      if (owns()) {
        loading = false;
        publications = {
          ...publications,
          coverage: { ...publications.coverage, settled: true },
        };
        if (retained)
          retained = {
            ...retained,
            coverage: { ...retained.coverage, settled: true },
          };
        publish();
      }
      return Promise.resolve();
    }
    const currentController = new AbortController(),
      currentSignal = AbortSignal.any([
        controller.signal,
        currentController.signal,
      ]);
    let currentBytes = 0;
    const guard = (signal = controller.signal) => {
      if (!owns() || signal.aborted) throw Error(unavailable);
    };
    const read = <T>(
      work: (signal: AbortSignal) => Promise<unknown>,
      schema: { parse(value: unknown): T },
      signal: AbortSignal,
      family: "current" | "retained",
    ) =>
      pool.run(signal, async () => {
        const raw = await work(signal);
        guard(signal);
        const bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
        if (family === "current") {
          currentBytes += bytes;
          if (currentBytes > 16 * 1024 * 1024) {
            currentController.abort();
            throw Error(unavailable);
          }
        } else if (bytes > CHECKPOINT_REVIEW_INVENTORY_MAX_BYTES)
          throw Error(unavailable);
        const parsed = freeze(structuredClone(schema.parse(raw))),
          capturedBytes = new TextEncoder().encode(
            JSON.stringify(parsed),
          ).byteLength;
        if (family === "current") {
          currentBytes += Math.max(0, capturedBytes - bytes);
          if (currentBytes > 16 * 1024 * 1024) {
            currentController.abort();
            throw Error(unavailable);
          }
        } else if (capturedBytes > CHECKPOINT_REVIEW_INVENTORY_MAX_BYTES)
          throw Error(unavailable);
        return parsed;
      });
    const scopeMatches = (value: { projectId: string; workspace: string }) =>
      value.projectId === scope.projectId &&
      workspaceKey(value.workspace) === workspaceKey(scope.workspace);
    const runFingerprint = (page: ProjectRunsPage) => {
      const { asOf: _asOf, ...rest } = page;
      return JSON.stringify(rest);
    };
    const beadFingerprint = (page: ProjectBeadsPage) =>
      JSON.stringify([
        page.projectId,
        page.workspace,
        page.complete,
        page.problems,
        page.beads.map((bead) => [
          bead.id,
          bead.type,
          bead.status,
          bead.parent,
        ]),
        page.dependencies,
      ]);
    const current = async () => {
      if (scope.archived) return;
      try {
        const [page, beads] = await Promise.all([
          read(reads.runs, projectRunsPageSchema, currentSignal, "current"),
          read(reads.beads, projectBeadsPageSchema, currentSignal, "current"),
        ]);
        guard(currentSignal);
        if (
          !scopeMatches(page) ||
          !scopeMatches(beads) ||
          page.problems.length ||
          !beads.complete ||
          beads.problems.length ||
          new Set(beads.beads.map((bead) => bead.id)).size !==
            beads.beads.length ||
          page.runs.length > 128
        )
          throw Error(unavailable);
        const details = await Promise.all(
          page.runs.map((run) =>
            read(
              (signal) => reads.detail(run.slug, signal),
              projectRunDetailSchema,
              currentSignal,
              "current",
            ),
          ),
        );
        guard(currentSignal);
        const targets: CheckpointTarget[] = [];
        if (
          new Set(details.map((detail) => detail.run.slug)).size !==
          page.runs.length
        )
          throw Error(unavailable);
        for (const [index, detail] of details.entries()) {
          const listed = page.runs[index];
          if (
            !listed ||
            listed.slug !== detail.run.slug ||
            !scopeMatches(detail) ||
            detail.checkout !== page.checkout ||
            detail.workspace !== page.workspace ||
            detail.problems.length ||
            JSON.stringify(listed) !== JSON.stringify(detail.run)
          )
            throw Error(unavailable);
          const checkpoints = deriveProjectRunCheckpoints({
            projectId: scope.projectId,
            workspace: page.workspace,
            runs: {
              page,
              loading: false,
              error: "",
              selectedSlug: detail.run.slug,
              detail,
              detailLoading: false,
              detailError: "",
              detailStale: false,
            },
            beads: { page: beads, loading: false, error: null },
          });
          if (checkpoints.kind === "no-epic") continue;
          if (checkpoints.kind !== "ready") throw Error(unavailable);
          for (const beadId of checkpoints.summary.inProgressIds) {
            if (detail.run.updatedAt === null) throw Error(unavailable);
            targets.push(
              targetSchema.parse({
                projectId: scope.projectId,
                workspacePath: detail.workspace,
                checkout: detail.checkout,
                runSlug: detail.run.slug,
                epicId: checkpoints.epicId,
                beadId,
                runUpdatedAt: detail.run.updatedAt,
              }),
            );
            if (targets.length > 256) throw Error(unavailable);
          }
        }
        const associations = await Promise.all(
          targets.map((target) =>
            read(
              (signal) => reads.association(target, signal),
              projectCheckpointInboxContextReadSchema,
              currentSignal,
              "current",
            ),
          ),
        );
        guard(currentSignal);
        const facts: InboxCheckpointFact[] = [];
        for (const [index, target] of targets.entries()) {
          const data = associations[index];
          if (!data?.available) throw Error(unavailable);
          const {
            catalogRevision,
            scopeHash: _hash,
            ...location
          } = data.context.baseBinding;
          if (
            catalogRevision !== scope.catalogRevision ||
            JSON.stringify(location) !== JSON.stringify(target)
          )
            throw Error(unavailable);
          if (data.context.record) {
            const record = data.context.record;
            const originalHash = await sha256(
              projectCheckpointSubmissionOriginalJson(record.original),
            );
            guard(currentSignal);
            if (originalHash !== record.originalHash) throw Error(unavailable);
            const derived = await sha256(
              JSON.stringify({
                family: "checkpoint-source-submission",
                originalHash,
                schemaVersion: 1,
              }),
            );
            guard(currentSignal);
            if (record.receipt.reviewScopeHash !== derived)
              throw Error(unavailable);
          }
          const projected = await projectInboxCheckpointSource({
            scope: { projectId: scope.projectId, workspace: scope.workspace },
            target,
            sourceGeneration: own,
            catalogRevision: scope.catalogRevision,
            association: {
              raw: data,
              lastVerified: null,
              coverage: freshCoverage(),
            },
          });
          guard(currentSignal);
          if (
            projected.status === "unverified" ||
            (data.context.state === "current" && !projected.coverage.fresh)
          )
            throw Error(unavailable);
          facts.push(...projected.facts);
        }
        const [afterRuns, afterBeads] = await Promise.all([
          read(reads.runs, projectRunsPageSchema, currentSignal, "current"),
          read(reads.beads, projectBeadsPageSchema, currentSignal, "current"),
        ]);
        guard(currentSignal);
        if (
          runFingerprint(afterRuns) !== runFingerprint(page) ||
          beadFingerprint(afterBeads) !== beadFingerprint(beads)
        )
          throw Error(unavailable);
        cachedPublications = freeze({
          context: scope,
          page,
          beads,
          details,
          associations,
          facts,
        });
        publications = {
          facts,
          coverage: { ...freshCoverage(), applicable: true },
        };
        publish();
      } catch {
        currentController.abort();
        if (!owns()) return;
        publications = {
          facts: staleFacts(oldPublications(scope)),
          coverage: {
            ...pendingCoverage(true),
            settled: true,
            applicable: true,
          },
        };
        publish();
      }
    };
    const saved = async () => {
      try {
        const data = await read(
          reads.retained,
          projectCheckpointReviewInventoryReadSchema,
          controller.signal,
          "retained",
        );
        guard();
        const prior = oldRetained(scope)?.snapshot ?? null;
        const result = await projectInboxRetainedCheckpointSources({
          scope: { projectId: scope.projectId, workspace: scope.workspace },
          sourceGeneration: own,
          catalogRevision: scope.catalogRevision,
          inventory: {
            raw: data,
            lastVerified: prior,
            coverage: freshCoverage(),
          },
        });
        guard();
        const previous = oldRetained(scope);
        retained =
          !result.coverage.fresh && previous
            ? {
                ...previous,
                facts: staleFacts(previous.facts),
                coverage: { ...pendingCoverage(true), settled: true },
                diagnostics: [unavailable],
              }
            : result;
        if (result.coverage.fresh)
          cachedRetained = { context: scope, value: result };
        publish();
      } catch {
        if (!owns()) return;
        const previous = oldRetained(scope);
        retained = previous
          ? {
              ...previous,
              facts: staleFacts(previous.facts),
              coverage: { ...pendingCoverage(true), settled: true },
              diagnostics: [unavailable],
            }
          : {
              scope: { projectId: scope.projectId, workspace: scope.workspace },
              sourceGeneration: own,
              catalogRevision: scope.catalogRevision,
              facts: [],
              history: [],
              snapshot: null,
              coverage: { ...pendingCoverage(true), settled: true },
              diagnostics: [unavailable],
            };
        publish();
      }
    };
    const task = (async () => {
      await Promise.allSettled([current(), saved()]);
      if (owns()) {
        loading = false;
        publish();
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  }
  function setContext(next: unknown) {
    if (disposed) return;
    context = parseContext(next);
    loading = false;
    revoke();
    publish();
  }
  function invalidate() {
    if (disposed) return;
    loading = false;
    revoke();
    publish();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    loading = false;
    revoke();
    publish();
    listeners.clear();
  }
  revoke();
  publish();
  return {
    get: () => view,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setContext,
    refresh,
    invalidate,
    dispose,
    async close() {
      dispose();
      await Promise.allSettled([...pending]);
      await pool.drain();
    },
  };
}
