import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  readCouncilRun,
  renderCouncilReport,
  writeCouncilArtifacts,
} from "./artifacts";
import { parseCouncilCliArgs, runCouncilCli } from "./cli";
import { buildContextPack, ContextSecurityError, hashText } from "./context";
import { FakeCouncilTransport, runCouncil } from "./engine";
import {
  type CouncilProfile,
  estimateCouncilCost,
  type IndependentOutput,
  parseCouncilProfileJson,
} from "./types";

const tempRoots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `council-${label}-`));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function profile(overrides: Partial<CouncilProfile> = {}): CouncilProfile {
  const base: CouncilProfile = {
    schemaVersion: 1,
    id: "test-council",
    title: "Test Council",
    depth: "balanced",
    minQuorum: 3,
    minPeerBallots: 2,
    maxEstimatedUsd: 1,
    seats: [
      {
        id: "alpha",
        role: "Factual reviewer",
        provider: "provider-alpha",
        model: "model-alpha",
        timeoutMs: 500,
        maxOutputTokens: 1000,
        estimatedCostUsd: 0.01,
      },
      {
        id: "beta",
        role: "Security reviewer",
        provider: "provider-beta",
        model: "model-beta",
        timeoutMs: 500,
        maxOutputTokens: 1000,
        estimatedCostUsd: 0.01,
      },
      {
        id: "gamma",
        role: "Test reviewer",
        provider: "provider-gamma",
        model: "model-gamma",
        timeoutMs: 500,
        maxOutputTokens: 1000,
        estimatedCostUsd: 0.01,
      },
      {
        id: "delta",
        role: "Architecture reviewer",
        provider: "provider-delta",
        model: "model-delta",
        timeoutMs: 500,
        maxOutputTokens: 1000,
        estimatedCostUsd: 0.01,
      },
    ],
    chair: {
      id: "chair",
      role: "Independent chair",
      provider: "provider-chair",
      model: "model-chair",
      timeoutMs: 500,
      maxOutputTokens: 1200,
      estimatedCostUsd: 0.02,
    },
  };
  return { ...base, ...overrides };
}

function context(text = "The artifact is a short planning document.") {
  return buildContextPack({ kind: "stdin", text });
}

describe("council profile", () => {
  test("parses the checked-in profile and estimates round cost", () => {
    const text = readFileSync(
      resolve(process.cwd(), "councils", "default.json"),
      "utf8",
    );
    const result = parseCouncilProfileJson(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.seats).toHaveLength(4);
      expect(estimateCouncilCost(result.value)).toBe(0);
    }
    expect(estimateCouncilCost(profile())).toBe(0.1);
    expect(
      estimateCouncilCost(profile({ depth: "quick", minPeerBallots: 0 })),
    ).toBe(0.06);
  });

  test("rejects duplicate seats and invalid quorum", () => {
    const duplicate = profile();
    duplicate.seats[1]!.id = duplicate.seats[0]!.id;
    expect(parseCouncilProfileJson(JSON.stringify(duplicate)).ok).toBe(false);
    const invalidQuorum = profile({ minQuorum: 5 });
    expect(parseCouncilProfileJson(JSON.stringify(invalidQuorum)).ok).toBe(
      false,
    );
  });
});

