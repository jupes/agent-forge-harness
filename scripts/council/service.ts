import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProjectCouncilAuthority,
  ProjectCouncilAuthorityResolver,
  ProjectCouncilOriginal,
  ProjectCouncilOriginalRead,
  ProjectCouncilReserveRequest,
  ProjectCouncilReceipt,
} from "../../types/project-council";
import {
  projectCouncilMetadata,
  projectCouncilHistorySchema,
  projectCouncilReceiptSchema,
  projectCouncilMetadataSchema,
  projectCouncilOriginalReadSchema,
  projectCouncilReserveRequestSchema,
} from "../../types/project-council";
import {
  MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES,
  projectCouncilRunRead,
  type ProjectCouncilRunProvenance,
} from "../../types/project-council-run-read";
import { parseBeadsIssueId } from "../run-correlation";
import { writeOwnerOnly } from "../hearth/token";
import {
  assertCouncilRunId,
  type CouncilArtifactPaths,
  listCouncilRunIds,
  parseStoredRun,
  readCouncilRun,
  reserveCouncilRun,
  resolveRunDirectory,
  writeCouncilJobFailure,
} from "./artifacts";
import { contextListing, sanitizeContent } from "./context";
import { councilOutcome, type CouncilAppend, type CouncilAttachResolver } from "./ledger-events";
import type { CommandRunner } from "./pr-source";
import {
  assertProvidersReady,
  providerEndpointSnapshot,
  providerReadiness,
} from "./providers";
import type {
  ContextRedaction,
  ContextSource,
  CouncilDiscussionRound,
  CouncilEvent,
  CouncilProfile,
  CouncilRun,
  CouncilSeat,
  ModelTransport,
} from "./types";
import { parseCouncilProfileJson } from "./types";
import {
  type CouncilReviewOptions,
  executeCouncilReview,
  loadCouncilProfile,
  prepareCouncilContext,
} from "./workflow";
import {
  createProjectCouncilOriginalStore,
  projectCouncilInputHash,
  projectCouncilProfileHash,
} from "./project-original-store";

export type CouncilServiceInput = {
  sourceType: "file" | "plan" | "pr" | "text" | "bead";
  source: string;
  profile?: string | undefined;
  maxUsd?: number | undefined;
  maxBytes?: number | undefined;
  runId?: string | undefined;
  redactSecrets?: boolean | undefined;
  /** The Beads issue the review is for; recorded on its ledger events. */
  beadId?: string | undefined;
};

/**
 * What a run on a source would send, without starting one: the pack's summary
 * and its listing, one line per part (`contextListing`), never the evidence.
 */
export type CouncilPreview = {
  source: Pick<ContextSource, "kind" | "displayName" | "locator">;
  byteLength: number;
  truncated: boolean;
  redactions: ContextRedaction[];
  listing: string[];
};

export type CouncilServiceJob = {
  runId: string;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  events: CouncilEvent[];
  discussion?: CouncilDiscussionRound[];
  profile?: CouncilProfile;
  run?: CouncilRun;
  error?: string;
  persistenceStatus?: "pending" | "saved" | "failed";
  persistenceError?: string;
  artifacts?: CouncilArtifactPaths;
};

export type CouncilServiceOptions = {
  workspaceRoot?: string;
  harnessRoot?: string;
  runsRoot?: string;
  /** Machine-private home for project-bound Council review originals. */
  reviewHome?: string;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  resolveTransport?: (
    profile: CouncilProfile,
  ) => (seat: CouncilSeat) => ModelTransport;
  /**
   * The ledger a run's started and finished events go to, and who they belong
   * to. Injected by the host — the MCP server, and the hearth when it runs as
   * a command — because this module never imports the ledger itself. Without
   * both, runs record nothing in the ledger.
   */
  appendEvent?: CouncilAppend;
  resolveAttach?: CouncilAttachResolver;
  /**
   * Runs `bd`, `git` and `gh` for the bead and pr sources; the local one when
   * absent. Tests hand in a fake, so no test reads the real tracker.
   */
  runCommand?: CommandRunner;
};

export function safeCouncilError(error: unknown): string {
  return sanitizeContent(
    error instanceof Error ? error.message : String(error),
    "redact",
  ).text.slice(0, 1000);
}

/**
 * The checks on a start request that need nothing but the request. Throws
 * what `start` has always thrown, in the order it always has, and after
 * those the two refusals of a bead source. A host that records something
 * before it starts a run (the hearth's audit row) calls this first, so a
 * malformed request is refused before anything is written.
 */
