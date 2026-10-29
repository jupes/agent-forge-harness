import { useEffect, useRef, useState } from "preact/hooks";
import { appStream } from "../../../docs/js/use-stream";
import {
  type ProjectCouncilOriginalRead,
  type ProjectCouncilReserveRequest,
  projectCouncilIntentJson,
  projectCouncilOriginalReadSchema,
  projectCouncilRequestIdSchema,
  projectCouncilReserveRequestSchema,
} from "../../../types/project-council";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../../types/project-council-run-read";
import {
  createProjectCouncilTransport,
  type ProjectCouncilHistory,
  type ProjectCouncilProfileChoice,
  type ProjectCouncilTransport,
} from "./project-council-transport";

export type ProjectCouncilPhase =
  | "loading"
  | "ready"
  | "preparing"
  | "reserved"
  | "committing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "held"
  | "retiring";
export interface ProjectCouncilView {
  projectId: string;
  workspace: string | null;
  phase: ProjectCouncilPhase;
  profiles: ProjectCouncilProfileChoice[];
  history: ProjectCouncilHistory | null;
  original: ProjectCouncilOriginalRead | null;
  run: ProjectCouncilRunRead | null;
  runLoading: boolean;
  error: string;
}

export interface ProjectCouncilOwner {
  get(): ProjectCouncilView;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  prepare(request: ProjectCouncilReserveRequest): Promise<void>;
  retire(requestId: string, intentHash: string): Promise<void>;
  openSaved(requestId: string): Promise<void>;
  openResult(requestId: string): Promise<void>;
  convene(requestId: string, intentHash: string): Promise<void>;
  readRun(): Promise<void>;
  cancel(requestId: string, intentHash: string): Promise<void>;
  newDraft(): void;
  dispose(): void;
}

export interface ProjectCouncilTransportInput extends ProjectCouncilTransport {}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The saved review could not be verified.";
}

function publishedContextMatches(
  published: NonNullable<
    NonNullable<ProjectCouncilRunRead["job"]>["run"]
  >["context"],
  original: ProjectCouncilOriginalRead["original"]["context"],
): boolean {
  const expected = {
    source: original.source,
    contentHash: original.contentHash,
    byteLength: original.byteLength,
    truncated: original.truncated,
    redactions: original.redactions,
    evidence: original.evidence,
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value !== null) {
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  return canonical(published) === canonical(expected);
}

async function verifyOriginal(
  value: unknown,
  projectId: string,
  workspace: string | null,
  requestId?: string,
): Promise<ProjectCouncilOriginalRead> {
  const result = projectCouncilOriginalReadSchema.parse(value);
  const { metadata, original } = result;
  if (
    metadata.projectId !== projectId ||
    original.binding.projectId !== projectId ||
    workspace === null ||
    original.binding.workspace !== workspace ||
    (requestId !== undefined && original.requestId !== requestId) ||
    metadata.requestId !== original.requestId ||
    metadata.intentHash !== original.intentHash
  )
    throw Error(
      "The saved original belongs to a different project or workspace.",
    );
  const expected = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(projectCouncilIntentJson(original)),
  );
  const hash = [...new Uint8Array(expected)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== original.intentHash)
    throw Error(
      "The saved original hash does not match its reviewed contents.",
    );
  return result;
}

