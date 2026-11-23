import { expect, test } from "bun:test";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { observeProjectShift } from "./observations";
import { projectShiftRequestHash } from "./registry";

const workspace = "/fixture/workspace";
const request = {
  requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
  expectedCatalogRevision: 7,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
    runTimeout: "20m",
  },
};
const intent: ProjectShiftIntent = {
  projectId: FIXTURE_PROJECT_ID,
  workspace,
  shiftId: "shift-20261023-063000-0001",
  request,
  requestHash: projectShiftRequestHash(FIXTURE_PROJECT_ID, workspace, request),
  createdAt: "2026-10-23T06:30:00.000Z",
  attemptedAt: "2026-10-23T06:30:01.000Z",
};
const record = {
  shiftId: intent.shiftId,
  workspace,
  pid: 1234,
  state: "running",
  startedAt: "2026-10-23T06:30:02.000Z",
  deadline: "2026-10-23T08:30:02.000Z",
  options: {
    concurrency: 2,
    forMs: 7_200_000,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
    runTimeoutMs: 1_200_000,
    throttle: 0.85,
  },
  spentUsd: 3.4,
  unpriced: 1,
  admitted: 2,
  beads: [
    { beadId: "alpha-a", outcome: "review", attempts: 1 },
    { beadId: "alpha-b", outcome: "running", attempts: 2 },
  ],
  error: "PRIVATE-PROVIDER-PROMPT",
  commentError: "PRIVATE-COMMENT",
};

test("only the correlated actual shift record confirms running, stopping, recovery or stopped; raw error bodies stay private", () => {
  const running = observeProjectShift(intent, {
    record,
    alive: true,
    stopRequested: false,
  });
  expect(running.phase).toBe("running");
  expect(running.actual?.runTimeoutMs).toBe(1_200_000);
  expect(running.actual?.spentUsd).toBe(3.4);
  expect(running.actual?.unpriced).toBe(1);
  expect(running.actual?.reviewed).toBe(1);
  expect(running.actual?.running).toBe(1);
  expect(running.actual?.admitted).toBe(2);
  expect(
    observeProjectShift(intent, {
      record: { ...record, admitted: undefined },
      alive: true,
      stopRequested: false,
    }).actual?.admitted,
  ).toBeNull();
  expect(
    observeProjectShift(intent, { record, alive: true, stopRequested: true })
      .phase,
  ).toBe("stopping");
  expect(
    observeProjectShift(intent, { record, alive: false, stopRequested: true })
      .phase,
  ).toBe("needs-recovery");
  expect(
    observeProjectShift(intent, {
      record: {
        ...record,
        state: "stopped",
        reason: "operator",
        endedAt: "2026-10-23T06:31:00.000Z",
      },
      alive: false,
      stopRequested: true,
    }).phase,
  ).toBe("stopped");
  expect(JSON.stringify(running)).not.toContain("PRIVATE");
  expect(JSON.stringify(running)).not.toContain("alpha-a");
  for (const invalid of [
    { ...record, workspace: "/foreign" },
    { ...record, options: { ...record.options, maxUsd: 999 } },
    { ...record, options: { ...record.options, runTimeoutMs: undefined } },
    {
      ...record,
      startedAt: "2026-10-23T06:29:00.000Z",
      deadline: "2026-10-23T08:29:00.000Z",
    },
  ]) {
    const unknown = observeProjectShift(intent, {
      record: invalid,
      alive: true,
      stopRequested: false,
    });
    expect(unknown.phase).toBe("unknown");
    expect(unknown.actual).toBeNull();
  }
});

test("a saved request and a launch marker remain distinct from an actual shift; dead or mismatched markers are unknown", () => {
  expect(observeProjectShift({ ...intent, attemptedAt: null }, {}).phase).toBe(
    "reserved",
  );
  expect(observeProjectShift(intent, {}).phase).toBe("unknown");
  const launch = {
    shiftId: intent.shiftId,
    workspace,
    state: "starting",
    pid: 1234,
    alive: true,
    startedAt: "2026-10-23T06:30:01.000Z",
    requested: request.options,
  };
  expect(observeProjectShift(intent, { launch }).phase).toBe("starting");
  expect(observeProjectShift(intent, { launch }).actual).toBeNull();
  for (const invalid of [
    { ...launch, alive: false },
    { ...launch, pid: -1 },
    { ...launch, requested: { ...request.options, concurrency: 1 } },
  ])
    expect(observeProjectShift(intent, { launch: invalid }).phase).toBe(
      "unknown",
    );
  expect(
    observeProjectShift(intent, {
      launch: {
        ...launch,
        state: "failed",
        alive: false,
        endedAt: "2026-10-23T06:30:02.000Z",
      },
    }).phase,
  ).toBe("failed");
});

test("attended host observations report measured shares and throttling without granting cleanup authority to optional metadata", () => {
  const host = {
    asOf: "2026-10-23T06:31:00.000Z",
    cpu: 0.91,
    memory: 0.45,
    busy: true,
  };
  const observed = observeProjectShift(intent, {
    record: { ...record, host },
    alive: true,
  });
  expect(observed.phase).toBe("throttled");
  expect(observed.actual).toMatchObject({ host, throttle: 0.85 });
  for (const invalid of [
    undefined,
    { ...host, cpu: -1 },
    { ...host, memory: Infinity },
    { ...host, asOf: "invalid" },
  ]) {
    const source = { ...record, host: invalid };
    expect(
      observeProjectShift(intent, { record: source, alive: true }).actual?.host,
    ).toBeNull();
    expect(
      observeProjectShift(intent, {
        record: source,
        alive: true,
        stopRequested: true,
      }).phase,
    ).toBe("stopping");
    expect(
      observeProjectShift(intent, { record: source, alive: false }).phase,
    ).toBe("needs-recovery");
  }
  expect(
    observeProjectShift(intent, {
      record: {
        ...record,
        host: { ...host, cpu: null, memory: null, busy: false },
      },
      alive: true,
    }).actual?.host,
  ).toMatchObject({ cpu: null, memory: null, busy: false });
});
