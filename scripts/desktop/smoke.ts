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
  linkOrCopy(join(stage, "desktop-host.exe"), join(runner, "desktop-host.exe"));
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
  const appProcess = Bun.spawn({
    cmd: [join(runner, "agent-forge-desktop.exe"), "--root", fixtureRoot],
    cwd: runner,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let socket: WebSocket | undefined;
  let checks: SmokeChecks | undefined;
  let processTree: ProcessTree | undefined;
  let windowVisible = false;
  let cspErrors = 0;
  let smokeError: Error | undefined;
  let failureScreenshot: string | undefined;

  try {
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
      checks = await readChecks(socket);
      if (checks.hashCleared && checks.authenticated && checks.health) break;
      await delay(500);
    }
    if (!checks?.hashCleared || !checks.authenticated || !checks.health) {
      throw new Error(
        "The dashboard did not complete its launch-session exchange.",
      );
    }
    await reloadPage(socket);
    checks = await readChecks(socket);
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
          childrenStopped: true,
        },
        error: null,
      }),
    );
  }
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

async function readChecks(socket: WebSocket): Promise<SmokeChecks> {
  const result = await cdp(socket, "Runtime.evaluate", {
    expression: `(async () => {
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
      const healthOk = await fetch(${JSON.stringify(healthPath)}, { signal: AbortSignal.timeout(2500) })
        .then((response) => { healthStatus = response.status; return response.ok; }).catch(() => false);
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
  };
}

function allChecksPassed(checks: SmokeChecks): boolean {
  return (
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
): Promise<boolean> {
  const deadline = Date.now() + waitLimitMs;
  while (Date.now() < deadline && child.exitCode === null) {
    const result = await powershellResult(
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`,
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
