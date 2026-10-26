import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AclReading, AclTarget, WindowsAcl } from "../hearth/acl-windows";
import { FILE_ALL_ACCESS, SYSTEM_SID } from "../hearth/acl-windows";
import { markReadOnlyCapabilityRefusal } from "../sessions/read-only-capability-refusal";
import { scratchDirs } from "../test-scratch";
import {
  attestEmptyInitialStart,
  createInitialStartAttempt,
  markKnownPreacceptPreparationRefusal,
  noteInitialStartPreparationRefusal,
  proofForInitialStartRefusal,
} from "./preaccept-not-sent-proof";
import {
  createRestartIdentityJournal,
  type RestartIdentityInput,
  RestartIdentityJournalError,
} from "./restart-index";

const scratch = scratchDirs({ tempDir: realpathSync.native(tmpdir()) });
afterEach(() => scratch.cleanup());

const USER = "S-1-5-21-1-2-3-1001";
const PROJECT = "project-123e4567-e89b-42d3-a456-426614174000";
const request = (
  overrides: Partial<
    Parameters<ReturnType<typeof createRestartIdentityJournal>["reserve"]>[0]
  > = {},
) => ({
  version: 1 as const,
  address: { family: "owned-session-start" as const, projectId: PROJECT },
  workspace: "c:/served/repo",
  requestId: "7b5b2b32-4bcc-4a1c-92c8-61dd39234d82",
  requestHash: "a".repeat(64),
  provider: "claude" as const,
  mode: "task" as const,
  ...overrides,
});

function makePreacceptProof(
  identity: RestartIdentityInput,
  attemptGeneration: number,
) {
  const attempt = createInitialStartAttempt(
    identity,
    attemptGeneration,
    attestEmptyInitialStart(identity),
  );
  const capabilityRefusal = markReadOnlyCapabilityRefusal(
    new Error("test read-only capability refusal"),
  );
  const refusal = markKnownPreacceptPreparationRefusal(
    new Error("controlled preparation refusal"),
    capabilityRefusal,
  );
  noteInitialStartPreparationRefusal(attempt, refusal);
  const proof = proofForInitialStartRefusal(attempt);
  if (proof === null) throw new Error("Expected the preaccept proof");
  return proof;
}

