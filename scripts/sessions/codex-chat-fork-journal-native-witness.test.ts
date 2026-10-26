import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CodexChatForkOriginal } from "../../types/codex-chat-fork";
import {
  type AclReading,
  assertOwnerOnly,
  makeOwnerOnly,
  nativeWindowsAcl,
  ownerOnlyProblem,
} from "../hearth/acl-windows";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import { scratchDirs } from "../test-scratch";
import { createCodexChatForkJournal } from "./codex-chat-fork-journal";
import {
  CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
  createCodexChatForkJournalStorage,
} from "./codex-chat-fork-journal-storage";

const scratch = scratchDirs(),
  nativeEnabled =
    process.platform === "win32" &&
    process.env.AGENT_FORGE_RUN_FORK_NATIVE_WITNESS === "1",
  children = new Set<Bun.Subprocess>(),
  outputLimit = 16 * 1024,
  childTimeoutMs = 12_000;
const testSourceSeal = {
  parentRequestHash: "a".repeat(64),
  parentTurnHash: "b".repeat(64),
  parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a70",
  throughNativeTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a71",
  sourceSettingsHash: "c".repeat(64),
};

const attemptReplySchema = z
    .object({
      mayDispatch: z.boolean(),
      state: z.literal("attempted"),
    })
    .strict(),
  reservationReplySchema = z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        requestId: z.enum([
          "0199a213-81c0-7800-8aa1-bbab2a035a57",
          "0199a213-81c0-7800-8aa1-bbab2a035a58",
        ]),
        state: z.literal("reserved"),
        storageErrors: z.array(z.string().max(500)).max(1),
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.enum(["conflict", "held", "unexpected"]),
        storageErrors: z.array(z.string().max(500)).max(1),
      })
      .strict(),
  ]);

afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
  scratch.cleanup();
});

interface Fixture {
  base: string;
  root: string;
  home: string;
}

function fixture(label: string): Fixture {
  const base = scratch.make(`fork-native-${label}-`),
    root = join(base, "workspace"),
    home = join(base, "profile");
  mkdirSync(join(root, ".git"), { recursive: true });
  return { base, root, home };
}

const projectId = "project-00000000-0000-4000-8000-000000000001",
  parentSessionId = "session-0199a213-81c0-7800-8aa1-bbab2a035a51",
  throughTurnRequestId = "0199a213-81c0-7800-8aa1-bbab2a035a54";

function intent(requestId: string) {
  return { requestId, throughTurnRequestId };
}

function reference(record: CodexChatForkOriginal) {
  return {
    projectId: record.projectId,
    workspaceKey: record.workspaceKey,
    requestId: record.requestId,
    requestHash: record.requestHash,
    parentSessionId: record.parentSessionId,
    throughTurnRequestId: record.throughTurnRequestId,
    protocolVersion: record.protocolVersion,
    childAppSessionId: record.childAppSessionId,
    sourceSeal: record.sourceSeal,
  };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > outputLimit) {
        await reader.cancel();
        throw new Error("Fork native witness child output exceeded its limit.");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function runChild(script: string): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: childTimeoutMs,
  });
  children.add(child);
  let complete = false;
  try {
    const [stdout, stderr, code] = await Promise.all([
      readBounded(child.stdout),
      readBounded(child.stderr),
      child.exited,
    ]);
    complete = true;
    if (code !== 0)
      throw new Error(
        `Fork native witness child exited ${code}: ${stderr.slice(0, 2_000)}`,
      );
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(
        `Fork native witness child returned invalid bounded JSON: ${stdout.slice(0, 2_000)}`,
      );
    }
  } finally {
    if (!complete) {
      child.kill();
      await child.exited;
    }
    children.delete(child);
  }
}

function imports(): string {
  return `import { CodexChatForkJournalError, createCodexChatForkJournal } from ${JSON.stringify(join(import.meta.dir, "codex-chat-fork-journal.ts"))};`;
}

function childBarrier(barrier: string, slot: string): string {
  const other = slot === "a" ? "b" : "a";
  return `
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const gate = ${JSON.stringify(barrier)};
    writeFileSync(join(gate, ${JSON.stringify(slot)}), "ready", { flag: "wx" });
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(gate, ${JSON.stringify(other)}))) {
      if (Date.now() >= deadline) throw new Error("Fork race barrier timed out");
      await Bun.sleep(20);
    }
  `;
}

function journalImport(root: string, home: string): string {
  return `
    ${imports()}
    import { createCodexChatForkJournalStorage } from ${JSON.stringify(join(import.meta.dir, "codex-chat-fork-journal-storage.ts"))};
    const storage = createCodexChatForkJournalStorage(${JSON.stringify(home)});
    const storageErrors = [];
    const tracedStorage = {
      listEvents: () => storage.listEvents(),
      read: (entry, maxBytes) => storage.read(entry, maxBytes),
      writeOnce: (name, text) => storage.writeOnce(name, text),
      async exclusive(work) {
        try { return await storage.exclusive(work); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          storageErrors.push(message.replaceAll(${JSON.stringify(home)}, "[profile]").replaceAll(${JSON.stringify(root)}, "[workspace]").slice(0, 500));
          throw error;
        }
      },
    };
    const journal = createCodexChatForkJournal({root:${JSON.stringify(root)},home:${JSON.stringify(home)},storage:tracedStorage});`;
}

