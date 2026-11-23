import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import {
  CHECKPOINT_REVIEW_INVENTORY_MAX_RECORDS,
  CHECKPOINT_REVIEW_INVENTORY_UNAVAILABLE,
  type ProjectCheckpointReviewInventoryRead,
  projectCheckpointReviewInventoryJson,
  projectCheckpointReviewInventoryReadSchema,
  projectCheckpointReviewInventoryScopeSchema,
} from "../../types/project-checkpoint-review-inventory";
import {
  PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES,
  projectCheckpointReviewOriginalReadSchema,
} from "../../types/project-checkpoint-reviews";
import { readHomeFile, readHomeFileBounded } from "../hearth/home-guard";
import { workspaceKey } from "../projects/scope";
import { readProjectCheckpointReviewInventory } from "./project-checkpoint-review-store";

const FAMILY = "checkpoint-reviews",
  ANCHORS = "checkpoint-review-anchors";
const MAX_FAMILIES = 64,
  MAX_ANCHORS = 64,
  MAX_JOURNAL_BYTES = 8 * 1024 * 1024,
  MAX_ANCHOR_BYTES = 1024 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Stable observed retained Review records only; not an atomic or publication inventory. */
export async function readProjectCheckpointReviewDiscovery(options: {
  home: string;
  workspacePath: string;
  projectId: string;
  now?: () => number;
  afterFirstCollection?: () => void | Promise<void>;
}): Promise<ProjectCheckpointReviewInventoryRead> {
  const home = options.home,
    scopeInput = {
      projectId: options.projectId,
      workspacePath: options.workspacePath,
    },
    now = options.now ?? (() => performance.now()),
    afterFirstCollection = options.afterFirstCollection;
  try {
    const scope = projectCheckpointReviewInventoryScopeSchema.parse(scopeInput),
      started = now();
    let inspected = 0;
    const budget = (entries = 0) => {
      inspected += entries;
      const elapsed = now() - started;
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > 2000 ||
        inspected > 4096
      )
        throw Error("Observation budget exceeded");
    };
    budget();
    if (readHomeFile(home).problem !== null)
      throw Error("Untrusted private home");
    const collect = () => {
      let journalBytes = 0,
        anchorBytes = 0;
      const manifest: {
        family: string;
        name: string;
        bytes: number;
        hash: string | null;
      }[] = [];
      const scan = (family: string, anchor: boolean) => {
        budget();
        const directory = join(home, family);
        if (readHomeFile(directory).problem !== null)
          throw Error("Untrusted private directory");
        try {
          const stat = lstatSync(directory);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw Error("Invalid directory");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
        const names: string[] = [],
          iterator = opendirSync(directory);
        try {
          for (
            let entry = iterator.readSync();
            entry !== null;
            entry = iterator.readSync()
          ) {
            budget(1);
            if (
              entry.isSymbolicLink() ||
              !entry.isFile() ||
              !(anchor
                ? /^[a-f0-9]{64}\.json$/.test(entry.name)
                : /^[a-f0-9]{64}\.(json|lock\.db(?:-(?:journal|wal|shm))?)$/.test(
                    entry.name,
                  ))
            )
              throw Error("Unexpected private entry");
            names.push(entry.name);
          }
        } finally {
          iterator.closeSync();
        }
        const files: string[] = [];
        for (const name of names.sort()) {
          budget();
          const file = join(directory, name),
            stat = lstatSync(file);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
            throw Error("Linked or invalid private entry");
          if (!name.endsWith(".json")) {
            manifest.push({ family, name, bytes: 0, hash: null });
            continue;
          }
          files.push(file);
          if (files.length > (anchor ? MAX_ANCHORS : MAX_FAMILIES))
            throw Error("Family count exceeded");
          const limit = anchor
            ? 16 * 1024
            : PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES;
          if (stat.size > limit) throw Error("Private file limit exceeded");
          if (anchor) {
            anchorBytes += stat.size;
            if (anchorBytes > MAX_ANCHOR_BYTES)
              throw Error("Anchor set exceeded");
          } else {
            journalBytes += stat.size;
            if (journalBytes > MAX_JOURNAL_BYTES)
              throw Error("Journal set exceeded");
          }
          const read = readHomeFileBounded(home, file, limit);
          if (read.problem !== null || read.text === null)
            throw Error("Private file unavailable");
          const actualBytes = Buffer.byteLength(read.text, "utf8");
          if (anchor) {
            anchorBytes += actualBytes - stat.size;
            if (anchorBytes > MAX_ANCHOR_BYTES) throw Error("Anchor set grew");
          } else {
            journalBytes += actualBytes - stat.size;
            if (journalBytes > MAX_JOURNAL_BYTES)
              throw Error("Journal set grew");
          }
          manifest.push({
            family,
            name,
            bytes: actualBytes,
            hash: hash(read.text),
          });
        }
        return files;
      };
      const files = scan(FAMILY, false);
      scan(ANCHORS, true);
      budget();
      // The existing synchronous decoder checks all anchors and journals. Its inner work is not interruptible.
      const stored = readProjectCheckpointReviewInventory(
        home,
        files,
        scope.projectId,
      );
      budget();
      const matching = stored.filter(
        (row) =>
          workspaceKey(row.original.binding.workspacePath) ===
          workspaceKey(scope.workspacePath),
      );
      if (matching.length > CHECKPOINT_REVIEW_INVENTORY_MAX_RECORDS)
        throw Error("Record set exceeded");
      const records = matching.map((row) =>
        projectCheckpointReviewOriginalReadSchema.parse({
          original: row.original,
          receipt: row.receipt,
          metadata: {
            schemaVersion: 1,
            requestId: row.original.requestId,
            intentHash: row.original.intentHash,
            scope: row.scope,
            state: row.receipt.state,
            commentId: row.receipt.commentId,
            createdAt: row.original.createdAt,
            updatedAt: row.receipt.updatedAt,
          },
        }),
      );
      budget();
      return { manifest, records };
    };
    const first = collect();
    await afterFirstCollection?.();
    budget();
    const second = collect();
    // Equality detects observed changes; independent journal locks do not form a global atomic cut.
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw Error("Retained observation changed");
    const observationRevision = hash(
      projectCheckpointReviewInventoryJson(scope, second.records),
    );
    const result = projectCheckpointReviewInventoryReadSchema.parse({
      available: true,
      schemaVersion: 1,
      scope,
      coverage: "retained-review-records",
      records: second.records,
      observationRevision,
    });
    budget();
    return freeze(result);
  } catch {
    return freeze({
      available: false,
      error: CHECKPOINT_REVIEW_INVENTORY_UNAVAILABLE,
    });
  }
}
