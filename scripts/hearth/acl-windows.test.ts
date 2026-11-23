import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AclEntry,
  type AclReading,
  type AclTarget,
  bunFfi,
  DIRECTORY_ACE_FLAGS,
  FILE_ALL_ACCESS,
  INHERITED_ACE,
  makeOwnerOnly,
  nativeWindowsAcl,
  OwnerOnlyError,
  ownerOnlyDacl,
  ownerOnlyDescriptor,
  ownerOnlyProblem,
  parseDacl,
  SYSTEM_SID,
  sidBytes,
  sidText,
  type WindowsAcl,
} from "./acl-windows";

const USER = "S-1-5-21-3623811015-3361044348-30300820-1013";

test("bunFfi is looked up, not imported: found under Bun, and refused with the reason in a runtime without it (Node, where Vite loads this module)", () => {
  expect(typeof bunFfi().dlopen).toBe("function");
  for (const lookup of [() => undefined, () => ({})])
    expect(() => bunFfi(lookup)).toThrow(
      "this runtime has no bun:ffi, so it cannot set a Windows ACL (the hearth runs under Bun)",
    );
});

test("sidBytes and sidText convert a SID both ways, and sidBytes refuses what is not a SID", () => {
  for (const sid of [
    USER,
    SYSTEM_SID,
    "S-1-5-32-545",
    "S-1-1-0",
    "S-1-16-8192",
  ])
    expect(sidText(sidBytes(sid))).toBe(sid);
  // S-1-5-18: revision 1, one sub-authority, authority 5 (big-endian), 18 (little-endian).
  expect([...sidBytes(SYSTEM_SID)]).toEqual([
    1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0,
  ]);
  for (const bad of [
    "",
    "S-1",
    "S-1-5",
    "S-2-5-18",
    "S-1-5-x",
    "S-1-5-4294967296",
    `S-1-5${"-1".repeat(16)}`,
  ])
    expect(() => sidBytes(bad)).toThrow("not a SID");
});

test("ownerOnlyDacl holds two allow entries, full control for the user then SYSTEM, inheritable on a directory only", () => {
  const entries = (target: AclTarget): AclEntry[] =>
    parseDacl(ownerOnlyDacl(USER, target));
  expect(entries("file")).toEqual([
    { type: 0, flags: 0, mask: FILE_ALL_ACCESS, sid: USER },
    { type: 0, flags: 0, mask: FILE_ALL_ACCESS, sid: SYSTEM_SID },
  ]);
  expect(entries("directory")).toEqual([
    { type: 0, flags: DIRECTORY_ACE_FLAGS, mask: FILE_ALL_ACCESS, sid: USER },
    {
      type: 0,
      flags: DIRECTORY_ACE_FLAGS,
      mask: FILE_ALL_ACCESS,
      sid: SYSTEM_SID,
    },
  ]);
});

test("ownerOnlyDescriptor is self-relative, owned by the user, with the protected owner-only DACL and no group or SACL", () => {
  const descriptor = ownerOnlyDescriptor(USER, "file");
  const view = new DataView(descriptor.buffer);
  const owner = sidBytes(USER);
  const dacl = ownerOnlyDacl(USER, "file");
  expect(view.getUint8(0)).toBe(1);
  // SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_DACL_PRESENT, and nothing else.
  expect(view.getUint16(2, true)).toBe(0x8000 | 0x1000 | 0x0004);
  expect(view.getUint32(4, true)).toBe(20);
  expect(view.getUint32(8, true)).toBe(0);
  expect(view.getUint32(12, true)).toBe(0);
  const daclAt = view.getUint32(16, true);
  expect(daclAt).toBe(20 + owner.length);
  expect(daclAt % 4).toBe(0);
  expect(sidText(descriptor.subarray(20, daclAt))).toBe(USER);
  expect(descriptor.subarray(daclAt)).toEqual(dacl);
  expect(descriptor.length).toBe(daclAt + dacl.length);
});

test("parseDacl refuses a DACL that does not hold together", () => {
  const good = ownerOnlyDacl(USER, "file");
  expect(() => parseDacl(good.subarray(0, 6))).toThrow("truncated");
  expect(() => parseDacl(good.subarray(0, good.length - 1))).toThrow(
    "truncated",
  );
  const badSize = good.slice();
  // The first entry's size, made larger than the DACL.
  new DataView(badSize.buffer).setUint16(10, 0x400, true);
  expect(() => parseDacl(badSize)).toThrow("malformed");
});

