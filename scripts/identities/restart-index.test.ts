import { afterEach, expect, test } from "bun:test";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AclReading, AclTarget, WindowsAcl } from "../hearth/acl-windows";
import { FILE_ALL_ACCESS, SYSTEM_SID } from "../hearth/acl-windows";
import { scratchDirs } from "../test-scratch";
import {
  createRestartIdentityJournal,
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
  return acl;
}

function profile() {
  return join(scratch.make("restart-identities-"), "profile");
}

const storageOptions = () => ({ platform: "win32" as const, acl: fakeAcl() });

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