describe("context packs", () => {
  test("produces equivalent hashed evidence from file, plan, and stdin", () => {
    const root = tempRoot("context");
    const file = join(root, "artifact.txt");
    const plan = join(root, "plan.md");
    const text = "Evidence-oriented review content.";
    writeFileSync(file, text, "utf8");
    writeFileSync(plan, text, "utf8");

    const filePack = buildContextPack({ kind: "file", path: file, cwd: root });
    const planPack = buildContextPack({ kind: "plan", path: plan, cwd: root });
    const stdinPack = buildContextPack({ kind: "stdin", text });

    expect(filePack.contentHash).toBe(hashText(text));
    expect(planPack.contentHash).toBe(filePack.contentHash);
    expect(stdinPack.contentHash).toBe(filePack.contentHash);
    expect(filePack.evidence[0]?.id).toBe("E1");
    expect(planPack.source.kind).toBe("plan");
  });

  test("truncates deterministically and rejects files outside the workspace", () => {
    const root = tempRoot("truncate");
    const other = tempRoot("outside");
    const file = join(root, "large.txt");
    const outside = join(other, "other.txt");
    writeFileSync(file, "0123456789", "utf8");
    writeFileSync(outside, "outside", "utf8");
    const pack = buildContextPack({
      kind: "file",
      path: file,
      cwd: root,
      maxBytes: 5,
    });
    expect(pack.truncated).toBe(true);
    expect(pack.evidence[0]?.content).toBe("01234");
    expect(() =>
      buildContextPack({ kind: "file", path: outside, cwd: root }),
    ).toThrow(ContextSecurityError);
  });

  test("rejects high-confidence secrets and can redact them explicitly", () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    expect(() => buildContextPack({ kind: "stdin", text: secret })).toThrow(
      ContextSecurityError,
    );
    const pack = buildContextPack({
      kind: "stdin",
      text: `token=${secret}`,
      secretPolicy: "redact",
    });
    expect(pack.evidence[0]?.content).not.toContain(secret);
    expect(pack.evidence[0]?.content).toContain("[REDACTED:anthropic-api-key]");
    expect(pack.redactions[0]?.count).toBe(1);
    expect(() =>
      buildContextPack({
        kind: "stdin",
        text: "OPENROUTER_API_KEY=synthetic-openrouter-secret",
      }),
    ).toThrow(ContextSecurityError);
  });

  test("scans for secrets before truncation and preserves UTF-8 boundaries", () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    expect(() =>
      buildContextPack({
        kind: "stdin",
        text: `prefix-${secret}`,
        maxBytes: 12,
      }),
    ).toThrow(ContextSecurityError);
    const unicode = buildContextPack({
      kind: "stdin",
      text: "😀suffix",
      maxBytes: 3,
    });
    expect(unicode.evidence[0]?.content).toBe("");
    expect(unicode.byteLength).toBe(0);
    expect(unicode.truncated).toBe(true);
  });

  test("rejects credential-shaped file paths", () => {
    const root = tempRoot("sensitive-file");
    const envFile = join(root, ".env");
    writeFileSync(envFile, "NOT_EVEN_A_SECRET=true", "utf8");
    expect(() =>
      buildContextPack({ kind: "file", path: envFile, cwd: root }),
    ).toThrow(ContextSecurityError);
  });
});

