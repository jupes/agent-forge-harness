import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  smithConfigCreateReceiptSchema,
  smithConfigPreviewSchema,
} from "../config/smith-create-protocol";
import { syncCodexSkills } from "../executors/codex-sync";
import { buildChildEnv } from "../executors/env";
import { verifyKeeperReader } from "../keeper/verify-reader";
import { createCodexTaskRuntime } from "../sessions/codex-task-runtime";
import { verifyProjectShiftEntry } from "../shifts/verify-entry";
import { syncCodex } from "../sync-codex";
import { scratchDirs } from "../test-scratch";
import { lockPath } from "./home";
import { readLock } from "./lock";
import { OPERATOR_HEADER } from "./paths";
import { waitForProtectedReadiness } from "./protected-readiness";

const scratch = scratchDirs();
const root = resolve(import.meta.dir, "../..");
let executable: string;
let provider: string;
type CompiledSmithChild = Bun.Subprocess<"ignore", "ignore", "pipe">;
const withTimeout = async <T>(value: Promise<T>, ms: number, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
function environment(home: string) {
  const base = Object.fromEntries(
    Object.entries(buildChildEnv(process.env, [])).filter(
      ([key]) => key.toLowerCase() !== "path",
    ),
  );
  return {
    ...base,
    PATH: "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    AGENT_FORGE_HOME: join(home, "private-home"),
  };
}
beforeAll(() => {
  const folder = scratch.make("packaged-codex-sync-binary-");
  executable = join(
    folder,
    `hearth${process.platform === "win32" ? ".exe" : ""}`,
  );
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(root, "scripts/hearth/compiled-entry.ts"),
      "--outfile",
      executable,
    ],
    {
      cwd: folder,
      env: environment(folder),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  if (built.exitCode !== 0)
    throw new Error(
      `Packaged sync oracle did not compile: ${built.stderr.toString().slice(-2000)}`,
    );
  provider = join(folder, `codex${process.platform === "win32" ? ".exe" : ""}`);
  const providerEntry = join(folder, "provider-fixture.ts");
  writeFileSync(
    providerEntry,
    `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCodexTaskRuntimeFixture } from ${JSON.stringify(join(root, "scripts/sessions/fixtures/codex-task-runtime-fixture.ts").replaceAll("\\", "/"))};
if (!process.argv.includes("--version") && !process.argv.includes("--help") &&
    !existsSync(join(process.cwd(), ".agents/skills/one/SKILL.md"))) process.exit(19);
await runCodexTaskRuntimeFixture();
`,
  );
  const fake = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      providerEntry,
      "--outfile",
      provider,
    ],
    {
      cwd: folder,
      env: environment(folder),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  if (fake.exitCode !== 0)
    throw new Error(
      `Packaged fake provider did not compile: ${fake.stderr.toString().slice(-2000)}`,
    );
}, 65_000);
afterAll(() => scratch.cleanup());

function plantedRoot() {
  const folder = scratch.make("packaged-codex-sync-root-");
  for (const name of [
    ".git",
    ".claude/skills/one",
    ".claude/commands",
    ".claude/agents",
  ])
    mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(
    join(folder, ".claude/skills/one/SKILL.md"),
    "# Disposable one 🌱\n",
  );
  writeFileSync(
    join(folder, ".claude/commands/alpha.md"),
    "# Alpha\n\nExact body.\n",
  );
  return folder;
}
test("the production compiled hearth syncs its chosen cwd without ambient Bun or source scripts", () => {
  const folder = plantedRoot();
  const result = Bun.spawnSync([executable, "--codex-sync"], {
    cwd: folder,
    env: environment(folder),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  let receipt: unknown;
  try {
    receipt = JSON.parse(result.stdout.toString());
  } catch {
    throw new Error("Packaged sync did not return its metadata envelope");
  }
  expect(receipt).toMatchObject({
    ok: true,
    data: { skills: 1, commandsConverted: 1 },
    error: null,
  });
  expect(
    readFileSync(join(folder, ".agents/skills/one/SKILL.md"), "utf8"),
  ).toBe("# Disposable one 🌱\n");
  expect(existsSync(join(folder, "scripts"))).toBe(false);
  expect(existsSync(join(folder, "package.json"))).toBe(false);
  expect(existsSync(join(folder, "private-home"))).toBe(false);
}, 10_000);

function generated(root: string, relative = ""): Array<[string, string]> {
  return readdirSync(join(root, relative), { withFileTypes: true })
    .flatMap<[string, string]>((entry) => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? generated(root, path)
        : [[path, readFileSync(join(root, path)).toString("base64")]];
    })
    .filter(([path]) =>
      !relative
        ? path.startsWith(".agents/") || path.startsWith(".codex/")
        : true,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

test("packaged sync produces the source mirror only in the canonical linked checkout", async () => {
  const main = plantedRoot(),
    worktree = scratch.make("packaged-codex-linked-");
  const gitdir = join(main, ".git/worktrees/linked");
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  mkdirSync(join(worktree, ".claude/skills/one"), { recursive: true });
  mkdirSync(join(worktree, ".claude/commands"), { recursive: true });
  mkdirSync(join(worktree, ".claude/agents"), { recursive: true });
  writeFileSync(
    join(worktree, ".claude/skills/one/SKILL.md"),
    "# Linked checkout's own source\n",
  );
  const reference = plantedRoot();
  writeFileSync(
    join(reference, ".claude/skills/one/SKILL.md"),
    "# Linked checkout's own source\n",
  );
  // Every generated byte comes from the linked checkout's own source.
  writeFileSync(
    join(worktree, ".claude/commands/alpha.md"),
    "# Alpha\n\nExact body.\n",
  );
  syncCodex(reference);
  await syncCodexSkills({
    workspace: main,
    worktree,
    command: [executable, "--codex-sync"],
    env: environment(worktree),
    timeoutMs: 5000,
  });
  expect(generated(worktree)).toEqual(generated(reference));
  expect(existsSync(join(main, ".agents"))).toBe(false);
  const foreign = plantedRoot();
  await syncCodexSkills({
    workspace: main,
    worktree: foreign,
    command: [executable, "--codex-sync"],
    env: environment(foreign),
    timeoutMs: 5000,
  });
  expect(existsSync(join(foreign, ".agents"))).toBe(false);
});

test("fixed packaged sync rejects extra caller paths or commands without creating server state or changing either root", () => {
  const folder = plantedRoot(),
    other = plantedRoot();
  for (const args of [["--root", other], [other], ["--command", provider]]) {
    const result = Bun.spawnSync([executable, "--codex-sync", ...args], {
      cwd: folder,
      env: environment(folder),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.toString());
    } catch {
      throw new Error("Packaged refusal did not return JSON");
    }
    expect(value).toMatchObject({ ok: false, data: null });
    for (const root of [folder, other]) {
      expect(existsSync(join(root, ".agents"))).toBe(false);
      expect(existsSync(join(root, ".codex"))).toBe(false);
      expect(existsSync(join(root, "private-home"))).toBe(false);
    }
  }
});

test("a native Task uses the fixed packaged sync before provider dispatch and never dispatches after sync refusal", async () => {
  for (const valid of [true, false]) {
    const folder = valid
      ? plantedRoot()
      : scratch.make("packaged-codex-no-source-");
    if (!valid) mkdirSync(join(folder, ".git"));
    const configHome = join(folder, "config"),
      home = join(folder, "home");
    mkdirSync(configHome);
    mkdirSync(home);
    writeFileSync(
      join(folder, "agent-forge.toml"),
      '[execution.env]\npass = ["CODEX_RUNTIME_LOG"]\n',
    );
    const log = join(folder, "provider.jsonl");
    const runtime = createCodexTaskRuntime({
      root: folder,
      home,
      configHome,
      command: [provider],
      syncCommand: [executable, "--codex-sync"],
      environment: { ...environment(folder), CODEX_RUNTIME_LOG: log },
      timeoutMs: 5000,
    });
    const snapshot = await runtime.prepare({
      smith: "codex-journeyman",
      launch: {
        mode: "task",
        cwd: folder,
        model: "gpt-example-exact",
        sandbox: "read-only",
        approvalPolicy: "never",
        prompt: "Private planted input",
      },
    });
    const result = await runtime.run(
      snapshot,
      async () => {},
      new AbortController().signal,
    );
    let lines: unknown[];
    try {
      lines = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error("Fake native provider did not record its calls");
    }
    expect(result.phase).toBe(valid ? "completed" : "failed");
    expect(lines).toHaveLength(valid ? 5 : 4);
    expect(JSON.stringify(lines)).toContain(
      valid ? '"kind":"task"' : '"kind":"help"',
    );
    if (!valid) expect(JSON.stringify(lines)).not.toContain('"kind":"task"');
  }
}, 15_000);

test("the same compiled production entry retains the sealed Keeper reader", async () => {
  expect(
    await verifyKeeperReader([executable, "--keeper-reader"]),
  ).toMatchObject({
    oneReadonlyTool: true,
    projectScoped: true,
    scopeChangeRefused: true,
    noOperatorAction: true,
    childStopped: true,
  });
}, 20_000);

test("the same compiled production entry consumes only an authorized original and never repeats engine admission", async () => {
  await verifyProjectShiftEntry([executable]);
}, 15_000);

test("compiled Smith create survives restart and serves its immutable original before corrupt config reads", async () => {
  const root = realpathSync.native(plantedRoot());
  const profilePath = join(root, ".compiled-smith-profile");
  mkdirSync(profilePath);
  const profile = realpathSync.native(profilePath);
  const privateHome = join(profile, "private-home");
  const configFile = join(root, "agent-forge.toml");
  const smith = {
    name: "compiled-receipt-smith",
    provider: "custom",
    model: "reviewed-model",
    effort: "high",
    enabled: true,
    tags: ["compiled-checkpoint"],
  };
  const startServer = (): {
    child: CompiledSmithChild;
    privateHome: string;
    stderr: Promise<string>;
  } => {
    const child = Bun.spawn([executable, "--root", root], {
      cwd: root,
      env: { ...environment(profile), HEARTH_PORT: "0" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    });
    return { child, privateHome, stderr: new Response(child.stderr).text() };
  };
  const stopChild = async (
    server: ReturnType<typeof startServer>,
    assertSignalSettled: boolean,
  ) => {
    let signalSettled = true,
      usedHardStop = false,
      code: number;
    if (server.child.exitCode !== null) code = server.child.exitCode;
    else {
      server.child.kill("SIGTERM");
      try {
        code = await withTimeout(
          server.child.exited,
          3000,
          "Graceful hearth stop timed out",
        );
      } catch {
        signalSettled = false;
        usedHardStop = true;
        server.child.kill("SIGKILL");
        code = await withTimeout(
          server.child.exited,
          3000,
          "Hard-stopped hearth did not exit",
        );
      }
    }
    const stderr = await withTimeout(
      server.stderr,
      3000,
      "Hearth stderr did not drain",
    );
    const result = { code, stderr, signalSettled, usedHardStop };
    if (assertSignalSettled) {
      expect(result.signalSettled, JSON.stringify(result)).toBe(true);
      expect(result.usedHardStop, JSON.stringify(result)).toBe(false);
      expect(
        result.code === 0 ||
          (process.platform === "win32" && result.code === 143),
        JSON.stringify(result),
      ).toBe(true);
      expect(result.stderr, JSON.stringify(result)).toBe("");
    }
    return result;
  };
  const waitForServer = async (
    server: ReturnType<typeof startServer>,
    readinessPath: string,
  ) => {
    const ready = await waitForProtectedReadiness({
      expectedPid: server.child.pid,
      readIdentity: () => {
        const lock = readLock(lockPath(server.privateHome, root));
        if (!lock) return null;
        let token = "";
        try {
          token = readFileSync(lock.tokenFile, "utf8").trim();
        } catch {
          /* The new lock can be visible before its token is installed. */
        }
        return {
          pid: lock.pid,
          url: `http://127.0.0.1:${lock.port}`,
          token,
        };
      },
      probe: async ({ url, token }) => {
        const response = await fetch(`${url}${readinessPath}`, {
          headers: { Origin: url, [OPERATOR_HEADER]: token },
          signal: AbortSignal.timeout(2000),
        });
        if (response.status === 200 || response.status === 404)
          return {
            kind: "ready",
            status: response.status,
            value: response,
          };
        return { kind: "refused", status: response.status };
      },
      now: Date.now,
      sleep: Bun.sleep,
      timeoutMs: 10_000,
      intervalMs: 50,
    });
    if (server.child.exitCode !== null)
      throw new Error(
        "Compiled Smith hearth exited during protected readiness.",
      );
    return {
      url: ready.identity.url,
      token: ready.identity.token,
      readiness: ready.value,
    };
  };
  const stopServer = async (server: ReturnType<typeof startServer>) => {
    await stopChild(server, true);
  };
  const send = (
    server: Awaited<ReturnType<typeof waitForServer>>,
    path: string,
    init: RequestInit = {},
  ) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: {
        Origin: server.url,
        [OPERATOR_HEADER]: server.token,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(5000),
    });

  let first = startServer();
  try {
    const firstAddress = await waitForServer(
      first,
      `/__agent-forge/smiths/creates/${randomUUID()}`,
    );
    // An authenticated 404 is only a read-readiness witness, never evidence
    // that an original Start was not admitted.
    await firstAddress.readiness.body?.cancel();
    const previewResponse = await send(
      firstAddress,
      "/__agent-forge/config/smiths/preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "workspace", smith }),
      },
    );
    expect(previewResponse.status).toBe(200);
    const previewBody = await previewResponse.json();
    expect(previewBody.ok).toBe(true);
    const preview = smithConfigPreviewSchema.parse(previewBody.data);
    const request = {
      requestId: randomUUID().toLowerCase(),
      target: "workspace" as const,
      smith,
      expectedRevision: preview.expectedRevision,
    };
    const createResponse = await send(
      firstAddress,
      "/__agent-forge/config/smiths/creates",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    expect(createResponse.status).toBe(200);
    const createBody = await createResponse.json();
    expect(createBody.ok).toBe(true);
    const receipt = smithConfigCreateReceiptSchema.parse(createBody.data);
    expect(receipt.result.phase).toBe("confirmed");
    expect(existsSync(join(privateHome, "smith-create-journal"))).toBe(true);
    expect(existsSync(join(privateHome, "config.toml"))).toBe(false);
    await stopServer(first);

    const corrupt = "this is not valid TOML = [\n";
    writeFileSync(configFile, corrupt);
    first = startServer();
    const restarted = await waitForServer(
      first,
      `/__agent-forge/smiths/creates/${request.requestId}`,
    );
    const originalResponse = restarted.readiness;
    expect(originalResponse.status).toBe(200);
    const originalBody = await originalResponse.json();
    expect(smithConfigCreateReceiptSchema.parse(originalBody.data)).toEqual(
      receipt,
    );

    const retryResponse = await send(
      restarted,
      "/__agent-forge/config/smiths/creates",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    expect(retryResponse.status).toBe(200);
    const retryBody = await retryResponse.json();
    expect(smithConfigCreateReceiptSchema.parse(retryBody.data)).toEqual(
      receipt,
    );

    const changed = {
      ...request,
      smith: { ...smith, model: "different-model" },
    };
    const conflict = await send(
      restarted,
      "/__agent-forge/config/smiths/creates",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changed),
      },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe(
      "The request ID belongs to a different saved Smith create.",
    );
    expect(readFileSync(configFile, "utf8")).toBe(corrupt);
    expect(existsSync(join(privateHome, "config.toml"))).toBe(false);
  } finally {
    if (first.child.exitCode === null) await stopChild(first, false);
  }
}, 30_000);
