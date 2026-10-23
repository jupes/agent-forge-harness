import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  SessionWorktreeReceipt,
  SessionWorktreeRequest,
} from "../../types/session-worktrees";
import { ConversationError } from "../conversations/error";
import {
  ensurePrivateHome,
  readHomeFile,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "../projects/scope";
import { isProjectId } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  createWorktree,
  type GitRun,
  gitRun,
  listWorktrees,
} from "../scheduler/worktrees";
import {
  sessionWorktreeReceiptSchema,
  sessionWorktreeRequestSchema,
} from "./worktree-protocol";

export const MAX_SESSION_WORKTREE_REQUESTS = 1000;
export const MAX_SESSION_WORKTREE_BYTES = 2_097_152;
const UNKNOWN =
  "Creation is not confirmed. Inspect the planned worktree and branch; checking or retrying this request never creates another worktree.";
export const sessionWorktreeJournalFile = (home: string) =>
  join(home, "session-worktrees", "requests.json");

/** Fixed fields and canonical path spelling; no mutable configuration participates. */
export function sessionWorktreeRequestHash(
  projectId: string,
  request: SessionWorktreeRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId,
        requestId: request.requestId,
        repository: workspaceKey(request.repository),
        baseRef: request.baseRef,
        branch: request.branch,
        ...(request.beadId ? { beadId: request.beadId } : {}),
      }),
    )
    .digest("hex");
}
export function sessionWorktreeId(
  projectId: string,
  requestId: string,
): string {
  return `sw-${createHash("sha256").update(`${projectId}\0${requestId}`).digest("hex").slice(0, 28)}`;
}

const recordSchema = z
  .object({
    request: sessionWorktreeRequestSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    plan: sessionWorktreeReceiptSchema.refine(
      (value) => value.state === "unknown" && value.worktree !== null,
    ),
    receipt: sessionWorktreeReceiptSchema.nullable(),
  })
  .strict()
  .refine((value) => {
    const { request, plan, receipt } = value;
    const same = (item: SessionWorktreeReceipt) =>
      item.projectId === plan.projectId &&
      item.requestId === plan.requestId &&
      item.repository === plan.repository &&
      item.baseRef === plan.baseRef &&
      item.resolvedCommit === plan.resolvedCommit &&
      item.branch === plan.branch &&
      (item.worktree === null ||
        JSON.stringify(item.worktree) === JSON.stringify(plan.worktree));
    return (
      value.requestHash ===
        sessionWorktreeRequestHash(plan.projectId, request) &&
      plan.requestId === request.requestId &&
      workspaceKey(plan.repository) === workspaceKey(request.repository) &&
      plan.baseRef === request.baseRef &&
      plan.branch === request.branch &&
      plan.worktree?.id ===
        sessionWorktreeId(plan.projectId, request.requestId) &&
      workspaceKey(plan.worktree.path) ===
        workspaceKey(join(plan.repository, "trees", plan.worktree.id)) &&
      (receipt === null || same(receipt))
    );
  });
const journalSchema = z
  .object({
    version: z.literal(1),
    records: z.array(recordSchema).max(MAX_SESSION_WORKTREE_REQUESTS),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((record) => record.request.requestId)).size ===
      value.records.length,
  );
type Journal = z.infer<typeof journalSchema>;
type Record = Journal["records"][number];

function unavailable(message: string): never {
  throw new ConversationError(503, `${message} Saved data has been kept.`);
}
function checked(home: string) {
  const directory = join(home, "session-worktrees"),
    lock = join(directory, "requests.lock.db"),
    file = sessionWorktreeJournalFile(home);
  for (const [path, folder] of [
    [directory, true],
    [lock, false],
    [file, false],
  ] as const) {
    try {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      )
        unavailable("The private worktree receipt path is linked or invalid.");
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        unavailable("The private worktree receipt path could not be checked.");
    }
  }
  if (readHomeFile(directory).problem !== null)
    unavailable("The worktree receipt directory is not private.");
  return { file, lock };
}
function readJournal(home: string): Journal {
  const { file } = checked(home);
  const found = readSessionTranscript(home, file);
  if (found.problem !== null)
    unavailable("The private worktree receipts could not be read.");
  if (found.text === null) return { version: 1, records: [] };
  let raw: unknown;
  try {
    if (Buffer.byteLength(found.text) > MAX_SESSION_WORKTREE_BYTES)
      throw new Error("Full receipt store");
    raw = JSON.parse(found.text);
  } catch {
    unavailable("The private worktree receipts are invalid or full.");
  }
  const parsed = journalSchema.safeParse(raw);
  if (!parsed.success)
    unavailable(
      "The private worktree receipts are invalid or use an unsupported version.",
    );
  return parsed.data;
}
function save(home: string, state: Journal) {
  checked(home);
  const parsed = journalSchema.safeParse(state),
    content = JSON.stringify(state);
  if (
    !parsed.success ||
    Buffer.byteLength(content) > MAX_SESSION_WORKTREE_BYTES
  )
    unavailable("The private worktree receipts are invalid or full.");
  try {
    writeOwnerOnly(sessionWorktreeJournalFile(home), content);
  } catch {
    unavailable(
      "The worktree receipt write could not be confirmed. Check the original request.",
    );
  }
}

