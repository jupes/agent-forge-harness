import { afterEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  type GitRun,
  readStrictWorktreeRegistry,
  registryPathKey,
  removeWorktree,
} from "./worktrees";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture() {
  const main = realpathSync.native(scratch.make("worktree-registry-guard-"));
  mkdirSync(join(main, "trees"));
  const row = {
    id: "shift-test-1",
    path: join(main, "trees", "shift-test-1"),
    branch: "feat/test",
    createdAt: "2026-11-07T00:00:00.000Z",
    beadId: "forge-test.1",
  };
  const save = (value: unknown) =>
    writeFileSync(join(main, "trees", ".state.json"), JSON.stringify(value));
  return { main, row, save };
}
test.each([
  "branch",
  "commit",
  "foreign",
] as const)("reviewed cleanup refuses clean-status %s drift before Git removal", (drift) => {
  const f = fixture();
  mkdirSync(f.row.path);
  f.save({ worktrees: [f.row] });
  const userFile = join(f.row.path, "owned.txt"),
    external = join(f.main, "external.txt"),
    cache = join(f.main, "trees", ".state.json");
  writeFileSync(userFile, "retained tracked work");
  writeFileSync(external, "retained external work");
  const cacheBytes = readFileSync(cache, "utf8"),
    cacheIdentity = lstatSync(cache, { bigint: true });
  const expectedHead = "a".repeat(40);
  let branch = f.row.branch,
    head = expectedHead,
    removals = 0;
  let foreign = false;
  const asked: string[][] = [];
  const git: GitRun = (args) => {
    asked.push([...args]);
    if (args.includes("--show-toplevel"))
      return { status: 0, stdout: f.main, stderr: "" };
    if (args[0] === "status") {
      if (drift === "branch") branch = "feat/switched";
      else if (drift === "commit") head = "b".repeat(40);
      else foreign = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "list")
      return {
        status: 0,
        stdout:
          `worktree ${f.row.path}\0HEAD ${head}\0branch refs/heads/${branch}\0\0` +
          (foreign ? "worktree /foreign\0\0" : ""),
        stderr: "",
      };
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD")
      return { status: 0, stdout: head, stderr: "" };
    if (args[1] === "remove") {
      removals++;
      return { status: 0, stdout: "", stderr: "" };
    }
    throw Error("Unexpected fake Git call");
  };
  const reviewed = { force: false, expectedRecord: f.row, expectedHead };
  const result = removeWorktree(f.main, f.row.id, reviewed, { git });
  expect(removals).toBe(0);
  expect(result.ok).toBe(false);
  expect(readFileSync(cache, "utf8")).toBe(cacheBytes);
  const after = lstatSync(cache, { bigint: true });
  expect([after.dev, after.ino]).toEqual([
    cacheIdentity.dev,
    cacheIdentity.ino,
  ]);
  expect(readFileSync(userFile, "utf8")).toBe("retained tracked work");
  expect(readFileSync(external, "utf8")).toBe("retained external work");
  expect(
    asked.some(
      ([command, action]) =>
        command === "branch" ||
        command === "stash" ||
        (command === "worktree" && action === "prune"),
    ),
  ).toBe(false);
});

test.each([
  "initial identity",
  "status force",
] as const)("reviewed cleanup does not adopt mutable %s options", (mutation) => {
  const f = fixture();
  mkdirSync(f.row.path);
  f.save({ worktrees: [f.row] });
  const reviewed = {
    force: false,
    expectedRecord: f.row,
    expectedHead: "a".repeat(40),
  };
  const cache = join(f.main, "trees", ".state.json");
  let expectedCache = readFileSync(cache, "utf8");
  let branch = f.row.branch,
    head = reviewed.expectedHead,
    removals = 0,
    forced = false;
  const git: GitRun = (args) => {
    if (args.includes("--show-toplevel")) {
      if (mutation === "initial identity") {
        branch = reviewed.expectedRecord.branch = "feat/substitute";
        head = reviewed.expectedHead = "b".repeat(40);
        f.save({ worktrees: [reviewed.expectedRecord] });
        expectedCache = readFileSync(cache, "utf8");
      }
      return { status: 0, stdout: f.main, stderr: "" };
    }
    if (args[0] === "status") {
      if (mutation === "status force") reviewed.force = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "list")
      return {
        status: 0,
        stdout: `worktree ${f.row.path}\0HEAD ${head}\0branch refs/heads/${branch}\0\0`,
        stderr: "",
      };
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD")
      return { status: 0, stdout: head, stderr: "" };
    if (args[1] === "remove") {
      removals++;
      forced = args.includes("--force");
      return { status: 0, stdout: "", stderr: "" };
    }
    throw Error("Unexpected fake Git call");
  };
  const result = removeWorktree(f.main, f.row.id, reviewed, { git });
  expect(forced).toBe(false);
  if (mutation === "initial identity") {
    expect(removals).toBe(0);
    expect(result.ok).toBe(false);
    expect(readFileSync(cache, "utf8")).toBe(expectedCache);
  }
});

