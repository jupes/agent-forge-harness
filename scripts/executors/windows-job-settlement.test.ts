import { expect, test } from "bun:test";
import {
  type AssignedRootProcess,
  settleWindowsJob,
  WINDOWS_JOB_SETTLEMENT_MS,
  type WindowsJobSettlementApi,
  type WindowsJobSettlementFailurePhase,
} from "./windows-job-settlement";

type FakeProcess = {
  pid: number;
  creationTime: string;
  inJob: boolean;
  signaled: boolean | null;
};

function fixture(members: number[] = []) {
  const root = processRow(900),
    rootIdentity: AssignedRootProcess<FakeProcess> = {
      pid: root.pid,
      handle: root,
      creationTime: root.creationTime,
    },
    processes = new Map<number, FakeProcess>([[root.pid, root]]),
    calls: string[] = [],
    closed: number[] = [];
  let now = 0,
    total = members.length + 1,
    active = members.length + 1,
    totalSnapshots: (number | null)[] = [],
    activeSnapshots: (number | null)[] = [],
    snapshots: (number[] | null)[] = [members];
  const api: WindowsJobSettlementApi<object, FakeProcess> = {
    terminate() {
      calls.push("terminate");
      return true;
    },
    totalProcesses() {
      calls.push("total");
      const next = totalSnapshots.shift();
      return next === undefined ? total : next;
    },
    activeProcesses() {
      calls.push("active");
      const next = activeSnapshots.shift();
      return next === undefined ? active : next;
    },
    members() {
      calls.push("members");
      const next = snapshots.shift();
      if (next === null) return null;
      if (next !== undefined) return { processIds: next, complete: true };
      return { processIds: members, complete: true };
    },
    openProcess(pid) {
      calls.push(`open:${pid}`);
      return processes.get(pid) ?? null;
    },
    belongsToJob(process) {
      calls.push(`belongs:${process.pid}`);
      return process.inJob;
    },
    creationTime(process) {
      calls.push(`creation:${process.pid}`);
      return process.creationTime;
    },
    signaled(process) {
      calls.push(`signaled:${process.pid}`);
      return process.signaled;
    },
    closeProcess(process) {
      calls.push(`close:${process.pid}`);
      closed.push(process.pid);
    },
    now: () => now,
    async sleep(ms) {
      calls.push("sleep");
      now += ms;
    },
  };
  return {
    api,
    calls,
    closed,
    processes,
    rootIdentity,
    setSnapshots(value: (number[] | null)[]) {
      snapshots = value;
    },
    setTotals(value: (number | null)[]) {
      totalSnapshots = value;
    },
    setTotal(value: number) {
      total = value;
    },
    setActive(value: number) {
      active = value;
    },
    setActiveSnapshots(value: (number | null)[]) {
      activeSnapshots = value;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

function processRow(
  pid: number,
  changes: Partial<FakeProcess> = {},
): FakeProcess {
  return {
    pid,
    creationTime: `${pid.toString(16).padStart(16, "0")}`,
    inJob: true,
    signaled: true,
    ...changes,
  };
}

const settle = <Job extends object>(
  f: ReturnType<typeof fixture>,
  job: Job,
  ms = 50,
) => settleWindowsJob(f.api, job, f.rootIdentity, ms);

test("a refused job census reports its bounded failure phase", async () => {
  const f = fixture(),
    phases: WindowsJobSettlementFailurePhase[] = [];
  f.setSnapshots([null]);
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: WindowsJobSettlementFailurePhase) {
      phases.push(phase);
    },
  });

  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(phases).toEqual(["capture-members"]);
});

test("a throwing refusal observer cannot change settlement or handle cleanup", async () => {
  const f = fixture();
  f.setSnapshots([null]);
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase() {
      throw new Error("private observer failure");
    },
  });

  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(f.closed).toEqual([900]);
});

test("a failed process-handle close is reported after all handles are attempted", async () => {
  const f = fixture([21]),
    phases: WindowsJobSettlementFailurePhase[] = [];
  f.processes.set(21, processRow(21));
  const closeAttempts: number[] = [];
  f.api.closeProcess = (process) => {
    closeAttempts.push(process.pid);
    f.closed.push(process.pid);
    if (process.pid === 21) throw new Error("private native close detail");
  };
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: WindowsJobSettlementFailurePhase) {
      phases.push(phase);
    },
  });

  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(closeAttempts).toEqual([900, 21]);
  expect(phases).toEqual(["close-process-handles"]);
});

