/** Bounded, testable observation of the exact Windows job retained by a guard. */

export const WINDOWS_JOB_SETTLEMENT_MS = 1000;
const POLL_MS = 10;
const MAX_JOB_PROCESSES = 64;
const SETTLEMENT_ERROR =
  "Windows owned process cleanup could not be confirmed.";

export const WINDOWS_JOB_SETTLEMENT_FAILURE_PHASES = [
  "guard-root",
  "capture-root",
  "capture-members",
  "verify-census-members",
  "verify-census-total-read",
  "verify-census-generation",
  "verify-census-active-read",
  "verify-census-unaccounted",
  "verify-census-unretained",
  "terminate",
  "observe-settlement",
  "observe-members-read",
  "observe-members-invalid",
  "observe-total-read",
  "observe-total-invalid",
  "observe-total-changed",
  "observe-active-read",
  "observe-active-invalid",
  "observe-unaccounted",
  "observe-unretained",
  "observe-signal-read",
  "observe-signal-indeterminate",
  "observe-clock",
  "observe-wait",
  "final-census",
  "close-process-handles",
  "close-job-handle",
  "deadline",
] as const;
export type WindowsJobSettlementFailurePhase =
  (typeof WINDOWS_JOB_SETTLEMENT_FAILURE_PHASES)[number];

export type WindowsJobSettlementGenerationFailureReason =
  | "generation-decreased"
  | "growth-count-not-covered"
  | "growth-over-cap"
  | "growth-member-unretained";

export interface WindowsJobSettlementGenerationFailureWitness {
  readonly reason: WindowsJobSettlementGenerationFailureReason;
  readonly initialTotal: number | null;
  readonly capturedTotal: number | null;
  readonly retainedCount: number;
  readonly capturedMemberCount: number;
}

export interface WindowsJobSettlementUnaccountedFailureWitness {
  readonly activeCount: number | null;
  readonly retainedCount: number | null;
  readonly capturedMemberCount: number | null;
  readonly initialTotal: number | null;
  readonly capturedTotal: number | null;
}

type WindowsJobSettlementFailureObserver = (
  phase: WindowsJobSettlementFailurePhase,
  generationFailure?: WindowsJobSettlementGenerationFailureWitness,
  unaccountedFailure?: WindowsJobSettlementUnaccountedFailureWitness,
) => void;

const MAX_DIAGNOSTIC_UINT32 = 0xffff_ffff;

function diagnosticUint32(value: number): number | null {
  return value <= MAX_DIAGNOSTIC_UINT32 ? value : null;
}

export interface JobMembers {
  processIds: readonly number[];
  complete: boolean;
}

/** Only kernel ownership and process-state facts cross this boundary. */
export interface WindowsJobSettlementApi<Job, Process> {
  /** Optional trusted, synchronous refusal-phase observer. */
  onFailurePhase?: WindowsJobSettlementFailureObserver;
  terminate(job: Job): boolean;
  /** Cumulative job-generation fence; never used as an exit witness. */
  totalProcesses(job: Job): number | null;
  /** Additional negative check only; equality/zero never proves completion. */
  activeProcesses(job: Job): number | null;
  members(job: Job): JobMembers | null;
  openProcess(pid: number): Process | null;
  belongsToJob(process: Process, job: Job): boolean | null;
  creationTime(process: Process): string | null;
  signaled(process: Process): boolean | null;
  closeProcess(process: Process): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

type RetainedProcess<Process> = {
  handle: Process;
  creationTime: string;
};

export interface AssignedRootProcess<Process> {
  pid: number;
  handle: Process;
  creationTime: string;
}

/**
 * Capture same-job process identities before requesting termination, then
 * observe every captured handle even if termination removes its PID from the
 * job list before the process object becomes signaled. The lifetime process
 * count fences members created during capture or termination; handles retained
 * through the final recheck prevent PID reuse.
 */
export async function settleWindowsJob<Job, Process>(
  api: WindowsJobSettlementApi<Job, Process>,
  job: Job,
  assignedRoot: AssignedRootProcess<Process>,
  deadlineMs = WINDOWS_JOB_SETTLEMENT_MS,
): Promise<void> {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > WINDOWS_JOB_SETTLEMENT_MS
  ) {
    try {
      api.closeProcess(assignedRoot.handle);
    } catch {
      // Invalid bounds already refuse; still attempt to release the transferred handle.
    }
    throw new Error("Invalid Windows job settlement bound.");
  }

