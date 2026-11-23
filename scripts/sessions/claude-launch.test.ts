import { expect, test } from "bun:test";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import { buildChildEnv } from "../executors/env";
import { supervise } from "../executors/supervisor";
import { serializeClaudeLaunch } from "./claude-launch";

const capabilities = {
  version: "2.1.296",
  flags: [
    "--print",
    "--input-format",
    "--output-format",
    "--verbose",
    "--include-partial-messages",
    "--model",
    "--effort",
    "--permission-mode",
    "--permission-prompts",
    "--allowedTools",
    "--resume",
    "--fallback-model",
    "--add-dir",
    "--max-budget-usd",
    "--json-schema",
  ],
  modelEfforts: { "claude-sonnet-5-5": ["low", "medium", "high"] },
} as const;

test("a task sends its private prompt on stdin and keeps the established coding permission policy", () => {
  const prompt = 'Private "question" & $literal %PATH%\nsecond line 🌱';
  const launch = serializeClaudeLaunch(
    { mode: "task", model: "claude-sonnet-5-5", prompt },
    capabilities,
  );
  expect(launch.stdin).toBe(prompt);
  expect(launch.inputFormat).toBe("text");
  expect(launch.argv).toContain("acceptEdits");
  expect(launch.argv).toContain("none");
  expect(launch.argv.join(" ")).not.toContain(prompt);
  expect(launch.equivalentCommand).not.toContain("Private");
  expect(launch.equivalentCommand).toContain("claude");
  expect(launch.stdinNote).toContain("stdin");
});

test("a subsequent chat turn resumes its exact UUID and preserves explicitly supported model and effort", () => {
  const id = "13a72c84-6c9d-438c-9160-6fdd19f92177";
  const launch = serializeClaudeLaunch(
    {
      mode: "chat",
      resumeSessionId: id,
      model: "claude-sonnet-5-5",
      effort: "high",
      prompt: "Second turn",
    },
    capabilities,
  );
  expect(launch.argv).toEqual(
    expect.arrayContaining([
      "--resume",
      id,
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "high",
    ]),
  );
  expect(launch.argv).not.toContain("--continue");
  expect(launch.argv).not.toContain("--session-id");
  expect(launch.requiredFlags).toContain("--resume");
  expect(() =>
    serializeClaudeLaunch(
      { mode: "task", model: "sonnet", prompt: "Task", resumeSessionId: id },
      capabilities,
    ),
  ).toThrow("Task");
  expect(() =>
    serializeClaudeLaunch(
      {
        mode: "chat",
        model: "sonnet",
        prompt: "Turn",
        resumeSessionId: "latest",
      },
      capabilities,
    ),
  ).toThrow("invalid");
  expect(() =>
    serializeClaudeLaunch(
      {
        mode: "chat",
        model: "claude-sonnet-5-5",
        effort: "high",
        prompt: "Turn",
      },
      { ...capabilities, modelEfforts: {} },
    ),
  ).toThrow("effort");
  expect(() =>
    serializeClaudeLaunch(
      {
        mode: "chat",
        model: "claude-sonnet-5-5",
        effort: "max",
        prompt: "Turn",
      },
      capabilities,
    ),
  ).toThrow("effort");
});

test("typed inline attachments and scope context become one private JSON-lines user message", () => {
  const image = "iVBORw0KGgo=";
  const launch = serializeClaudeLaunch(
    {
      mode: "chat",
      model: "sonnet",
      prompt: "Private image question",
      context: {
        projectId: "project-example",
        repository: "C:/private repo",
        worktree: "C:/private tree",
        beadId: "fixture-1",
        about: [{ kind: "bead", id: "fixture-1" }],
      },
      attachments: [
        { kind: "text", name: "private.txt", text: "Private attachment body" },
        {
          kind: "image",
          name: "private.png",
          mediaType: "image/png",
          data: image,
        },
      ],
    },
    capabilities,
  );
  expect(launch.inputFormat).toBe("stream-json");
  expect(launch.stdin.endsWith("\n")).toBe(true);
  let message: unknown;
  try {
    message = JSON.parse(launch.stdin);
  } catch {
    throw new Error("Invalid serialized input");
  }
  expect(message).toMatchObject({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: expect.arrayContaining([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: image },
        },
      ]),
    },
  });
  expect(launch.stdin).toContain("Private attachment body");
  expect(launch.stdin).toContain("project-example");
  expect(launch.argv.join(" ") + launch.equivalentCommand).not.toContain(
    "Private",
  );
  expect(launch.equivalentCommand).not.toContain("private");
});