function safeTrees(repository: string) {
  for (const [path, folder] of [
    [join(repository, "trees"), true],
    [join(repository, "trees", ".state.json"), false],
  ] as const) {
    try {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      )
        unavailable("The worktree registry path is linked or invalid.");
      if (!folder) {
        if (info.size > 1_000_000)
          unavailable("The worktree registry exceeds its supported bound.");
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(path, "utf8"));
        } catch {
          unavailable("The worktree registry is invalid.");
        }
        if (
          !z
            .object({ worktrees: z.array(z.unknown()) })
            .strict()
            .safeParse(raw).success
        )
          unavailable("The worktree registry uses an unsupported shape.");
      }
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        unavailable("The worktree registry could not be checked.");
    }
  }
}

interface Options {
  home: string;
  root: string;
  git?: GitRun | undefined;
  /** Reuses current Start repository/project/bead authority; called only for a new UUID. */
  validateScope(
    projectId: string,
    request: SessionWorktreeRequest,
  ): Promise<{ repository: string }>;
}

/** Durable original intent fences Git. Reads/retries only reconcile; they never replay a write. */
export function createSessionWorktreeService(options: Options) {
  const git = options.git ?? gitRun;
  const find = (projectId: string, requestId: string): Record => {
    if (
      !isProjectId(projectId) ||
      !z.string().uuid().safeParse(requestId).success
    )
      throw new ConversationError(
        400,
        "Expected a project and original worktree request UUID.",
      );
    const record = readJournal(options.home).records.find(
      (item) => item.request.requestId === requestId,
    );
    if (!record)
      throw new ConversationError(
        404,
        "This worktree creation request has no saved receipt.",
      );
    if (record.plan.projectId !== projectId)
      throw new ConversationError(
        409,
        "This worktree request belongs to a different project.",
      );
    return record;
  };
  const reconcile = (record: Record): SessionWorktreeReceipt => {
    const receipt = record.receipt ?? record.plan;
    if (receipt.state !== "unknown") return receipt;
    const plan = record.plan,
      worktree = plan.worktree;
    if (!worktree) return receipt;
    try {
      safeTrees(plan.repository);
      if (
        workspaceKey(realpathSync.native(plan.repository)) !==
        workspaceKey(plan.repository)
      )
        return receipt;
      const info = lstatSync(worktree.path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        workspaceKey(realpathSync.native(worktree.path)) !==
          workspaceKey(worktree.path)
      )
        return receipt;
      const listed = listWorktrees(plan.repository, {
        git,
        readMirror: () => null,
      });
      if (
        !listed.ok ||
        !listed.entries.some(
          (item) =>
            !item.missing &&
            !item.detached &&
            workspaceKey(item.path) === workspaceKey(worktree.path) &&
            item.branch === plan.branch &&
            item.head === plan.resolvedCommit,
        )
      )
        return receipt;
      const branch = git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`],
        plan.repository,
        5000,
      );
      const common = git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        worktree.path,
        5000,
      );
      const mainCommon = git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        plan.repository,
        5000,
      );
      if (
        branch.status !== 0 ||
        branch.stdout.trim() !== plan.resolvedCommit ||
        common.status !== 0 ||
        mainCommon.status !== 0 ||
        workspaceKey(common.stdout.trim()) !==
          workspaceKey(mainCommon.stdout.trim())
      )
        return receipt;
      return { ...plan, state: "created", reason: null };
    } catch {
      return receipt;
    }
  };
  return {
    async read(
      projectId: string,
      requestId: string,
    ): Promise<SessionWorktreeReceipt> {
      return reconcile(find(projectId, requestId));
    },
    async create(
      projectId: string,
      raw: unknown,
    ): Promise<SessionWorktreeReceipt> {
      const parsed = sessionWorktreeRequestSchema.safeParse(raw);
      if (!isProjectId(projectId) || !parsed.success)
        throw new ConversationError(
          400,
          "Expected an original worktree UUID, repository, base ref and safe new branch.",
        );
      const request = parsed.data,
        hash = sessionWorktreeRequestHash(projectId, request);
      ensurePrivateHome(options.home);
      const { lock } = checked(options.home);
      const result = await withQueueLock(
        lock,
        async () => {
          const state = readJournal(options.home),
            existing = state.records.find(
              (item) => item.request.requestId === request.requestId,
            );
          if (existing) {
            if (
              existing.plan.projectId !== projectId ||
              existing.requestHash !== hash
            )
              throw new ConversationError(
                409,
                "This worktree request already names different content or a different project.",
              );
            return reconcile(existing);
          }
          if (state.records.length >= MAX_SESSION_WORKTREE_REQUESTS)
            unavailable(
              "The worktree receipt store is full; original UUIDs are never evicted.",
            );
          const { repository } = await options.validateScope(
            projectId,
            request,
          );
          if (workspaceKey(repository) !== workspaceKey(request.repository))
            throw new ConversationError(
              409,
              "The selected repository is not its checked canonical path.",
            );
          safeTrees(repository);
          const format = git(
            ["check-ref-format", "--branch", request.branch],
            repository,
            5000,
          );
          if (format.status !== 0 || format.stdout.trim() !== request.branch)
            throw new ConversationError(
              400,
              "Expected a valid literal new branch name.",
            );
          const branch = git(
            [
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${request.branch}`,
            ],
            repository,
            5000,
          );
          if (branch.status === 0)
            throw new ConversationError(
              409,
              "That branch already exists. Choose an explicit new branch.",
            );
          if (branch.status === null)
            unavailable("The branch could not be checked.");
          const resolved = git(
            ["rev-parse", "--verify", "--quiet", `${request.baseRef}^{commit}`],
            repository,
            5000,
          );
          const resolvedCommit = resolved.stdout.trim();
          if (
            resolved.status !== 0 ||
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resolvedCommit)
          )
            throw new ConversationError(
              409,
              "The selected base ref does not name a confirmed local commit.",
            );
          const id = sessionWorktreeId(projectId, request.requestId),
            path = join(repository, "trees", id);
          try {
            lstatSync(path);
            throw new ConversationError(
              409,
              "The planned worktree path is already occupied. Inspect it before creating another request.",
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const createdAt = new Date().toISOString();
          const plan: SessionWorktreeReceipt = {
            projectId,
            requestId: request.requestId,
            repository,
            baseRef: request.baseRef,
            resolvedCommit,
            branch: request.branch,
            worktree: { id, path, branch: request.branch, createdAt },
            state: "unknown",
            reason: UNKNOWN,
          };
          const record: Record = {
            request,
            requestHash: hash,
            plan,
            receipt: null,
          };
          state.records.push(record);
          save(options.home, state);
          let attempted = false;
          const observedGit: GitRun = (args, cwd, timeout) => {
            if (args[0] === "worktree" && args[1] === "add") attempted = true;
            return git(args, cwd, timeout);
          };
          let receipt: SessionWorktreeReceipt;
          try {
            const made = createWorktree(
              repository,
              repository,
              {
                branch: request.branch,
                startPoint: resolvedCommit,
                beadId: request.beadId,
                preserveOnFailure: true,
              },
              {
                git: observedGit,
                newId: () => id,
                now: () => new Date(createdAt),
                readMirror: () => null,
              },
            );
            receipt = made.ok
              ? { ...plan, state: "created", reason: null }
              : {
                  ...plan,
                  state: attempted ? "unknown" : "refused",
                  worktree: attempted ? plan.worktree : null,
                  reason: made.error.replace(/[\p{Cc}\p{Cs}]/gu, " ").trim(),
                };
          } catch {
            receipt = { ...plan, reason: UNKNOWN };
          }
          record.receipt = receipt;
          try {
            save(options.home, state);
          } catch {
            return {
              ...plan,
              reason:
                "The final receipt write was not confirmed. Inspect the original request; no automatic creation will run.",
            };
          }
          return receipt;
        },
        { waitMs: 5000 },
      );
      if (!result.ok)
        unavailable(
          "Worktree creation is busy or unavailable. Check the original request before retrying.",
        );
      return result.value;
    },
  };
}