  const deadline = api.now() + deadlineMs;
  const retained = new Map<number, RetainedProcess<Process>>([
    [
      assignedRoot.pid,
      { handle: assignedRoot.handle, creationTime: assignedRoot.creationTime },
    ],
  ]);
  let phase: WindowsJobSettlementFailurePhase = "capture-root",
    failurePhase: WindowsJobSettlementFailurePhase | null = null,
    generationFailure: WindowsJobSettlementGenerationFailureWitness | null =
      null,
    unaccountedFailure: WindowsJobSettlementUnaccountedFailureWitness | null =
      null;
  const refuse: (failedAt?: WindowsJobSettlementFailurePhase) => never = (
    failedAt = phase,
  ) => {
    failurePhase ??= failedAt;
    throw new Error(SETTLEMENT_ERROR);
  };
  const readTotalProcesses = (invalidPhase = phase): number => {
    const total = api.totalProcesses(job);
    if (total === null || !Number.isSafeInteger(total) || total < 0)
      refuse(invalidPhase);
    return total;
  };
  const hasUnaccountedProcesses = (census?: {
    capturedMemberCount: number;
    initialTotal: number;
    capturedTotal: number;
  }, invalidPhase = phase): boolean => {
    const active = api.activeProcesses(job);
    if (active === null || !Number.isSafeInteger(active) || active < 0)
      refuse(invalidPhase);
    const unaccounted = active > retained.size;
    if (unaccounted && census !== undefined) {
      unaccountedFailure = {
        activeCount: diagnosticUint32(active),
        retainedCount: diagnosticUint32(retained.size),
        capturedMemberCount: diagnosticUint32(census.capturedMemberCount),
        initialTotal: diagnosticUint32(census.initialTotal),
        capturedTotal: diagnosticUint32(census.capturedTotal),
      };
    }
    // This can only refuse conservatively. It is never used to assert that
    // retained members have exited or that a lower count proves completion.
    return unaccounted;
  };
  const readMembers = (invalidPhase = phase): readonly number[] => {
    const result = api.members(job);
    if (
      result === null ||
      !result.complete ||
      result.processIds.length > MAX_JOB_PROCESSES
    )
      refuse(invalidPhase);
    const seen = new Set<number>();
    for (const pid of result.processIds) {
      if (!Number.isSafeInteger(pid) || pid < 1 || seen.has(pid))
        refuse(invalidPhase);
      seen.add(pid);
    }
    return result.processIds;
  };
  const retain = (pid: number): RetainedProcess<Process> => {
    const existing = retained.get(pid);
    if (existing) return existing;
    const handle = api.openProcess(pid);
    if (handle === null) refuse();
    try {
      const belongs = api.belongsToJob(handle, job),
        creationTime = api.creationTime(handle);
      if (
        belongs !== true ||
        creationTime === null ||
        !/^[0-9a-f]{16}$/i.test(creationTime)
      )
        refuse();
      const row = { handle, creationTime };
      retained.set(pid, row);
      return row;
    } catch {
      try {
        api.closeProcess(handle);
      } catch {
        // A failed close still makes settlement unconfirmed.
      }
      refuse();
    }
  };
  const observationNow = (): number => {
    phase = "observe-clock";
    return api.now();
  };

