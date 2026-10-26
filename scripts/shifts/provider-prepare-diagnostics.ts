import { dlopen, FFIType, ptr } from "bun:ffi";
import { resolve, win32 } from "node:path";

export interface FixtureProcessIdentity {
  relation: "root" | "helper";
  pid: number;
  parentPid: number | null;
  executable: string;
}

export interface ProcessObservation extends FixtureProcessIdentity {
  state: "alive" | "exited" | "access-unknown";
  creationTime: string | null;
}

export function classifyWaitResult(
  result: number,
): ProcessObservation["state"] {
  return result === 0 ? "exited" : result === 258 ? "alive" : "access-unknown";
}

interface HeldFixtureProcess extends FixtureProcessIdentity {
  handle: ReturnType<typeof ptr> | null;
  creationTime: string | null;
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

/** Open and identify exact fixture-reported processes before the test sends Stop. */
export function holdFixtureProcesses(
  identities: FixtureProcessIdentity[],
): HeldFixtureProcess[] {
  if (process.platform !== "win32")
    return identities.map((identity) => ({
      ...identity,
      handle: null,
      creationTime: null,
    }));
  const api = kernel32();
  return identities.map((identity) => {
    const handle = api.OpenProcess(0x00100000 | 0x00001000, 0, identity.pid);
    if (!handle) return { ...identity, handle: null, creationTime: null };
    const creation = new Uint32Array(2),
      exit = new Uint32Array(2),
      kernel = new Uint32Array(2),
      user = new Uint32Array(2),
      image = new Uint16Array(32768),
      imageLength = new Uint32Array([image.length]);
    try {
      if (
        api.GetProcessTimes(
          handle,
          ptr(creation),
          ptr(exit),
          ptr(kernel),
          ptr(user),
        ) === 0 ||
        api.QueryFullProcessImageNameW(
          handle,
          0,
          ptr(image),
          ptr(imageLength),
        ) === 0
      ) {
        api.CloseHandle(handle);
        return { ...identity, handle: null, creationTime: null };
      }
      const actualImage = String.fromCharCode(
        ...image.subarray(0, imageLength[0]),
      );
      if (
        actualImage.replaceAll("/", "\\").toLowerCase() !==
        identity.executable.replaceAll("/", "\\").toLowerCase()
      ) {
        api.CloseHandle(handle);
        return { ...identity, handle: null, creationTime: null };
      }
      const ticks =
        (BigInt(creation[1] ?? 0) << 32n) | BigInt(creation[0] ?? 0);
      return {
        ...identity,
        handle,
        creationTime: ticks.toString(16).padStart(16, "0"),
      };
    } catch {
      api.CloseHandle(handle);
      return { ...identity, handle: null, creationTime: null };
    }
  });
}

/** Sample process state by the held handles, then close every handle before filesystem cleanup. */
export function sampleAndCloseFixtureProcesses(
  held: HeldFixtureProcess[],
): ProcessObservation[] {
  if (process.platform !== "win32")
    return held.map((row) => ({ ...row, state: "access-unknown" }));
  const api = kernel32();
  try {
    return held.map((row) => {
      if (!row.handle || !row.creationTime)
        return { ...row, state: "access-unknown" };
      const result = api.WaitForSingleObject(row.handle, 0);
      return {
        ...row,
        state: classifyWaitResult(result),
      };
    });
  } finally {
    for (const row of held) if (row.handle) api.CloseHandle(row.handle);
  }
}

export interface RestartManagerReport {
  state: "complete" | "unavailable" | "timeout" | "output-limit";
  resources: string[];
  pids: number[];
}

/** Only accepts bounded, typed PID output; never returns app names, commands, or environment. */
export function parseRestartManagerReport(
  stdout: string,
  root: string,
  resources: string[],
): RestartManagerReport {
  const relativeResources = resources.map((path) => safeRelative(root, path));
  try {
    const value: unknown = JSON.parse(stdout);
    const keys =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
        : [];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      keys.length !== 2 ||
      !keys.includes("ok") ||
      !keys.includes("pids") ||
      (value as Record<string, unknown>)["ok"] !== true ||
      !Array.isArray((value as Record<string, unknown>)["pids"])
    )
      throw new Error("Invalid Restart Manager reply");
    const pids = (value as { pids: unknown[] }).pids;
    if (
      pids.length > 128 ||
      pids.some((pid) => !Number.isSafeInteger(pid) || (pid as number) < 1)
    )
      throw new Error("Restart Manager PID list is outside its bound");
    return {
      state: "complete",
      resources: relativeResources,
      pids: [...new Set(pids as number[])],
    };
  } catch {
    return {
      state: "unavailable",
      resources: relativeResources,
      pids: [],
    };
  }
}

