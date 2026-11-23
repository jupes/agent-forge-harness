import { afterEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type NativePhysicalPathDeps,
  nativePhysicalPath,
} from "./native-realpath";
import { scratchDirs } from "./test-scratch";

test("a native alias cannot replace a distinct literal POSIX backslash directory", () => {
  const literal = "/repo/a\\b",
    alias = "/repo/a/b";
  const inodes = new Map([
    ["/", 1n],
    ["/repo", 2n],
    [literal, 9_007_199_254_740_993n],
    ["/repo/a", 3n],
    [alias, 9_007_199_254_740_992n],
  ]);
  const deps: NativePhysicalPathDeps = {
    platform: "posix",
    cwd: () => "/repo",
    realpath: () => alias,
    lstat(path) {
      const ino = inodes.get(path);
      if (ino === undefined) throw Error("No fixture object exists");
      return {
        dev: 1n,
        ino,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    readlink() {
      throw Error("The fixture contains no symlink");
    },
  };
  expect(nativePhysicalPath(literal, deps)).toBe(literal);
});

type VirtualNode = {
  ino: bigint;
  directory: boolean;
  target?: string;
  dev?: bigint;
};
function virtualPosix() {
  const entries = new Map<string, VirtualNode>();
  const state = { cwd: "/cwd", actual: "/cwd", captures: 0 };
  let ino = 10n;
  const node = (path: string, directory = true, target?: string) =>
    entries.set(path, {
      ino: ino++,
      directory,
      ...(target === undefined ? {} : { target }),
    });
  node("/");
  node("/cwd");
  const deps: NativePhysicalPathDeps = {
    platform: "posix",
    cwd: () => {
      state.captures++;
      return state.cwd;
    },
    lstat(path) {
      const found = entries.get(path === "." ? state.actual : path);
      if (!found) throw Error("Missing virtual filesystem object");
      return {
        dev: found.dev ?? 1n,
        ino: found.ino,
        isDirectory: () => found.directory,
        isSymbolicLink: () => found.target !== undefined,
      };
    },
    readlink(path) {
      const target = entries.get(path)?.target;
      if (target === undefined) throw Error("Not a virtual link");
      return target;
    },
    realpath() {
      throw Error("No independent native spelling witness");
    },
  };
  return { entries, state, node, deps };
}

test("POSIX links and dotdot follow physical parents and capture relative cwd once", () => {
  const f = virtualPosix();
  f.node("/right");
  f.node("/right/inner");
  f.node("/right/peer", false);
  f.node("/cwd/absolute", false, "/right/inner");
  f.node("/cwd/relative", false, "../right/inner");
  f.node("/cwd/space \\ leaf");
  expect(nativePhysicalPath("/cwd/absolute/../peer", f.deps)).toBe(
    "/right/peer",
  );
  expect(nativePhysicalPath("relative/../peer", f.deps)).toBe("/right/peer");
  expect(f.state.captures).toBe(1);
  expect(nativePhysicalPath("/../../", f.deps)).toBe("/");
  expect(nativePhysicalPath("/cwd/space \\ leaf", f.deps)).toBe(
    "/cwd/space \\ leaf",
  );
});

test("missing or non-directory traversal, unsafe strings and unverified cwd fail closed", () => {
  const f = virtualPosix();
  f.node("/file", false);
  f.node("/trailing-target", false, "/file/");
  f.node("/bad-target", false, "bad\0target");
  f.node("/bad-unicode", false, "bad\ud800target");
  for (const path of [
    "",
    "/missing",
    "/file/child",
    "/file/.",
    "/file/..",
    "/file/",
    "/trailing-target",
    "/bad-target",
    "/bad-unicode",
    "/bad\0name",
    "/bad\ud800name",
  ])
    expect(() => nativePhysicalPath(path, f.deps)).toThrow();
  f.state.cwd = "not-absolute";
  expect(() => nativePhysicalPath(".", f.deps)).toThrow();
  f.state.cwd = "/cwd";
  f.state.actual = "/";
  expect(() => nativePhysicalPath(".", f.deps)).toThrow();
});

test("the physical walker admits 40 links and 4096 components, including expanded dots", () => {
  const f = virtualPosix();
  f.node("/s41");
  for (let i = 40; i >= 0; i--) f.node("/s" + i, false, "/s" + (i + 1));
  expect(nativePhysicalPath("/s1", f.deps)).toBe("/s41");
  expect(() => nativePhysicalPath("/s0", f.deps)).toThrow();
  f.node("/loop", false, "loop");
  expect(() => nativePhysicalPath("/loop", f.deps)).toThrow();
  expect(
    nativePhysicalPath("/" + Array(4095).fill(".").join("/"), f.deps),
  ).toBe("/");
  expect(() =>
    nativePhysicalPath("/" + Array(4096).fill(".").join("/"), f.deps),
  ).toThrow();
  f.node("/fan", false, Array(4094).fill(".").join("/"));
  expect(nativePhysicalPath("/fan", f.deps)).toBe("/");
  f.node("/fan", false, Array(4095).fill(".").join("/"));
  expect(() => nativePhysicalPath("/fan", f.deps)).toThrow();
});

test("native spelling needs a completed walk and matching bigint device and inode", () => {
  const f = virtualPosix();
  f.node("/Object");
  const object = f.entries.get("/Object");
  if (!object) throw Error("Missing virtual object fixture");
  f.entries.set("/canonical", { ...object });
  let nativeCalls = 0;
  f.deps.realpath = () => {
    nativeCalls++;
    return "/canonical";
  };
  expect(nativePhysicalPath("/Object", f.deps)).toBe("/canonical");
  f.entries.set("/canonical", { ...object, dev: 2n });
  expect(nativePhysicalPath("/Object", f.deps)).toBe("/Object");
  f.entries.delete("/Object");
  expect(() => nativePhysicalPath("/Object", f.deps)).toThrow();
  expect(nativeCalls).toBe(2);
  const lstat = f.deps.lstat;
  if (!lstat) throw Error("Missing virtual lstat fixture");
  const unsupported = lstat("/");
  Reflect.set(unsupported, "ino", Number.MAX_SAFE_INTEGER + 1);
  expect(() =>
    nativePhysicalPath("/", { ...f.deps, lstat: () => unsupported }),
  ).toThrow();
});

test("a same-inode native alias with a symlink parent cannot conceal physical escape", () => {
  const f = virtualPosix();
  f.node("/safe");
  f.node("/outside");
  f.node("/outside/child");
  f.node("/safe/link", false, "/outside");
  const child = f.entries.get("/outside/child");
  if (!child) throw Error("Missing physical child fixture");
  // lstat follows the symlink parent and therefore reports the same real leaf.
  f.entries.set("/safe/link/child", { ...child });
  f.deps.realpath = () => "/safe/link/child";
  expect(nativePhysicalPath("/safe/link/child", f.deps)).toBe("/outside/child");
});

test("optional native spelling cannot spend a second component budget", () => {
  const f = virtualPosix();
  f.node("/Object");
  const object = f.entries.get("/Object");
  if (!object) throw Error("Missing virtual object fixture");
  f.entries.set("/canonical", { ...object });
  f.deps.realpath = () => "/canonical";
  const atLimit = "/" + Array(4094).fill(".").join("/") + "/Object";
  expect(nativePhysicalPath(atLimit, f.deps)).toBe("/Object");
});

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("ordinary scratch filesystem paths retain native spelling on the host platform", () => {
  const root = scratch.make("native-physical-host-");
  const directory = join(root, "space folder"),
    file = join(directory, "leaf.txt");
  mkdirSync(directory);
  writeFileSync(file, "owned fixture");
  expect(nativePhysicalPath(directory)).toBe(realpathSync.native(directory));
  expect(nativePhysicalPath(file)).toBe(realpathSync.native(file));
  if (process.platform === "win32") {
    const alias = join(root, "junction");
    symlinkSync(directory, alias, "junction");
    expect(nativePhysicalPath(alias)).toBe(realpathSync.native(directory));
  }
});

test("Windows delegation preserves native behavior without consulting POSIX evidence", () => {
  const original = "C:\\fixture\\..\\target";
  expect(
    nativePhysicalPath(original, {
      platform: "win32",
      realpath(value) {
        expect(value).toBe(original);
        return "native result";
      },
      lstat() {
        throw Error("No POSIX walk is permitted on Windows");
      },
    }),
  ).toBe("native result");
});

test.skipIf(process.platform === "win32")(
  "actual POSIX identities preserve literal separators, physical links and Unicode target bytes",
  () => {
    const root = nativePhysicalPath(scratch.make("native-physical-posix-"));
    const literal = join(root, "a\\b"),
      nested = join(root, "a", "b");
    mkdirSync(literal);
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(literal, "child"));
    const left = lstatSync(literal, { bigint: true }),
      right = lstatSync(nested, { bigint: true });
    expect(left.dev === right.dev && left.ino === right.ino).toBe(false);
    expect(nativePhysicalPath(literal)).toBe(literal);
    expect(nativePhysicalPath(join(literal, "child"))).toBe(
      join(literal, "child"),
    );
    expect(nativePhysicalPath(nested)).toBe(nested);
    const relative = join(root, "relative");
    symlinkSync("a\\b", relative);
    expect(nativePhysicalPath(relative)).toBe(literal);
    mkdirSync(join(root, "target", "inner"), { recursive: true });
    writeFileSync(join(root, "target", "peer"), "physical sibling");
    writeFileSync(join(root, "peer"), "lexical decoy");
    symlinkSync("target/inner", join(root, "link"));
    expect(nativePhysicalPath(root + "/link/../peer")).toBe(
      join(root, "target", "peer"),
    );
    symlinkSync(literal, join(root, "absolute"));
    expect(nativePhysicalPath(join(root, "absolute"))).toBe(literal);
    symlinkSync("loop", join(root, "loop"));
    expect(() => nativePhysicalPath(join(root, "loop"))).toThrow();
    symlinkSync("peer/", join(root, "file-directory"));
    expect(() => nativePhysicalPath(join(root, "file-directory"))).toThrow();
    const bomTarget = join(root, "\ufefftarget");
    mkdirSync(bomTarget);
    symlinkSync("\ufefftarget", join(root, "bom-link"));
    expect(nativePhysicalPath(join(root, "bom-link"))).toBe(bomTarget);
    mkdirSync(join(root, "\ufffd"));
    const invalid = join(root, "invalid-utf8-link");
    symlinkSync(Buffer.from([0xff]), invalid);
    expect(readlinkSync(invalid, { encoding: "buffer" })).toEqual(
      Buffer.from([0xff]),
    );
    expect(() => nativePhysicalPath(invalid)).toThrow();
  },
);
