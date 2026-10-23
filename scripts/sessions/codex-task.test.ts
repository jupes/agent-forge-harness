import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  CodexExecPrivateEvent,
  CodexTaskLaunch,
} from "../../types/codex-task";
import { buildChildEnv } from "../executors/env";
import { supervise } from "../executors/supervisor";
import {
  CODEX_EXEC_STREAM_LIMITS,
  createCodexExecParser,
} from "./codex-exec-stream";
import {
  codexExecCapabilitiesSchema,
  codexTaskLaunchSchema,
  serializeCodexTask,
} from "./codex-task";

const capabilities = {
  version: "0.163.0-alpha.10.2",
  flags: ["--json", "--color", "--sandbox", "--model", "--cd", "--config"],
} as const;
const task: CodexTaskLaunch = {
  mode: "task",
  cwd: "C:/repo",
  model: "gpt-example-exact",
  sandbox: "read-only",
  approvalPolicy: "never",
  prompt: "Do the task",
};

test("a Task preserves private stdin and emits explicit supported execution options", () => {
  const prompt = '  Private "question" & $literal %PATH%\nsecond line 🌱\n';
  const launch = serializeCodexTask(
    {
      mode: "task",
      cwd: "C:/repo/owner's checkout",
      model: "gpt-example-exact",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      prompt,
    },
    capabilities,
  );
  expect(launch.argv).toEqual([
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--model",
    "gpt-example-exact",
    "--cd",
    "C:/repo/owner's checkout",
    "--config",
    'approval_policy="never"',
    "-",
  ]);
  expect(launch.stdin).toBe(prompt);
  expect(launch.inputFormat).toBe("text");
  expect(launch.argv.join(" ")).not.toContain("Private");
  expect(launch.equivalentCommand).not.toContain("Private");
  expect(launch.equivalentCommand.startsWith("& 'codex' 'exec'")).toBe(true);
  expect(launch.equivalentCommand).toContain("'C:/repo/owner''s checkout'");
  expect(launch.stdinNote).toContain("private stdin");
  expect(launch.requiredFlags).toEqual([...capabilities.flags]);
});

test("effort requires separately sourced exact-model and CLI-version evidence without dropping the request", () => {
  const evidence = {
    model: task.model,
    efforts: ["future_effort"],
    source: "model/list",
    cliVersion: capabilities.version,
    asOf: "2026-10-22T10:00:00.000Z",
  } as const;
  const supported = { ...capabilities, modelEfforts: [evidence] };
  const requested = { ...task, effort: "future_effort" };
  expect(serializeCodexTask(requested, supported).argv).toContain(
    'model_reasoning_effort="future_effort"',
  );
  expect(serializeCodexTask(task, supported).argv.join(" ")).not.toContain(
    "model_reasoning_effort",
  );
  for (const available of [
    capabilities,
    {
      ...capabilities,
      modelEfforts: [{ ...evidence, model: "gpt-example-alias" }],
    },
    { ...capabilities, modelEfforts: [{ ...evidence, cliVersion: "0.162.0" }] },
    { ...capabilities, modelEfforts: [{ ...evidence, efforts: ["high"] }] },
  ])
    expect(() => serializeCodexTask(requested, available)).toThrow("effort");
  expect(() =>
    serializeCodexTask(requested, {
      ...capabilities,
      modelEfforts: [evidence, evidence],
    }),
  ).toThrow();
});

test("bounded text attachments and context travel only in canonical private stdin", () => {
  const data = {
    context: {
      projectId: "private-project",
      repository: "C:/repo",
      worktree: "C:/repo",
      beadId: "private-bead",
      about: [{ kind: "bead", id: "private-about" }],
    },
    attachments: [
      {
        kind: "text",
        name: "notes.txt",
        text: 'Private attachment \"body\"\n🌱',
      },
    ],
  } as const;
  const result = serializeCodexTask({ ...task, ...data }, capabilities);
  expect(result.stdin).toBe(
    `${task.prompt}\n\n<agent-forge-task-data>\n${JSON.stringify(data)}\n</agent-forge-task-data>`,
  );
  expect(result.argv.join(" ")).not.toContain("private-project");
  expect(result.equivalentCommand).not.toContain("Private attachment");
  expect(result.equivalentCommand).not.toContain("private-about");
  expect(() =>
    serializeCodexTask(
      {
        ...task,
        attachments: Array.from({ length: 8 }, () => ({
          kind: "text",
          name: "large",
          text: "🌱".repeat(262_144),
        })),
      },
      capabilities,
    ),
  ).toThrow("stdin");
});