/** Invoke the Windows Restart Manager only for the exact fixture image and log, with a hard bound. */
export async function queryFixtureRestartManager(
  root: string,
  executable: string,
  log: string,
): Promise<RestartManagerReport> {
  const resources = [executable, log],
    names = resources.map((path) => safeRelative(root, path));
  if (process.platform !== "win32")
    return { state: "unavailable", resources: names, pids: [] };
  const script = restartManagerScript(resources),
    encoded = Buffer.from(script, "utf16le").toString("base64"),
    powershell = resolve(
      process.env["SystemRoot"] ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(
      [
        powershell,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
  } catch {
    return { state: "unavailable", resources: names, pids: [] };
  }
  let output = "",
    overflow = false;
  const read = (async () => {
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        output += Buffer.from(next.value).toString("utf8");
        if (Buffer.byteLength(output) > 4096) {
          overflow = true;
          child.kill();
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 2500);
  try {
    const [exitCode] = await Promise.all([child.exited, read]);
    if (overflow) return { state: "output-limit", resources: names, pids: [] };
    if (timedOut || exitCode === null)
      return { state: "timeout", resources: names, pids: [] };
    if (exitCode !== 0)
      return { state: "unavailable", resources: names, pids: [] };
    return parseRestartManagerReport(output, root, resources);
  } catch {
    child.kill();
    await child.exited;
    return { state: "unavailable", resources: names, pids: [] };
  } finally {
    clearTimeout(timer);
  }
}

function safeRelative(root: string, path: string): string {
  const relativePath = win32.relative(win32.resolve(root), win32.resolve(path));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(relativePath)
  )
    throw new Error("Restart Manager resource is outside the fixture root.");
  return relativePath.replaceAll("\\", "/");
}

function restartManagerScript(resources: string[]): string {
  const files = Buffer.from(JSON.stringify(resources), "utf8").toString(
    "base64",
  );
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
[StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct RM_PROCESS_INFO { public RM_UNIQUE_PROCESS Process; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string strAppName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string strServiceShortName; public int ApplicationType; public uint AppStatus; public uint TSSessionId; public int bRestartable; }
public static class RmApi {
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, RM_UNIQUE_PROCESS[] apps, uint serviceCount, string[] services);
 [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint handle, ref uint needed, ref uint count, [In,Out] RM_PROCESS_INFO[] apps, ref uint rebootReasons);
 [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
}
'@
$files = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${files}')))
$handle = [uint32]0
$key = New-Object System.Text.StringBuilder -ArgumentList 'AGENTFORGE-PROBE-LOCK-01'
$pids = @()
try {
  if ([RmApi]::RmStartSession([ref]$handle, 0, $key) -ne 0) { throw 'start' }
  if ([RmApi]::RmRegisterResources($handle, [uint32]$files.Count, [string[]]$files, 0, [RM_UNIQUE_PROCESS[]]@(), 0, [string[]]@()) -ne 0) { throw 'register' }
  [uint32]$needed = 0; [uint32]$count = 0; [uint32]$reboot = 0
  $code = [RmApi]::RmGetList($handle, [ref]$needed, [ref]$count, [RM_PROCESS_INFO[]]@(), [ref]$reboot)
  if ($code -eq 234 -and $needed -le 128) {
    $apps = New-Object RM_PROCESS_INFO[] $needed; $count = $needed
    $code = [RmApi]::RmGetList($handle, [ref]$needed, [ref]$count, $apps, [ref]$reboot)
    if ($code -eq 0 -and $count -le 128) { $pids = @($apps | Select-Object -First $count | ForEach-Object { [int]$_.Process.dwProcessId }) }
  } elseif ($code -eq 0) { $pids = @() }
  if ($code -ne 0) { throw 'list' }
  [ordered]@{ ok = $true; pids = @($pids | Sort-Object -Unique) } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ ok = $false; pids = @() } | ConvertTo-Json -Compress
} finally {
  if ($handle -ne 0) { [void][RmApi]::RmEndSession($handle) }
}`;
}

function kernel32() {
  return dlopen("kernel32.dll", {
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
}
