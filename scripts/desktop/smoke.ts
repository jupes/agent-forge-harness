import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isMain } from "../is-main";

const root = resolve(import.meta.dir, "../..");
const app = join(root, "apps", "desktop");
const stage = join(app, "build", "windows-x64");
const executable = join(stage, "agent-forge-desktop.exe");
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const powershell = join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const waitLimitMs = 60_000;
const healthPath = "/__agent-forge/health";
const tokenPath = "/__agent-forge/token";
const sessionKeyName = "agent-forge-session-key";
const sessionKeyHeader = "x-agent-forge-session-key";

type CdpMessage = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  error?: unknown;
  result?: unknown;
};
type CdpTarget = { webSocketDebuggerUrl: string; type: string };
type ProcessIdentity = {
  pid: number;
  parentPid: number;
  created: string;
  path: string;
};
type ProcessTree = { root?: ProcessIdentity; children: ProcessIdentity[] };
type SmokeChecks = {
  hashCleared: boolean;
  rendered: boolean;
  health: boolean;
  authenticated: boolean;
  cssMime: boolean;
  scriptMime: boolean;
  readyState: string | null;
  literalLoopbackOrigin: boolean;
  healthStatus: number | null;
  tokenStatus: number | null;
  hasSessionKey: boolean;
  workspaceMatches: boolean;
};

