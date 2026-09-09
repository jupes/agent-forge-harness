import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCouncilRun, reserveCouncilRun } from "./artifacts";
import { runCouncilCli } from "./cli";
import { FakeCouncilTransport } from "./fake-transport";
import { createCouncilService } from "./service";
import type { CouncilRun, SeatRecord } from "./types";
import {
  executeCouncilReview,
  loadCouncilProfile,
  prepareCouncilContext,
} from "./workflow";

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "council-workflow-"));
  roots.push(root);
  writeFileSync(
    join(root, "review.md"),
    "Verify the rollout plan and its evidence.\n",
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function parseEnvelope(text: string): {
  ok: boolean;
  data: { run: CouncilRun };
  error: string | null;
} {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Expected a CLI envelope");
  }
}
function decisions(records: SeatRecord[]) {
  return records.map(({ latencyMs: _latency, ...record }) => record);
}

for (const kind of ["file", "plan", "stdin"] as const) {
  test(`CLI and job execution preserve the same ${kind} evidence, decisions and artifacts`, async () => {
    const root = workspace();
    let stdout = "";
    const cliArgs = kind === "stdin" ? ["stdin"] : [kind, "review.md"];
    const code = await runCouncilCli(
      [...cliArgs, "--run-id", "parity", "--runs-dir", "cli-runs", "--json"],
      {
        cwd: root,
        readStdin: async () => readFileSync(join(root, "review.md"), "utf8"),
        stdout: (value) => {
          stdout += value;
        },
        stderr: () => {},
      },
    );
    const cli = parseEnvelope(stdout);
    expect(code).toBe(0);
    expect(cli.ok).toBe(true);
    const service = createCouncilService({
      workspaceRoot: root,
      runsRoot: join(root, "job-runs"),
    });
    try {
      const started = service.start({
        sourceType: kind === "stdin" ? "text" : kind,
        source:
          kind === "stdin"
            ? readFileSync(join(root, "review.md"), "utf8")
            : "review.md",
        runId: "parity",
      });
      expect(started.status).toBe("running");
      const finished = await service.wait(started.runId);
      expect(finished.status).toBe("completed");
      // Pasted text intentionally has a friendlier label than CLI stdin.
      if (kind === "stdin") {
        expect(finished.run?.context.source.displayName).toBe(
          "Pasted review text",
        );
        expect(cli.data.run.context.source.displayName).toBe("standard input");
      }
      const evidenceContent = (run: CouncilRun) =>
        run.context.evidence?.map(({ title: _title, ...item }) => item) ?? [];
      expect(evidenceContent(finished.run!)).toEqual(
        evidenceContent(cli.data.run),
      );
      expect(finished.run?.context.contentHash).toBe(
        cli.data.run.context.contentHash,
      );
      expect(decisions(finished.run!.records)).toEqual(
        decisions(cli.data.run.records),
      );
      expect(finished.run?.aggregatedFindings).toEqual(
        cli.data.run.aggregatedFindings,
      );
      expect(finished.run?.chair).toEqual(cli.data.run.chair);
      expect(readCouncilRun("parity", join(root, "job-runs"))).toEqual(
        finished.run!,
      );
      expect(readCouncilRun("parity", join(root, "cli-runs"))).toEqual(
        cli.data.run,
      );
    } finally {
      await service.close();
    }
  });
}

test("shared preparation preserves caller labels, redaction and byte limits", async () => {
  const root = workspace();
  const source = "A review note.\nOPENAI_API_KEY=sk-testabcdefghijklmnopqrstuv";
  await expect(
    prepareCouncilContext({
      kind: "stdin",
      source,
      workspaceRoot: root,
      secretPolicy: "reject",
      maxBytes: 10,
    }),
  ).rejects.toThrow("potential secrets");
  const prepared = await prepareCouncilContext({
    kind: "stdin",
    source,
    workspaceRoot: root,
    secretPolicy: "redact",
    maxBytes: 10,
    displayName: "Pasted review text",
  });
  expect(prepared.source.displayName).toBe("Pasted review text");
  expect(prepared.truncated).toBe(true);
  expect(prepared.redactions.length).toBeGreaterThan(0);
  expect(JSON.stringify(prepared)).not.toContain(
    "sk-testabcdefghijklmnopqrstuv",
  );
});

