import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { OPERATOR_HEADER } from "../hearth/paths";
import { isMain } from "../is-main";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { ledgerPath } from "../ledger/paths";
import { resolveCheckout } from "../ledger/workspace";
import { createProjectStore } from "../projects/store";

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
// Find owned modal dialogs too; Process.MainWindowHandle excludes those.
const nativeWindowLocator = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeWindowLocator {
  private delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr p);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      var text = new StringBuilder(256); GetWindowText(h, text, 256);
      if (text.ToString() != title) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
`;

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
  const fakeBdCalls = join(temp, "fake-bd-calls.jsonl");
  writeFileSync(
    fakeBdSource,
    `import {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(fakeBdCalls)},JSON.stringify(process.argv)+"\\n");const row={id:"fixture-epic",title:"Native fixture epic",issue_type:"epic",status:"open",labels:["project:native-fixture"],created_at:"2026-10-21T00:00:00Z",updated_at:"2026-10-21T00:00:00Z"};process.stdout.write(process.argv.includes("export")?JSON.stringify(row)+"\\n":"[]\\n");\n`,
    "utf8",
  );
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
  const trackerProbe = Bun.spawnSync(
    [fakeBdExecutable, "export", "--readonly", "--no-memories"],
    { stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  let trackerRow: unknown;
  try {
    trackerRow = JSON.parse(trackerProbe.stdout.toString());
  } catch {
    trackerRow = null;
  }
  if (
    trackerProbe.exitCode !== 0 ||
    asRecord(trackerRow)?.id !== "fixture-epic"
  )
    throw new Error("Isolated tracker export did not answer a fixture epic.");
  linkOrCopy(executable, join(runner, "agent-forge-desktop.exe"));
  linkOrCopy(join(stage, "hearth.exe"), join(runner, "hearth.exe"));
  cpSync(join(stage, "dashboard"), join(runner, "dashboard"), {
    recursive: true,
  });

  const debugPort = await availablePort();
  const env = {
    // Windows treats PATH/Path as one key; remove inherited aliases before
    // setting the isolated path for native grandchildren.
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => name.toUpperCase() !== "PATH",
      ),
    ),
    AGENT_FORGE_HOME: desktopSmokeHome,
    HTTP_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "",
    no_proxy: "corp.example",
    PATH: [fakeBin, join(systemRoot, "System32"), systemRoot].join(delimiter),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    WEBVIEW2_USER_DATA_FOLDER: join(temp, "webview-profile"),
  };
  const launch = (
    args: string[] = [],
    cwd = runner,
    overrides: Record<string, string> = {},
  ) =>
    Bun.spawn({
      cmd: [join(runner, "agent-forge-desktop.exe"), ...args],
      cwd,
      env: { ...env, ...overrides },
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
  let focusOutline:
    | { specifiedCssPx: number; computedCssPx: number }
    | undefined;

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
    await createProjectStore(desktopSmokeHome).create(
      {
        slug: "native-fixture",
        name: "Native fixture",
        description: "Private catalog verification",
        icon: "N",
        workspaces: [
          {
            root: selectedRoot,
            repositories: [selectedRoot],
            epicIds: ["fixture-epic"],
          },
        ],
      },
      0,
    );
    const fixtureLedger = ledgerPath({ AGENT_FORGE_HOME: desktopSmokeHome });
    const seeded = appendEvent(
      {
        kind: "session.started",
        workspace: resolveCheckout(selectedRoot).workspace,
        beadId: "fixture-epic",
        sessionId: "native-observed-session",
        executor: { provider: "codex", model: "fixture-model" },
        payload: { kind: "interactive" },
      },
      { path: fixtureLedger },
    );
    closeLedger(fixtureLedger);
    if (!seeded.ok)
      throw new Error("Could not seed isolated session metadata.");
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
    const trackerRead = asRecord(
      await evaluate(
        socket,
        `(async () => { const response = await fetch('/__agent-forge/beads/counts', {signal:AbortSignal.timeout(5000)}); return response.json(); })()`,
      ),
    );
    if (trackerRead?.ok !== true)
      throw new Error(
        `Native fixture tracker read failed: ${String(trackerRead?.error ?? "no answer").slice(0, 400)}`,
      );
    let exportCalls = 0;
    for (const line of readFileSync(fakeBdCalls, "utf8").split("\n")) {
      try {
        const args: unknown = JSON.parse(line);
        if (Array.isArray(args) && args.includes("export")) exportCalls++;
      } catch {
        /* An incomplete trailing recorder line is not evidence. */
      }
    }
    if (exportCalls < 2)
      throw new Error(
        "The packaged hearth did not use the isolated tracker stand-in.",
      );
    if (
      !(await evaluate(
        socket,
        `(async () => {
      const read = async () => { const r = await fetch('/__agent-forge/projects', {signal:AbortSignal.timeout(5000)}); const e = await r.json(); if (!r.ok || !e.ok) throw Error('Catalog read failed'); return e.data; };
      const catalog = await read();
      const project = catalog.projects.find(p => p.slug === 'native-fixture');
      if (catalog.version !== 1 || catalog.revision !== 1 || !project || project.pinned) return false;
      const tokenResponse = await fetch(${JSON.stringify(tokenPath)}, {headers:{${JSON.stringify(sessionKeyHeader)}:localStorage.getItem(${JSON.stringify(sessionKeyName)})},signal:AbortSignal.timeout(5000)});
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || !token.ok) return false;
      const r = await fetch('/__agent-forge/projects/' + project.id + '/preferences', {method:'POST',headers:{'Content-Type':'application/json',${JSON.stringify(OPERATOR_HEADER)}:token.data.token},body:JSON.stringify({revision:catalog.revision,pinned:true}),signal:AbortSignal.timeout(5000)});
      const changed = await r.json();
      const confirmed = await read();
      return r.ok && changed.ok && changed.data.revision === 2 && confirmed.revision === 2 && confirmed.projects.find(p => p.id === project.id)?.pinned === true;
    })()`,
      ))
    )
      throw new Error(
        "The packaged hearth did not confirm and persist project preferences.",
      );
    await reloadPage(socket);
    await waitForPage(
      socket,
      `Array.from(document.querySelectorAll('.af-project-card button')).some(b => b.textContent?.trim() === 'Unpin Native fixture')`,
      "The native project card did not reflect persisted preferences.",
    );
    await evaluate(
      socket,
      `Array.from(document.querySelectorAll('.af-project-card a')).find(a => a.textContent?.trim() === 'Open Native fixture')?.click()`,
    );
    await waitForPage(
      socket,
      `document.querySelector('.af-desktop-project-name')?.textContent?.trim() === 'Native fixture' && location.hash.endsWith('/overview')`,
      "The native project card opened the wrong scope.",
    );
    const sourceCheck = asRecord(
      await evaluate(
        socket,
        `(async () => { const id = location.hash.split('/')[3]; const response = await fetch('/__agent-forge/projects/' + id + '/overview', {signal:AbortSignal.timeout(5000)}); return response.json(); })()`,
      ),
    );
    const sourceSummary = asRecord(asRecord(sourceCheck?.data)?.summary);
    if (
      !Array.isArray(sourceSummary?.sessions) ||
      sourceSummary.sessions.length !== 1
    )
      throw new Error(
        `Native fixture source failed: ${JSON.stringify({ problems: sourceSummary?.problems, sessions: sourceSummary?.sessions }).slice(0, 600)}`,
      );
    await waitForPage(
      socket,
      `!!document.querySelector('.af-project-overview a[href*="selectionId=native-observed-session"]')`,
      "The native project overview did not show its scoped session.",
    );
    await saveConnectionShot(socket, "native-project-overview.png");
    await evaluate(
      socket,
      `Array.from(document.querySelectorAll('.af-project-overview a')).find(a => a.textContent?.trim() === 'All sessions')?.click()`,
    );
    await waitForPage(
      socket,
      `document.querySelector('.af-project-sessions')?.textContent?.includes('native-observed-session')`,
      "The native scoped session list did not load.",
    );
    await evaluate(
      socket,
      `Array.from(document.querySelectorAll('.af-project-sessions a')).find(a => a.textContent?.trim() === 'Open native-observed-session')?.click()`,
    );
    await waitForPage(
      socket,
      `document.querySelector('[aria-label="Selected session"]')?.textContent?.includes('native-observed-session')`,
      "The native session inspector did not select its scoped session.",
    );
    await evaluate(socket, `location.hash = '#/desktop/projects'`);
    await waitForPage(
      socket,
      `!!document.querySelector('.af-project-card')`,
      "The native project cards did not return.",
    );
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

    focusOutline = await verifyConnectionRecovery(socket);
    await verifyDesktopFrame(socket);
    // Hearth recovery keeps the host and window, but replaces the child hearth.
    processTree = await captureProcessTree(appProcess.pid);

    // Crash only the fixture-owned host, never a real hearth or another app.
    const priorTree = processTree;
    const priorOrigin = await pageOrigin(socket);
    const priorSession = await sessionFingerprint(socket);
    await stopFixtureHost(priorTree);
    await waitForMainWindow(
      appProcess.pid,
      appProcess,
      "Agent Forge — connection stopped",
    );
    await recoveryDialog(
      appProcess.pid,
      "inspect",
      "Agent Forge — connection stopped",
      "native-runtime-recovery.png",
    );
    await recoveryDialog(
      appProcess.pid,
      "retry",
      "Agent Forge — connection stopped",
    );
    const restartDeadline = Date.now() + waitLimitMs;
    while (Date.now() < restartDeadline) {
      checks = await readChecks(
        socket,
        `${basename(temp)}/selected checkout`,
      ).catch(() => undefined);
      if (
        checks &&
        allChecksPassed(checks) &&
        (await sessionFingerprint(socket)) !== priorSession
      )
        break;
      await delay(500);
    }
    if (
      !checks ||
      !allChecksPassed(checks) ||
      (await sessionFingerprint(socket)) === priorSession
    )
      throw new Error(
        "The restarted host did not establish a fresh authorized connection.",
      );
    const restartedTree = await captureProcessTree(appProcess.pid);
    processTree = {
      children: [...priorTree.children, ...restartedTree.children],
    };
    const activeHosts = restartedTree.children.filter(
      (child) => basename(child.path).toLowerCase() === "desktop-host.exe",
    );
    if (activeHosts.length !== 1)
      throw new Error("Restart did not leave exactly one desktop host.");
    const currentOrigin = await pageOrigin(socket);
    for (const forbidden of new Set(["http://127.0.0.1:1", priorOrigin])) {
      if (forbidden === currentOrigin) continue;
      await cdp(socket, "Page.navigate", { url: `${forbidden}/` });
      if ((await pageOrigin(socket)) !== currentOrigin)
        throw new Error("Native navigation escaped the active host origin.");
    }

    // A second failure exercises Cancel after a successful reconnect.
    await stopFixtureHost(restartedTree);
    await waitForMainWindow(
      appProcess.pid,
      appProcess,
      "Agent Forge — connection stopped",
    );
    await recoveryDialog(
      appProcess.pid,
      "cancel",
      "Agent Forge — connection stopped",
    );
    await waitForAppExit(appProcess);
    if (appProcess.exitCode !== 0)
      throw new Error("Cancelling runtime recovery did not exit cleanly.");
    await waitForCapturedChildrenGone(processTree);
    socket.close();
    socket = undefined;
    await verifyNativeWindowHandoff(launch, runner, fixtureRoot, temp);
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
          runtimeRetryTested: true,
          runtimeCancelTested: true,
          staleWindowDisabledTested: true,
          retiredOriginBlockedTested: true,
          hearthRestartTested: true,
          connectionStatesTested: true,
          unknownRestartHeldTested: true,
          connectionKeyboardTested: true,
          minimumViewportTested: true,
          desktopFrameTested: true,
          scopedNavigationTested: true,
          inspectorCollapseTested: true,
          frameKeyboardTested: true,
          frameTextContrastTested: true,
          normalWindowCloseTested: true,
          reopenWindowTested: true,
          secondWindowHandoffTested: true,
          frameTargetsTested: true,
          frameFocusOutlineTested: true,
          projectCatalogTested: true,
          projectHomeTested: true,
          projectOverviewTested: true,
          projectSessionsTested: true,
          trackerStandInTested: true,
          focusOutline,
          childrenStopped: true,
        },
        error: null,
      }),
    );
  }
}

/** The real packaged page and restart route, with only failure/health answers controlled. */
async function verifyConnectionRecovery(
  socket: WebSocket,
): Promise<{ specifiedCssPx: number; computedCssPx: number }> {
  const interception = await cdp(
    socket,
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
    (() => {
      const original = window.fetch.bind(window);
      const probe = window.__connectionSmoke = {mode:'mismatch', active:0, posts:[], stream:null, sentinel:'same page', dropRestart:false, restore:()=>{window.fetch=original}};
      window.fetch = async (input, init = {}) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (init.method === 'POST') probe.posts.push(path);
        if (path === '/__agent-forge/health' && probe.mode === 'mismatch')
          return Response.json({ok:true,data:{apiVersion:2},error:null});
        if (path === '/__agent-forge/stream') {
          const controller = new AbortController();
          probe.stream = controller;
          const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
          probe.active++;
          signal.addEventListener('abort', () => probe.active--, {once:true});
          if (probe.mode === 'offline') return new Response('offline', {status:503});
          return original(input, {...init, signal});
        }
        const response = await original(input, init);
        if (path === '/__agent-forge/desktop/restart' && probe.dropRestart) {
          probe.dropRestart = false;
          await response.text();
          throw new Error('Smoke: restart answer lost');
        }
        return response;
      };
    })();
  `,
    },
  );
  await reloadPage(socket);
  const banner = "document.querySelector('.af-desktop-connection')";
  await waitForPage(
    socket,
    `${banner}?.dataset.phase === 'version-mismatch'`,
    "Version mismatch did not come from the explicit health version",
  );
  await evaluate(
    socket,
    "window.__connectionSmoke.mode='offline'; window.__connectionSmoke.stream.abort()",
  );
  await waitForPage(
    socket,
    `${banner}?.dataset.phase === 'reconnecting' && ${banner}.textContent.includes('attempt 1 of 5')`,
    "The retry attempt was not shown",
  );
  await waitForPage(
    socket,
    `${banner}?.dataset.phase === 'stopped' && !!${banner}.querySelector('time')`,
    "The stopped banner did not retain its last-data time",
  );
  await cdp(socket, "Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp(socket, "Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const restart = `${banner}.querySelector('button')`;
  // Tab supplies keyboard modality; focus the recovery control as assistive navigation does.
  await cdp(socket, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await cdp(socket, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await evaluate(socket, `${restart}.focus()`);
  const focusEvidence = await evaluate(
    socket,
    `(() => {const button=${restart};const box=button.getBoundingClientRect();const style=getComputedStyle(button);const declared=[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).filter(rule=>rule.selectorText === ':focus-visible').map(rule=>Number.parseFloat(rule.style.getPropertyValue('outline-width') || rule.style.getPropertyValue('outline')));return {visible:button.matches(':focus-visible'),outline:style.outlineStyle,width:Number.parseFloat(style.outlineWidth),specified:declared.at(-1),height:box.height,right:box.right,left:box.left,viewport:innerWidth,animations:${banner}.getAnimations({subtree:true}).length,dpr:devicePixelRatio}})()`,
  );
  const focus = asRecord(focusEvidence);
  if (
    !focus ||
    focus.visible !== true ||
    focus.outline === "none" ||
    focus.specified !== 2 ||
    typeof focus.width !== "number" ||
    focus.width <= 0 ||
    typeof focus.height !== "number" ||
    focus.height < 24 ||
    typeof focus.right !== "number" ||
    typeof focus.viewport !== "number" ||
    focus.right > focus.viewport ||
    typeof focus.left !== "number" ||
    focus.left < 0 ||
    focus.animations !== 0
  )
    throw new Error(
      `Recovery focus, hit target, minimum viewport or reduced motion failed: ${JSON.stringify(focusEvidence)}`,
    );
  await saveConnectionShot(socket, "native-connection-stopped.png");
  const priorSession = await sessionFingerprint(socket);
  const priorOrigin = await pageOrigin(socket);
  await evaluate(
    socket,
    `window.__connectionSmoke.mode='normal'; ${restart}.click()`,
  );
  await waitForPage(
    socket,
    `${banner}?.dataset.phase === 'connected' && ${banner}.textContent.includes('Workspace actions are available')`,
    "Explicit restart did not reconnect",
  );
  if (
    (await sessionFingerprint(socket)) === priorSession ||
    (await pageOrigin(socket)) !== priorOrigin
  )
    throw new Error(
      "Restart did not refresh the session on the existing origin",
    );
  if (
    !(await evaluate(
      socket,
      "window.__connectionSmoke.active === 1 && window.__connectionSmoke.posts.filter(p => p === '/__agent-forge/desktop/restart').length === 1",
    ))
  )
    throw new Error("Restart did not leave exactly one stream and one action");
  await cdp(socket, "Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await saveConnectionShot(socket, "native-connection-connected.png");
  // Lose only the answer after a real restart: the page must never repeat it itself.
  await evaluate(
    socket,
    "window.__connectionSmoke.mode='mismatch'; window.__connectionSmoke.stream.abort()",
  );
  await waitForPage(
    socket,
    `${banner}?.dataset.phase === 'version-mismatch'`,
    "Compatibility was not checked after reconnection",
  );
  await evaluate(
    socket,
    `window.__connectionSmoke.mode='normal';window.__connectionSmoke.dropRestart=true;${restart}.click()`,
  );
  await waitForPage(
    socket,
    `${banner}?.textContent.includes('Outcome unknown') && ${banner}.dataset.phase === 'connected'`,
    "The unknown restart was not held after reads recovered",
  );
  await saveConnectionShot(socket, "native-connection-unknown.png");
  if (
    !(await evaluate(
      socket,
      "window.__connectionSmoke.sentinel === 'same page' && window.__connectionSmoke.active === 1 && window.__connectionSmoke.posts.filter(p => p === '/__agent-forge/desktop/restart').length === 2 && window.__connectionSmoke.posts.every(p => ['/__agent-forge/desktop/restart','/__agent-forge/session'].includes(p))",
    ))
  )
    throw new Error(
      "Recovery reloaded the page, duplicated the stream, or replayed a workspace write",
    );
  await evaluate(socket, `${banner}.querySelector('button').click()`);
  if (
    !(await evaluate(
      socket,
      "window.__connectionSmoke.posts.filter(p => p === '/__agent-forge/desktop/restart').length === 2",
    ))
  )
    throw new Error("Acknowledging an unknown outcome repeated the action");
  if (typeof interception.identifier !== "string")
    throw new Error("Smoke interceptor identifier unavailable");
  await cdp(socket, "Page.removeScriptToEvaluateOnNewDocument", {
    identifier: interception.identifier,
  });
  await evaluate(socket, "window.__connectionSmoke.restore()");
  return { specifiedCssPx: 2, computedCssPx: Number(focus.width) };
}

async function verifyNativeWindowHandoff(
  launch: (
    args: string[],
    cwd: string,
    overrides: Record<string, string>,
  ) => Bun.Subprocess,
  runner: string,
  checkout: string,
  temp: string,
): Promise<void> {
  const processes: Bun.Subprocess[] = [];
  const sockets: WebSocket[] = [];
  const trees: ProcessTree[] = [];
  const start = async (profile: string, needsChildHearth: boolean) => {
    const port = await availablePort();
    const child = launch(["--root", checkout], runner, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: join(temp, profile),
    });
    processes.push(child);
    await waitForMainWindow(child.pid, child);
    const tree = await captureProcessTree(child.pid, needsChildHearth);
    trees.push(tree);
    const target = await waitForTarget(port, child);
    const socket = await openCdp(target.webSocketDebuggerUrl);
    sockets.push(socket);
    await cdpEnable(socket);
    const deadline = Date.now() + waitLimitMs;
    let healthy = false;
    while (Date.now() < deadline) {
      const checks = await readChecks(socket, `${basename(temp)}/checkout`);
      if (allChecksPassed(checks)) {
        healthy = true;
        break;
      }
      await delay(100);
    }
    if (!healthy)
      throw new Error(
        "A review window did not establish its isolated authorized connection",
      );
    return {
      child,
      tree,
      socket,
      session: await sessionFingerprint(socket),
      hearthPid: await pageHearthPid(socket),
    };
  };
  const close = async (child: Bun.Subprocess): Promise<void> => {
    await closeMainWindow(child.pid);
    await waitForAppExit(child);
    if (child.exitCode !== 0)
      throw new Error("Normal native window close did not exit successfully");
  };
  try {
    const first = await start("window-handoff-first", true);
    const second = await start("window-handoff-second", false);
    if (first.hearthPid !== second.hearthPid)
      throw new Error(
        "Two windows started duplicate hearths for the same checkout",
      );
    await close(first.child);
    await waitForCapturedChildrenGone({
      children: first.tree.children.filter(
        (child) => basename(child.path).toLowerCase() !== "hearth.exe",
      ),
    });
    if ((await pageHearthPid(second.socket)) !== first.hearthPid)
      throw new Error(
        "Closing the former owner stopped the second window's hearth",
      );
    const stillConnected = await readChecks(
      second.socket,
      `${basename(temp)}/checkout`,
    );
    if (!allChecksPassed(stillConnected))
      throw new Error(
        "The remaining window lost its session after the former owner closed",
      );
    await close(second.child);
    await waitForCapturedChildrenGone({
      children: trees.flatMap((tree) => tree.children),
    });
    const reopened = await start("window-handoff-second", true);
    if (reopened.session === second.session)
      throw new Error(
        "Reopening the desktop did not refresh its launch session",
      );
    await close(reopened.child);
    await waitForCapturedChildrenGone({ children: reopened.tree.children });
  } finally {
    for (const socket of sockets) socket.close();
    for (const child of processes) {
      if (child.exitCode === null) {
        await closeMainWindow(child.pid).catch(() => {});
        await Promise.race([child.exited, delay(8_000)]);
      }
      if (child.exitCode === null) child.kill();
    }
    for (const tree of trees) await stopCapturedChildren(tree);
    await waitForCapturedChildrenGone({
      children: trees.flatMap((tree) => tree.children),
    });
  }
}

async function pageHearthPid(socket: WebSocket): Promise<number> {
  const result = await cdp(socket, "Runtime.evaluate", {
    expression: `(async () => {const response=await fetch('/__agent-forge/health', {signal:AbortSignal.timeout(2500)});const answer=await response.json();return response.ok && answer.ok === true ? answer.data?.pid : null})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const pid = asRecord(result.result)?.value;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(
      "The native review could not verify its hearth process identity",
    );
  return pid;
}

async function verifyDesktopFrame(socket: WebSocket): Promise<void> {
  const frame = "document.querySelector('.af-desktop-frame')";
  await waitForPage(
    socket,
    `!!${frame}`,
    "The packaged desktop did not mount its frame",
  );
  const session = await sessionFingerprint(socket);
  const origin = await pageOrigin(socket);
  let streamRequests = 0;
  const observe = (event: MessageEvent): void => {
    const message = parseCdpMessage(String(event.data));
    if (message?.method !== "Network.requestWillBeSent") return;
    const request = asRecord(asRecord(message.params)?.request);
    if (
      typeof request?.url === "string" &&
      request.url.endsWith("/__agent-forge/stream")
    )
      streamRequests++;
  };
  socket.addEventListener("message", observe);
  try {
    await cdp(socket, "Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(socket, "location.hash=''");
    await waitForPage(
      socket,
      "document.querySelector('.af-desktop-project-name')?.textContent.includes('No project selected')",
      "The unselected project state was fabricated",
    );
    if (
      await evaluate(
        socket,
        "document.querySelector('.af-desktop-inspector').hidden",
      )
    )
      await evaluate(
        socket,
        "document.querySelector('main button[aria-label=\"Show inspector\"]').click()",
      );
    await waitForPage(
      socket,
      `${frame}.dataset.inspectorOpen === 'true'`,
      "The inspector did not open at the wide viewport",
    );
    if (
      !(await evaluate(
        socket,
        `(() => {const main=document.querySelector('main').getBoundingClientRect();const inspector=document.querySelector('.af-desktop-inspector').getBoundingClientRect();return document.documentElement.scrollWidth <= innerWidth && main.width > 400 && inspector.width >= 290 && inspector.left >= main.right-1})()`,
      ))
    )
      throw new Error(
        "The wide desktop frame overflowed or its inspector overlapped the content",
      );
    await saveConnectionShot(socket, "native-frame-1440.png");
    if (
      !(await evaluate(
        socket,
        `(() => {const targets=[...document.querySelectorAll('.af-desktop-frame a[href],.af-desktop-frame button:not([disabled])')].map(node=>node.getBoundingClientRect()).filter(box=>box.width>0&&box.height>0&&box.right>0&&box.bottom>0);return targets.length>5&&targets.every(box=>box.width>=24&&box.height>=24)})()`,
      ))
    )
      throw new Error(
        "A visible desktop control is smaller than its 24px target",
      );
    if (
      !(await evaluate(
        socket,
        `(() => {
      const channels = value => value.match(/[\\d.]+/g).slice(0,3).map(Number);
      const light = rgb => rgb.map(n => { const c=n/255; return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4; }).reduce((sum,n,i)=>sum+n*[0.2126,0.7152,0.0722][i],0);
      return [...document.querySelectorAll('.af-desktop-frame .af-empty-hint,.af-desktop-breadcrumb,.af-desktop-content-header .af-btn')].every(node => {
        const foreground=light(channels(getComputedStyle(node).color));
        let surface=node; while(surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface=surface.parentElement;
        if(!surface) return false;
        const background=light(channels(getComputedStyle(surface).backgroundColor));
        return (Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05) >= 4.5;
      });
    })()`,
      ))
    )
      throw new Error(
        "Desktop hint text failed AA contrast against its rendered surface",
      );
    const project = "project-stable-42";
    const selection = "agent-forge-harness-" + "long-bead-reference-".repeat(8);
    await evaluate(
      socket,
      `location.hash=${JSON.stringify(`#/desktop/project/${project}/beads?selectionKind=bead&selectionId=${selection}`)}`,
    );
    await waitForPage(
      socket,
      "document.querySelector('main h1')?.textContent === 'Beads'",
      "Project navigation did not reach the content outlet",
    );
    // Stress the existing name slot without inventing a persisted project record.
    await evaluate(
      socket,
      "document.querySelector('.af-desktop-project-name > span').textContent='A long project name with many repositories '.repeat(20)",
    );
    if (
      !(await evaluate(
        socket,
        "(() => {const name=document.querySelector('.af-desktop-project-name > span');return name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis' && document.documentElement.scrollWidth <= innerWidth})()",
      ))
    )
      throw new Error("A long project title escaped its constrained name slot");
    await evaluate(
      socket,
      "document.querySelector('button[aria-label=\"Close inspector\"]').focus()",
    );
    await cdp(socket, "Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForPage(
      socket,
      `${frame}.dataset.inspectorOpen === 'false'`,
      "The inspector did not collapse at the minimum viewport",
    );
    await waitForPage(
      socket,
      "document.activeElement.getAttribute('aria-label') === 'Show inspector'",
      "Responsive collapse lost the inspector's keyboard focus",
    );
    if (
      !(await evaluate(
        socket,
        "(() => {const side=document.querySelector('.af-desktop-sidebar').getBoundingClientRect();return side.width <= 57 && document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('.af-desktop-sidebar-label')).display === 'none'})()",
      ))
    )
      throw new Error(
        "The minimum desktop viewport did not narrow the sidebar to icons",
      );
    await evaluate(
      socket,
      "document.querySelector('.af-desktop-project-name > span').textContent='Project unavailable'",
    );
    await saveConnectionShot(socket, "native-frame-1100.png");
    // Keyboard navigation changes destinations while preserving stable scope/selection.
    await cdp(socket, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await cdp(socket, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    for (const label of [
      "Inbox",
      "Providers & usage",
      "Smiths",
      "Settings",
      "Projects",
    ]) {
      await evaluate(
        socket,
        `document.querySelector('.af-desktop-rail a[aria-label=${JSON.stringify(label)}]').focus()`,
      );
      if (
        !(await evaluate(
          socket,
          "document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none' && Number.parseFloat(getComputedStyle(document.activeElement).outlineWidth) > 0",
        ))
      )
        throw new Error("A rail destination lost its visible keyboard focus");
      await cdp(socket, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await cdp(socket, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await waitForPage(
        socket,
        `document.querySelector('main h1')?.textContent === ${JSON.stringify(label)}`,
        "Keyboard navigation did not select its destination",
      );
      if (
        !(await evaluate(
          socket,
          `(() => {const query=new URLSearchParams(location.hash.split('?')[1]);return query.get('project') === '${project}' && query.get('selectionId') === ${JSON.stringify(selection)}})()`,
        ))
      )
        throw new Error(
          "Global navigation changed the project or object selection",
        );
    }
    await evaluate(
      socket,
      "document.querySelector('main button[aria-label=\"Show inspector\"]').focus()",
    );
    await cdp(socket, "Input.dispatchKeyEvent", {
      type: "keyDown",
      text: "\r",
      unmodifiedText: "\r",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await cdp(socket, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await waitForPage(
      socket,
      `${frame}.dataset.inspectorOpen === 'true'`,
      "Keyboard inspector toggle did not open",
    );
    await evaluate(
      socket,
      "document.querySelector('button[aria-label=\"Close inspector\"]').focus()",
    );
    await cdp(socket, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp(socket, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitForPage(
      socket,
      "document.activeElement.getAttribute('aria-label') === 'Show inspector'",
      "Closing the inspector did not restore keyboard focus",
    );
    if (
      streamRequests !== 0 ||
      (await sessionFingerprint(socket)) !== session ||
      (await pageOrigin(socket)) !== origin
    )
      throw new Error(
        "Frame navigation restarted the stream, session or origin",
      );
    await evaluate(socket, "location.hash=''");
  } finally {
    socket.removeEventListener("message", observe);
  }
}

async function waitForPage(
  socket: WebSocket,
  expression: string,
  error: string,
): Promise<void> {
  const deadline = Date.now() + waitLimitMs;
  while (Date.now() < deadline) {
    if (await evaluate(socket, expression)) return;
    await delay(100);
  }
  throw new Error(error);
}

async function saveConnectionShot(
  socket: WebSocket,
  name: string,
): Promise<void> {
  const result = await cdp(socket, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  if (typeof result.data !== "string")
    throw new Error("Connection screenshot unavailable");
  const file = join(root, ".tmp", "work", "desktop-native-tools", name);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, Buffer.from(result.data, "base64"));
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

/** Operate only a dialog owned by this smoke's exact native PID. */
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
${nativeWindowLocator}
'@
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
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
}
'@
    $window = [NativeWindowLocator]::Find(${pid}, '${psQuote(title)}')
    $title = New-Object System.Text.StringBuilder 256
    [void][RecoveryProbe]::GetWindowText($window, $title, 256)
    if ($title.ToString() -ne '${psQuote(title)}') { throw 'Expected startup recovery dialog' }
    if ([RecoveryProbe]::GetDlgItem($window, 4) -eq [IntPtr]::Zero -or [RecoveryProbe]::GetDlgItem($window, 2) -eq [IntPtr]::Zero) { throw 'Recovery choices missing' }
    $default = [RecoveryProbe]::SendMessage($window, 0x400, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64() -band 0xffff
    if ($default -ne 2) { throw 'Cancel is not the default choice' }
    ${
      title === "Agent Forge — connection stopped"
        ? `
    $owner = [RecoveryProbe]::GetWindow($window, 4)
    if ($owner -eq [IntPtr]::Zero -or [RecoveryProbe]::IsWindowEnabled($owner)) { throw 'Stale workspace window is not disabled' }
    `
        : ""
    }
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
    awaitPromise: true,
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
      `Add-Type -TypeDefinition @'
${nativeWindowLocator}
'@
      [NativeWindowLocator]::Find(${pid}, '${psQuote(title)}').ToInt64()`,
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

async function pageOrigin(socket: WebSocket): Promise<string> {
  const result = await cdp(socket, "Runtime.evaluate", {
    expression: "location.origin",
    returnByValue: true,
  });
  const origin = asRecord(result.result)?.value;
  if (typeof origin !== "string")
    throw new Error("WebView origin unavailable.");
  return origin;
}

async function sessionFingerprint(socket: WebSocket): Promise<string> {
  const result = await cdp(socket, "Runtime.evaluate", {
    expression: `(async () => {
      const key = localStorage.getItem(${JSON.stringify(sessionKeyName)});
      if (!key) return "";
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = asRecord(result.result)?.value;
  if (typeof value !== "string" || !value)
    throw new Error("Session fingerprint unavailable.");
  return value;
}

async function stopFixtureHost(tree: ProcessTree): Promise<void> {
  const hosts = tree.children.filter(
    (child) => basename(child.path).toLowerCase() === "desktop-host.exe",
  );
  if (hosts.length !== 1)
    throw new Error("Expected one fixture host before crash.");
  await stopCapturedChildren({ children: hosts });
  await waitForCapturedChildrenGone({ children: hosts });
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

async function captureProcessTree(
  rootPid: number,
  needsChildHearth = true,
): Promise<ProcessTree> {
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
    (needsChildHearth &&
      !children.some(
        (child) => basename(child.path).toLowerCase() === "hearth.exe",
      ))
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
