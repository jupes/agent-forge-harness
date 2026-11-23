import { expect, test } from "bun:test";
import type { GeminiTaskLaunch } from "../../types/gemini-task";
import { geminiTaskLaunchSchema, serializeGeminiTask } from "./gemini-task";

const launch: GeminiTaskLaunch = {
  route: "gemini-cli",
  mode: "task",
  cwd: "C:\\fixture\\checkout",
  prompt: 'Private "quotes" & $(literal) %PATH%\n🌱',
};
const capabilities = {
  version: "0.65.0",
  flags: [
    "--output-format",
    "--model",
    "--approval-mode",
    "--sandbox",
    "--policy",
    "--include-directories",
  ],
};

test("Gemini Task keeps private text on stdin and preserves untouched CLI defaults in the exact argv preview", () => {
  const result = serializeGeminiTask(launch, capabilities);
  expect(result.argv).toEqual(["--output-format", "stream-json"]);
  expect(result.stdin).toBe(launch.prompt);
  expect(result.argv.join(" ")).not.toContain("Private");
  expect(result.equivalentCommand).toBe(
    "& 'gemini' '--output-format' 'stream-json'",
  );
  expect(result.inputFormat).toBe("text");
  expect(result.requiredFlags).toEqual(["--output-format"]);
});

test("Gemini-specific options retain exact spelling and inline context without inventing effort or output-schema flags", () => {
  const input: GeminiTaskLaunch = {
    ...launch,
    model: "gemini-exact-example",
    approvalMode: "plan",
    sandbox: true,
    policyFiles: ["C:/fixture/owner's policy.toml"],
    includeDirectories: ["C:/fixture/related"],
    context: {
      projectId: "project-example",
      repository: launch.cwd,
      worktree: launch.cwd,
      beadId: "alpha-1",
    },
    attachments: [
      { kind: "text", name: "Literal @file", text: "Private attachment 🌱" },
    ],
  };
  const result = serializeGeminiTask(input, capabilities);
  expect(result.argv).toEqual([
    "--output-format",
    "stream-json",
    "--model",
    "gemini-exact-example",
    "--approval-mode",
    "plan",
    "--sandbox",
    "--policy",
    "C:/fixture/owner's policy.toml",
    "--include-directories",
    "C:/fixture/related",
  ]);
  expect(result.stdin).toBe(
    `${launch.prompt}\n\n<agent-forge-task-data>\n${JSON.stringify({ context: input.context, attachments: input.attachments }).replaceAll("@", "\\u0040")}\n</agent-forge-task-data>`,
  );
  expect(result.equivalentCommand).toContain(
    "'C:/fixture/owner''s policy.toml'",
  );
  expect(result.equivalentCommand).not.toContain("Private");
  expect(result.argv).not.toContain("--effort");
  expect(result.requiredFlags).toEqual([
    "--output-format",
    "--model",
    "--approval-mode",
    "--sandbox",
    "--policy",
    "--include-directories",
  ]);
});

test("inline data does not trigger Gemini's native @path expansion and still decodes to the original text", () => {
  const attachments = [
    {
      kind: "text",
      name: "@private-file",
      text: "literal @another-file and owner@example.test",
    },
  ] as const;
  const result = serializeGeminiTask({ ...launch, attachments }, capabilities);
  const encoded = result.stdin
    .split("<agent-forge-task-data>\n")[1]
    ?.split("\n</agent-forge-task-data>")[0];
  expect(encoded).not.toContain("@");
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded ?? "");
  } catch {
    throw Error("Invalid inline JSON");
  }
  expect(decoded).toEqual({ attachments });
  expect(result.stdin.startsWith(launch.prompt)).toBe(true);
});

test("Task serialization refuses unverified versions and missing native flags instead of silently dropping requested options", () => {
  expect(() =>
    serializeGeminiTask(launch, { ...capabilities, flags: [] }),
  ).toThrow();
  expect(() =>
    serializeGeminiTask(launch, { ...capabilities, version: "0.64.0" }),
  ).toThrow();
  expect(() =>
    serializeGeminiTask(launch, { ...capabilities, version: "1.0.0" }),
  ).toThrow();
  for (const [field, value, flag] of [
    ["model", "gemini-example", "--model"],
    ["approvalMode", "plan", "--approval-mode"],
    ["sandbox", false, "--sandbox"],
    ["policyFiles", ["C:/fixture/policy.toml"], "--policy"],
    ["includeDirectories", ["C:/fixture/extra"], "--include-directories"],
  ] as const) {
    expect(() =>
      serializeGeminiTask(
        { ...launch, [field]: value },
        {
          ...capabilities,
          flags: capabilities.flags.filter((item) => item !== flag),
        },
      ),
    ).toThrow();
  }
  expect(
    serializeGeminiTask({ ...launch, sandbox: false }, capabilities).argv,
  ).toEqual(["--output-format", "stream-json", "--sandbox=false"]);
});

test("the private Gemini request refuses bypasses, foreign routes, unsafe paths, malformed text and unknown options", () => {
  for (const request of [
    { ...launch, route: "antigravity" },
    { ...launch, mode: "chat" },
    { ...launch, approvalMode: "yolo" },
    { ...launch, skipTrust: true },
    { ...launch, effort: "high" },
    { ...launch, outputSchema: "{}" },
    { ...launch, cwd: "relative/checkout" },
    { ...launch, cwd: "C:/fixture/../foreign" },
    { ...launch, model: "--dangerous-option" },
    { ...launch, policyFiles: ["relative-policy.toml"] },
    { ...launch, includeDirectories: ["C:/fixture/../foreign"] },
    { ...launch, prompt: "  \n" },
    { ...launch, prompt: "bad\0text" },
    { ...launch, prompt: "bad\uD800text" },
    { ...launch, attachments: [{ kind: "image", name: "image", text: "{}" }] },
    {
      ...launch,
      attachments: [{ kind: "text", name: "bad\nname", text: "content" }],
    },
    {
      ...launch,
      context: {
        projectId: "p",
        repository: launch.cwd,
        worktree: launch.cwd,
        token: "private",
      },
    },
  ])
    expect(geminiTaskLaunchSchema.safeParse(request).success).toBe(false);
});

test("the complete private stdin has a byte bound, including inline attachments and Unicode", () => {
  const maximum = 2_097_152;
  expect(
    serializeGeminiTask(
      { ...launch, prompt: "a".repeat(maximum) },
      capabilities,
    ).stdin.length,
  ).toBe(maximum);
  expect(() => {
    serializeGeminiTask(
      { ...launch, prompt: "a".repeat(maximum + 1) },
      capabilities,
    );
  }).toThrow();
  expect(() => {
    serializeGeminiTask(
      { ...launch, prompt: "🌱".repeat(maximum / 4 + 1) },
      capabilities,
    );
  }).toThrow();
  expect(() => {
    serializeGeminiTask(
      {
        ...launch,
        prompt: "a".repeat(maximum - 5),
        attachments: [{ kind: "text", name: "note", text: "attachment" }],
      },
      capabilities,
    );
  }).toThrow();
});