function fakeAcl() {
  const protectedPaths = new Map<string, AclTarget>();
  const overrides = new Map<string, AclReading>();
  let failNextRead: ((path: string) => boolean) | undefined;
  let failNextFolderRead: ((name: string | null) => boolean) | undefined;
  let afterNextRead: ((path: string) => boolean) | undefined;
  let afterNextReadEffect: ((path: string) => void) | undefined;
  let afterNextFolderRead: ((name: string | null) => boolean) | undefined;
  let afterNextFolderReadEffect:
    | ((folder: string, name: string | null) => void)
    | undefined;
  const key = (path: string) => {
    const info = lstatSync(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  };
  const reading = (target: AclTarget): AclReading => ({
    owner: USER,
    protected: true,
    entries: [USER, SYSTEM_SID].map((sid) => ({
      type: 0,
      flags: target === "directory" ? 0x3 : 0,
      mask: FILE_ALL_ACCESS,
      sid,
    })),
  });
  const acl: WindowsAcl = {
    userSid: () => USER,
    apply(path, target) {
      protectedPaths.set(key(path), target);
    },
    read(path) {
      if (failNextRead?.(path)) {
        failNextRead = undefined;
        throw new Error("injected ACL read failure");
      }
      let result = overrides.get(key(path));
      if (result === undefined) {
        const target =
          protectedPaths.get(key(path)) ??
          (protectedPaths.get(key(dirname(path))) === "directory"
            ? "file"
            : undefined);
        if (target === undefined)
          throw new Error("unrecognized ACL fixture path");
        result = reading(target);
      }
      if (afterNextRead?.(path)) {
        const effect = afterNextReadEffect;
        afterNextRead = undefined;
        afterNextReadEffect = undefined;
        effect?.(path);
      }
      return result;
    },
    readInFolder(folder, name, maxBytes) {
      if (failNextFolderRead?.(name)) {
        failNextFolderRead = undefined;
        throw new Error("injected opened-file read failure");
      }
      const directory = overrides.get(key(folder)) ?? reading("directory");
      if (name === null) return { folder: directory, file: null };
      const file = join(folder, name);
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { folder: directory, file: null };
        throw error;
      }
      if (bytes.byteLength > maxBytes) throw new Error("file exceeds limit");
      const target = protectedPaths.get(key(file));
      if (target === undefined)
        throw new Error("unrecognized ACL fixture file");
      if (afterNextFolderRead?.(name)) {
        const effect = afterNextFolderReadEffect;
        afterNextFolderRead = undefined;
        afterNextFolderReadEffect = undefined;
        effect?.(folder, name);
      }
      return {
        folder: directory,
        file: { reading: overrides.get(key(file)) ?? reading(target), bytes },
      };
    },
  };
  return {
    acl,
    protect(path: string, target: AclTarget) {
      acl.apply(path, target);
    },
    override(path: string, value: AclReading) {
      overrides.set(key(path), value);
    },
    failAclReadOnce(predicate: (path: string) => boolean) {
      failNextRead = predicate;
    },
    failFileReadOnce(predicate: (name: string | null) => boolean) {
      failNextFolderRead = predicate;
    },
    afterAclReadOnce(
      predicate: (path: string) => boolean,
      effect: (path: string) => void,
    ) {
      afterNextRead = predicate;
      afterNextReadEffect = effect;
    },
    afterFileReadOnce(
      predicate: (name: string | null) => boolean,
      effect: (folder: string, name: string | null) => void,
    ) {
      afterNextFolderRead = predicate;
      afterNextFolderReadEffect = effect;
    },
  };
}

function profile() {
  return join(scratch.make("restart-identities-"), "profile");
}

test("a linked ancestor is refused before creating any missing profile path", async () => {
  const root = scratch.make("restart-identities-linked-ancestor-");
  const target = join(root, "target");
  const linked = join(root, "linked");
  mkdirSync(target);
  symlinkSync(target, linked, "junction");
  expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  expect(realpathSync.native(linked)).toBe(realpathSync.native(target));
  const before = readdirSync(target);

  await expect(
    createRestartIdentityJournal(join(linked, "nested", "profile")).reserve(
      request(),
    ),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);

  expect(readdirSync(target)).toEqual(before);
});

const storageOptions = () => ({
  platform: "win32" as const,
  acl: fakeAcl().acl,
});

function replaceFileIdentity(path: string): void {
  const replacement = `${path}.replacement`;
  const displaced = `${path}.displaced`;
  copyFileSync(path, replacement);
  renameSync(path, displaced);
  renameSync(replacement, path);
  unlinkSync(displaced);
}

function rewriteLastEvent(
  directory: string,
  rewrite: (event: Record<string, unknown>) => Record<string, unknown>,
): void {
  const name = readdirSync(directory)
    .filter((entry) => entry.startsWith("event-"))
    .sort()
    .at(-1);
  if (name === undefined) throw new Error("missing journal event");
  const path = join(directory, name);
  const event = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  const text = JSON.stringify(rewrite(event));
  writeFileSync(path, text);
  const digest = createHash("sha256").update(text).digest("hex");
  const sequence = String(event.sequence).padStart(8, "0");
  renameSync(path, join(directory, `event-${sequence}-${digest}.json`));
}

test("a reserved identity persists as one strict metadata event and exact reserve is idempotent", async () => {
  const home = profile();
  const options = storageOptions();
  const journal = createRestartIdentityJournal(home, options);
  const reserved = await journal.reserve(request());

  expect(reserved).toMatchObject({ ...request(), state: "reserved" });
  expect(
    await createRestartIdentityJournal(home, options).list({
      address: request().address,
      workspace: request().workspace,
    }),
  ).toEqual([reserved]);
  expect(await journal.reserve(request())).toEqual(reserved);
});

