import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  makeOwnerOnly,
  nativeWindowsAcl,
  ownerOnlyProblem,
} from "../hearth/acl-windows";
import { ensurePrivateHome } from "../hearth/home-guard";
import { workspaceKey } from "../projects/scope";
import { scratchDirs } from "../test-scratch";
import type { RestartIdentityInput } from "./restart-index";
import { createRestartIdentityJournal } from "./restart-index";

const scratch = scratchDirs({ tempDir: realpathSync.native(tmpdir()) });
const workerPath = join(import.meta.dir, "restart-index-worker.ts");
const MAX_CHILD_OUTPUT_BYTES = 8 * 1024;
const CHILD_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 5_000;

type ChildOutput = { code: number; stdout: string; stderr: string };
type Child = {
  process: ReturnType<typeof Bun.spawn>;
  done: Promise<ChildOutput>;
};
const children = new Set<Child>();

afterEach(async () => {
  const owned = [...children];
  for (const child of owned) {
    if (child.process.exitCode === null) child.process.kill();
  }
  const outcomes = await Promise.allSettled(owned.map((child) => child.done));
  children.clear();
  try {
    scratch.cleanup();
  } catch (error) {
    outcomes.push({ status: "rejected", reason: error });
  }
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "Restart identity native fixture cleanup failed",
    );
});

function fixture(prefix: string) {
  const root = scratch.make(prefix);
  const profile = join(root, "profile");
  const workspaceDirectory = join(root, "workspace");
  mkdirSync(workspaceDirectory);
  return {
    root,
    profile,
    workspace: workspaceKey(realpathSync.native(workspaceDirectory)),
  };
}

function identity(workspace: string): RestartIdentityInput {
  return {
    version: 1,
    address: {
      family: "owned-session-start",
      projectId: "project-123e4567-e89b-42d3-a456-426614174000",
    },
    workspace,
    requestId: "7b5b2b32-4bcc-4a1c-92c8-61dd39234d82",
    requestHash: "a".repeat(64),
    provider: "claude",
    mode: "task",
  };
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let oversized = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes <= MAX_CHILD_OUTPUT_BYTES) text += decoder.decode(next.value);
      else oversized = true;
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (oversized)
    throw new Error("Restart identity worker output exceeded its cap");
  return text;
}

function startWorker(
  operation: "attempt" | "retire",
  profile: string,
  input: RestartIdentityInput,
  barrier?: { ready: string; release: string },
): Child {
  const args = [
    process.execPath,
    workerPath,
    operation,
    profile,
    JSON.stringify(input),
  ];
  if (barrier !== undefined) args.push(barrier.ready, barrier.release);
  const childProcess = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  const timer = setTimeout(() => childProcess.kill(), CHILD_TIMEOUT_MS);
  const child: Child = {
    process: childProcess,
    done: Promise.all([
      childProcess.exited,
      readLimited(childProcess.stdout),
      readLimited(childProcess.stderr),
    ])
      .then(([code, stdout, stderr]) => ({ code, stdout, stderr }))
      .finally(() => clearTimeout(timer)),
  };
  void child.done.catch(() => {});
  children.add(child);
  return child;
}

const workerReplySchema = z.union([
  z
    .object({
      ok: z.literal(true),
      operation: z.enum(["attempt", "retire"]),
      state: z.enum(["attempted", "retired"]),
      mayDispatch: z.boolean().optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), kind: z.string() }).strict(),
]);

async function workerReply(child: Child) {
  const output = await child.done;
  children.delete(child);
  expect(output.code, output.stdout).toBe(0);
  expect(output.stderr).toBe("");
  let raw: unknown;
  try {
    raw = JSON.parse(output.stdout);
  } catch {
    throw new Error("Restart identity worker did not return JSON");
  }
  const parsed = workerReplySchema.safeParse(raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success)
    throw new Error("Restart identity worker reply was invalid");
  return parsed.data;
}

async function waitFor(paths: string[]): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline)
      throw new Error("Restart identity workers did not reach the barrier");
    await Bun.sleep(5);
  }
}