async function main(): Promise<void> {
  if (process.platform !== "win32")
    throw new Error("Desktop smoke requires Windows.");
  if (!existsSync(executable))
    throw new Error("Build the Windows release stage before running smoke.");

  const temp = mkdtempSync(join(tmpdir(), "agent-forge-desktop-smoke-"));
  const desktopSmokeHome = resolve(temp, "home");
  const fakeBin = join(temp, "bin");
  const fixtureRoot = join(temp, "checkout");
  const runner = join(temp, "application");
  assertWithin(temp, desktopSmokeHome);
  mkdirSync(fakeBin);
  mkdirSync(runner);
  mkdirSync(join(fixtureRoot, ".git"), { recursive: true });
  mkdirSync(join(fixtureRoot, "scripts", "hearth"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "scripts", "hearth", "server.ts"),
    "// isolated checkout marker\n",
    "utf8",
  );
  const fakeBdSource = join(temp, "fake-bd.ts");
  const fakeBdExecutable = join(fakeBin, "bd.exe");
  writeFileSync(fakeBdSource, 'process.stdout.write("[]\\n");\n', "utf8");
  await runBounded(
    [
      process.execPath,
      "build",
      "--compile",
      fakeBdSource,
      "--outfile",
      fakeBdExecutable,
    ],
    30_000,
    "Could not prepare isolated tracker stub.",
  );
  linkOrCopy(executable, join(runner, "agent-forge-desktop.exe"));
  linkOrCopy(join(stage, "hearth.exe"), join(runner, "hearth.exe"));
  cpSync(join(stage, "dashboard"), join(runner, "dashboard"), {
    recursive: true,
  });

  const debugPort = await availablePort();
  const env = {
    ...process.env,
    AGENT_FORGE_HOME: desktopSmokeHome,
    HTTP_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "",
    no_proxy: "corp.example",
    PATH: [fakeBin, join(systemRoot, "System32"), systemRoot].join(delimiter),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    WEBVIEW2_USER_DATA_FOLDER: join(temp, "webview-profile"),
  };
  const launch = (args: string[] = [], cwd = runner) =>
    Bun.spawn({
      cmd: [join(runner, "agent-forge-desktop.exe"), ...args],
      cwd,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  for (const scenario of [
    {
      args: [],
      title: "Choose an Agent Forge checkout",
      cancel: (pid: number) => folderDialog(pid),
    },
    {
      args: ["--root", fixtureRoot],
      title: "Agent Forge — hearth unavailable",
      cancel: (pid: number) => recoveryDialog(pid, "cancel"),
    },
  ]) {
    const cancelled = launch(scenario.args);
    try {
      await waitForMainWindow(cancelled.pid, cancelled, scenario.title);
      await scenario.cancel(cancelled.pid);
      await waitForAppExit(cancelled);
      if (cancelled.exitCode !== 0)
        throw new Error(
          `Cancelling startup did not exit cleanly (code ${cancelled.exitCode}).`,
        );
    } finally {
      if (cancelled.exitCode === null) cancelled.kill();
    }
  }
  const selectedRoot = join(temp, "selected checkout");
  mkdirSync(selectedRoot);
  const appProcess = launch([], selectedRoot);
  let socket: WebSocket | undefined;
  let checks: SmokeChecks | undefined;
  let processTree: ProcessTree | undefined;
  let windowVisible = false;
  let cspErrors = 0;
  let smokeError: Error | undefined;
  let failureScreenshot: string | undefined;

  try {
    await waitForMainWindow(
      appProcess.pid,
      appProcess,
      "Choose an Agent Forge checkout",
    );
    // Accept the displayed empty folder first: the real app must reject it.
    // This avoids depending on unsupported OS accessibility editing patterns.
    await folderDialog(appProcess.pid, true);
    await waitForMainWindow(
      appProcess.pid,
      appProcess,
      "Agent Forge — choose a checkout",
    );
    await recoveryDialog(
      appProcess.pid,
      "inspect",
      "Agent Forge — choose a checkout",
      "native-workspace-warning.png",
    );
    mkdirSync(join(selectedRoot, ".git"));
    mkdirSync(join(selectedRoot, "scripts", "hearth"), { recursive: true });
    copyFileSync(
      join(fixtureRoot, "scripts", "hearth", "server.ts"),
      join(selectedRoot, "scripts", "hearth", "server.ts"),
    );
    await recoveryDialog(
      appProcess.pid,
      "retry",
      "Agent Forge — choose a checkout",
    );
    await waitForMainWindow(
      appProcess.pid,
      appProcess,
      "Choose an Agent Forge checkout",
    );
    await folderDialog(appProcess.pid, true);
    await waitForMainWindow(
      appProcess.pid,
      appProcess,
      "Agent Forge — hearth unavailable",
    );
    await recoveryDialog(appProcess.pid, "inspect");
    linkOrCopy(
      join(stage, "desktop-host.exe"),
      join(runner, "desktop-host.exe"),
    );
    await recoveryDialog(appProcess.pid, "retry");
    windowVisible = await waitForMainWindow(appProcess.pid, appProcess);
    processTree = await captureProcessTree(appProcess.pid);
    const target = await waitForTarget(debugPort, appProcess);
    socket = await openCdp(target.webSocketDebuggerUrl);
    await cdpEnable(socket);
    await cdp(socket, "Network.enable", {});
    socket.addEventListener("message", (event) => {
      const message = parseCdpMessage(String(event.data));
      if (message?.method !== "Log.entryAdded") return;
      const entry = asRecord(asRecord(message.params)?.entry);
      const text = typeof entry?.text === "string" ? entry.text : "";
      if (
        entry?.level === "error" &&
        /content security policy|blocked.*script/i.test(text)
      )
        cspErrors++;
    });
    const probeDeadline = Date.now() + waitLimitMs;
    while (Date.now() < probeDeadline) {
      checks = await readChecks(socket, `${basename(temp)}/selected checkout`);
      if (checks.hashCleared && checks.authenticated && checks.health) break;
      await delay(500);
    }
    if (!checks?.hashCleared || !checks.authenticated || !checks.health) {
      throw new Error(
        "The dashboard did not complete its launch-session exchange.",
      );
    }
    await reloadPage(socket);
    checks = await readChecks(socket, `${basename(temp)}/selected checkout`);
    if (!allChecksPassed(checks))
      throw new Error(
        "The dashboard failed a packaged asset or session check.",
      );
    if (cspErrors > 0)
      throw new Error("WebView reported a blocked dashboard script.");
    const screenshot = await cdp(socket, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    if (typeof screenshot.data !== "string")
      throw new Error("WebView screenshot was unavailable.");
    const screenshotPath = join(
      root,
      ".tmp",
      "work",
      "desktop-native-tools",
      "native-smoke.png",
    );
    mkdirSync(resolve(screenshotPath, ".."), { recursive: true });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    await closeMainWindow(appProcess.pid);
    await waitForAppExit(appProcess);
    await waitForCapturedChildrenGone(processTree);
    socket.close();
    socket = undefined;
  } catch (error: unknown) {
    smokeError =
      error instanceof Error ? error : new Error("Desktop smoke failed.");
    if (socket && windowVisible) {
      failureScreenshot = await saveScreenshot(
        socket,
        "native-smoke-failure.png",
      ).catch(() => undefined);
    }
  } finally {
    socket?.close();
    if (!processTree && appProcess.exitCode === null) {
      processTree = await captureProcessTree(appProcess.pid).catch(
        () => undefined,
      );
    }
    if (appProcess.exitCode === null) {
      await closeMainWindow(appProcess.pid).catch(() => {});
      await Promise.race([appProcess.exited, delay(8_000)]);
    }
    if (appProcess.exitCode === null) appProcess.kill();
    if (processTree) {
      await stopCapturedChildren(processTree);
      const childrenStopped = await waitForCapturedChildrenGone(
        processTree,
      ).then(
        () => true,
        () => false,
      );
      if (!childrenStopped && !smokeError)
        smokeError = new Error(
          "A smoke-owned child process did not stop cleanly.",
        );
      if (childrenStopped && appProcess.exitCode !== null) cleanupTemp(temp);
    }
  }

  if (smokeError) {
    console.log(
      JSON.stringify({
        ok: false,
        data: null,
        error: smokeError.message,
        diagnostics: {
          windowVisible,
          ...(checks ?? {}),
          cspErrors,
          ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
        },
      }),
    );
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify({
        ok: true,
        data: {
          windowVisible,
          ...(checks ?? {}),
          cspErrors,
          proxyEnvConflictTested: true,
          startupRetryTested: true,
          startupCancelTested: true,
          checkoutPickerTested: true,
          checkoutPickerCancelTested: true,
          invalidCheckoutRetryTested: true,
          childrenStopped: true,
        },
        error: null,
      }),
    );
  }
}

async function folderDialog(pid: number, accept = false): Promise<void> {
  await powershellResult(
    `
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FolderProbe {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
'@
    $window = (Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle
    $title = New-Object System.Text.StringBuilder 256
    [void][FolderProbe]::GetWindowText($window, $title, 256)
    if ($title.ToString() -ne 'Choose an Agent Forge checkout') { throw 'Expected checkout picker' }
    if (-not [FolderProbe]::PostMessage($window, 0x111, [IntPtr]${accept ? 1 : 2}, [IntPtr]::Zero)) { throw 'Folder action unavailable' }
  `,
    "checkout picker check",
  );
}

/** Operate only the startup dialog owned by this smoke's exact native PID. */
async function recoveryDialog(
  pid: number,
  action: "inspect" | "retry" | "cancel",
  title = "Agent Forge — hearth unavailable",
  screenshotName = "native-startup-recovery.png",
): Promise<void> {
  const screenshot = join(
    root,
    ".tmp",
    "work",
    "desktop-native-tools",
    screenshotName,
  );
  mkdirSync(resolve(screenshot, ".."), { recursive: true });
  await powershellResult(
    `
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RecoveryProbe {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
}
'@
    $window = (Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle
    $title = New-Object System.Text.StringBuilder 256
    [void][RecoveryProbe]::GetWindowText($window, $title, 256)
    if ($title.ToString() -ne '${psQuote(title)}') { throw 'Expected startup recovery dialog' }
    if ([RecoveryProbe]::GetDlgItem($window, 4) -eq [IntPtr]::Zero -or [RecoveryProbe]::GetDlgItem($window, 2) -eq [IntPtr]::Zero) { throw 'Recovery choices missing' }
    $default = [RecoveryProbe]::SendMessage($window, 0x400, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64() -band 0xffff
    if ($default -ne 2) { throw 'Cancel is not the default choice' }
    ${
      action === "inspect"
        ? `
    Add-Type -AssemblyName System.Drawing
    [void][RecoveryProbe]::SetThreadDpiAwarenessContext([RecoveryProbe]::GetWindowDpiAwarenessContext($window))
    $rect = New-Object RecoveryProbe+Rect
    if (-not [RecoveryProbe]::GetWindowRect($window, [ref]$rect)) { throw 'Dialog bounds unavailable' }
    $bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $dc = $graphics.GetHdc()
      try {
        if (-not [RecoveryProbe]::PrintWindow($window, $dc, 2)) { throw 'Dialog capture unavailable' }
      } finally { $graphics.ReleaseHdc($dc) }
      $bitmap.Save('${psQuote(screenshot)}', [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    `
        : `if (-not [RecoveryProbe]::PostMessage($window, 0x111, [IntPtr]${action === "retry" ? 4 : 2}, [IntPtr]::Zero)) { throw 'Could not choose recovery action' }`
    }
  `,
    "startup recovery check",
  );
}

async function runBounded(
  command: string[],
  timeoutMs: number,
  errorMessage: string,
): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const status = await child.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error(errorMessage);
  if (status !== 0) throw new Error(errorMessage);
}

async function availablePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, drain() {}, error() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function waitForTarget(
  port: number,
  child: Bun.Subprocess,
): Promise<CdpTarget> {
  const deadline = Date.now() + waitLimitMs;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_500),
      });
      const targets: unknown = await response.json();
      if (Array.isArray(targets)) {
        const page = targets
          .map(asRecord)
          .find(
            (item) =>
              item?.type === "page" &&
              typeof item.webSocketDebuggerUrl === "string",
          );
        if (page && typeof page.webSocketDebuggerUrl === "string") {
          return {
            type: "page",
            webSocketDebuggerUrl: page.webSocketDebuggerUrl,
          };
        }
      }
    } catch {
      // The WebView debug endpoint appears after the native window starts.
    }
    await delay(250);
  }
  throw new Error("The WebView debug endpoint did not become ready.");
}

