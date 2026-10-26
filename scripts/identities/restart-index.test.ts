import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AclReading, AclTarget, WindowsAcl } from "../hearth/acl-windows";
import { FILE_ALL_ACCESS, SYSTEM_SID } from "../hearth/acl-windows";
import { scratchDirs } from "../test-scratch";
import {
  createRestartIdentityJournal,
  orderRestartIdentityNames,
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

function fakeAcl() {
  const protectedPaths = new Map<string, AclTarget>();
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
      const target =
        protectedPaths.get(key(path)) ??
        (protectedPaths.get(key(dirname(path))) === "directory"
          ? "file"
          : undefined);
      if (target === undefined)
        throw new Error("unrecognized ACL fixture path");
      return reading(target);
    },
    readInFolder(folder, name, maxBytes) {
      const directory = reading("directory");
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
      return {
        folder: directory,
        file: { reading: reading(target), bytes },
      };
    },
  };
  return {
    acl,
    protect(path: string, target: AclTarget) {
      acl.apply(path, target);
    },
  };
}

function profile() {
  return join(scratch.make("restart-identities-"), "profile");
}

const storageOptions = () => ({
  platform: "win32" as const,
  acl: fakeAcl().acl,
});

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
  });
  expect(recovered).toEqual({
    row: { ...identity, state: "attempted" },
    mayDispatch: false,
  });
  expect(repeated).toEqual({
    row: { ...identity, state: "attempted" },
    mayDispatch: false,
  });
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

test("journal name ordering normalizes reverse filesystem enumeration without filtering entries", () => {
  const later = "event-00000002-" + "b".repeat(64) + ".json";
  const earlier = "event-00000001-" + "a".repeat(64) + ".json";
  const unknown = "candidate.tmp";

  expect(orderRestartIdentityNames([later, unknown, earlier])).toEqual([
    unknown,
    earlier,
    later,
  ]);
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
