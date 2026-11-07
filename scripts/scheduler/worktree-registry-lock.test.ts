import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  createLockedWorktree,
  withWorktreeRegistryLock,
} from "./worktree-registry-lock";
import type { GitRun } from "./worktrees";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture() {
  const main = realpathSync.native(scratch.make("worktree-registry-lock-"));
  mkdirSync(join(main, ".git"));
  return main;
}
test("registry mutation remains synchronous and a competing or reentrant writer does no work", () => {
  const main = fixture();
  let effects = 0;
  const held = withWorktreeRegistryLock(main, () => {
    effects++;
    const other = new Database(
      join(main, ".git", "agent-forge-worktrees.lock.db"),
    );
    try {
      expect(() => other.exec("BEGIN EXCLUSIVE")).toThrow();
    } finally {
      other.close();
    }
    expect(
      withWorktreeRegistryLock(main, () => {
        effects++;
        return { ok: true, value: "bad" };
      }).ok,
    ).toBe(false);
    return { ok: true, value: "done" };
  });
  expect(held).toEqual({ ok: true, value: "done" });
  expect(effects).toBe(1);
  expect(() =>
    withWorktreeRegistryLock(main, () => {
      throw Error("callback failed");
    }),
  ).toThrow("callback failed");
  expect(
    withWorktreeRegistryLock(main, () => ({ ok: true, value: "next" })),
  ).toEqual({ ok: true, value: "next" });
});
test("an external SQLite holder refuses the callback and release permits the next writer", () => {
  const main = fixture();
  const other = new Database(
    join(main, ".git", "agent-forge-worktrees.lock.db"),
  );
  other.exec("BEGIN EXCLUSIVE");
  let called = false;
  try {
    expect(
      withWorktreeRegistryLock(main, () => {
        called = true;
        return { ok: true, value: null };
      }).ok,
    ).toBe(false);
    expect(called).toBe(false);
  } finally {
    other.close();
  }
  expect(
    withWorktreeRegistryLock(main, () => ({ ok: true, value: null })).ok,
  ).toBe(true);
});

test("a competing creation cannot enter the Git/cache transaction and later writes preserve foreign entries", () => {
  const main = fixture();
  mkdirSync(join(main, "trees"));
  const foreign = {
    id: "legacy",
    path: "/foreign",
    extension: { retained: true },
  };
  const extended = {
    id: "old",
    path: join(main, "trees", "old"),
    branch: "feat/old",
    createdAt: "2026-11-07T00:00:00.000Z",
    ownerSessionId: "old-session",
    extension: "preserve",
  };
  writeFileSync(
    join(main, "trees", ".state.json"),
    JSON.stringify({ worktrees: [foreign, extended] }),
  );
  let additions = 0;
  const git: GitRun = (args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      additions++;
      expect(
        createLockedWorktree(main, main, { branch: "feat/competing" }, { git })
          .ok,
      ).toBe(false);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "check-ref-format")
      return { status: 0, stdout: String(args[2]), stderr: "" };
    if (args[0] === "check-ignore")
      return {
        status: 0,
        stdout: ".gitignore:1:trees/\ttrees/target",
        stderr: "",
      };
    if (args.includes("--show-toplevel"))
      return { status: 0, stdout: main, stderr: "" };
    if (args.includes("--verify")) return { status: 1, stdout: "", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD")
      return { status: 0, stdout: "a".repeat(40), stderr: "" };
    throw Error(`Unexpected fake Git ${args.join(" ")}`);
  };
  for (const id of ["first", "second"])
    expect(
      createLockedWorktree(
        main,
        main,
        { branch: `feat/${id}` },
        {
          git,
          newId: () => id,
          readMirror: () => null,
          home: () => join(main, "not-home"),
        },
      ).ok,
    ).toBe(true);
  let saved: { worktrees: unknown[] };
  try {
    saved = JSON.parse(
      readFileSync(join(main, "trees", ".state.json"), "utf8"),
    );
  } catch {
    throw Error("Registry must remain JSON");
  }
  expect(additions).toBe(2);
  expect(saved.worktrees).toContainEqual(foreign);
  expect(saved.worktrees).toContainEqual(extended);
  expect(saved.worktrees).toHaveLength(4);
});