export function createProjectCouncilOwner(
  projectId: string,
  workspace: string | null,
  transport: ProjectCouncilTransportInput = createProjectCouncilTransport(),
): ProjectCouncilOwner {
  let view: ProjectCouncilView = {
    projectId,
    workspace,
    phase: "loading",
    profiles: [],
    history: null,
    original: null,
    run: null,
    runLoading: false,
    error: "",
  };
  let disposed = false;
  let generation = 0;
  let selectionGeneration = 0;
  let actionGeneration = 0;
  let metadataAbort: AbortController | null = null;
  let metadataRefreshes = 0;
  const privateAborts = new Set<AbortController>();
  let ownedActivity = 0;
  let refreshPending = false;
  let runGeneration = 0;
  let runAbort: AbortController | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  let runDelay = 2_000;
  const stopRunFollow = () => {
    runGeneration++;
    if (runTimer !== null) clearTimeout(runTimer);
    runTimer = null;
    runAbort?.abort();
    runAbort = null;
  };
  const listeners = new Set<() => void>();
  const paint = (change: Partial<ProjectCouncilView>) => {
    if (disposed) return;
    view = { ...view, ...change };
    for (const listener of listeners) listener();
  };

  const assertHistoryOwner = (history: ProjectCouncilHistory) => {
    if (
      history.version !== 1 ||
      history.projectId !== projectId ||
      (workspace !== null && history.workspace !== workspace)
    ) {
      throw Error(
        "Saved Council history belongs to a different project or workspace.",
      );
    }
    if (
      history.activeRequestId !== null &&
      !history.items.some((item) => item.requestId === history.activeRequestId)
    ) {
      throw Error(
        "The active saved review is missing from the scoped history response.",
      );
    }
  };

  const protectedRead = async <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const abort = new AbortController();
    privateAborts.add(abort);
    const deadline = setTimeout(() => abort.abort(), 6_000);
    try {
      return await work(abort.signal);
    } finally {
      clearTimeout(deadline);
      privateAborts.delete(abort);
    }
  };

  const metadataRead = async <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    metadataAbort?.abort();
    const abort = new AbortController();
    metadataAbort = abort;
    const deadline = setTimeout(() => abort.abort(), 6_000);
    try {
      return await work(abort.signal);
    } finally {
      clearTimeout(deadline);
      if (metadataAbort === abort) metadataAbort = null;
    }
  };

  const refresh = async () => {
    if (ownedActivity > 0) {
      refreshPending = true;
      return;
    }
    if (
      disposed ||
      view.phase === "preparing" ||
      view.phase === "committing" ||
      view.phase === "retiring"
    )
      return;
    const current = ++generation;
    metadataRefreshes++;
    try {
      const [profiles, history] = await metadataRead((signal) =>
        Promise.all([
          transport.profiles(signal),
          transport.history(projectId, signal),
        ]),
      );
      assertHistoryOwner(history);
      if (disposed || current !== generation) return;
      paint({ profiles, history });
      const activeId = history.activeRequestId;
      if (activeId !== null) {
        if (!projectCouncilRequestIdSchema.safeParse(activeId).success)
          throw Error("The active saved review ID is invalid.");
        const row = history.items.find((item) => item.requestId === activeId);
        const historyState = row?.state;
        if (disposed || current !== generation) return;
        const saved = view.original?.original;
        const alreadyReviewed =
          saved !== undefined &&
          row !== undefined &&
          saved.requestId === activeId &&
          row.runId === saved.runId &&
          row.intentHash === saved.intentHash &&
          saved.state === historyState;
        if (alreadyReviewed) {
          paint({ history });
        } else if (view.original) {
          paint({
            history,
            run: null,
            runLoading: false,
            phase: "held",
            error:
              "Saved review metadata changed. Read this exact saved original before continuing.",
          });
        } else {
          paint({
            history,
            phase: historyState === "reserved" ? "reserved" : "held",
            error:
              "Read the saved original to verify its current contents and state.",
          });
        }
      } else if (view.original) {
        const row = history.items.find(
          (item) => item.requestId === view.original?.original.requestId,
        );
        const saved = view.original.original;
        if (
          !row ||
          row.runId !== saved.runId ||
          row.intentHash !== saved.intentHash ||
          row.state !== saved.state ||
          ["reserved", "dispatch-claimed", "running"].includes(saved.state)
        ) {
          paint({
            history,
            run: null,
            runLoading: false,
            phase: "held",
            error:
              "Saved review state changed. Read this exact saved original before continuing.",
          });
        } else paint({ history });
      } else if (view.phase !== "held") {
        paint({ history, phase: "ready", error: "" });
      } else {
        paint({ history });
      }
      // An empty history is never proof that a previously sent reserve was absent.
    } catch (error) {
      if (disposed || current !== generation) return;
      paint({
        phase: view.history?.activeRequestId
          ? "held"
          : view.phase === "loading"
            ? "held"
            : view.phase,
        error: message(error),
      });
    } finally {
      metadataRefreshes--;
    }
  };

  const beginOwnedActivity = () => {
    ownedActivity++;
    generation++;
    if (metadataRefreshes > 0) {
      refreshPending = true;
      metadataAbort?.abort();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ownedActivity--;
      if (ownedActivity === 0 && refreshPending) {
        refreshPending = false;
        void refresh();
      }
    };
  };

  const prepare = async (request: ProjectCouncilReserveRequest) => {
    if (
      disposed ||
      workspace === null ||
      view.phase !== "ready" ||
      view.history?.activeRequestId
    )
      return;
    const parsedRequest = projectCouncilReserveRequestSchema.safeParse(request);
    const selectedProfile = view.profiles.find(
      (profile) => profile.path === request.profileChoice,
    );
    if (
      !parsedRequest.success ||
      !selectedProfile ||
      !selectedProfile.readiness.every((item) => item.configured)
    ) {
      paint({
        error:
          "Choose a valid, locally configured Council profile before preparing an original.",
      });
      return;
    }
    const action = ++actionGeneration;
    const selection = selectionGeneration;
    const finish = beginOwnedActivity();
    paint({ phase: "preparing", error: "", original: null });
    try {
      const reserved = await transport.reserve(projectId, parsedRequest.data);
      const verified = await verifyOriginal(
        await protectedRead((signal) =>
          transport.original(projectId, reserved.metadata.requestId, signal),
        ),
        projectId,
        workspace,
        reserved.metadata.requestId,
      );
      if (
        reserved.metadata.projectId !== projectId ||
        verified.metadata.intentHash !== reserved.metadata.intentHash ||
        verified.original.state !== "reserved"
      )
        throw Error(
          "The prepared original did not match the reservation response.",
        );
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration
      )
        return;
      paint({ original: verified, phase: "reserved", error: "" });
      void refresh();
    } catch (error) {
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration
      )
        return;
      paint({
        phase: "held",
        error: `${message(error)} Check saved review before trying again.`,
      });
      void refresh();
    } finally {
      finish();
    }
  };

  const retire = async (requestId: string, intentHash: string) => {
    const saved = view.original;
    if (
      disposed ||
      workspace === null ||
      view.phase !== "reserved" ||
      !saved ||
      saved.original.state !== "reserved" ||
      saved.original.requestId !== requestId ||
      saved.original.intentHash !== intentHash
    )
      return;
    const action = ++actionGeneration;
    const selection = selectionGeneration;
    const finish = beginOwnedActivity();
    paint({ phase: "retiring", error: "" });
    try {
      const receipt = await transport.retire(
        projectId,
        saved.original.requestId,
        saved.original.intentHash,
      );
      if (
        receipt.metadata.requestId !== saved.original.requestId ||
        receipt.metadata.intentHash !== saved.original.intentHash ||
        receipt.metadata.projectId !== projectId ||
        receipt.metadata.runId !== saved.original.runId ||
        receipt.phase !== "retired"
      )
        throw Error("The retirement receipt did not match the saved review.");
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration ||
        view.original?.original.requestId !== requestId ||
        view.original.original.intentHash !== intentHash
      )
        return;
      stopRunFollow();
      paint({
        history: view.history,
        original: null,
        run: null,
        phase: "held",
        error:
          "Retirement is verified. Check saved history before preparing another original.",
      });
      const history = await protectedRead((signal) =>
        transport.history(projectId, signal),
      );
      assertHistoryOwner(history);
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration
      )
        return;
      if (history.activeRequestId !== null)
        throw Error(
          "Another saved review is active after retirement. Check its exact original before preparing again.",
        );
      paint({ history, original: null, run: null, phase: "ready", error: "" });
    } catch (error) {
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration
      )
        return;
      paint({
        phase: "held",
        error: `${message(error)} Check saved review before trying again.`,
      });
    } finally {
      finish();
    }
  };

  const openSaved = async (requestId: string) => {
    if (
      disposed ||
      !(
        view.history?.activeRequestId === requestId ||
        view.history?.items.some((item) => item.requestId === requestId)
      )
    )
      return;
    selectionGeneration++;
    actionGeneration++;
    if (workspace === null) {
      paint({
        phase: "held",
        error:
          "The current served project workspace is not available. Check the project before reading its original.",
      });
      return;
    }
    const finish = beginOwnedActivity();
    const current = ++generation;
    stopRunFollow();
    paint({ phase: "held", error: "", original: null, run: null });
    try {
      const verified = await verifyOriginal(
        await protectedRead((signal) =>
          transport.original(projectId, requestId, signal),
        ),
        projectId,
        workspace,
        requestId,
      );
      if (disposed || current !== generation) return;
      paint({
        original: verified,
        phase: verified.original.state === "reserved" ? "reserved" : "held",
        error: "",
      });
    } catch (error) {
      if (disposed || current !== generation) return;
      paint({ phase: "held", error: message(error) });
    } finally {
      finish();
    }
  };

  const scheduleRunRead = (delay = runDelay) => {
    if (disposed || runTimer !== null || runAbort !== null) return;
    runTimer = setTimeout(() => {
      runTimer = null;
      void readRun(true);
    }, delay);
  };

  const readRun = async (background = false) => {
    const saved = view.original;
    if (
      disposed ||
      workspace === null ||
      !saved ||
      saved.original.state === "reserved" ||
      saved.original.state === "retired" ||
      runAbort
    )
      return;
    const finish = beginOwnedActivity();
    const current = ++runGeneration;
    const abort = new AbortController();
    runAbort = abort;
    const deadline = setTimeout(() => abort.abort(), 6_000);
    let retryDelay: number | null = null;
    let continueFollowing = false;
    paint({ runLoading: !background, error: "" });
    try {
      const result = projectCouncilRunReadSchema.parse(
        await transport.run(projectId, saved.original.requestId, abort.signal),
      );
      if (
        result.provenance.requestId !== saved.original.requestId ||
        result.provenance.intentHash !== saved.original.intentHash ||
        result.provenance.runId !== saved.original.runId ||
        result.provenance.projectId !== projectId ||
        result.provenance.workspace !== saved.original.binding.workspace ||
        result.provenance.catalogRevision !==
          saved.original.binding.catalogRevision ||
        result.provenance.scopeHash !== saved.original.binding.scopeHash
      )
        throw Error(
          "The Council result belongs to a different saved original or project scope.",
        );
      if (
        result.job?.profile &&
        JSON.stringify(result.job.profile) !==
          JSON.stringify(saved.original.profile)
      )
        throw Error(
          "The Council result profile does not match the reviewed original.",
        );
      if (
        result.job?.run &&
        !publishedContextMatches(result.job.run.context, saved.original.context)
      )
        throw Error(
          "The Council result context does not match the reviewed original.",
        );
      if (disposed || current !== runGeneration) return;
      const phase =
        result.receipt.phase === "running"
          ? "running"
          : result.receipt.phase === "completed"
            ? "completed"
            : result.receipt.phase === "failed"
              ? "failed"
              : result.receipt.phase === "cancelled"
                ? "cancelled"
                : "held";
      let latestOriginal = saved;
      if (
        ["completed", "failed", "cancelled"].includes(phase) &&
        result.receipt.metadata.state !== saved.original.state
      ) {
        latestOriginal = await verifyOriginal(
          await protectedRead((signal) =>
            transport.original(projectId, saved.original.requestId, signal),
          ),
          projectId,
          workspace,
          saved.original.requestId,
        );
        if (
          latestOriginal.original.intentHash !== result.provenance.intentHash ||
          latestOriginal.original.state !== result.receipt.metadata.state
        )
          throw Error(
            "The terminal receipt did not match the saved original state.",
          );
      }
      if (disposed || current !== runGeneration) return;
      runDelay = 2_000;
      paint({
        run: result,
        original: latestOriginal,
        runLoading: false,
        phase,
        error: "",
      });
      if (phase === "completed" || phase === "failed" || phase === "cancelled")
        void refresh();
      continueFollowing =
        phase === "running" &&
        (result.job?.status === "running" ||
          result.job?.status === "cancelling");
    } catch (error) {
      if (disposed || current !== runGeneration) return;
      if (
        background &&
        (view.phase === "running" || view.run?.receipt.phase === "running")
      ) {
        runDelay = Math.min(10_000, runDelay * 2);
        paint({
          runLoading: false,
          error: `${message(error)} The last verified progress remains visible.`,
        });
        retryDelay = runDelay;
      } else {
        paint({ phase: "held", runLoading: false, error: message(error) });
      }
    } finally {
      clearTimeout(deadline);
      if (runAbort === abort) runAbort = null;
      if (retryDelay !== null) scheduleRunRead(retryDelay);
      else if (continueFollowing) scheduleRunRead();
      finish();
    }
  };

  const openResult = async (requestId: string) => {
    const finish = beginOwnedActivity();
    try {
      await openSaved(requestId);
      const saved = view.original;
      if (
        !disposed &&
        saved?.original.requestId === requestId &&
        saved.original.state !== "reserved" &&
        saved.original.state !== "retired"
      )
        await readRun();
    } finally {
      finish();
    }
  };

  const convene = async (requestId: string, intentHash: string) => {
    const saved = view.original;
    if (
      disposed ||
      workspace === null ||
      view.phase !== "reserved" ||
      !saved ||
      saved.original.state !== "reserved" ||
      saved.original.requestId !== requestId ||
      saved.original.intentHash !== intentHash
    )
      return;
    const action = ++actionGeneration;
    const selection = selectionGeneration;
    const finish = beginOwnedActivity();
    paint({ phase: "committing", error: "", run: null });
    try {
      const receipt = await transport.commit(
        projectId,
        saved.original.requestId,
        saved.original.intentHash,
      );
      if (
        receipt.metadata.requestId !== saved.original.requestId ||
        receipt.metadata.intentHash !== saved.original.intentHash ||
        receipt.metadata.projectId !== projectId ||
        receipt.metadata.runId !== saved.original.runId ||
        receipt.phase === "reserved" ||
        receipt.phase === "retired"
      )
        throw Error(
          "The Council admission receipt did not match the reviewed original.",
        );
      const currentOriginal = await verifyOriginal(
        await protectedRead((signal) =>
          transport.original(projectId, saved.original.requestId, signal),
        ),
        projectId,
        workspace,
        saved.original.requestId,
      );
      if (
        currentOriginal.original.state === "reserved" ||
        currentOriginal.original.intentHash !== receipt.metadata.intentHash
      )
        throw Error("The saved original did not confirm Council admission.");
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration ||
        view.original?.original.requestId !== requestId ||
        view.original.original.intentHash !== intentHash
      )
        return;
      paint({ phase: "held", error: "", original: currentOriginal });
      await readRun();
    } catch (error) {
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration
      )
        return;
      stopRunFollow();
      paint({
        phase: "held",
        error: `${message(error)} Check the saved original and result; do not submit Convene again.`,
      });
    } finally {
      finish();
    }
  };

  const cancel = async (requestId: string, intentHash: string) => {
    const saved = view.original;
    if (
      disposed ||
      workspace === null ||
      !saved ||
      saved.original.requestId !== requestId ||
      saved.original.intentHash !== intentHash ||
      saved.original.state === "reserved" ||
      saved.original.state === "retired" ||
      view.phase !== "running"
    )
      return;
    const action = ++actionGeneration;
    const selection = selectionGeneration;
    const finish = beginOwnedActivity();
    stopRunFollow();
    paint({
      phase: "held",
      error: "Requesting cancellation; checking the saved result…",
    });
    try {
      const receipt = await transport.cancel(
        projectId,
        saved.original.requestId,
        saved.original.intentHash,
      );
      if (
        receipt.metadata.requestId !== saved.original.requestId ||
        receipt.metadata.intentHash !== saved.original.intentHash ||
        receipt.metadata.runId !== saved.original.runId ||
        receipt.metadata.projectId !== projectId ||
        receipt.phase === "reserved" ||
        receipt.phase === "retired"
      )
        throw Error(
          "The cancellation receipt did not match the saved original.",
        );
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration ||
        view.original?.original.requestId !== requestId ||
        view.original.original.intentHash !== intentHash
      )
        return;
      await readRun();
    } catch (error) {
      if (
        disposed ||
        action !== actionGeneration ||
        selection !== selectionGeneration
      )
        return;
      paint({
        phase: "held",
        error: `${message(error)} Cancellation is not confirmed; check the saved result.`,
      });
    } finally {
      finish();
    }
  };

  const newDraft = () => {
    const saved = view.original;
    const terminal = saved &&
      ["completed", "failed", "cancelled", "retired"].includes(
        saved.original.state,
      );
    if (
      !saved ||
      !terminal ||
      view.history?.activeRequestId !== null
    )
      return;
    selectionGeneration++;
    actionGeneration++;
    stopRunFollow();
    paint({ original: null, run: null, phase: "ready", error: "" });
  };

  void refresh();
  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    prepare,
    retire,
    openSaved,
    openResult,
    convene,
    readRun: () => readRun(false),
    cancel,
    newDraft,
    dispose() {
      disposed = true;
      generation++;
      metadataAbort?.abort();
      for (const abort of privateAborts) abort.abort();
      stopRunFollow();
      listeners.clear();
    },
  };
}

