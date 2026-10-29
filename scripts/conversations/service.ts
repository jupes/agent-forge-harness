import { randomUUID } from "node:crypto";
import type { PreparedCodexChat } from "../../types/codex-chat";
import type { PreparedCodexTask } from "../../types/codex-task-runtime";
import type {
  ConversationBinding,
  ConversationObject,
  ConversationPage,
  ConversationReceipt,
  ConversationSend,
  ConversationState,
  ConversationTurn,
  OwnedConversationAddress,
  PreparedConversationSend,
} from "../../types/conversation";
import type { PreparedGeminiChat } from "../../types/gemini-chat-runtime";
import type { PreparedGeminiTask } from "../../types/gemini-task-runtime";
import type {
  KeeperBriefIntent,
  KeeperBriefIntentMetadata,
  KeeperBriefOriginRequest,
  KeeperBriefOriginBinding,
  KeeperBriefSelection,
  KeeperBriefSnapshot,
} from "../../types/keeper-brief";
import type {
  KeeperContinuationRequest,
  KeeperRecoveryPage,
} from "../../types/keeper-recovery";
import type {
  ProjectCreateOperation,
  ProjectRecord,
} from "../../types/projects";
import type {
  SessionMessage,
  SessionTurnSnapshot,
} from "../../types/session-turn";
import {
  type InitialStartAttempt,
  markInitialStartAcceptEntered,
  noteInitialStartPreparationRefusal,
} from "../identities/preaccept-not-sent-proof";
import { keeperBriefPrompt, keeperBriefs } from "../keeper/brief-model";
import {
  briefSnapshotSchema,
  keeperBriefIntentMetadataSchema,
  keeperBriefIntentReferenceSchema,
  keeperBriefIntentReserveRequestSchema,
  keeperBriefOriginBindingSchema,
  keeperBriefSelectionSchema,
} from "../keeper/brief-protocol";
import { keeperContinuationSchema } from "../keeper/recovery-protocol";
import {
  type KeeperRuntime,
  prepareKeeper,
} from "../keeper/recovery-runtime";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import {
  createProjectStore,
  hashProjectCreateRequest,
} from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import { preparedCodexChatSchema } from "../sessions/codex-app-server-protocol";
import { preparedCodexTaskSchema } from "../sessions/codex-task-runtime-protocol";
import { preparedGeminiChatSchema } from "../sessions/gemini-chat-runtime-protocol";
import { preparedGeminiTaskSchema } from "../sessions/gemini-task-runtime-protocol";
import { sessionTurnSnapshotSchema } from "../sessions/turn-protocol";
import { conversationPage, validateConversationPageQuery } from "./page";
import { conversationLeaseFile } from "./paths";
import { parseSessionSend } from "./protocol";
import {
  ConversationError,
  createConversationStore,
  interruptedConversation,
  parseConversationSend,
} from "./store";
import type {
  CodexChatOwnerLifecycleSink,
  ConversationTransport,
  ConversationUpdate,
} from "./transport";
import { KeeperSelectionMismatchError } from "./transport";

export type { ConversationPage } from "../../types/conversation";

export type ValidateConversationAbout = (
  projectId: string,
  about: ConversationObject[],
) => Promise<void>;

interface ConversationOptions {
  home: string;
  root: string;
  transport: ConversationTransport;
  /** Trusted receipt writer is provided only by the ordinary owned Codex Chat service. */
  ownerLifecycle?: (input: {
    projectId: string;
    requestId: string;
    owner: string;
  }) => CodexChatOwnerLifecycleSink;
  keeperRuntime?: KeeperRuntime | undefined;
  validateAbout?: ValidateConversationAbout | undefined;
  prepareBrief?:
    | ((projectId: string) => Promise<KeeperBriefSnapshot>)
    | undefined;
  /** Trusted private ProjectStore seam used only to resolve onboarding originals. */
  readProjectCreate?:
    | ((requestId: string) => ProjectCreateOperation | null)
    | undefined;
  onChange?(update: ConversationUpdate): void;
  onRecoveryChange?(projectId: string): void;
  /** Trusted fixed partition for an app-owned session. Omission retains the standing Keeper. */
  address?: OwnedConversationAddress | undefined;
  /** Only an app-owned service may prepare a private coding launch under its lease. */
  prepareSession?:
    | ((request: {
        project: ProjectRecord;
        input: SessionMessage;
        resume: ConversationBinding | null;
      }) => Promise<SessionTurnSnapshot>)
    | undefined;
  /** Additive private Task path; never normalizes or replaces a Claude snapshot. */
  prepareCodexTask?:
    | ((request: {
        project: ProjectRecord;
        input: SessionMessage;
        resume: ConversationBinding | null;
      }) => Promise<PreparedCodexTask>)
    | undefined;
  prepareCodexChat?:
    | ((request: {
        project: ProjectRecord;
        input: SessionMessage;
        resume: ConversationBinding | null;
      }) => Promise<PreparedCodexChat>)
    | undefined;
  /** Dedicated linked-Fork child continuation; never used by ordinary sends. */
  prepareForkCodexChat?:
    | ((request: {
        project: ProjectRecord;
        input: SessionMessage;
        resume: ConversationBinding | null;
      }) => Promise<{
        prepared: PreparedCodexChat;
        resumeSettings: {
          modelProvider: string;
          serviceTier: string | null;
          reasoningEffort: string | null;
        };
      }>)
    | undefined;
  prepareGeminiTask?:
    | ((request: {
        project: ProjectRecord;
        input: SessionMessage;
        resume: ConversationBinding | null;
      }) => Promise<PreparedGeminiTask>)
    | undefined;
  prepareGeminiChat?:
    | ((request: {
        project: ProjectRecord;
        input: SessionMessage;
        resume: ConversationBinding | null;
      }) => Promise<PreparedGeminiChat>)
    | undefined;
}

const activePhase = (phase: string) =>
  ["accepted", "running", "cancelling"].includes(phase);
const forkChildTurnCapability = Symbol("trusted Fork-child turn");
const savedKeeperSmith = (state: ConversationState) => {
  const process = [...state.frames]
    .reverse()
    .find((frame) => frame.event.kind === "process")?.event;
  return (
    state.keeperRecovery?.smith ??
    (process?.kind === "process" ? process.smith : undefined)
  );
};

const intentMetadata = (intent: KeeperBriefIntent): KeeperBriefIntentMetadata => {
  const {
    version,
    requestId,
    projectId,
    conversationId,
    expectedRevision,
    origin,
    selection,
    purpose,
    intentHash,
    createdAt,
    state,
    preparedTurnHash,
  } = intent;
  return keeperBriefIntentMetadataSchema.parse({
    version,
    requestId,
    projectId,
    conversationId,
    expectedRevision,
    origin,
    selection,
    purpose,
    intentHash,
    createdAt,
    state,
    preparedTurnHash,
  });
};

