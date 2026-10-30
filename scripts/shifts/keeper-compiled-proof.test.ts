import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectShiftStartRequest } from "../../types/project-shifts";
import { PRIVATE_CAPTURE_FAILURE } from "../executors/private-capture";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { SHIFTS_DIR } from "../scheduler/shift-store";
import { scratchDirs } from "../test-scratch";
import {
  keeperStartFailureDiagnostic,
  keeperWaitFacts,
  physicalKeeperProofRoot,
} from "./keeper-compiled-proof";
import { projectShiftRequestHash } from "./registry";

test("compiled Keeper fixture shares the disk-canonical workspace for scope and request hashes", () => {
  const scratch = scratchDirs();
  try {
    const parent = scratch.make("compiled Keeper path alias "),
      actual = join(parent, "actual workspace"),
      alias = join(parent, "alias workspace");
    mkdirSync(join(actual, ".git"), { recursive: true });
    symlinkSync(actual, alias, "junction");

    const physical = physicalKeeperProofRoot(alias),
      served = resolveCheckout(alias).workspace,
      catalogRoot =
        projectCatalogFixture(served).projects[0]?.workspaces[0]?.root;
    expect(workspaceKey(physical)).toBe(workspaceKey(served));
    expect(workspaceKey(alias)).not.toBe(workspaceKey(served));
    expect(catalogRoot).toBe(served);
    expect(workspaceKey(catalogRoot ?? "")).toBe(workspaceKey(served));

    const request: ProjectShiftStartRequest = {
      requestId: "913c01ee-e854-4d0e-8d6c-a246304d74a1",
      expectedCatalogRevision: 1,
      options: {
        for: "1m",
        concurrency: 1,
        maxBeads: 1,
        maxUsd: 5,
        repairs: 1,
        base: "main",
      },
    };
    expect(
      projectShiftRequestHash(FIXTURE_PROJECT_ID, catalogRoot!, request),
    ).toBe(projectShiftRequestHash(FIXTURE_PROJECT_ID, served, request));

    if (process.platform === "win32") {
      const extended = `\\\\?\\${alias}`;
      expect(physical).not.toBe(served);
      expect(workspaceKey(extended)).not.toBe(workspaceKey(served));
      expect(physicalKeeperProofRoot(extended)).toBe(physical);
    }
  } finally {
    scratch.cleanup();
  }
});

test("Keeper compiled proof reports only a strict bounded public refusal error", async () => {
  const response = new Response(
    JSON.stringify({
      ok: false,
      data: null,
      error: "The original Shift review could not be verified.",
    }),
    { status: 503 },
  );
  expect(await keeperStartFailureDiagnostic(response)).toBe(
    'status=503; refusal="The original Shift review could not be verified."',
  );
});

test("Keeper compiled proof hides malformed, oversized and nonstandard refusal bodies", async () => {
  const malformed = new Response(
      JSON.stringify({ ok: false, data: null, error: "bad", extra: "private" }),
      { status: 400 },
    ),
    tooLong = new Response(
      JSON.stringify({ ok: false, data: null, error: "x".repeat(513) }),
      { status: 409 },
    );
  let cancelled = false;
  const oversized = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_097));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 503 },
  );
  expect(await keeperStartFailureDiagnostic(malformed)).toBe(
    "status=400; refusal=malformed",
  );
  expect(await keeperStartFailureDiagnostic(tooLong)).toBe(
    "status=409; refusal=malformed",
  );
  expect(await keeperStartFailureDiagnostic(oversized)).toBe(
    "status=503; refusal=oversized",
  );
  expect(cancelled).toBe(true);
});

