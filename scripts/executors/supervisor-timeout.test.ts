import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import { buildChildEnv } from "./env";
import {
  INTERACTIVE_BOOTSTRAP_CONTROL,
  INTERACTIVE_BOOTSTRAP_TERMINAL,
} from "./interactive-bootstrap";
import { supervise } from "./supervisor";
import { guardSuspendedWindowsProcess } from "./tree-guard";

const scratch = scratchDirs();
afterAll(() => scratch.cleanup());
let command: string;
beforeAll(() => {
  command = join(
    scratch.make("interactive-timeout-"),
    process.platform === "win32" ? "fixture.exe" : "fixture",
  );
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "fixtures/interactive-cli.ts"),
      "--outfile",
      command,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  if (build.exitCode !== 0)
    throw Error(
      `Closed fixture compile failed: ${build.stderr.toString().slice(-2000)}`,
    );
}, 15_000);

function alive(pid: number) {
  try {
    if (
      process.platform === "linux" &&
      /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a real bootstrap deadline retains timeout truth after partial output delays its parent's event loop", async () => {
  const owner = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/interactive-timeout-parent.ts"),
      command,
    ],
    {
      cwd: import.meta.dir,
      env: buildChildEnv(process.env, []),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(owner.stdout).text(),
    new Response(owner.stderr).text(),
    owner.exited,
  ]);
  expect(code, stderr).toBe(0);
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw Error(
      `Invalid closed oracle result: ${stdout.slice(-2000)} ${stderr.slice(-2000)}`,
    );
  }
  expect(value).toMatchObject({
    held: true,
    live: 0,
    result: { timedOut: true, stopped: false },
  });
  if (
    !value ||
    typeof value !== "object" ||
    !("providerPid" in value) ||
    typeof value.providerPid !== "number" ||
    !("lines" in value) ||
    !Array.isArray(value.lines)
  )
    throw Error("Missing closed oracle identity/output");
  expect(value.lines).toContain("partial native text");
  let tree: unknown;
  try {
    tree = JSON.parse(String(value.lines[0]));
  } catch {
    throw Error("Missing closed native helper announcement");
  }
  if (
    !tree ||
    typeof tree !== "object" ||
    !("childPid" in tree) ||
    typeof tree.childPid !== "number"
  )
    throw Error("Invalid closed helper identity");
  expect(alive(value.providerPid)).toBe(false);
  expect(alive(tree.childPid)).toBe(false);
});

test("an owned versioned terminal timeout witness is retained independently of the parent timer", async () => {
  const handle = supervise({
    command: [command],
    bootstrapCommand: [
      process.execPath,
      join(import.meta.dir, "fixtures/interactive-control.ts"),
      "terminal-timeout",
    ],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    timeoutMs: 2000,
    onLine() {
      throw Error("A private witness cannot enter stdout");
    },
  });
  try {
    expect(await handle.done).toMatchObject({ timedOut: true, stopped: false });
  } finally {
    await handle.stop("closed witness cleanup");
  }
});

test("ordinary native exit one and forged stdout do not claim a bootstrap timeout", async () => {
  for (const mode of ["exit-one", "forged-timeout"]) {
    const lines: string[] = [];
    const handle = supervise({
      command: [command, mode],
      cwd: import.meta.dir,
      env: buildChildEnv(process.env, []),
      stdinMode: "interactive",
      timeoutMs: 2000,
      onLine: (line) => lines.push(line),
    });
    try {
      const result = await handle.done;
      expect(result).toEqual({
        exitCode: 1,
        timedOut: false,
        stopped: false,
        ownedTreeReleased: true,
        stderr: "",
      });
      expect(lines.length).toBe(mode === "forged-timeout" ? 1 : 0);
      await handle.stop("late settled cleanup");
      expect(result).toEqual({
        exitCode: 1,
        timedOut: false,
        stopped: false,
        ownedTreeReleased: true,
        stderr: "",
      });
    } finally {
      await handle.stop("closed exit cleanup");
    }
  }
});

