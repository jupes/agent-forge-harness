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

function summary(job: CouncilServiceJob): Record<string, unknown> {
  const run = job.run;
  return {
    ...job,
    verdict: run?.chair?.verdict ?? null,
    summary: run?.chair?.summary ?? job.error ?? null,
    recommendations: run?.chair?.recommendations ?? [],
    findings: run?.aggregatedFindings ?? [],
    failures: run?.failures ?? [],
    context: run?.context ?? null,
    estimatedCostUsd: run?.estimatedCostUsd ?? null,
    actualCostUsd: run?.actualCostUsd ?? null,
    usageEstimatedCostUsd: run?.usageEstimatedCostUsd ?? null,
    accountedCostUsd: run?.accountedCostUsd ?? null,
    costIsEstimate: run?.costIsEstimate ?? true,
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
        return toolResult(summary(service.start(input)));
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
            summary(result),
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
  for (const name of ["council_status", "council_replay"] as const) {
    server.registerTool(
      name,
      {
        title:
          name === "council_status"
            ? "Get council progress and result"
            : "Replay a council review",
        description:
          "Retrieve a run by its confined ID. The discussion array exposes validated independent, peer and rebuttal rounds while status is running; these are provisional, not a final verdict. Terminal results include synthesis, costs and failures and survive server restarts.",
        inputSchema: ID_INPUT,
        annotations: { readOnlyHint: true },
      },
      async ({ runId }) => {
        try {
          return toolResult(summary(service.get(runId)));
        } catch (error) {
          return toolResult(null, safeCouncilError(error));
        }
      },
    );
  }
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
        return toolResult(summary(service.cancel(runId)));
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
