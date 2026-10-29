import {
  type ProjectCheckpointReviewBinding,
  type ProjectCheckpointReviewMetadata,
  type ProjectCheckpointReviewMetadataRead,
  type ProjectCheckpointReviewOriginalRead,
  type ProjectCheckpointReviewPrepareRequest,
  type ProjectCheckpointReviewReceipt,
  type ProjectCheckpointReviewScope,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewMetadataReadSchema,
  projectCheckpointReviewOriginalReadSchema,
  projectCheckpointReviewPrepareRequestSchema,
} from "../../../types/project-checkpoint-reviews";
import {
  createProjectCheckpointReviewTransport,
  type ProjectCheckpointReviewTransport,
} from "./project-checkpoint-review-transport";

export type ProjectCheckpointReviewTarget = Pick<
  ProjectCheckpointReviewBinding,
  | "projectId"
  | "workspacePath"
  | "checkout"
  | "runSlug"
  | "epicId"
  | "beadId"
  | "runUpdatedAt"
>;

export type ProjectCheckpointReviewPhase =
  | "loading"
  | "ready"
  | "preparing"
  | "prepared"
  | "committing"
  | "confirmed"
  | "refused"
  | "unknown"
  | "retired"
  | "held";

export interface ProjectCheckpointReviewView {
  target: ProjectCheckpointReviewTarget;
  phase: ProjectCheckpointReviewPhase;
  note: string;
  metadata: ProjectCheckpointReviewMetadataRead | null;
  original: ProjectCheckpointReviewOriginalRead | null;
  receipt: ProjectCheckpointReviewReceipt | null;
  error: string;
  busy: boolean;
}

export function canStartProjectCheckpointReview(
  view: ProjectCheckpointReviewView,
): boolean {
  if (view.phase === "ready") return true;
  return (
    ["confirmed", "refused", "retired"].includes(view.phase) &&
    view.metadata !== null &&
    view.metadata.activeRequestId === null &&
    !view.metadata.blocked
  );
}

export interface ProjectCheckpointReviewOwner {
  get(): ProjectCheckpointReviewView;
  subscribe(listener: () => void): () => void;
  setTarget(target: ProjectCheckpointReviewTarget): void;
  invalidatePending(): void;
  setNote(note: string): void;
  refresh(): Promise<void>;
  submit(
    decision: ProjectCheckpointReviewPrepareRequest["decision"],
  ): Promise<void>;
  openSaved(requestId: string): Promise<void>;
  recordSaved(): Promise<void>;
  checkRecordedComment(): Promise<void>;
  retirePrepared(): Promise<void>;
  dispose(): void;
}

function sameTarget(
  a: ProjectCheckpointReviewTarget,
  b: ProjectCheckpointReviewTarget,
): boolean {
  return (
    a.projectId === b.projectId &&
    a.workspacePath === b.workspacePath &&
    a.checkout === b.checkout &&
    a.runSlug === b.runSlug &&
    a.epicId === b.epicId &&
    a.beadId === b.beadId &&
    a.runUpdatedAt === b.runUpdatedAt
  );
}

function sameScope(
  a: ProjectCheckpointReviewTarget,
  b: ProjectCheckpointReviewTarget,
): boolean {
  return (
    a.projectId === b.projectId &&
    a.workspacePath === b.workspacePath &&
    a.runSlug === b.runSlug &&
    a.beadId === b.beadId
  );
}

function scopeOf(
  target: ProjectCheckpointReviewTarget,
): ProjectCheckpointReviewScope {
  return {
    projectId: target.projectId,
    workspacePath: target.workspacePath,
    runSlug: target.runSlug,
    beadId: target.beadId,
  };
}

function bindingMatches(
  binding: ProjectCheckpointReviewBinding,
  target: ProjectCheckpointReviewTarget,
): boolean {
  return (
    binding.projectId === target.projectId &&
    binding.workspacePath === target.workspacePath &&
    binding.checkout === target.checkout &&
    binding.runSlug === target.runSlug &&
    binding.epicId === target.epicId &&
    binding.beadId === target.beadId &&
    binding.runUpdatedAt === target.runUpdatedAt
  );
}

function bindingScopeMatches(
  binding: ProjectCheckpointReviewBinding,
  target: ProjectCheckpointReviewTarget,
): boolean {
  return (
    binding.projectId === target.projectId &&
    binding.workspacePath === target.workspacePath &&
    binding.runSlug === target.runSlug &&
    binding.beadId === target.beadId
  );
}

