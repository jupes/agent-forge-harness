import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import { chromium, type Page } from "@playwright/test";
import {
  type ProjectCouncilMetadata,
  type ProjectCouncilOriginalRead,
  type ProjectCouncilReceipt,
  projectCouncilIntentJson,
  projectCouncilMetadataSchema,
  projectCouncilOriginalReadSchema,
  projectCouncilReceiptSchema,
} from "../../types/project-council";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../types/project-council-run-read";
import { loadCouncilProfile } from "../council/workflow";
import { makeOwnerOnly } from "../hearth/acl-windows";
import { isMain } from "../is-main";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { readComments, readState, writeState } from "../../tests/e2e/bd-stand-in-state";
import type { ForgeState } from "../forge/phases";
import { reviewCommentFor } from "../dashboard/forge-run-model";
import { runsHref } from "../../apps/desktop/src/project-runs-model";

const root = resolve(import.meta.dir, "../..");
const stage = join(root, "apps/desktop/build/windows-x64");
const body =
  "Council native smoke fixture: the blue lantern rests beside the open notebook.";
const checkpointNote = "Please add a deterministic example for the checkpoint command.";
const entrypoint = isMain(import.meta);
const modeArgs = entrypoint ? process.argv.slice(2) : [];
const checkpointMode = modeArgs.length === 1 && modeArgs[0] === "--checkpoint";
if (modeArgs.length > 0 && !checkpointMode)
  throw new Error("Expected no arguments or the explicit --checkpoint mode.");
const epicId = checkpointMode
  ? "checkpoint-native-epic"
  : "council-smoke-epic";
