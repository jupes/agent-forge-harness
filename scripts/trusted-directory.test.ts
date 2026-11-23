import { expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  canonicalTrustedDirectory,
  type TrustedDirectoryProbe,
} from "./trusted-directory";

type Entry = {
  dev: bigint;
  ino: bigint;
  directory: boolean;
  symlink: boolean;
  reparse: "plain" | "reparse" | "unknown";
};
const entry = (ino: number, update: Partial<Entry> = {}): Entry => ({
  dev: 1n,
  ino: BigInt(ino),
  directory: true,
  symlink: false,
  reparse: "plain",
  ...update,
});
const key = (path: string) => path.replaceAll("/", "\\").toLowerCase();

function probe(
  entries: Map<string, Entry>,
  realpath: (path: string) => string = (path) => path,
  afterRealpath?: () => void,
): TrustedDirectoryProbe {
  let count = 0;
  return {
    platform: "win32",
    path: win32,
    lstat(path) {
      const found = entries.get(key(path));
      if (!found) {
        const error = Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return {
        dev: found.dev,
        ino: found.ino,
        isDirectory: () => found.directory,
        isSymbolicLink: () => found.symlink,
      };
    },
    realpath(path) {
      const physical = realpath(path);
      if (++count === 1) afterRealpath?.();
      return physical;
    },
    reparseKind(path) {
      return entries.get(key(path))?.reparse ?? "unknown";
    },
  };
}

function aliases() {
  return new Map<string, Entry>([
    ["c:\\", entry(1)],
    ["c:\\users", entry(2)],
    ["c:\\users\\alice~1", entry(3)],
    ["c:\\users\\alice smith", entry(3)],
    ["c:\\users\\alice~1\\profile", entry(4)],
    ["c:\\users\\alice smith\\profile", entry(4)],
  ]);
}

test("trusted directory resolves a short spelling only through the same checked filesystem objects", () => {
  const entries = aliases();
  expect(
    canonicalTrustedDirectory(
      "C:\\Users\\ALICE~1\\Profile\\restart-identities",
      probe(entries, () => "C:\\Users\\Alice Smith\\Profile"),
    ),
  ).toBe("C:\\Users\\Alice Smith\\Profile\\restart-identities");

  entries.set("c:\\users\\alice smith", entry(30));
  expect(() =>
    canonicalTrustedDirectory(
      "C:\\Users\\ALICE~1\\Profile\\restart-identities",
      probe(entries, () => "C:\\Users\\Alice Smith\\Profile"),
    ),
  ).toThrow("identit");
});

test("trusted directory refuses a reparse ancestor and a changed checked parent", () => {
  const entries = aliases();
  entries.set("c:\\users\\alice~1", entry(3, { reparse: "reparse" }));
  expect(() =>
    canonicalTrustedDirectory(
      "C:\\Users\\ALICE~1\\Profile\\restart-identities",
      probe(entries, () => "C:\\Users\\Alice Smith\\Profile"),
    ),
  ).toThrow("plain directory");

  entries.set("c:\\users\\alice~1", entry(3));
  expect(() =>
    canonicalTrustedDirectory(
      "C:\\Users\\ALICE~1\\Profile\\restart-identities",
      probe(
        entries,
        () => "C:\\Users\\Alice Smith\\Profile",
        () => entries.set("c:\\users", entry(20)),
      ),
    ),
  ).toThrow("changed");
});

test("trusted directory keeps a missing suffix below its canonical existing parent", () => {
  const entries = new Map<string, Entry>([
    ["c:\\", entry(1)],
    ["c:\\profiles", entry(2)],
    ["c:\\profiles\\operator", entry(3)],
  ]);
  expect(
    canonicalTrustedDirectory(
      "C:\\Profiles\\Operator\\new\\profile",
      probe(entries),
    ),
  ).toBe("C:\\Profiles\\Operator\\new\\profile");
});