  let confirmed = false;
  try {
    // Establish a generation fence, then retain exact same-job process
    // handles before TerminateJobObject can remove PIDs from the job list.
    if (
      !Number.isSafeInteger(assignedRoot.pid) ||
      assignedRoot.pid < 1 ||
      !/^[0-9a-f]{16}$/i.test(assignedRoot.creationTime) ||
      api.creationTime(assignedRoot.handle) !== assignedRoot.creationTime
    )
      refuse("capture-root");
    phase = "capture-members";
    const initialTotal = readTotalProcesses(),
      initialMembers = readMembers();
    for (const pid of initialMembers) retain(pid);
    phase = "verify-census-members";
    const capturedMembers = readMembers();
    phase = "verify-census-total-read";
    const capturedTotal = readTotalProcesses();
    // Accept growth only when the lifetime count is covered by retained identities.
    // This count fences generations; it never proves exit by itself.
    // Settlement still requires every retained process handle to signal.
    let generationFailureReason: WindowsJobSettlementGenerationFailureReason | null =
      null;
    if (capturedTotal < initialTotal) {
      generationFailureReason = "generation-decreased";
    } else if (capturedTotal > initialTotal) {
      if (capturedTotal !== retained.size) {
        generationFailureReason = "growth-count-not-covered";
      } else if (retained.size > MAX_JOB_PROCESSES) {
        generationFailureReason = "growth-over-cap";
      } else if (capturedMembers.some((pid) => !retained.has(pid))) {
        generationFailureReason = "growth-member-unretained";
      }
    }
    if (generationFailureReason !== null) {
      generationFailure = {
        reason: generationFailureReason,
        initialTotal: diagnosticUint32(initialTotal),
        capturedTotal: diagnosticUint32(capturedTotal),
        retainedCount: retained.size,
        capturedMemberCount: capturedMembers.length,
      };
      failurePhase ??= "verify-census-generation";
      refuse("verify-census-generation");
    }
    phase = "verify-census-active-read";
    const unaccounted = hasUnaccountedProcesses({
      initialTotal,
      capturedTotal,
      capturedMemberCount: capturedMembers.length,
    });
    if (unaccounted) {
      failurePhase ??= "verify-census-unaccounted";
      refuse("verify-census-unaccounted");
    }
    phase = "verify-census-unretained";
    for (const pid of capturedMembers) if (!retained.has(pid)) refuse();
    if (api.now() >= deadline) refuse("deadline");
    phase = "terminate";
    if (!api.terminate(job)) refuse();

    while (observationNow() < deadline) {
      phase = "observe-members-read";
      const currentMembers = readMembers("observe-members-invalid");
      phase = "observe-total-read";
      // TotalProcesses detects members added since capture; it does not prove
      // that any member has exited.
      if (readTotalProcesses("observe-total-invalid") !== capturedTotal)
        refuse("observe-total-changed");
      phase = "observe-active-read";
      if (hasUnaccountedProcesses(undefined, "observe-active-invalid"))
        refuse("observe-unaccounted");
      phase = "observe-unretained";
      if (currentMembers.some((pid) => !retained.has(pid))) refuse();
      let allSignaled = true;
      for (const process of retained.values()) {
        phase = "observe-signal-read";
        const state = api.signaled(process.handle);
        if (state === null) refuse("observe-signal-indeterminate");
        if (!state) allSignaled = false;
      }

      if (allSignaled) {
        phase = "final-census";
        if (readTotalProcesses() !== capturedTotal || hasUnaccountedProcesses())
          refuse();
        const finalMembers = readMembers();
        // Recheck generation only after every retained process handle is
        // signaled and the final same-job membership snapshot is available.
        if (
          api.now() < deadline &&
          readTotalProcesses() === capturedTotal &&
          !hasUnaccountedProcesses() &&
          finalMembers.every((pid) => retained.has(pid))
        ) {
          confirmed = true;
          break;
        }
      }
      const waitMs = Math.min(
        POLL_MS,
        Math.max(0, deadline - observationNow()),
      );
      phase = "observe-wait";
      await api.sleep(waitMs);
    }
  } catch {
    failurePhase ??= phase;
    confirmed = false;
  }
  if (!confirmed) failurePhase ??= "deadline";
  let closeFailed = false;
  for (const { handle } of retained.values()) {
    try {
      api.closeProcess(handle);
    } catch {
      // Close every retained identity handle; the caller keeps the job guarded on failure.
      closeFailed = true;
      failurePhase ??= "close-process-handles";
    }
  }
  if (!confirmed || closeFailed) {
    failurePhase ??= "deadline";
    try {
      if (
        failurePhase === "verify-census-generation" &&
        generationFailure !== null
      )
        api.onFailurePhase?.(failurePhase, generationFailure);
      else if (
        failurePhase === "verify-census-unaccounted" &&
        unaccountedFailure !== null
      )
        api.onFailurePhase?.(failurePhase, undefined, unaccountedFailure);
      else api.onFailurePhase?.(failurePhase);
    } catch {
      // Diagnostic observers cannot change the settlement result.
    }
    throw new Error(SETTLEMENT_ERROR);
  }
}
