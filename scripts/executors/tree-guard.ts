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
 * `release()`, called once the child has exited on its own or been killed,
 * stands the guard down without ending anything: the job's kill-on-close is
 * cleared before its handle is closed, and the watcher is killed before its
 * pipe is closed. So what a child that exited left running is left running,
 * as it was before this guard.
 *
 * Not covered: on Windows, a process the child starts before it is assigned
 * to the job (the assignment follows `Bun.spawn` at once, ahead of the
 * child's own start-up), or one started with breakaway; elsewhere, a process
 * that leaves the child's process group. A guard that cannot be set up (no
 * job object, no `sh`) guards nothing, silently: the child runs as it did
 * before this guard, and the exit hook still covers every other way out.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

export interface TreeGuard {
  /** Stand the guard down, ending nothing. Safe to call more than once. */
  release(): void;
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
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.ptr,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

type Kernel32 = ReturnType<typeof openKernel32>;
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
function setLimitFlags(api: Kernel32, job: number, flags: number): boolean {
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

function jobGuard(pid: number): TreeGuard {
  const api = jobApi();
  if (api === null) return UNGUARDED;
  const job = api.CreateJobObjectW(null, null);
  if (job === null) return UNGUARDED;
  const child = api.OpenProcess(ASSIGN_ACCESS, 0, pid);
  const assigned =
    child !== null &&
    setLimitFlags(api, job, KILL_ON_JOB_CLOSE) &&
    api.AssignProcessToJobObject(job, child) !== 0;
  if (child !== null) api.CloseHandle(child);
  if (!assigned) {
    // An empty job, or one the child is not in: closing it ends nothing.
    setLimitFlags(api, job, 0);
    api.CloseHandle(job);
    return UNGUARDED;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      setLimitFlags(api, job, 0);
      api.CloseHandle(job);
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

function watchGuard(pid: number): TreeGuard {
  let watcher: Bun.Subprocess<"pipe", "ignore", "ignore">;
  try {
    watcher = Bun.spawn(["sh", "-c", WATCH, "parent-watch", String(pid)], {
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