test("Keeper first-admission timeout facts omit native-tool arguments and stay bounded", () => {
  const scratch = scratchDirs();
  try {
    const home = scratch.make("compiled Keeper wait facts "),
      shiftId = "shift-20261025-120000-abcd",
      shiftDir = join(home, SHIFTS_DIR),
      stateDir = join(home, "fixture"),
      admissionsFile = join(stateDir, "provider-admissions.jsonl"),
      callsFile = join(stateDir, "calls.jsonl");
    mkdirSync(shiftDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(shiftDir, `${shiftId}.json`),
      JSON.stringify({
        shiftId,
        pid: 12345,
        workspace: "C:/fixture",
        startedAt: "2026-10-25T12:00:00.000Z",
        deadline: "2026-10-25T12:01:00.000Z",
        state: "stopped",
        reason: "The inert native fixture refused worktree creation.",
        options: {},
        spentUsd: 0,
        unpriced: 0,
        beads: [],
      }),
    );
    writeFileSync(admissionsFile, `${JSON.stringify({ pid: 12345 })}\n`);
    writeFileSync(
      callsFile,
      `${JSON.stringify({
        tool: "C:/fixture/bin/git.exe",
        args: [
          "worktree",
          "add",
          "-b",
          "branch",
          "--",
          "C:/PRIVATE/path",
          "SECRET_ARGUMENT",
        ],
      })}\n`,
    );

    const facts = keeperWaitFacts(home, shiftId, admissionsFile, callsFile);
    expect(facts).toContain("shiftState=stopped");
    expect(facts).toContain(
      "The inert native fixture refused worktree creation.",
    );
    expect(facts).toContain("admissionCount=1");
    expect(facts).toContain("git:worktree add");
    expect(facts).not.toContain("PRIVATE");
    expect(facts).not.toContain("SECRET_ARGUMENT");
    expect(facts.length).toBeLessThanOrEqual(800);
  } finally {
    scratch.cleanup();
  }
});

test("Keeper timeout facts classify only fixed errors and aggregate bounded bead metadata", () => {
  const scratch = scratchDirs();
  try {
    const home = scratch.make("compiled Keeper bounded facts "),
      shiftId = "shift-20261025-120001-abcd",
      shiftDir = join(home, SHIFTS_DIR),
      stateDir = join(home, "fixture"),
      recordFile = join(shiftDir, `${shiftId}.json`),
      admissionsFile = join(stateDir, "provider-admissions.jsonl"),
      callsFile = join(stateDir, "calls.jsonl"),
      base: Record<string, unknown> = {
        shiftId,
        pid: 12345,
        workspace: "C:/fixture",
        startedAt: "2026-10-25T12:00:00.000Z",
        deadline: "2026-10-25T12:01:00.000Z",
        state: "stopped",
        reason: "halted",
        options: {},
        spentUsd: 0,
        unpriced: 0,
        admitted: 1,
        beads: [],
      };
    mkdirSync(shiftDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(admissionsFile, "");
    writeFileSync(callsFile, "");
    const factsFor = (record: Record<string, unknown>): string => {
      writeFileSync(recordFile, JSON.stringify(record));
      return keeperWaitFacts(home, shiftId, admissionsFile, callsFile);
    };

    for (const { record, classification } of [
      {
        record: { ...base, error: PRIVATE_CAPTURE_FAILURE },
        classification: "private-capture",
      },
      {
        record: { ...base, error: "the shift failed: PRIVATE_LOOP_DETAIL" },
        classification: "shift-loop",
      },
      { record: base, classification: "none" },
      {
        record: { ...base, error: "PRIVATE_OTHER_DETAIL" },
        classification: "other",
      },
    ]) {
      const facts = factsFor(record);
      expect(facts).toContain(`errorClass=${classification}`);
      expect(facts).not.toContain(PRIVATE_CAPTURE_FAILURE);
      expect(facts).not.toContain("the shift failed:");
      expect(facts).not.toContain("PRIVATE_LOOP_DETAIL");
      expect(facts).not.toContain("PRIVATE_OTHER_DETAIL");
    }

    for (const value of [0, 100])
      expect(factsFor({ ...base, admitted: value })).toContain(
        `recordAdmitted=${value}`,
      );
    for (const value of [-1, 101, 1.5])
      expect(factsFor({ ...base, admitted: value })).toContain(
        "recordAdmitted=unknown",
      );

    expect(
      factsFor({
        ...base,
        beads: [
          { outcome: "running", attempts: 1 },
          { outcome: "released", attempts: 2 },
        ],
      }),
    ).toContain("beadFacts=2;1,0,1,0,0,0;3");
    expect(
      factsFor({
        ...base,
        beads: [{ outcome: "private", attempts: 12 }],
      }),
    ).toContain("beadFacts=unknown");
  } finally {
    scratch.cleanup();
  }
});
