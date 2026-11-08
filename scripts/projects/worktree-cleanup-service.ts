import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readHomeFile } from "../hearth/home-guard";
import type { ReadDeps } from "../hearth/routes/operator-reads";
import { QUEUE_LOCK_FILE } from "../hearth/routes/queue";
import { resolveCheckout } from "../ledger/workspace";
import { nativePhysicalPath } from "../native-realpath";
import { registryPathKey } from "../scheduler/worktrees";
import { isProjectId, ProjectStoreError } from "./store";
import {
  type CleanupReceipt,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "./worktree-cleanup-protocol";
import {
  type CleanupRow,
  readWorktreeCleanupInventory,
} from "./worktree-cleanup-store";

export interface CleanupServiceHost {
  home: string;
  root: string;
  queueLockFile: string;
  ledgerPath: string;
  runBd: ReadDeps["runBd"];
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

/** Host-only owner; recovery reads never admit work or dispatch an effect. */
export function createProjectWorktreeCleanupService(
  options: CleanupServiceHost,
) {
  const host = Object.freeze({
    home: options.home,
    root: options.root,
    queueLockFile: options.queueLockFile,
    ledgerPath: options.ledgerPath,
    runBd: options.runBd,
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
  return Object.freeze({
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
  });
}