export function assertCouncilInput(input: CouncilServiceInput): void {
  if (
    !input ||
    !["file", "plan", "pr", "text", "bead"].includes(input.sourceType) ||
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
  if (
    input.beadId !== undefined &&
    (typeof input.beadId !== "string" || !input.beadId.trim())
  )
    throw new Error("beadId must be a nonempty string");
  if (input.sourceType === "bead") {
    // The bead under review is the bead the run is recorded against: a host
    // that audits the request first (the hearth) must be able to name it, and
    // no caller may have one bead packed and another one credited.
    const bead = parseBeadsIssueId(input.source);
    if (bead === null)
      throw new Error(
        "source must be a Beads issue id when the source is a bead",
      );
    if (input.beadId !== undefined && input.beadId !== bead)
      throw new Error(
        "beadId must name the bead under review when the source is a bead",
      );
  }
}

/**
 * A start request with every field named, present or not: the copy `start`
 * makes is typed as this, so a field added to `CouncilServiceInput` and left
 * out of the copy fails to compile instead of being dropped on the job path.
 */
type EveryField = {
  [K in keyof Required<CouncilServiceInput>]: CouncilServiceInput[K];
};

/**
 * One reading of each field of a start request, whatever kind of object the
 * caller handed over: its own fields and inherited ones, plain or computed.
 * The queued job runs after `start` returns and must use what was checked,
 * not what the caller's object says by then.
 */
function councilInputFrom(request: CouncilServiceInput): EveryField {
  if (
    request === null ||
    (typeof request !== "object" && typeof request !== "function")
  )
    return request;
  const {
    sourceType,
    source,
    profile,
    maxUsd,
    maxBytes,
    runId,
    redactSecrets,
    beadId,
  } = request;
  return {
    sourceType,
    source,
    profile,
    maxUsd,
    maxBytes,
    runId,
    redactSecrets,
    beadId,
  };
}

/**
 * The bead a run is recorded against: the one the caller named, else, for a
 * bead source, the bead under review. Only for an input that has passed
 * `assertCouncilInput`.
 */
export function councilBeadId(input: CouncilServiceInput): string | undefined {
  if (input.beadId !== undefined) return input.beadId;
  return input.sourceType === "bead"
    ? (parseBeadsIssueId(input.source) ?? undefined)
    : undefined;
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
      projectProvenance?: ReturnType<typeof projectRunProvenance>;
    }
  >();
  const projectStores = new Map<string, ReturnType<typeof createProjectCouncilOriginalStore>>();
  const projectOperations = new Set<Promise<unknown>>();
  let projectAdmissionReservations = 0;
  let projectAdmissionTail: Promise<void> = Promise.resolve();
  let closed = false;

  function projectStore(workspace: string, projectId: string) {
    if (!options.reviewHome)
      throw new Error("project Council reviews are unavailable on this host");
    const storeKey = `${workspace}\0${projectId}`;
    let store = projectStores.get(storeKey);
    if (!store) {
      store = createProjectCouncilOriginalStore({
        home: options.reviewHome,
        workspace,
        projectId,
      });
      projectStores.set(storeKey, store);
    }
    return store;
  }

  function trackProjectOperation<T>(work: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(work);
    projectOperations.add(pending);
    void pending.then(
      () => projectOperations.delete(pending),
      () => projectOperations.delete(pending),
    );
    return pending;
  }

  function withProjectAdmission<T>(work: () => Promise<T>): Promise<T> {
    const operation = projectAdmissionTail.then(work);
    projectAdmissionTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

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
    return loadCouncilProfile(profilePath(path));
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
    // The UI selects the first choice. Match a start that omits `profile`,
    // regardless of the filesystem's enumeration order or a workspace default.
    const defaultPath = join(harnessRoot, "councils", "default.json");
    const ordered = [...paths].sort((left, right) => {
      if (left === right) return 0;
      if (left === defaultPath) return -1;
      if (right === defaultPath) return 1;
      return left < right ? -1 : 1;
    });
    return ordered.flatMap((path) => {
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
    if (terminal && state.run && typeof state.run === "object") {
      const run = parseStoredRun(JSON.stringify(state.run));
      return {
        runId,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt:
          typeof state.updatedAt === "string"
            ? state.updatedAt
            : run.finishedAt,
        events: run.events,
        discussion: run.discussion ?? [],
        profile: run.profile,
        run,
        persistenceStatus: "failed",
        persistenceError:
          typeof state.persistenceError === "string"
            ? safeCouncilError(state.persistenceError)
            : "The completed result could not be saved as normal run artifacts.",
      };
    }
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
  /** The source packed as a run packs it: one path for a job and a preview. */
  function pack(input: CouncilServiceInput) {
    return prepareCouncilContext({
      kind: input.sourceType === "text" ? "stdin" : input.sourceType,
      source: input.source,
      workspaceRoot,
      secretPolicy: input.redactSecrets ? "redact" : "reject",
      maxBytes: input.maxBytes,
      ...(input.sourceType === "text"
        ? { displayName: "Pasted review text" }
        : {}),
      ...(options.runCommand ? { runner: options.runCommand } : {}),
    });
  }
  /**
   * What a run on this request would send, read now and listed part by part:
   * the same checks as `start`, the same pack, and nothing more. No run is
   * reserved, no model is called and nothing is recorded. The profile, the
   * cost ceiling and the run id do not change a pack and are not read.
   */
  async function preview(
    request: CouncilServiceInput,
  ): Promise<CouncilPreview> {
    if (closed) throw new Error("council service is closed");
    const input = councilInputFrom(request);
    assertCouncilInput(input);
    const packed = await pack(input);
    const { kind, displayName, locator } = packed.source;
    return {
      source: { kind, displayName, locator },
      byteLength: packed.byteLength,
      truncated: packed.truncated,
      redactions: packed.redactions,
      listing: contextListing(packed),
    };
  }
  function start(request: CouncilServiceInput): CouncilServiceJob {
    if (closed) throw new Error("council service is closed");
    // The caller's object is read here and nowhere else: `begin` checks and
    // runs the copy, and never sees the object itself.
    return begin(councilInputFrom(request));
  }
  function begin(input: CouncilServiceInput): CouncilServiceJob {
    assertCouncilInput(input);
    if (active.size + projectAdmissionReservations >= 4)
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
      persistenceStatus: "pending",
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
        const packed = await pack(input);
        const engineOptions: CouncilReviewOptions = {
          profile: selected,
          context: packed,
          runId,
          runsRoot,
          reservation,
          environment,
          signal: controller.signal,
          onResult: (result) => {
            job.run = result.run;
            job.status = result.run.status;
            if (!result.ok) job.error = result.error;
          },
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
        if (options.fetchImpl) engineOptions.fetchImpl = options.fetchImpl;
        if (options.resolveTransport)
          engineOptions.resolveTransport = options.resolveTransport(selected);
        if (options.appendEvent && options.resolveAttach) {
          try {
            const beadId = councilBeadId(input);
            engineOptions.attach = options.resolveAttach({
              cwd: workspaceRoot,
              ...(beadId !== undefined ? { beadId } : {}),
            });
            engineOptions.appendEvent = options.appendEvent;
          } catch {
            // A review runs whether or not its audit identity resolves.
          }
        }
        const { artifacts } = await executeCouncilReview(engineOptions);
        job.artifacts = artifacts;
        job.persistenceStatus = "saved";
      } catch (error) {
        const persistenceError = safeCouncilError(error);
        if (job.run) {
          job.status = job.run.status;
          job.persistenceStatus = "failed";
          job.persistenceError = persistenceError;
        } else {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.error = persistenceError;
        }
        try {
          writeCouncilJobFailure(reservation, {
            runId,
            status: job.status,
            startedAt,
            updatedAt: new Date().toISOString(),
            ...(job.error ? { error: job.error } : {}),
            ...(job.persistenceError
              ? { persistenceError: job.persistenceError }
              : {}),
            ...(job.run ? { run: job.run } : {}),
          });
        } catch (persistenceError) {
          const unavailable = `failure record unavailable: ${safeCouncilError(persistenceError)}`;
          if (job.persistenceError) job.persistenceError += `; ${unavailable}`;
          else job.error = `${job.error ?? "Review failed"}; ${unavailable}`;
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

  function projectAuthority(
    projectId: string,
    authority: ProjectCouncilAuthority,
    profileHash: string,
  ) {
    let root: string;
    try {
      root = realpathSync(resolve(authority.workspaceRoot));
    } catch {
      throw new Error("The served Council workspace could not be verified.");
    }
    if (
      authority.projectId !== projectId ||
      root !== workspaceRoot ||
      !authority.workspace ||
      authority.workspace.length > 1024 ||
      !Number.isSafeInteger(authority.catalogRevision) ||
      authority.catalogRevision < 0 ||
      !/^[a-f0-9]{64}$/.test(authority.scopeHash)
    )
      throw new Error("The current project Council scope could not be verified.");
    return {
      projectId,
      workspace: authority.workspace,
      catalogRevision: authority.catalogRevision,
      scopeHash: authority.scopeHash,
      profileHash,
    };
  }

  function selectedProjectProfile(path: string): CouncilProfile {
    if (!profiles().some((choice) => choice.path === path))
      throw new Error("Choose a currently advertised Council profile.");
    return profile(path);
  }

  function projectProfileChoice(path: string, deepDiscussion: boolean): CouncilProfile {
    const selected = selectedProjectProfile(path);
    if (deepDiscussion && selected.minPeerBallots < 1)
      throw new Error("This profile cannot support deep discussion because it has no peer ballots.");
    const raw: Record<string, unknown> = {
      ...selected,
      depth: deepDiscussion ? "deep" : selected.depth === "quick" ? "quick" : "balanced",
    };
    if (deepDiscussion) raw.maxDiscussionRounds = selected.depth === "deep" ? selected.maxDiscussionRounds ?? 1 : 1;
    else delete raw.maxDiscussionRounds;
    const parsed = parseCouncilProfileJson(JSON.stringify(raw));
    if (!parsed.ok) throw new Error(`This profile does not support the selected discussion depth: ${parsed.error}`);
    return parsed.value;
  }

  function originalSourceRef(original: ProjectCouncilOriginal) {
    return {
      sourceType:
        original.context.source.kind === "stdin"
          ? ("text" as const)
          : original.context.source.kind,
      source: original.context.source.locator,
    };
  }

  function projectReceipt(original: ProjectCouncilOriginal): ProjectCouncilReceipt {
    const entry = active.get(original.runId);
    const job = entry && sameProjectRun(entry, original) ? entry.job : undefined;
    const phase: ProjectCouncilReceipt["phase"] =
      original.state === "reserved"
        ? "reserved"
        : original.state === "retired"
          ? "retired"
          : original.state === "completed" ||
              original.state === "failed" ||
              original.state === "cancelled"
            ? original.state
            : job && ["running", "cancelling"].includes(job.status)
              ? "running"
              : "unknown";
    return {
      metadata: projectCouncilMetadata(original),
      phase,
      ...(phase === "failed" && job?.error
        ? { error: safeCouncilError(job.error) }
        : {}),
    };
  }

  function projectRunProvenance(original: ProjectCouncilOriginal): ProjectCouncilRunProvenance {
    return {
      version: 1,
      requestId: original.requestId,
      intentHash: original.intentHash,
      runId: original.runId,
      projectId: original.binding.projectId,
      workspace: original.binding.workspace,
      catalogRevision: original.binding.catalogRevision,
      scopeHash: original.binding.scopeHash,
    };
  }

  function sameProjectRun(
    entry: NonNullable<ReturnType<typeof active.get>>,
    original: ProjectCouncilOriginal,
  ): boolean {
    const expected = projectRunProvenance(original);
    const actual = entry.projectProvenance;
    return !!actual && JSON.stringify(actual) === JSON.stringify(expected);
  }

  function projectJobMatchesOriginal(
    job: CouncilServiceJob,
    original: ProjectCouncilOriginal,
  ): boolean {
    if (
      job.runId !== original.runId ||
      (job.profile !== undefined && JSON.stringify(job.profile) !== JSON.stringify(original.profile))
    ) return false;
    const run = job.run;
    if (!run) return true;
    const expected = original.context;
    return run.runId === original.runId &&
      JSON.stringify(run.profile) === JSON.stringify(original.profile) &&
      run.context.contentHash === expected.contentHash &&
      run.context.byteLength === expected.byteLength &&
      run.context.truncated === expected.truncated &&
      JSON.stringify(run.context.source) === JSON.stringify(expected.source) &&
      JSON.stringify(run.context.redactions) === JSON.stringify(expected.redactions) &&
      JSON.stringify(run.context.evidence) === JSON.stringify(expected.evidence);
  }

  function readOwnedProjectFile(directory: string, file: string, maxBytes: number): string {
    let descriptor: number | null = null;
    try {
      const rootReal = realpathSync(runsRoot);
      const directoryReal = realpathSync(directory);
      const pathStat = lstatSync(file);
      if (
        !inside(rootReal, directoryReal) ||
        dirname(directoryReal) !== rootReal ||
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        pathStat.nlink !== 1 ||
        pathStat.size > maxBytes ||
        realpathSync(file) !== resolve(file)
      ) throw new Error("unsafe or oversized project Council result");
      descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes ||
        opened.dev !== pathStat.dev || opened.ino !== pathStat.ino ||
        realpathSync(directory) !== directoryReal ||
        realpathSync(file) !== resolve(file)
      ) throw new Error("project Council result identity changed");
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(descriptor, bytes, length, bytes.length - length, length);
        if (read === 0) break;
        length += read;
      }
      if (length > maxBytes || length !== opened.size)
        throw new Error("project Council result exceeded its read ceiling");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  function readProjectJob(original: ProjectCouncilOriginal): CouncilServiceJob {
    const directory = resolveRunDirectory(original.runId, runsRoot);
    const manifest = join(directory, "manifest.json");
    const terminal = join(directory, "terminal.json");
    const statePath = existsSync(manifest) ? manifest : terminal;
    const text = readOwnedProjectFile(directory, statePath, MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES);
    if (statePath === manifest) {
      const run = parseStoredRun(text);
      if (run.runId !== original.runId)
        throw new Error("project Council manifest identity changed");
      return {
        runId: run.runId,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.finishedAt,
        events: run.events,
        discussion: run.discussion ?? [],
        profile: run.profile,
        run,
      };
    }
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("invalid project Council terminal record");
    const state = raw as Record<string, unknown>;
    if (state.run && typeof state.run === "object") {
      const run = parseStoredRun(JSON.stringify(state.run));
      if (run.runId !== original.runId || state.status !== run.status)
        throw new Error("project Council terminal result identity changed");
      return {
        runId: run.runId,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : run.finishedAt,
        events: run.events,
        discussion: run.discussion ?? [],
        profile: run.profile,
        run,
        persistenceStatus: "failed",
        persistenceError: typeof state.persistenceError === "string" ? safeCouncilError(state.persistenceError) : "The completed result could not be saved as normal run artifacts.",
      };
    }
    if (
      typeof state.startedAt !== "string" ||
      state.runId !== original.runId ||
      (state.status !== "failed" && state.status !== "cancelled") ||
      state.status !== original.state
    )
      throw new Error("invalid project Council terminal record");
    return {
      runId: original.runId,
      status: state.status,
      startedAt: state.startedAt,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : state.startedAt,
      events: [],
      ...(typeof state.error === "string" ? { error: safeCouncilError(state.error) } : {}),
    };
  }

  async function queueProjectReview(
    original: ProjectCouncilOriginal,
    store: ReturnType<typeof createProjectCouncilOriginalStore>,
  ): Promise<CouncilServiceJob> {
    if (closed) throw new Error("council service is closed");
    const reservation = reserveCouncilRun(original.runId, runsRoot);
    writeOwnerOnly(
      join(reservation.paths.directory, "project-review-provenance.json"),
      JSON.stringify(projectRunProvenance(original)),
    );
    writeFileSync(
      join(reservation.paths.directory, "job.json"),
      JSON.stringify({ runId: original.runId, startedAt: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    await store.markRunning(
      original.binding.projectId,
      original.requestId,
      original.intentHash,
    );
    const startedAt = new Date().toISOString();
    const job: CouncilServiceJob = {
      runId: original.runId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      events: [],
      artifacts: reservation.paths,
      discussion: [],
      profile: structuredClone(original.profile),
      persistenceStatus: "pending",
    };
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
    const done = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) throw new Error("council run cancelled");
        const engineOptions: CouncilReviewOptions = {
          profile: original.profile,
          context: original.context,
          runId: original.runId,
          runsRoot,
          reservation,
          environment,
          providerEndpoints: original.providerEndpoints,
          signal: controller.signal,
          onResult: (result) => {
            job.run = result.run;
            job.status = result.run.status;
            if (!result.ok) job.error = result.error;
          },
          onEvent: (event) => {
            job.events.push(event);
            publish();
          },
          onDiscussionRound: (round) => {
            job.discussion!.push(round);
            publish();
          },
        };
        engineOptions.maxUsd = original.options.maxUsd;
        if (options.fetchImpl) engineOptions.fetchImpl = options.fetchImpl;
        if (options.resolveTransport)
          engineOptions.resolveTransport = options.resolveTransport(original.profile);
        const beadId =
          original.context.source.kind === "bead"
            ? original.context.source.locator
            : undefined;
        if (options.appendEvent && options.resolveAttach) {
          try {
            engineOptions.attach = options.resolveAttach({
              cwd: workspaceRoot,
              ...(beadId !== undefined ? { beadId } : {}),
            });
            engineOptions.appendEvent = options.appendEvent;
          } catch {
            // A review runs whether or not its audit identity resolves.
          }
        }
        const { artifacts } = await executeCouncilReview(engineOptions);
        job.artifacts = artifacts;
        job.persistenceStatus = "saved";
      } catch (error) {
        const persistenceError = safeCouncilError(error);
        if (job.run) {
          job.status = job.run.status;
          job.persistenceStatus = "failed";
          job.persistenceError = persistenceError;
        } else {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.error = persistenceError;
        }
        try {
          writeCouncilJobFailure(reservation, {
            runId: original.runId,
            status: job.status,
            startedAt,
            updatedAt: new Date().toISOString(),
            ...(job.error ? { error: job.error } : {}),
            ...(job.persistenceError
              ? { persistenceError: job.persistenceError }
              : {}),
            ...(job.run ? { run: job.run } : {}),
          });
        } catch (persistenceError) {
          const unavailable = `failure record unavailable: ${safeCouncilError(persistenceError)}`;
          if (job.persistenceError) job.persistenceError += `; ${unavailable}`;
          else job.error = `${job.error ?? "Review failed"}; ${unavailable}`;
        }
      }
      if (job.run) {
        const terminal =
          job.run.status === "completed"
            ? "completed"
            : job.run.status === "cancelled"
              ? "cancelled"
              : "failed";
        try {
          await store.setTerminal(
            original.binding.projectId,
            original.requestId,
            original.intentHash,
            terminal,
          );
        } catch {
          // Keep the dispatch claim: a missing terminal write is uncertainty, not NotSent.
        }
      }
      publish();
      const result = snapshot(job);
      active.delete(original.runId);
      listeners.clear();
      return result;
    });
    active.set(original.runId, {
      job,
      controller,
      done,
      listeners,
      projectProvenance: projectRunProvenance(original),
    });
    return snapshot(job);
  }

  function reserveProjectReview(
    projectId: string,
    rawRequest: ProjectCouncilReserveRequest,
    resolveAuthority: ProjectCouncilAuthorityResolver,
  ) {
    return trackProjectOperation(async () => {
      if (closed) throw new Error("council service is closed");
      const parsed = projectCouncilReserveRequestSchema.safeParse(rawRequest);
      if (!parsed.success) throw new Error("Expected a strict project Council review choice.");
      const request = parsed.data;
      const inputHash = projectCouncilInputHash({ projectId, ...request });
      const authority = await resolveAuthority(projectId, request.sourceChoice);
      const selected = projectProfileChoice(request.profileChoice, request.deepDiscussion);
      const binding = projectAuthority(
        projectId,
        authority,
        projectCouncilProfileHash(selected),
      );
      const store = projectStore(binding.workspace, projectId);
      const existing = await store.findActive(projectId, binding, inputHash);
      if (existing)
        return { metadata: projectCouncilMetadata(existing), created: false };
      assertProvidersReady(selected, environment);
      const providerEndpoints = providerEndpointSnapshot(selected, environment);
      const packed = await prepareCouncilContext({
        kind: request.sourceChoice.sourceType === "text"
          ? "stdin"
          : request.sourceChoice.sourceType,
        source: request.sourceChoice.source,
        workspaceRoot,
        secretPolicy: request.redactSecrets ? "redact" : "reject",
        maxBytes: request.maxBytes,
        ...(request.sourceChoice.sourceType === "text"
          ? { displayName: "Pasted review text" }
          : {}),
        ...(options.runCommand ? { runner: options.runCommand } : {}),
      });
      const currentAuthority = await resolveAuthority(projectId, {
        sourceType:
          packed.source.kind === "stdin" ? "text" : packed.source.kind,
        source: packed.source.locator,
      });
      const currentProfile = projectProfileChoice(request.profileChoice, request.deepDiscussion);
      const currentBinding = projectAuthority(
        projectId,
        currentAuthority,
        projectCouncilProfileHash(currentProfile),
      );
      if (
        JSON.stringify(currentBinding) !== JSON.stringify(binding) ||
        JSON.stringify(currentProfile) !== JSON.stringify(selected)
      )
        throw new Error("The project scope or Council profile changed during review preparation. Prepare the current choice again.");
      assertProvidersReady(currentProfile, environment);
      if (closed) throw new Error("council service is closing; no review was reserved");
      const listing = contextListing(packed);
      const probeId = "00000000-0000-4000-8000-000000000000";
      const now = new Date().toISOString();
      projectCouncilMetadataSchema.parse({
        requestId: probeId,
        runId: `council-review-${probeId}`,
        intentHash: "0".repeat(64),
        projectId,
        state: "reserved",
        sourceType: packed.source.kind === "stdin" ? "text" : packed.source.kind,
        sourceName: packed.source.displayName,
        listing,
        byteLength: packed.byteLength,
        truncated: packed.truncated,
        redactions: packed.redactions,
        profileId: currentProfile.id,
        profileTitle: currentProfile.title,
        maxUsd: request.maxUsd,
        maxBytes: request.maxBytes,
        redactSecrets: request.redactSecrets,
        deepDiscussion: request.deepDiscussion,
        createdAt: now,
        updatedAt: now,
      });
      const reserved = await store.reservePrepared({
        binding,
        inputHash,
        profileChoice: request.profileChoice,
        profile: currentProfile,
        providerEndpoints,
        context: packed,
        listing,
        options: {
          maxUsd: request.maxUsd,
          maxBytes: request.maxBytes,
          redactSecrets: request.redactSecrets,
          deepDiscussion: request.deepDiscussion,
        },
      });
      return {
        metadata: projectCouncilMetadata(reserved.original),
        created: reserved.created,
      };
    });
  }

  function discoverProjectReview(projectId: string, workspace: string) {
    const found = projectStore(workspace, projectId).discover(projectId);
    return found ? projectCouncilMetadata(found) : null;
  }

  function historyProjectReviews(projectId: string, workspace: string) {
    return projectCouncilHistorySchema.parse(
      projectStore(workspace, projectId).history(projectId),
    );
  }

  function readProjectOriginal(
    projectId: string,
    workspace: string,
    requestId: string,
  ): ProjectCouncilOriginalRead {
    const original = projectStore(workspace, projectId).read(projectId, requestId);
    return projectCouncilOriginalReadSchema.parse({
      metadata: projectCouncilMetadata(original),
      original: structuredClone(original),
    });
  }

  async function retireProjectReview(
    projectId: string,
    workspace: string,
    requestId: string,
    intentHash: string,
  ) {
    const original = await projectStore(workspace, projectId).retire(
      projectId,
      requestId,
      intentHash,
    );
    return projectReceipt(original);
  }

  async function commitProjectReview(
    projectId: string,
    workspace: string,
    requestId: string,
    intentHash: string,
    resolveAuthority: ProjectCouncilAuthorityResolver,
  ) {
    return trackProjectOperation(() => withProjectAdmission(async () => {
      if (closed) throw new Error("council service is closed");
      const store = projectStore(workspace, projectId);
      const original = store.read(projectId, requestId);
      if (original.intentHash !== intentHash)
        throw new Error("The Council original hash does not match.");
      const alreadyClaimed = original.state !== "reserved";
      if (!alreadyClaimed && active.size + projectAdmissionReservations >= 4)
        throw new Error("At most 4 council runs may execute concurrently");
      if (!alreadyClaimed) projectAdmissionReservations += 1;
      try {
        const claimed = await store.claimDispatch(
          projectId,
          requestId,
          intentHash,
          async (candidate) => {
            const sourceRef = originalSourceRef(candidate);
            const authority = await resolveAuthority(projectId, sourceRef);
            const selected = projectProfileChoice(candidate.profileChoice, candidate.options.deepDiscussion);
            const binding = projectAuthority(
              projectId,
              authority,
              projectCouncilProfileHash(selected),
            );
            if (
              JSON.stringify(binding) !== JSON.stringify(candidate.binding) ||
              JSON.stringify(selected) !== JSON.stringify(candidate.profile)
            )
              throw new Error("The reviewed project scope or profile changed. No provider was called.");
            assertProvidersReady(selected, environment);
            const currentEndpoints = providerEndpointSnapshot(selected, environment);
            if (JSON.stringify(currentEndpoints) !== JSON.stringify(candidate.providerEndpoints))
              throw new Error("The reviewed provider endpoint configuration changed. No provider was called.");
            if (existsSync(resolveRunDirectory(candidate.runId, runsRoot)))
              throw new Error("The reviewed Council run identity is already owned by another run.");
          },
        );
        if (!claimed.created)
          return { receipt: projectReceipt(claimed.original), created: false };
        try {
          await queueProjectReview(claimed.original, store);
        } catch {
          // The durable dispatch claim is authoritative; a lost launch outcome is not retried.
        }
        return { receipt: projectReceipt(store.read(projectId, requestId)), created: true };
      } finally {
        if (!alreadyClaimed) projectAdmissionReservations -= 1;
      }
    }));
  }

  async function cancelProjectReview(
    projectId: string,
    workspace: string,
    requestId: string,
    intentHash: string,
  ) {
    const store = projectStore(workspace, projectId);
    const original = store.read(projectId, requestId);
    if (original.intentHash !== intentHash)
      throw new Error("The Council original hash does not match.");
    const current = active.get(original.runId);
    if (!current || !sameProjectRun(current, original))
      return projectReceipt(original);
    if (!current || !["running", "cancelling"].includes(current.job.status))
      return projectReceipt(original);
    if (current.job.status === "running") {
      current.job.status = "cancelling";
      current.job.updatedAt = new Date().toISOString();
      current.controller.abort();
    }
    await current.done;
    return projectReceipt(store.read(projectId, requestId));
  }

  function ownsProjectRun(original: ProjectCouncilOriginal): boolean {
    try {
      const directory = resolveRunDirectory(original.runId, runsRoot),
        file = join(directory, "project-review-provenance.json");
      const rawText = readOwnedProjectFile(directory, file, 4096);
      const raw: unknown = JSON.parse(rawText);
      return (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw) &&
        JSON.stringify(raw) === JSON.stringify(projectRunProvenance(original))
      );
    } catch {
      return false;
    }
  }

  function councilVerdictCommentPreview(job: CouncilServiceJob): string | null {
    const run = job.run;
    if (job.status !== "completed" || !run || run.status !== "completed") return null;
    const severities = ["blocker", "high", "medium", "low"] as const;
    const counts = severities.map((severity) =>
      run.aggregatedFindings.filter((finding) => finding.severity === severity).length,
    );
    return `review: COUNCIL ${job.runId} ${councilOutcome(run).toUpperCase()} — findings ${counts.join("/")} (${severities.join("/")})`;
  }

  function readProjectRun(
    projectId: string,
    workspace: string,
    requestId: string,
    intentHash: string,
  ) {
    const original = projectStore(workspace, projectId).read(projectId, requestId);
    if (original.intentHash !== intentHash)
      throw new Error("The Council original hash does not match.");
    const provenance = projectRunProvenance(original) satisfies ProjectCouncilRunProvenance;
    const unknown = () => {
      const receipt = projectCouncilReceiptSchema.parse({
        ...projectReceipt(original),
        phase:
          original.state === "reserved" || original.state === "retired"
            ? original.state
            : "unknown",
      });
      return projectCouncilRunRead(provenance, receipt, null, null);
    };
    const running = active.get(original.runId);
    if (running && sameProjectRun(running, original)) {
      const job = snapshot(running.job);
      if (!projectJobMatchesOriginal(job, original))
        return unknown();
      const receipt = projectCouncilReceiptSchema.parse(projectReceipt(original));
      return projectCouncilRunRead(
        provenance,
        receipt,
        job,
        councilVerdictCommentPreview(job),
      );
    }
    if (
      ["completed", "failed", "cancelled"].includes(original.state) &&
      ownsProjectRun(original)
    ) {
      const job = readProjectJob(original);
      if (!projectJobMatchesOriginal(job, original))
        return unknown();
      const receipt = projectCouncilReceiptSchema.parse(projectReceipt(original));
      return projectCouncilRunRead(
        provenance,
        receipt,
        job,
        councilVerdictCommentPreview(job),
      );
    }
    return unknown();
  }
  function cancel(runId: string): CouncilServiceJob {
    assertCouncilRunId(runId);
    const entry = active.get(runId);
    if (entry?.job.status === "running") {
      entry.job.status = "cancelling";
      entry.job.updatedAt = new Date().toISOString();
      for (const listener of entry.listeners) listener(snapshot(entry.job));
      entry.controller.abort();
    }
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
      if (["running", "cancelling"].includes(entry.job.status))
        entry.controller.abort();
    await Promise.all([...projectOperations]);
    await Promise.all([...active.values()].map((entry) => entry.done));
  }
  return {
    profiles,
    readiness,
    preview,
    start,
    get,
    list,
    cancel,
    subscribe,
    wait,
    reserveProjectReview,
    discoverProjectReview,
    historyProjectReviews,
    readProjectOriginal,
    readProjectRun,
    retireProjectReview,
    commitProjectReview,
    cancelProjectReview,
    close,
  };
}
