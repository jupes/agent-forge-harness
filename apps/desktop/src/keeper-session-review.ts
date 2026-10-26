import type { ActionOutcome } from "../../../docs/js/action-outcome";
import {
  keeperSessionStartReceiptSchema,
  keeperSessionStartRequestSchema,
} from "../../../scripts/keeper/session-start-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import { canonicalSessionInput } from "../../../scripts/sessions/preparation";
import type { WorktreeEntry } from "../../../types/beads";
import type { SmithsView } from "../../../types/hearth";
import type { KeeperProposal } from "../../../types/keeper-proposal";
import type {
  KeeperSessionStartReceipt,
  KeeperSessionStartRequest,
} from "../../../types/keeper-session-start";
import type {
  SessionStartReceipt,
  SessionStartRequest,
} from "../../../types/session-requests";
import type { SessionWorktreeRequest } from "../../../types/session-worktrees";
import type { KeeperSessionIdentities } from "./keeper-session-identities";
import {
  chooseSessionSmith,
  newSessionDraft,
  type SessionComposerDraft,
  sessionStartBody,
} from "./session-composer";
import type { SessionComposerOwner } from "./session-composer-owner";
import { createSessionWorktreeClient } from "./session-worktree-client";

/** A proposal's current location has no path; only its own checked main may fill it. */
export function prefillKeeperSession(
  source: KeeperProposal,
  smiths: SmithsView,
  worktrees: WorktreeEntry[],
) {
  const action = source.draft.action;
  if (action.kind !== "start-session")
    throw new Error("This card does not propose a session.");
  let draft: SessionComposerDraft = {
    ...newSessionDraft(),
    initialized: true,
    prompt: action.prompt,
    repository: action.repository,
    beadId: action.beadId,
    smith: action.smith,
    where: action.worktree === "new" ? "new" : "existing",
    mode: "task",
  };
  const selected = smiths.smiths.find((item) => item.name === action.smith);
  const locked = action.provider !== "claude";
  let reason = locked
    ? `The proposed ${action.provider} session adapter is unavailable in this composer. No provider was selected automatically.`
    : "";
  if (!locked && selected?.enabled && selected.provider === "claude")
    draft = chooseSessionSmith(draft, selected);
  else if (!locked)
    reason =
      "The proposed smith is missing, disabled or has no Claude session adapter. Explicitly choose an enabled smith before Start.";
  if (action.worktree === "current") {
    const main = worktrees.find(
      (item) =>
        item.kind === "main" &&
        !item.missing &&
        workspaceKey(item.path) === workspaceKey(action.repository),
    );
    if (main) {
      draft.worktree = main.path;
      draft.where = "main";
    } else
      reason ||=
        "The proposal has no checked current worktree path. Explicitly choose a registered worktree or create one before Start.";
  }
  return { draft, locked, reason };
}

function savedDraft(input: SessionStartRequest): SessionComposerDraft {
  return {
    ...newSessionDraft(),
    initialized: true,
    prompt: input.launch.prompt,
    attachments: structuredClone(input.launch.attachments ?? []),
    about: structuredClone(input.about ?? []),
    repository: input.repository,
    worktree: input.worktree,
    where:
      workspaceKey(input.repository) === workspaceKey(input.worktree)
        ? "main"
        : "existing",
    beadId: input.beadId ?? "",
    mode: input.launch.mode,
    smith: input.smith,
    custom: true,
    model: input.launch.model,
    effort: input.launch.effort ?? "",
    permissionMode: input.launch.permissionMode ?? "acceptEdits",
    fallbackModels: input.launch.fallbackModels?.join(", ") ?? "",
    extraDirectories: input.launch.extraDirectories?.join("\n") ?? "",
    maxBudgetUsd:
      input.launch.maxBudgetUsd === undefined
        ? ""
        : String(input.launch.maxBudgetUsd),
    outputSchema: input.launch.outputSchema
      ? JSON.stringify(input.launch.outputSchema)
      : "",
  };
}
export async function reviewedStartHash(
  input: SessionStartRequest,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalSessionInput(input)),
  );
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export interface KeeperSessionReview {
  source: KeeperProposal;
  revision: number;
  view: ReturnType<SessionComposerOwner["project"]>;
  reason: string;
  providerLocked: boolean;
  loaded: boolean;
  original: KeeperSessionStartRequest | null;
  expectedRequestId: string | null;
  result: KeeperSessionStartReceipt | null;
  owner: SessionComposerOwner;
}

