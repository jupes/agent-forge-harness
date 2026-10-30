import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectShiftIntent,
  ProjectShiftStartRequest,
} from "../../types/project-shifts";
import type { ProjectShiftAttemptOrigin } from "../../types/shift-origin";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import type { PrivateExecInput } from "../executors/private-capture";
import { PRIVATE_CAPTURE_FAILURE } from "../executors/private-capture";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { SHIFTS_DIR } from "../scheduler/shift-store";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../sessions/registry";
import { scratchDirs } from "../test-scratch";
import {
  prepareShiftTurnSnapshot,
  shiftAttemptHash,
  shiftAttemptOrigin,
  shiftAttemptRequestId,
} from "./attempt-identity";
import {
  keeperStartFailureDiagnostic,
  keeperWaitFacts,
  physicalKeeperProofRoot,
} from "./keeper-compiled-proof";
import { projectShiftRequestHash } from "./registry";

type AttemptEvidenceContext = {
  intent: ProjectShiftIntent;
  projectId: string;
  workspace: string;
  originalRequestId: string;
  expectedRequestHash: string;
  shiftId: string;
  firstBeadId: string;
  attempt: 1;
};

async function seedOwnedAttemptEvidence(
  root: string,
  options: {
    origin?: Partial<ProjectShiftAttemptOrigin>;
    copies?: number;
    turnPhase?: "accepted" | "running" | "failed";
    processFrame?: boolean;
    recordWorkspace?: string;
    rowBeadId?: string;
    corruptRegistry?: boolean;
    wrongText?: string;
    wrongAbout?: Array<{ kind: "bead" | "run"; id: string }>;
    extraTurn?: boolean;
  } = {},
) {
  mkdirSync(join(root, ".git"), { recursive: true });
  const workspace = resolveCheckout(root).workspace,
    home = join(root, "home"),
    shiftId = "shift-20261025-130000-abcd",
    originalRequestId = "913c01ee-e854-4d0e-8d6c-a246304d74a1",
    firstBeadId = "alpha-work",
    runId = "fixture-run-1",
    recordWorkspace = options.recordWorkspace ?? workspace,
    stateDir = join(root, "fixture"),
    admissionsFile = join(stateDir, "provider-admissions.jsonl"),
    callsFile = join(stateDir, "calls.jsonl"),
    privateBody = "PRIVATE_ATTEMPT_BODY_SENTINEL",
    effort = "medium",
    processPid = 987654;
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(home, SHIFTS_DIR), { recursive: true });
  writeFileSync(admissionsFile, "");
  writeFileSync(callsFile, "");
  writeFileSync(
    join(home, SHIFTS_DIR, `${shiftId}.json`),
    JSON.stringify({
      shiftId,
      pid: 12345,
      workspace,
      startedAt: "2026-10-25T13:00:00.000Z",
      deadline: "2026-10-25T13:01:00.000Z",
      state: "stopped",
      reason: "halted",
      options: {},
      spentUsd: 0,
      unpriced: 0,
      admitted: 1,
      beads: [
        {
          beadId: options.rowBeadId ?? firstBeadId,
          runId,
          outcome: "released",
          attempts: 1,
        },
      ],
    }),
  );

  const request: ProjectShiftStartRequest = {
      requestId: originalRequestId,
      expectedCatalogRevision: 1,
      options: {
        for: "1m",
        concurrency: 1,
        maxBeads: 1,
        maxUsd: 5,
        repairs: 1,
        base: "main",
        smith: "claude-journeyman",
      },
    },
    intent: ProjectShiftIntent = {
      projectId: FIXTURE_PROJECT_ID,
      workspace,
      request,
      shiftId,
      requestHash: projectShiftRequestHash(
        FIXTURE_PROJECT_ID,
        workspace,
        request,
      ),
      createdAt: "2026-10-25T13:00:00.000Z",
      attemptedAt: "2026-10-25T13:00:01.000Z",
      executionStartedAt: "2026-10-25T13:00:02.000Z",
    },
    input: PrivateExecInput = {
      provider: "claude",
      beadId: firstBeadId,
      runId,
      workspace,
      cwd: workspace,
      smith: {
        name: "claude-journeyman",
        provider: "claude",
        model: "claude-sonnet-5-5",
        effort,
        enabled: true,
        tags: [],
      },
      command: [join(root, "bin", "claude")],
      stdin: privateBody,
      timeoutMs: 10_000,
    },
    attempt = 1,
    cliVersion = "2.1.293",
    canonicalOrigin = shiftAttemptOrigin(intent, input, attempt),
    origin: ProjectShiftAttemptOrigin = {
      ...canonicalOrigin,
      ...options.origin,
    },
    canonicalAttemptId = shiftAttemptRequestId(intent, input, attempt),
    canonicalAttemptHash = shiftAttemptHash(intent, input, attempt, cliVersion),
    registry = createSessionRegistry(home),
    records = [];
  const context: AttemptEvidenceContext = {
    intent,
    projectId: FIXTURE_PROJECT_ID,
    workspace,
    originalRequestId,
    expectedRequestHash: intent.requestHash,
    shiftId,
    firstBeadId,
    attempt: 1,
  };
  for (let index = 0; index < (options.copies ?? 1); index++) {
    const requestId = index === 0 ? canonicalAttemptId : randomUUID(),
      requestHash =
        index === 0
          ? canonicalAttemptHash
          : createHash("sha256").update(`fixture-${index}`).digest("hex");
    records.push(
      await registry.reserve(
        FIXTURE_PROJECT_ID,
        requestId,
        requestHash,
        () => ({
          mode: "task",
          provider: "claude",
          workspace: recordWorkspace,
          repository: recordWorkspace,
          worktree: recordWorkspace,
          beadId: origin.beadId,
          smith: "claude-journeyman",
          requestedModel: input.smith.model,
          requestedEffort: effort,
          origin: index === 0 ? origin : canonicalOrigin,
        }),
      ),
    );
  }
  const selected = records[0];
  if (selected && options.turnPhase) {
    const address = {
        kind: "session" as const,
        projectId: FIXTURE_PROJECT_ID,
        sessionId: selected.id,
      },
      store = createConversationStore(home, undefined, address),
      owner = randomUUID(),
      snapshot = prepareShiftTurnSnapshot(
        intent,
        input,
        attempt,
        cliVersion,
        selected.id,
      );
    await store.accept(FIXTURE_PROJECT_ID, {
      requestId: selected.requestId,
      expectedRevision: 0,
      text: privateBody,
      about: [
        { kind: "bead", id: origin.beadId },
        { kind: "run", id: origin.runId },
      ],
      shift: snapshot,
    });
    if (options.turnPhase !== "accepted") {
      await store.start(FIXTURE_PROJECT_ID, selected.requestId, owner);
      if (options.processFrame)
        await store.append(FIXTURE_PROJECT_ID, selected.requestId, owner, {
          kind: "process",
          pid: processPid,
          smith: selected.smith,
          requestedModel: selected.requestedModel,
          requestedEffort: selected.requestedEffort ?? "medium",
        });
      if (options.turnPhase === "failed")
        await store.finish(
          FIXTURE_PROJECT_ID,
          selected.requestId,
          owner,
          "failed",
          null,
        );
      if (options.extraTurn) {
        await store.accept(FIXTURE_PROJECT_ID, {
          requestId: randomUUID(),
          expectedRevision: store.read(FIXTURE_PROJECT_ID).revision,
          text: "extra fixture turn",
          about: [],
        });
      }
      if (options.wrongText !== undefined || options.wrongAbout) {
        const persisted = store.read(FIXTURE_PROJECT_ID),
          userFrame = persisted.frames.find(
            (frame) =>
              frame.turnId === selected.requestId &&
              frame.event.kind === "user",
          );
        if (!userFrame || userFrame.event.kind !== "user")
          throw new Error("Canonical fixture user frame was not persisted");
        if (options.wrongText !== undefined)
          userFrame.event.text = options.wrongText;
        if (options.wrongAbout) userFrame.event.about = options.wrongAbout;
        writeFileSync(
          conversationFile(home, FIXTURE_PROJECT_ID, address),
          JSON.stringify(persisted),
        );
      }
    }
  }
  if (options.corruptRegistry)
    writeFileSync(sessionRegistryFile(home), "{invalid registry");
  return {
    home,
    context,
    admissionsFile,
    callsFile,
    privateBody,
    processPid,
    attemptHash: canonicalAttemptHash,
    sessionId: selected?.id ?? "",
    attemptRequestId: selected?.requestId ?? "",
    facts() {
      return keeperWaitFacts(home, shiftId, admissionsFile, callsFile, context);
    },
  };
}

