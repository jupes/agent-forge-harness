import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BUILTIN_SMITHS } from "../config/defaults";
import type { PrivateExecInput } from "../executors/private-capture";
import { restartManagerLockerPids } from "../hearth/windows-cleanup-diagnostic";
import { scratchDirs } from "../test-scratch";
import { createShiftProviderPreparer } from "./provider-prepare";
import {
  fixedProviderPrepareResources,
  fixtureProcessIdentities,
  holdFixtureProcesses,
  type ProcessObservation,
  windowsProbeProcessApi,
} from "./provider-prepare-diagnostics";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture(provider: "claude" | "codex" = "claude") {
  const root = realpathSync.native(
    scratch.make("shift-readonly-capabilities-"),
  );
  mkdirSync(join(root, ".git"));
  const exe = join(
      root,
      `${provider}${process.platform === "win32" ? ".exe" : ""}`,
    ),
    record = join(root, "provider.json");
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(
        import.meta.dir,
        provider === "claude"
          ? "../sessions/fixtures/compiled-coding-cli.ts"
          : "../sessions/fixtures/compiled-codex-task-runtime-cli.ts",
      ),
      "--outfile",
      exe,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  if (built.exitCode !== 0)
    throw Error("Read-only capability fixture did not compile");
  const smith = BUILTIN_SMITHS[`${provider}-journeyman`];
  if (!smith) throw Error("Fixture smith missing");
  const input: PrivateExecInput = {
    provider,
    beadId: "bounded-task-1",
    runId: "bounded-run-1",
    workspace: root,
    cwd: root,
    smith,
    command:
      provider === "claude"
        ? [exe, "-p"]
        : [exe, "exec", "--config", 'approval_policy="never"', "-"],
    stdin: "Never dispatched private input",
    timeoutMs: 5000,
  };
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass=["CODING_FIXTURE_MODE","CODING_FIXTURE_RECORD","CODEX_RUNTIME_MODE","CODEX_RUNTIME_LOG"]\n',
  );
  return { root, record, input };
}

test("preparation verifies the selected smith and current native CLI flags without sending a prompt", async () => {
  const f = fixture();
  const prepare = createShiftProviderPreparer({
    root: f.root,
    environment: { CODING_FIXTURE_RECORD: f.record },
    configHome: f.root,
  });
  expect(await prepare(f.input, new AbortController().signal)).toEqual({
    version: "2.1.296",
  });
  expect(existsSync(f.record)).toBe(false);
});

test("Codex preparation requires explicit approval never and only invokes native version and exec help", async () => {
  const f = fixture("codex"),
    prepare = createShiftProviderPreparer({
      root: f.root,
      configHome: f.root,
      environment: { CODEX_RUNTIME_LOG: f.record },
    });
  await expect(
    prepare(
      { ...f.input, command: [f.input.command[0] ?? "", "exec", "-"] },
      new AbortController().signal,
    ),
  ).rejects.toThrow("private provider transcript");
  expect(existsSync(f.record)).toBe(false);
  expect(await prepare(f.input, new AbortController().signal)).toEqual({
    version: "0.163.0-alpha.10.2",
  });
  let calls: unknown[];
  try {
    calls = readFileSync(f.record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    throw Error("Read-only probe log was not published");
  }
  expect(calls).toMatchObject([
    { kind: "version", argv: ["--version"], stdin: "" },
    { kind: "help", argv: ["exec", "--help"], stdin: "" },
  ]);
});

test("Stop during native capability help settles its owned probe before any prompt", async () => {
  const f = fixture("codex"),
    controller = new AbortController(),
    executable = f.input.command[0] ?? "",
    diagnosticEnabled =
      process.platform === "win32" &&
      process.env["AGENT_FORGE_TEST_PROBE_DIAGNOSTICS"] === "1";
  const prepare = createShiftProviderPreparer({
    root: f.root,
    configHome: f.root,
    environment: {
      CODEX_RUNTIME_LOG: f.record,
      CODEX_RUNTIME_MODE: "hang-help",
    },
  });
  const pending = prepare(f.input, controller.signal);
  const settled = pending.then(
    () => "prepared",
    () => "refused",
  );
  let held: ReturnType<typeof holdFixtureProcesses> | null = null,
    observations: ProcessObservation[] = [],
    failure: unknown = null;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        existsSync(f.record) &&
        readFileSync(f.record, "utf8").includes('"kind":"help"')
      )
        break;
      await Bun.sleep(10);
    }
    expect(readFileSync(f.record, "utf8")).toContain('"kind":"help"');
    if (diagnosticEnabled)
      held = holdFixtureProcesses(
        fixtureProcessIdentities(readFileSync(f.record, "utf8"), executable),
        windowsProbeProcessApi(),
      );
    controller.abort();
    expect(
      await Promise.race([settled, Bun.sleep(1500).then(() => "hung")]),
    ).toBe("refused");
  } catch (error) {
    failure = error;
  } finally {
    controller.abort();
    await settled;
    try {
      observations = held?.sampleAndClose() ?? [];
    } catch {
      held?.close();
    }
    try {
      scratch.cleanup();
    } catch (cleanupError) {
      if (diagnosticEnabled) {
        let lockerPids: number[] | null = null,
          relativeResources: readonly string[] = ["codex.exe", "provider.json"];
        try {
          const resources = fixedProviderPrepareResources(
            f.root,
            executable,
            f.record,
          );
          relativeResources = resources.relativeNames;
          lockerPids = restartManagerLockerPids(resources.paths);
        } catch {
          // Diagnostic failure remains unavailable; never replace the cleanup result.
        }
        const code =
          cleanupError &&
          typeof cleanupError === "object" &&
          "code" in cleanupError &&
          ["EPERM", "EACCES", "EBUSY"].includes(String(cleanupError.code))
            ? String(cleanupError.code)
            : "other";
        process.stderr.write(
          `${JSON.stringify({
            event: "provider-prepare-scratch-cleanup",
            resources: relativeResources,
            processes: observations,
            lockerPids,
            lockerProbe: lockerPids === null ? "unavailable" : "ok",
            errorCode: code,
          })}\n`,
        );
      }
      if (failure === null) failure = cleanupError;
    }
  }
  if (failure !== null) throw failure;
}, 15000);

test("changed smith configuration or unsupported actual flags refuse before a private turn", async () => {
  const f = fixture();
  const legacy = createShiftProviderPreparer({
    root: f.root,
    environment: {
      CODING_FIXTURE_MODE: "legacy",
      CODING_FIXTURE_RECORD: f.record,
    },
    configHome: f.root,
  });
  await expect(legacy(f.input, new AbortController().signal)).rejects.toThrow(
    "private provider transcript",
  );
  const current = createShiftProviderPreparer({
    root: f.root,
    environment: { CODING_FIXTURE_RECORD: f.record },
    configHome: f.root,
  });
  await expect(
    current(
      { ...f.input, smith: { ...f.input.smith, model: "different-model" } },
      new AbortController().signal,
    ),
  ).rejects.toThrow("private provider transcript");
  expect(existsSync(f.record)).toBe(false);
});