function reading(
  target: AclTarget,
  change: Partial<AclReading> = {},
): AclReading {
  return {
    owner: USER,
    protected: true,
    entries: parseDacl(ownerOnlyDacl(USER, target)),
    ...change,
  };
}

function withEntry(
  target: AclTarget,
  entry: Partial<AclEntry>,
  index = 0,
): AclReading {
  const read = reading(target);
  const entries = (read.entries ?? []).map((each, i) =>
    i === index ? { ...each, ...entry } : each,
  );
  return { ...read, entries };
}

test("ownerOnlyProblem accepts exactly the owner-only ACL, for a file and for a directory", () => {
  expect(ownerOnlyProblem(reading("file"), "file", USER)).toBeNull();
  expect(ownerOnlyProblem(reading("directory"), "directory", USER)).toBeNull();
  // The user's entry alone is enough: SYSTEM is allowed, not required.
  const userOnly = reading("file");
  expect(
    ownerOnlyProblem(
      { ...userOnly, entries: userOnly.entries?.slice(0, 1) ?? null },
      "file",
      USER,
    ),
  ).toBeNull();
});

test("ownerOnlyProblem names what is wrong with anything else", () => {
  const cases: Array<[AclReading, AclTarget, string]> = [
    [reading("file", { entries: null }), "file", "it has no DACL at all"],
    [
      reading("file", { owner: "S-1-5-32-544" }),
      "file",
      "its owner is S-1-5-32-544, not this user",
    ],
    [reading("file", { owner: null }), "file", "its owner is nobody"],
    [
      reading("file", { protected: false }),
      "file",
      "its DACL is not protected",
    ],
    [
      withEntry("file", { sid: "S-1-5-32-545" }, 1),
      "file",
      "its DACL grants S-1-5-32-545",
    ],
    [
      withEntry("file", { sid: "S-1-1-0" }, 1),
      "file",
      "its DACL grants S-1-1-0",
    ],
    [
      withEntry("file", { sid: null }, 1),
      "file",
      "its DACL grants an unknown trustee",
    ],
    [withEntry("file", { type: 1 }, 1), "file", "an entry of type 1"],
    [withEntry("file", { flags: INHERITED_ACE }), "file", "an inherited entry"],
    [withEntry("file", { flags: 0x8 }), "file", "does not apply to it"],
    [reading("file"), "directory", "is not inherited by what is created in it"],
    [
      withEntry("file", { mask: 0x120089 }),
      "file",
      "does not give this user full control",
    ],
    [
      reading("file", { entries: [] }),
      "file",
      "does not give this user full control",
    ],
  ];
  for (const [read, target, reason] of cases)
    expect(ownerOnlyProblem(read, target, USER)).toContain(reason);
});

test("makeOwnerOnly throws OwnerOnlyError when the ACL cannot be set, cannot be read, or reads back otherwise", () => {
  const acl = (arranged: Partial<WindowsAcl>): WindowsAcl => ({
    userSid: () => USER,
    apply: () => undefined,
    read: () => reading("file"),
    ...arranged,
  });
  const reasonOf = (attempt: () => void): string => {
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerOnlyError);
      return (error as OwnerOnlyError).reason;
    }
    return "no error";
  };
  expect(reasonOf(() => makeOwnerOnly("x", "file", acl({})))).toBe("no error");
  expect(
    reasonOf(() =>
      makeOwnerOnly(
        "x",
        "file",
        acl({
          apply: () => {
            throw new Error(
              "Windows refused to set its ACL (error 5, access denied)",
            );
          },
        }),
      ),
    ),
  ).toBe("Windows refused to set its ACL (error 5, access denied)");
  expect(
    reasonOf(() =>
      makeOwnerOnly(
        "x",
        "file",
        acl({
          read: () => {
            throw new Error(
              "Windows refused to read its ACL (error 2, the file was not found)",
            );
          },
        }),
      ),
    ),
  ).toBe("Windows refused to read its ACL (error 2, the file was not found)");
  expect(
    reasonOf(() =>
      makeOwnerOnly(
        "x",
        "file",
        acl({ read: () => reading("file", { protected: false }) }),
      ),
    ),
  ).toContain("its DACL is not protected");
});

// ── advapi32, for real (runs only on Windows) ──────────────────────────────

const ON_WINDOWS = process.platform === "win32";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** This user's SID as `whoami` prints it, by its absolute path, with argv only. */
function whoamiSid(): string {
  const whoami = join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "whoami.exe",
  );
  const result = Bun.spawnSync([whoami, "/user", "/fo", "csv", "/nh"], {
    stdout: "pipe",
  });
  const sid = /^"[^"]*","(S-1-\d+(?:-\d+)+)"$/.exec(
    result.stdout.toString().trim(),
  )?.[1];
  if (sid === undefined) throw new Error("whoami printed no SID");
  return sid;
}