test("Keeper wait facts correlate only the exact first Shift-owned attempt", async () => {
  const scratch = scratchDirs();
  try {
    const positive = await seedOwnedAttemptEvidence(
        scratch.make("owned attempt evidence positive "),
        { turnPhase: "running", processFrame: true },
      ),
      facts = positive.facts();
    expect(facts).toContain("attemptReservation=matched");
    expect(facts).toContain("ownerTurn=running");
    expect(facts).toContain("processFrame=observed");
    for (const privateValue of [
      positive.privateBody,
      positive.attemptHash,
      positive.home,
      positive.sessionId,
      positive.attemptRequestId,
      String(positive.processPid),
    ])
      expect(facts).not.toContain(privateValue);
    expect(facts.length).toBeLessThanOrEqual(800);

    const accepted = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence accepted "),
      { turnPhase: "accepted" },
    );
    expect(accepted.facts()).toContain("ownerTurn=accepted");
    const running = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence running "),
      { turnPhase: "running" },
    );
    expect(running.facts()).toContain("processFrame=not-observed");
    const terminal = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence terminal "),
      { turnPhase: "failed", processFrame: true },
    );
    expect(terminal.facts()).toContain("ownerTurn=failed");
    expect(terminal.facts()).toContain("processFrame=observed");
    const reservationOnly = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence reservation only "),
    );
    expect(reservationOnly.facts()).toContain("attemptReservation=matched");
    expect(reservationOnly.facts()).toContain("ownerTurn=unknown");
    expect(reservationOnly.facts()).toContain("processFrame=unknown");

    for (const invalidTurn of [
      { wrongText: "different private input" },
      {
        wrongAbout: [
          { kind: "run" as const, id: "fixture-run-1" },
          { kind: "bead" as const, id: "alpha-work" },
        ],
      },
      { extraTurn: true, turnPhase: "failed" as const },
    ]) {
      const invalid = await seedOwnedAttemptEvidence(
        scratch.make("owned attempt evidence invalid turn "),
        { turnPhase: "failed", ...invalidTurn },
      );
      expect(invalid.facts()).toContain("attemptReservation=matched");
      expect(invalid.facts()).toContain("ownerTurn=unknown");
      expect(invalid.facts()).toContain("processFrame=unknown");
    }

    for (const origin of [
      { originalRequestId: randomUUID() },
      { shiftId: "shift-20261025-130001-abcd" },
      { runId: "foreign-run" },
      { beadId: "foreign-bead" },
      { attempt: 2 },
    ]) {
      const foreign = await seedOwnedAttemptEvidence(
        scratch.make("owned attempt evidence foreign "),
        { origin },
      );
      expect(foreign.facts()).toContain("attemptReservation=unknown");
    }

    const absent = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence absent "),
      { copies: 0 },
    );
    expect(absent.facts()).toContain("attemptReservation=unknown");
    const malformed = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence malformed "),
      { corruptRegistry: true },
    );
    expect(malformed.facts()).toContain("attemptReservation=unknown");
    const ambiguous = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence ambiguous "),
      { copies: 2 },
    );
    expect(ambiguous.facts()).toContain("attemptReservation=ambiguous");
    const outside = scratch.make("owned attempt evidence other workspace ");
    mkdirSync(join(outside, ".git"), { recursive: true });
    const scopeMismatch = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence scope mismatch "),
      { recordWorkspace: resolveCheckout(outside).workspace },
    );
    expect(scopeMismatch.facts()).toContain("attemptReservation=unknown");
    const firstBeadMismatch = await seedOwnedAttemptEvidence(
      scratch.make("owned attempt evidence first bead mismatch "),
      { rowBeadId: "other-bead" },
    );
    expect(firstBeadMismatch.facts()).toContain("attemptReservation=unknown");
  } finally {
    scratch.cleanup();
  }
});

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
    expect(facts).not.toContain("attemptReservation=");
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
