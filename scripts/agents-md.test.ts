import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import {
  checkAgentsMd,
  listDirsUpToDepth,
  parseArgs,
  scaffoldText,
  shouldIgnoreDir,
} from "./agents-md";

describe("agents-md helpers", () => {
  test("parseArgs resolves mode and flags", () => {
    expect(parseArgs(["validate"])).toEqual({
      mode: "validate",
      write: false,
      hook: false,
    });
    expect(parseArgs(["scaffold", "--write", "--hook"])).toEqual({
      mode: "scaffold",
      write: true,
      hook: true,
    });
  });

  test("shouldIgnoreDir ignores hidden and configured folders", () => {
    expect(shouldIgnoreDir(".git")).toBeTrue();
    expect(shouldIgnoreDir("node_modules")).toBeTrue();
    expect(shouldIgnoreDir("docs")).toBeFalse();
  });

  test("listDirsUpToDepth includes only max depth 2", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-depth-"));
    try {
      mkdirSync(join(root, "a", "b", "c"), { recursive: true });
      mkdirSync(join(root, "docs"), { recursive: true });
      mkdirSync(join(root, ".git"), { recursive: true });
      const dirs = listDirsUpToDepth(root, 2);
      const rel = dirs.map((d) => relative(root, d) || ".");
      expect(rel).toContain(".");
      expect(rel).toContain("a");
      expect(rel).toContain(join("a", "b"));
      expect(rel).not.toContain(join("a", "b", "c"));
      expect(rel).not.toContain(".git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checkAgentsMd reports missing AGENTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-check-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "# Root");
      writeFileSync(join(root, "scripts", "AGENTS.md"), "# Scripts");
      const got = checkAgentsMd(root);
      const missing = got.missingAgents.map((d) => relative(root, d) || ".");
      expect(missing).toContain("docs");
      expect(missing).not.toContain(".");
      expect(missing).not.toContain("scripts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scaffoldText is deterministic and includes heading", () => {
    const got = scaffoldText(process.cwd());
    expect(got).toContain("# AGENTS.md — .");
    expect(got).toContain("## Scope");
    expect(got).toContain("## Local Rules");
  });
});
