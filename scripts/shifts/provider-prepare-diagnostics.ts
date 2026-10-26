import { dlopen, FFIType, ptr } from "bun:ffi";
import { win32 } from "node:path";

export interface FixtureProcessIdentity {
  relation: "root" | "helper";
  pid: number;
  parentPid: number | null;
  executable: string;
}

export interface ProcessObservation {
  relation: FixtureProcessIdentity["relation"];
  pid: number;
  parentPid: number | null;
  state: "alive" | "exited" | "access-unknown";
  creationTime: string | null;
}

export interface ProbeProcessApi<Handle> {
  open(pid: number): Handle | null;
  executable(handle: Handle): string | null;
  creationTime(handle: Handle): string | null;
  wait(handle: Handle): number;
  close(handle: Handle): void;
}

interface CapturedProcess {
  identity: FixtureProcessIdentity;
  handle: unknown | null;
  creationTime: string | null;
}

export interface HeldProbeProcesses {
  sampleAndClose(): ProcessObservation[];
  close(): void;
}

export function classifyWaitResult(
  result: number,
): ProcessObservation["state"] {
  return result === 0 ? "exited" : result === 258 ? "alive" : "access-unknown";
}

/** Strictly read the fixture's completed help record, including its root/helper relation. */
export function fixtureProcessIdentities(
  contents: string,
  executable: string,
): FixtureProcessIdentity[] {
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) !== "")
    throw new Error("Fixture log ends in an incomplete record.");
  const rows: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(0, -1)) {
    if (!line) throw new Error("Fixture log contains an empty record.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Fixture log contains malformed JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Fixture log record is not an object.");
    rows.push(parsed as Record<string, unknown>);
  }
  const help = [...rows].reverse().find((row) => row["kind"] === "help");
  if (
    !help ||
    !Number.isSafeInteger(help["pid"]) ||
    !Number.isSafeInteger(help["childPid"])
  )
    throw new Error("Fixture help record has no bounded root/helper PID pair.");
  const pid = help["pid"] as number,
    childPid = help["childPid"] as number;
  if (pid < 1 || childPid < 1 || pid === childPid)
    throw new Error("Fixture help record has invalid root/helper PIDs.");
  return [
    { relation: "root", pid, parentPid: null, executable },
    { relation: "helper", pid: childPid, parentPid: pid, executable },
  ];
}

/** Hold verified fixture process handles across Stop; reports never expose handles or paths. */
export function holdFixtureProcesses<Handle>(
  identities: FixtureProcessIdentity[],
  api: ProbeProcessApi<Handle>,
): HeldProbeProcesses {
  const captured: CapturedProcess[] = [];
  for (const identity of identities) {
    let handle: Handle | null = null;
    try {
      handle = api.open(identity.pid);
      if (handle === null) {
        captured.push({ identity, handle: null, creationTime: null });
        continue;
      }
      const executable = api.executable(handle),
        creationTime = api.creationTime(handle);
      if (
        executable === null ||
        !sameExecutable(executable, identity.executable) ||
        creationTime === null
      ) {
        api.close(handle);
        captured.push({ identity, handle: null, creationTime: null });
        continue;
      }
      captured.push({ identity, handle, creationTime });
    } catch {
      if (handle !== null) {
        try {
          api.close(handle);
        } catch {
          // Every remaining captured handle is still closed by close().
        }
      }
      captured.push({ identity, handle: null, creationTime: null });
    }
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const row of captured) {
      if (row.handle === null) continue;
      const handle = row.handle as Handle;
      row.handle = null;
      try {
        api.close(handle);
      } catch {
        // Continue closing other handles; caller reports unknown if sampling failed.
      }
    }
  };
  return {
    sampleAndClose() {
      if (closed)
        return captured.map((row) => observation(row, "access-unknown"));
      const reports = captured.map((row) => {
        if (row.handle === null || row.creationTime === null)
          return observation(row, "access-unknown");
        try {
          return observation(
            row,
            classifyWaitResult(api.wait(row.handle as Handle)),
          );
        } catch {
          return observation(row, "access-unknown");
        }
      });
      close();
      return reports;
    },
    close,
  };
}

function observation(
  row: CapturedProcess,
  state: ProcessObservation["state"],
): ProcessObservation {
  return {
    relation: row.identity.relation,
    pid: row.identity.pid,
    parentPid: row.identity.parentPid,
    state,
    creationTime: row.creationTime,
  };
}

function sameExecutable(actual: string, expected: string): boolean {
  return (
    win32.resolve(actual).toLowerCase() ===
    win32.resolve(expected).toLowerCase()
  );
}

/** Native process access is constructed only inside the explicit diagnostic opt-in. */
export function windowsProbeProcessApi(): ProbeProcessApi<
  ReturnType<typeof ptr>
> {
  const api = dlopen("kernel32.dll", {
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.ptr,
    },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    QueryFullProcessImageNameW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    WaitForSingleObject: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  return {
    open(pid) {
      return api.OpenProcess(0x00100000 | 0x00001000, 0, pid);
    },
    executable(handle) {
      const image = new Uint16Array(32768),
        length = new Uint32Array([image.length]);
      if (
        api.QueryFullProcessImageNameW(handle, 0, ptr(image), ptr(length)) === 0
      )
        return null;
      return String.fromCharCode(...image.subarray(0, length[0]));
    },
    creationTime(handle) {
      const creation = new Uint32Array(2),
        exit = new Uint32Array(2),
        kernel = new Uint32Array(2),
        user = new Uint32Array(2);
      if (
        api.GetProcessTimes(
          handle,
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
    },
    wait(handle) {
      return api.WaitForSingleObject(handle, 0);
    },
    close(handle) {
      api.CloseHandle(handle);
    },
  };
}

export function fixedProviderPrepareResources(
  root: string,
  executable: string,
  log: string,
): { paths: string[]; relativeNames: ["codex.exe", "provider.json"] } {
  const expectedExecutable = win32.resolve(root, "codex.exe"),
    expectedLog = win32.resolve(root, "provider.json");
  if (
    !sameExecutable(executable, expectedExecutable) ||
    !sameExecutable(log, expectedLog)
  )
    throw new Error(
      "Provider preparation diagnostic resources are not the fixture pair.",
    );
  return {
    paths: [expectedExecutable, expectedLog],
    relativeNames: ["codex.exe", "provider.json"],
  };
}