function scopeMatches(
  scope: ProjectCheckpointReviewScope,
  target: ProjectCheckpointReviewTarget,
): boolean {
  return (
    scope.projectId === target.projectId &&
    scope.workspacePath === target.workspacePath &&
    scope.runSlug === target.runSlug &&
    scope.beadId === target.beadId
  );
}

async function verifyOriginal(
  value: unknown,
  target: ProjectCheckpointReviewTarget,
  requestId?: string,
  requireCurrentStamp = true,
): Promise<ProjectCheckpointReviewOriginalRead> {
  const read = projectCheckpointReviewOriginalReadSchema.parse(value);
  if (
    !scopeMatches(read.metadata.scope, target) ||
    !(requireCurrentStamp
      ? bindingMatches(read.original.binding, target)
      : bindingScopeMatches(read.original.binding, target)) ||
    (requestId !== undefined && read.original.requestId !== requestId) ||
    read.metadata.requestId !== read.original.requestId ||
    read.metadata.intentHash !== read.original.intentHash ||
    read.receipt.requestId !== read.original.requestId ||
    read.receipt.intentHash !== read.original.intentHash
  )
    throw Error(
      "The saved checkpoint review belongs to a different run or checkpoint.",
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(projectCheckpointReviewIntentJson(read.original)),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== read.original.intentHash)
    throw Error(
      "The saved checkpoint review hash does not match its original.",
    );
  return read;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The checkpoint review could not be verified.";
}

function phaseFor(
  state: ProjectCheckpointReviewMetadata["state"],
): ProjectCheckpointReviewPhase {
  return state === "prepared" ? "prepared" : state;
}