const checkpointId = `${epicId}.native-review`;
const waitMs = 60_000;
type Identity = {
  pid: number;
  parentPid: number;
  created: string;
  path: string;
};
type ReplyData = {
  metadata: ProjectCouncilMetadata | null;
  originals: ProjectCouncilOriginalRead[];
  receipts: ProjectCouncilReceipt[];
  runs: ProjectCouncilRunRead[];
  errors: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function assertWithin(base: string, path: string): void {
  const rel = relative(resolve(base), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Smoke path escaped its asserted directory boundary.");
}
function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
async function waitForExit(
  child: Bun.Subprocess,
  timeoutMs: number,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function killAndReap(
  child: Bun.Subprocess,
  label: string,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  if ((await waitForExit(child, 5_000)) === null)
    throw new Error(
      `${label} did not exit after its retained process handle was stopped.`,
    );
}
function cleanError(error: unknown): string {
  return (
    error instanceof Error ? error.message : "Native Council smoke failed"
  )
    .replaceAll(body, "[fixture body redacted]")
    .replaceAll(checkpointNote, "[fixture note redacted]")
    .slice(0, 500);
}
async function compileTool(source: string, output: string): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, "build", "--compile", source, "--outfile", output],
    {
      cwd: root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    },
  );
  const status = await waitForExit(child, 45_000);
  if (status === null) {
    await killAndReap(child, "Inert command fixture build");
    throw new Error("Inert command fixture build timed out.");
  }
  if (status !== 0) throw new Error("Inert command fixture build failed.");
}
async function waitFor<T>(
  read: () => Promise<T | null>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await delay(250);
  }
  throw new Error(`${label} did not become ready within ${waitMs}ms.`);
}
async function runPowerShell(
  script: string,
  timeoutMs = 7_000,
): Promise<string> {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const child = Bun.spawn(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      script,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const out = new Response(child.stdout).text();
  const err = new Response(child.stderr).text();
  const status = await waitForExit(child, timeoutMs);
  if (status === null) {
    await killAndReap(child, "Bounded PowerShell helper");
    throw new Error("Bounded PowerShell helper timed out.");
  }
  const [stdout, stderr] = await Promise.all([out, err]);
  if (status !== 0)
    throw new Error(`Native process helper failed: ${stderr.slice(0, 300)}`);
  return stdout.trim();
}
async function captureTree(
  pid: number,
  executable: string,
  expectedCreated?: string,
): Promise<{ root: Identity; children: Identity[] }> {
  const expected = executable.replaceAll("'", "''");
  const expectedDate = expectedCreated
    ? `$root.CreationDate.ToUniversalTime().ToString('o') -cne '${expectedCreated.replaceAll("'", "''")}' -or `
    : "";
  const script = `
    $all=@(Get-CimInstance Win32_Process)
    $root=@($all | Where-Object { $_.ProcessId -eq ${pid} }) | Select-Object -First 1
    if ($null -eq $root -or ${expectedDate}[IO.Path]::GetFullPath($root.ExecutablePath) -ine [IO.Path]::GetFullPath('${expected}')) { throw 'Native app identity changed.' }
    $rootTime=[datetime]$root.CreationDate
    $allowed=@('desktop-host.exe','hearth.exe','msedgewebview2.exe','msedge.exe')
    $found=@(); $frontier=@(${pid}); $seen=@{'${pid}'=$true}
    for($depth=0;$depth -lt 6 -and $frontier.Count -gt 0;$depth++) {
      $next=@($all | Where-Object { $frontier -contains $_.ParentProcessId -and $allowed -contains [IO.Path]::GetFileName($_.ExecutablePath) -and [datetime]$_.CreationDate -ge $rootTime -and -not $seen.ContainsKey([string]$_.ProcessId) })
      foreach($item in $next) { $seen[[string]$item.ProcessId]=$true; $found += $item }
      $frontier=@($next | ForEach-Object { $_.ProcessId })
    }
    $ids=@($found | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');path=[string]$_.ExecutablePath} })
    $rootIdentity=[pscustomobject]@{pid=[int]$root.ProcessId;parentPid=[int]$root.ParentProcessId;created=$root.CreationDate.ToUniversalTime().ToString('o');path=[string]$root.ExecutablePath}
    [pscustomobject]@{root=$rootIdentity;children=$ids} | ConvertTo-Json -Compress -Depth 5
  `;
  const value = record(JSON.parse(await runPowerShell(script)));
  const rawRoot = record(value?.root);
  if (!rawRoot) throw new Error("Native app identity was not captured.");
  const rootIdentity: Identity = {
    pid: Number(rawRoot.pid),
    parentPid: Number(rawRoot.parentPid),
    created: String(rawRoot.created),
    path: String(rawRoot.path),
  };
  if (
    rootIdentity.pid !== pid ||
    !rootIdentity.created ||
    resolve(rootIdentity.path).toLowerCase() !==
      resolve(executable).toLowerCase()
  )
    throw new Error(
      "Captured native app identity did not match its launched executable.",
    );
  const children = Array.isArray(value?.children)
    ? value.children
    : value?.children
      ? [value.children]
      : [];
  return {
    root: rootIdentity,
    children: children
      .map((child) => record(child))
      .filter((child): child is Record<string, unknown> => !!child)
      .map((child) => ({
        pid: Number(child.pid),
        parentPid: Number(child.parentPid),
        created: String(child.created),
        path: String(child.path),
      })),
  };
}
async function liveOwned(identities: Identity[]): Promise<number[]> {
  if (!identities.length) return [];
  const encoded = Buffer.from(JSON.stringify(identities), "utf8").toString(
    "base64",
  );
  const script = `
    $expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
    $all=@(Get-CimInstance Win32_Process)
    $live=@()
    foreach($item in $expected) {
      $found=@($all | Where-Object { $_.ProcessId -eq [int]$item.pid -and $_.CreationDate.ToUniversalTime().ToString('o') -ceq [string]$item.created -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq [IO.Path]::GetFullPath([string]$item.path) }) | Select-Object -First 1
      if($found) { $live += [int]$item.pid }
    }
    ConvertTo-Json -Compress -InputObject @($live)
  `;
  const value = JSON.parse(await runPowerShell(script));
  return (Array.isArray(value) ? value : value === null ? [] : [value]).map(
    Number,
  );
}
async function closeNative(
  child: Bun.Subprocess,
  executable: string,
  rootIdentity: Identity | undefined,
  identities: Identity[],
): Promise<string[]> {
  const errors: string[] = [];
  if (child.exitCode === null) {
    try {
      if (!rootIdentity)
        throw new Error("Native app identity was not captured before cleanup.");
      if (
        rootIdentity.pid !== child.pid ||
        resolve(rootIdentity.path).toLowerCase() !==
          resolve(executable).toLowerCase()
      )
        throw new Error("Native app identity changed before WM_CLOSE.");
      const current = await captureTree(
        child.pid,
        executable,
        rootIdentity.created,
      );
      for (const item of current.children)
        if (
          !identities.some(
            (known) =>
              known.pid === item.pid &&
              known.created === item.created &&
              known.path.toLowerCase() === item.path.toLowerCase(),
          )
        )
          identities.push(item);
      const expected = executable.replaceAll("'", "''");
      const expectedCreated = rootIdentity.created.replaceAll("'", "''");
      await runPowerShell(
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}' -ErrorAction Stop; if($p.ProcessId -ne ${rootIdentity.pid} -or $p.CreationDate.ToUniversalTime().ToString('o') -cne '${expectedCreated}' -or [IO.Path]::GetFullPath($p.ExecutablePath) -ine [IO.Path]::GetFullPath('${expected}')) { throw 'Native app identity changed before WM_CLOSE.' }; $g=Get-Process -Id ${child.pid} -ErrorAction Stop; if(-not $g.CloseMainWindow()) { throw 'WM_CLOSE was not accepted by the native app.' }`,
      );
      const status = await waitForExit(child, 12_000);
      if (status === null) {
        errors.push("Native app did not exit after graceful WM_CLOSE.");
        await killAndReap(child, "Native app after graceful-close timeout");
      }
    } catch (error) {
      errors.push(cleanError(error));
      if (child.exitCode === null) {
        try {
          await killAndReap(
            child,
            "Native app after identity or close failure",
          );
        } catch (reapError) {
          errors.push(cleanError(reapError));
        }
      }
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const live = await liveOwned(identities);
      if (!live.length) return errors;
    } catch (error) {
      errors.push(cleanError(error));
      break;
    }
    await delay(300);
  }
  const live = await liveOwned(identities).catch((error) => {
    errors.push(cleanError(error));
    return identities.map((item) => item.pid);
  });
  if (live.length)
    errors.push(`Owned native sidecars remain: ${live.join(",")}`);
  return errors;
}

