#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import * as z from "zod/v4";
import { readCouncilRun, writeCouncilArtifacts } from "./artifacts";
import { loadCouncilProfile } from "./cli";
import {
  buildContextPack,
  type ContextInput,
  sanitizeContent,
} from "./context";
import { runCouncil } from "./engine";
import { compilePullRequest } from "./pr-source";
import {
  assertProvidersReady,
  createProviderResolver,
  type ProviderResolverOptions,
  providerReadiness,
} from "./providers";
import type { ContextPack, CouncilProfile, ModelTransport } from "./types";

type Environment = Record<string, string | undefined>;

export type CouncilMcpOptions = {
  workspaceRoot?: string;
  harnessRoot?: string;
  runsRoot?: string;
  environment?: Environment;
  fetchImpl?: typeof fetch;
  resolveTransport?: (
    profile: CouncilProfile,
  ) => (seat: CouncilProfile["chair"]) => ModelTransport;
};

const REVIEW_INPUT = z.object({
  sourceType: z.enum(["file", "plan", "pr", "text"]),
  source: z
    .string()
    .min(1)
    .describe("Relative file path, PR number/URL, or pasted text"),
  profile: z
    .string()
    .optional()
    .describe("Profile path relative to the configured workspace"),
  maxUsd: z.number().nonnegative().optional(),
  maxBytes: z.number().int().positive().max(2_000_000).optional(),
  runId: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  redactSecrets: z.boolean().default(false),
});

const PROFILE_INPUT = z.object({
  profile: z
    .string()
    .optional()
    .describe("Profile path relative to the configured workspace"),
});

const REPLAY_INPUT = z.object({
  runId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
});

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function safeExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`file does not exist: ${path}`);
  }
}

function resolveProfilePath(
  profile: string | undefined,
  workspaceRoot: string,
  harnessRoot: string,
): string {
  if (!profile) return resolve(harnessRoot, "councils", "default.json");
  const candidate = safeExistingPath(resolve(workspaceRoot, profile));
  const workspace = safeExistingPath(workspaceRoot);
  const harness = safeExistingPath(harnessRoot);
  if (!isInside(workspace, candidate) && !isInside(harness, candidate)) {
    throw new Error("council profile must be inside the workspace or harness");
  }
  return candidate;
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeContent(raw.slice(0, 1_000), "redact").text;
}

function toolResult(data: Record<string, unknown>, isError = false) {
  const envelope = {
    ok: !isError,
    data: isError ? null : data,
    error: isError ? String(data.error ?? "Council tool failed") : null,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError,
  };
}

async function contextFromTool(
  input: z.infer<typeof REVIEW_INPUT>,
  workspaceRoot: string,
): Promise<ContextPack> {
  const secretPolicy = input.redactSecrets ? "redact" : "reject";
  let contextInput: ContextInput;
  if (input.sourceType === "text") {
    contextInput = {
      kind: "stdin",
      text: input.source,
      displayName: "MCP pasted text",
      secretPolicy,
    };
  } else if (input.sourceType === "pr") {
    const pullRequest = await compilePullRequest(input.source, {
      cwd: workspaceRoot,
    });
    contextInput = {
      kind: "pr",
      text: pullRequest.text,
      displayName: pullRequest.displayName,
      locator: pullRequest.locator,
      metadata: pullRequest.metadata,
      secretPolicy,
    };
  } else {
    contextInput = {
      kind: input.sourceType,
      path: input.source,
      cwd: workspaceRoot,
      secretPolicy,
    };
  }
  if (input.maxBytes !== undefined) contextInput.maxBytes = input.maxBytes;
  return buildContextPack(contextInput);
}

function reviewSummary(
  result: Awaited<ReturnType<typeof runCouncil>>,
  artifacts: ReturnType<typeof writeCouncilArtifacts>,
): Record<string, unknown> {
  return {
    runId: result.run.runId,
    status: result.run.status,
    verdict: result.run.chair?.verdict ?? null,
    summary: result.run.chair?.summary ?? result.run.error ?? null,
    recommendations: result.run.chair?.recommendations ?? [],
    findings: result.run.aggregatedFindings,
    failures: result.run.failures,
    context: result.run.context,
    estimatedCostUsd: result.run.estimatedCostUsd,
    actualCostUsd: result.run.actualCostUsd,
    artifacts,
  };
}