test("separate journal instances serialize the attempted fence against reserved-only retirement", async () => {
  const home = profile();
  const options = storageOptions();
  const writer = createRestartIdentityJournal(home, options);
  const canceller = createRestartIdentityJournal(home, options);
  const identity = request();
  await writer.reserve(identity);

  const outcomes = await Promise.allSettled([
    writer.beginAttempt(identity),
    canceller.retireReserved(identity),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);

  const scope = { address: identity.address, workspace: identity.workspace };
  const rows = await createRestartIdentityJournal(home, options).list(scope);
  expect(rows).toHaveLength(1);
  const state = rows[0]?.state;
  expect(state === "attempted" || state === "retired").toBe(true);
  if (state === "retired") {
    await expect(writer.beginAttempt(identity)).rejects.toBeInstanceOf(
      RestartIdentityJournalError,
    );
  } else {
    await expect(canceller.retireReserved(identity)).rejects.toBeInstanceOf(
      RestartIdentityJournalError,
    );
  }
});

test("only the first durable attempted fence authorizes dispatch", async () => {
  const home = profile();
  const options = storageOptions();
  const identity = request();
  const journal = createRestartIdentityJournal(home, options);
  await journal.reserve(identity);

  const first = await journal.beginAttempt(identity);
  const recovered = await createRestartIdentityJournal(
    home,
    options,
  ).beginAttempt(identity);
  const repeated = await journal.beginAttempt(identity);

  expect(first).toEqual({
    row: { ...identity, state: "attempted" },
    mayDispatch: true,
    attemptGeneration: 1,
  });
  expect(recovered).toEqual({
    row: { ...identity, state: "attempted" },
    mayDispatch: false,
    attemptGeneration: 1,
  });
  expect(repeated).toEqual({
    row: { ...identity, state: "attempted" },
    mayDispatch: false,
    attemptGeneration: 1,
  });
});

test("only an opaque proof for the current attempt settles durable not-sent", async () => {
  const home = profile();
  const options = storageOptions();
  const identity = request();
  const journal = createRestartIdentityJournal(home, options);
  await journal.reserve(identity);
  const claim = await journal.beginAttempt(identity);
  const validProof = makePreacceptProof(identity, claim.attemptGeneration);

  await expect(
    journal.settleNotSent(
      { ...identity, requestHash: "b".repeat(64) },
      validProof,
    ),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
  await expect(
    journal.settleNotSent(identity, {} as never),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
  expect(
    (
      await journal.lookup(
        { address: identity.address, workspace: identity.workspace },
        identity.requestId,
      )
    )?.state,
  ).toBe("attempted");

  expect(await journal.settleNotSent(identity, validProof)).toMatchObject({
    ...identity,
    state: "not-sent",
  });
  const recovered = createRestartIdentityJournal(home, options);
  expect(
    (
      await recovered.lookup(
        { address: identity.address, workspace: identity.workspace },
        identity.requestId,
      )
    )?.state,
  ).toBe("not-sent");
  await expect(recovered.retireReserved(identity)).rejects.toBeInstanceOf(
    RestartIdentityJournalError,
  );

  const retry = await recovered.beginAttempt(identity);
  expect(retry).toMatchObject({ mayDispatch: true, attemptGeneration: 2 });
  await expect(
    recovered.settleNotSent(
      identity,
      makePreacceptProof(identity, claim.attemptGeneration),
    ),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
  expect(
    await createRestartIdentityJournal(home, options).beginAttempt(identity),
  ).toMatchObject({ mayDispatch: false, attemptGeneration: 2 });
});

test("concurrent explicit retries after not-sent grant one new generation", async () => {
  const home = profile();
  const options = storageOptions();
  const identity = request();
  const firstJournal = createRestartIdentityJournal(home, options);
  await firstJournal.reserve(identity);
  const firstClaim = await firstJournal.beginAttempt(identity);
  await firstJournal.settleNotSent(
    identity,
    makePreacceptProof(identity, firstClaim.attemptGeneration),
  );

  const results = await Promise.all([
    firstJournal.beginAttempt(identity),
    createRestartIdentityJournal(home, options).beginAttempt(identity),
  ]);
  expect(results.filter((result) => result.mayDispatch)).toHaveLength(1);
  expect(results.filter((result) => !result.mayDispatch)).toHaveLength(1);
  expect(results.every((result) => result.attemptGeneration === 2)).toBe(true);
});

test("verified source may promote not-sent without another attempt claim", async () => {
  const home = profile();
  const options = {
    ...storageOptions(),
    verifyAdmission: () => ({ source: "verified-original" }),
  };
  const identity = request();
  const journal = createRestartIdentityJournal(home, options);
  await journal.reserve(identity);
  const claim = await journal.beginAttempt(identity);
  await journal.settleNotSent(
    identity,
    makePreacceptProof(identity, claim.attemptGeneration),
  );

  const admitted = await journal.admit(identity);
  expect(admitted.row.state).toBe("admitted");
  expect(admitted.evidence).toEqual({ source: "verified-original" });
  expect(
    (await createRestartIdentityJournal(home, options).beginAttempt(identity))
      .mayDispatch,
  ).toBe(false);
});

test("replay rejects missing retry/admission generations and generation on retirement", async () => {
  const retryHome = profile();
  const retryOptions = storageOptions();
  const identity = request();
  const retryJournal = createRestartIdentityJournal(retryHome, retryOptions);
  await retryJournal.reserve(identity);
  const firstClaim = await retryJournal.beginAttempt(identity);
  await retryJournal.settleNotSent(
    identity,
    makePreacceptProof(identity, firstClaim.attemptGeneration),
  );
  await retryJournal.beginAttempt(identity);
  rewriteLastEvent(join(retryHome, "restart-identities"), (event) => {
    const { attemptGeneration: _removed, ...legacyShape } = event;
    return legacyShape;
  });
  await expect(
    createRestartIdentityJournal(retryHome, retryOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);

  const admitHome = profile();
  const admitOptions = {
    ...storageOptions(),
    verifyAdmission: () => ({ source: "verified-original" }),
  };
  const admitJournal = createRestartIdentityJournal(admitHome, admitOptions);
  await admitJournal.reserve(identity);
  const admitClaim = await admitJournal.beginAttempt(identity);
  await admitJournal.settleNotSent(
    identity,
    makePreacceptProof(identity, admitClaim.attemptGeneration),
  );
  await admitJournal.admit(identity);
  rewriteLastEvent(join(admitHome, "restart-identities"), (event) => {
    const { attemptGeneration: _removed, ...legacyShape } = event;
    return legacyShape;
  });
  await expect(
    createRestartIdentityJournal(admitHome, admitOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);

  const retiredHome = profile();
  const retiredOptions = storageOptions();
  const retiredJournal = createRestartIdentityJournal(
    retiredHome,
    retiredOptions,
  );
  await retiredJournal.reserve(identity);
  await retiredJournal.retireReserved(identity);
  rewriteLastEvent(join(retiredHome, "restart-identities"), (event) => ({
    version: event.version,
    sequence: event.sequence,
    parentDigest: event.parentDigest,
    operation: event.operation,
    attemptGeneration: 1,
    row: event.row,
  }));
  await expect(
    createRestartIdentityJournal(retiredHome, retiredOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("simultaneous independent first claims grant dispatch to exactly one caller", async () => {
  const home = profile();
  const options = storageOptions();
  const identity = request();
  const first = createRestartIdentityJournal(home, options);
  const second = createRestartIdentityJournal(home, options);

  const claims = await Promise.all([
    first.beginAttempt(identity),
    second.beginAttempt(identity),
  ]);
  expect(claims.filter((claim) => claim.mayDispatch)).toHaveLength(1);
  expect(claims.filter((claim) => !claim.mayDispatch)).toHaveLength(1);
  expect(claims.every((claim) => claim.row.state === "attempted")).toBe(true);
});

test("cancellation wins before the fence or loses after the fence, never both", async () => {
  const identity = request();

  const cancelFirstHome = profile();
  const cancelFirstOptions = storageOptions();
  const cancelFirst = createRestartIdentityJournal(
    cancelFirstHome,
    cancelFirstOptions,
  );
  await cancelFirst.reserve(identity);
  await cancelFirst.retireReserved(identity);
  await expect(cancelFirst.beginAttempt(identity)).rejects.toBeInstanceOf(
    RestartIdentityJournalError,
  );
  expect(
    (
      await cancelFirst.list({
        address: identity.address,
        workspace: identity.workspace,
      })
    )[0]?.state,
  ).toBe("retired");

  const fenceFirstHome = profile();
  const fenceFirstOptions = storageOptions();
  const fenceFirst = createRestartIdentityJournal(
    fenceFirstHome,
    fenceFirstOptions,
  );
  await fenceFirst.reserve(identity);
  const claim = await fenceFirst.beginAttempt(identity);
  expect(claim.mayDispatch).toBe(true);
  await expect(fenceFirst.retireReserved(identity)).rejects.toBeInstanceOf(
    RestartIdentityJournalError,
  );
  expect(
    (
      await fenceFirst.list({
        address: identity.address,
        workspace: identity.workspace,
      })
    )[0]?.state,
  ).toBe("attempted");
});

test("a post-publication readback failure keeps the fence and disables repeat dispatch", async () => {
  const home = profile();
  const fixture = fakeAcl();
  const options = { platform: "win32" as const, acl: fixture.acl };
  const identity = request();
  const journal = createRestartIdentityJournal(home, options);
  await journal.reserve(identity);
  fixture.failFileReadOnce(
    (name) => name?.startsWith("event-00000002-") ?? false,
  );

  await expect(journal.beginAttempt(identity)).rejects.toBeInstanceOf(
    RestartIdentityJournalError,
  );
  const recovered = createRestartIdentityJournal(home, options);
  expect(
    (
      await recovered.lookup(
        { address: identity.address, workspace: identity.workspace },
        identity.requestId,
      )
    )?.state,
  ).toBe("attempted");
  expect((await recovered.beginAttempt(identity)).mayDispatch).toBe(false);
});

test("a post-publication ACL failure preserves ambiguous stage evidence and blocks reads", async () => {
  const home = profile();
  const fixture = fakeAcl();
  const options = { platform: "win32" as const, acl: fixture.acl };
  const identity = request();
  const journal = createRestartIdentityJournal(home, options);
  await journal.reserve(identity);
  fixture.failAclReadOnce(
    (path) => path.endsWith(".json") && path.includes("event-00000002-"),
  );

  await expect(journal.beginAttempt(identity)).rejects.toBeInstanceOf(
    RestartIdentityJournalError,
  );
  const directory = join(home, "restart-identities");
  const staged = readdirSync(directory).filter((name) => name.endsWith(".tmp"));
  expect(staged).toHaveLength(1);
  expect(lstatSync(join(directory, staged[0]!)).nlink).toBe(2);
  await expect(
    createRestartIdentityJournal(home, options).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("nonprivate profile, index, event, lock, and sidecar ACLs all fail closed", async () => {
  const identity = request();
  const badAcl: AclReading = {
    owner: "S-1-5-21-9-9-9-9999",
    protected: true,
    entries: [
      { type: 0, flags: 0, mask: FILE_ALL_ACCESS, sid: "S-1-5-21-9-9-9-9999" },
    ],
  };
  const assertUnavailable = async (
    home: string,
    options: { platform: "win32"; acl: WindowsAcl },
  ) => {
    await expect(
      createRestartIdentityJournal(home, options).list({
        address: identity.address,
        workspace: identity.workspace,
      }),
    ).rejects.toBeInstanceOf(RestartIdentityJournalError);
  };

  const profileHome = profile();
  const profileFixture = fakeAcl();
  const profileOptions = {
    platform: "win32" as const,
    acl: profileFixture.acl,
  };
  await createRestartIdentityJournal(profileHome, profileOptions).reserve(
    identity,
  );
  profileFixture.override(profileHome, badAcl);
  await assertUnavailable(profileHome, profileOptions);

  const indexHome = profile();
  const indexFixture = fakeAcl();
  const indexOptions = { platform: "win32" as const, acl: indexFixture.acl };
  await createRestartIdentityJournal(indexHome, indexOptions).reserve(identity);
  indexFixture.override(join(indexHome, "restart-identities"), badAcl);
  await assertUnavailable(indexHome, indexOptions);

  const eventHome = profile();
  const eventFixture = fakeAcl();
  const eventOptions = { platform: "win32" as const, acl: eventFixture.acl };
  await createRestartIdentityJournal(eventHome, eventOptions).reserve(identity);
  const eventDirectory = join(eventHome, "restart-identities");
  const eventName = readdirSync(eventDirectory).find((name) =>
    name.startsWith("event-"),
  );
  expect(eventName).toBeDefined();
  eventFixture.override(join(eventDirectory, eventName!), badAcl);
  await assertUnavailable(eventHome, eventOptions);

  const lockHome = profile();
  const lockFixture = fakeAcl();
  const lockOptions = { platform: "win32" as const, acl: lockFixture.acl };
  await createRestartIdentityJournal(lockHome, lockOptions).reserve(identity);
  lockFixture.override(
    join(lockHome, "restart-identities", "transaction.lock.db"),
    badAcl,
  );
  await assertUnavailable(lockHome, lockOptions);

  const sidecarHome = profile();
  const sidecarFixture = fakeAcl();
  const sidecarOptions = {
    platform: "win32" as const,
    acl: sidecarFixture.acl,
  };
  await createRestartIdentityJournal(sidecarHome, sidecarOptions).reserve(
    identity,
  );
  const sidecarPath = join(
    sidecarHome,
    "restart-identities",
    "transaction.lock.db-wal",
  );
  writeFileSync(sidecarPath, "sidecar");
  sidecarFixture.protect(sidecarPath, "file");
  sidecarFixture.override(sidecarPath, badAcl);
  await assertUnavailable(sidecarHome, sidecarOptions);
});

test("inherited journal directory ACLs fail closed even without outsider write rights", async () => {
  const identity = request();
  const home = profile();
  const fixture = fakeAcl();
  const options = { platform: "win32" as const, acl: fixture.acl };
  await createRestartIdentityJournal(home, options).reserve(identity);
  fixture.override(join(home, "restart-identities"), {
    owner: USER,
    protected: false,
    entries: [
      { type: 0, flags: 0, mask: FILE_ALL_ACCESS, sid: USER },
      { type: 0, flags: 0, mask: FILE_ALL_ACCESS, sid: SYSTEM_SID },
    ],
  });

  await expect(
    createRestartIdentityJournal(home, options).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("event and lock inode substitutions during checked reads fail closed", async () => {
  const identity = request();

  const eventHome = profile();
  const eventFixture = fakeAcl();
  const eventOptions = { platform: "win32" as const, acl: eventFixture.acl };
  await createRestartIdentityJournal(eventHome, eventOptions).reserve(identity);
  eventFixture.afterFileReadOnce(
    (name) => name?.startsWith("event-") ?? false,
    (folder, name) => {
      const path = join(folder, name!);
      replaceFileIdentity(path);
      eventFixture.protect(path, "file");
    },
  );
  await expect(
    createRestartIdentityJournal(eventHome, eventOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);

  const lockHome = profile();
  const lockFixture = fakeAcl();
  const lockOptions = { platform: "win32" as const, acl: lockFixture.acl };
  await createRestartIdentityJournal(lockHome, lockOptions).reserve(identity);
  const lockPath = join(lockHome, "restart-identities", "transaction.lock.db");
  lockFixture.afterAclReadOnce(
    (path) => path === lockPath,
    (path) => {
      replaceFileIdentity(path);
      lockFixture.protect(path, "file");
    },
  );
  await expect(
    createRestartIdentityJournal(lockHome, lockOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("event replay rejects duplicate keys and future versions", async () => {
  const identity = request();

  const duplicateHome = profile();
  const duplicateOptions = storageOptions();
  await createRestartIdentityJournal(duplicateHome, duplicateOptions).reserve(
    identity,
  );
  const duplicateDirectory = join(duplicateHome, "restart-identities");
  const duplicateName = readdirSync(duplicateDirectory).find((name) =>
    name.startsWith("event-"),
  );
  expect(duplicateName).toBeDefined();
  const duplicatePath = join(duplicateDirectory, duplicateName!);
  const duplicateText = readFileSync(duplicatePath, "utf8").replace(
    '"version":1',
    '"version":1,"version":1',
  );
  writeFileSync(duplicatePath, duplicateText);
  const duplicateDigest = createHash("sha256")
    .update(duplicateText)
    .digest("hex");
  renameSync(
    duplicatePath,
    join(duplicateDirectory, `event-00000001-${duplicateDigest}.json`),
  );
  await expect(
    createRestartIdentityJournal(duplicateHome, duplicateOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);

  const futureHome = profile();
  const futureOptions = storageOptions();
  await createRestartIdentityJournal(futureHome, futureOptions).reserve(
    identity,
  );
  const futureDirectory = join(futureHome, "restart-identities");
  const futureName = readdirSync(futureDirectory).find((name) =>
    name.startsWith("event-"),
  );
  expect(futureName).toBeDefined();
  const futurePath = join(futureDirectory, futureName!);
  const futureEvent = JSON.parse(readFileSync(futurePath, "utf8")) as Record<
    string,
    unknown
  >;
  futureEvent.version = 2;
  const futureText = JSON.stringify(futureEvent);
  writeFileSync(futurePath, futureText);
  const futureDigest = createHash("sha256").update(futureText).digest("hex");
  renameSync(
    futurePath,
    join(futureDirectory, `event-00000001-${futureDigest}.json`),
  );
  await expect(
    createRestartIdentityJournal(futureHome, futureOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("a UUID cannot be reused from another project or workspace scope", async () => {
  const journal = createRestartIdentityJournal(profile(), storageOptions());
  const identity = request();
  await journal.reserve(identity);

  await expect(
    journal.reserve(
      request({
        address: {
          family: "owned-session-start",
          projectId: "project-223e4567-e89b-42d3-a456-426614174000",
        },
        workspace: "c:/served/other-repo",
      }),
    ),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("recovery replays the complete hash chain when enumeration is reverse-created", async () => {
  const home = profile();
  const options = storageOptions();
  const identity = request();
  const journal = createRestartIdentityJournal(home, options);
  await journal.reserve(identity);
  await journal.retireReserved(identity);

  const directory = join(home, "restart-identities");
  const eventFiles = readdirSync(directory)
    .filter((name) => name.startsWith("event-"))
    .sort();
  const held = Array.from(
    { length: eventFiles.length },
    (_, index) => `reverse-hold-${index}`,
  );
  for (let index = 0; index < eventFiles.length; index++) {
    renameSync(
      join(directory, eventFiles[index]!),
      join(directory, held[index]!),
    );
  }
  for (let index = 0; index < eventFiles.length; index++) {
    const reverseIndex = eventFiles.length - index - 1;
    renameSync(
      join(directory, held[reverseIndex]!),
      join(directory, eventFiles[reverseIndex]!),
    );
  }

  expect(
    await createRestartIdentityJournal(home, options).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).toMatchObject([{ requestId: identity.requestId, state: "retired" }]);
});

test("replay still rejects namespace debris and a missing sequence predecessor", async () => {
  const identity = request();
  const debrisHome = profile();
  const debrisFixture = fakeAcl();
  const debrisOptions = { platform: "win32" as const, acl: debrisFixture.acl };
  await createRestartIdentityJournal(debrisHome, debrisOptions).reserve(
    identity,
  );
  const debrisPath = join(debrisHome, "restart-identities", "candidate.tmp");
  writeFileSync(debrisPath, "unrecognized");
  debrisFixture.protect(debrisPath, "file");
  await expect(
    createRestartIdentityJournal(debrisHome, debrisOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);

  const gapHome = profile();
  const gapOptions = storageOptions();
  const gapJournal = createRestartIdentityJournal(gapHome, gapOptions);
  await gapJournal.reserve(identity);
  await gapJournal.retireReserved(identity);
  const directory = join(gapHome, "restart-identities");
  const firstEvent = readdirSync(directory).find((name) =>
    name.startsWith("event-00000001-"),
  );
  expect(firstEvent).toBeDefined();
  unlinkSync(join(directory, firstEvent!));
  await expect(
    createRestartIdentityJournal(gapHome, gapOptions).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("event bytes must use the fixed schema key order even with a matching digest name", async () => {
  const home = profile();
  const options = storageOptions();
  const identity = request();
  await createRestartIdentityJournal(home, options).reserve(identity);
  const directory = join(home, "restart-identities");
  const [originalName] = readdirSync(directory).filter((name) =>
    name.startsWith("event-"),
  );
  expect(originalName).toBeDefined();
  const path = join(directory, originalName!);
  const event = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  const reordered = JSON.stringify(
    Object.fromEntries(Object.entries(event).reverse()),
  );
  writeFileSync(path, reordered);
  const digest = createHash("sha256").update(reordered).digest("hex");
  renameSync(path, join(directory, `event-00000001-${digest}.json`));

  await expect(
    createRestartIdentityJournal(home, options).list({
      address: identity.address,
      workspace: identity.workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});

test("replay refuses a journal that exceeds the row budget", async () => {
  const home = profile();
  const fixture = fakeAcl();
  const options = { platform: "win32" as const, acl: fixture.acl };
  const journal = createRestartIdentityJournal(home, options);
  await journal.reserve(request());
  const directory = join(home, "restart-identities");
  for (const name of readdirSync(directory).filter((item) =>
    item.startsWith("event-"),
  )) {
    unlinkSync(join(directory, name));
  }

  let parentDigest: string | null = null;
  for (let sequence = 1; sequence <= 1_001; sequence++) {
    const suffix = sequence.toString(16).padStart(8, "0");
    const input = request({
      address: {
        family: "owned-session-start",
        projectId: `project-${suffix}-e89b-42d3-a456-426614174000`,
      },
      requestId: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    });
    const row = { ...input, state: "reserved" as const };
    const event: {
      version: 1;
      sequence: number;
      parentDigest: string | null;
      operation: "reserve";
      row: RestartIdentityInput & { state: "reserved" };
    } = {
      version: 1,
      sequence,
      parentDigest,
      operation: "reserve",
      row,
    };
    const text = JSON.stringify(event)!;
    const bytes = Buffer.from(text, "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = join(
      directory,
      `event-${String(sequence).padStart(8, "0")}-${digest}.json`,
    );
    writeFileSync(path, bytes, { mode: 0o600 });
    fixture.protect(path, "file");
    parentDigest = digest;
  }

  await expect(
    journal.list({
      address: request().address,
      workspace: request().workspace,
    }),
  ).rejects.toBeInstanceOf(RestartIdentityJournalError);
});
