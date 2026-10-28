/**
 * Ends a supervised child's process tree when the harness process ends in a
 * way that runs none of its own code: killed outright (SIGKILL, or
 * TerminateProcess on Windows). `supervisor.ts`'s exit hook covers every
 * other way out; this covers that one, and is set up as each child starts.
 *
 * - Windows: a job object per child, with kill-on-close and no breakaway,
 *   and the child assigned to it as soon as it has started. What the child
 *   starts after that starts in the job too. The harness holds the job's only
 *   handle, so when the harness ends, however it ends, the system closes the
 *   handle and ends every process in the job. Through `bun:ffi` (kernel32).
 * - Elsewhere: a parent-watch. The child runs in a process group of its own
 *   (`supervise` starts it detached). A watcher (`sh`), itself detached, reads
 *   a pipe whose only writer is the harness; the read returns at end of file
 *   when the harness has ended, however it ended, and the watcher then kills
 *   the child's process group.
 *
 * `release()`, called after normal completion, stands the guard down without
 * ending anything: the job's kill-on-close is cleared before its handle is
 * closed, and the watcher is killed before its pipe is closed. A stopped
 * Windows child instead keeps its job until `settleStopped()` confirms that
 * every remaining member has physically exited.
 *
 * Not covered: on Windows, a process the child starts before it is assigned
 * to the job (the assignment follows `Bun.spawn` at once, ahead of the
 * child's own start-up), or one started with breakaway; elsewhere, a process
 * that leaves the child's process group. A guard that cannot be set up (no
 * job object, no `sh`) guards nothing, silently: the child runs as it did
 * before this guard, and the exit hook still covers every other way out.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import {
  type JobMembers,
  settleWindowsJob,
  WINDOWS_JOB_SETTLEMENT_MS,
  type WindowsJobSettlementFailurePhase,
  type WindowsJobSettlementApi,
} from "./windows-job-settlement";

export interface TreeGuard {
  /** Stand the guard down, ending nothing. Safe to call more than once. */
  release(): void;
  /** Windows only: close the kill-on-close job without clearing its limit. */
  terminate?(): void;
  /** Windows only: terminate and physically settle this exact owned job. */
  settleStopped?(): Promise<void>;
}

const UNGUARDED: TreeGuard = { release: () => undefined };

// ── Windows: a job object ──────────────────────────────────────────────────

/** `JobObjectExtendedLimitInformation`. */
const EXTENDED_LIMIT_INFORMATION = 9;
/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. */
const KILL_ON_JOB_CLOSE = 0x2000;
/** `sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)` on a 64-bit process. */
const EXTENDED_LIMIT_SIZE = 144;
/** Offset of `BasicLimitInformation.LimitFlags` in that structure. */
const LIMIT_FLAGS_OFFSET = 16;
/** `PROCESS_SET_QUOTA | PROCESS_TERMINATE`: what `AssignProcessToJobObject` needs. */
const ASSIGN_ACCESS = 0x0100 | 0x0001;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const ASSIGNED_ROOT_ACCESS =
  ASSIGN_ACCESS | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

function isNullHandle(value: unknown): boolean {
  return value === null || value === 0 || value === 0n;
}

function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    SetInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    TerminateJobObject: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    QueryInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    IsProcessInJob: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    WaitForSingleObject: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.ptr,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

type Kernel32 = ReturnType<typeof openKernel32>;
type KernelHandle = ReturnType<Kernel32["CreateJobObjectW"]>;
let kernel32: Kernel32 | null | undefined;

/** kernel32's job functions, loaded once; null when they cannot be loaded. */
function jobApi(): Kernel32 | null {
  if (kernel32 === undefined) {
    try {
      kernel32 = openKernel32();
    } catch {
      kernel32 = null;
    }
  }
  return kernel32;
}

/** Set the job's limit flags (and nothing else): kill-on-close, or none. */
function setLimitFlags(
  api: Kernel32,
  job: KernelHandle,
  flags: number,
): boolean {
  const info = new Uint8Array(EXTENDED_LIMIT_SIZE);
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, flags, true);
  return (
    api.SetInformationJobObject(
      job,
      EXTENDED_LIMIT_INFORMATION,
      ptr(info),
      EXTENDED_LIMIT_SIZE,
    ) !== 0
  );
}

function processCreationTime(
  api: Kernel32,
  processHandle: KernelHandle,
): string | null {
  const creation = new Uint32Array(2),
    exit = new Uint32Array(2),
    kernel = new Uint32Array(2),
    user = new Uint32Array(2);
  if (
    api.GetProcessTimes(
      processHandle,
      ptr(creation),
      ptr(exit),
      ptr(kernel),
      ptr(user),
    ) === 0
  )
    return null;
  return ((BigInt(creation[1] ?? 0) << 32n) | BigInt(creation[0] ?? 0))
    .toString(16)
    .padStart(16, "0");
}

