import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  type GitRun,
  readStrictWorktreeRegistry,
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
    { worktrees: [{ ...f.row, unknown: true }] },
  ]) {
    f.save(value);
    expect(readStrictWorktreeRegistry(f.main).ok).toBe(false);
  }
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
      { force: false, expectedRecord: f.row },
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
      { force: false, expectedRecord: f.row },
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