test("deadline refusal is reported without extending the settlement clock", async () => {
  const f = fixture(),
    phases: WindowsJobSettlementFailurePhase[] = [];
  f.rootIdentity.handle.signaled = false;
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: WindowsJobSettlementFailurePhase) {
      phases.push(phase);
    },
  });

  await expect(
    settleWindowsJob(
      diagnosticApi,
      {},
      f.rootIdentity,
      WINDOWS_JOB_SETTLEMENT_MS,
    ),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(f.calls.filter((call) => call === "sleep").length).toBe(
    WINDOWS_JOB_SETTLEMENT_MS / 10,
  );
  expect(phases).toEqual(["deadline"]);
});

test("an empty owned job settles after termination", async () => {
  const f = fixture();
  await settle(f, {});
  expect(f.calls.indexOf("creation:900")).toBeLessThan(
    f.calls.indexOf("terminate"),
  );
  expect(f.closed).toEqual([900]);
});

test("signaled members can settle while identity handles keep them listed", async () => {
  const f = fixture([21]);
  f.processes.set(21, processRow(21));
  f.api.terminate = () => {
    expect(f.calls).toContain("open:21");
    expect(f.closed).toEqual([]);
    return true;
  };
  await settle(f, {});
  expect(f.closed.sort((left, right) => left - right)).toEqual([21, 900]);
});

test("a changed member generation refuses settlement", async () => {
  const f = fixture([31]);
  f.processes.set(31, processRow(31));
  f.setTotals([2, 3]);
  f.setTotal(3);
  const phases: string[] = [];
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: string) {
      phases.push(phase);
    },
  });
  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(f.closed.sort()).toEqual([31, 900]);
  expect(f.calls).not.toContain("active");
  expect(phases).toEqual(["verify-census-generation"]);
  expect(f.calls.filter((call) => call.startsWith("open:"))).toEqual([
    "open:31",
  ]);
});

test("a generation refusal reports bounded facts from the rejected census", async () => {
  const f = fixture([31]);
  f.processes.set(31, processRow(31));
  f.setTotals([2, 3]);
  f.setTotal(3);
  const phases: string[] = [],
    witnesses: unknown[] = [];
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: string, witness?: unknown) {
      phases.push(phase);
      witnesses.push(witness);
    },
  });

  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(phases).toEqual(["verify-census-generation"]);
  expect(witnesses).toEqual([
    {
      reason: "growth-count-not-covered",
      initialTotal: 2,
      capturedTotal: 3,
      retainedCount: 2,
      capturedMemberCount: 1,
    },
  ]);
  expect(f.calls).not.toContain("active");
  expect(f.closed.sort()).toEqual([31, 900]);
});

test("fully retained growth still waits for every retained process handle", async () => {
  const f = fixture([21]),
    child = processRow(21, { signaled: false }),
    phases: WindowsJobSettlementFailurePhase[] = [];
  f.processes.set(21, child);
  f.setTotals([1, 2]);
  f.setTotal(2);
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: WindowsJobSettlementFailurePhase) {
      phases.push(phase);
    },
  });
  let releaseChild!: () => void;
  const childRelease = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let settled = false;
  let failure: unknown;
  f.api.sleep = async (ms) => {
    f.calls.push("sleep");
    await childRelease;
    child.signaled = true;
    f.setNow(ms);
  };
  const settlement = settleWindowsJob(diagnosticApi, {}, f.rootIdentity).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    },
  );

  expect(phases).toEqual([]);
  expect(f.calls).toContain("sleep");
  expect(settled).toBe(false);
  expect(f.closed).toEqual([]);
  expect(f.calls.indexOf("open:21")).toBeLessThan(f.calls.indexOf("terminate"));
  expect(f.calls.indexOf("belongs:21")).toBeLessThan(
    f.calls.indexOf("terminate"),
  );
  expect(f.calls.indexOf("creation:21")).toBeLessThan(
    f.calls.indexOf("terminate"),
  );

  releaseChild();
  await settlement;
  expect(settled).toBe(true);
  expect(failure).toBeUndefined();
  expect(f.closed.sort()).toEqual([21, 900]);
  expect(phases).toEqual([]);
});