describe("council engine", () => {
  test("runs each round in parallel with a barrier before anonymous peer review", async () => {
    const neutralTitles = new Map([
      ["alpha", "Unsupported benchmark"],
      ["beta", "Unbounded trust boundary"],
      ["gamma", "Missing regression case"],
      ["delta", "Coupled lifecycle"],
    ]);
    const transport = new FakeCouncilTransport({
      delayMs: (request) => (request.stage === "independent" ? 20 : 5),
      output: (request) =>
        request.stage === "independent"
          ? ({
              verdict: "needs_changes",
              findings: [
                {
                  localId: "F1",
                  title:
                    neutralTitles.get(request.seat.id) ?? "Unknown concern",
                  severity: "medium",
                  claim:
                    "The artifact contains a claim that should be verified.",
                  consequence:
                    "An unverified claim can cause avoidable rework.",
                  evidenceIds: ["E1"],
                  confidence: 0.75,
                },
              ],
              strengths: [],
              unknowns: [],
            } satisfies IndependentOutput)
          : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "barrier-run",
    });

    expect(result.ok).toBe(true);
    expect(transport.maxActive).toBe(4);
    expect(transport.requests).toHaveLength(9);
    const peerStage = result.run.events.find(
      (event) =>
        event.type === "stage.started" && event.payload.stage === "peer",
    );
    const independentCompletions = result.run.events.filter(
      (event) =>
        event.type === "seat.completed" &&
        event.payload.stage === "independent",
    );
    expect(independentCompletions).toHaveLength(4);
    expect(
      independentCompletions.every(
        (event) => peerStage !== undefined && event.seq < peerStage.seq,
      ),
    ).toBe(true);

    const peerRequests = transport.requests.filter(
      (request) => request.stage === "peer",
    );
    for (const request of peerRequests) {
      for (const seat of profile().seats) {
        expect(request.prompt).not.toContain(seat.id);
        expect(request.prompt).not.toContain(seat.provider);
        expect(request.prompt).not.toContain(seat.model);
      }
    }
    const orders = new Set(
      peerRequests.map((request) =>
        (request.candidates ?? [])
          .map((candidate) => candidate.finding.title)
          .join("|"),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
    expect(result.run.aggregatedFindings).toHaveLength(4);
    expect(
      result.run.aggregatedFindings.every((finding) => finding.support === 3),
    ).toBe(true);
    expect(result.run.events.map((event) => event.seq)).toEqual(
      result.run.events.map((_, index) => index),
    );
  });

  test("deduplicates equivalent proposals without inflating peer support", async () => {
    const sharedFinding: IndependentOutput = {
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
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent" ? sharedFinding : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "deduplicate-run",
    });
    expect(result.ok).toBe(true);
    expect(result.run.aggregatedFindings).toHaveLength(1);
    expect(result.run.aggregatedFindings[0]?.proposedBy).toBe(4);
    expect(result.run.aggregatedFindings[0]?.support).toBe(0);
    expect(result.run.aggregatedFindings[0]?.independentProposers).toBe(4);
    expect(result.run.aggregatedFindings[0]?.consensusEligible).toBe(true);
  });

  test("continues through one independent failure when quorum remains", async () => {
    const transport = new FakeCouncilTransport({
      fail: [{ stage: "independent", seatId: "delta" }],
    });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "partial-run",
    });
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe("completed");
    expect(result.run.failures).toHaveLength(1);
    expect(
      result.run.records.filter((record) => record.stage === "peer"),
    ).toHaveLength(3);
  });

  test("fails before peer review when independent quorum is not met", async () => {
    const transport = new FakeCouncilTransport({
      fail: [
        { stage: "independent", seatId: "alpha" },
        { stage: "independent", seatId: "beta" },
      ],
    });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "quorum-run",
    });
    expect(result.ok).toBe(false);
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toContain("quorum");
    expect(
      transport.requests.every((request) => request.stage === "independent"),
    ).toBe(true);
  });

  test("enforces peer ballot quorum and records partial failures", async () => {
    const transport = new FakeCouncilTransport({
      fail: [
        { stage: "peer", seatId: "alpha" },
        { stage: "peer", seatId: "beta" },
        { stage: "peer", seatId: "gamma" },
      ],
    });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "peer-quorum-run",
    });
    expect(result.ok).toBe(false);
    expect(result.run.error).toContain("peer ballot quorum");
    expect(result.run.failures).toHaveLength(3);
  });

  test("rejects duplicate peer ballots without losing quorum", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "peer" && request.seat.id === "alpha"
          ? {
              ballots: (request.candidates ?? []).map(() => ({
                candidateId: request.candidates?.[0]?.candidateId,
                stance: "support",
                reason: "Repeated ballot should be rejected.",
                evidenceIds: ["E1"],
              })),
              missingFindings: [],
            }
          : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "duplicate-ballot-run",
    });
    expect(result.ok).toBe(true);
    const failedPeer = result.run.records.find(
      (record) => record.stage === "peer" && record.seatId === "alpha",
    );
    expect(failedPeer?.status).toBe("failed");
    expect(failedPeer?.error).toContain("duplicate candidate ID");
  });

  test("rejects a chair synthesis that invents finding keys", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "chair"
          ? {
              verdict: "needs_changes",
              summary: "Invalid synthesis.",
              recommendations: [],
              consensusFindingKeys: ["invented-key"],
              dissentFindingKeys: [],
            }
          : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "invalid-chair-run",
    });
    expect(result.ok).toBe(false);
    expect(result.run.error).toContain("chair failed");
    expect(result.run.failures[0]?.error).toContain("unknown finding key");
  });

  test("cancels in-flight parallel calls", async () => {
    const controller = new AbortController();
    const transport = new FakeCouncilTransport({ delayMs: 100 });
    const pending = runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "cancel-run",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.run.status).toBe("cancelled");
    expect(result.run.records).toHaveLength(4);
    expect(
      result.run.records.every((record) => record.status === "cancelled"),
    ).toBe(true);
  });

  test("fails budget preflight before any transport call", async () => {
    const transport = new FakeCouncilTransport();
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "budget-run",
      maxUsd: 0.01,
    });
    expect(result.ok).toBe(false);
    expect(result.run.error).toContain("exceeds budget");
    expect(transport.requests).toHaveLength(0);
  });

  test("stops between rounds when reported cost exceeds the budget", async () => {
    const transport = new FakeCouncilTransport({ costUsd: 0.1 });
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => transport,
      runId: "reported-cost-run",
      maxUsd: 0.25,
    });
    expect(result.ok).toBe(false);
    expect(result.run.error).toContain("reported cost");
    expect(result.run.actualCostUsd).toBe(0.4);
    expect(transport.requests).toHaveLength(4);
  });

  test("enforces per-seat timeout", async () => {
    const slowProfile = profile({
      minQuorum: 2,
      seats: profile().seats.map((seat) => ({ ...seat, timeoutMs: 5 })),
    });
    const transport = new FakeCouncilTransport({ delayMs: 100 });
    const result = await runCouncil({
      profile: slowProfile,
      context: context(),
      resolveTransport: () => transport,
      runId: "timeout-run",
    });
    expect(result.ok).toBe(false);
    expect(
      result.run.records.every((record) => record.status === "failed"),
    ).toBe(true);
    expect(result.run.failures[0]?.error).toContain("timeout");
  });
});