function openCdp(url: string): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    const onOpen = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("error", onError);
      resolveSocket(socket);
    };
    const onError = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      reject(new Error("WebView debug connection failed."));
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.close();
      reject(new Error("WebView debug connection timed out."));
    }, 5_000);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function cdpEnable(socket: WebSocket): Promise<void> {
  await cdp(socket, "Runtime.enable", {});
  await cdp(socket, "Log.enable", {});
  await cdp(socket, "Page.enable", {});
}

async function evaluate(
  socket: WebSocket,
  expression: string,
): Promise<unknown> {
  const result = await cdp(socket, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined)
    throw new Error("WebView evaluation failed.");
  return asRecord(result.result)?.value;
}

let nextCommandId = 1;
function cdp(
  socket: WebSocket,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = nextCommandId++;
  return new Promise((resolveResult, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const message = parseCdpMessage(String(event.data));
      if (message?.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error !== undefined)
        reject(new Error("WebView command failed."));
      else resolveResult(asRecord(message.result) ?? {});
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("WebView command timed out."));
    }, 5_000);
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function reloadPage(socket: WebSocket): Promise<void> {
  const loaded = new Promise<void>((resolveLoad, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (parseCdpMessage(String(event.data))?.method !== "Page.loadEventFired")
        return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolveLoad();
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("WebView page reload timed out."));
    }, 10_000);
    socket.addEventListener("message", onMessage);
  });
  await cdp(socket, "Page.reload", { ignoreCache: true });
  await loaded;
}