async function main(): Promise<void> {
  const evidenceRoot = resolve(root, ".tmp/work/desktop-native-tools");
  mkdirSync(evidenceRoot, { recursive: true });
  const proofDir = mkdtempSync(join(evidenceRoot, "council-native-smoke-"));
  assertWithin(evidenceRoot, proofDir);
  const fixture = mkdtempSync(join(tmpdir(), "agent-forge-council-native-"));
  assertWithin(tmpdir(), fixture);
  const home = join(fixture, "home"),
    checkout = join(fixture, "checkout");
  let workspaceRoot = checkout;
  const fakeBin = join(fixture, "bin"),
    runner = join(fixture, "application");
  const app = join(runner, "agent-forge-desktop.exe");
  const paths = {
    app: join(stage, "agent-forge-desktop.exe"),
    hearth: join(stage, "hearth.exe"),
    host: join(stage, "desktop-host.exe"),
    dashboard: join(stage, "dashboard"),
  };
  const report: Record<string, unknown> = {
    version: 1,
    ...(checkpointMode ? { scenario: "checkpoint-return" } : {}),
    proofDir,
    fixture,
    projectId: null,
    ...(!checkpointMode ? { requestId: null, intentHash: null } : {}),
    ...(!checkpointMode
      ? { bodySha256: createHash("sha256").update(body).digest("hex") }
      : {}),
    ...(!checkpointMode
      ? {
          schemas: { metadata: false, original: false, receipt: false, run: false },
          protectedReads: 0,
        }
      : {}),
    councilPosts: [],
    screenshots: [],
    cleanupErrors: [],
  };
  let errorText = "";
  let appProcess: Bun.Subprocess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let closeIdentities: Identity[] = [];
  let appIdentity: Identity | undefined;
  try {
    if (process.platform === "win32") makeOwnerOnly(fixture, "directory");
    for (const path of Object.values(paths))
      if (!existsSync(path))
        throw new Error("Packaged Release WebView stage is incomplete.");
    for (const dir of [home, checkout, fakeBin, runner])
      mkdirSync(dir, { recursive: true });
    if (checkpointMode) workspaceRoot = realpathSync.native(checkout);
    mkdirSync(join(checkout, ".git"));
    mkdirSync(join(checkout, "scripts/hearth"), { recursive: true });
    mkdirSync(join(checkout, "councils"), { recursive: true });
    writeFileSync(
      join(checkout, "scripts/hearth/server.ts"),
      "// isolated native Council fixture\n",
    );
    copyFileSync(
      join(root, "councils/default.json"),
      join(checkout, "councils/default.json"),
    );
    const profile = loadCouncilProfile(join(checkout, "councils/default.json"));
    if (
      [...profile.seats, profile.chair].some(
        (seat) => seat.provider !== "fake" || seat.estimatedCostUsd !== 0,
      )
    )
      throw new Error(
        "The packaged Council smoke profile is not zero-cost fake-provider only.",
      );
    const store = createProjectStore(home);
    const catalog = await store.create(
      {
        slug: "council-native-smoke",
        name: "Council native smoke",
        description: "Synthetic isolated fixture",
        icon: "C",
        workspaces: [
          {
            root: workspaceRoot,
            repositories: [workspaceRoot],
            epicIds: [epicId],
          },
        ],
      },
      0,
    );
    const project = catalog.projects[0];
    if (!project) throw new Error("Typed fixture project was not saved.");
    report.projectId = project.id;
    const standInState = join(fixture, "bd-state");
    const bdCalls = checkpointMode
      ? join(standInState, "calls.jsonl")
      : join(fixture, "bd-calls.jsonl");
    const gitCalls = join(fixture, "git-calls.jsonl");
    const bdSource = join(fixture, "bd-fixture.ts"),
      gitSource = join(fixture, "git-fixture.ts");
    let checkpointRuns: Array<{ state: ForgeState; bytes: string }> = [];
    if (checkpointMode) {
      mkdirSync(standInState);
      const createdAt = "2026-10-29T18:00:00.000Z";
      writeState(standInState, {
        [epicId]: {
          id: epicId,
          title: "Native checkpoint return epic",
          issue_type: "epic",
          status: "open",
          priority: 1,
          labels: [`project:${project.slug}`],
          created_at: createdAt,
          updated_at: createdAt,
          dependencies: [],
        },
        [checkpointId]: {
          id: checkpointId,
          title: "Native checkpoint return fixture",
          issue_type: "task",
          status: "in_progress",
          priority: 2,
          labels: [`project:${project.slug}`],
          created_at: createdAt,
          updated_at: createdAt,
          dependencies: [
            {
              issue_id: checkpointId,
              depends_on_id: epicId,
              type: "parent-child",
            },
          ],
        },
      });
      const runsDir = join(workspaceRoot, ".tmp/work/forge-runs");
      mkdirSync(runsDir, { recursive: true });
      const makeRun = (slug: string, label: string): { state: ForgeState; bytes: string } => {
        const state: ForgeState = {
          schemaVersion: 2,
          slug,
          feature: label,
          epic: epicId,
          phase: "plan",
          completed: ["research", "plan"],
          artifacts: {},
          mode: "gated",
          checkout: workspaceRoot,
          updatedAt: createdAt,
        };
        const bytes = JSON.stringify(state);
        writeFileSync(join(runsDir, `${state.slug}.json`), bytes, {
          flag: "wx",
        });
        return { state, bytes };
      };
      checkpointRuns = [
        makeRun("native-checkpoint-run-a", "Checkpoint return fixture A"),
        makeRun("native-checkpoint-run-b", "Checkpoint return fixture B"),
      ];
    }
    if (!checkpointMode)
      writeFileSync(
        bdSource,
        `import{appendFileSync}from'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(bdCalls)},JSON.stringify(args)+'\\n');if(args[0]==='export'&&args.includes('--readonly')&&args.includes('--no-memories')){process.stdout.write(JSON.stringify({id:${JSON.stringify(epicId)},title:'Council smoke epic',issue_type:'epic',status:'open',priority:1,labels:['project:council-native-smoke'],created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',dependencies:[]})+'\\n');process.exit(0)}process.stderr.write('Refused non-read-only Council smoke tracker command\\n');process.exit(2);`,
      );
    writeFileSync(
      gitSource,
      `import{appendFileSync,realpathSync,statSync}from'node:fs';import{join}from'node:path';const root=${JSON.stringify(workspaceRoot)},log=${JSON.stringify(gitCalls)},args=process.argv.slice(2),cwd=realpathSync.native(process.cwd());appendFileSync(log,JSON.stringify({args,cwd})+'\\n');if(cwd.toLowerCase()!==realpathSync.native(root).toLowerCase()||!statSync(join(cwd,'.git')).isDirectory())throw Error('Foreign native fixture Git cwd');const eq=(...v)=>JSON.stringify(args)===JSON.stringify(v),answer=v=>{process.stdout.write(v);process.exit(0)};if(eq('rev-parse','--show-toplevel'))answer(cwd+'\\n');if(eq('rev-parse','--path-format=absolute','--git-common-dir'))answer(join(cwd,'.git')+'\\n');if(eq('worktree','list','--porcelain','-z'))answer('worktree '+cwd+'\\0HEAD '+'0'.repeat(40)+'\\0detached\\0\\0');if(eq('remote','get-url','origin'))process.exit(1);process.stderr.write('Refused unknown fixture Git command\\n');process.exit(2);`,
    );
    await compileTool(
      checkpointMode ? join(root, "tests/e2e/bd-stand-in.ts") : bdSource,
      join(fakeBin, "bd.exe"),
    );
    await compileTool(gitSource, join(fakeBin, "git.exe"));
    for (const name of [
      "agent-forge-desktop.exe",
      "hearth.exe",
      "desktop-host.exe",
    ])
      copyFileSync(join(stage, name), join(runner, name));
    cpSync(paths.dashboard, join(runner, "dashboard"), { recursive: true });
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const portProbe = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {}, drain() {}, error() {} },
    });
    const debugPort = portProbe.port;
    portProbe.stop(true);
    const local = join(home, "AppData/Local"),
      roaming = join(home, "AppData/Roaming");
    mkdirSync(local, { recursive: true });
    mkdirSync(roaming, { recursive: true });
    const env: Record<string, string> = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: fixture,
      TMP: fixture,
      USERPROFILE: home,
      HOME: home,
      LOCALAPPDATA: local,
      APPDATA: roaming,
      COMSPEC: join(systemRoot, "System32/cmd.exe"),
      PATH: [fakeBin, join(systemRoot, "System32"), systemRoot].join(delimiter),
      AGENT_FORGE_HOME: home,
      ...(checkpointMode ? { BD_STAND_IN_STATE: standInState } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      WEBVIEW2_USER_DATA_FOLDER: join(home, "webview-profile"),
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    appProcess = Bun.spawn({
      cmd: [app, "--root", workspaceRoot],
      cwd: runner,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const version = await waitFor(async () => {
      if (appProcess!.exitCode !== null)
        throw new Error(
          `Native app exited before WebView startup (${appProcess!.exitCode}).`,
        );
      try {
        const response = await fetch(
          `http://127.0.0.1:${debugPort}/json/version`,
          { signal: AbortSignal.timeout(1000) },
        );
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    }, "WebView2 CDP endpoint");
    if (!record(version)?.webSocketDebuggerUrl)
      throw new Error("WebView2 did not publish a CDP browser endpoint.");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
      timeout: 10_000,
    });
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!context || !page)
      throw new Error("Packaged native WebView has no page context.");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page
      .getByRole("link", { name: "Open Council native smoke" })
      .waitFor({ timeout: waitMs });
    const firstTree = await captureTree(appProcess.pid, app);
    appIdentity = firstTree.root;
    closeIdentities = firstTree.children;
    const names = new Set(
      closeIdentities.map((item) => basename(item.path).toLowerCase()),
    );
    if (!names.has("desktop-host.exe") || !names.has("hearth.exe"))
      throw new Error(
        "The packaged native app did not own both expected sidecars.",
      );
    const result = checkpointMode
      ? await exerciseCheckpoint(
          page,
          project.id,
          workspaceRoot,
          home,
          standInState,
          checkpointRuns,
          report,
          appProcess.pid,
          app,
        )
      : await exercise(page, project.id, report, appProcess.pid, app);
    for (const item of result) closeIdentities.push(...item);
    const finalTree = await captureTree(
      appProcess.pid,
      app,
      firstTree.root.created,
    );
    for (const item of finalTree.children)
      if (
        !closeIdentities.some(
          (known) =>
            known.pid === item.pid &&
            known.created === item.created &&
            known.path === item.path,
        )
      )
        closeIdentities.push(item);
    report.cleanupErrors = [];
  } catch (error) {
    errorText = cleanError(error);
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      (report.cleanupErrors as string[]).push(cleanError(error));
    }
    if (appProcess) {
      if (appProcess.exitCode === null) {
        try {
          const tree = await captureTree(appProcess.pid, app);
          appIdentity ??= tree.root;
          for (const item of tree.children)
            if (
              !closeIdentities.some(
                (known) =>
                  known.pid === item.pid &&
                  known.created === item.created &&
                  known.path.toLowerCase() === item.path.toLowerCase(),
              )
            )
              closeIdentities.push(item);
        } catch (error) {
          (report.cleanupErrors as string[]).push(cleanError(error));
        }
      }
      if (!appIdentity)
        (report.cleanupErrors as string[]).push(
          "Native app identity was not captured for cleanup.",
        );
      (report.cleanupErrors as string[]).push(
        ...(await closeNative(appProcess, app, appIdentity, closeIdentities)),
      );
    }
  }
  const ok = !errorText && (report.cleanupErrors as string[]).length === 0;
  const envelope = {
    ok,
    data: ok ? report : null,
    error: ok
      ? null
      : errorText || (report.cleanupErrors as string[]).join("; "),
  };
  writeFileSync(
    join(proofDir, "proof.json"),
    JSON.stringify({ ...envelope, evidence: report }, null, 2),
  );
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if (!ok) process.exitCode = 1;
}