test("shared execution preserves cancellation, events, discussion and failed artifacts", async () => {
  const root = workspace();
  const context = await prepareCouncilContext({
    kind: "file",
    source: "review.md",
    workspaceRoot: root,
    secretPolicy: "reject",
  });
  const profile = loadCouncilProfile(resolve("councils/default.json"));
  const fake = new FakeCouncilTransport();
  const controller = new AbortController();
  controller.abort();
  const events: string[] = [];
  const { result } = await executeCouncilReview({
    profile,
    context,
    runId: "cancelled",
    runsRoot: join(root, "runs"),
    signal: controller.signal,
    resolveTransport: () => fake,
    onEvent: (event) => events.push(event.type),
  });
  expect(result.ok).toBe(false);
  expect(result.run.status).toBe("cancelled");
  expect(fake.requests).toHaveLength(0);
  expect(events).toContain("run.cancelled");
  expect(readCouncilRun("cancelled", join(root, "runs")).status).toBe(
    "cancelled",
  );

  const rounds: string[] = [];
  const completed = await executeCouncilReview({
    profile,
    context,
    runId: "complete",
    runsRoot: join(root, "runs"),
    resolveTransport: () => fake,
    onDiscussionRound: (round) => rounds.push(round.stage),
  });
  expect(completed.result.ok).toBe(true);
  expect(rounds).toEqual(["independent", "peer", "revision"]);
  await expect(
    executeCouncilReview({
      profile,
      context,
      runId: "complete",
      runsRoot: join(root, "runs"),
      resolveTransport: () => fake,
    }),
  ).rejects.toThrow("already exists");
  expect(fake.requests).toHaveLength(13);
});

test("job retains completed review data when artifact persistence fails", async () => {
  const root = workspace(),
    runsRoot = join(root, "runs");
  const fake = new FakeCouncilTransport({
    onRequest: (request) => {
      if (request.stage === "chair")
        writeFileSync(
          join(runsRoot, "save-failure", "report.md"),
          "Do not overwrite",
        );
    },
  });
  const service = createCouncilService({
    workspaceRoot: root,
    runsRoot,
    resolveTransport: () => () => fake,
  });
  try {
    const job = service.start({
      sourceType: "text",
      source: "Review this plan",
      runId: "save-failure",
    });
    const finished = await service.wait(job.runId);
    expect(finished.status).toBe("completed");
    expect(finished.persistenceStatus).toBe("failed");
    expect(finished.persistenceError).toContain("already exists");
    expect(finished.run?.status).toBe("completed");
    expect(finished.run?.chair?.summary).toContain("deterministic review");
    expect(readFileSync(join(runsRoot, job.runId, "report.md"), "utf8")).toBe(
      "Do not overwrite",
    );
    expect(service.get(job.runId).status).toBe("completed");
    expect(service.get(job.runId).persistenceStatus).toBe("failed");
  } finally {
    await service.close();
  }
});

test("shared execution rejects a mismatched reservation before any model calls", async () => {
  const root = workspace(),
    runsRoot = join(root, "runs");
  const reservation = reserveCouncilRun("owned", runsRoot);
  const context = await prepareCouncilContext({
    kind: "file",
    source: "review.md",
    workspaceRoot: root,
    secretPolicy: "reject",
  });
  const fake = new FakeCouncilTransport();
  await expect(
    executeCouncilReview({
      profile: loadCouncilProfile(resolve("councils/default.json")),
      context,
      runsRoot,
      reservation,
      runId: "different",
      resolveTransport: () => fake,
    }),
  ).rejects.toThrow("different run");
  expect(fake.requests).toHaveLength(0);
});
