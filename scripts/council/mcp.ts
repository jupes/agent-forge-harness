#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { assertCouncilRunId } from "./artifacts";
import {
  type CouncilServiceJob,
  type CouncilServiceOptions,
  createCouncilService,
  safeCouncilError,
} from "./service";

export type CouncilMcpOptions = CouncilServiceOptions;

const RUN_ID = z.string().refine((id) => {
  try {
    assertCouncilRunId(id);
    return true;
  } catch {
    return false;
  }
}, "Invalid council run ID");
const REVIEW_INPUT = z.object({
  sourceType: z.enum(["file", "plan", "pr", "text"]),
  source: z
    .string()
    .min(1)
    .max(2_000_000)
    .describe("Workspace file path, PR number/URL, or pasted text"),
  profile: z
    .string()
    .optional()
    .describe("Profile path inside the configured workspace or harness"),
  maxUsd: z.number().nonnegative().optional(),
  maxBytes: z.number().int().positive().max(2_000_000).optional(),
  runId: RUN_ID.optional(),
  redactSecrets: z.boolean().default(false),
});
const PROFILE_INPUT = z.object({ profile: z.string().optional() });
const ID_INPUT = z.object({ runId: RUN_ID });

function toolResult(
  data: Record<string, unknown> | null,
  error: string | null = null,
) {
  const envelope = { ok: error === null, data, error };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: error !== null,
  };
}

function boundedText(value: string | undefined, max = 1_000): string | null {
  return value === undefined ? null : value.slice(0, max);
}

function boundedScalar(value: unknown): unknown {
  return typeof value === "string" ? value.slice(0, 300) : value;
}

function compactArtifacts(job: CouncilServiceJob) {
  if (!job.artifacts) return null;
  return Object.fromEntries(
    Object.entries(job.artifacts).map(([key, value]) => [
      key,
      value.slice(0, 1_000),
    ]),
  );
}

function statusSummary(job: CouncilServiceJob): Record<string, unknown> {
  const run = job.run;
  const lastEvent = job.events.at(-1);
  const eventPayload = lastEvent
    ? Object.fromEntries(
        ["stage", "round", "seatId", "count", "verdict"].flatMap((key) =>
          key in lastEvent.payload
            ? [[key, boundedScalar(lastEvent.payload[key])]]
            : [],
        ),
      )
    : null;
  return {
    runId: job.runId,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    profile: job.profile
      ? {
          id: job.profile.id.slice(0, 200),
          title: job.profile.title.slice(0, 300),
          depth: job.profile.depth,
        }
      : null,
    progress: {
      eventCount: job.events.length,
      discussionRoundCount:
        job.discussion?.length ?? run?.discussion?.length ?? 0,
      lastEvent: lastEvent
        ? {
            seq: lastEvent.seq,
            at: lastEvent.at,
            type: lastEvent.type,
            payload: eventPayload,
          }
        : null,
    },
    discussion: (job.discussion ?? run?.discussion ?? []).map((round) => ({
      stage: round.stage,
      ...(round.round === undefined ? {} : { round: round.round }),
      completedAt: round.completedAt,
      recordCount: round.records.length,
      completedCount: round.records.filter(
        (record) => record.status === "completed",
      ).length,
      failureCount: round.records.filter(
        (record) => record.status !== "completed",
      ).length,
      findingCount: round.findings.length,
    })),
    verdict: run?.chair?.verdict ?? null,
    summary: boundedText(run?.chair?.summary ?? job.error, 2_000),
    recommendations: (run?.chair?.recommendations ?? [])
      .slice(0, 10)
      .map((value) => value.slice(0, 500)),
    findingCount: run?.aggregatedFindings.length ?? 0,
    findings: (run?.aggregatedFindings ?? []).slice(0, 25).map((finding) => ({
      key: finding.key,
      title: finding.title.slice(0, 300),
      claim: finding.claim.slice(0, 500),
      severity: finding.severity,
      resolution: finding.resolution,
      support: finding.support,
      oppose: finding.oppose,
      uncertain: finding.uncertain,
    })),
    failureCount: run?.failures.length ?? 0,
    failures: (run?.failures ?? []).slice(0, 20).map((failure) => ({
      ...failure,
      error: failure.error.slice(0, 500),
    })),
    estimatedCostUsd: run?.estimatedCostUsd ?? null,
    actualCostUsd: run?.actualCostUsd ?? null,
    usageEstimatedCostUsd: run?.usageEstimatedCostUsd ?? null,
    accountedCostUsd: run?.accountedCostUsd ?? null,
    costIsEstimate: run?.costIsEstimate ?? true,
    persistenceStatus: job.persistenceStatus ?? null,
    persistenceError: boundedText(job.persistenceError),
    artifacts: compactArtifacts(job),
  };
}