export function createCouncilMcpServer(
  options: CouncilMcpOptions = {},
): McpServer {
  const environment = options.environment ?? process.env;
  const harnessRoot = resolve(
    options.harnessRoot ?? resolve(import.meta.dir, "..", ".."),
  );
  const workspaceRoot = resolve(
    options.workspaceRoot ??
      environment.COUNCIL_WORKSPACE_ROOT ??
      process.cwd(),
  );
  const runsRoot = resolve(
    options.runsRoot ??
      environment.COUNCIL_RUNS_DIR ??
      resolve(workspaceRoot, "reports", "council-runs"),
  );
  const providerOptions: ProviderResolverOptions = { environment };
  if (options.fetchImpl) providerOptions.fetchImpl = options.fetchImpl;

  const server = new McpServer({
    name: "agent-forge-council",
    version: "0.1.0",
  });

  server.registerTool(
    "council_readiness",
    {
      title: "Check council provider readiness",
      description:
        "Check which model providers a council profile uses and report missing environment variable names without exposing credential values.",
      inputSchema: PROFILE_INPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ profile }) => {
      try {
        const profilePath = resolveProfilePath(
          profile,
          workspaceRoot,
          harnessRoot,
        );
        const councilProfile = loadCouncilProfile(profilePath);
        return toolResult({
          profileId: councilProfile.id,
          readiness: providerReadiness(councilProfile, environment),
        });
      } catch (error) {
        return toolResult({ error: safeMessage(error) }, true);
      }
    },
  );

  server.registerTool(
    "council_review",
    {
      title: "Run a deliberative council review",
      description:
        "Review a PR, plan, file, or pasted text with parallel model-provider seats, anonymous peer challenge, deterministic aggregation, and chair synthesis.",
      inputSchema: REVIEW_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input, context) => {
      try {
        const profilePath = resolveProfilePath(
          input.profile,
          workspaceRoot,
          harnessRoot,
        );
        const profile = loadCouncilProfile(profilePath);
        assertProvidersReady(profile, environment);
        const packedContext = await contextFromTool(input, workspaceRoot);
        const resolveTransport = options.resolveTransport
          ? options.resolveTransport(profile)
          : createProviderResolver(providerOptions);
        const engineOptions: Parameters<typeof runCouncil>[0] = {
          profile,
          context: packedContext,
          resolveTransport,
          signal: context.mcpReq.signal,
        };
        if (input.maxUsd !== undefined) engineOptions.maxUsd = input.maxUsd;
        if (input.runId) engineOptions.runId = input.runId;
        const result = await runCouncil(engineOptions);
        const artifacts = writeCouncilArtifacts(result.run, runsRoot);
        return toolResult(reviewSummary(result, artifacts), !result.ok);
      } catch (error) {
        return toolResult({ error: safeMessage(error) }, true);
      }
    },
  );

  server.registerTool(
    "council_replay",
    {
      title: "Replay a council review",
      description:
        "Load a completed local council run by ID and return its preserved findings, dissent, synthesis, cost, and failures.",
      inputSchema: REPLAY_INPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => {
      try {
        const run = readCouncilRun(runId, runsRoot);
        return toolResult({
          runId: run.runId,
          status: run.status,
          verdict: run.chair?.verdict ?? null,
          summary: run.chair?.summary ?? run.error ?? null,
          recommendations: run.chair?.recommendations ?? [],
          findings: run.aggregatedFindings,
          failures: run.failures,
          context: run.context,
          estimatedCostUsd: run.estimatedCostUsd,
          actualCostUsd: run.actualCostUsd,
        });
      } catch (error) {
        return toolResult({ error: safeMessage(error) }, true);
      }
    },
  );

  return server;
}

if (import.meta.main) {
  serveStdio(() => createCouncilMcpServer());
}
