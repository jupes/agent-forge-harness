import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildContextPack } from "./context";
import { runCouncil } from "./engine";
import { createCouncilMcpServer } from "./mcp";
import { type CommandRunner, compilePullRequest } from "./pr-source";
import {
  assertProvidersReady,
  createProviderResolver,
  providerReadiness,
} from "./providers";
import {
  type CouncilProfile,
  type ModelRequest,
  parseCouncilProfileJson,
} from "./types";

const tempRoots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `council-integration-${label}-`));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function multiProviderProfile(): CouncilProfile {
  const parsed = parseCouncilProfileJson(
    readFileSync(
      resolve(process.cwd(), "councils", "multi-provider.example.json"),
      "utf8",
    ),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const INDEPENDENT_OUTPUT = {
  verdict: "needs_changes",
  findings: [
    {
      localId: "F1",
      title: "Unsupported benchmark",
      severity: "medium",
      claim: "The benchmark lacks a reproducible source.",
      consequence: "The decision may rely on an invalid comparison.",
      evidenceIds: ["E1"],
      confidence: 0.8,
    },
  ],
  strengths: [],
  unknowns: [],
};

function promptFromBody(body: Record<string, unknown>): string {
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.messages)) {
    const message = body.messages.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as Record<string, unknown>).role === "user",
    );
    if (
      message &&
      typeof (message as Record<string, unknown>).content === "string"
    ) {
      return (message as Record<string, unknown>).content as string;
    }
  }
  return "";
}

function outputForPrompt(prompt: string): Record<string, unknown> {
  if (prompt.includes("Challenge the anonymous")) {
    const candidateIds = [
      ...new Set(
        [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].map(
          (match) => match[1]!,
        ),
      ),
    ];
    return {
      ballots: candidateIds.map((candidateId) => ({
        candidateId,
        stance: "support",
        reason: "The evidence supports this candidate.",
        evidenceIds: ["E1"],
        suggestedSeverity: null,
      })),
      missingFindings: [],
    };
  }
  if (prompt.includes("Produce the final council review")) {
    const keys = [
      ...new Set(
        [...prompt.matchAll(/"key":"([a-f0-9]+)"/g)].map((match) => match[1]!),
      ),
    ];
    return {
      verdict: "needs_changes",
      summary: "The providers reached an evidence-backed consensus.",
      recommendations: ["Add a reproducible benchmark source."],
      consensusFindingKeys: keys,
      dissentFindingKeys: [],
    };
  }
  return INDEPENDENT_OUTPUT;
}

describe("multi-provider transports", () => {
  test("runs one council across OpenAI, Anthropic, DeepSeek, and Qwen", async () => {
    const profile = multiProviderProfile();
    profile.depth = "balanced";
    const environment = {
      OPENAI_API_KEY: "openai-test-key",
      ANTHROPIC_API_KEY: "anthropic-test-key",
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DASHSCOPE_API_KEY: "qwen-test-key",
      OPENAI_BASE_URL: "https://openai.example/v1",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      DEEPSEEK_BASE_URL: "https://deepseek.example",
      QWEN_BASE_URL: "https://qwen.example/v1",
    };
    const requests: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const mockFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, headers: new Headers(init?.headers), body });
      const output = outputForPrompt(promptFromBody(body));
      if (url.endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                content: [
                  { type: "output_text", text: JSON.stringify(output) },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
        );
      }
      if (url.endsWith("/v1/messages")) {
        return new Response(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(output) }],
            usage: { input_tokens: 11, output_tokens: 21 },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(output) },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 22 },
        }),
      );
    }) as typeof fetch;

    assertProvidersReady(profile, environment);
    const result = await runCouncil({
      profile,
      context: buildContextPack({ kind: "stdin", text: "Review this plan." }),
      resolveTransport: createProviderResolver({
        environment,
        fetchImpl: mockFetch,
      }),
      runId: "mixed-provider-run",
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(9);
    expect(
      new Set(result.run.records.map((record) => record.provider)),
    ).toEqual(new Set(["openai", "anthropic", "deepseek", "qwen"]));
    expect(result.run.aggregatedFindings[0]?.support).toBe(4);
    expect(requests.some((request) => request.url.endsWith("/responses"))).toBe(
      true,
    );
    expect(
      requests.some((request) => request.url.endsWith("/v1/messages")),
    ).toBe(true);
    expect(
      requests.filter((request) => request.url.endsWith("/chat/completions")),
    ).toHaveLength(4);
    expect(
      requests
        .find((request) => request.url.endsWith("/responses"))
        ?.headers.get("authorization"),
    ).toBe("Bearer openai-test-key");
    expect(
      requests
        .find((request) => request.url.endsWith("/v1/messages"))
        ?.headers.get("x-api-key"),
    ).toBe("anthropic-test-key");
    expect(
      requests
        .find((request) => request.url.startsWith("https://deepseek.example"))
        ?.headers.get("authorization"),
    ).toBe("Bearer deepseek-test-key");
    expect(
      requests
        .find((request) => request.url.startsWith("https://qwen.example"))
        ?.headers.get("authorization"),
    ).toBe("Bearer qwen-test-key");
    for (const request of requests) {
      const serializedBody = JSON.stringify(request.body);
      for (const key of Object.values(environment).filter((value) =>
        value.endsWith("-key"),
      )) {
        expect(serializedBody).not.toContain(key);
      }
    }
  });

  test("reports only missing variable names and redacts echoed secrets", async () => {
    const profile = multiProviderProfile();
    const readiness = providerReadiness(profile, {});
    expect(
      readiness.find((entry) => entry.provider === "openai")?.missing,
    ).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(readiness)).not.toContain("sk-");

    const unsupported = providerReadiness(
      {
        ...profile,
        seats: [{ ...profile.seats[0]!, provider: "unknown-provider" }],
      },
      {},
    ).find((entry) => entry.provider === "unknown-provider");
    expect(unsupported?.missing).toEqual([]);
    expect(unsupported?.error).toBe("unsupported provider");

    const secret = "unusual.provider.key.value.123456789";
    const transport = createProviderResolver({
      environment: { OPENAI_API_KEY: secret },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: { message: `bad key ${secret}` } }),
          {
            status: 401,
          },
        )) as unknown as typeof fetch,
    })(profile.seats[0]!);
    const request: ModelRequest = {
      runId: "provider-error",
      stage: "independent",
      seat: profile.seats[0]!,
      system: "Return JSON.",
      prompt: "Review.",
      context: buildContextPack({ kind: "stdin", text: "Review." }),
    };
    try {
      await transport.generate(request, new AbortController().signal);
      throw new Error("expected provider call to fail");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("[REDACTED:provider-api-key]");
    }

    expect(() =>
      createProviderResolver({
        environment: {
          OPENAI_API_KEY: secret,
          OPENAI_BASE_URL: "http://provider.example/v1",
        },
      })(profile.seats[0]!),
    ).toThrow("HTTPS or local HTTP");
  });
});

