import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCouncilRunId,
  type CouncilArtifactPaths,
  listCouncilRunIds,
  readCouncilRun,
  reserveCouncilRun,
  resolveRunDirectory,
  writeCouncilArtifacts,
  writeCouncilJobFailure,
} from "./artifacts";
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
import {
  type CouncilDiscussionRound,
  type CouncilEvent,
  type CouncilProfile,
  type CouncilRun,
  type CouncilSeat,
  type ModelTransport,
  parseCouncilProfileJson,
} from "./types";

export type CouncilServiceInput = {
  sourceType: "file" | "plan" | "pr" | "text";
  source: string;
  profile?: string | undefined;
  maxUsd?: number | undefined;
  maxBytes?: number | undefined;
  runId?: string | undefined;
  redactSecrets?: boolean | undefined;
};

export type CouncilServiceJob = {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  events: CouncilEvent[];
  discussion?: CouncilDiscussionRound[];
  profile?: CouncilProfile;
  run?: CouncilRun;
  error?: string;
  artifacts?: CouncilArtifactPaths;
};

export type CouncilServiceOptions = {
  workspaceRoot?: string;
  harnessRoot?: string;
  runsRoot?: string;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  resolveTransport?: (
    profile: CouncilProfile,
  ) => (seat: CouncilSeat) => ModelTransport;
};