function fullResult(job: CouncilServiceJob): Record<string, unknown> {
  return {
    runId: job.runId,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    error: boundedText(job.error),
    persistenceStatus: job.persistenceStatus ?? null,
    persistenceError: boundedText(job.persistenceError),
    artifacts: job.artifacts ?? null,
    run: job.run ?? null,
  };
}

export function createCouncilMcpServer(
  options: CouncilMcpOptions = {},
): McpServer {
  const service = createCouncilService(options);
  const server = new McpServer({
    name: "agent-forge-council",
    version: "0.2.0",
  });
  server.registerTool(
    "council_profiles",
    {
      title: "List council profiles",
      description:
        "List available councils and provider readiness without exposing credentials.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => toolResult({ profiles: service.profiles() }),
  );
  server.registerTool(
    "council_readiness",
    {
      title: "Check council provider readiness",
      description:
        "Report missing provider environment variable names without making model calls.",
      inputSchema: PROFILE_INPUT,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return toolResult(service.readiness(input));
      } catch (error) {
        return toolResult(null, safeCouncilError(error));
      }
    },
  );
  server.registerTool(
    "council_start",
    {
      title: "Start a council review",
      description:
        "Start a persistent local review and immediately return its run ID. Poll council_status for progress and results; council_cancel stops it. Recommended for real providers: the review outlives this MCP request's timeout.",
      inputSchema: REVIEW_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        return toolResult(statusSummary(service.start(input)));
      } catch (error) {
        return toolResult(null, safeCouncilError(error));
      }
    },
  );
  server.registerTool(
    "council_review",
    {
      title: "Run and await a council review",
      description:
        "Run a review synchronously. Use council_start for long reviews to avoid client request timeouts. Failed reviews retain their run ID, diagnostics, and artifact paths.",
      inputSchema: REVIEW_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input, context) => {
      try {
        const job = service.start(input);
        // Explicit synchronous cancellation stops this run. Async council_start
        // intentionally has no request-scoped cancellation signal.
        const onAbort = () => service.cancel(job.runId);
        context.mcpReq.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        if (context.mcpReq.signal.aborted) onAbort();
        try {
          const result = await service.wait(job.runId);
          return toolResult(
            fullResult(result),
            result.status === "completed"
              ? null
              : (result.error ?? `Council ${result.status}`),
          );
        } finally {
          context.mcpReq.signal.removeEventListener("abort", onAbort);
        }
      } catch (error) {
        return toolResult(null, safeCouncilError(error));
      }
    },
  );
  server.registerTool(
    "council_status",
    {
      title: "Get compact council progress and result",
      description:
        "Poll compact, bounded progress for a run. Returns round counts and abbreviated terminal findings without evidence, transcripts, or duplicated run data. Use council_replay once after completion for the full preserved review.",
      inputSchema: ID_INPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => {
      try {
        return toolResult(statusSummary(service.get(runId)));
      } catch (error) {
        return toolResult(null, safeCouncilError(error));
      }
    },
  );
  server.registerTool(
    "council_replay",
    {
      title: "Replay one complete council review",
      description:
        "Retrieve a terminal review exactly once without duplicating its context, findings, events, or discussion outside the run object. Poll active work with council_status instead.",
      inputSchema: ID_INPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => {
      try {
        const job = service.get(runId);
        if (job.status === "running" || job.status === "cancelling")
          return toolResult(
            statusSummary(job),
            "Council is still active; poll council_status before replaying it.",
          );
        return toolResult(fullResult(job));
      } catch (error) {
        return toolResult(null, safeCouncilError(error));
      }
    },
  );
  server.registerTool(
    "council_list",
    {
      title: "List recent council reviews",
      description: "List up to 100 recent local reviews and their statuses.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return toolResult({
          runs: service
            .list()
            .map(({ runId, status, startedAt, updatedAt, error }) => ({
              runId,
              status,
              startedAt,
              updatedAt,
              error,
            })),
        });
      } catch (error) {
        return toolResult(null, safeCouncilError(error));
      }
    },
  );
  server.registerTool(
    "council_cancel",
    {
      title: "Cancel a council review",
      description:
        "Request cancellation of an active local review. Poll council_status to retrieve its terminal cancellation record.",
      inputSchema: ID_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ runId }) => {
      try {
        return toolResult(statusSummary(service.cancel(runId)));
      } catch (error) {
        return toolResult(null, safeCouncilError(error));
      }
    },
  );
  const close = server.close.bind(server);
  server.close = async () => {
    await service.close();
    await close();
  };
  return server;
}

if (import.meta.main) serveStdio(() => createCouncilMcpServer());