/** Fixture-only setup to isolate foreign-sidecar and debris refusal from mutex creation. */
async function prepareExistingOwnerOnlyMutex(home: string): Promise<void> {
  const journalRoot = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY),
    events = join(journalRoot, "events"),
    locks = join(journalRoot, "locks"),
    mutex = join(locks, "journal.sqlite"),
    acl = nativeWindowsAcl();
  ensurePrivateHome(home);
  ensurePrivateHome(journalRoot);
  ensurePrivateHome(events);
  ensurePrivateHome(locks);
  const locked = await withQueueLock(mutex, async () => undefined, {
    waitMs: 5_000,
  });
  if (!locked.ok)
    throw new Error("Could not prepare the isolated mutex fixture.");
  for (const name of readdirSync(locks))
    makeOwnerOnly(join(locks, name), "file", acl);
  assertOwnerOnly(mutex, "file", acl);
}

function inheritedFile(
  base: string,
  destination: string,
): { path: string; text: string; acl: AclReading } {
  const source = join(base, `foreign-${randomUUID()}.bin`),
    text = "preserve inherited fixture",
    acl = nativeWindowsAcl();
  writeFileSync(source, text);
  const before = acl.read(source);
  if (ownerOnlyProblem(before, "file", acl.userSid()) === null)
    throw new Error(
      "The foreign ACL fixture unexpectedly has an owner-only DACL.",
    );
  renameSync(source, destination);
  const moved = acl.read(destination);
  if (JSON.stringify(moved) !== JSON.stringify(before))
    throw new Error("Moving the foreign ACL fixture changed its ACL.");
  return { path: destination, text, acl: before };
}

function detail(error: unknown, mutex: string): string {
  const message = error instanceof Error ? error.message : String(error);
  let acl: unknown = "missing";
  try {
    acl = nativeWindowsAcl().read(mutex);
  } catch (readError) {
    acl = readError instanceof Error ? readError.message : String(readError);
  }
  const summary =
    typeof acl === "object" && acl !== null
      ? {
          owner: "owner" in acl ? acl.owner : null,
          protected: "protected" in acl ? acl.protected : null,
          entries: "entries" in acl ? acl.entries : null,
        }
      : acl;
  return `${message}; mutexExists=${existsSync(mutex)}; mutexAcl=${JSON.stringify(summary)}`;
}

test.skipIf(!nativeEnabled)(
  "Windows fresh Fork reserve and reopen report the newly created mutex ACL",
  async () => {
    expect(Bun.version).toBe("1.4.2");
    const { root, home } = fixture("fresh"),
      requestId = "0199a213-81c0-7800-8aa1-bbab2a035a55",
      mutex = join(
        home,
        CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
        "locks",
        "journal.sqlite",
      );
    let reserved: CodexChatForkOriginal;
    try {
      reserved = await createCodexChatForkJournal({ root, home }).reserve(
        projectId,
        parentSessionId,
        intent(requestId),
        testSourceSeal,
      );
    } catch (error) {
      throw new Error(detail(error, mutex));
    }
    assertOwnerOnly(mutex, "file", nativeWindowsAcl());
    expect(
      createCodexChatForkJournal({ root, home }).read(projectId, requestId),
    ).toEqual(reserved);
  },
  20_000,
);

test.skipIf(!nativeEnabled)(
  "Windows separate processes claim the same original attempt at most once",
  async () => {
    const { base, root, home } = fixture("attempt-race"),
      requestId = "0199a213-81c0-7800-8aa1-bbab2a035a56",
      parent = createCodexChatForkJournal({ root, home });
    const reserved = await parent.reserve(
        projectId,
        parentSessionId,
        intent(requestId),
        testSourceSeal,
      ),
      barrier = join(base, "barrier");
    mkdirSync(barrier);
    const scripts = ["a", "b"].map(
      (slot) => `${journalImport(root, home)} ${childBarrier(barrier, slot)}
        const result = await journal.markAttempted(${JSON.stringify(reference(reserved))});
        process.stdout.write(JSON.stringify({mayDispatch:result.mayDispatch,state:result.record.state}));`,
    );
    const results = (await Promise.all(scripts.map(runChild))).map((value) =>
      attemptReplySchema.parse(value),
    );
    expect(results.filter((value) => value.mayDispatch)).toHaveLength(1);
    expect(results.every((value) => value.state === "attempted")).toBe(true);
    expect(parent.read(projectId, requestId)?.state).toBe("attempted");
  },
  30_000,
);