const sameSelection = (
  left: KeeperBriefSelection,
  right: KeeperBriefSelection,
) =>
  JSON.stringify({
    name: left.name,
    provider: left.provider,
    model: left.model,
    effort: left.effort,
    enabled: left.enabled,
    tags: left.tags,
  }) ===
  JSON.stringify({
    name: right.name,
    provider: right.provider,
    model: right.model,
    effort: right.effort,
    enabled: right.enabled,
    tags: right.tags,
  });

const sameProjectScope = (
  left: ProjectRecord["workspaces"][number],
  right: ProjectRecord["workspaces"][number],
) =>
  workspaceKey(left.root) === workspaceKey(right.root) &&
  JSON.stringify([...left.repositories].sort()) ===
    JSON.stringify([...right.repositories].sort()) &&
  JSON.stringify([...left.epicIds].sort()) ===
    JSON.stringify([...right.epicIds].sort());

/** Observers do not own provider lifetime. A held SQLite lease fences dispatch across hearths. */
export function createConversationService(options: ConversationOptions) {
  if (
    (options.prepareSession ||
      options.prepareCodexTask ||
      options.prepareCodexChat ||
      options.prepareForkCodexChat ||
      options.prepareGeminiChat ||
      options.prepareGeminiTask) &&
    !options.address
  )
    throw new ConversationError(
      400,
      "Session launch preparation requires an owned session address.",
    );
  if (
    [
      options.prepareSession,
      options.prepareCodexTask,
      options.prepareCodexChat,
      options.prepareGeminiChat,
      options.prepareGeminiTask,
    ].filter(Boolean).length > 1
  )
    throw new ConversationError(
      400,
      "Choose one explicit owned session provider preparation.",
    );
  const store = createConversationStore(
    options.home,
    undefined,
    options.address,
  );
  const workspace = resolveCheckout(options.root).workspace;
  const jobs = new Map<
    string,
    {
      job: Promise<void>;
      abort: AbortController;
      requestId: string;
      admission: Promise<ConversationReceipt>;
    }
  >();
  const keeperBriefAdmissions = new Map<
    string,
    {
      job: Promise<void>;
      abort: AbortController;
      requestId: string;
      admission: Promise<ConversationReceipt>;
    }
  >();
  const owned = new Set<string>();
  let closed = false;
  // Native capability probes are reads, but still consume real child processes.
  // Share a single budget across projects and concurrent observer requests.
  let activeReadinessChecks = 0;
  const readinessWaiters: (() => void)[] = [];
  const readinessReads = new Map<
    string,
    Promise<KeeperRecoveryPage["choices"]>
  >();
  const pendingBriefReservations = new Set<Promise<unknown>>();
  const trackBriefReservation = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = work();
    pendingBriefReservations.add(pending);
    void pending.then(
      () => pendingBriefReservations.delete(pending),
      () => pendingBriefReservations.delete(pending),
    );
    return pending;
  };
  const boundedReadiness = async <T>(check: () => Promise<T>): Promise<T> => {
    if (activeReadinessChecks >= 4)
      await new Promise<void>((resolve) => readinessWaiters.push(resolve));
    else activeReadinessChecks++;
    try {
      if (closed) throw new ConversationError(503, "This hearth is closing.");
      return await check();
    } finally {
      const next = readinessWaiters.shift();
      if (next) next();
      else activeReadinessChecks--;
    }
  };
  const projectFor = (projectId: string) => {
    // Validates the address before it can participate in a filename.
    store.read(projectId);
    const project = createProjectStore(options.home)
      .read()
      .projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    return project;
  };
  const projectCatalogFor = (projectId: string) => {
    store.read(projectId);
    const catalog = createProjectStore(options.home).read();
    const project = catalog.projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    if (project.archived)
      throw new ConversationError(
        409,
        "This project is archived. Its saved Keeper brief original remains available for review.",
      );
    const scope = project.workspaces.find(
      (item) => workspaceKey(item.root) === workspaceKey(workspace),
    );
    if (!scope)
      throw new ConversationError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    return { catalog, project, scope };
  };
  const trustedBriefOrigin = (
    projectId: string,
    scope: ProjectRecord["workspaces"][number],
    catalogRevision: number,
    request: KeeperBriefOriginRequest,
  ): KeeperBriefOriginBinding => {
    const common = {
      projectId,
      workspace,
      catalogRevision,
    };
    if (request.kind === "overview")
      return keeperBriefOriginBindingSchema.parse({
        kind: "overview",
        ...common,
      });
    const operation = options.readProjectCreate?.(
      request.projectCreateRequestId,
    );
    if (
      !operation ||
      operation.state !== "created" ||
      operation.projectId !== projectId ||
      operation.requestId !== request.projectCreateRequestId ||
      operation.createdRevision === null ||
      operation.createdRevision > catalogRevision ||
      !/^[a-f0-9]{64}$/.test(operation.scopeHash) ||
      operation.requestHash !==
        hashProjectCreateRequest({
          requestId: operation.requestId,
          expectedCatalogRevision: operation.baseRevision,
          original: operation.original,
        })
    )
      throw new ConversationError(
        409,
        "The accepted project creation original is unavailable or no longer matches this project.",
      );
    const acceptedScope = operation.original.workspaces.find((item) =>
      sameProjectScope(item, scope),
    );
    if (!acceptedScope || !sameProjectScope(scope, acceptedScope))
      throw new ConversationError(
        409,
        "The accepted project creation scope no longer matches the served workspace.",
      );
    return keeperBriefOriginBindingSchema.parse({
      kind: "onboarding",
      ...common,
      projectCreate: {
        requestId: operation.requestId,
        hash: operation.requestHash,
        scopeHash: operation.scopeHash,
        revision: operation.createdRevision,
      },
    });
  };
  const trustedBriefSelection = (
    project: ProjectRecord,
    state: ConversationState,
  ): KeeperBriefSelection => {
    const runtime = options.keeperRuntime;
    if (!runtime)
      throw new ConversationError(
        503,
        "Keeper selection cannot be verified. The saved conversation has been kept.",
      );
    const catalog = runtime.catalog();
    if (catalog.smiths.length > 100)
      throw new ConversationError(
        503,
        "The Keeper smith catalog exceeds its supported bound.",
      );
    const name =
      savedKeeperSmith(state) ?? project.keeperSmith ?? catalog.defaultSmith;
    const smith = catalog.smiths.find((item) => item.name === name);
    const parsed = keeperBriefSelectionSchema.safeParse(smith);
    if (!parsed.success)
      throw new ConversationError(
        409,
        "The selected Keeper smith is unknown or disabled. No brief original was reserved.",
      );
    return parsed.data;
  };
  const assertServedBriefIntent = (
    projectId: string,
    intent: KeeperBriefIntent | null,
  ): KeeperBriefIntent => {
    if (
      !intent ||
      intent.projectId !== projectId ||
      workspaceKey(intent.origin.workspace) !== workspaceKey(workspace)
    )
      throw new ConversationError(
        404,
        "The saved Keeper brief original is not available in this hearth scope.",
      );
    return intent;
  };
  const leaseFor = (projectId: string) =>
    conversationLeaseFile(options.home, projectId, options.address);
  const receipt = (
    state: ConversationState,
    requestId: string,
  ): ConversationReceipt => {
    const turn = state.turns.find((item) => item.requestId === requestId);
    if (!turn)
      throw new ConversationError(
        404,
        "This request is not in the conversation.",
      );
    return {
      conversationId: state.conversationId,
      revision: state.revision,
      turn,
    };
  };
  const notify = (projectId: string, requestId: string) => {
    const current = receipt(store.read(projectId), requestId);
    try {
      options.onChange?.({
        projectId,
        conversationId: current.conversationId,
        revision: current.revision,
        requestId,
        phase: current.turn.phase,
      });
    } catch {
      /* A failed metadata projection never repeats a turn. */
    }
  };
  const observe = async (projectId: string) => {
    projectFor(projectId);
    let state = store.read(projectId);
    if (
      !jobs.has(projectId) &&
      state.turns.some((item) => activePhase(item.phase))
    ) {
      const observed = await withQueueLock(
        leaseFor(projectId),
        async () => store.read(projectId),
        { waitMs: 150 },
      );
      state = observed.ok
        ? interruptedConversation(observed.value)
        : store.read(projectId);
    }
    return state;
  };
  return {
    reserveKeeperBrief(
      projectId: string,
      request: {
        expectedRevision: number;
        origin: KeeperBriefOriginRequest;
      },
    ): Promise<KeeperBriefIntentMetadata> {
      return trackBriefReservation(async () => {
        if (closed)
          throw new ConversationError(503, "This hearth is closing.");
        const checked = keeperBriefIntentReserveRequestSchema.safeParse(request);
        if (!checked.success || options.address)
          throw new ConversationError(
            400,
            "Expected a bounded brief reservation request.",
          );
        const reservation = checked.data;
        if (!options.prepareBrief || !options.keeperRuntime)
          throw new ConversationError(
            503,
            "Keeper brief source preparation is unavailable. No original was reserved.",
          );
        const locked = await withQueueLock(
          leaseFor(projectId),
          async () => {
            if (closed)
              throw new ConversationError(503, "This hearth is closing.");
            const current = projectCatalogFor(projectId);
            const state = store.read(projectId);
            if (state.revision !== reservation.expectedRevision)
              throw new ConversationError(
                409,
                "The conversation changed. Read it again before reserving a brief.",
              );
            const origin = trustedBriefOrigin(
              projectId,
              current.scope,
              current.catalog.revision,
              reservation.origin,
            );
            const selection = trustedBriefSelection(current.project, state);
            const active = store.discoverKeeperBrief(projectId);
            if (
              active &&
              active.expectedRevision === reservation.expectedRevision &&
              JSON.stringify(active.origin) === JSON.stringify(origin) &&
              sameSelection(active.selection, selection)
            )
              return active;
            const activeTurn = active
              ? state.turns.find((turn) => turn.requestId === active.requestId)
              : undefined;
            const terminalActive =
              active?.state === "admitted" &&
              activeTurn !== undefined &&
              ["completed", "failed", "cancelled"].includes(
                activeTurn.phase,
              );
            if (active && !terminalActive)
              throw new ConversationError(
                409,
                "A different Keeper brief original is already reserved or unresolved. Read it before preparing another.",
              );

            const preparedSnapshot = await options.prepareBrief(projectId);
            if (closed)
              throw new ConversationError(
                503,
                "This hearth closed during Keeper brief preparation. No original was reserved.",
              );
            const snapshotResult =
              briefSnapshotSchema.safeParse(preparedSnapshot);
            if (
              !snapshotResult.success ||
              snapshotResult.data.projectId !== projectId ||
              snapshotResult.data.workspace !== origin.workspace ||
              snapshotResult.data.catalogRevision !== origin.catalogRevision
            )
              throw new ConversationError(
                503,
                "The bounded brief source changed or could not be verified. No original was reserved.",
              );
            const after = projectCatalogFor(projectId);
            const afterOrigin = trustedBriefOrigin(
              projectId,
              after.scope,
              after.catalog.revision,
              reservation.origin,
            );
            const afterSelection = trustedBriefSelection(
              after.project,
              store.read(projectId),
            );
            if (
              store.read(projectId).revision !==
                reservation.expectedRevision ||
              JSON.stringify(afterOrigin) !== JSON.stringify(origin) ||
              !sameSelection(afterSelection, selection)
            )
              throw new ConversationError(
                409,
                "The project, Keeper selection or conversation changed while preparing the brief. Refresh and review again.",
              );
            return store.reserveKeeperBrief(
              projectId,
              {
                expectedRevision: reservation.expectedRevision,
                origin,
                selection,
                text: keeperBriefPrompt(snapshotResult.data),
                about: [],
                snapshot: snapshotResult.data,
              },
              () => !closed,
            );
          },
          { waitMs: 300 },
        );
        if (!locked.ok)
          throw new ConversationError(
            409,
            "Another Keeper action owns this project. Read the saved original before retrying.",
          );
        return intentMetadata(locked.value);
      });
    },
    discoverKeeperBrief(projectId: string): KeeperBriefIntentMetadata | null {
      if (options.address)
        throw new ConversationError(
          400,
          "Keeper brief originals belong to the standing conversation.",
        );
      const active = store.discoverKeeperBrief(projectId);
      return active
        ? intentMetadata(assertServedBriefIntent(projectId, active))
        : null;
    },
    readKeeperBriefIntent(
      projectId: string,
      requestId: string,
    ): KeeperBriefIntent | null {
      if (options.address)
        throw new ConversationError(
          400,
          "Keeper brief originals belong to the standing conversation.",
        );
      const found = store.readKeeperBriefIntent(projectId, requestId);
      return found ? assertServedBriefIntent(projectId, found) : null;
    },
    async retireKeeperBrief(
      projectId: string,
      input: { requestId: string; intentHash: string },
    ): Promise<KeeperBriefIntentMetadata> {
      if (options.address)
        throw new ConversationError(
          400,
          "Keeper brief originals belong to the standing conversation.",
        );
      assertServedBriefIntent(
        projectId,
        store.readKeeperBriefIntent(projectId, input.requestId),
      );
      const locked = await withQueueLock(
        leaseFor(projectId),
        async () => store.retireKeeperBrief(projectId, input),
        { waitMs: 300 },
      );
      if (!locked.ok)
        throw new ConversationError(
          409,
          "Another Keeper action owns this project. Read the saved original before retrying.",
        );
      return intentMetadata(locked.value);
    },
    async commitKeeperBrief(
      projectId: string,
      input: {
        requestId: string;
        expectedRevision: number;
        intentHash: string;
      },
    ): Promise<ConversationReceipt> {
      const checked = keeperBriefIntentReferenceSchema.safeParse(input);
      if (!checked.success || options.address)
        throw new ConversationError(400, "Expected an exact Keeper brief ticket.");
      const reference = checked.data;
      const original = assertServedBriefIntent(
        projectId,
        store.readKeeperBriefIntent(projectId, reference.requestId),
      );
      if (
        original.intentHash !== reference.intentHash ||
        original.expectedRevision !== reference.expectedRevision
      )
        throw new ConversationError(
          409,
          "The Keeper brief ticket does not match its saved original.",
        );
      // Settled identity reads never need a live project or provider configuration.
      if (original.state === "admitted")
        return (
          await store.acceptKeeperBrief(projectId, reference, () => !closed)
        ).receipt;
      if (original.state === "retired")
        throw new ConversationError(409, "This Keeper brief reservation was retired.");
      const currentJob = jobs.get(projectId);
      if (currentJob) {
        if (currentJob.requestId !== reference.requestId)
          throw new ConversationError(
            409,
            "This hearth already owns an active turn. No new turn was accepted.",
          );
        await currentJob.admission;
        return receipt(store.read(projectId), reference.requestId);
      }
      const currentAdmission = keeperBriefAdmissions.get(projectId);
      if (currentAdmission) {
        if (currentAdmission.requestId !== reference.requestId)
          throw new ConversationError(
            409,
            "This hearth already owns a Keeper brief admission. No new turn was accepted.",
          );
        await currentAdmission.admission;
        return receipt(store.read(projectId), reference.requestId);
      }
      const runtime = options.keeperRuntime;
      if (!runtime)
        throw new ConversationError(
          503,
          "Keeper readiness is unavailable. The reviewed original has been kept.",
        );
      const abort = new AbortController();
      const owner = randomUUID();
      let admitted = false;
      let accept: (value: ConversationReceipt) => void = () => {};
      let refuse: (error: unknown) => void = () => {};
      const admission = new Promise<ConversationReceipt>((resolve, reject) => {
        accept = resolve;
        refuse = reject;
      });
      let job = Promise.resolve();
      const admissionOwner = {
        job: Promise.resolve(),
        abort,
        requestId: reference.requestId,
        admission,
      };
      keeperBriefAdmissions.set(projectId, admissionOwner);
      job = (async () => {
        const locked = await withQueueLock(
          leaseFor(projectId),
          async () => {
            if (closed || abort.signal.aborted)
              throw new ConversationError(503, "This hearth is closing.");
            const retained = assertServedBriefIntent(
              projectId,
              store.readKeeperBriefIntent(projectId, reference.requestId),
            );
            if (
              retained.intentHash !== reference.intentHash ||
              retained.expectedRevision !== reference.expectedRevision
            )
              throw new ConversationError(409, "The saved brief ticket changed.");
            if (retained.state === "admitted") {
              const replay = await store.acceptKeeperBrief(
                projectId,
                reference,
                () =>
                  !closed &&
                  !abort.signal.aborted &&
                  keeperBriefAdmissions.get(projectId)?.abort === abort,
              );
              admitted = true;
              accept(replay.receipt);
              return;
            }
            if (retained.state !== "reserved")
              throw new ConversationError(409, "This Keeper brief reservation was retired.");
            const current = projectCatalogFor(projectId);
            const requestOrigin: KeeperBriefOriginRequest =
              retained.origin.kind === "overview"
                ? { kind: "overview" }
                : {
                    kind: "onboarding",
                    projectCreateRequestId:
                      retained.origin.projectCreate.requestId,
                  };
            const liveOrigin = trustedBriefOrigin(
              projectId,
              current.scope,
              current.catalog.revision,
              requestOrigin,
            );
            const liveSelection = trustedBriefSelection(
              current.project,
              store.read(projectId),
            );
            if (
              JSON.stringify(liveOrigin) !== JSON.stringify(retained.origin) ||
              !sameSelection(liveSelection, retained.selection)
            )
              throw new ConversationError(
                409,
                "The project scope or Keeper selection changed after review. Read the saved original before reserving another.",
              );
            const state = store.read(projectId);
            if (state.revision !== retained.expectedRevision)
              throw new ConversationError(
                409,
                "The conversation changed after review. The saved original has been kept.",
              );
            if (
              state.binding &&
              state.binding.provider !== liveSelection.provider
            )
              throw new ConversationError(
                409,
                "The selected Keeper provider differs from the saved conversation. Resolve continuity before committing this brief.",
              );
            const transport = runtime.transport(liveSelection);
            if (!transport)
              throw new ConversationError(
                503,
                "The reviewed Keeper adapter is unavailable. The original has been kept.",
              );
            const readiness = await runtime.readiness(
              liveSelection,
              current.project,
              options.root,
              state.binding,
              liveSelection,
            );
            if (!readiness.canStart)
              throw new ConversationError(503, readiness.reason);
            const currentBinding = () => {
              if (
                closed ||
                abort.signal.aborted ||
                keeperBriefAdmissions.get(projectId)?.abort !== abort
              )
                return false;
              try {
                const fresh = projectCatalogFor(projectId);
                const freshOrigin = trustedBriefOrigin(
                  projectId,
                  fresh.scope,
                  fresh.catalog.revision,
                  requestOrigin,
                );
                const freshSelection = trustedBriefSelection(
                  fresh.project,
                  store.read(projectId),
                );
                return (
                  store.read(projectId).revision ===
                    retained.expectedRevision &&
                  JSON.stringify(freshOrigin) ===
                    JSON.stringify(retained.origin) &&
                  sameSelection(freshSelection, retained.selection)
                );
              } catch {
                return false;
              }
            };
            if (!currentBinding())
              throw new ConversationError(
                409,
                "The project scope or Keeper selection changed during readiness. The reviewed original has been kept.",
              );
            const result = await store.acceptKeeperBrief(
              projectId,
              reference,
              currentBinding,
            );
            if (!result.created) {
              admitted = true;
              accept(result.receipt);
              return;
            }
            await store.start(projectId, reference.requestId, owner);
            owned.add(projectId);
            admitted = true;
            jobs.set(projectId, {
              job,
              abort,
              requestId: reference.requestId,
              admission,
            });
            accept(receipt(store.read(projectId), reference.requestId));
            notify(projectId, reference.requestId);
            try {
              const runResult = await transport.run(
                {
                  project: current.project,
                  root: options.root,
                  input: {
                    requestId: retained.requestId,
                    expectedRevision: retained.expectedRevision,
                    text: retained.text,
                    about: retained.about,
                    brief: retained.snapshot,
                  },
                  resume: state.binding,
                  smith: retained.selection.name,
                  expectedSmith: retained.selection,
                },
                async (event) => {
                  await store.append(
                    projectId,
                    reference.requestId,
                    owner,
                    event,
                  );
                  notify(projectId, reference.requestId);
                },
                abort.signal,
              );
              await store.finish(
                projectId,
                reference.requestId,
                owner,
                abort.signal.aborted ? "cancelled" : runResult.phase,
                runResult.reason,
              );
            } catch (error) {
              const selectionMismatch =
                error instanceof KeeperSelectionMismatchError ? error : null;
              await store.finish(
                projectId,
                reference.requestId,
                owner,
                abort.signal.aborted
                  ? "cancelled"
                  : selectionMismatch
                    ? "failed"
                    : "unknown",
                abort.signal.aborted
                  ? "The supervised turn was stopped."
                  : selectionMismatch
                    ? selectionMismatch.message
                    : "The provider did not report a confirmed outcome. This turn was not resent.",
              );
            }
            notify(projectId, reference.requestId);
          },
          { waitMs: 300 },
        );
        if (!locked.ok) {
          const latest = store.readKeeperBriefIntent(
            projectId,
            reference.requestId,
          );
          if (latest?.state === "admitted") {
            const replay = await store.acceptKeeperBrief(
              projectId,
              reference,
              () => !closed,
            );
            admitted = true;
            accept(replay.receipt);
          } else
            throw new ConversationError(
              409,
              "Another hearth owns this project. Read the saved original before retrying.",
            );
        }
      })()
        .catch((error) => {
          if (!admitted) refuse(error);
        })
        .finally(() => {
          if (keeperBriefAdmissions.get(projectId)?.abort === abort)
            keeperBriefAdmissions.delete(projectId);
          if (jobs.get(projectId)?.abort === abort) {
            jobs.delete(projectId);
            owned.delete(projectId);
          }
        });
      admissionOwner.job = job;
      return admission;
    },
    async recovery(
      projectId: string,
      requestId?: string,
    ): Promise<KeeperRecoveryPage> {
      const project = projectFor(projectId),
        state = await observe(projectId),
        runtime = options.keeperRuntime;
      if (closed || !runtime || options.address)
        throw new ConversationError(
          503,
          "Keeper smith recovery is unavailable in this build.",
        );
      const catalog = runtime.catalog(),
        selectedSmith =
          savedKeeperSmith(state) ??
          project.keeperSmith ??
          catalog.defaultSmith;
      if (catalog.smiths.length > 100)
        throw new ConversationError(
          503,
          "The Keeper smith catalog exceeds its supported bound.",
        );
      const key = JSON.stringify([
        projectId,
        state.revision,
        state.binding,
        catalog.smiths,
      ]);
      let checks = readinessReads.get(key);
      if (!checks) {
        checks = Promise.allSettled(
          catalog.smiths.map((smith) =>
            boundedReadiness(async () => ({
              smith,
              readiness: await runtime.readiness(
                smith,
                project,
                options.root,
                state.binding,
              ),
            })),
          ),
        )
          .then((results) =>
            results.map((result) => {
              if (result.status === "rejected") throw result.reason;
              return result.value;
            }),
          )
          .finally(() => readinessReads.delete(key));
        readinessReads.set(key, checks);
      }
      const page: KeeperRecoveryPage = {
        projectId,
        conversationRevision: state.revision,
        selectedSmith,
        choices: await checks,
        continuation: state.keeperRecovery?.continuation ?? null,
        request:
          state.keeperRecovery?.records.find(
            (item) => item.requestId === requestId,
          ) ?? null,
      };
      if (Buffer.byteLength(JSON.stringify(page)) > 128_000)
        throw new ConversationError(
          503,
          "The Keeper readiness report exceeds its bounded read size. The saved selection and conversation have been kept.",
        );
      return page;
    },
    async continueKeeper(projectId: string, raw: KeeperContinuationRequest) {
      const parsed = keeperContinuationSchema.safeParse(raw);
      if (!parsed.success)
        throw new ConversationError(
          400,
          "Expected an explicit smith, revision and reviewed summary.",
        );
      const input = parsed.data,
        project = projectFor(projectId),
        current = store.read(projectId);
      // Reconcile committed intent before reading mutable configuration/readiness.
      if (
        current.keeperRecovery?.records.some(
          (item) => item.requestId === input.requestId,
        )
      )
        return store.continueKeeper(projectId, input, "claude");
      const runtime = options.keeperRuntime;
      if (closed || options.address || !runtime)
        throw new ConversationError(
          503,
          "Keeper smith recovery is unavailable. The saved conversation has been kept.",
        );
      if (
        !project.workspaces.some(
          (scope) => workspaceKey(scope.root) === workspaceKey(workspace),
        )
      )
        throw new ConversationError(
          409,
          "This hearth does not serve the project's workspace.",
        );
      const changed = await withQueueLock(
        leaseFor(projectId),
        async () => {
          const state = store.read(projectId);
          if (
            state.keeperRecovery?.records.some(
              (item) => item.requestId === input.requestId,
            )
          )
            return store.continueKeeper(projectId, input, "claude");
          if (closed)
            throw new ConversationError(
              503,
              "This hearth is closing. The Keeper was not changed.",
            );
          if (
            state.revision !== input.expectedRevision ||
            state.turns.some(
              (item) => activePhase(item.phase) || item.phase === "unknown",
            )
          )
            throw new ConversationError(
              409,
              "The conversation changed or a turn is unresolved. Read it before changing the Keeper.",
            );
          const ready = await prepareKeeper(
            runtime,
            project,
            options.root,
            input.mode === "fresh" ? null : state.binding,
            input.smith,
          );
          if (closed)
            throw new ConversationError(
              503,
              "This hearth is closing. The Keeper was not changed.",
            );
          return store.continueKeeper(projectId, input, ready.smith.provider);
        },
        { waitMs: 300 },
      );
      if (!changed.ok)
        throw new ConversationError(
          409,
          "Another hearth owns an active turn. The Keeper was not changed.",
        );
      try {
        options.onRecoveryChange?.(projectId);
      } catch {
        /* A read notification never repeats a write. */
      }
      return changed.value;
    },
    async briefs(projectId: string) {
      return keeperBriefs(await observe(projectId));
    },
    async read(
      projectId: string,
      query: { after?: number; limit?: number; requestId?: string } = {},
    ): Promise<ConversationPage> {
      validateConversationPageQuery(query);
      const state = await observe(projectId);
      return conversationPage(state, query, owned.has(projectId));
    },
    async send(
      projectId: string,
      rawInput: SessionMessage,
      purpose: "message" | "brief" = "message",
      initialStartAttempt?: InitialStartAttempt,
      capability?: typeof forkChildTurnCapability,
    ): Promise<ConversationReceipt> {
      const forkChildTurn = capability === forkChildTurnCapability;
      if (forkChildTurn && !options.prepareForkCodexChat)
        throw new ConversationError(
          409,
          "This session has no verified Fork-child continuation capability.",
        );
      const wireInput: SessionMessage =
        options.prepareSession ||
        options.prepareCodexTask ||
        options.prepareCodexChat ||
        options.prepareForkCodexChat ||
        options.prepareGeminiChat ||
        options.prepareGeminiTask
          ? parseSessionSend(rawInput)
          : parseConversationSend(rawInput);
      const privateInput: ConversationSend = {
        requestId: wireInput.requestId,
        expectedRevision: wireInput.expectedRevision,
        text: wireInput.text,
        about: wireInput.about,
      };
      let input: PreparedConversationSend = privateInput;
      let codexResumeSettings:
        | {
            modelProvider: string;
            serviceTier: string | null;
            reasoningEffort: string | null;
          }
        | undefined;
      const project = projectFor(projectId);
      const current = store.read(projectId);
      const original = () => {
        const user = store
          .read(projectId)
          .frames.find(
            (frame) =>
              frame.turnId === input.requestId && frame.event.kind === "user",
          )?.event;
        if (options.prepareGeminiChat) {
          if (
            user?.kind !== "user" ||
            !user.geminiChat ||
            JSON.stringify(wireInput.attachments ?? []) !==
              JSON.stringify(user.geminiChat.launch.attachments ?? [])
          )
            throw new ConversationError(
              409,
              "This request id already names different content. Read the original request.",
            );
          return { ...privateInput, geminiChat: user.geminiChat };
        }
        if (options.prepareGeminiTask) {
          if (
            user?.kind !== "user" ||
            !user.geminiTask ||
            JSON.stringify(wireInput.attachments ?? []) !==
              JSON.stringify(user.geminiTask.launch.attachments ?? [])
          )
            throw new ConversationError(
              409,
              "This request id already names different content. Read the original request.",
            );
          return { ...privateInput, geminiTask: user.geminiTask };
        }
        if (options.prepareCodexChat) {
          if (
            user?.kind !== "user" ||
            !user.codexChat ||
            JSON.stringify(wireInput.attachments ?? []) !==
              JSON.stringify(user.codexChat.launch.attachments ?? [])
          )
            throw new ConversationError(
              409,
              "This request id already names different content. Read the original request.",
            );
          return { ...privateInput, codexChat: user.codexChat };
        }
        if (options.prepareCodexTask) {
          if (
            user?.kind !== "user" ||
            !user.codexTask ||
            JSON.stringify(wireInput.attachments ?? []) !==
              JSON.stringify(user.codexTask.launch.attachments ?? [])
          )
            throw new ConversationError(
              409,
              "This request id already names different content. Read the original request.",
            );
          return { ...privateInput, codexTask: user.codexTask };
        }
        if (options.prepareSession) {
          if (user?.kind !== "user" || !user.session)
            throw new ConversationError(
              409,
              "This request id already names different content. Read the original request.",
            );
          if (
            JSON.stringify(wireInput.attachments ?? []) !==
            JSON.stringify(user.session.launch.attachments ?? [])
          )
            throw new ConversationError(
              409,
              "This request id already names different content. Read the original request.",
            );
          return { ...privateInput, session: user.session };
        }
        if (purpose !== "brief") return wireInput;
        if (user?.kind !== "user" || !user.brief)
          throw new ConversationError(
            409,
            "This request id already names different content. Read the original request.",
          );
        return { ...wireInput, brief: user.brief };
      };
      if (current.turns.some((item) => item.requestId === input.requestId)) {
        markInitialStartAcceptEntered(initialStartAttempt);
        return store.accept(projectId, original());
      }
      if (
        (options.prepareSession ||
          options.prepareCodexTask ||
          options.prepareCodexChat ||
          options.prepareGeminiChat ||
          options.prepareGeminiTask) &&
        purpose !== "message"
      )
        throw new ConversationError(
          400,
          "Owned coding sessions cannot create Keeper briefs.",
        );
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No turn was accepted.",
        );
      if (
        !project.workspaces.some(
          (scope) => workspaceKey(scope.root) === workspaceKey(workspace),
        )
      )
        throw new ConversationError(
          409,
          "This hearth does not serve this project's workspace. No turn was accepted.",
        );
      if (input.about.length) {
        if (!options.validateAbout)
          throw new ConversationError(
            400,
            "Object context requires the project-scoped reader. No turn was accepted.",
          );
        await options.validateAbout(projectId, input.about);
      }
      if (purpose === "brief" && !options.prepareBrief)
        throw new ConversationError(
          503,
          "Brief source preparation is unavailable. No turn was accepted.",
        );
      let selected =
        options.keeperRuntime && !options.address
          ? await prepareKeeper(
              options.keeperRuntime,
              project,
              options.root,
              current.binding,
              savedKeeperSmith(current) ?? project.keeperSmith,
            )
          : { transport: options.transport, smith: null };
      if (
        current.binding &&
        current.binding.provider !== selected.transport.provider
      )
        throw new ConversationError(
          409,
          "The configured provider differs from the saved conversation. Continuity must be resolved before sending.",
        );
      if ((!options.keeperRuntime || options.address) && !initialStartAttempt)
        await selected.transport.check?.({
          project,
          root: options.root,
          resume: current.binding,
          ...(selected.smith ? { smith: selected.smith.name } : {}),
        });
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No turn was accepted.",
        );
      const existing = jobs.get(projectId);
      if (existing) {
        if (existing.requestId !== input.requestId)
          throw new ConversationError(
            409,
            "This hearth already owns an active turn. No new turn was accepted.",
          );
        await existing.admission;
        markInitialStartAcceptEntered(initialStartAttempt);
        return store.accept(projectId, original());
      }
      const abort = new AbortController();
      const owner = randomUUID();
      let admitted = false;
      let accept: (value: ConversationReceipt) => void = () => {};
      let refuse: (error: unknown) => void = () => {};
      const answer = new Promise<ConversationReceipt>((resolve, reject) => {
        accept = resolve;
        refuse = reject;
      });
      const job = (async () => {
        const locked = await withQueueLock(
          leaseFor(projectId),
          async () => {
            if (closed || abort.signal.aborted)
              throw new ConversationError(
                503,
                "This hearth is closing. No turn was accepted.",
              );
            await store.recover(projectId);
            const atAdmission = store.read(projectId);
            if (
              options.keeperRuntime &&
              !options.address &&
              !atAdmission.turns.some(
                (turn) => turn.requestId === input.requestId,
              )
            )
              selected = await prepareKeeper(
                options.keeperRuntime,
                project,
                options.root,
                atAdmission.binding,
                savedKeeperSmith(atAdmission) ??
                  projectFor(projectId).keeperSmith,
              );
            if (
              atAdmission.binding &&
              atAdmission.binding.provider !== selected.transport.provider
            )
              throw new ConversationError(
                409,
                "The configured provider changed. Review a continuation before sending; no turn was accepted.",
              );
            // Preflight can take time. Recheck new context at admission; exact
            // retries always reconcile their saved receipt without fresh authority.
            if (
              input.about.length &&
              !store
                .read(projectId)
                .turns.some((turn) => turn.requestId === input.requestId)
            )
              await options.validateAbout?.(projectId, input.about);
            if (purpose === "brief") {
              if (
                store
                  .read(projectId)
                  .turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                const snapshot = briefSnapshotSchema.safeParse(
                  await options.prepareBrief?.(projectId),
                );
                if (!snapshot.success || snapshot.data.projectId !== projectId)
                  throw new ConversationError(
                    503,
                    "The scoped brief snapshot could not be verified. No turn was accepted.",
                  );
                input = { ...wireInput, brief: snapshot.data };
              }
            }
            if (options.prepareSession) {
              const latest = store.read(projectId);
              if (
                latest.turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                let prepared: SessionTurnSnapshot;
                try {
                  prepared = await options.prepareSession({
                    project: projectFor(projectId),
                    input: wireInput,
                    resume: latest.binding,
                  });
                } catch (error) {
                  noteInitialStartPreparationRefusal(
                    initialStartAttempt,
                    error,
                  );
                  throw error;
                }
                const snapshot = sessionTurnSnapshotSchema.safeParse(prepared);
                if (
                  !snapshot.success ||
                  snapshot.data.launch.prompt !== wireInput.text ||
                  JSON.stringify(snapshot.data.launch.attachments ?? []) !==
                    JSON.stringify(wireInput.attachments ?? [])
                )
                  throw new ConversationError(
                    503,
                    "The private session launch could not be verified. No turn was accepted.",
                  );
                input = { ...privateInput, session: snapshot.data };
              }
            }
            if (options.prepareCodexTask) {
              const latest = store.read(projectId);
              if (
                latest.turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                let prepared: PreparedCodexTask;
                try {
                  prepared = await options.prepareCodexTask({
                    project: projectFor(projectId),
                    input: wireInput,
                    resume: latest.binding,
                  });
                } catch (error) {
                  noteInitialStartPreparationRefusal(
                    initialStartAttempt,
                    error,
                  );
                  throw error;
                }
                const snapshot = preparedCodexTaskSchema.safeParse(prepared);
                if (
                  !snapshot.success ||
                  snapshot.data.launch.prompt !== wireInput.text ||
                  JSON.stringify(snapshot.data.launch.attachments ?? []) !==
                    JSON.stringify(wireInput.attachments ?? [])
                )
                  throw new ConversationError(
                    503,
                    "The private Codex Task could not be verified. No turn was accepted.",
                  );
                input = { ...privateInput, codexTask: snapshot.data };
              }
            }
            if (options.prepareForkCodexChat && forkChildTurn) {
              const latest = store.read(projectId);
              if (
                latest.turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                const prepared = await options.prepareForkCodexChat({
                  project: projectFor(projectId),
                  input: wireInput,
                  resume: latest.binding,
                });
                const snapshot = preparedCodexChatSchema.safeParse(
                  prepared.prepared,
                );
                if (
                  !snapshot.success ||
                  snapshot.data.launch.prompt !== wireInput.text ||
                  JSON.stringify(snapshot.data.launch.attachments ?? []) !==
                    JSON.stringify(wireInput.attachments ?? []) ||
                  !prepared.resumeSettings.modelProvider ||
                  (prepared.resumeSettings.serviceTier !== null &&
                    typeof prepared.resumeSettings.serviceTier !== "string") ||
                  (prepared.resumeSettings.reasoningEffort !== null &&
                    typeof prepared.resumeSettings.reasoningEffort !== "string")
                )
                  throw new ConversationError(
                    503,
                    "The source-sealed Fork child continuation could not be verified. No turn was accepted.",
                  );
                input = { ...privateInput, codexChat: snapshot.data };
                codexResumeSettings = prepared.resumeSettings;
              }
            } else if (options.prepareCodexChat) {
              const latest = store.read(projectId);
              if (
                latest.turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                let prepared: PreparedCodexChat;
                try {
                  prepared = await options.prepareCodexChat({
                    project: projectFor(projectId),
                    input: wireInput,
                    resume: latest.binding,
                  });
                } catch (error) {
                  noteInitialStartPreparationRefusal(
                    initialStartAttempt,
                    error,
                  );
                  throw error;
                }
                const snapshot = preparedCodexChatSchema.safeParse(prepared);
                if (
                  !snapshot.success ||
                  snapshot.data.launch.prompt !== wireInput.text ||
                  JSON.stringify(snapshot.data.launch.attachments ?? []) !==
                    JSON.stringify(wireInput.attachments ?? [])
                )
                  throw new ConversationError(
                    503,
                    "The private Codex Chat could not be verified. No turn was accepted.",
                  );
                input = { ...privateInput, codexChat: snapshot.data };
              }
            }
            if (options.prepareGeminiTask) {
              const latest = store.read(projectId);
              if (
                latest.turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                let prepared: PreparedGeminiTask;
                try {
                  prepared = await options.prepareGeminiTask({
                    project: projectFor(projectId),
                    input: wireInput,
                    resume: latest.binding,
                  });
                } catch (error) {
                  noteInitialStartPreparationRefusal(
                    initialStartAttempt,
                    error,
                  );
                  throw error;
                }
                const snapshot = preparedGeminiTaskSchema.safeParse(prepared);
                if (
                  !snapshot.success ||
                  snapshot.data.launch.prompt !== wireInput.text ||
                  JSON.stringify(snapshot.data.launch.attachments ?? []) !==
                    JSON.stringify(wireInput.attachments ?? [])
                )
                  throw new ConversationError(
                    503,
                    "The private Gemini Task could not be verified. No turn was accepted.",
                  );
                input = { ...privateInput, geminiTask: snapshot.data };
              }
            }
            if (options.prepareGeminiChat) {
              const latest = store.read(projectId);
              if (
                latest.turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                let prepared: PreparedGeminiChat;
                try {
                  prepared = await options.prepareGeminiChat({
                    project: projectFor(projectId),
                    input: wireInput,
                    resume: latest.binding,
                  });
                } catch (error) {
                  noteInitialStartPreparationRefusal(
                    initialStartAttempt,
                    error,
                  );
                  throw error;
                }
                const snapshot = preparedGeminiChatSchema.safeParse(prepared);
                if (
                  !snapshot.success ||
                  snapshot.data.launch.prompt !== wireInput.text ||
                  JSON.stringify(snapshot.data.launch.attachments ?? []) !==
                    JSON.stringify(wireInput.attachments ?? [])
                )
                  throw new ConversationError(
                    503,
                    "The private Gemini Chat could not be verified. No turn was accepted.",
                  );
                input = { ...privateInput, geminiChat: snapshot.data };
              }
            }
            if (closed || abort.signal.aborted)
              throw new ConversationError(
                503,
                "The hearth closed during source preparation. No turn was accepted.",
              );
            markInitialStartAcceptEntered(initialStartAttempt);
            const accepted = await store.accept(projectId, input);
            if (accepted.turn.phase !== "accepted") {
              admitted = true;
              accept(accepted);
              return;
            }
            await store.start(projectId, input.requestId, owner);
            owned.add(projectId);
            admitted = true;
            accept(receipt(store.read(projectId), input.requestId));
            notify(projectId, input.requestId);
            try {
              const state = store.read(projectId);
              const retained =
                state.binding === null &&
                state.keeperRecovery?.continuation.summary
                  ? `Retained context reviewed by the operator (source revision ${state.keeperRecovery.continuation.expectedRevision}):\n${state.keeperRecovery.continuation.summary}\n\nCurrent request:\n`
                  : "";
              const turnInput = input.brief
                ? { ...input, text: keeperBriefPrompt(input.brief) }
                : input;
              const result = await selected.transport.run(
                {
                  project,
                  root: options.root,
                  input: retained
                    ? { ...turnInput, text: retained + turnInput.text }
                    : turnInput,
                  resume: state.binding,
                  ...(codexResumeSettings ? { codexResumeSettings } : {}),
                  ...(options.ownerLifecycle &&
                  selected.transport.provider === "codex" &&
                  !forkChildTurn
                    ? {
                        ownerLifecycle: options.ownerLifecycle({
                          projectId,
                          requestId: input.requestId,
                          owner,
                        }),
                      }
                    : {}),
                  ...(selected.smith ? { smith: selected.smith.name } : {}),
                },
                async (event) => {
                  await store.append(projectId, input.requestId, owner, event);
                  notify(projectId, input.requestId);
                },
                abort.signal,
              );
              await store.finish(
                projectId,
                input.requestId,
                owner,
                abort.signal.aborted ? "cancelled" : result.phase,
                result.reason,
              );
            } catch {
              // Dispatch may already have reached the provider. Preserve partial output and uncertainty.
              await store.finish(
                projectId,
                input.requestId,
                owner,
                abort.signal.aborted ? "cancelled" : "unknown",
                abort.signal.aborted
                  ? "The supervised turn was stopped."
                  : "The provider did not report a confirmed outcome. This turn was not resent.",
              );
            }
            notify(projectId, input.requestId);
          },
          { waitMs: 300 },
        );
        if (!locked.ok) {
          if (
            store
              .read(projectId)
              .turns.some((turn) => turn.requestId === input.requestId)
          ) {
            markInitialStartAcceptEntered(initialStartAttempt);
            const previous = await store.accept(projectId, original());
            admitted = true;
            accept(previous);
          } else
            throw new ConversationError(
              409,
              "Another hearth owns an active turn. No new turn was accepted.",
            );
        }
      })()
        .catch((error) => {
          if (!admitted) refuse(error);
        })
        .finally(() => {
          if (jobs.get(projectId)?.abort === abort) {
            jobs.delete(projectId);
            owned.delete(projectId);
          }
        });
      jobs.set(projectId, {
        job,
        abort,
        requestId: input.requestId,
        admission: answer,
      });
      return answer;
    },
    sendForkChildTurn(projectId: string, input: SessionMessage) {
      return this.send(
        projectId,
        input,
        "message",
        undefined,
        forkChildTurnCapability,
      );
    },
    async stop(
      projectId: string,
      requestId: string,
    ): Promise<ConversationReceipt> {
      projectFor(projectId);
      const before = receipt(store.read(projectId), requestId);
      const active = jobs.get(projectId);
      if (
        ["running", "cancelling"].includes(before.turn.phase) &&
        (!owned.has(projectId) || active?.requestId !== requestId)
      )
        throw new ConversationError(
          409,
          "This hearth does not own the turn's process. It has not confirmed a stop.",
        );
      if (!activePhase(before.turn.phase)) return before;
      await store.requestStop(projectId, requestId);
      active?.abort.abort();
      notify(projectId, requestId);
      return receipt(store.read(projectId), requestId);
    },
    async settled(projectId: string) {
      await jobs.get(projectId)?.job;
    },
    async close() {
      closed = true;
      for (const { abort } of jobs.values()) abort.abort();
      for (const { abort } of keeperBriefAdmissions.values()) abort.abort();
      await Promise.all([
        ...[...jobs.values()].map((item) => item.job),
        ...[...keeperBriefAdmissions.values()].map((item) => item.job),
      ]);
      await Promise.allSettled([...readinessReads.values()]);
      await Promise.allSettled([...pendingBriefReservations]);
    },
  };
}
