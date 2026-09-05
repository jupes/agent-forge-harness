import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  assertCouncilRunId,
  readCouncilRun,
  reserveCouncilRun,
  writeCouncilArtifacts,
} from "./artifacts";
import { buildContextPack, renderContextForPrompt } from "./context";
import { FakeCouncilTransport } from "./engine";
import { createCouncilMcpServer } from "./mcp";
import { type CommandRunner, compilePullRequest } from "./pr-source";
import { createCouncilService } from "./service";

const temporary: string[] = [];
function temp() {
  const path = mkdtempSync(join(tmpdir(), "council-safety-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function service(root: string, delayMs = 1) {
  return createCouncilService({
    workspaceRoot: root,
    harnessRoot: process.cwd(),
    runsRoot: join(root, "runs"),
    resolveTransport: () => () => new FakeCouncilTransport({ delayMs }),
  });
}

describe("artifact ownership", () => {
  test("rejects traversal, reserved names, collisions, and junctions before dispatch", async () => {
    const root = temp(),
      council = service(root, 20);
    try {
      for (const id of [
        ".",
        "..",
        "../escape",
        "CON",
        "name.",
        "x".repeat(121),
      ])
        expect(() => assertCouncilRunId(id)).toThrow();
      expect(() =>
        council.start({ sourceType: "text", source: "review", runId: ".." }),
      ).toThrow();
      expect(existsSync(join(root, "manifest.json"))).toBe(false);
      const first = council.start({
        sourceType: "text",
        source: "first input",
        runId: "stable-id",
      });
      expect(() =>
        council.start({
          sourceType: "text",
          source: "second input",
          runId: "stable-id",
        }),
      ).toThrow("already exists");
      await council.wait(first.runId);
      expect(() =>
        council.start({
          sourceType: "text",
          source: "second input",
          runId: "stable-id",
        }),
      ).toThrow("already exists");
      const target = temp();
      symlinkSync(
        target,
        join(root, "runs", "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() => reserveCouncilRun("linked", join(root, "runs"))).toThrow();
      expect(() => readCouncilRun("linked", join(root, "runs"))).toThrow(
        "inside",
      );
    } finally {
      await council.close();
    }
  });

  test("bare replay IDs use only their configured root and preserve first manifest", async () => {
    const root = temp(),
      council = service(root);
    try {
      const started = council.start({
        sourceType: "text",
        source: "correct source",
        runId: "shadow",
      });
      const result = await council.wait(started.runId);
      if (!result.run) throw new Error("missing run");
      const first = readFileSync(result.artifacts!.manifest, "utf8");
      expect(() =>
        writeCouncilArtifacts(result.run!, join(root, "runs")),
      ).toThrow("already exists");
      expect(readFileSync(result.artifacts!.manifest, "utf8")).toBe(first);
      mkdirSync(join(root, "shadow"));
      writeFileSync(
        join(root, "shadow", "manifest.json"),
        JSON.stringify({ ...result.run, runId: "wrong-run" }),
      );
      const original = process.cwd();
      try {
        process.chdir(root);
        expect(readCouncilRun("shadow", join(root, "runs")).runId).toBe(
          "shadow",
        );
      } finally {
        process.chdir(original);
      }
      expect(council.get("shadow").status).toBe("completed");
    } finally {
      await council.close();
    }
  });
});

describe("context confidentiality", () => {
  test("redacts labels, metadata, filenames, and rendered prompts as well as body", () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    const input = {
      kind: "pr" as const,
      text: `Title ${secret}`,
      displayName: `PR #42: ${secret}`,
      locator: `https://example.com/${secret}`,
      metadata: { files: [secret], title: secret },
    };
    expect(() => buildContextPack(input)).toThrow("potential secrets");
    const packed = buildContextPack({ ...input, secretPolicy: "redact" });
    expect(JSON.stringify(packed)).not.toContain(secret);
    expect(renderContextForPrompt(packed)).not.toContain(secret);
    expect(renderContextForPrompt(packed)).toContain("1: Title");
  });
});

function prRunner(
  options: { changed?: boolean; bdMissing?: boolean } = {},
): CommandRunner {
  let views = 0;
  return async (command) => {
    if (command[0] === "bd") {
      if (options.bdMissing) throw new Error("spawn bd ENOENT");
      return {
        exitCode: 0,
        stdout: '[{"acceptance_criteria":"Safe review"}]',
        stderr: "",
      };
    }
    if (command.includes("view")) {
      views++;
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/example/repo/pull/42",
          title: "Review",
          body: "Refs: agent-forge-harness-t1b1.3",
          baseRefName: "master",
          baseRefOid: "base",
          headRefName: "feature",
          headRefOid: options.changed && views > 1 ? "changed" : "head",
          additions: 4,
          deletions: 0,
          changedFiles: 4,
          files: [".env", "renamed.md", "src/okay.ts", "credentials.pem"].map(
            (path) => ({ path, additions: 1, deletions: 0 }),
          ),
        }),
      };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: [
        "diff --git a/.env b/.env",
        "--- a/.env",
        "+++ b/.env",
        "@@ -0,0 +1 @@",
        "+DATABASE_PASSWORD=synthetic-env-secret",
        "diff --git a/.env.production b/renamed.md",
        "--- a/.env.production",
        "+++ b/renamed.md",
        "@@ -0,0 +1 @@",
        "+DATABASE_PASSWORD=synthetic-renamed-secret",
        "diff --git a/credentials.pem b/credentials.pem",
        "+synthetic-private-file",
        "diff --git a/src/okay.ts b/src/okay.ts",
        "--- a/src/okay.ts",
        "+++ b/src/okay.ts",
        "@@ -0,0 +1 @@",
        "+const okay = true;",
        "",
      ].join("\n"),
    };
  };
}

