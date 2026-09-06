import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { renderCouncilReport } from "./artifacts";
import { loadCouncilProfile } from "./cli";
import { buildContextPack } from "./context";
import { ballotChanged, previousBallot } from "./discussion";
import { FakeCouncilTransport, runCouncil } from "./engine";
import { createCouncilMcpServer } from "./mcp";
import { type CouncilServiceJob, createCouncilService } from "./service";
import type { CouncilDiscussionRound, ModelTransport } from "./types";

const harnessRoot = resolve(import.meta.dir, "../..");
const profile = () =>
  loadCouncilProfile(join(harnessRoot, "councils/default.json"));

test("round snapshots retain objections, changed votes, titles, and validated outputs", async () => {
  const rounds: CouncilDiscussionRound[] = [];
  const transport = new FakeCouncilTransport({
    output: (request) => {
      if (request.stage === "independent")
        return {
          verdict: "needs_changes",
          findings: [
            {
              localId: "F1",
              title: `${request.seat.id} risk`,
              claim: `${request.seat.id} check is missing`,
              severity: "high",
              consequence: "A regression can ship",
              evidenceIds: ["E1"],
              confidence: 0.8,
            },
          ],
          strengths: ["Scope is clear"],
          unknowns: [],
        };
      if (request.stage === "chair")
        return {
          verdict: "insufficient_evidence",
          summary: "Objections remain",
          recommendations: ["Check the supplied guard"],
          consensusFindingKeys: [],
          dissentFindingKeys: request.aggregatedFindings!.map(
            (finding) => finding.key,
          ),
        };
      return {
        ballots: request.candidates!.map((candidate) => ({
          candidateId: candidate.candidateId,
          stance: request.stage === "peer" ? "support" : "oppose",
          reason:
            request.stage === "peer"
              ? "The check appears missing"
              : "The guard in E1 resolves this objection",
          evidenceIds: ["E1"],
        })),
        missingFindings: [],
      };
    },
  });
  const result = await runCouncil({
    profile: profile(),
    context: buildContextPack({ kind: "stdin", text: "E1 has the guard." }),
    resolveTransport: () => transport,
    onDiscussionRound: (round) => {
      rounds.push(structuredClone(round));
      round.records.length = 0;
    },
  });
  expect(result.ok).toBe(true);
  expect(rounds.map((round) => round.stage)).toEqual([
    "independent",
    "peer",
    "revision",
  ]);
  expect(result.run.discussion?.[0]?.records).toHaveLength(4);
  const output = rounds[2]!.records[0]!.output;
  if (!output || !("ballots" in output))
    throw new Error("Missing validated ballots");
  const ballot = output.ballots[0]!;
  const earlier = previousBallot(
    rounds,
    2,
    rounds[2]!.records[0]!.seatId,
    ballot.candidateId,
  )!;
  expect(ballotChanged(earlier, ballot)).toBe(true);
  expect(earlier.reason).toBe("The check appears missing");
  expect(rounds[2]!.candidateTitles[ballot.candidateId]).toContain("risk");
  expect(renderCouncilReport(result.run)).toContain(
    "Changed from support to oppose",
  );
  expect(renderCouncilReport(result.run)).toContain(
    "The guard in E1 resolves this objection",
  );
});

function heldChair() {
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const chairStarted = new Promise<void>((done) => {
    began = done;
  });
  const fake = new FakeCouncilTransport();
  const transport: ModelTransport = {
    async generate(request, signal) {
      if (request.stage === "chair") {
        began();
        await gate;
      }
      return fake.generate(request, signal);
    },
  };
  return { transport, chairStarted, release };
}

test("service exposes discussion before synthesis and reloads the same discussion from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "council-discussion-"));
  const held = heldChair();
  const options = {
    workspaceRoot: root,
    harnessRoot,
    runsRoot: join(root, "runs"),
  };
  const service = createCouncilService({
    ...options,
    resolveTransport: () => () => held.transport,
  });
  try {
    service.start({
      sourceType: "text",
      source: "Review this bounded plan",
      runId: "visible-rounds",
    });
    await held.chairStarted;
    const snapshot = service.get("visible-rounds");
    expect(snapshot.status).toBe("running");
    expect(snapshot.run).toBeUndefined();
    expect(snapshot.discussion).toHaveLength(3);
    expect(snapshot.profile?.id).toBe(profile().id);
    snapshot.discussion!.length = 0;
    expect(service.get("visible-rounds").discussion).toHaveLength(3);
    held.release();
    const final = await service.wait("visible-rounds");
    const restarted = createCouncilService(options);
    try {
      expect(restarted.get("visible-rounds").discussion).toEqual(
        final.discussion,
      );
    } finally {
      await restarted.close();
    }
    expect(readFileSync(final.artifacts!.report, "utf8")).toContain(
      "Round-by-round discussion",
    );
  } finally {
    held.release();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP clients can read intermediate discussion without waiting for the chair", async () => {
  const root = mkdtempSync(join(tmpdir(), "council-mcp-discussion-"));
  const held = heldChair();
  const server = createCouncilMcpServer({
    workspaceRoot: root,
    harnessRoot,
    runsRoot: join(root, "runs"),
    resolveTransport: () => () => held.transport,
  });
  const client = new Client({ name: "discussion-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const started = await client.callTool({
      name: "council_start",
      arguments: {
        sourceType: "text",
        source: "Review this plan",
        runId: "mcp-progress",
      },
    });
    expect(started.isError).not.toBe(true);
    await held.chairStarted;
    const status = await client.callTool({
      name: "council_status",
      arguments: { runId: "mcp-progress" },
    });
    const envelope = status.structuredContent as {
      ok: boolean;
      data: CouncilServiceJob;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("running");
    expect(envelope.data.discussion).toHaveLength(3);
    expect(envelope.data.run).toBeUndefined();
  } finally {
    held.release();
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed rounds do not expose unvalidated provider output", async () => {
  const transport = new FakeCouncilTransport({
    output: () => ({ unsafeRawOutput: "DO_NOT_PUBLISH" }),
  });
  const result = await runCouncil({
    profile: profile(),
    context: buildContextPack({ kind: "stdin", text: "Review" }),
    resolveTransport: () => transport,
  });
  expect(result.ok).toBe(false);
  expect(result.run.discussion).toHaveLength(1);
  expect(JSON.stringify(result.run.discussion)).not.toContain("DO_NOT_PUBLISH");
  expect(
    result.run.discussion?.[0]?.records.every(
      (record) => record.status === "failed",
    ),
  ).toBe(true);
});
