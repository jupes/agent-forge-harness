/**
 * `forge:review` as a command: what a command line it cannot read whole
 * leaves behind. Spawned scripts, in a scratch checkout with a scratch ledger
 * and a scratch user home.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEvent } from "../../types/hearth";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import type { ForgeState } from "./phases";
import { parseState } from "./runs";

const PHASE_GATE = join(import.meta.dir, "phase-gate.ts");
const REVIEW = join(import.meta.dir, "auto-loop-cli.ts");

interface Box {
  cwd: string;
  home: string;
  userHome: string;
}

const temporary: string[] = [];

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A ledger file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
});

/** A scratch checkout, ledger home and user home, under a path with a space. */
function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "forge review test "));
  temporary.push(root);
  const box = {
    cwd: join(root, "check out"),
    home: join(root, "forge home"),
    userHome: join(root, "user home"),
  };
  mkdirSync(join(box.cwd, ".git"), { recursive: true });
  mkdirSync(join(box.cwd, "plans", "research"), { recursive: true });
  mkdirSync(box.userHome, { recursive: true });
  return box;
}

/** The parent's environment minus anything that names a live session, run or ledger. */
function childEnv(box: Box): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    AGENT_FORGE_HOME: box.home,
    HOME: box.userHome,
    USERPROFILE: box.userHome,
  };
}

async function run(
  box: Box,
  script: string,
  args: string[],
): Promise<{
  exitCode: number;
  printed: { ok: boolean; data: unknown; error: string | null };
}> {
  const child = Bun.spawn(["bun", "run", script, ...args], {
    cwd: box.cwd,
    env: childEnv(box),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, printed: JSON.parse(stdout) };
}

/** Run `x`, whose research write named bead `b-1`: a correlated run. */
async function correlatedRun(box: Box): Promise<void> {
  writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
  const wrote = await run(box, PHASE_GATE, [
    "research",
    "--slug",
    "x",
    "--write",
    "--mode",
    "auto",
    "--bead",
    "b-1",
  ]);
  expect(wrote.exitCode).toBe(0);
}

/** A schema 2 verdict for run `x` and bead `b-1`, from a person, at `name` in the checkout. */
function verdictFile(box: Box, name: string, summary: string): string {
  const path = join(box.cwd, name);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      beadsIssueId: "b-1",
      executionRunId: "x",
      verdict: "PASS",
      findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      summary,
      evaluator: { kind: "human", actorKind: "reviewer" },
    }),
  );
  return path;
}

function runState(box: Box): ForgeState | null {
  return parseState(
    readFileSync(join(box.cwd, ".tmp", "work", "forge-runs", "x.json"), "utf8"),
  );
}

/** The run's review rows in the scratch ledger; the handle is closed again, so a child can write next. */
function reviewRows(box: Box): LedgerEvent[] {
  const rows = queryEvents(
    { runId: "x", kinds: ["verdict.bound", "review.recorded"] },
    { path: join(box.home, "ledger.db") },
  );
  closeLedger();
  return rows;
}

describe("forge:review refuses a command line it cannot read whole, before any round is recorded", () => {
  test("the walk's command line, its verdict path left empty, is refused and records nothing", async () => {
    const box = sandbox();
    await correlatedRun(box);

    const refused = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      "--tier",
      "human",
    ]);
    expect(refused.exitCode).toBe(2);
    expect(refused.printed).toEqual({
      ok: false,
      data: null,
      error: "--verdict needs a value.",
    });
    expect(runState(box)?.reviews).toBeUndefined();
    expect(reviewRows(box)).toEqual([]);
    expect(
      existsSync(join(box.cwd, ".tmp", "work", "session-handoff.md")),
    ).toBe(false);
  }, 60_000);

  test("an unknown flag, a flag given twice and a flag with no value are each refused, and no round is recorded", async () => {
    const box = sandbox();
    await correlatedRun(box);
    const file = verdictFile(box, "review-research-1.json", "research read");

    for (const [argv, error] of [
      [
        ["--slug", "x", "--phase", "research", "--verdikt", file],
        "unknown flag --verdikt",
      ],
      [
        [
          "--slug",
          "x",
          "--phase",
          "research",
          "--verdict",
          file,
          "--verdict",
          file,
        ],
        "--verdict is given twice",
      ],
      [
        [
          "--slug",
          "x",
          "--phase",
          "plan",
          "--phase=research",
          "--verdict",
          file,
        ],
        "--phase is given twice",
      ],
      [
        ["--slug", "x", "--phase", "research", "--verdict", file, "--tier"],
        "--tier needs a value",
      ],
      [
        ["--slug", "x", "--phase", "research", "--verdict="],
        "--verdict needs a value",
      ],
      [
        [
          "--slug",
          "x",
          "--phase",
          "research",
          "--verdict",
          file,
          "--max-revisions",
          "--tier",
          "human",
        ],
        "--max-revisions needs a value",
      ],
    ] as const) {
      const refused = await run(box, REVIEW, [...argv]);
      expect({ argv, exitCode: refused.exitCode }).toEqual({
        argv,
        exitCode: 2,
      });
      expect(refused.printed.ok).toBe(false);
      expect(refused.printed.error).toContain(error);
    }
    expect(runState(box)?.reviews).toBeUndefined();
    expect(reviewRows(box)).toEqual([]);
  }, 120_000);
});