test("private terminal facts refuse missing, foreign, future, malformed, duplicate or unordered receipts", async () => {
  for (const mode of [
    "missing",
    "pid",
    "version",
    "extra",
    "value",
    "duplicate",
    "order",
  ]) {
    let settlementFact: string | null = null;
    const startedAt = Date.now();
    const handle = supervise({
      command: [command],
      bootstrapCommand: [
        process.execPath,
        join(import.meta.dir, "fixtures/interactive-control.ts"),
        `terminal-invalid-${mode}`,
      ],
      cwd: import.meta.dir,
      env: buildChildEnv(process.env, []),
      stdinMode: "interactive",
      timeoutMs: 3000,
      ...(process.platform === "win32" && process.arch === "x64"
        ? {
            interactiveGuard(pid: number) {
              return guardSuspendedWindowsProcess(pid, {
                onWindowsSettlementFailure(
                  phase,
                  generationFailure,
                  unaccountedFailure,
                ) {
                  if (settlementFact !== null) return;
                  try {
                    const bounded = (value: number | null | undefined) =>
                        value !== null &&
                        value !== undefined &&
                        Number.isSafeInteger(value) &&
                        value >= 0 &&
                        value <= 0xffff_ffff
                          ? String(value)
                          : "unknown",
                      elapsedMs = Math.min(
                        3000,
                        Math.max(0, Date.now() - startedAt),
                      ),
                      reason = generationFailure?.reason ?? "none";
                    settlementFact = `mode=${mode}; phase=${phase}; reason=${reason}; elapsedMs=${elapsedMs}; generationCounts=${bounded(generationFailure?.initialTotal)},${bounded(generationFailure?.capturedTotal)},${bounded(generationFailure?.retainedCount)},${bounded(generationFailure?.capturedMemberCount)}; accountingCounts=${bounded(unaccountedFailure?.activeCount)},${bounded(unaccountedFailure?.retainedCount)},${bounded(unaccountedFailure?.capturedMemberCount)},${bounded(unaccountedFailure?.initialTotal)},${bounded(unaccountedFailure?.capturedTotal)}`;
                  } catch {
                    settlementFact = `mode=${mode}; phase=${phase}; reason=unknown; elapsedMs=unknown; generationCounts=unknown; accountingCounts=unknown`;
                  }
                },
              });
            },
          }
        : {}),
      onLine() {
        throw Error("Private terminal controls cannot enter stdout");
      },
    });
    const withSettlementFact = async (assertion: () => unknown) => {
      try {
        await assertion();
      } catch (error) {
        if (settlementFact === null) throw error;
        throw new Error(
          `The private-terminal rejection assertion failed; ${settlementFact}`,
          { cause: error },
        );
      }
    };
    await withSettlementFact(() =>
      expect(handle.done).rejects.toThrow("private interactive terminal"),
    );
    await withSettlementFact(() =>
      expect(handle.stop("late rejected cleanup")).rejects.toThrow(
        "private interactive terminal",
      ),
    );
    expect(alive(handle.pid)).toBe(false);
  }
});

test("the real bootstrap bounds a missing terminal acknowledgement without exposing private input", async () => {
  const messages: unknown[] = [];
  const env = buildChildEnv(process.env, []);
  const wrapper = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      `--config=${join(import.meta.dir, "interactive-bootstrap.bunfig.toml")}`,
      join(import.meta.dir, "interactive-bootstrap-entry.ts"),
    ],
    {
      cwd: import.meta.dir,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      serialization: "json",
      ipc(message: unknown) {
        messages.push(message);
      },
    },
  );
  await wrapper.stdin.write(
    `${JSON.stringify({ version: 1, command: [command, "exit-one"], cwd: import.meta.dir, env, timeoutMs: 2000 })}\n`,
  );
  await wrapper.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    wrapper.exited,
    new Response(wrapper.stdout).text(),
    new Response(wrapper.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("The owned interactive process could not complete.\n");
  expect(messages).toEqual([
    {
      kind: INTERACTIVE_BOOTSTRAP_CONTROL,
      version: 1,
      pid: expect.any(Number),
    },
    {
      kind: INTERACTIVE_BOOTSTRAP_TERMINAL,
      version: 1,
      pid: expect.any(Number),
      timedOut: false,
    },
  ]);
});