test.skipIf(!nativeEnabled)(
  "Windows separate processes cannot reserve two UUIDs for one active parent address",
  async () => {
    const { base, root, home } = fixture("address-race");
    const barrier = join(base, "barrier");
    mkdirSync(barrier);
    const ids = [
      "0199a213-81c0-7800-8aa1-bbab2a035a57",
      "0199a213-81c0-7800-8aa1-bbab2a035a58",
    ];
    const scripts = ["a", "b"].map(
      (
        slot,
        index,
      ) => `${journalImport(root, home)} ${childBarrier(barrier, slot)}
        try {
          const record = await journal.reserve(${JSON.stringify(projectId)},${JSON.stringify(parentSessionId)},${JSON.stringify(intent(ids[index]!))},${JSON.stringify(testSourceSeal)});
          process.stdout.write(JSON.stringify({ok:true,requestId:record.requestId,state:record.state,storageErrors}));
        } catch (error) {
          process.stdout.write(JSON.stringify({ok:false,reason:error instanceof CodexChatForkJournalError ? error.reason : "unexpected",storageErrors}));
        }`,
    );
    const parent = createCodexChatForkJournal({ root, home }),
      results = (await Promise.all(scripts.map(runChild))).map((value) =>
        reservationReplySchema.parse(value),
      ),
      winner = results.find((value) => value.ok),
      loser = results.find((value) => !value.ok);
    if (winner === undefined || loser === undefined)
      throw new Error(
        `The active-address race returned malformed outcomes: ${JSON.stringify(results).slice(0, 2_000)}`,
      );
    if (loser.reason !== "conflict")
      throw new Error(
        `The active-address race loser was ${loser.reason}, with storage diagnostics ${JSON.stringify(loser.storageErrors).slice(0, 1_000)}; outcomes=${JSON.stringify(results).slice(0, 2_000)}`,
      );
    expect(loser.reason).toBe("conflict");
    const reopened = createCodexChatForkJournal({ root, home });
    expect(reopened.read(projectId, winner!.requestId)?.state).toBe("reserved");
    expect(
      reopened.read(
        projectId,
        ids.find((requestId) => requestId !== winner!.requestId)!,
      ),
    ).toBeNull();
  },
  30_000,
);

test.skipIf(!nativeEnabled)(
  "Windows foreign mutex and sidecar ACLs are refused without changing them",
  async () => {
    const acl = nativeWindowsAcl();
    for (const kind of ["mutex", "sidecar"] as const) {
      const { base, home } = fixture(`foreign-${kind}`),
        journalRoot = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY),
        locks = join(journalRoot, "locks"),
        mutex = join(locks, "journal.sqlite");
      ensurePrivateHome(home);
      ensurePrivateHome(journalRoot);
      ensurePrivateHome(join(journalRoot, "events"));
      ensurePrivateHome(locks);
      if (kind === "sidecar") await prepareExistingOwnerOnlyMutex(home);
      const target = kind === "mutex" ? mutex : `${mutex}-wal`;
      const inherited = inheritedFile(base, target),
        beforeText = readFileSync(inherited.path, "utf8"),
        beforeAcl = acl.read(inherited.path);
      expect(beforeText).toBe(inherited.text);
      expect(beforeAcl).toEqual(inherited.acl);
      expect(() => assertOwnerOnly(target, "file", acl)).toThrow();
      await expect(
        createCodexChatForkJournalStorage(home).exclusive(
          async () => undefined,
        ),
      ).rejects.toThrow();
      expect(readFileSync(inherited.path, "utf8")).toBe(beforeText);
      expect(acl.read(inherited.path)).toEqual(beforeAcl);
    }
  },
  30_000,
);

test.skipIf(!nativeEnabled)(
  "Windows linked profile ancestors and unknown journal debris fail closed",
  async () => {
    const linked = fixture("junction"),
      target = join(linked.base, "junction-target"),
      alias = join(linked.base, "alias"),
      linkedHome = join(alias, "missing", "nested", "profile");
    mkdirSync(target);
    symlinkSync(target, alias, "junction");
    await expect(
      createCodexChatForkJournalStorage(linkedHome).exclusive(
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(readdirSync(target)).toEqual([]);

    const { root, home } = fixture("debris"),
      requestId = "0199a213-81c0-7800-8aa1-bbab2a035a59";
    await prepareExistingOwnerOnlyMutex(home);
    const events = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "events"),
      debris = join(events, "interrupted-publication.tmp");
    writeOwnerOnly(debris, "preserve", {
      platform: "win32",
      acl: nativeWindowsAcl(),
    });
    expect(() =>
      createCodexChatForkJournal({ root, home }).read(projectId, requestId),
    ).toThrow();
    expect(readFileSync(debris, "utf8")).toBe("preserve");
  },
  30_000,
);