test("supported task options and quoted paths share the argv serializer while private schema prose is redacted", () => {
  const request = {
    mode: "task",
    model: "claude-sonnet-5-5",
    effort: "high",
    prompt: "Task",
    permissionMode: "plan",
    fallbackModels: ["sonnet"],
    extraDirectories: ["C:/O'Brien/private directory"],
    maxBudgetUsd: 2.5,
    outputSchema: {
      type: "object",
      description: "Private schema prose",
      properties: { count: { type: "number" } },
    },
  } as const;
  const launch = serializeClaudeLaunch(
    {
      ...request,
      fallbackModels: [...request.fallbackModels],
      extraDirectories: [...request.extraDirectories],
    },
    {
      ...capabilities,
      modelEfforts: { ...capabilities.modelEfforts, sonnet: ["high"] },
    },
  );
  expect(launch.argv).toEqual(
    expect.arrayContaining([
      "--permission-mode",
      "plan",
      "--fallback-model",
      "sonnet",
      "--add-dir",
      "C:/O'Brien/private directory",
      "--max-budget-usd",
      "2.5",
      "--json-schema",
      JSON.stringify(request.outputSchema),
    ]),
  );
  expect(launch.equivalentCommand).toContain("'C:/O''Brien/private directory'");
  expect(launch.equivalentCommand).not.toContain("Private schema prose");
  expect(launch.stdinNote).toContain("schema");
  expect(() =>
    serializeClaudeLaunch(
      { ...request, mode: "chat", fallbackModels: [], extraDirectories: [] },
      capabilities,
    ),
  ).toThrow("Task");
  expect(() =>
    serializeClaudeLaunch(
      { mode: "task", model: "sonnet", prompt: "Task", maxBudgetUsd: 2 },
      {
        ...capabilities,
        flags: capabilities.flags.filter((flag) => flag !== "--max-budget-usd"),
      },
    ),
  ).toThrow("capability");
});

test("capability evidence and strict bounded inputs refuse forged modes, flags, files and unsupported efforts", () => {
  const valid = { mode: "task", model: "sonnet", prompt: "Task" };
  const invalid: unknown[] = [
    { ...valid, permissionMode: "bypassPermissions" },
    { ...valid, permissionMode: "dontAsk" },
    { ...valid, rawFlags: ["--dangerously-skip-permissions"] },
    { ...valid, allowedTools: ["Bash(*)"] },
    { ...valid, model: "--dangerously-skip-permissions" },
    { ...valid, prompt: "" },
    { ...valid, prompt: "x".repeat(16_385) },
    { ...valid, prompt: "nul\0" },
    { ...valid, extraDirectories: ["--permission-mode=bypassPermissions"] },
    { ...valid, attachments: [{ kind: "path", path: "C:/secret.txt" }] },
    {
      ...valid,
      attachments: [
        {
          kind: "image",
          name: "bad",
          mediaType: "image/svg+xml",
          data: "PHN2Zz4=",
        },
      ],
    },
    {
      ...valid,
      attachments: [
        {
          kind: "image",
          name: "bad",
          mediaType: "image/png",
          data: "not base64",
        },
      ],
    },
    { ...valid, maxBudgetUsd: Number.POSITIVE_INFINITY },
    { ...valid, maxBudgetUsd: 0 },
    { ...valid, outputSchema: { description: "x".repeat(16_385) } },
  ];
  const serializeUnknown = (request: unknown) =>
    Reflect.apply(serializeClaudeLaunch, undefined, [request, capabilities]);
  for (const request of invalid)
    expect(() => serializeUnknown(request)).toThrow("invalid");
  expect(() =>
    serializeClaudeLaunch(
      { ...valid, mode: "task" },
      { version: "not-a-version", flags: capabilities.flags },
    ),
  ).toThrow("capability");
  expect(() =>
    serializeClaudeLaunch(
      { mode: "task", model: "constructor", effort: "low", prompt: "Task" },
      capabilities,
    ),
  ).toThrow("effort");
  const oversized: ClaudeSessionLaunch = {
    mode: "task",
    model: "sonnet",
    prompt: "Task",
    attachments: Array.from({ length: 8 }, () => ({
      kind: "text",
      name: "large.txt",
      text: "\n".repeat(524_288),
    })),
  };
  expect(() => serializeClaudeLaunch(oversized, capabilities)).toThrow("8 MiB");
  expect(() =>
    serializeClaudeLaunch(
      {
        mode: "task",
        model: "sonnet",
        prompt: "Task",
        outputSchema: {
          properties: {
            one: { description: "x".repeat(10_000) },
            two: { description: "x".repeat(10_000) },
          },
        },
      },
      capabilities,
    ),
  ).toThrow("argument limit");
});

test("the serialized request survives actual supervised argv/stdin pipes with filtered environment", async () => {
  const launch = serializeClaudeLaunch(
    {
      mode: "chat",
      model: "sonnet",
      prompt: 'Private "quotes" & $(literal) %PATH%\n🌱',
      attachments: [
        { kind: "text", name: "private.txt", text: "attachment\nbody" },
      ],
    },
    capabilities,
  );
  let observed: unknown;
  const child = supervise({
    command: [
      process.execPath,
      `${import.meta.dir}/fixtures/launch-cli.ts`,
      ...launch.argv,
    ],
    cwd: import.meta.dir,
    env: buildChildEnv(
      { PATH: process.env.PATH, FORBIDDEN_SESSION_SECRET: "synthetic-only" },
      [],
    ),
    stdin: launch.stdin,
    timeoutMs: 5000,
    onLine(line) {
      try {
        observed = JSON.parse(line);
      } catch {
        throw new Error("Invalid fake launch recording");
      }
    },
  });
  const exit = await child.done;
  expect(exit.exitCode).toBe(0);
  expect(exit.timedOut).toBe(false);
  expect(observed).toEqual({
    argv: launch.argv,
    stdin: launch.stdin,
    secretPresent: false,
  });
}, 10_000);