describe("PR source compilation", () => {
  test("records immutable refs, diff omissions, files, and linked acceptance criteria", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      if (command[0] === "bd") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              acceptance_criteria: "The council can review a pull request.",
            },
          ]),
          stderr: "",
        };
      }
      if (command.includes("view")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/example/repo/pull/42",
            title: "Add review councils",
            body: "Refs: agent-forge-harness-t1b1.3",
            baseRefName: "master",
            baseRefOid: "base-sha",
            headRefName: "feat/council",
            headRefOid: "head-sha",
            additions: 100,
            deletions: 5,
            changedFiles: 1,
            files: [{ path: "src/council.ts", additions: 100, deletions: 5 }],
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: "diff --git a/src/council.ts b/src/council.ts\n+new line\n",
        stderr: "",
      };
    };

    const compiled = await compilePullRequest("42", {
      cwd: process.cwd(),
      maxDiffBytes: 20,
      runner,
    });
    expect(compiled.metadata.baseSha).toBe("base-sha");
    expect(compiled.metadata.headSha).toBe("head-sha");
    expect(compiled.metadata.diffTruncated).toBe(true);
    expect(compiled.metadata.includedFiles).toEqual(["src/council.ts"]);
    expect(compiled.text).toContain("The council can review a pull request.");
    expect(compiled.text).toContain("Diff truncated at 20 UTF-8 bytes.");
    expect(calls.map((call) => call[0])).toEqual(["gh", "gh", "gh", "bd"]);
  });

  test("rejects unsafe references before invoking local tools", async () => {
    let called = false;
    const runner: CommandRunner = async () => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(
      compilePullRequest("branch; remove everything", { runner }),
    ).rejects.toThrow("PR reference");
    await expect(
      compilePullRequest("http://github.com/example/repo/pull/42", { runner }),
    ).rejects.toThrow("PR reference");
    expect(called).toBe(false);
  });
});

describe("MCP facade", () => {
  test("discovers readiness, review, and replay tools over MCP", async () => {
    const root = tempRoot("mcp");
    const runsRoot = join(root, "runs");
    const server = createCouncilMcpServer({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot,
    });
    const client = new Client({
      name: "council-test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "council_cancel",
        "council_list",
        "council_profiles",
        "council_readiness",
        "council_replay",
        "council_review",
        "council_start",
        "council_status",
      ]);
      expect(JSON.stringify(tools)).not.toMatch(/api.?key/i);

      const readiness = await client.callTool({
        name: "council_readiness",
        arguments: {},
      });
      expect(readiness.isError).not.toBe(true);
      expect(JSON.stringify(readiness.structuredContent)).toContain(
        '"provider":"fake"',
      );

      const review = await client.callTool({
        name: "council_review",
        arguments: {
          sourceType: "text",
          source: "Review this locally supplied architecture note.",
          runId: "mcp-review",
        },
      });
      expect(review.isError).not.toBe(true);
      expect(JSON.stringify(review.structuredContent)).toContain(
        '"runId":"mcp-review"',
      );

      const replay = await client.callTool({
        name: "council_replay",
        arguments: { runId: "mcp-review" },
      });
      expect(replay.isError).not.toBe(true);
      expect(JSON.stringify(replay.structuredContent)).toContain(
        '"status":"completed"',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
