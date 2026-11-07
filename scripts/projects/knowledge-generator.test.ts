import { expect, test } from "bun:test";
import type { Smith } from "../../types/hearth";
import type { SuperviseOptions } from "../executors/supervisor";
import {
  createKnowledgeGenerator,
  createKnowledgeOutput,
  KNOWLEDGE_CLAUDE_FLAGS,
} from "./knowledge-generator";
import { generatedKnowledgeSchema } from "./knowledge-protocol";
import type { KnowledgeSource } from "./knowledge-source";

const generated = {
  overview: {
    name: "alpha",
    description: "Observed source",
    purpose: "tooling",
    tech_stack: {
      runtime: "bun",
      framework: "unknown",
      language: "typescript",
      key_libraries: [],
    },
  },
  architecture: { structure: "src/", entry_points: [], key_components: [] },
  patterns: {
    error_handling: "unknown",
    state_management: "unknown",
    module_organization: "unknown",
    authentication: "unknown",
    testing: "unknown",
  },
  conventions: {
    commit_format: "unknown",
    branch_naming: "unknown",
    pr_requirements: [],
    coding_standards: [],
  },
  integration_points: { apis: [], shared_types: [], events: [] },
  key_files: [],
  recent_changes: [],
};
const session = "10000000-0000-4000-8000-000000000001";
const init = {
  type: "system",
  subtype: "init",
  session_id: session,
  claude_code_version: "3.0.0",
  tools: ["StructuredOutput"],
};
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  structured_output: generated,
};
const exit = { exitCode: 0, timedOut: false, stopped: false };
const evidence: KnowledgeSource = {
  version: 1,
  repositoryKey: "a".repeat(64),
  name: "alpha",
  sourceCommit: "b".repeat(40),
  evidenceHash: "c".repeat(64),
  files: [],
  structure: [],
  recentChanges: [],
  omitted: ["bounded evidence"],
};

test("tool-free knowledge output retains a whole validated document only after one matching successful result and settled exit", () => {
  const output = createKnowledgeOutput("alpha");
  output.line(JSON.stringify(init));
  output.line(
    JSON.stringify({
      type: "assistant",
      session_id: session,
      message: {
        content: [
          {
            type: "tool_use",
            name: "StructuredOutput",
            id: "out-1",
            input: generated,
          },
        ],
      },
    }),
  );
  output.line(
    JSON.stringify({
      type: "user",
      session_id: session,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "out-1", content: "accepted" },
        ],
      },
    }),
  );
  output.line(JSON.stringify(result));
  expect(output.finish(exit)).toEqual(
    generatedKnowledgeSchema.parse(generated),
  );
});

test("knowledge generation seals the selected native executable, disables discovery/tools, strips capabilities and consumes one prepared generation", async () => {
  const smith: Smith = {
    name: "fixture",
    provider: "claude",
    model: "exact-model",
    effort: "high",
    enabled: true,
    tags: [],
  };
  let identity = "native-identity",
    help = KNOWLEDGE_CLAUDE_FLAGS.join(" ");
  const calls: SuperviseOptions[] = [];
  const generator = createKnowledgeGenerator({
    root: "/served",
    operatorToken: () => "operator-secret",
    environment: {
      PATH: "/bin",
      AGENT_FORGE_HOME: "/private",
      TEST_SECRET: "operator-secret",
      NODE_OPTIONS: "--require=/foreign",
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "/foreign",
    },
    selection: () => ({
      smith,
      envPass: [
        "AGENT_FORGE_HOME",
        "TEST_SECRET",
        "NODE_OPTIONS",
        "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
      ],
    }),
    runtime: {
      executable: () => "/native/claude.exe",
      identity: () => identity,
      supervise: (options) => {
        calls.push(options);
        if (options.command.at(-1) === "--version")
          options.onLine("3.0.0 (Claude Code)");
        else if (options.command.at(-1) === "--help") options.onLine(help);
        else {
          options.onLine(JSON.stringify(init));
          options.onLine(JSON.stringify(result));
        }
        return {
          pid: 1,
          done: Promise.resolve({ ...exit, stderr: "" }),
          stop: async () => {},
        };
      },
    },
  });
  const ready = await generator.prepare("fixture");
  expect(await generator.generate(ready, evidence)).toEqual(generated);
  const run = calls[2];
  expect(run?.windowsHide).toBe(true);
  expect(run?.command).toContain("--bare");
  expect(run?.command).toContain("--restricted");
  expect(run?.command).toContain("--no-session-persistence");
  expect(run?.command[run.command.indexOf("--tools") + 1]).toBe("");
  expect(run?.command[run.command.indexOf("--mcp-config") + 1]).toBe(
    '{"mcpServers":{}}',
  );
  expect(run?.command).not.toContain("--resume");
  expect(run?.stdin).toContain("bounded evidence");
  for (const call of calls) {
    expect(call.windowsHide).toBe(true);
    expect(Object.values(call.env)).not.toContain("operator-secret");
    expect(call.env.AGENT_FORGE_HOME).toBeUndefined();
    expect(call.env.NODE_OPTIONS).toBeUndefined();
    expect(
      call.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD,
    ).toBeUndefined();
  }
  await expect(generator.generate(ready, evidence)).rejects.toThrow();
  expect(calls).toHaveLength(3);
  const changed = await generator.prepare("fixture");
  identity = "replaced";
  await expect(generator.generate(changed, evidence)).rejects.toThrow();
  expect(calls).toHaveLength(5);
  help = "--print";
  await expect(generator.prepare("fixture")).rejects.toThrow();
});

test("knowledge output refuses executable tools, mismatched identity, duplicate/failed results, invalid schema and interrupted children", () => {
  const sequences = [
    [{ ...init, tools: ["Read"] }, result],
    [
      init,
      {
        type: "assistant",
        session_id: session,
        message: {
          content: [{ type: "tool_use", name: "Bash", id: "x", input: {} }],
        },
      },
      result,
    ],
    [init, { ...result, session_id: "foreign" }],
    [init, result, result],
    [init, { ...result, is_error: true }],
    [
      init,
      {
        ...result,
        structured_output: { ...generated, outputPath: "/foreign" },
      },
    ],
    [
      init,
      {
        ...result,
        structured_output: {
          ...generated,
          overview: { ...generated.overview, name: "other" },
        },
      },
    ],
    [result],
  ];
  for (const sequence of sequences) {
    const output = createKnowledgeOutput("alpha");
    for (const event of sequence) output.line(JSON.stringify(event));
    expect(() => output.finish(exit)).toThrow();
  }
  const output = createKnowledgeOutput("alpha");
  output.line(JSON.stringify(init));
  output.line(JSON.stringify(result));
  expect(() => output.finish({ ...exit, timedOut: true })).toThrow();
  const malformed = createKnowledgeOutput("alpha");
  malformed.line("{invalid");
  expect(() => malformed.finish(exit)).toThrow();
});