export function safeCouncilError(error: unknown): string {
  return sanitizeContent(
    error instanceof Error ? error.message : String(error),
    "redact",
  ).text.slice(0, 1000);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

export function createCouncilService(options: CouncilServiceOptions = {}) {
  const environment = options.environment ?? process.env;
  const harnessRoot = realpathSync(
    resolve(
      options.harnessRoot ?? fileURLToPath(new URL("../../", import.meta.url)),
    ),
  );
  const workspaceRoot = realpathSync(
    resolve(
      options.workspaceRoot ??
        environment.COUNCIL_WORKSPACE_ROOT ??
        process.cwd(),
    ),
  );
  const runsRoot = resolve(
    options.runsRoot ??
      environment.COUNCIL_RUNS_DIR ??
      join(workspaceRoot, "reports", "council-runs"),
  );
  const active = new Map<
    string,
    {
      job: CouncilServiceJob;
      controller: AbortController;
      done: Promise<CouncilServiceJob>;
      listeners: Set<(job: CouncilServiceJob) => void>;
    }
  >();
  let closed = false;

  function profilePath(path?: string): string {
    const candidate = realpathSync(
      path
        ? resolve(workspaceRoot, path)
        : join(harnessRoot, "councils", "default.json"),
    );
    if (
      (!inside(workspaceRoot, candidate) && !inside(harnessRoot, candidate)) ||
      !lstatSync(candidate).isFile()
    )
      throw new Error(
        "council profile must be a file inside the workspace or harness",
      );
    return candidate;
  }
  function profile(path?: string): CouncilProfile {
    const parsed = parseCouncilProfileJson(
      readFileSync(profilePath(path), "utf8"),
    );
    if (!parsed.ok) throw new Error(`invalid council profile: ${parsed.error}`);
    return parsed.value;
  }
  function readiness(input: { profile?: string | undefined } = {}) {
    const selected = profile(input.profile);
    return {
      profileId: selected.id,
      readiness: providerReadiness(selected, environment),
    };
  }
  function profiles() {
    const paths = new Set<string>();
    for (const root of [harnessRoot, workspaceRoot]) {
      const directory = join(root, "councils");
      if (existsSync(directory))
        for (const name of readdirSync(directory))
          if (name.endsWith(".json")) paths.add(join(directory, name));
    }
    return [...paths].flatMap((path) => {
      try {
        const selected = profile(path);
        return [
          {
            path,
            title: selected.title,
            id: selected.id,
            depth: selected.depth,
            maxEstimatedUsd: selected.maxEstimatedUsd,
            seats: selected.seats,
            chair: selected.chair,
            readiness: providerReadiness(selected, environment),
          },
        ];
      } catch {
        return [];
      }
    });
  }
  function snapshot(job: CouncilServiceJob): CouncilServiceJob {
    return structuredClone(job);
  }
  function get(runId: string): CouncilServiceJob {
    assertCouncilRunId(runId);
    const running = active.get(runId);
    if (running) return snapshot(running.job);
    const directory = resolveRunDirectory(runId, runsRoot);
    if (existsSync(join(directory, "manifest.json"))) {
      const run = readCouncilRun(runId, runsRoot);
      return {
        runId,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.finishedAt,
        events: run.events,
        discussion: run.discussion ?? [],
        profile: run.profile,
        run,
        ...(run.error ? { error: run.error } : {}),
        artifacts: {
          directory,
          manifest: join(directory, "manifest.json"),
          events: join(directory, "events.ndjson"),
          report: join(directory, "report.md"),
        },
      };
    }
    const terminal = existsSync(join(directory, "terminal.json"));
    const statePath = join(directory, terminal ? "terminal.json" : "job.json");
    if (lstatSync(statePath).isSymbolicLink())
      throw new Error("unsafe council job state");
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      throw new Error("invalid council job state");
    }
    if (
      !stored ||
      typeof stored !== "object" ||
      !("startedAt" in stored) ||
      typeof stored.startedAt !== "string"
    )
      throw new Error("invalid council job state");
    const state = stored as Record<string, unknown>;
    return {
      runId,
      status: terminal && state.status === "cancelled" ? "cancelled" : "failed",
      startedAt: stored.startedAt,
      updatedAt:
        typeof state.updatedAt === "string"
          ? state.updatedAt
          : stored.startedAt,
      events: [],
      error:
        terminal && typeof state.error === "string"
          ? safeCouncilError(state.error)
          : "Review was interrupted before completion; start a new run to retry.",
    };
  }
  function list(): CouncilServiceJob[] {
    return [...new Set([...listCouncilRunIds(runsRoot), ...active.keys()])]
      .flatMap((id) => {
        try {
          return [get(id)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100);
  }
  function start(input: CouncilServiceInput): CouncilServiceJob {
    if (closed) throw new Error("council service is closed");
    if (
      !input ||
      !["file", "plan", "pr", "text"].includes(input.sourceType) ||
      typeof input.source !== "string" ||
      !input.source.trim() ||
      Buffer.byteLength(input.source, "utf8") > 2_000_000
    )
      throw new Error(
        "source must be a nonempty supported input of at most 2 MB",
      );
    if (input.profile !== undefined && typeof input.profile !== "string")
      throw new Error("profile must be a path string");
    if (
      input.maxBytes !== undefined &&
      (!Number.isInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > 2_000_000)
    )
      throw new Error("maxBytes must be between 1 and 2000000");
    if (
      input.maxUsd !== undefined &&
      (!Number.isFinite(input.maxUsd) || input.maxUsd < 0)
    )
      throw new Error("maxUsd must be finite and nonnegative");
    if (
      input.redactSecrets !== undefined &&
      typeof input.redactSecrets !== "boolean"
    )
      throw new Error("redactSecrets must be a boolean");
    if (active.size >= 4)
      throw new Error("At most 4 council runs may execute concurrently");
    const selected = profile(input.profile);
    assertProvidersReady(selected, environment);
    if (input.runId !== undefined && typeof input.runId !== "string")
      throw new Error("runId must be a string");
    const runId =
      input.runId ?? `council-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const reservation = reserveCouncilRun(runId, runsRoot);
    const startedAt = new Date().toISOString();
    const job: CouncilServiceJob = {
      runId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      events: [],
      artifacts: reservation.paths,
      discussion: [],
      profile: selected,
    };
    writeFileSync(
      join(reservation.paths.directory, "job.json"),
      JSON.stringify({ runId, startedAt }),
      { flag: "wx", mode: 0o600 },
    );
    const controller = new AbortController();
    const listeners = new Set<(job: CouncilServiceJob) => void>();
    const publish = () => {
      job.updatedAt = new Date().toISOString();
      for (const listener of listeners) {
        try {
          listener(snapshot(job));
        } catch {}
      }
    };
    // Queue preparation after returning the handle, so network capture cannot
    // hold an MCP request open or bind the review to a client's request timer.
    const done = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) throw new Error("council run cancelled");
        const secretPolicy = input.redactSecrets ? "redact" : "reject";
        let contextInput: ContextInput;
        if (input.sourceType === "pr") {
          const compiled = await compilePullRequest(input.source, {
            cwd: workspaceRoot,
            secretPolicy,
          });
          contextInput = {
            kind: "pr",
            text: compiled.text,
            displayName: compiled.displayName,
            locator: compiled.locator,
            metadata: compiled.metadata,
            secretPolicy,
          };
        } else if (input.sourceType === "text")
          contextInput = {
            kind: "stdin",
            text: input.source,
            displayName: "Pasted review text",
            secretPolicy,
          };
        else
          contextInput = {
            kind: input.sourceType,
            path: input.source,
            cwd: workspaceRoot,
            secretPolicy,
          };
        if (input.maxBytes !== undefined)
          contextInput.maxBytes = input.maxBytes;
        const packed = buildContextPack(contextInput);
        const providerOptions: ProviderResolverOptions = { environment };
        if (options.fetchImpl) providerOptions.fetchImpl = options.fetchImpl;
        const engineOptions: Parameters<typeof runCouncil>[0] = {
          profile: selected,
          context: packed,
          runId,
          signal: controller.signal,
          resolveTransport: options.resolveTransport
            ? options.resolveTransport(selected)
            : createProviderResolver(providerOptions),
          onEvent: (event) => {
            job.events.push(event);
            publish();
          },
          onDiscussionRound: (round) => {
            job.discussion!.push(round);
            publish();
          },
        };
        if (input.maxUsd !== undefined) engineOptions.maxUsd = input.maxUsd;
        const result = await runCouncil(engineOptions);
        job.run = result.run;
        job.status = result.run.status;
        if (!result.ok) job.error = result.error;
        job.artifacts = writeCouncilArtifacts(
          result.run,
          runsRoot,
          reservation,
        );
      } catch (error) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.error = safeCouncilError(error);
        try {
          writeCouncilJobFailure(reservation, {
            runId,
            status: job.status,
            startedAt,
            updatedAt: new Date().toISOString(),
            error: job.error,
          });
        } catch (persistenceError) {
          job.error += `; failure record unavailable: ${safeCouncilError(persistenceError)}`;
        }
      }
      publish();
      const result = snapshot(job);
      active.delete(runId);
      listeners.clear();
      return result;
    });
    active.set(runId, { job, controller, done, listeners });
    return snapshot(job);
  }
  function cancel(runId: string): CouncilServiceJob {
    assertCouncilRunId(runId);
    const entry = active.get(runId);
    if (entry?.job.status === "running") entry.controller.abort();
    return get(runId);
  }
  function subscribe(
    runId: string,
    listener: (job: CouncilServiceJob) => void,
  ): () => void {
    assertCouncilRunId(runId);
    const entry = active.get(runId);
    if (!entry) {
      listener(get(runId));
      return () => {};
    }
    entry.listeners.add(listener);
    listener(snapshot(entry.job));
    return () => entry.listeners.delete(listener);
  }
  async function wait(runId: string): Promise<CouncilServiceJob> {
    assertCouncilRunId(runId);
    return active.get(runId)?.done ?? get(runId);
  }
  async function close() {
    closed = true;
    for (const entry of active.values())
      if (entry.job.status === "running") entry.controller.abort();
    await Promise.all([...active.values()].map((entry) => entry.done));
  }
  return {
    profiles,
    readiness,
    start,
    get,
    list,
    cancel,
    subscribe,
    wait,
    close,
  };
}