async function readChecks(
  socket: WebSocket,
  workspaceSuffix: string,
): Promise<SmokeChecks> {
  const result = await cdp(socket, "Runtime.evaluate", {
    expression: `(async () => {
      if (location.protocol !== "http:" || location.hostname !== "127.0.0.1") return {};
      const sessionKey = localStorage.getItem(${JSON.stringify(sessionKeyName)});
      const hasSessionKey = typeof sessionKey === "string" && sessionKey.length > 0;
      let tokenStatus = null;
      const tokenOk = hasSessionKey &&
        await fetch(${JSON.stringify(tokenPath)}, { headers: { ${JSON.stringify(sessionKeyHeader)}: sessionKey }, signal: AbortSignal.timeout(2500) })
          .then(async (response) => {
            tokenStatus = response.status;
            if (!response.ok) return false;
            const envelope = await response.json();
            return typeof envelope?.data?.token === "string" && envelope.data.token.length > 0;
          }).catch(() => false);
      let healthStatus = null;
      let workspaceMatches = false;
      const healthOk = await fetch(${JSON.stringify(healthPath)}, { signal: AbortSignal.timeout(2500) })
        .then(async (response) => {
          healthStatus = response.status;
          const envelope = await response.json();
          workspaceMatches = typeof envelope?.data?.root === "string" && envelope.data.root.replaceAll(String.fromCharCode(92), "/").toLowerCase().endsWith(${JSON.stringify(workspaceSuffix.toLowerCase())});
          return response.ok && envelope?.ok === true;
        }).catch(() => false);
      const cssLink = [...document.querySelectorAll('link[rel="stylesheet"]')]
        .find((link) => link.href.includes("/assets/"));
      const script = [...document.scripts].find((item) => item.src.includes("/assets/"));
      const cssMime = !!cssLink && await fetch(cssLink.href, { signal: AbortSignal.timeout(2500) })
        .then((response) => response.headers.get("content-type")?.includes("text/css") === true)
        .catch(() => false);
      const scriptMime = !!script && await fetch(script.src, { signal: AbortSignal.timeout(2500) })
        .then((response) => response.headers.get("content-type")?.includes("javascript") === true)
        .catch(() => false);
      const app = document.querySelector("#app");
      return {
        hashCleared: location.hash === "",
        rendered: !!app && app.children.length > 0,
        health: healthOk,
        authenticated: tokenOk,
        cssMime,
        scriptMime,
        readyState: document.readyState,
        literalLoopbackOrigin: location.protocol === "http:" && location.hostname === "127.0.0.1" && location.port !== "",
        healthStatus,
        tokenStatus,
        hasSessionKey,
        workspaceMatches,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined)
    throw new Error("Dashboard smoke probe failed.");
  const value = asRecord(asRecord(result.result)?.value);
  return {
    hashCleared: value?.hashCleared === true,
    rendered: value?.rendered === true,
    health: value?.health === true,
    authenticated: value?.authenticated === true,
    cssMime: value?.cssMime === true,
    scriptMime: value?.scriptMime === true,
    readyState: typeof value?.readyState === "string" ? value.readyState : null,
    literalLoopbackOrigin: value?.literalLoopbackOrigin === true,
    healthStatus:
      typeof value?.healthStatus === "number" ? value.healthStatus : null,
    tokenStatus:
      typeof value?.tokenStatus === "number" ? value.tokenStatus : null,
    hasSessionKey: value?.hasSessionKey === true,
    workspaceMatches: value?.workspaceMatches === true,
  };
}

function allChecksPassed(checks: SmokeChecks): boolean {
  return (
    checks.workspaceMatches &&
    checks.hashCleared &&
    checks.rendered &&
    checks.health &&
    checks.authenticated &&
    checks.cssMime &&
    checks.scriptMime &&
    checks.literalLoopbackOrigin &&
    checks.hasSessionKey
  );
}

async function saveScreenshot(
  socket: WebSocket,
  name: string,
): Promise<string | undefined> {
  const result = await cdp(socket, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  if (typeof result.data !== "string") return undefined;
  const screenshotPath = join(
    root,
    ".tmp",
    "work",
    "desktop-native-tools",
    name,
  );
  mkdirSync(resolve(screenshotPath, ".."), { recursive: true });
  writeFileSync(screenshotPath, Buffer.from(result.data, "base64"));
  return screenshotPath;
}

function parseCdpMessage(raw: string): CdpMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    const record = asRecord(value);
    return record as CdpMessage | undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function waitForMainWindow(
  pid: number,
  child: Bun.Subprocess,
  title = "Agent Forge Harness",
): Promise<boolean> {
  const deadline = Date.now() + waitLimitMs;
  while (Date.now() < deadline && child.exitCode === null) {
    const result = await powershellResult(
      `$window = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($window.MainWindowTitle -eq '${psQuote(title)}') { $window.MainWindowHandle }`,
      "main-window check",
    );
    if (Number(result.trim()) > 0) return true;
    await delay(250);
  }
  if (child.exitCode !== null)
    throw new Error(
      `The native process exited with code ${child.exitCode} before showing a window.`,
    );
  throw new Error("The native app did not open a visible window.");
}

async function closeMainWindow(pid: number): Promise<void> {
  await powershellResult(
    `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`,
    "window close",
  );
}

async function waitForAppExit(child: Bun.Subprocess): Promise<void> {
  const status = await Promise.race([
    child.exited,
    delay(10_000).then(() => null),
  ]);
  if (status === null)
    throw new Error("The native window did not close cleanly.");
}

function linkOrCopy(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

function assertWithin(base: string, target: string): void {
  const relativePath = relative(resolve(base), resolve(target));
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Refusing a smoke home outside its temporary directory.");
  }
}

async function captureProcessTree(rootPid: number): Promise<ProcessTree> {
  const script = `
    $all = @(Get-CimInstance Win32_Process)
    $root = $all | Where-Object { $_.ProcessId -eq ${rootPid} -and [System.IO.Path]::GetFileName($_.ExecutablePath) -eq 'agent-forge-desktop.exe' } | Select-Object -First 1
    $rootCreated = if ($null -eq $root) { [datetime]::MaxValue } else { [datetime]$root.CreationDate }
    $allowedNames = @('desktop-host.exe','hearth.exe','msedgewebview2.exe','msedge.exe')
    $found = @()
    $frontier = @(${rootPid})
    $seen = @{}
    for ($depth = 0; $depth -lt 4 -and $frontier.Count -gt 0; $depth++) {
      $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId -and $allowedNames -contains [System.IO.Path]::GetFileName($_.ExecutablePath) -and [datetime]$_.CreationDate -ge $rootCreated -and -not $seen.ContainsKey([string]$_.ProcessId) })
      foreach ($item in $next) { $seen[[string]$item.ProcessId] = $true; $found += $item }
      $frontier = @($next | ForEach-Object { $_.ProcessId })
    }
    $toIdentity = { param($item) [pscustomobject]@{ pid=[int]$item.ProcessId; parentPid=[int]$item.ParentProcessId; created=[string]$item.CreationDate; path=[string]$item.ExecutablePath } }
    $rootIdentity = if ($null -eq $root) { $null } else { & $toIdentity $root }
    $childIdentities = @($found | ForEach-Object { & $toIdentity $_ })
    [pscustomobject]@{ root=$rootIdentity; children=$childIdentities } | ConvertTo-Json -Compress -Depth 5
  `;
  const parsed = asRecord(
    JSON.parse(
      await powershellResult(script, "process-tree capture"),
    ) as unknown,
  );
  const rootIdentity = parseProcessIdentity(parsed?.root);
  const rawChildren = parsed?.children;
  const childValues = Array.isArray(rawChildren)
    ? rawChildren
    : rawChildren === undefined || rawChildren === null
      ? []
      : [rawChildren];
  const children = childValues
    .map(parseProcessIdentity)
    .filter((item): item is ProcessIdentity => item !== undefined);
  if (
    !rootIdentity ||
    basename(rootIdentity.path).toLowerCase() !== "agent-forge-desktop.exe"
  ) {
    throw new Error("The smoke could not verify its native process identity.");
  }
  const allowedChildren = new Set([
    "desktop-host.exe",
    "hearth.exe",
    "msedgewebview2.exe",
    "msedge.exe",
  ]);
  if (
    children.some(
      (child) => !allowedChildren.has(basename(child.path).toLowerCase()),
    )
  ) {
    throw new Error("The smoke found an unexpected child process.");
  }
  if (
    !children.some(
      (child) => basename(child.path).toLowerCase() === "desktop-host.exe",
    ) ||
    !children.some(
      (child) => basename(child.path).toLowerCase() === "hearth.exe",
    )
  ) {
    throw new Error("The smoke did not capture both native host processes.");
  }
  return { root: rootIdentity, children };
}

function parseProcessIdentity(value: unknown): ProcessIdentity | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.pid !== "number" ||
    typeof record.parentPid !== "number" ||
    typeof record.created !== "string" ||
    typeof record.path !== "string"
  )
    return undefined;
  return {
    pid: record.pid,
    parentPid: record.parentPid,
    created: record.created,
    path: record.path,
  };
}

async function waitForCapturedChildrenGone(tree: ProcessTree): Promise<void> {
  if (tree.children.length === 0) return;
  const matches = tree.children
    .map(
      (child) =>
        `[pscustomobject]@{pid=${child.pid};parentPid=${child.parentPid};created='${psQuote(child.created)}';path='${psQuote(child.path)}'}`,
    )
    .join(",");
  const query = `$expected=@(${matches}); $all=@(Get-CimInstance Win32_Process); $live=@(); foreach($item in $expected){$current=$all | Where-Object {$_.ProcessId -eq $item.pid} | Select-Object -First 1; if($current -and [string]$current.CreationDate -eq $item.created -and [int]$current.ParentProcessId -eq $item.parentPid -and [System.IO.Path]::GetFileName($current.ExecutablePath) -eq [System.IO.Path]::GetFileName($item.path)){$live+=$current}}; $live.Count`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = Number(
      (await powershellResult(query, "child-exit check")).trim(),
    );
    if (count === 0) return;
    await delay(250);
  }
  throw new Error(
    "A captured smoke-owned child remained after the window closed.",
  );
}

async function stopCapturedChildren(tree: ProcessTree): Promise<void> {
  const reverse = [...tree.children].reverse();
  const stops = reverse
    .map(
      (child) =>
        `$item=[pscustomobject]@{pid=${child.pid};parentPid=${child.parentPid};created='${psQuote(child.created)}';path='${psQuote(child.path)}'}; $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($item.pid)"; if($current -and [string]$current.CreationDate -eq $item.created -and [int]$current.ParentProcessId -eq $item.parentPid -and [System.IO.Path]::GetFileName($current.ExecutablePath) -eq [System.IO.Path]::GetFileName($item.path)){Stop-Process -Id $item.pid -Force -ErrorAction SilentlyContinue}`,
    )
    .join(";");
  if (stops === "") return;
  const script = stops;
  await powershellResult(script, "child stop").catch(() => "");
}

