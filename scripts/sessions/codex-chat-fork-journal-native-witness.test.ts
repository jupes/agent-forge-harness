import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
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
  CODEX_CHAT_FORK_MUTEX_GUARDS,
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

const mutexGuardSchema = z
    .object({
      phase: z.literal("exclusive-pre-lock-assert"),
      guard: z.enum(CODEX_CHAT_FORK_MUTEX_GUARDS),
      fileSize: z.number().int().min(0).nullable(),
      identityStable: z.boolean().nullable(),
      failure: z.enum(["privacy", "identity", "other"]),
    })
    .strict(),
  attemptReplySchema = z
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
        storageGuards: z.array(mutexGuardSchema).max(8),
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.enum(["conflict", "held", "unexpected"]),
        storageGuards: z.array(mutexGuardSchema).max(8),
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
    reservationKind: record.reservationKind,
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

function startQuietChild(script: string): Bun.Subprocess {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: childTimeoutMs,
  });
  children.add(child);
  return child;
}

async function waitForMarker(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`Fork mutex publication marker timed out: ${label}`);
    await Bun.sleep(10);
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
    const storageGuards = [];
    const storage = createCodexChatForkJournalStorage(${JSON.stringify(home)}, {
      onMutexDiagnostic(diagnostic) {
        if (diagnostic.phase === "exclusive-pre-lock-assert" && diagnostic.guard !== null && storageGuards.length < 8)
          storageGuards.push({phase:diagnostic.phase,guard:diagnostic.guard,fileSize:diagnostic.fileSize,identityStable:diagnostic.identityStable,failure:diagnostic.failure});
      },
    });
    const tracedStorage = {
      listEvents: () => storage.listEvents(),
      read: (entry, maxBytes) => storage.read(entry, maxBytes),
      writeOnce: (name, text) => storage.writeOnce(name, text),
      exclusive: (work) => storage.exclusive(work),
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
        "direct-v1",
      );
    } catch (error) {
      throw new Error(detail(error, mutex));
    }
    expect(reserved.reservationKind).toBe("direct-v1");
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
        "direct-v1",
      ),
      barrier = join(base, "barrier");
    expect(reserved.reservationKind).toBe("direct-v1");
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
          const record = await journal.reserve(${JSON.stringify(projectId)},${JSON.stringify(parentSessionId)},${JSON.stringify(intent(ids[index]!))},${JSON.stringify(testSourceSeal)},"direct-v1");
          process.stdout.write(JSON.stringify({ok:true,requestId:record.requestId,state:record.state,storageGuards}));
        } catch (error) {
          process.stdout.write(JSON.stringify({ok:false,reason:error instanceof CodexChatForkJournalError ? error.reason : "unexpected",storageGuards}));
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
        `The active-address race loser was ${loser.reason}, with bounded storage guards ${JSON.stringify(loser.storageGuards).slice(0, 1_000)}; outcomes=${JSON.stringify(results).slice(0, 2_000)}`,
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
  "Windows exposes the first Fork mutex inode only after its DACL is private",
  async () => {
    expect(Bun.version).toBe("1.4.2");
    const { base, root, home } = fixture("private-mutex-publication"),
      barrier = join(base, "publication"),
      mutex = join(
        home,
        CODEX_CHAT_FORK_JOURNAL_DIRECTORY,
        "locks",
        "journal.sqlite",
      ),
      creatorVisible = join(barrier, "creator-visible"),
      creatorMetadataRead = join(barrier, "creator-metadata-read"),
      peerSnapshot = join(barrier, "peer-snapshot"),
      releaseCreator = join(barrier, "release-creator"),
      releaseCreatorMetadata = join(barrier, "release-creator-metadata"),
      creatorResult = join(barrier, "creator-result"),
      peerResult = join(barrier, "peer-result"),
      native = nativeWindowsAcl();
    mkdirSync(barrier);

    const publicationScript = (requestId: string, creator: boolean) => `
      import { closeSync, existsSync, lstatSync, openSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { CodexChatForkJournalError, createCodexChatForkJournal } from ${JSON.stringify(join(import.meta.dir, "codex-chat-fork-journal.ts"))};
      import { CODEX_CHAT_FORK_JOURNAL_DIRECTORY, createCodexChatForkJournalStorage } from ${JSON.stringify(join(import.meta.dir, "codex-chat-fork-journal-storage.ts"))};
      import { nativeWindowsAcl, ownerOnlyProblem } from ${JSON.stringify(join(import.meta.dir, "../hearth/acl-windows.ts"))};
      const root = ${JSON.stringify(root)}, home = ${JSON.stringify(home)}, barrier = ${JSON.stringify(barrier)};
      const mutex = join(home, CODEX_CHAT_FORK_JOURNAL_DIRECTORY, "locks", "journal.sqlite");
      const native = nativeWindowsAcl();
      const stages = [];
      const metadataReads = [];
      let mutexAclReads = 0;
      let peerWriteOpen = "not-probed";
      let creatorReadOpen = "not-probed";
      const fileKind = (path) => {
        const leaf = path.slice(path.lastIndexOf(String.fromCharCode(92)) + 1).toLowerCase();
        return leaf === "journal.sqlite" ? "mutex" :
          leaf === "journal.sqlite-journal" ? "sqlite-journal" :
          leaf === "journal.sqlite-wal" ? "sqlite-wal" :
          leaf === "journal.sqlite-shm" ? "sqlite-shm" : "other";
      };
      const recordRead = (fact) => { if (metadataReads.length < 16) metadataReads.push(fact); };
      const identity = () => { const info = lstatSync(mutex, { bigint: true }); return { dev: String(info.dev), ino: String(info.ino), size: Number(info.size) }; };
      const reading = () => { const acl = native.read(mutex); return { ownerOnly: ownerOnlyProblem(acl, "file", native.userSid()) === null, protected: acl.protected }; };
      const acl = {
        userSid: () => native.userSid(),
        defaultOwnerSid: () => native.defaultOwnerSid?.(),
        read(path) {
          const kind = fileKind(path);
          if (kind === "mutex") {
            mutexAclReads++;
            if (${creator} && mutexAclReads === 3) {
              // Source order is lstat/path metadata, then this ACL read.
              // Hold here while the peer performs its actual reserve.
              const sizeBeforePeer = Number(lstatSync(path, { bigint: true }).size);
              stages.push("creator-mutex-acl-read-3-before");
              writeFileSync(${JSON.stringify(creatorMetadataRead)}, "ready", { flag: "wx" });
              const wait = new Int32Array(new SharedArrayBuffer(4));
              const deadline = Date.now() + 6_000;
              while (!existsSync(${JSON.stringify(releaseCreatorMetadata)})) {
                if (Date.now() >= deadline)
                  throw new Error("creator metadata barrier timed out");
                Atomics.wait(wait, 0, 0, 10);
              }
              stages.push("creator-mutex-acl-read-3-after");
              recordRead({ operation: "mutex-acl-read-gap", kind: "mutex", beforeBytes: sizeBeforePeer, afterBytes: Number(lstatSync(path, { bigint: true }).size) });
            }
          }
          try {
            const result = native.read(path);
            if (kind !== "other") recordRead({ operation: "acl", kind, ok: true });
            return result;
          } catch (error) {
            if (kind !== "other") recordRead({ operation: "acl", kind, ok: false });
            throw error;
          }
        },
        readInFolder: native.readInFolder ? (folder, name, maxBytes) => {
          const kind = name === null ? "folder" : fileKind(join(folder, name));
          try {
            const result = native.readInFolder(folder, name, maxBytes);
            if (kind !== "other" && kind !== "folder") recordRead({ operation: "file", kind, present: result?.file !== null && result?.file !== undefined, bytes: result?.file?.bytes.byteLength ?? 0 });
            return result;
          } catch (error) {
            if (kind !== "other" && kind !== "folder") recordRead({ operation: "file", kind, present: false, bytes: 0 });
            throw error;
          }
        } : undefined,
        createOwnerOnlyExclusive(path) {
          const created = native.createOwnerOnlyExclusive!(path);
          if (path === mutex) stages.push(created.kind === "created" ? "exclusive-created" : "exclusive-exists");
          if (${creator} && path === mutex && created.kind === "created") {
            stages.push("creator-read-open-before");
            try {
              const descriptor = openSync(mutex, "r");
              closeSync(descriptor);
              creatorReadOpen = "opened";
              stages.push("creator-read-open-after");
            } catch (error) {
              const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
              creatorReadOpen = code === "EACCES" || code === "EPERM" || code === "EBUSY" ? "denied" : "other-error";
              stages.push("creator-read-open-denied");
            }
            // The descriptor supplies a private DACL at creation; the held
            // no-delete handle protects identity during readback and the peer probe.
            try {
              writeFileSync(${JSON.stringify(creatorVisible)}, JSON.stringify({ ...identity(), ...reading(), creatorReadOpen }), { flag: "wx" });
              const wait = new Int32Array(new SharedArrayBuffer(4));
              const deadline = Date.now() + 6_000;
              while (!existsSync(${JSON.stringify(releaseCreator)})) {
                if (Date.now() >= deadline)
                  throw new Error("creator publication barrier timed out");
                Atomics.wait(wait, 0, 0, 10);
              }
            } catch (error) {
              try {
                created.remove();
              } finally {
                created.close();
              }
              throw error;
            }
          }
          return created;
        },
        apply(path, target) {
          native.apply(path, target);
        },
      };
      const diagnostics = [];
      const storage = createCodexChatForkJournalStorage(home, {
        platform: "win32",
        acl,
        afterMutexDirectorySnapshot: ${creator} ? undefined : (empty) => {
          stages.push(empty ? "mutex-snapshot-empty" : "mutex-snapshot-present");
          try {
            const descriptor = openSync(mutex, "r+");
            closeSync(descriptor);
            peerWriteOpen = "opened";
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            peerWriteOpen = code === "EACCES" || code === "EPERM" || code === "EBUSY" ? "denied" : "other-error";
          }
          writeFileSync(${JSON.stringify(peerSnapshot)}, JSON.stringify({ empty, ...identity(), ...reading(), peerWriteOpen }), { flag: "wx" });
        },
        beforeExclusivePreLockAssert: () => {
          if (stages.length < 8) stages.push("before-pre-lock-assert");
          if (!${creator}) {
            const wait = new Int32Array(new SharedArrayBuffer(4));
            const deadline = Date.now() + 6_000;
            while (!existsSync(${JSON.stringify(creatorMetadataRead)})) {
              if (Date.now() >= deadline)
                throw new Error("peer metadata barrier timed out");
              Atomics.wait(wait, 0, 0, 10);
            }
          }
        },
        onMutexDiagnostic: (item) => {
          if (diagnostics.length < 8) diagnostics.push({ phase: item.phase, guard: item.guard, fileSize: item.fileSize, identityStable: item.identityStable, failure: item.failure });
        },
      });
      const journal = createCodexChatForkJournal({ root, home, storage });
      try {
        const record = await journal.reserve(
          ${JSON.stringify(projectId)},
          ${JSON.stringify(parentSessionId)},
          ${JSON.stringify(intent(requestId))},
          ${JSON.stringify(testSourceSeal)},
          "direct-v1",
        );
        stages.push("reserved");
        writeFileSync(${JSON.stringify(creator ? creatorResult : peerResult)}, JSON.stringify({ ok: true, requestId: record.requestId, state: record.state, diagnostics, metadataReads: metadataReads.slice(0, 16), stages: stages.slice(0, 8), peerWriteOpen, creatorReadOpen }));
      } catch (error) {
        const reason = error instanceof CodexChatForkJournalError ? error.reason : "unexpected";
        stages.push("refused-" + reason);
        writeFileSync(${JSON.stringify(creator ? creatorResult : peerResult)}, JSON.stringify({ ok: false, reason, diagnostics, metadataReads: metadataReads.slice(0, 16), stages: stages.slice(0, 8), peerWriteOpen, creatorReadOpen }));
      }
    `;

    const spawned: Bun.Subprocess[] = [];
    let setupFailure: unknown;
    try {
      spawned.push(
        startQuietChild(
          publicationScript("0199a213-81c0-7800-8aa1-bbab2a035a57", true),
        ),
      );
      await waitForMarker(creatorVisible, "creator-visible");
      spawned.push(
        startQuietChild(
          publicationScript("0199a213-81c0-7800-8aa1-bbab2a035a58", false),
        ),
      );
      await waitForMarker(peerSnapshot, "peer-snapshot");
      writeFileSync(releaseCreator, "release", { flag: "wx" });
      await waitForMarker(
        creatorMetadataRead,
        "creator-metadata-read-after-mutex-lstat",
      );
      await waitForMarker(peerResult, "peer-reserved");
      writeFileSync(releaseCreatorMetadata, "release", { flag: "wx" });
    } catch (error) {
      setupFailure = error;
    } finally {
      if (!existsSync(releaseCreator))
        writeFileSync(releaseCreator, "release", { flag: "wx" });
      if (!existsSync(releaseCreatorMetadata))
        writeFileSync(releaseCreatorMetadata, "release", { flag: "wx" });
      const exits = await Promise.all(spawned.map((child) => child.exited));
      for (const child of spawned) children.delete(child);
      if (exits.some((code) => code !== 0) && setupFailure === undefined)
        setupFailure = new Error(
          `Fork mutex publication child exited unexpectedly: ${exits.join(",")}`,
        );
    }
    if (setupFailure !== undefined) throw setupFailure;

    const publication = z
        .object({
          dev: z.string(),
          ino: z.string(),
          size: z.number().int().min(0),
          ownerOnly: z.boolean(),
          protected: z.boolean(),
          creatorReadOpen: z.enum([
            "not-probed",
            "opened",
            "denied",
            "other-error",
          ]),
        })
        .strict()
        .parse(JSON.parse(readFileSync(creatorVisible, "utf8"))),
      peer = z
        .object({
          empty: z.boolean(),
          dev: z.string(),
          ino: z.string(),
          size: z.number().int().min(0),
          ownerOnly: z.boolean(),
          protected: z.boolean(),
          peerWriteOpen: z.enum(["opened", "denied", "other-error"]),
        })
        .strict()
        .parse(JSON.parse(readFileSync(peerSnapshot, "utf8"))),
      reply = z.discriminatedUnion("ok", [
        z
          .object({
            ok: z.literal(true),
            requestId: z.string(),
            state: z.literal("reserved"),
            diagnostics: z.array(z.unknown()).max(8),
            stages: z.array(z.string().max(40)).max(8),
            metadataReads: z.array(z.unknown()).max(16),
            peerWriteOpen: z.enum([
              "not-probed",
              "opened",
              "denied",
              "other-error",
            ]),
            creatorReadOpen: z.enum([
              "not-probed",
              "opened",
              "denied",
              "other-error",
            ]),
          })
          .strict(),
        z
          .object({
            ok: z.literal(false),
            reason: z.enum(["conflict", "held", "missing", "unexpected"]),
            diagnostics: z.array(z.unknown()).max(8),
            stages: z.array(z.string().max(40)).max(8),
            metadataReads: z.array(z.unknown()).max(16),
            peerWriteOpen: z.enum([
              "not-probed",
              "opened",
              "denied",
              "other-error",
            ]),
            creatorReadOpen: z.enum([
              "not-probed",
              "opened",
              "denied",
              "other-error",
            ]),
          })
          .strict(),
      ]);
    const results = [
      reply.parse(JSON.parse(readFileSync(creatorResult, "utf8"))),
      reply.parse(JSON.parse(readFileSync(peerResult, "utf8"))),
    ];
    const firstVisible = {
      ownerOnly: publication.ownerOnly,
      protected: publication.protected,
      sameIdentity:
        peer.dev === publication.dev && peer.ino === publication.ino,
      creatorReadOpen: publication.creatorReadOpen,
      peerWriteOpen: peer.peerWriteOpen,
    };
    process.stdout.write(
      `[fork-mutex-publication-facts] ${JSON.stringify({
        firstVisible,
        children: results.map((result) => ({
          ok: result.ok,
          reason: result.ok ? null : result.reason,
          stages: result.stages,
          metadataReads: result.metadataReads,
          diagnostics: result.diagnostics,
        })),
      }).slice(0, 5_000)}\n`,
    );
    expect(peer.empty).toBe(false);
    expect(publication.size).toBe(0);
    expect(peer.size).toBe(0);
    expect(peer.dev).toBe(publication.dev);
    expect(peer.ino).toBe(publication.ino);
    expect(peer.peerWriteOpen).toBe("denied");

    const winner = results.find((result) => result.ok),
      loser = results.find((result) => !result.ok);
    if (winner === undefined || loser === undefined)
      throw new Error(
        `Fork mutex publication lacked one winner/refusal; bounded results=${JSON.stringify(results).slice(0, 2_000)}`,
      );
    expect(winner.state).toBe("reserved");
    if (loser.reason !== "conflict")
      throw new Error(
        `Fork mutex publication loser was ${loser.reason}; bounded facts were emitted after cleanup.`,
      );
    expect(loser.reason).toBe("conflict");
    const records = createCodexChatForkJournal({ root, home }).list(projectId);
    expect(records.map((record) => record.requestId)).toEqual([
      winner.requestId,
    ]);
    const finalInfo = lstatSync(mutex, { bigint: true });
    expect(`${finalInfo.dev}:${finalInfo.ino}`).toBe(
      `${publication.dev}:${publication.ino}`,
    );
    assertOwnerOnly(mutex, "file", native);

    // This assertion is deliberately after release and full child cleanup so a
    // causal RED cannot strand either process or hide the winner/conflict proof.
    expect(publication.ownerOnly).toBe(true);
    expect(publication.protected).toBe(true);
    expect(peer.ownerOnly).toBe(true);
    expect(peer.protected).toBe(true);
  },
  20_000,
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
      if (kind === "mutex") {
        // CREATE_NEW must report a collision without changing the foreign
        // inode, its bytes, or its inherited ACL.
        expect(acl.createOwnerOnlyExclusive!(target).kind).toBe("exists");
      }
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
