import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BUILTIN_SMITHS } from "../config/defaults";
import { claudeAdapter } from "./claude";
import { createCodexAdapter, parseCodexLine } from "./codex";
import { buildChildEnv } from "./env";
import type { SpawnRequest } from "./types";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");

describe("codex adapter", () => {
  test("runs its prepare step (codex:sync) before spawning", async () => {
    const prepared: string[] = [];
    const adapter = createCodexAdapter({
      prepare: (request) => {
        prepared.push(request.workspace);
      },
    });
    const root = mkdtempSync(join(tmpdir(), "codex prep "));
    const handle = await adapter.spawn({
      beadId: "b",
      worktree: root,
      workspace: root,
      smith: BUILTIN_SMITHS["codex-journeyman"] as SpawnRequest["smith"],
      prompt: "x",
      env: buildChildEnv(process.env, []),
      command: [process.execPath, FAKE, "--fake-provider", "codex"],
    });
    for await (const _ of handle.events) {
      // drain
    }
    expect(prepared).toEqual([root]);
  });

  test("maps command_execution items to tool calls with exit codes", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "ls", exit_code: 2 },
    });
    expect(parseCodexLine(line)).toEqual([
      { tool: "shell", input: "ls", exitCode: 2 },
    ]);
    expect(parseCodexLine("nope")).toEqual([]);
  });
});

describe("doctor", () => {
  test("a missing binary is data (found:false), not a throw", async () => {
    const report = await claudeAdapter.doctor([
      join(tmpdir(), "definitely-not-a-real-binary-xyz"),
    ]);
    expect(report.provider).toBe("claude");
    expect(report.found).toBe(true); // override given, but it cannot run
    expect(report.ok).toBe(false);
    expect(report.reason).toBeTruthy();
  });
});