test("reviewed cleanup validates complete Git evidence and explicit review options", () => {
  const f = fixture();
  mkdirSync(f.row.path);
  f.save({ worktrees: [f.row] });
  const cache = join(f.main, "trees", ".state.json");
  const head = "a".repeat(40);
  const inventory = (value = head) =>
    `worktree ${f.row.path}\0HEAD ${value}\0branch refs/heads/${f.row.branch}\0\0`;
  let listing = inventory(),
    directHead = head,
    removals = 0;
  let listStatus: number | null = 0;
  let onStatus = () => {};
  let retainedCache = readFileSync(cache, "utf8");
  const git: GitRun = (args) => {
    if (args.includes("--show-toplevel"))
      return { status: 0, stdout: f.main, stderr: "" };
    if (args[1] === "list")
      return { status: listStatus, stdout: listing, stderr: "" };
    if (args[0] === "status") {
      onStatus();
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD")
      return { status: 0, stdout: directHead, stderr: "" };
    if (args[1] === "remove") {
      removals++;
      expect(args).not.toContain("--force");
      return { status: 0, stdout: "", stderr: "" };
    }
    throw Error("Unexpected fake Git call");
  };
  const reviewed = { force: false, expectedRecord: f.row, expectedHead: head };
  const refuse = (
    label: string,
    options: Parameters<typeof removeWorktree>[2] = reviewed,
  ) => {
    const result = removeWorktree(f.main, f.row.id, options, { git });
    expect({ label, ok: result.ok, removals }).toEqual({
      label,
      ok: false,
      removals: 0,
    });
    expect(readFileSync(cache, "utf8")).toBe(retainedCache);
  };
  const invalidOptions: Parameters<typeof removeWorktree>[2][] = [
    { force: false, expectedHead: head },
    { force: false, expectedRecord: f.row },
    { ...reviewed, force: true },
    ...[
      "",
      "a".repeat(39),
      "a".repeat(41),
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(40),
      "g".repeat(40),
    ].map((expectedHead) => ({ ...reviewed, expectedHead })),
  ];
  invalidOptions.forEach((options, index) => {
    refuse(`invalid options ${index}`, options);
  });
  const invalidInventories = [
    "",
    inventory().slice(0, -1),
    inventory() + inventory(),
    inventory().replace(`HEAD ${head}\0`, ""),
    inventory().replace(`HEAD ${head}\0`, `HEAD ${head}\0HEAD ${head}\0`),
    inventory().replace(`branch refs/heads/${f.row.branch}\0`, ""),
    inventory().replace(`branch refs/heads/${f.row.branch}`, "detached"),
    inventory().replace(
      `HEAD ${head}\0branch refs/heads/${f.row.branch}`,
      "bare",
    ),
    inventory().replace("\0\0", "\0locked review\0\0"),
    inventory().replace("\0\0", "\0prunable missing\0\0"),
    inventory().replace("\0\0", "\0unsupported evidence\0\0"),
    inventory() + "worktree /foreign\0\0",
    inventory() +
      `worktree relative\0HEAD ${head}\0branch refs/heads/foreign\0\0`,
    inventory() + `worktree /foreign\0bare\0branch refs/heads/foreign\0\0`,
  ];
  invalidInventories.forEach((value, index) => {
    listing = value;
    refuse(`invalid inventory ${index}`);
  });
  listing = inventory();
  for (const status of [1, null]) {
    listStatus = status;
    refuse(`failed inventory ${status}`);
  }
  listStatus = 0;
  directHead = "b".repeat(40);
  refuse("independent HEAD disagrees");
  directHead = head;
  onStatus = () => {
    directHead = "b".repeat(40);
  };
  refuse("independent HEAD advances during clean status");
  directHead = head;
  onStatus = () => {
    f.save({ worktrees: [{ ...f.row, branch: "feat/replacement" }] });
    retainedCache = readFileSync(cache, "utf8");
  };
  refuse("registry changes during clean status");
  onStatus = () => {};
  for (const width of [40, 64]) {
    f.save({ worktrees: [f.row] });
    const expectedHead = "a".repeat(width);
    listing = inventory(expectedHead);
    directHead = expectedHead;
    const before = removals;
    expect(
      removeWorktree(f.main, f.row.id, { ...reviewed, expectedHead }, { git })
        .ok,
    ).toBe(true);
    expect(removals).toBe(before + 1);
  }
});

test("strict cleanup inventory retains complete ownership and refuses ambiguous registry data", () => {
  const f = fixture();
  expect(readStrictWorktreeRegistry(f.main)).toEqual({ ok: true, value: [] });
  f.save({ worktrees: [f.row] });
  expect(readStrictWorktreeRegistry(f.main)).toEqual({
    ok: true,
    value: [f.row],
  });
  for (const value of [
    {},
    { worktrees: null },
    { worktrees: [f.row], unknown: true },
    { worktrees: [f.row, f.row] },
    { worktrees: [{ ...f.row, beadId: "../foreign" }] },
    { worktrees: [{ ...f.row, ownerSessionId: "invalid session" }] },
    { worktrees: [{ ...f.row, createdAt: "unknown" }] },
    { worktrees: [{ ...f.row, path: f.main }] },
    { worktrees: [{ ...f.row, path: `${f.row.path} ` }] },
    {
      worktrees: [
        { ...f.row, path: join(f.main, "trees", "x") + "/../" + f.row.id },
      ],
    },
    { worktrees: [{ ...f.row, unknown: true }] },
  ]) {
    f.save(value);
    expect(readStrictWorktreeRegistry(f.main).ok).toBe(false);
  }
});

test("registry path comparison preserves platform-native path data", () => {
  expect(registryPathKey("/tmp/main\\trees\\id", "posix")).not.toBe(
    registryPathKey("/tmp/main/trees/id", "posix"),
  );
  expect(registryPathKey("/tmp/main/trees/id ", "posix")).not.toBe(
    registryPathKey("/tmp/main/trees/id", "posix"),
  );
  expect(registryPathKey("C:/main/trees/id ", "win32")).not.toBe(
    registryPathKey("C:/main/trees/id", "win32"),
  );
  expect(registryPathKey("C:/Main/trees/id", "win32")).toBe(
    registryPathKey("c:\\main\\trees\\id", "win32"),
  );
});

test("strict registry refuses an outside path even when a child alias resolves to it", () => {
  const f = fixture(),
    outside = join(f.main, "outside");
  mkdirSync(outside);
  symlinkSync(
    outside,
    f.row.path,
    process.platform === "win32" ? "junction" : "dir",
  );
  f.save({ worktrees: [{ ...f.row, path: outside }] });
  expect(readStrictWorktreeRegistry(f.main).ok).toBe(false);
  f.save({ worktrees: [f.row] });
  let effects = 0;
  const git: GitRun = (args) => {
    if (args.includes("--show-toplevel"))
      return { status: 0, stdout: f.main, stderr: "" };
    if (args[1] === "remove") effects++;
    return { status: 0, stdout: "", stderr: "" };
  };
  expect(
    removeWorktree(
      f.main,
      f.row.id,
      { force: false, expectedRecord: f.row, expectedHead: "a".repeat(40) },
      { git },
    ).ok,
  ).toBe(false);
  expect(effects).toBe(0);
});

test("reviewed cleanup refuses missing, changed, ignored-dirty targets before any removal", () => {
  const f = fixture();
  mkdirSync(f.row.path);
  f.save({ worktrees: [f.row] });
  let listed = true,
    dirty = "",
    removed = 0;
  const git: GitRun = (args) => {
    if (args.includes("--show-toplevel"))
      return { status: 0, stdout: f.main, stderr: "" };
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD")
      return { status: 0, stdout: "a".repeat(40), stderr: "" };
    if (args[0] === "status") {
      expect(args).toContain("--ignored=matching");
      expect(args).toContain("--untracked-files=all");
      return { status: 0, stdout: dirty, stderr: "" };
    }
    if (args[1] === "list")
      return {
        status: 0,
        stdout: listed
          ? `worktree ${f.row.path}\0HEAD ${"a".repeat(40)}\0branch refs/heads/${f.row.branch}\0\0`
          : "",
        stderr: "",
      };
    if (args[1] === "remove") {
      removed++;
      return { status: 0, stdout: "", stderr: "" };
    }
    throw Error("Unexpected fake Git");
  };
  const remove = () =>
    removeWorktree(
      f.main,
      f.row.id,
      { force: false, expectedRecord: f.row, expectedHead: "a".repeat(40) },
      { git },
    );
  listed = false;
  expect(remove().ok).toBe(false);
  expect(readStrictWorktreeRegistry(f.main)).toEqual({
    ok: true,
    value: [f.row],
  });
  listed = true;
  f.save({ worktrees: [{ ...f.row, branch: "feat/replacement" }] });
  expect(remove().ok).toBe(false);
  f.save({ worktrees: [f.row] });
  dirty = "!! ignored-user-data\0";
  expect(remove().ok).toBe(false);
  expect(removed).toBe(0);
  dirty = "";
  expect(remove().ok).toBe(true);
  expect(removed).toBe(1);
});
