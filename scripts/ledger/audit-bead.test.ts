/**
 * One bead's history across the four kinds of emitter, read back through the
 * real `audit-cli.ts`.
 *
 * What is real here: the hook scripts, `phase-gate.ts`, `auto-loop-cli.ts`,
 * the council CLI (its default profile is the simulated one — no model is
 * called) and `audit-cli.ts` are each spawned, with a from-scratch environment
 * and a temp `AGENT_FORGE_HOME`. What is not: the `gate.ran` event is appended
 * in-process from the gate's builders, because spawning the quality gate would
 * run this test suite again; and no live session is involved.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEvent } from "../../types/hearth";
import { readRunState } from "../forge/runs-store";
import { gateAttach, gateRanEvent } from "../quality-gate-ledger";
import { appendEvent } from "./append";
import { closeLedger } from "./db";

const ROOT = join(import.meta.dir, "..", "..");
const SESSION = join(ROOT, ".claude", "hooks", "session.ts");
const LEDGER_HOOK = join(ROOT, ".claude", "hooks", "ledger-hook.ts");
const PHASE_GATE = join(ROOT, "scripts", "forge", "phase-gate.ts");
const REVIEW = join(ROOT, "scripts", "forge", "auto-loop-cli.ts");
const COUNCIL = join(ROOT, "scripts", "council", "cli.ts");
const AUDIT = join(import.meta.dir, "audit-cli.ts");

const BEAD = "proj-b1.2";
const temporary: string[] = [];

interface Box {
  cwd: string;
  home: string;
  userHome: string;
  emptyPath: string;
  path: string;
}

function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "ledger bead test "));
  temporary.push(root);
  const box = {
    cwd: join(root, "check out"),
    home: join(root, "forge home"),
    userHome: join(root, "user home"),
    emptyPath: join(root, "empty path"),
    path: join(root, "forge home", "ledger.db"),
  };
  mkdirSync(join(box.cwd, ".git"), { recursive: true });
  mkdirSync(join(box.cwd, "plans", "research"), { recursive: true });
  mkdirSync(box.userHome, { recursive: true });
  mkdirSync(box.emptyPath, { recursive: true });
  return box;
}

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

/**
 * A from-scratch environment: no live session id, run, bead or ledger of the
 * parent's leaks in, and neither `bd` nor `git` is reachable.
 */
function childEnv(box: Box): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_FORGE_HOME: box.home,
    HOME: box.userHome,
    USERPROFILE: box.userHome,
    PATH: box.emptyPath,
  };
  for (const name of ["SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function spawn(
  box: Box,
  script: string,
  args: string[],
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: box.cwd,
    env: childEnv(box),
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

function hookPayload(
  event: string,
  box: Box,
  sessionId: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: sessionId,
    cwd: box.cwd,
    ...extra,
  });
}

async function audit(box: Box, args: string[]): Promise<LedgerEvent[]> {
  const ran = await spawn(box, AUDIT, [...args, "--json"]);
  expect(ran.exitCode).toBe(0);
  const envelope = JSON.parse(ran.stdout) as {
    ok: boolean;
    data: LedgerEvent[];
  };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

describe("audit-cli --bead over events from every emitter (spawned scripts, scratch ledger, no live session)", () => {
  test("audit-cli --bead lists the session, run, gate and council events of one bead in id order, and --bead-exact drops the session-joined rows (gate.ran appended in-process through its builders)", async () => {
    const box = sandbox();

    // Session family: the hook scripts, given hook payloads for session S.
    // SessionStart also leaves S's mirror in the checkout, which is how the
    // scripts below attach to it.
    const started = await spawn(
      box,
      SESSION,
      [],
      hookPayload("SessionStart", box, "S", {
        source: "startup",
        model: "m-1",
      }),
    );
    expect(started.exitCode).toBe(0);
    const tool = (sessionId: string) =>
      spawn(
        box,
        LEDGER_HOOK,
        [],
        hookPayload("PostToolUse", box, sessionId, {
          tool_name: "Bash",
          tool_input: { command: "git status" },
        }),
      );
    expect((await tool("S")).exitCode).toBe(0);
    // Another session in the same checkout that never touches the bead.
    expect((await tool("T")).exitCode).toBe(0);

    // Run family: a phase-gate write that names the bead, then a review round.
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const wrote = await spawn(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--bead",
      BEAD,
    ]);
    expect(wrote.exitCode).toBe(0);
    const verdict = join(box.cwd, "v.json");
    writeFileSync(
      verdict,
      JSON.stringify({
        schemaVersion: 1,
        taskId: BEAD,
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
    );
    const reviewed = await spawn(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      verdict,
    ]);
    expect(reviewed.exitCode).toBe(0);

    // Gate family: what the quality gate builds for a passing run of "x",
    // appended here rather than by the gate script.
    const gate = appendEvent(
      gateRanEvent({
        result: { passed: true, forgeSlug: "x" },
        durationMs: 1500,
        trigger: "TaskCompleted",
        attach: gateAttach({
          cwd: box.cwd,
          env: {},
          forgeSlug: "x",
          state: readRunState("x", box.cwd),
          path: box.path,
        }),
      }),
      { path: box.path },
    );
    expect(gate.ok).toBe(true);
    closeLedger();

    // Council family: the CLI with its simulated default profile.
    const council = await spawn(
      box,
      COUNCIL,
      ["stdin", "--bead", BEAD, "--run-id", "c-1", "--json"],
      "Review this plan and its evidence",
    );
    expect(council.exitCode).toBe(0);

    const joined = await audit(box, ["--bead", BEAD]);
    expect(joined.map((event) => event.kind)).toEqual([
      "session.started",
      "tool.called",
      "run.phase.completed",
      "verdict.bound",
      "review.recorded",
      "gate.ran",
      "council.run.started",
      "council.run.finished",
    ]);
    const ids = joined.map((event) => event.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    // Every row is session S's; the session rows carry no bead of their own.
    for (const event of joined) expect(event.sessionId).toBe("S");
    expect(joined.slice(0, 2).map((event) => event.beadId)).toEqual([
      undefined,
      undefined,
    ]);

    const exact = await audit(box, ["--bead", BEAD, "--bead-exact"]);
    expect(exact.map((event) => event.kind)).toEqual([
      "run.phase.completed",
      "verdict.bound",
      "review.recorded",
      "gate.ran",
      "council.run.started",
      "council.run.finished",
    ]);
    for (const event of exact) expect(event.beadId).toBe(BEAD);
    expect(exact.map((event) => event.id)).toEqual(ids.slice(2));

    // Session T made a tool call in the same checkout and is in neither list.
    const everything = await audit(box, []);
    expect(
      everything.filter((event) => event.sessionId === "T").length,
    ).toBeGreaterThan(0);
  }, 120_000);
});