/** Query the exact job's bounded process list and the minimum identity facts. */
function windowsJobSettlementApi(
  api: Kernel32,
  onFailurePhase?: (phase: WindowsJobSettlementFailurePhase) => void,
): WindowsJobSettlementApi<KernelHandle, KernelHandle> {
  return {
    ...(onFailurePhase ? { onFailurePhase } : {}),
    terminate(job) {
      return api.TerminateJobObject(job, 1) !== 0;
    },
    totalProcesses(job) {
      const buffer = new Uint8Array(48),
        returned = new Uint32Array(1);
      if (
        api.QueryInformationJobObject(
          job,
          JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
          ptr(buffer),
          buffer.byteLength,
          ptr(returned),
        ) === 0 ||
        returned[0] === undefined ||
        returned[0] !== buffer.byteLength
      )
        return null;
      return new DataView(buffer.buffer).getUint32(36, true);
    },
    activeProcesses(job) {
      const buffer = new Uint8Array(48),
        returned = new Uint32Array(1);
      if (
        api.QueryInformationJobObject(
          job,
          JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
          ptr(buffer),
          buffer.byteLength,
          ptr(returned),
        ) === 0 ||
        returned[0] === undefined ||
        returned[0] !== buffer.byteLength
      )
        return null;
      return new DataView(buffer.buffer).getUint32(40, true);
    },
    members(job): JobMembers | null {
      if (process.arch !== "x64") return null;
      const capacity = 64,
        headerBytes = 8,
        pointerBytes = 8,
        buffer = new Uint8Array(headerBytes + capacity * pointerBytes),
        returned = new Uint32Array(1);
      if (
        api.QueryInformationJobObject(
          job,
          JOB_OBJECT_BASIC_PROCESS_ID_LIST,
          ptr(buffer),
          buffer.byteLength,
          ptr(returned),
        ) === 0
      )
        return null;
      const view = new DataView(buffer.buffer),
        assigned = view.getUint32(0, true),
        count = view.getUint32(4, true),
        requiredBytes = headerBytes + count * pointerBytes;
      if (
        assigned > capacity ||
        count > capacity ||
        assigned !== count ||
        returned[0] === undefined ||
        returned[0] < requiredBytes ||
        returned[0] % pointerBytes !== 0 ||
        returned[0] > buffer.byteLength
      )
        return { processIds: [], complete: false };
      const processIds: number[] = [];
      for (let index = 0; index < count; index++) {
        const pid = view.getBigUint64(headerBytes + index * pointerBytes, true);
        if (pid > BigInt(Number.MAX_SAFE_INTEGER))
          return { processIds: [], complete: false };
        processIds.push(Number(pid));
      }
      return { processIds, complete: true };
    },
    openProcess(pid) {
      const handle = api.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
        0,
        pid,
      );
      return isNullHandle(handle) ? null : handle;
    },
    belongsToJob(processHandle, job) {
      const result = new Uint32Array(1);
      if (api.IsProcessInJob(processHandle, job, ptr(result)) === 0)
        return null;
      return result[0] === 1;
    },
    creationTime(processHandle) {
      return processCreationTime(api, processHandle);
    },
    signaled(processHandle) {
      const result = api.WaitForSingleObject(processHandle, 0);
      if (result === WAIT_OBJECT_0) return true;
      if (result === WAIT_TIMEOUT) return false;
      return null;
    },
    closeProcess(processHandle) {
      if (api.CloseHandle(processHandle) === 0)
        throw new Error("Windows process handle close failed.");
    },
    now() {
      return performance.now();
    },
    sleep: Bun.sleep,
  };
}