/** App-root private drafts and exact original actions, shared by full Keeper and drawer. */
export function createKeeperSessionReviews(deps: {
  canWrite(): boolean;
  requestId(): string;
  identities: KeeperSessionIdentities;
  read(
    projectId: string,
    proposalId: string,
    requestId?: string,
  ): Promise<unknown | null>;
  post(
    projectId: string,
    proposalId: string,
    input: KeeperSessionStartRequest,
  ): Promise<ActionOutcome & { notSent?: true }>;
  createWorktree(
    projectId: string,
    input: SessionWorktreeRequest,
  ): Promise<ActionOutcome>;
  readWorktree(projectId: string, requestId: string): Promise<unknown>;
  adopt(
    projectId: string,
    input: SessionStartRequest,
    raw: SessionStartReceipt,
  ): boolean;
}) {
  const entries = new Map<string, KeeperSessionReview>(),
    retryableNotSent = new WeakMap<KeeperSessionReview, boolean>(),
    listeners = new Set<() => void>();
  let disposed = false;
  const tell = () => {
    if (!disposed) for (const listener of [...listeners]) listener();
  };
  const lock = (entry: KeeperSessionReview) => {
    entry.view.inputLocked =
      !entry.loaded ||
      !entry.view.composer.initialized ||
      entry.view.loading ||
      entry.view.starting ||
      entry.providerLocked ||
      !!entry.original;
  };
  const accept = async (entry: KeeperSessionReview, raw: unknown) => {
    if (entry.view.lastStarted) return;
    const parsed = keeperSessionStartReceiptSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("The saved Start reply could not be verified.");
    const result = parsed.data;
    if (
      result.projectId !== entry.source.projectId ||
      result.proposalId !== entry.source.id ||
      result.original.sourceHash !== entry.source.sourceHash ||
      (entry.expectedRequestId !== null &&
        result.original.start.requestId !== entry.expectedRequestId) ||
      result.record.sourceRequestId !== entry.source.sourceRequestId ||
      (entry.original &&
        canonicalSessionInput(result.original) !==
          canonicalSessionInput(entry.original)) ||
      result.revision < (entry.result?.revision ?? 0) ||
      (await reviewedStartHash(result.original.start)) !== result.startHash
    )
      throw new Error(
        "The saved Start did not match this proposal and exact reviewed input.",
      );
    if (disposed || entry.view.lastStarted) return;
    if (result.revision < (entry.result?.revision ?? 0)) return;
    if (!entry.original)
      entry.view.composer = savedDraft(result.original.start);
    entry.original = structuredClone(result.original);
    entry.expectedRequestId = result.original.start.requestId;
    entry.result = result;
    entry.loaded = true;
    entry.view.keeperOriginalKnown = true;
    entry.view.pendingStart = structuredClone(result.original.start);
    if (result.session !== null || result.receipt !== null)
      retryableNotSent.set(entry, false);
    entry.view.retryStartAvailable = retryableNotSent.get(entry) === true;
    entry.view.notice = result.record.message;
    if (result.session && result.receipt) {
      if (
        !deps.adopt(entry.source.projectId, result.original.start, {
          session: result.session,
          receipt: result.receipt,
        })
      )
        throw new Error("The admitted session could not be verified.");
      entry.view.pendingStart = null;
      entry.view.lastStarted = result.session.id;
    } else
      entry.view.notice += entry.view.retryStartAvailable
        ? " The original Start was verified as not sent. An explicit retry is available."
        : " No matching original session turn is confirmed. Check before any retry.";
    lock(entry);
    tell();
  };
  const check = async (entry: KeeperSessionReview) => {
    if (entry.view.loading || disposed) return;
    entry.view.loading = true;
    entry.view.retryStartAvailable = false;
    lock(entry);
    tell();
    try {
      const held = deps.identities.read(entry.source);
      if (held && entry.expectedRequestId && held !== entry.expectedRequestId)
        throw Error(
          "The recorded Start identities conflict. A replacement is locked.",
        );
      entry.expectedRequestId ??= held;
      entry.view.keeperOriginalKnown =
        entry.expectedRequestId !== null || entry.original !== null;
      const raw = await deps.read(
        entry.source.projectId,
        entry.source.id,
        entry.original?.start.requestId ?? entry.expectedRequestId ?? undefined,
      );
      if (disposed) return;
      if (raw === null) {
        if (!entry.original && entry.expectedRequestId) {
          entry.loaded = false;
          entry.view.notice =
            "The known original Start is not available in this read. Its recorded request identity is kept; check again to recover its exact reviewed input. A replacement Start is locked.";
          return;
        }
        entry.loaded = true;
        entry.view.retryStartAvailable =
          !entry.view.lastStarted &&
          entry.original !== null &&
          retryableNotSent.get(entry) === true;
        if (!entry.view.lastStarted)
          entry.view.notice = entry.original
            ? entry.view.retryStartAvailable
              ? "The protected check found no original Start record, and the prior request was proven not sent. You may explicitly retry the exact original."
              : "The original Start is not recorded in this read, but the earlier request may still arrive. Its exact input and identity remain held; no retry is available."
            : "Review these options. Only explicit Start authorizes a session.";
      } else await accept(entry, raw);
    } catch (error) {
      if (!entry.view.lastStarted) {
        entry.loaded = false;
        entry.view.retryStartAvailable = retryableNotSent.get(entry) === true;
        entry.view.notice =
          error instanceof Error
            ? `${error.message} Check the original proposal Start again before proceeding.`
            : "The original proposal Start could not be checked.";
      }
    } finally {
      entry.view.loading = false;
      lock(entry);
      tell();
    }
  };
  const post = async (entry: KeeperSessionReview) => {
    const original = entry.original;
    if (
      !original ||
      disposed ||
      entry.view.starting ||
      entry.view.lastStarted ||
      !deps.canWrite()
    )
      return;
    entry.view.starting = true;
    retryableNotSent.set(entry, false);
    entry.view.retryStartAvailable = false;
    entry.view.notice = "Starting the exact reviewed proposal…";
    lock(entry);
    tell();
    let outcome: ActionOutcome;
    try {
      const held = await deps.identities.reserve(
        entry.source,
        () => original.start.requestId,
      );
      if (held.requestId !== original.start.requestId)
        throw Error(
          "The saved Start identity conflicts with this original. No request was sent.",
        );
      if (disposed || !deps.canWrite()) {
        entry.view.starting = false;
        lock(entry);
        tell();
        return;
      }
      outcome = await deps.post(
        entry.source.projectId,
        entry.source.id,
        structuredClone(original),
      );
    } catch (error) {
      outcome = {
        state: "unknown",
        message:
          error instanceof Error
            ? `${error.message} Check the original Start; its exact input and identity are kept.`
            : "The Start reply was lost. Check the original Start; retry uses the exact same input and identity.",
      };
    }
    if (disposed) return;
    entry.view.starting = false;
    if (!entry.view.lastStarted) {
      if (outcome.state === "done") {
        try {
          await accept(entry, outcome.data);
        } catch (error) {
          if (!entry.view.lastStarted)
            entry.view.notice =
              error instanceof Error
                ? error.message
                : "The Start reply could not be verified.";
        }
      } else {
        retryableNotSent.set(
          entry,
          outcome.state === "refused" &&
            "notSent" in outcome &&
            outcome.notSent === true,
        );
        entry.view.retryStartAvailable = retryableNotSent.get(entry) === true;
        entry.view.notice = outcome.message;
      }
    }
    lock(entry);
    tell();
  };
  function make(source: KeeperProposal, revision: number): KeeperSessionReview {
    if (source.draft.action.kind !== "start-session")
      throw new Error("This card does not propose a session.");
    const view: KeeperSessionReview["view"] = {
      composer: newSessionDraft(),
      loading: false,
      starting: false,
      notice: "",
      pendingStart: null,
      lastStarted: null,
      inputLocked: true,
      keeperOriginalKnown: false,
      retryStartAvailable: false,
      ...(source.draft.action.provider !== "claude"
        ? { providerUnavailable: source.draft.action.provider }
        : {}),
    };
    const entry: KeeperSessionReview = {
      source: structuredClone(source),
      revision,
      view,
      reason: "",
      providerLocked: source.draft.action.provider !== "claude",
      loaded: false,
      original: null,
      expectedRequestId: null,
      result: null,
      owner: {
        purpose: "keeper-proposal",
        project: (id) => {
          if (id !== entry.source.projectId)
            throw new Error("This proposal belongs to another project.");
          return view;
        },
        editComposer(id, update) {
          if (id !== entry.source.projectId || view.inputLocked) return;
          view.composer = { ...view.composer, ...structuredClone(update) };
          tell();
        },
        initializeComposer(project, smiths, worktrees) {
          if (
            project.id !== entry.source.projectId ||
            view.composer.initialized
          )
            return;
          const prefill = prefillKeeperSession(entry.source, smiths, worktrees);
          view.composer = prefill.draft;
          entry.reason = prefill.reason;
          entry.providerLocked = prefill.locked;
          lock(entry);
          tell();
        },
        async start(id, input) {
          if (
            disposed ||
            id !== entry.source.projectId ||
            !deps.canWrite() ||
            view.inputLocked ||
            entry.original ||
            entry.expectedRequestId ||
            !entry.loaded
          )
            return;
          let reserving = false;
          try {
            if (
              canonicalSessionInput(input) !==
              canonicalSessionInput(sessionStartBody(view.composer))
            )
              throw new Error("Review the latest draft before Start.");
            const parsed = keeperSessionStartRequestSchema.safeParse({
              sourceHash: entry.source.sourceHash,
              expectedRevision: entry.revision,
              start: {
                ...input,
                // Validate the full body before reserving the real durable identity.
                requestId: "00000000-0000-4000-8000-000000000000",
              },
            });
            if (!parsed.success)
              throw new Error(
                "Review a valid full session request before Start.",
              );
            view.starting = true;
            reserving = true;
            lock(entry);
            tell();
            const held = await deps.identities.reserve(
              entry.source,
              deps.requestId,
            );
            entry.expectedRequestId = held.requestId;
            view.keeperOriginalKnown = true;
            if (!held.created) {
              entry.loaded = false;
              view.notice =
                "An original Start identity is already recorded. Check it to recover the exact input before proceeding. A replacement Start is locked.";
              return;
            }
            parsed.data.start.requestId = held.requestId;
            entry.original = structuredClone(parsed.data);
            view.pendingStart = structuredClone(parsed.data.start);
            lock(entry);
          } catch (error) {
            if (reserving) entry.loaded = false;
            view.notice =
              error instanceof Error
                ? error.message
                : "Review the session options.";
            tell();
            return;
          } finally {
            view.starting = false;
            lock(entry);
            tell();
          }
          await post(entry);
        },
        refresh: (id) =>
          id === entry.source.projectId ? check(entry) : Promise.resolve(),
        retryStart: (id) =>
          id === entry.source.projectId &&
          retryableNotSent.get(entry) === true &&
          entry.view.retryStartAvailable &&
          entry.original &&
          !entry.view.loading &&
          !entry.view.starting
            ? post(entry)
            : Promise.resolve(),
        worktrees: createSessionWorktreeClient({
          canWrite: () => deps.canWrite() && !view.inputLocked,
          requestId: deps.requestId,
          post: (id, input) =>
            id === entry.source.projectId
              ? deps.createWorktree(id, input)
              : Promise.resolve({
                  state: "refused",
                  message: "This proposal belongs to another project.",
                }),
          read: (id, requestId) =>
            id === entry.source.projectId
              ? deps.readWorktree(id, requestId)
              : Promise.reject(
                  new Error("This proposal belongs to another project."),
                ),
          changed: tell,
        }),
      },
    };
    return entry;
  }
  return {
    get(source: KeeperProposal, revision: number, knownRequestId?: string) {
      const key = `${source.projectId}:${source.id}:${source.sourceHash}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = make(source, revision);
        entries.set(key, entry);
      }
      if (!entry.original) entry.revision = Math.max(entry.revision, revision);
      if (knownRequestId && !entry.expectedRequestId)
        entry.expectedRequestId = knownRequestId;
      return entry;
    },
    open: check,
    close(_entry: KeeperSessionReview) {
      /* Navigation never dispatches or cleans up a worktree. */
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
export type KeeperSessionReviews = ReturnType<
  typeof createKeeperSessionReviews
>;