type NativeCheckpointEvent = {
  id: number;
  ulid: string;
  ts: string;
  kind: string;
  workspace: string;
  bead_id: string | null;
  run_id: string | null;
  session_id: string | null;
  payload: string;
};

function readNativeCheckpointEvents(
  home: string,
  workspace: string,
  beadId: string,
  kind: "bead.transitioned" | "council.verdict.comment" | "council.run.started",
  limit: 2 | 3,
): NativeCheckpointEvent[] {
  const db = new Database(join(home, "ledger.db"), { readonly: true });
  try {
    return db
      .query<NativeCheckpointEvent, [string, string, string, string]>(
        `SELECT id, ulid, ts, kind, workspace, bead_id, run_id, session_id, payload FROM events WHERE workspace = ? AND bead_id = ? AND kind = ? ORDER BY id LIMIT ${limit}`,
      )
      .all(workspaceKey(workspace), beadId, kind);
  } finally {
    db.close();
  }
}

async function exerciseCheckpoint(
  page: Page,
  projectId: string,
  workspace: string,
  home: string,
  standInState: string,
  runs: readonly { state: ForgeState; bytes: string }[],
  report: Record<string, unknown>,
  appPid: number,
  appPath: string,
): Promise<Identity[][]> {
  const runB = runs.find((item) => item.state.slug === "native-checkpoint-run-b");
  const runA = runs.find((item) => item.state.slug === "native-checkpoint-run-a");
  if (!runA || !runB) throw new Error("The two native checkpoint Runs were not seeded.");
  const runBTitle = runB.state.feature ?? runB.state.slug;
  const posts: { path: string; body: unknown }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !path.startsWith("/__agent-forge/"))
      return;
    let postBody: unknown = null;
    try {
      postBody = request.postDataJSON();
    } catch {
      // The exact path/count assertions below still retain malformed posts.
    }
    posts.push({ path, body: postBody });
  });
  const nav = page.getByRole("navigation", { name: "Project destinations" });
  await page.getByRole("link", { name: "Open Council native smoke" }).click();
  await nav.getByRole("link", { name: "Runs", exact: true }).click();
  await page.getByRole("link", { name: runBTitle, exact: true }).click();
  await page
    .getByRole("article", { name: "Selected forge run" })
    .getByRole("heading", { name: runBTitle, exact: true })
    .waitFor({ timeout: waitMs });
  const checkpointButton = page.getByRole("button", {
    name: "Send " + checkpointId + " to Council",
    exact: true,
  });
  await checkpointButton.waitFor({ timeout: waitMs });
  await checkpointButton.click();
  if (posts.length !== 0)
    throw new Error("Opening the canonical checkpoint Council draft caused a POST.");
  await nav.getByRole("link", { name: "Reviews", exact: true }).click();
  const sourceType = page.getByLabel("Source type");
  const source = page.getByLabel("Beads issue ID");
  await source.waitFor({ timeout: waitMs });
  if ((await sourceType.inputValue()) !== "bead" || (await source.inputValue()) !== checkpointId)
    throw new Error("Council did not receive the exact canonical checkpoint source.");
  const profile = page.getByLabel("Council profile");
  if (!(await profile.inputValue()).replaceAll("\\", "/").endsWith("councils/default.json"))
    throw new Error("The checkpoint flow did not select the fake-only Council profile.");
  await page.getByRole("button", { name: "Prepare original for review" }).click();
  await page.getByRole("heading", { name: "Exact saved original" }).waitFor({ timeout: waitMs });
  const savedCouncilOriginal = page.locator(
    '[aria-label="Exact saved Council original"]',
  );
  await savedCouncilOriginal
    .getByText("Request identity and scope", { exact: true })
    .click();
  const originalIdentity = savedCouncilOriginal.locator("details dl dd");
  const councilRequestId = (await originalIdentity.nth(0).innerText()).trim();
  const councilIntentHash = (await originalIdentity.nth(1).innerText()).trim();
  const councilRunId = (await originalIdentity.nth(2).innerText()).trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(councilRequestId) ||
    !/^[a-f0-9]{64}$/.test(councilIntentHash) ||
    !councilRunId
  )
    throw new Error("The exact saved Council original identity was not visible.");
  await page.getByRole("button", { name: "Convene this exact original" }).click();
  await page.getByRole("heading", { name: "Verified result facts" }).waitFor({ timeout: waitMs });
  await page.getByRole("heading", { name: "Council result" }).waitFor({ timeout: waitMs });
  await page.getByText("Inspect complete public Council result", { exact: true }).click();
  let publicRunValue: unknown;
  try {
    publicRunValue = JSON.parse(
      await page.getByLabel("Complete public Council result transcript").inputValue(),
    );
  } catch {
    throw new Error("The visible completed Council result was invalid JSON.");
  }
  const publicRun = record(publicRunValue);
  const verifiedState = page.getByText("Verified state: completed", { exact: true });
  await verifiedState.waitFor({ timeout: waitMs });
  if (
    !publicRun ||
    publicRun.runId !== councilRunId ||
    publicRun.status !== "completed"
  )
    throw new Error("The completed Council result changed the saved original run identity.");
  await page
    .getByTestId("council-verdict-status")
    .getByText("Verdict comment posted to the bead.", { exact: true })
    .waitFor({ timeout: waitMs });
  const preview = page.locator('[aria-label="Bead verdict comment preview"] pre');
  await preview.waitFor({ timeout: waitMs });
  const previewText = (await preview.textContent()) ?? "";
  const councilComments = readComments(standInState)[checkpointId] ?? [];
  const councilComment = councilComments[0];
  if (
    councilComments.length !== 1 ||
    !councilComment?.id ||
    councilComment.text !== previewText
  )
    throw new Error("The completed Council verdict did not match its one persisted Bead comment.");
  const firstPosts = posts.filter((post) =>
    post.path.includes("/projects/" + projectId + "/council/reviews"),
  );
  const reservePath = "/__agent-forge/projects/" + projectId + "/council/reviews";
  const reservePost = firstPosts.find((post) => post.path === reservePath);
  const commitPath = reservePath + "/" + councilRequestId + "/commit";
  const commitPost = firstPosts.find((post) => post.path === commitPath);
  const sourceChoice = record(record(reservePost?.body)?.sourceChoice);
  const commitBody = record(commitPost?.body);
  if (
    firstPosts.length !== 2 ||
    !reservePost ||
    !commitPost ||
    !sourceChoice ||
    sourceChoice.sourceType !== "bead" ||
    sourceChoice.source !== checkpointId ||
    commitBody?.intentHash !== councilIntentHash
  )
    throw new Error("Council did not perform exactly one reserve and one commit.");
  const councilLedgerBaseline = readNativeCheckpointEvents(home, workspace, checkpointId, "bead.transitioned", 3);
  const councilCommentRows = readNativeCheckpointEvents(home, workspace, checkpointId, "council.verdict.comment", 2);
  const councilStartedRows = readNativeCheckpointEvents(home, workspace, checkpointId, "council.run.started", 2);
  const councilEventRow = councilCommentRows[0];
  const councilBeadEvent = councilLedgerBaseline[0];
  const councilStartedEvent = councilStartedRows[0];
  if (
    councilLedgerBaseline.length !== 1 ||
    councilCommentRows.length !== 1 ||
    councilStartedRows.length !== 1 ||
    !councilEventRow ||
    !councilBeadEvent ||
    councilBeadEvent.kind !== "bead.transitioned" ||
    !councilStartedEvent ||
    councilStartedEvent.kind !== "council.run.started"
  )
    throw new Error("The Council review did not produce one scoped start, verdict, and Bead event.");
  let councilEventPayload: unknown;
  try {
    councilEventPayload = JSON.parse(councilEventRow.payload);
  } catch {
    throw new Error("The Council comment event payload was invalid JSON.");
  }
  const councilEvent = record(councilEventPayload);
  if (
    !councilEvent ||
    Object.keys(councilEvent).sort().join(",") !== "councilRunId,status" ||
    councilEvent.councilRunId !== councilRunId ||
    councilEvent.status !== "posted"
  )
    throw new Error("The Council comment event did not match the displayed result run.");
  let councilStartedPayload: unknown;
  try {
    councilStartedPayload = JSON.parse(councilStartedEvent.payload);
  } catch {
    throw new Error("The Council start event payload was invalid JSON.");
  }
  if (record(councilStartedPayload)?.councilRunId !== councilRunId)
    throw new Error("The Council start event did not match the saved original run.");
  let councilBeadPayload: unknown;
  try {
    councilBeadPayload = JSON.parse(councilBeadEvent.payload);
  } catch {
    throw new Error("The Council Bead event payload was invalid JSON.");
  }
  const councilBead = record(councilBeadPayload);
  if (
    !councilBead ||
    Object.keys(councilBead).sort().join(",") !== "action,hash,length" ||
    councilBead.action !== "comment" ||
    councilBead.hash !== createHash("sha256").update(councilComment.text, "utf8").digest("hex") ||
    councilBead.length !== councilComment.text.length
  )
    throw new Error("The Council Bead metadata did not match its exact persisted comment.");
  await page.setViewportSize({ width: 1100, height: 700 });
  const beforeBack = join(String(report.proofDir), "checkpoint-council-result.png");
  await page.screenshot({ path: beforeBack, fullPage: true });
  await page
    .getByRole("button", {
      name: "Back to Run " + runB.state.slug + " checkpoint " + checkpointId,
      exact: true,
    })
    .click();
  await page
    .getByRole("article", { name: "Selected forge run" })
    .getByRole("heading", { name: runBTitle, exact: true })
    .waitFor({ timeout: waitMs });
  const selectedHref = await page.evaluate(() => location.hash);
  if (selectedHref !== runsHref(projectId, runB.state.slug))
    throw new Error("Council returned to a different Run selection.");
  const note = page.getByLabel("Review note");
  await note.waitFor({ timeout: waitMs });
  if (!(await note.isEnabled()) || !(await note.evaluate((element) => document.activeElement === element)))
    throw new Error("Back to Run did not focus the exact active checkpoint note.");
  if (posts.length !== 2)
    throw new Error("Returning from Council submitted a human checkpoint action.");
  const humanNote = checkpointNote;
  await page.keyboard.type(humanNote);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const requestChanges = page.getByRole("button", {
    name: "Request changes",
    exact: true,
  });
  if (!(await requestChanges.evaluate((element) => document.activeElement === element)))
    throw new Error("Keyboard focus did not reach Request changes.");
  await page.keyboard.press("Enter");
  await page
    .getByText("Review comment recorded and verified.", { exact: true })
    .waitFor({ timeout: waitMs });
  const comments = readComments(standInState)[checkpointId] ?? [];
  const humanComment = comments[1];
  const marker = humanComment?.text.match(/Forge checkpoint review ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/);
  const requestId = marker?.[1];
  const canonicalReview = reviewCommentFor({
    issueId: checkpointId,
    decision: "request-changes",
    note: humanNote,
  });
  if (!canonicalReview.ok || !humanComment || !requestId)
    throw new Error("The human checkpoint comment did not retain its canonical request identity.");
  const expectedHumanComment = canonicalReview.body + "\nForge checkpoint review " + requestId;
  if (
    comments.length !== 2 ||
    comments[0]?.id !== councilComment.id ||
    comments[0]?.id === humanComment.id ||
    humanComment.issueId !== checkpointId ||
    humanComment.text !== expectedHumanComment
  )
    throw new Error("Council and human review comments were not two distinct exact writes.");
  const checkpointPosts = posts.filter((post) =>
    post.path.includes("/runs/" + runB.state.slug + "/checkpoints/" + checkpointId + "/reviews"),
  );
  if (
    checkpointPosts.length !== 2 ||
    checkpointPosts[0]?.path !==
      "/__agent-forge/projects/" +
        projectId +
        "/runs/" +
        runB.state.slug +
        "/checkpoints/" +
        checkpointId +
        "/reviews" ||
    record(checkpointPosts[0]?.body)?.decision !== "request-changes" ||
    record(checkpointPosts[0]?.body)?.note !== humanNote ||
    record(checkpointPosts[0]?.body)?.expectedEpicId !== epicId ||
    record(checkpointPosts[0]?.body)?.expectedRunUpdatedAt !==
      runB.state.updatedAt ||
    record(checkpointPosts[0]?.body)?.requestId !== requestId ||
    !checkpointPosts[1]?.path.endsWith("/" + requestId + "/commit") ||
    typeof record(checkpointPosts[1]?.body)?.intentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(
      String(record(checkpointPosts[1]?.body)?.intentHash),
    )
  )
    throw new Error("The human review did not use one matching prepare/commit pair.");
  const issue = readState(standInState)[checkpointId];
  if (issue?.status !== "in_progress")
    throw new Error("The review action changed the checkpoint Beads status.");
  const runFiles = join(workspace, ".tmp/work/forge-runs");
  for (const item of [runA, runB])
    if (readFileSync(join(runFiles, item.state.slug + ".json"), "utf8") !== item.bytes)
      throw new Error("A checkpoint review changed a Run file.");
  const events = readNativeCheckpointEvents(home, workspace, checkpointId, "bead.transitioned", 3);
  const finalCouncilComments = readNativeCheckpointEvents(home, workspace, checkpointId, "council.verdict.comment", 2);
  const finalCouncilStarted = readNativeCheckpointEvents(home, workspace, checkpointId, "council.run.started", 2);
  const event = events[1];
  if (
    posts.length !== 4 ||
    events.length !== 2 ||
    finalCouncilComments.length !== 1 ||
    JSON.stringify(finalCouncilComments) !== JSON.stringify(councilCommentRows) ||
    finalCouncilStarted.length !== 1 ||
    JSON.stringify(finalCouncilStarted) !== JSON.stringify(councilStartedRows) ||
    JSON.stringify(events.slice(0, 1)) !==
      JSON.stringify(councilLedgerBaseline) ||
    !event ||
    event.id <= councilBeadEvent.id ||
    event.kind !== "bead.transitioned" ||
    event.bead_id !== checkpointId ||
    event.workspace !== workspaceKey(workspace)
  )
    throw new Error("The human comment metadata event was absent or ambiguous.");
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    throw new Error("The checkpoint comment metadata payload was invalid JSON.");
  }
  const eventPayload = record(payload);
  if (
    !eventPayload ||
    Object.keys(eventPayload).sort().join(",") !== "action,hash,length" ||
    eventPayload.action !== "comment" ||
    eventPayload.hash !== createHash("sha256").update(humanComment.text, "utf8").digest("hex") ||
    eventPayload.length !== humanComment.text.length
  )
    throw new Error("The metadata event did not match the human comment hash and length.");
  const urlAndStorage = await page.evaluate(() =>
    [location.href, ...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
  );
  if (urlAndStorage.includes(humanNote))
    throw new Error("The private checkpoint note appeared in URL or browser storage.");
  await page.screenshot({
    path: join(String(report.proofDir), "checkpoint-human-comment-recorded.png"),
    fullPage: true,
  });
  report.checkpointReturn = {
    runSlug: runB.state.slug,
    similarRunSlug: runA.state.slug,
    beadId: checkpointId,
    councilRequestId,
    councilIntentHash,
    councilRunId,
    councilEventId: councilEventRow.id,
    councilCommentId: councilComment.id,
    humanCommentId: humanComment.id,
    humanRequestId: requestId,
    humanEventId: event.id,
    humanCommentSha256: eventPayload.hash,
    humanCommentLength: eventPayload.length,
    runFilesUnchanged: true,
    beadRemainsInProgress: true,
    returnFocusVerified: true,
    screenshots: [beforeBack, join(String(report.proofDir), "checkpoint-human-comment-recorded.png")],
    viewport: "WebView2 viewport emulation at 1100x700; native OS window geometry was not asserted.",
  };
  report.councilPosts = firstPosts.map((post) => post.path);
  report.screenshots = [
    beforeBack,
    join(String(report.proofDir), "checkpoint-human-comment-recorded.png"),
  ];
  report.screenshotViewport =
    "WebView2 viewport emulation at 1100x700; native OS window geometry was not asserted.";
  report.reducedMotion = true;
  report.keyboardFocus = true;
  return [(await captureTree(appPid, appPath)).children];
}