export function createProjectCheckpointReviewOwner(
  initialTarget: ProjectCheckpointReviewTarget,
  transport: ProjectCheckpointReviewTransport = createProjectCheckpointReviewTransport(),
): ProjectCheckpointReviewOwner {
  let target = { ...initialTarget };
  let targetGeneration = 0;
  let operationGeneration = 0;
  let disposed = false;
  let stickyHold = false;
  let metadataAbort: AbortController | null = null;
  const privateAborts = new Set<AbortController>();
  const listeners = new Set<() => void>();
  let view: ProjectCheckpointReviewView = {
    target: { ...target },
    phase: "loading",
    note: "",
    metadata: null,
    original: null,
    receipt: null,
    error: "",
    busy: false,
  };
  const paint = (patch: Partial<ProjectCheckpointReviewView>) => {
    if (disposed) return;
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  };
  const current = (generation: number, operation: number) =>
    !disposed &&
    generation === targetGeneration &&
    operation === operationGeneration;
  const acceptReceipt = (
    saved: ProjectCheckpointReviewOriginalRead,
    receipt: ProjectCheckpointReviewReceipt,
  ) => {
    const metadata = {
      ...saved.metadata,
      state: receipt.state,
      commentId: receipt.commentId,
      updatedAt: receipt.updatedAt,
    };
    const items = view.metadata?.items ?? [saved.metadata];
    const nextItems = items.some((item) => item.requestId === receipt.requestId)
      ? items.map((item) =>
          item.requestId === receipt.requestId ? metadata : item,
        )
      : [...items, metadata];
    const activeRequestId = ["prepared", "unknown"].includes(receipt.state)
      ? receipt.requestId
      : view.metadata?.activeRequestId === receipt.requestId
        ? null
        : (view.metadata?.activeRequestId ?? null);
    const metadataRead = view.metadata
      ? { ...view.metadata, items: nextItems, activeRequestId }
      : {
          schemaVersion: 1 as const,
          scope: scopeOf(target),
          items: nextItems,
          activeRequestId,
          blocked: receipt.state === "unknown",
        };
    const original = { ...saved, metadata, receipt };
    stickyHold = ["prepared", "unknown"].includes(receipt.state);
    paint({
      metadata: metadataRead,
      original,
      receipt,
      phase: phaseFor(receipt.state),
      busy: false,
      error: "",
    });
  };
  const privateRead = async <T>(
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
  const refresh = async () => {
    if (disposed || view.busy) return;
    metadataAbort?.abort();
    const abort = new AbortController();
    metadataAbort = abort;
    const generation = targetGeneration;
    const operation = operationGeneration;
    const savedTarget = { ...target };
    const deadline = setTimeout(() => abort.abort(), 6_000);
    const ownsMetadataRead = () =>
      metadataAbort === abort &&
      !abort.signal.aborted &&
      current(generation, operation);
    try {
      const result = projectCheckpointReviewMetadataReadSchema.parse(
        await transport.metadata(scopeOf(savedTarget), abort.signal),
      );
      if (!scopeMatches(result.scope, savedTarget))
        throw Error("Checkpoint review history has the wrong scope.");
      if (!ownsMetadataRead()) return;
      const saved = view.original;
      const savedRow =
        saved &&
        result.items.find(
          (item) => item.requestId === saved.original.requestId,
        );
      if (
        saved &&
        (!savedRow ||
          savedRow.intentHash !== saved.original.intentHash ||
          savedRow.state !== saved.metadata.state ||
          (["prepared", "unknown"].includes(savedRow.state) &&
            result.activeRequestId !== saved.original.requestId))
      ) {
        paint({
          metadata: result,
          phase: "held",
          error:
            "Saved review state changed. Read this exact original before continuing.",
        });
      } else if (saved || stickyHold || view.phase === "unknown") {
        paint({ metadata: result });
      } else if (result.activeRequestId !== null || result.blocked) {
        paint({
          metadata: result,
          phase: "held",
          error:
            "A saved checkpoint review must be opened and verified before continuing.",
        });
      } else paint({ metadata: result, phase: "ready", error: "" });
    } catch (error) {
      if (ownsMetadataRead())
        paint({ phase: view.phase, error: errorText(error) });
    } finally {
      clearTimeout(deadline);
      if (metadataAbort === abort) metadataAbort = null;
    }
  };
  const performReceipt = async (
    operation: "commit" | "retire" | "readback",
    saved: ProjectCheckpointReviewOriginalRead,
    generation: number,
    action: number,
  ) => {
    const scope = scopeOf(target);
    const result = await transport[operation](
      scope,
      saved.original.requestId,
      saved.original.intentHash,
    );
    if (!current(generation, action)) return;
    if (
      result.requestId !== saved.original.requestId ||
      result.intentHash !== saved.original.intentHash
    )
      throw Error(
        "The checkpoint review receipt belongs to a different original.",
      );
    acceptReceipt(saved, result);
  };
  const submit = async (
    decision: ProjectCheckpointReviewPrepareRequest["decision"],
  ) => {
    if (disposed || view.busy || !canStartProjectCheckpointReview(view)) return;
    const parsed = projectCheckpointReviewPrepareRequestSchema.safeParse({
      requestId: crypto.randomUUID(),
      expectedEpicId: target.epicId,
      expectedRunUpdatedAt: target.runUpdatedAt,
      decision,
      note: view.note.trim(),
    });
    if (!parsed.success) {
      paint({
        error: parsed.error.issues[0]?.message ?? "Review note is invalid.",
      });
      return;
    }
    const captured = { ...target };
    const generation = targetGeneration;
    const operation = ++operationGeneration;
    paint({
      phase: "preparing",
      busy: true,
      original: null,
      receipt: null,
      error: "",
    });
    stickyHold = true;
    try {
      const metadata = await transport.prepare(scopeOf(captured), parsed.data);
      if (!current(generation, operation)) {
        void refresh();
        return;
      }
      if (
        metadata.requestId !== parsed.data.requestId ||
        metadata.scope.projectId !== captured.projectId ||
        metadata.scope.workspacePath !== captured.workspacePath ||
        metadata.scope.runSlug !== captured.runSlug ||
        metadata.scope.beadId !== captured.beadId ||
        metadata.state !== "prepared"
      )
        throw Error(
          "The prepared checkpoint review did not match this exact request.",
        );
      const original = await privateRead((signal) =>
        transport.original(scopeOf(captured), metadata.requestId, signal),
      );
      const verified = await verifyOriginal(
        original,
        captured,
        metadata.requestId,
      );
      if (!current(generation, operation)) {
        void refresh();
        return;
      }
      if (
        verified.metadata.intentHash !== metadata.intentHash ||
        verified.original.decision !== parsed.data.decision ||
        verified.original.note !== parsed.data.note ||
        verified.metadata.state !== "prepared"
      )
        throw Error(
          "The prepared original did not match the review you entered.",
        );
      paint({
        metadata: view.metadata,
        original: verified,
        phase: "committing",
      });
      const receipt = await transport.commit(
        scopeOf(captured),
        metadata.requestId,
        metadata.intentHash,
      );
      if (!current(generation, operation)) return;
      if (
        receipt.requestId !== metadata.requestId ||
        receipt.intentHash !== metadata.intentHash
      )
        throw Error(
          "The checkpoint review receipt did not match its prepared original.",
        );
      acceptReceipt(verified, receipt);
      void refresh();
    } catch (error) {
      if (current(generation, operation)) {
        paint({
          phase: "held",
          busy: false,
          error: `${errorText(error)} Check the saved review before trying again.`,
        });
        void refresh();
      }
    }
  };
  const openSaved = async (id: string) => {
    if (disposed || view.busy) return;
    const row = view.metadata?.items.find((item) => item.requestId === id);
    if (!row) {
      paint({
        error: "That checkpoint review is not present in verified history.",
      });
      return;
    }
    const savedTarget = { ...target };
    const generation = targetGeneration;
    const operation = ++operationGeneration;
    paint({ busy: true, phase: "held", error: "Reading the saved original…" });
    try {
      const raw = await privateRead((signal) =>
        transport.original(scopeOf(savedTarget), id, signal),
      );
      const verified = await verifyOriginal(raw, savedTarget, id, false);
      if (!current(generation, operation)) return;
      if (
        verified.metadata.intentHash !== row.intentHash ||
        verified.metadata.state !== row.state
      )
        throw Error(
          "The saved original does not match its verified history row.",
        );
      paint({
        original: verified,
        receipt: verified.receipt,
        phase: phaseFor(verified.metadata.state),
        busy: false,
        error: "",
      });
      stickyHold = ["prepared", "unknown"].includes(verified.metadata.state);
    } catch (error) {
      if (current(generation, operation))
        paint({ phase: "held", busy: false, error: errorText(error) });
    }
  };
  const owner: ProjectCheckpointReviewOwner = {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTarget(next) {
      if (sameTarget(target, next)) return;
      const preservedNote = sameScope(target, next) ? view.note : "";
      if (!sameScope(target, next)) stickyHold = false;
      target = { ...next };
      targetGeneration++;
      operationGeneration++;
      metadataAbort?.abort();
      for (const abort of privateAborts) abort.abort();
      view = {
        target: { ...next },
        phase: stickyHold ? "held" : "loading",
        note: preservedNote,
        metadata: null,
        original: null,
        receipt: null,
        error: stickyHold
          ? "Read the exact saved review before continuing."
          : "",
        busy: false,
      };
      for (const listener of listeners) listener();
      void refresh();
    },
    invalidatePending() {
      if (disposed || !view.busy || view.phase === "committing") return;
      operationGeneration++;
      stickyHold = true;
      paint({
        busy: false,
        phase: "held",
        error:
          "The run view changed during review. Read the saved original before continuing.",
      });
      void refresh();
    },
    setNote(note) {
      if (view.busy) {
        operationGeneration++;
        paint({
          note,
          busy: false,
          phase: "held",
          error:
            "The note changed during review preparation. Read the saved original before continuing.",
        });
        void refresh();
      } else paint({ note, error: "" });
    },
    refresh,
    submit,
    openSaved,
    async recordSaved() {
      const saved = view.original;
      if (
        !saved ||
        view.busy ||
        view.phase !== "prepared" ||
        saved.metadata.state !== "prepared"
      )
        return;
      const generation = targetGeneration;
      const operation = ++operationGeneration;
      paint({ busy: true, phase: "committing", error: "" });
      try {
        await performReceipt("commit", saved, generation, operation);
      } catch (error) {
        if (current(generation, operation))
          paint({
            phase: "held",
            busy: false,
            error: `${errorText(error)} Check the saved review before trying again.`,
          });
      }
    },
    async checkRecordedComment() {
      const saved = view.original;
      if (
        !saved ||
        view.busy ||
        saved.metadata.state !== "unknown" ||
        !["unknown", "held"].includes(view.phase)
      )
        return;
      const generation = targetGeneration;
      const operation = ++operationGeneration;
      paint({ busy: true, error: "Checking the exact recorded comment…" });
      try {
        await performReceipt("readback", saved, generation, operation);
      } catch (error) {
        if (current(generation, operation))
          paint({ phase: "unknown", busy: false, error: errorText(error) });
      }
    },
    async retirePrepared() {
      const saved = view.original;
      if (
        !saved ||
        view.busy ||
        view.phase !== "prepared" ||
        saved.metadata.state !== "prepared"
      )
        return;
      const generation = targetGeneration;
      const operation = ++operationGeneration;
      paint({ busy: true, phase: "held", error: "" });
      try {
        await performReceipt("retire", saved, generation, operation);
      } catch (error) {
        if (current(generation, operation))
          paint({ phase: "held", busy: false, error: errorText(error) });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      operationGeneration++;
      targetGeneration++;
      metadataAbort?.abort();
      for (const abort of privateAborts) abort.abort();
      listeners.clear();
    },
  };
  return owner;
}