describe("artifacts and CLI", () => {
  test("CLI rejects missing flag values and unsafe run ids", () => {
    expect(parseCouncilCliArgs(["stdin", "--profile", "--json"])).toEqual({
      ok: false,
      error: "--profile needs a value",
      json: true,
    });
    const unsafe = parseCouncilCliArgs(["stdin", "--run-id", "../escape"]);
    expect(unsafe.ok).toBe(false);
  });

  test("writes and replays a complete run", async () => {
    const root = tempRoot("artifacts");
    const result = await runCouncil({
      profile: profile(),
      context: context(),
      resolveTransport: () => new FakeCouncilTransport(),
      runId: "artifact-run",
    });
    const paths = writeCouncilArtifacts(result.run, root);
    const replay = readCouncilRun("artifact-run", root);
    expect(replay.runId).toBe("artifact-run");
    expect(
      readFileSync(paths.events, "utf8").split("\n").length,
    ).toBeGreaterThan(5);
    expect(renderCouncilReport(replay)).toContain("## Findings");
    expect(readFileSync(paths.report, "utf8")).toContain("Council Review");
  });

  test("CLI dry-run and execution emit standard JSON envelopes", async () => {
    const root = tempRoot("cli");
    const source = join(root, "plan.md");
    const profilePath = resolve(process.cwd(), "councils", "default.json");
    const runsDir = join(root, "runs");
    writeFileSync(source, "# Plan\n\nVerify this plan.", "utf8");

    let dryOutput = "";
    const dryCode = await runCouncilCli(
      ["plan", source, "--profile", profilePath, "--dry-run", "--json"],
      {
        cwd: root,
        stdout: (text) => (dryOutput += text),
        stderr: () => undefined,
      },
    );
    const dryEnvelope = JSON.parse(dryOutput) as {
      ok: boolean;
      data: { dryRun: boolean; budgetAllowed: boolean };
      error: string | null;
    };
    expect(dryCode).toBe(0);
    expect(dryEnvelope).toEqual({
      ok: true,
      data: expect.objectContaining({ dryRun: true, budgetAllowed: true }),
      error: null,
    });

    let runOutput = "";
    const runCode = await runCouncilCli(
      [
        "plan",
        source,
        "--profile",
        profilePath,
        "--runs-dir",
        runsDir,
        "--run-id",
        "cli-run",
        "--json",
      ],
      {
        cwd: root,
        stdout: (text) => (runOutput += text),
        stderr: () => undefined,
      },
    );
    const runEnvelope = JSON.parse(runOutput) as {
      ok: boolean;
      data: { run: { runId: string }; artifacts: { report: string } };
      error: string | null;
    };
    expect(runCode).toBe(0);
    expect(runEnvelope.ok).toBe(true);
    expect(runEnvelope.data.run.runId).toBe("cli-run");
    expect(readFileSync(runEnvelope.data.artifacts.report, "utf8")).toContain(
      "Council Review",
    );

    let replayOutput = "";
    const replayCode = await runCouncilCli(
      ["replay", "cli-run", "--runs-dir", runsDir, "--json"],
      {
        cwd: root,
        stdout: (text) => (replayOutput += text),
        stderr: () => undefined,
      },
    );
    expect(replayCode).toBe(0);
    expect(JSON.parse(replayOutput).data.run.runId).toBe("cli-run");
  });
});
