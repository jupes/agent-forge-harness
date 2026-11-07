import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { withQueueLock } from "../scheduler/queue-lock";
import { canonicalTrustedDirectory } from "../trusted-directory";
import { KNOWLEDGE_LIMITS } from "./knowledge-protocol";
import {
  captureKnowledgeFile,
  type KnowledgeFileSnapshot,
  type KnowledgeTarget,
  knowledgeDigest,
  verifyKnowledgeTarget,
} from "./knowledge-source";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const relative = (target: KnowledgeTarget) =>
  `knowledge/repos/${target.name}.yaml`;
const snapshot = (target: KnowledgeTarget) =>
  captureKnowledgeFile(
    target.root,
    relative(target),
    KNOWLEDGE_LIMITS.documentBytes,
  );
function check(target: KnowledgeTarget, expected: KnowledgeFileSnapshot) {
  verifyKnowledgeTarget(target);
  const current = snapshot(target);
  if (!same(current, expected) || expected.file !== target.file)
    throw Error("Knowledge output or its parent changed after review");
  return current;
}

/** Fixed missing parents only. The returned new anchor must be saved before the publication effect. */
export function prepareKnowledgePublication(
  target: KnowledgeTarget,
  expected: KnowledgeFileSnapshot,
): KnowledgeFileSnapshot {
  check(target, expected);
  let parent = target.root;
  for (const component of ["knowledge", "repos"]) {
    canonicalTrustedDirectory(parent);
    const next = join(parent, component);
    try {
      mkdirSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (
      canonicalTrustedDirectory(next) !== next ||
      !lstatSync(next).isDirectory()
    )
      throw Error("Knowledge output parents could not be verified");
    parent = next;
  }
  verifyKnowledgeTarget(target);
  const found = snapshot(target);
  if (!same({ ...found, parent: expected.parent }, expected))
    throw Error("Knowledge output changed while preparing its fixed parents");
  return found;
}

/** Cooperating writers share the canonical repository lock even across separate private homes. */
export async function withKnowledgePublicationLock<T>(
  target: KnowledgeTarget,
  work: () => T | Promise<T>,
): Promise<T> {
  verifyKnowledgeTarget(target);
  const directory = join(target.root, ".git"),
    file = join(directory, "agent-forge-knowledge.lock.db");
  if (canonicalTrustedDirectory(directory) !== directory)
    throw Error("Knowledge repository lock is unavailable");
  try {
    const found = lstatSync(file);
    if (!found.isFile() || found.isSymbolicLink() || found.nlink !== 1)
      throw Error("Knowledge repository lock is linked or invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result = await withQueueLock(
    file,
    async () => {
      verifyKnowledgeTarget(target);
      return work();
    },
    { waitMs: 1000 },
  );
  if (!result.ok)
    throw Error("Another knowledge publication owns this repository");
  return result.value;
}

/** Atomic replacement with best-effort external-editor detection, not a hostile-account transaction. */
export function publishKnowledgeCandidate(
  target: KnowledgeTarget,
  expected: KnowledgeFileSnapshot,
  candidate: string,
): KnowledgeFileSnapshot {
  check(target, expected);
  if (
    Buffer.byteLength(candidate) > KNOWLEDGE_LIMITS.documentBytes ||
    candidate.split("\n").length > KNOWLEDGE_LIMITS.lines ||
    Buffer.from(candidate).toString("utf8") !== candidate
  )
    throw Error("Knowledge candidate exceeds its document contract");
  const tempName = `.${target.name}.knowledge-${randomUUID()}.tmp`,
    temp = join(dirname(target.file), tempName);
  let descriptor: number | undefined, own: KnowledgeFileSnapshot | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, candidate, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    own = captureKnowledgeFile(
      target.root,
      `knowledge/repos/${tempName}`,
      KNOWLEDGE_LIMITS.documentBytes,
    );
    if (own.hash !== knowledgeDigest(candidate) || own.bytes !== candidate)
      throw Error("Knowledge candidate staging could not be verified");
    check(target, expected);
    renameSync(temp, target.file);
    own = undefined;
    const confirmed = snapshot(target);
    verifyKnowledgeTarget(target);
    if (
      confirmed.hash !== knowledgeDigest(candidate) ||
      confirmed.bytes !== candidate
    )
      throw Error("Knowledge publication could not be read back");
    return confirmed;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (own) {
      try {
        const current = captureKnowledgeFile(
          target.root,
          `knowledge/repos/${tempName}`,
          KNOWLEDGE_LIMITS.documentBytes,
        );
        if (same(current, own)) unlinkSync(temp);
      } catch {
        /* An unverified staging name is retained, never removed by guess. */
      }
    }
  }
}