export function useProjectCouncil(
  projectId: string | null,
  workspace: string | null,
) {
  const key = JSON.stringify([projectId, workspace]);
  const ownerRef = useRef<{ key: string; owner: ProjectCouncilOwner } | null>(
    null,
  );
  const [snapshot, setSnapshot] = useState<{
    key: string;
    view: ProjectCouncilView;
  } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const owner = createProjectCouncilOwner(projectId, workspace);
    ownerRef.current = { key, owner };
    const changed = () => setSnapshot({ key, view: { ...owner.get() } });
    const unsubscribe = owner.subscribe(changed);
    const unwatch = appStream().watch(
      [
        "operator.action",
        "review.recorded",
        "run.phase.entered",
        "run.phase.completed",
      ],
      () => {
        if (document.visibilityState === "visible") void owner.refresh();
      },
    );
    const visible = () => {
      if (document.visibilityState === "visible") void owner.refresh();
    };
    document.addEventListener("visibilitychange", visible);
    changed();
    return () => {
      unsubscribe();
      unwatch();
      document.removeEventListener("visibilitychange", visible);
      if (ownerRef.current?.owner === owner) ownerRef.current = null;
      // Disposing a route owner prevents its late reads from painting a new project.
      owner.dispose();
    };
  }, [key]);
  const owner = ownerRef.current?.key === key ? ownerRef.current.owner : null;
  const view = snapshot?.key === key ? snapshot.view : null;
  return { owner, view };
}