test.skipIf(process.platform !== "win32")(
  "default Windows ACL storage survives child reopen and serializes cross-process claim versus retirement",
  async () => {
    const first = fixture("restart-native-first-");
    const firstIdentity = identity(first.workspace);
    const firstJournal = createRestartIdentityJournal(first.profile);
    expect(await firstJournal.reserve(firstIdentity)).toMatchObject({
      state: "reserved",
    });

    const firstClaim = await workerReply(
      startWorker("attempt", first.profile, firstIdentity),
    );
    expect(firstClaim).toEqual({
      ok: true,
      operation: "attempt",
      state: "attempted",
      mayDispatch: true,
    });
    const reopenedClaim = await workerReply(
      startWorker("attempt", first.profile, firstIdentity),
    );
    expect(reopenedClaim).toEqual({
      ok: true,
      operation: "attempt",
      state: "attempted",
      mayDispatch: false,
    });

    const race = fixture("restart-native-race-");
    const raceIdentity = identity(race.workspace);
    const raceJournal = createRestartIdentityJournal(race.profile);
    await raceJournal.reserve(raceIdentity);
    const readyAttempt = join(race.root, "attempt.ready");
    const readyRetire = join(race.root, "retire.ready");
    const release = join(race.root, "release");
    const attemptChild = startWorker("attempt", race.profile, raceIdentity, {
      ready: readyAttempt,
      release,
    });
    const retireChild = startWorker("retire", race.profile, raceIdentity, {
      ready: readyRetire,
      release,
    });
    await waitFor([readyAttempt, readyRetire]);
    writeFileSync(release, "go", { flag: "wx" });
    const [attempt, retirement] = await Promise.all([
      workerReply(attemptChild),
      workerReply(retireChild),
    ]);

    const attemptWon =
      attempt.ok &&
      attempt.operation === "attempt" &&
      attempt.mayDispatch === true;
    const retirementWon =
      retirement.ok &&
      retirement.operation === "retire" &&
      retirement.state === "retired";
    expect(attemptWon !== retirementWon).toBe(true);
    if (attemptWon) {
      expect(retirement).toEqual({ ok: false, kind: "conflict" });
    } else {
      expect(attempt).toEqual({ ok: false, kind: "conflict" });
    }
    const final = await raceJournal.lookup(
      { address: raceIdentity.address, workspace: raceIdentity.workspace },
      raceIdentity.requestId,
    );
    expect(final?.state).toBe(attemptWon ? "attempted" : "retired");
  },
  30_000,
);

test.skipIf(process.platform !== "win32")(
  "default Windows ACL refuses inherited foreign paths, linked directories and namespace debris",
  async () => {
    const acl = nativeWindowsAcl();
    const inputFixture = fixture("restart-native-invalid-");
    const input = identity(inputFixture.workspace);

    const foreignDirectoryHome = join(
      inputFixture.root,
      "foreign-directory-profile",
    );
    ensurePrivateHome(foreignDirectoryHome);
    const foreignIndex = join(foreignDirectoryHome, "restart-identities");
    mkdirSync(foreignIndex);
    expect(
      ownerOnlyProblem(acl.read(foreignIndex), "directory", acl.userSid()),
    ).not.toBeNull();
    await expect(
      createRestartIdentityJournal(foreignDirectoryHome).list({
        address: input.address,
        workspace: input.workspace,
      }),
    ).rejects.toThrow();

    const foreignLockHome = join(inputFixture.root, "foreign-lock-profile");
    ensurePrivateHome(foreignLockHome);
    const foreignLockDirectory = join(foreignLockHome, "restart-identities");
    ensurePrivateHome(foreignLockDirectory);
    const foreignLock = join(foreignLockDirectory, "transaction.lock.db");
    writeFileSync(foreignLock, "foreign-lock");
    expect(
      ownerOnlyProblem(acl.read(foreignLock), "file", acl.userSid()),
    ).not.toBeNull();
    await expect(
      createRestartIdentityJournal(foreignLockHome).list({
        address: input.address,
        workspace: input.workspace,
      }),
    ).rejects.toThrow();

    const linkedHome = join(inputFixture.root, "linked-profile");
    ensurePrivateHome(linkedHome);
    const linkedTarget = join(inputFixture.root, "linked-target");
    mkdirSync(linkedTarget);
    symlinkSync(
      linkedTarget,
      join(linkedHome, "restart-identities"),
      "junction",
    );
    await expect(
      createRestartIdentityJournal(linkedHome).list({
        address: input.address,
        workspace: input.workspace,
      }),
    ).rejects.toThrow();

    const debrisHome = join(inputFixture.root, "debris-profile");
    const debrisJournal = createRestartIdentityJournal(debrisHome);
    await debrisJournal.reserve(input);
    const debrisPath = join(debrisHome, "restart-identities", "candidate.tmp");
    writeFileSync(debrisPath, "unknown journal evidence");
    makeOwnerOnly(debrisPath, "file", acl);
    await expect(
      debrisJournal.list({
        address: input.address,
        workspace: input.workspace,
      }),
    ).rejects.toThrow();
  },
  20_000,
);
