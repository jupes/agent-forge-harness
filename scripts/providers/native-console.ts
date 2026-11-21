import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { win32 } from "node:path";
import { guardSuspendedWindowsProcess } from "../executors/tree-guard";

const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le");
/** Windows CRT argv quoting, never a shell command or a searched application name. */
export function windowsConsoleCommand(command: readonly string[]): Buffer {
  if (
    !command[0] ||
    !win32.isAbsolute(command[0]) ||
    !/\.exe$/i.test(command[0]) ||
    command.length > 32 ||
    command.some(
      (arg) =>
        typeof arg !== "string" || arg.includes("\0") || arg.length > 8192,
    )
  )
    throw Error("Expected a bounded native executable and argument array.");
  const line = command
    .map(
      (arg) =>
        `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`,
    )
    .join(" ");
  if (line.length >= 32767)
    throw Error("The native command exceeds its limit.");
  return wide(line);
}

export function windowsEnvironmentBlock(
  env: Readonly<Record<string, string>>,
): Buffer {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (
      !name ||
      /[=\0]/.test(name) ||
      value.includes("\0") ||
      names.has(name.toUpperCase())
    )
      throw Error("The native environment is invalid or ambiguous.");
    names.add(name.toUpperCase());
  }
  const pairs = Object.entries(env)
    .sort(([a], [b]) =>
      a.toUpperCase() < b.toUpperCase()
        ? -1
        : a.toUpperCase() > b.toUpperCase()
          ? 1
          : 0,
    )
    .map(([name, value]) => `${name}=${value}`);
  const text = `${pairs.join("\0")}\0\0`;
  if (text.length > 32767)
    throw Error("The native environment exceeds its limit.");
  return Buffer.from(text, "utf16le");
}

function openApi() {
  return dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    ResumeThread: { args: [FFIType.ptr], returns: FFIType.u32 },
    TerminateProcess: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    WaitForSingleObject: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    GetExitCodeProcess: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
}
let library: ReturnType<typeof openApi> | undefined;
export interface NativeConsoleExit {
  exitCode: number;
  stopped: boolean;
  timedOut: boolean;
}
/** Exact source-proven CreateProcessW refusal; no native process was created. */
export class NativeConsoleNotStartedError extends Error {
  constructor() {
    super("The vendor terminal could not be opened. No CLI ran.");
    this.name = "NativeConsoleNotStartedError";
  }
}
export interface NativeConsoleChild {
  pid: number;
  done: Promise<NativeConsoleExit>;
  stop(): Promise<NativeConsoleExit>;
}

export type NativeConsoleLaunchOptions = {
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Hidden inert fixtures only; the product always opens the vendor's own console. */
  visible?: boolean;
} & (
  | { lifetime?: { kind: "bounded" } | undefined; timeoutMs: number }
  | { lifetime: { kind: "managed" }; timeoutMs?: never }
);

/** Server-only primitive. The public action supplies a fixed vendor command, never caller argv. */
export function launchWindowsConsole(
  options: NativeConsoleLaunchOptions,
  deps: { guard?: typeof guardSuspendedWindowsProcess } = {},
): NativeConsoleChild {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("Native sign-in terminals require Windows x64.");
  const managed = options.lifetime?.kind === "managed";
  if (
    !win32.isAbsolute(options.cwd) ||
    options.cwd.includes("\0") ||
    (options.lifetime?.kind !== "managed" &&
      (typeof options.timeoutMs !== "number" ||
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 900000))
  )
    throw Error("The native terminal bounds or working directory are invalid.");
  const command = windowsConsoleCommand(options.command),
    env = windowsEnvironmentBlock(options.env),
    application = wide(options.command[0] ?? ""),
    cwd = wide(options.cwd);
  library ??= openApi();
  const api = library.symbols;
  // STARTUPINFOW and PROCESS_INFORMATION layouts for the shipped Windows x64 target.
  const startup = new Uint8Array(104),
    information = new Uint8Array(24);
  new DataView(startup.buffer).setUint32(0, startup.byteLength, true);
  const flags =
    0x00000004 |
    0x00000400 |
    (options.visible === false ? 0x08000000 : 0x00000010);
  if (
    api.CreateProcessW(
      ptr(application),
      ptr(command),
      null,
      null,
      0,
      flags,
      ptr(env),
      ptr(cwd),
      ptr(startup),
      ptr(information),
    ) === 0
  )
    throw new NativeConsoleNotStartedError();
  const info = new DataView(information.buffer),
    // justification: successful CreateProcessW filled these native HANDLE out-parameters.
    processHandle = Number(info.getBigUint64(0, true)) as Pointer,
    threadHandle = Number(info.getBigUint64(8, true)) as Pointer,
    pid = info.getUint32(16, true);
  let guard: ReturnType<typeof guardSuspendedWindowsProcess> = null;
  try {
    guard = (deps.guard ?? guardSuspendedWindowsProcess)(pid);
    if (!guard)
      throw Error("The vendor terminal could not be supervised. No CLI ran.");
    if (api.ResumeThread(threadHandle) === 0xffffffff)
      throw Error("The vendor terminal could not begin. No CLI ran.");
  } catch (error) {
    if (guard) guard.terminate();
    else api.TerminateProcess(processHandle, 1);
    api.CloseHandle(threadHandle);
    api.CloseHandle(processHandle);
    throw error;
  }
  api.CloseHandle(threadHandle);
  const owned = guard;
  let stopped = false,
    timedOut = false,
    settled = false;
  const deadline = managed
    ? Number.POSITIVE_INFINITY
    : performance.now() + (options.timeoutMs ?? 0);
  const done = (async (): Promise<NativeConsoleExit> => {
    try {
      for (;;) {
        const wait = api.WaitForSingleObject(processHandle, 0);
        if (wait === 0) break;
        if (wait !== 0x102)
          throw Error("The vendor terminal outcome could not be verified.");
        if (!stopped && !timedOut && performance.now() >= deadline) {
          timedOut = true;
          owned.terminate();
        }
        await Bun.sleep(25);
      }
      const code = new Uint8Array(4);
      if (api.GetExitCodeProcess(processHandle, ptr(code)) === 0)
        throw Error("The vendor terminal exit could not be verified.");
      return {
        exitCode: new DataView(code.buffer).getUint32(0, true),
        stopped,
        timedOut,
      };
    } catch (error) {
      owned.terminate();
      throw error;
    } finally {
      settled = true;
      // Unlike legacy coding tasks, a sign-in flow owns every helper until its terminal settles.
      owned.terminate();
      api.CloseHandle(processHandle);
    }
  })();
  return {
    pid,
    done,
    stop() {
      if (!settled && !timedOut) {
        stopped = true;
        owned.terminate();
      }
      return done;
    },
  };
}