async function powershellResult(
  script: string,
  purpose: string,
): Promise<string> {
  const result = Bun.spawnSync({
    cmd: [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; ${script}`,
    ],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().toLowerCase();
    const category = /access (is )?denied/.test(stderr)
      ? "access denied"
      : /parsererror|unexpected token|terminatorexpected/.test(stderr)
        ? "PowerShell syntax error"
        : /cim|winmgmts|namespace/.test(stderr)
          ? "CIM query failed"
          : /folder entry unavailable/.test(stderr)
            ? "folder entry unavailable"
            : /expected checkout picker/.test(stderr)
              ? "checkout picker not found"
              : /folder action unavailable/.test(stderr)
                ? "folder action unavailable"
                : "PowerShell command failed";
    throw new Error(
      `${purpose} failed (${category}, exit ${result.exitCode}).`,
    );
  }
  return result.stdout.toString();
}

function psQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function cleanupTemp(path: string): void {
  const base = resolve(tmpdir());
  const target = resolve(path);
  assertWithin(base, target);
  const relativePath = relative(base, target);
  if (!relativePath.startsWith("agent-forge-desktop-smoke-")) return;
  rmSync(target, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (isMain(import.meta)) {
  main().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        ok: false,
        data: null,
        error: error instanceof Error ? error.message : "Desktop smoke failed",
      }),
    );
    process.exitCode = 1;
  });
}
