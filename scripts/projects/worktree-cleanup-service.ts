import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { WorktreeRecord } from "../../types/beads";
import { comparableCheckout } from "../forge/runs";
import type { ActionContext } from "../hearth/api";
import { readHomeFile } from "../hearth/home-guard";
import type { ReadDeps } from "../hearth/routes/operator-reads";
import { projectSnapshotReader } from "../hearth/routes/project-summaries";
import { QUEUE_LOCK_FILE } from "../hearth/routes/queue";
import { writeOwnerOnly } from "../hearth/token";
import { validateLedgerEvent } from "../hearth/validate";
import { queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { nativePhysicalPath } from "../native-realpath";
import { withQueueLock } from "../scheduler/queue-lock";
import { withWorktreeRegistryLock } from "../scheduler/worktree-registry-lock";
import {
  type GitRun,
  gitRun,
  readStrictWorktreeRegistry,
  registryPathKey,
  removeWorktree,
} from "../scheduler/worktrees";
import { withProjectAdmission } from "./admission";
import { createProjectStore, isProjectId, ProjectStoreError } from "./store";
import { readWorktreeCleanupPreflight } from "./worktree-cleanup-preflight";
import {
  type CleanupReceipt,
  type CleanupRequest,
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "./worktree-cleanup-protocol";
import {
  type CleanupRow,
  readWorktreeCleanupInventory,
  withWorktreeCleanupLease,
} from "./worktree-cleanup-store";

export interface CleanupServiceHost {
  home: string;
  root: string;
  queueLockFile: string;
  ledgerPath: string;
  runBd: ReadDeps["runBd"];
  completeTracker?: ReadDeps["completeTracker"];
}
function receipt(row: CleanupRow): CleanupReceipt {
  const original = row.original;
  const state =
    row.phase === "confirmed" || row.phase === "refused"
      ? row.phase
      : "unknown";
  return cleanupReceiptSchema.parse({
    ...original.request,
    projectId: original.projectId,
    requestHash: original.requestHash,
    state,
    reason:
      state === "confirmed"
        ? null
        : (row.reason ??
          "Cleanup is not confirmed. Read this original before new work."),
    attemptedAt: row.attemptedAt,
    endedAt: row.endedAt,
    audit: original.audit,
  });
}

function sameRecord(
  value: WorktreeRecord | undefined,
  expected: CleanupRequest["expectedRecord"],
) {
  return (
    value !== undefined &&
    value.ownerSessionId === undefined &&
    (["id", "path", "branch", "createdAt", "beadId"] as const).every(
      (key) => value[key] === expected[key],
    )
  );
}
function sameTarget(left: CleanupRequest, right: CleanupRequest) {
  return (
    registryPathKey(left.repository) === registryPathKey(right.repository) &&
    (left.expectedRecord.id === right.expectedRecord.id ||
      registryPathKey(left.expectedRecord.path) ===
        registryPathKey(right.expectedRecord.path))
  );
}

/** Host-only owner; recovery reads never admit work or dispatch an effect. */
export function createProjectWorktreeCleanupService(
  options: CleanupServiceHost,
  controls: { git?: GitRun; persistJournal?: typeof writeOwnerOnly } = {},
) {
  const runtime = Object.freeze({
    git: controls.git ?? gitRun,
    persistJournal: controls.persistJournal ?? writeOwnerOnly,
  });

  const host = Object.freeze({
    home: options.home,
    root: options.root,
    queueLockFile: options.queueLockFile,
    ledgerPath: options.ledgerPath,
    runBd: options.runBd,
    completeTracker: options.completeTracker,
  });
  let servedRoot: string;
  try {
    for (const path of [host.home, host.root]) {
      const info = lstatSync(path);
      if (
        !isAbsolute(path) ||
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        registryPathKey(nativePhysicalPath(path)) !== registryPathKey(path)
      )
        throw Error("Noncanonical cleanup host");
    }
    servedRoot = nativePhysicalPath(host.root);
    if (
      readHomeFile(host.home).problem !== null ||
      typeof host.runBd !== "function" ||
      !isAbsolute(host.queueLockFile) ||
      !isAbsolute(host.ledgerPath) ||
      registryPathKey(host.queueLockFile) !==
        registryPathKey(join(host.home, QUEUE_LOCK_FILE)) ||
      registryPathKey(host.ledgerPath) !==
        registryPathKey(join(host.home, "ledger.db")) ||
      registryPathKey(
        nativePhysicalPath(resolveCheckout(host.root).workspace),
      ) !== registryPathKey(servedRoot)
    )
      throw Error("Mismatched cleanup host authority");
  } catch {
    throw new ProjectStoreError(
      503,
      "The protected cleanup host authority could not be verified.",
    );
  }
  const load = projectSnapshotReader(
    host.home,
    {
      root: servedRoot,
      workspace: servedRoot,
      ledgerPath: host.ledgerPath,
      runBd: host.runBd,
      completeTracker: host.completeTracker,
    },
    { membershipOnly: true, includeEmpty: true, omitRuns: true },
  );
  const member = (path: string) => {
    try {
      return (
        isAbsolute(path) &&
        registryPathKey(path) === registryPathKey(servedRoot) &&
        registryPathKey(nativePhysicalPath(path)) ===
          registryPathKey(servedRoot)
      );
    } catch {
      return false;
    }
  };
  const auditFor = (
    id: number,
    projectId: string,
    request: CleanupRequest,
    hash: string,
  ) => {
    const event = queryEvents(
      { afterId: id - 1, limit: 1 },
      { path: host.ledgerPath },
    )[0];
    if (
      !event ||
      !validateLedgerEvent(event).ok ||
      event.id !== id ||
      event.kind !== "operator.action" ||
      event.workspace !== comparableCheckout(servedRoot) ||
      event.beadId !== request.expectedRecord.beadId ||
      event.runId !== undefined ||
      event.sessionId !== undefined ||
      event.executor !== undefined ||
      event.payload.action !== "project.worktree.cleanup" ||
      event.payload.family !== "project-worktree-cleanup" ||
      event.payload.target !== projectId ||
      event.payload.requestId !== request.requestId ||
      event.payload.inputHash !== hash ||
      Object.keys(event.payload).some(
        (key) =>
          ![
            "action",
            "surface",
            "target",
            "family",
            "requestId",
            "inputHash",
          ].includes(key),
      )
    )
      throw new ProjectStoreError(
        409,
        "The stored operator audit does not match this cleanup original.",
      );
    return cleanupReceiptSchema.shape.audit.parse({
      eventId: event.id,
      ulid: event.ulid,
      ts: event.ts,
    });
  };
  const service = {
    read(
      projectId: string,
      requestId: string,
      requestHash: string,
    ): CleanupReceipt {
      if (
        !isProjectId(projectId) ||
        !cleanupRequestSchema.shape.requestId.safeParse(requestId).success ||
        typeof requestHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(requestHash)
      )
        throw new ProjectStoreError(
          400,
          "Expected the exact cleanup project, UUID and request hash.",
        );
      let rows: CleanupRow[];
      try {
        rows = readWorktreeCleanupInventory(host.home);
      } catch {
        throw new ProjectStoreError(
          503,
          "The complete saved cleanup history is unavailable.",
        );
      }
      const saved = rows.find(
        (row) => row.original.request.requestId === requestId,
      );
      if (!saved)
        throw new ProjectStoreError(
          404,
          "This cleanup original was not found.",
        );
      if (
        saved.original.projectId !== projectId ||
        saved.original.requestHash !== requestHash ||
        registryPathKey(saved.original.request.repository) !==
          registryPathKey(servedRoot)
      )
        throw new ProjectStoreError(
          409,
          "This UUID belongs to a different cleanup original or served repository.",
        );
      try {
        return receipt(saved);
      } catch {
        throw new ProjectStoreError(
          503,
          "The saved cleanup receipt could not be verified.",
        );
      }
    },
    async cleanup(
      projectId: string,
      raw: unknown,
      context: Readonly<ActionContext>,
    ): Promise<CleanupReceipt> {
      const captured = Object.freeze({ auditEventId: context?.auditEventId });
      const parsed = cleanupRequestSchema.safeParse(raw);
      if (!isProjectId(projectId) || !parsed.success)
        throw new ProjectStoreError(
          400,
          "Expected a complete reviewed cleanup request.",
        );
      const request = Object.freeze({
        ...parsed.data,
        expectedRecord: Object.freeze(parsed.data.expectedRecord),
      });
      if (
        !isAbsolute(request.repository) ||
        !isAbsolute(request.expectedRecord.path)
      )
        throw new ProjectStoreError(
          400,
          "Expected absolute repository and target paths.",
        );
      if (registryPathKey(request.repository) !== registryPathKey(servedRoot))
        throw new ProjectStoreError(
          409,
          "This cleanup review belongs to another served repository.",
        );
      if (
        registryPathKey(request.expectedRecord.path) !==
        registryPathKey(join(servedRoot, "trees", request.expectedRecord.id))
      )
        throw new ProjectStoreError(
          400,
          "Expected the native managed target path for this review.",
        );
      const hash = createHash("sha256")
        .update(canonicalCleanupRequest(projectId, request))
        .digest("hex");
      const progress: { publication: "none" | "possible" } = {
        publication: "none",
      };
      try {
        return await withWorktreeCleanupLease(
          host.home,
          async (scope) => {
            const rows = scope.read();
            const existing = rows.find(
              (row) => row.original.request.requestId === request.requestId,
            );
            if (existing) {
              if (
                existing.original.projectId !== projectId ||
                existing.original.requestHash !== hash
              )
                throw new ProjectStoreError(
                  409,
                  "This cleanup UUID already names another original.",
                );
              return receipt(existing);
            }
            if (
              rows.some(
                (row) =>
                  row.phase !== "confirmed" &&
                  row.phase !== "refused" &&
                  sameTarget(row.original.request, request),
              )
            )
              throw new ProjectStoreError(
                409,
                "Unresolved cleanup ownership retains this target.",
              );
            const id = captured.auditEventId;
            if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
              throw new ProjectStoreError(
                400,
                "A stored operator audit locator is required.",
              );
            return await withProjectAdmission(
              host.home,
              projectId,
              async () => {
                const catalog = createProjectStore(host.home).read();
                const project = catalog.projects.find(
                  (row) => row.id === projectId,
                );
                if (
                  !project ||
                  catalog.revision !== request.expectedCatalogRevision ||
                  !project.workspaces.some(
                    (workspace) =>
                      member(workspace.root) &&
                      workspace.repositories.some(member),
                  )
                )
                  throw new ProjectStoreError(
                    409,
                    "The current native project scope or revision changed.",
                  );
                const queued = await withQueueLock(
                  host.queueLockFile,
                  async () => {
                    const proof = await readWorktreeCleanupPreflight(
                      {
                        home: host.home,
                        root: servedRoot,
                        projectId,
                        worktreeId: request.expectedRecord.id,
                      },
                      {
                        git: runtime.git,
                        readSources: async () => (await load()).source,
                      },
                    );
                    const eligible =
                      proof.state === "eligible" &&
                      "record" in proof &&
                      proof.catalogRevision ===
                        request.expectedCatalogRevision &&
                      proof.head === request.expectedHead &&
                      sameRecord(proof.record, request.expectedRecord);
                    const audit = auditFor(id, projectId, request, hash);
                    const at = new Date().toISOString();
                    const reserved: CleanupRow = {
                      original: {
                        version: 1,
                        projectId,
                        request,
                        requestHash: hash,
                        createdAt: at,
                        audit,
                      },
                      phase: eligible ? "reserved" : "refused",
                      attemptedAt: null,
                      endedAt: eligible ? null : at,
                      outcome: null,
                      reason: eligible
                        ? null
                        : "Cleanup is not eligible. No removal was started.",
                    };
                    progress.publication = "possible";
                    scope.write(reserved);
                    if (!eligible) return receipt(reserved);
                    const removal = withWorktreeRegistryLock<{
                      attempted: CleanupRow;
                      removed: ReturnType<typeof removeWorktree>;
                    }>(servedRoot, () => {
                      const current = readStrictWorktreeRegistry(servedRoot);
                      if (
                        !current.ok ||
                        !sameRecord(
                          current.value.find(
                            (row) => row.id === request.expectedRecord.id,
                          ),
                          request.expectedRecord,
                        )
                      )
                        return {
                          ok: false,
                          error: "The reviewed registry changed.",
                        };
                      const attempted: CleanupRow = {
                        ...reserved,
                        phase: "attempted",
                        attemptedAt: new Date().toISOString(),
                        reason: null,
                      };
                      scope.write(attempted);
                      return {
                        ok: true,
                        value: {
                          attempted,
                          removed: removeWorktree(
                            servedRoot,
                            request.expectedRecord.id,
                            {
                              force: false,
                              expectedRecord: request.expectedRecord,
                              expectedHead: request.expectedHead,
                            },
                            { git: runtime.git },
                          ),
                        },
                      };
                    });
                    if (!removal.ok) {
                      const refused: CleanupRow = {
                        ...reserved,
                        phase: "refused",
                        endedAt: new Date().toISOString(),
                        reason:
                          "Registry authority changed. No removal was started.",
                      };
                      scope.write(refused);
                      return receipt(refused);
                    }
                    const result = removal.value.removed;
                    const confirmed =
                      result.ok &&
                      sameRecord(result.value, request.expectedRecord);
                    const finished: CleanupRow = {
                      ...removal.value.attempted,
                      phase: confirmed ? "confirmed" : "unknown",
                      endedAt: confirmed ? new Date().toISOString() : null,
                      reason: confirmed
                        ? null
                        : "Cleanup was attempted but its exact outcome is unconfirmed.",
                      outcome: confirmed ? "reviewed-remove-returned-ok" : null,
                    };
                    scope.write(finished);
                    return receipt(finished);
                  },
                  { waitMs: 1000 },
                );
                if (!queued.ok)
                  throw new ProjectStoreError(
                    503,
                    "The shared queue authority is busy.",
                  );
                return queued.value;
              },
            );
          },
          { persistJournal: runtime.persistJournal },
        );
      } catch (error) {
        try {
          return service.read(projectId, request.requestId, hash);
        } catch {
          if (
            progress.publication === "none" &&
            error instanceof ProjectStoreError
          )
            throw error;
          throw new ProjectStoreError(
            503,
            "The original cleanup outcome is unavailable. Read the saved original; never replay an unknown attempt.",
          );
        }
      }
    },
  };
  return Object.freeze(service);
}