test("a decreasing captured generation refuses settlement", async () => {
  const f = fixture([31]),
    phases: WindowsJobSettlementFailurePhase[] = [];
  f.processes.set(31, processRow(31));
  f.setTotals([2, 1]);
  f.setTotal(1);
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: WindowsJobSettlementFailurePhase) {
      phases.push(phase);
    },
  });

  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(phases).toEqual(["verify-census-generation"]);
  expect(f.calls).not.toContain("terminate");
  expect(f.closed.sort()).toEqual([31, 900]);
});

test("growth after a fully accounted capture refuses settlement", async () => {
  const f = fixture([32]),
    phases: WindowsJobSettlementFailurePhase[] = [];
  f.processes.set(32, processRow(32));
  f.setTotals([1, 2, 3]);
  f.setTotal(3);
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: WindowsJobSettlementFailurePhase) {
      phases.push(phase);
    },
  });

  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(phases).toEqual(["observe-settlement"]);
  expect(f.calls).toContain("terminate");
  expect(f.closed.sort()).toEqual([32, 900]);
});

test("fully retained growth above the identity cap refuses settlement", async () => {
  const memberIds = Array.from({ length: 64 }, (_, index) => index + 1),
    f = fixture(memberIds),
    phases: WindowsJobSettlementFailurePhase[] = [];
  for (const pid of memberIds) f.processes.set(pid, processRow(pid));
  f.setTotals([64, 65]);
  f.setTotal(65);
  const diagnosticApi = Object.assign(f.api, {
    onFailurePhase(phase: WindowsJobSettlementFailurePhase) {
      phases.push(phase);
    },
  });

  await expect(
    settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(phases).toEqual(["verify-census-generation"]);
  expect(f.calls).not.toContain("terminate");
  expect(f.closed).toHaveLength(65);
});

test("verification census failures report bounded read and member phases", async () => {
  const cases: {
    phase: string;
    prepare(f: ReturnType<typeof fixture>): void;
  }[] = [
    {
      phase: "verify-census-members",
      prepare(f) {
        f.setSnapshots([[31], null]);
      },
    },
    {
      phase: "verify-census-total-read",
      prepare(f) {
        f.setTotals([2, null]);
      },
    },
    {
      phase: "verify-census-active-read",
      prepare(f) {
        f.setActiveSnapshots([null]);
      },
    },
    {
      phase: "verify-census-unaccounted",
      prepare(f) {
        f.setActive(3);
      },
    },
    {
      phase: "verify-census-unretained",
      prepare(f) {
        f.setSnapshots([[31], [31, 32]]);
      },
    },
  ];

  for (const check of cases) {
    const f = fixture([31]),
      phases: string[] = [];
    f.processes.set(31, processRow(31));
    check.prepare(f);
    const diagnosticApi = Object.assign(f.api, {
      onFailurePhase(phase: string) {
        phases.push(phase);
      },
    });

    await expect(
      settleWindowsJob(diagnosticApi, {}, f.rootIdentity),
    ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
    expect(phases).toEqual([check.phase]);
    expect(f.closed.sort()).toEqual([31, 900]);
    expect(f.calls).not.toContain("terminate");
    if (check.phase === "verify-census-unretained")
      expect(f.calls).not.toContain("open:32");
  }
});

test("a live member is polled until its process handle is signaled", async () => {
  const f = fixture([41]),
    row = processRow(41, { signaled: false });
  f.processes.set(41, row);
  f.api.signaled = (process) => {
    if (f.calls.filter((call) => call === "sleep").length > 0)
      process.signaled = true;
    return process.signaled;
  };
  await settle(f, {});
  expect(f.calls).toContain("sleep");
  expect(f.closed.sort()).toEqual([41, 900]);
});

test("an empty post-termination list cannot replace a retained live-handle witness", async () => {
  const f = fixture([91, 92]),
    helper = processRow(92, { signaled: false });
  f.processes.set(91, processRow(91));
  f.processes.set(92, helper);
  f.setSnapshots([[91, 92], [91, 92], [], [], []]);
  f.api.sleep = async (ms) => {
    f.calls.push("sleep");
    helper.signaled = true;
    f.setNow(f.calls.filter((call) => call === "sleep").length * ms);
  };
  await settle(f, {});
  expect(f.closed.sort((left, right) => left - right)).toEqual([91, 92, 900]);
  expect(f.calls.filter((call) => call === "members")).toHaveLength(5);
});

test("a child appearing after initial capture refuses even if the earlier helper is not yet signaled", async () => {
  const f = fixture([101, 102]),
    helper = processRow(102, { signaled: false });
  f.processes.set(101, processRow(101));
  f.processes.set(102, helper);
  f.processes.set(103, processRow(103));
  f.setSnapshots([
    [101, 102],
    [101, 102],
    [101, 102],
    [102, 103],
  ]);
  f.setTotals([2, 2, 2, 3]);
  f.api.sleep = async (ms) => {
    f.calls.push("sleep");
    f.setNow(ms);
  };
  f.setTotals([3, 3, 3, 4]);
  f.setTotal(4);
  await expect(settle(f, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );
  expect(f.closed.sort()).toEqual([101, 102, 900]);
  expect(f.calls.filter((call) => call.startsWith("open:"))).toEqual([
    "open:101",
    "open:102",
  ]);
});

test("incomplete, oversized, duplicate, and invalid membership refuse", async () => {
  for (const ids of [
    { processIds: [51], complete: false },
    {
      processIds: Array.from({ length: 65 }, (_, index) => index + 1),
      complete: true,
    },
    { processIds: [51, 51], complete: true },
    { processIds: [0], complete: true },
  ]) {
    const f = fixture();
    f.api.members = () => ids;
    await expect(settle(f, {})).rejects.toThrow(
      "Windows owned process cleanup could not be confirmed.",
    );
  }
});

test("foreign, inaccessible, or identity-unreadable process handles refuse", async () => {
  for (const row of [
    processRow(61, { inJob: false }),
    processRow(61, { creationTime: "" }),
  ]) {
    const f = fixture([61]);
    f.processes.set(61, row);
    await expect(settle(f, {})).rejects.toThrow(
      "Windows owned process cleanup could not be confirmed.",
    );
    expect(f.closed.sort()).toEqual([61, 900]);
  }
  const f = fixture([62]);
  f.api.openProcess = () => null;
  f.processes.set(62, processRow(62));
  await expect(settle(f, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );
});

test("unknown handle state and query failures refuse instead of settling", async () => {
  const unknown = fixture([71]);
  unknown.processes.set(71, processRow(71, { signaled: null }));
  await expect(settle(unknown, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );
  expect(unknown.closed.sort()).toEqual([71, 900]);

  const failedAccounting = fixture();
  failedAccounting.api.totalProcesses = () => null;
  await expect(settle(failedAccounting, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );

  const unaccounted = fixture([73]);
  unaccounted.processes.set(73, processRow(73));
  unaccounted.setActive(3);
  await expect(settle(unaccounted, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );
  expect(unaccounted.closed.sort()).toEqual([73, 900]);

  const failedActive = fixture();
  failedActive.api.activeProcesses = () => null;
  await expect(settle(failedActive, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );

  const failedQuery = fixture();
  failedQuery.api.members = () => {
    throw new Error("private native diagnostic");
  };
  await expect(settle(failedQuery, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );
});

test("termination failure and deadline exhaustion refuse", async () => {
  const failed = fixture();
  failed.api.terminate = () => false;
  await expect(settle(failed, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );

  const f = fixture([81]);
  f.processes.set(81, processRow(81, { signaled: false }));
  await expect(
    settleWindowsJob(f.api, {}, f.rootIdentity, WINDOWS_JOB_SETTLEMENT_MS),
  ).rejects.toThrow("Windows owned process cleanup could not be confirmed.");
  expect(f.closed.sort()).toEqual([81, 900]);
});

test("a failed identity-handle close refuses after attempting every close", async () => {
  const f = fixture([82]);
  f.processes.set(82, processRow(82));
  f.api.closeProcess = (process) => {
    f.calls.push(`close:${process.pid}`);
    if (process.pid === 82) throw new Error("native close failure");
    f.closed.push(process.pid);
  };
  await expect(settle(f, {})).rejects.toThrow(
    "Windows owned process cleanup could not be confirmed.",
  );
  expect(f.calls.filter((call) => call.startsWith("close:"))).toEqual([
    "close:900",
    "close:82",
  ]);
});

test("invalid cleanup bounds are rejected before terminating the job", async () => {
  const f = fixture();
  await expect(settle(f, {}, WINDOWS_JOB_SETTLEMENT_MS + 1)).rejects.toThrow(
    "Invalid Windows job settlement bound.",
  );
  expect(f.calls).toEqual(["close:900"]);
});