test("Task policy refuses unsupported modes, file staging, extra options and missing flag evidence", () => {
  for (const change of [
    { mode: "chat" },
    { resumeSessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    { sandbox: "danger-full-access" },
    { approvalPolicy: "on-request" },
    { flags: ["--full-auto"] },
    { config: { approval_policy: "never" } },
    { outputSchema: {} },
    { outputSchemaPath: "C:/secret/schema.json" },
    { attachments: [{ kind: "image", path: "C:/secret/image.png" }] },
    { cwd: "relative" },
    { cwd: "C:/repo/../foreign" },
    { cwd: "C:/repo\nextra" },
    { prompt: " \n " },
    { prompt: "bad\0prompt" },
    { prompt: "bad\ud800" },
    { model: "gpt-example --full-auto" },
    { prompt: "x".repeat(16_385) },
  ])
    expect(
      codexTaskLaunchSchema.safeParse({ ...task, ...change }).success,
    ).toBe(false);
  for (const flag of capabilities.flags)
    expect(() =>
      serializeCodexTask(task, {
        ...capabilities,
        flags: capabilities.flags.filter((value) => value !== flag),
      }),
    ).toThrow(flag);
  expect(
    codexExecCapabilitiesSchema.safeParse({
      ...capabilities,
      modelEfforts: [
        {
          model: task.model,
          efforts: ["high"],
          source: "help",
          cliVersion: capabilities.version,
          asOf: "2026-10-22T10:00:00.000Z",
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    serializeCodexTask({ ...task, cwd: "/workspace/repo" }, capabilities).argv,
  ).toContain("/workspace/repo");
  expect(
    serializeCodexTask(
      { ...task, cwd: "\\\\server\\share\\repo" },
      capabilities,
    ).argv,
  ).toContain("\\\\server\\share\\repo");
});

test("a supervised native fake receives exactly serialized argv/stdin and a filtered environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-task-pipes-"));
  const capture = join(directory, "capture.json");
  try {
    const launch = serializeCodexTask(
      {
        ...task,
        cwd: directory,
        prompt: 'Private "quotes" & $(literal) %PATH%\n🌱',
      },
      capabilities,
    );
    for (const mode of ["normal", "exit-after-result"]) {
      const parser = createCodexExecParser({ version: capabilities.version });
      const events: CodexExecPrivateEvent[] = [];
      const child = supervise({
        command: [
          process.execPath,
          resolve(import.meta.dir, "fixtures/codex-task-cli.ts"),
          ...launch.argv,
        ],
        cwd: directory,
        env: buildChildEnv(
          {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            CODEX_TASK_FIXTURE_CAPTURE: capture,
            CODEX_TASK_FIXTURE_MODE: mode,
            TEST_OPERATOR_SECRET: "synthetic-secret-only",
          },
          ["CODEX_TASK_FIXTURE_CAPTURE", "CODEX_TASK_FIXTURE_MODE"],
        ),
        stdin: launch.stdin,
        timeoutMs: 5000,
        maxLineBytes: CODEX_EXEC_STREAM_LIMITS.lineBytes,
        onLine: (packet) => events.push(...parser.line(packet)),
      });
      const status = await child.done;
      expect(status.timedOut).toBe(false);
      expect(status.exitCode).toBe(mode === "normal" ? 0 : 7);
      expect(parser.finish(status).phase).toBe(
        mode === "normal" ? "completed" : "unknown",
      );
      expect(events.filter((event) => event.kind === "text")).toEqual([
        { kind: "text", itemId: "reply", text: "Fixture private reply 🌱" },
      ]);
      let recorded: unknown;
      try {
        recorded = JSON.parse(await readFile(capture, "utf8"));
      } catch {
        throw new Error(
          "The supervised fake did not record valid private input.",
        );
      }
      const observed = z
        .object({
          argv: z.array(z.string()),
          stdin: z.string(),
          cwd: z.string(),
          secretPresent: z.boolean(),
        })
        .strict()
        .parse(recorded);
      expect(observed).toEqual({
        argv: launch.argv,
        stdin: launch.stdin,
        cwd: directory,
        secretPresent: false,
      });
    }
  } finally {
    await rm(capture, { force: true });
    await rmdir(directory);
  }
}, 15_000);

test("the launch module loads with native CSP and no Node Buffer", async () => {
  const source = `
    globalThis.window = {};
    globalThis.Buffer = undefined;
    globalThis.Function = function () { throw new Error("unsafe-eval is forbidden"); };
    const { serializeCodexTask } = await import(${JSON.stringify(resolve(import.meta.dir, "codex-task.ts"))});
    const value = serializeCodexTask(${JSON.stringify(task)}, ${JSON.stringify(capabilities)});
    console.log(value.stdin === ${JSON.stringify(task.prompt)} && value.argv.includes("exec"));
  `;
  let output = "";
  const child = supervise({
    command: [process.execPath, "-e", source],
    cwd: import.meta.dir,
    env: buildChildEnv(
      { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      [],
    ),
    timeoutMs: 5000,
    maxLineBytes: 1024,
    onLine: (packet) => {
      output += packet;
    },
  });
  const status = await child.done;
  expect(status.stderr).toBe("");
  expect(status.exitCode).toBe(0);
  expect(status.timedOut).toBe(false);
  expect(output.trim()).toBe("true");
}, 10_000);
