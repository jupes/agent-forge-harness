import { readFileSync } from "node:fs";
import {
  type CouncilRunReservation,
  reserveCouncilRun,
  writeCouncilArtifacts,
} from "./artifacts";
import {
  buildContextPack,
  type ContextInput,
  type SecretPolicy,
} from "./context";
import { type CouncilEngineOptions, runCouncil } from "./engine";
import { compilePullRequest } from "./pr-source";
import {
  assertProvidersReady,
  createProviderResolver,
  type ProviderResolverOptions,
} from "./providers";
import {
  type ContextSourceKind,
  type CouncilExecutionResult,
  type CouncilProfile,
  parseCouncilProfileJson,
} from "./types";

export function loadCouncilProfile(path: string): CouncilProfile {
  const parsed = parseCouncilProfileJson(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new Error(`invalid council profile: ${parsed.error}`);
  return parsed.value;
}

export type CouncilSourceInput = {
  kind: ContextSourceKind;
  source: string;
  workspaceRoot: string;
  secretPolicy: SecretPolicy;
  maxBytes?: number | undefined;
  displayName?: string | undefined;
};

// CLI and jobs normalize their interface-specific input here. PR capture,
// evidence hashing, redaction and byte limits must never differ by interface.
export async function prepareCouncilContext(input: CouncilSourceInput) {
  let context: ContextInput;
  if (input.kind === "pr") {
    const compiled = await compilePullRequest(input.source, {
      cwd: input.workspaceRoot,
      secretPolicy: input.secretPolicy,
    });
    context = {
      kind: "pr",
      text: compiled.text,
      displayName: compiled.displayName,
      locator: compiled.locator,
      metadata: compiled.metadata,
    };
  } else if (input.kind === "stdin") {
    context = { kind: "stdin", text: input.source };
    if (input.displayName !== undefined)
      context.displayName = input.displayName;
  } else {
    context = {
      kind: input.kind,
      path: input.source,
      cwd: input.workspaceRoot,
    };
  }
  context.secretPolicy = input.secretPolicy;
  if (input.maxBytes !== undefined) context.maxBytes = input.maxBytes;
  return buildContextPack(context);
}

export type CouncilReviewOptions = Omit<
  CouncilEngineOptions,
  "resolveTransport" | "runId"
> & {
  runId: string;
  runsRoot: string;
  reservation?: CouncilRunReservation;
  resolveTransport?: CouncilEngineOptions["resolveTransport"];
  environment?: ProviderResolverOptions["environment"];
  fetchImpl?: ProviderResolverOptions["fetchImpl"];
  onResult?: (result: CouncilExecutionResult) => void;
};

// Jobs reserve before returning a handle; synchronous callers reserve here.
// Both paths dispatch and persist through this one boundary. Preparation errors
// remain the caller's responsibility (jobs persist them; CLI reports them).
export async function executeCouncilReview(options: CouncilReviewOptions) {
  const {
    runsRoot,
    reservation,
    environment,
    fetchImpl,
    resolveTransport,
    onResult,
    ...engineOptions
  } = options;
  assertProvidersReady(engineOptions.profile, environment);
  const owned = reservation ?? reserveCouncilRun(engineOptions.runId, runsRoot);
  if (owned.runId !== engineOptions.runId)
    throw new Error("council reservation belongs to a different run");
  const providerOptions: ProviderResolverOptions = {};
  if (environment !== undefined) providerOptions.environment = environment;
  if (fetchImpl !== undefined) providerOptions.fetchImpl = fetchImpl;
  const result = await runCouncil({
    ...engineOptions,
    resolveTransport:
      resolveTransport ?? createProviderResolver(providerOptions),
  });
  // Retain the completed run in memory even if saving its artifacts fails.
  try {
    onResult?.(structuredClone(result));
  } catch {
    // Observers cannot change or interrupt persistence of validated results.
  }
  const artifacts = writeCouncilArtifacts(result.run, runsRoot, owned);
  return { result, artifacts };
}