test.skipIf(!ON_WINDOWS)(
  "Windows: the process token's user is the SID whoami prints",
  () => {
    expect(nativeWindowsAcl().userSid()).toBe(whoamiSid());
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: a newly created file is owned by the process token's default owner SID",
  () => {
    const root = mkdtempSync(join(tmpdir(), "af token owner "));
    temps.push(root);
    const file = join(root, "created-by-this-token");
    writeFileSync(file, "fixture");
    const acl = nativeWindowsAcl();
    const owner = acl.defaultOwnerSid?.();
    expect(owner).toMatch(/^S-1-\d+(?:-\d+)+$/);
    expect(acl.read(file).owner).toBe(owner ?? null);
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: a folder and a file read back as the owner-only ACL once it is applied, and as inherited before",
  () => {
    const root = mkdtempSync(join(tmpdir(), "af acl native "));
    temps.push(root);
    const dir = join(root, "tokens");
    mkdirSync(dir);
    const file = join(dir, "x.token");
    writeFileSync(file, "x");
    const acl = nativeWindowsAcl();
    const user = acl.userSid();
    const before = acl.read(file);
    expect(before.protected).toBe(false);
    expect(
      before.entries?.every((entry) => (entry.flags & INHERITED_ACE) !== 0),
    ).toBe(true);

    makeOwnerOnly(dir, "directory");
    makeOwnerOnly(file, "file");
    expect(acl.read(dir)).toEqual({
      owner: user,
      protected: true,
      entries: parseDacl(ownerOnlyDacl(user, "directory")),
    });
    expect(acl.read(file)).toEqual({
      owner: user,
      protected: true,
      entries: parseDacl(ownerOnlyDacl(user, "file")),
    });
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: a path that does not exist is refused with the reason",
  () => {
    const root = mkdtempSync(join(tmpdir(), "af acl native "));
    temps.push(root);
    expect(() => makeOwnerOnly(join(root, "missing"), "file")).toThrow(
      "could not be made readable by this OS user only: Windows refused to set its ACL (error 2, the file was not found)",
    );
  },
);

test.skipIf(!ON_WINDOWS)(
  "Windows: readInFolder judges the folder a junction leads to, and reads a file relative to that folder's handle, through no junction in its name (x1gs.3.38)",
  () => {
    const root = mkdtempSync(join(tmpdir(), "af acl native "));
    temps.push(root);
    const target = join(root, "target");
    mkdirSync(join(target, "sub"), { recursive: true });
    writeFileSync(join(target, "a.lock"), "lock text");
    writeFileSync(join(target, "sub", "b.json"), "{}");
    const link = join(root, "link");
    symlinkSync(target, link, "junction");
    // A junction inside the folder, to a folder that holds an a.lock of its own.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "a.lock"), "another");
    symlinkSync(elsewhere, join(target, "loop"), "junction");
    makeOwnerOnly(target, "directory");
    const acl = nativeWindowsAcl();
    const read = acl.readInFolder?.(link, "a.lock", 1024);
    // The target's DACL, not the junction's, which inherited from the folder above.
    expect(read?.folder).toEqual(acl.read(target));
    expect(read?.folder).not.toEqual(acl.read(link));
    // The file's own owner and DACL (an elevated process's files belong to the Administrators).
    expect(read?.file?.reading).toEqual(acl.read(join(target, "a.lock")));
    expect(new TextDecoder().decode(read?.file?.bytes)).toBe("lock text");
    expect(
      new TextDecoder().decode(
        acl.readInFolder?.(link, "sub\\b.json", 1024)?.file?.bytes,
      ),
    ).toBe("{}");
    expect(acl.readInFolder?.(link, "missing.lock", 1024)?.file).toBeNull();
    expect(acl.readInFolder?.(link, null, 1024)?.file).toBeNull();
    expect(
      acl.readInFolder?.(join(root, "missing"), "a.lock", 1024),
    ).toBeNull();
    expect(() => acl.readInFolder?.(link, "loop\\a.lock", 1024)).toThrow(
      "Windows refused to open loop\\a.lock in the folder (status 0xc000050b)",
    );
    expect(() => acl.readInFolder?.(link, "a.lock", 4)).toThrow(
      "a.lock is larger than 4 bytes",
    );
  },
);