describe("PR snapshot safety", () => {
  test("omits credential files and renamed secrets while tolerating missing optional Beads", async () => {
    const compiled = await compilePullRequest("42", {
      runner: prRunner({ bdMissing: true }),
    });
    expect(compiled.text).not.toContain("synthetic-env-secret");
    expect(compiled.text).not.toContain("synthetic-renamed-secret");
    expect(compiled.text).not.toContain("synthetic-private-file");
    expect(compiled.text).toContain("const okay = true");
    expect(compiled.metadata.includedFiles).toEqual(["src/okay.ts"]);
    expect(compiled.text).toContain("Acceptance criteria unavailable");
    expect(compiled.text).toContain("Sensitive file excluded");
  });
  test("rejects a PR changing during capture", async () => {
    await expect(
      compilePullRequest("42", { runner: prRunner({ changed: true }) }),
    ).rejects.toThrow("PR changed");
  });
});

describe("async council service", () => {
  test("publishes complete snapshots and replays after restart", async () => {
    const root = temp(),
      council = service(root, 10);
    const started = council.start({
      sourceType: "text",
      source: "review",
      runId: "persistent",
    });
    expect(started.status).toBe("running");
    const observed: string[] = [];
    const unsubscribe = council.subscribe(started.runId, (job) =>
      observed.push(job.status),
    );
    const finished = await council.wait(started.runId);
    expect(finished.status).toBe("completed");
    expect(observed[0]).toBe("running");
    expect(observed.at(-1)).toBe("completed");
    expect(finished.events.length).toBeGreaterThan(0);
    unsubscribe();
    await council.close();
    const reopened = service(root);
    try {
      expect(reopened.get(started.runId).run?.runId).toBe(started.runId);
      expect(reopened.list()).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
  test("preserves preparation failures and explicit cancellation", async () => {
    const root = temp(),
      council = service(root, 50);
    const missing = council.start({
      sourceType: "file",
      source: "missing.md",
      runId: "missing",
    });
    const failed = await council.wait(missing.runId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("does not exist");
    const started = council.start({
      sourceType: "text",
      source: "review",
      runId: "cancelled",
    });
    council.cancel(started.runId);
    expect((await council.wait(started.runId)).status).toBe("cancelled");
    await council.close();
    const reopened = service(root);
    try {
      expect(reopened.get("missing").error).toContain("does not exist");
      expect(reopened.get("cancelled").status).toBe("cancelled");
    } finally {
      await reopened.close();
    }
  });
  test("rejects arbitrary profile paths and bounds concurrent starts", async () => {
    const root = temp(),
      outside = temp(),
      council = service(root, 50);
    writeFileSync(
      join(outside, "profile.json"),
      readFileSync(resolve("councils/default.json")),
    );
    try {
      expect(() =>
        council.start({
          sourceType: "text",
          source: "review",
          profile: join(outside, "profile.json"),
        }),
      ).toThrow("inside");
      for (let i = 0; i < 4; i++)
        council.start({
          sourceType: "text",
          source: "review",
          runId: `bounded-${i}`,
        });
      expect(() =>
        council.start({ sourceType: "text", source: "review" }),
      ).toThrow("At most 4");
    } finally {
      await council.close();
    }
  });
});

describe("MCP job integration", () => {
  test("returns promptly, retains failures, and supports status/cancel", async () => {
    const root = temp();
    const server = createCouncilMcpServer({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      resolveTransport: () => () => new FakeCouncilTransport({ delayMs: 200 }),
    });
    const client = new Client({ name: "async-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const result = await client.callTool(
        {
          name: "council_start",
          arguments: { sourceType: "text", source: "review", runId: "async" },
        },
        { timeout: 100 },
      );
      expect(
        (result.structuredContent?.data as Record<string, unknown>).status,
      ).toBe("running");
      const status = await client.callTool({
        name: "council_status",
        arguments: { runId: "async" },
      });
      expect(status.isError).not.toBe(true);
      await client.callTool({
        name: "council_cancel",
        arguments: { runId: "async" },
      });
      const failure = await client.callTool({
        name: "council_review",
        arguments: {
          sourceType: "file",
          source: "missing.md",
          runId: "failed",
        },
      });
      expect(failure.isError).toBe(true);
      expect(failure.structuredContent?.error).toContain("does not exist");
      expect(
        (failure.structuredContent?.data as Record<string, unknown>).runId,
      ).toBe("failed");
      expect(
        (failure.structuredContent?.data as Record<string, unknown>).artifacts,
      ).toBeDefined();
      const unsafe = await client.callTool({
        name: "council_start",
        arguments: { sourceType: "text", source: "review", runId: ".." },
      });
      expect(unsafe.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
  test("runs through the real stdio entry point from another project", async () => {
    const root = temp();
    const client = new Client({ name: "stdio-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", resolve("scripts/council/mcp.ts")],
      cwd: root,
      env: {
        COUNCIL_WORKSPACE_ROOT: root,
        COUNCIL_RUNS_DIR: join(root, "runs"),
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("council_start");
      const result = await client.callTool({
        name: "council_review",
        arguments: {
          sourceType: "text",
          source: "cross-project review",
          runId: "stdio",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(existsSync(join(root, "runs", "stdio", "manifest.json"))).toBe(
        true,
      );
    } finally {
      await client.close();
    }
  });
});