function jobGuard(
  pid: number,
  onWindowsSettlementFailure?: (phase: WindowsJobSettlementFailurePhase) => void,
): TreeGuard {
  let failureReported = false;
  const reportFailure = (phase: WindowsJobSettlementFailurePhase) => {
    if (!onWindowsSettlementFailure || failureReported) return;
    failureReported = true;
    try {
      onWindowsSettlementFailure(phase);
    } catch {
      // A trusted diagnostic observer cannot alter the ownership result.
    }
  };
  const api = jobApi();
  if (api === null) {
    reportFailure("guard-root");
    return UNGUARDED;
  }
  const job = api.CreateJobObjectW(null, null);
  if (isNullHandle(job)) {
    reportFailure("guard-root");
    return UNGUARDED;
  }
  const child = api.OpenProcess(ASSIGNED_ROOT_ACCESS, 0, pid);
  const assigned =
    !isNullHandle(child) &&
    setLimitFlags(api, job, KILL_ON_JOB_CLOSE) &&
    api.AssignProcessToJobObject(job, child) !== 0;
  if (!assigned || isNullHandle(child)) {
    reportFailure("guard-root");
    if (!isNullHandle(child)) api.CloseHandle(child);
    // An empty job, or one the child is not in: closing it ends nothing.
    setLimitFlags(api, job, 0);
    api.CloseHandle(job);
    return UNGUARDED;
  }
  let rootCreationTime: string | null = null;
  try {
    rootCreationTime = processCreationTime(api, child);
  } catch {
    // Keep the ownership guard; a stop will fail closed without this identity.
  }
  const assignedRootHandle = child;
  let rootHandle: KernelHandle | null = assignedRootHandle;
  let held = true,
    preserveKillOnClose = false;
  const closeRootHandle = () => {
    if (rootHandle === null) return;
    const handle = rootHandle;
    rootHandle = null;
    if (api.CloseHandle(handle) === 0)
      throw new Error("Windows process handle close failed.");
  };
  const closeWithKillOnClose = () => {
    if (!held) return;
    preserveKillOnClose = true;
    try {
      if (api.CloseHandle(job) !== 0) held = false;
      else reportFailure("close-job-handle");
    } finally {
      closeRootHandle();
    }
  };
  return {
    terminate() {
      closeWithKillOnClose();
    },
    async settleStopped() {
      if (!held || rootHandle === null || rootCreationTime === null) {
        reportFailure("guard-root");
        try {
          closeWithKillOnClose();
        } catch {
          // Preserve kill-on-close if the root identity or close cannot be confirmed.
        }
        throw new Error(
          "Windows owned process cleanup could not be confirmed.",
        );
      }
      const assignedRoot = {
        pid,
        handle: rootHandle,
        creationTime: rootCreationTime,
      };
      rootHandle = null;
      try {
        await settleWindowsJob(
          windowsJobSettlementApi(api, reportFailure),
          job,
          assignedRoot,
          WINDOWS_JOB_SETTLEMENT_MS,
        );
        preserveKillOnClose = true;
        if (api.CloseHandle(job) === 0) {
          reportFailure("close-job-handle");
          throw new Error(
            "Windows owned process cleanup could not be confirmed.",
          );
        }
        held = false;
      } catch {
        // Closing the retained job with kill-on-close still set is the fail-closed fallback.
        try {
          closeWithKillOnClose();
        } catch {
          // Leave the only job handle retained and kill-on-close enabled if close itself fails.
        }
        throw new Error(
          "Windows owned process cleanup could not be confirmed.",
        );
      }
    },
    release() {
      if (!held) return;
      if (preserveKillOnClose) {
        closeWithKillOnClose();
        return;
      }
      held = false;
      setLimitFlags(api, job, 0);
      api.CloseHandle(job);
      closeRootHandle();
    },
  };
}

// ── Elsewhere: a parent-watch ──────────────────────────────────────────────

/**
 * Read standard input to its end (the harness has ended), then kill the
 * process group named by `$1`. `read` is a shell builtin: the watcher is one
 * process.
 */
const WATCH = 'read -r _; kill -s KILL -- "-$1" 2>/dev/null';

function watchGuard(pid: number, program = "sh"): TreeGuard {
  let watcher: Bun.Subprocess<"pipe", "ignore", "ignore">;
  try {
    watcher = Bun.spawn([program, "-c", WATCH, "parent-watch", String(pid)], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
  } catch {
    return UNGUARDED;
  }
  // The watcher does not keep the harness's event loop running.
  watcher.unref();
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      // Killed before its pipe closes, so it never reads the end and kills nothing.
      watcher.kill("SIGKILL");
      try {
        watcher.stdin.end();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Guard the process tree of a child that has just started: on Windows its
 * own pid, elsewhere the process group it leads (started detached).
 */
export function guardTree(pid: number): TreeGuard {
  return process.platform === "win32" ? jobGuard(pid) : watchGuard(pid);
}

/** A held bootstrap cannot receive its grant unless abrupt-parent-death ownership exists. */
export function guardRequiredTree(pid: number): TreeGuard | null {
  const guarded =
    process.platform === "win32" ? jobGuard(pid) : watchGuard(pid, "/bin/sh");
  return guarded === UNGUARDED ? null : guarded;
}

/** New native processes remain suspended until this mandatory ownership succeeds. */
export function guardSuspendedWindowsProcess(
  pid: number,
  diagnostics?: {
    onWindowsSettlementFailure: (
      phase: WindowsJobSettlementFailurePhase,
    ) => void;
  },
): {
  release(): void;
  terminate(): void;
  settleStopped(): Promise<void>;
} | null {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  const guard = jobGuard(pid, diagnostics?.onWindowsSettlementFailure),
    terminate = guard.terminate,
    settleStopped = guard.settleStopped;
  return terminate && settleStopped
    ? {
        release: () => guard.release(),
        terminate,
        settleStopped: () => settleStopped.call(guard),
      }
    : null;
}