async function exercise(
  page: Page,
  projectId: string,
  report: Record<string, unknown>,
  appPid: number,
  appPath: string,
): Promise<Identity[][]> {
  const posts: string[] = [];
  const captured: ReplyData = {
    metadata: null,
    originals: [],
    receipts: [],
    runs: [],
    errors: [],
  };
  const tasks: Promise<void>[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      path.includes(`/projects/${projectId}/council/reviews`)
    )
      posts.push(path);
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname,
      base = `/projects/${projectId}/council/reviews`;
    const at = path.indexOf(base);
    if (at < 0) return;
    const tail = path.slice(at + base.length),
      method = response.request().method();
    const kind =
      method === "POST" && tail === ""
        ? "reserve"
        : method === "POST" && tail.endsWith("/commit")
          ? "receipt"
          : method === "GET" && /^\/[0-9a-f-]{36}$/.test(tail)
            ? "original"
            : method === "GET" && tail.endsWith("/run")
              ? "run"
              : null;
    if (!kind) return;
    tasks.push(
      (async () => {
        if (!response.ok())
          throw new Error(
            `Council protected read/action returned HTTP ${response.status()}.`,
          );
        const envelope = record(await response.json());
        if (envelope?.ok !== true)
          throw new Error(
            "Council response did not use a successful envelope.",
          );
        const data = envelope.data;
        if (kind === "reserve") {
          const metadata = projectCouncilMetadataSchema.safeParse(
            record(data)?.metadata,
          );
          if (!metadata.success)
            throw new Error(
              "Reserve identity failed the shared metadata schema.",
            );
          captured.metadata = metadata.data;
        } else if (kind === "receipt") {
          const receipt = projectCouncilReceiptSchema.safeParse(data);
          if (!receipt.success)
            throw new Error("Commit receipt failed the shared receipt schema.");
          captured.receipts.push(receipt.data);
        } else if (kind === "original") {
          const original = projectCouncilOriginalReadSchema.safeParse(data);
          if (!original.success)
            throw new Error(
              "Protected original failed the shared original schema.",
            );
          captured.originals.push(original.data);
        } else {
          const run = projectCouncilRunReadSchema.safeParse(data);
          if (!run.success)
            throw new Error("Protected result failed the shared run schema.");
          captured.runs.push(run.data);
        }
      })().catch((error) => {
        captured.errors.push(cleanError(error));
      }),
    );
  });
  const nav = page.getByRole("navigation", { name: "Project destinations" });
  await page.getByRole("link", { name: "Open Council native smoke" }).click();
  await nav.getByRole("link", { name: "Reviews", exact: true }).click();
  await page.getByRole("button", { name: "New review" }).click();
  const source = page.getByLabel("Document or question"),
    profile = page.getByLabel("Council profile");
  await source.fill(body);
  await source.focus();
  await page.keyboard.press("Tab");
  if (
    !(await profile.evaluate((element) => document.activeElement === element))
  )
    throw new Error(
      "Keyboard focus did not reach the Council profile control.",
    );
  if (
    !(await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ))
  )
    throw new Error(
      "Reduced-motion preference did not reach the native WebView.",
    );
  if (
    !(await profile.inputValue())
      .replaceAll("\\", "/")
      .endsWith("councils/default.json")
  )
    throw new Error(
      "The served fixture did not select its fake-only default profile.",
    );
  await source.fill(body);
  await page
    .getByRole("button", { name: "Prepare original for review" })
    .click();
  await page
    .getByRole("heading", { name: "Exact saved original" })
    .waitFor({ timeout: waitMs });
  await page.getByText(body, { exact: true }).waitFor({ timeout: waitMs });
  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await page
    .getByRole("heading", { name: "Verified result facts" })
    .waitFor({ timeout: waitMs });
  await page
    .getByRole("heading", { name: "Council result" })
    .waitFor({ timeout: waitMs });
  const screenshotWide = join(
    String(report.proofDir),
    "council-result-wide.png",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: screenshotWide, fullPage: true });
  const screenshotNarrow = join(
    String(report.proofDir),
    "council-result-narrow.png",
  );
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.screenshot({ path: screenshotNarrow, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const urlAndStorage = await page.evaluate(() =>
    [
      location.href,
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ].join("\n"),
  );
  if (urlAndStorage.includes(body))
    throw new Error("Private fixture text appeared in URL or browser storage.");
  await Promise.all(tasks);
  if (captured.errors.length) throw new Error(captured.errors.join("; "));
  const original = captured.originals[0];
  if (!original || !captured.metadata || captured.receipts.length !== 1)
    throw new Error(
      "Reserve, exact-original, and one commit receipt were not all observed.",
    );
  const requestId = captured.metadata.requestId,
    intentHash = captured.metadata.intentHash;
  const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
  if (
    original.original.requestId !== requestId ||
    original.original.intentHash !== intentHash ||
    createHash("sha256")
      .update(projectCouncilIntentJson(original.original), "utf8")
      .digest("hex") !== intentHash ||
    original.original.context.evidence[0]?.content !== body
  )
    throw new Error(
      "Protected original did not preserve the exact body, UUID, and intent hash.",
    );
  const receipt = captured.receipts[0]!;
  if (
    receipt.metadata.requestId !== requestId ||
    receipt.metadata.intentHash !== intentHash
  )
    throw new Error("Commit receipt changed the canonical identity.");
  const run = captured.runs.find(
    (item) =>
      item.receipt.phase === "completed" &&
      item.job?.run?.status === "completed",
  );
  if (
    !run ||
    !run.job ||
    !run.job.run ||
    run.provenance.requestId !== requestId ||
    run.provenance.intentHash !== intentHash ||
    run.provenance.runId !== original.original.runId ||
    run.job.run.context.contentHash !== original.original.context.contentHash ||
    run.job.run.context.source.kind !== "stdin" ||
    run.job.run.context.evidence?.[0]?.content !== body ||
    run.job.run.actualCostUsd !== 0 ||
    [...run.job.run.profile.seats, run.job.run.profile.chair].some(
      (seat) => seat.provider !== "fake",
    )
  )
    throw new Error(
      "Protected completed result did not match the fake-only exact original.",
    );
  if (
    posts.length !== 2 ||
    posts.filter((path) => path.endsWith("/commit")).length !== 1 ||
    posts.filter(
      (path) =>
        path === `/__agent-forge${`/projects/${projectId}/council/reviews`}` ||
        path.endsWith(`/projects/${projectId}/council/reviews`),
    ).length !== 1
  )
    throw new Error(
      `Expected exactly one reserve and one commit POST; observed ${posts.length}.`,
    );
  const readsBeforeReload = captured.runs.length,
    originalsBeforeReload = captured.originals.length;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page
    .getByRole("heading", { name: "Saved reviews" })
    .waitFor({ timeout: waitMs });
  await page.getByRole("button", { name: "Open result" }).click();
  await page
    .getByRole("heading", { name: "Verified result facts" })
    .waitFor({ timeout: waitMs });
  await Promise.all(tasks);
  if (captured.errors.length) throw new Error(captured.errors.join("; "));
  const reopened = captured.originals.at(-1);
  const reopenedRun = captured.runs
    .filter((item) => item.receipt.phase === "completed")
    .at(-1);
  if (
    captured.originals.length <= originalsBeforeReload ||
    captured.runs.length <= readsBeforeReload ||
    !reopened ||
    reopened.original.requestId !== requestId ||
    reopened.original.intentHash !== intentHash ||
    !reopenedRun ||
    reopenedRun.provenance.requestId !== requestId ||
    reopenedRun.provenance.intentHash !== intentHash ||
    reopenedRun.provenance.runId !== original.original.runId ||
    posts.length !== 2
  )
    throw new Error(
      "Explicit result reopen changed identity or caused an extra POST.",
    );
  report.requestId = requestId;
  report.intentHash = intentHash;
  report.bodySha256 = bodySha256;
  report.protectedReads = captured.runs.length + 1;
  report.schemas = {
    metadata: true,
    original: true,
    receipt: true,
    run: true,
    exactBody: true,
    sameIdentityAfterReload: true,
  };
  report.councilPosts = posts;
  report.screenshots = [screenshotWide, screenshotNarrow];
  report.screenshotViewport =
    "WebView2 viewport emulation at 1440x900 and 1100x700; native OS window geometry was not asserted.";
  report.reducedMotion = true;
  report.keyboardFocus = true;
  return [(await captureTree(appPid, appPath)).children];
}

if (entrypoint) void main();
