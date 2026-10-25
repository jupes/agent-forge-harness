import {
  keeperShiftStartReceiptWireSchema,
  keeperShiftStartRequestSchema,
} from "../../../scripts/keeper/shift-start-wire";
import { workspaceKey } from "../../../scripts/projects/scope";
import { shiftRequestIdSchema } from "../../../scripts/shifts/protocol";
import { canonicalProjectShiftStart } from "../../../scripts/shifts/start-input";
import type { KeeperProposal } from "../../../types/keeper-proposal";
import type {
  KeeperShiftStartReceipt,
  KeeperShiftStartRequest,
} from "../../../types/keeper-shift-start";
import type { ProjectShiftOptions } from "../../../types/project-shifts";
import {
  keeperShiftStartHashesInBrowser,
  verifyKeeperShiftReceiptHashes,
} from "./keeper-shift-hash";
import {
  newProjectShiftDraft,
  type ProjectShiftDraft,
  reviewedProjectShift,
} from "./project-shift-composer";

export type KeeperShiftReviewStatus =
  | "loading"
  | "ready"
  | "held"
  | "recorded"
  | "failed"
  | "unknown";

export interface KeeperShiftReviewState {
  source: KeeperProposal;
  revision: number;
  options: ProjectShiftOptions | null;
  workspace: string | null;
  /** Current workspace and Start availability were checked for the held original. */
  scopeVerified: boolean;
  draft: ProjectShiftDraft | null;
  requestId: string | null;
  original: KeeperShiftStartRequest | null;
  receipt: KeeperShiftStartReceipt | null;
  status: KeeperShiftReviewStatus;
  /** First verified outcome, retained separately from transient loading/held presentation. */
  admittedOutcome: Extract<
    KeeperShiftReviewStatus,
    "recorded" | "failed" | "unknown"
  > | null;
  notice: string;
}

function proposalBounds(source: KeeperProposal) {
  const action = source.draft.action;
  if (action.kind !== "start-shift")
    throw Error("This Keeper proposal does not request a Shift.");
  return {
    durationMinutes: action.durationMinutes,
    concurrency: action.concurrency,
    beadLimit: action.beadLimit,
    spendLimitUsd: action.spendLimitUsd,
  };
}

/** The four proposal values prefill the full canonical Shift form without replacing its defaults. */
export function prefillKeeperShiftDraft(
  source: KeeperProposal,
  options: ProjectShiftOptions,
): ProjectShiftDraft {
  const bounds = proposalBounds(source);
  if (options.projectId !== source.projectId)
    throw Error("The Shift options belong to another project.");
  const draft = newProjectShiftDraft(options);
  draft.for = `${bounds.durationMinutes}m`;
  draft.concurrency = String(bounds.concurrency);
  draft.maxBeads = String(bounds.beadLimit);
  draft.maxUsd = String(bounds.spendLimitUsd);
  return draft;
}

export function createKeeperShiftReview(
  source: KeeperProposal,
  revision: number,
): KeeperShiftReviewState {
  proposalBounds(source);
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw Error("The Keeper proposal revision is invalid.");
  return {
    source: structuredClone(source),
    revision,
    options: null,
    workspace: null,
    scopeVerified: false,
    draft: null,
    requestId: null,
    original: null,
    receipt: null,
    status: "loading",
    admittedOutcome: null,
    notice: "Loading the current Shift options. Nothing has started.",
  };
}

/** A previously saved UUID locks editing until its exact protected original is recovered. */
export function initializeKeeperShiftReview(
  state: KeeperShiftReviewState,
  options: ProjectShiftOptions,
  knownRequestId: string | null = null,
): KeeperShiftReviewState {
  const id =
    knownRequestId === null
      ? state.requestId
      : shiftRequestIdSchema.parse(knownRequestId);
  if (options.projectId !== state.source.projectId)
    return {
      ...holdKeeperShiftReview(
        state,
        "Current Shift options belong to another project.",
      ),
      scopeVerified: false,
    };
  let workspace: string;
  try {
    workspace = workspaceKey(options.workspace);
  } catch {
    return {
      ...holdKeeperShiftReview(
        state,
        "The current Shift workspace could not be verified.",
      ),
      scopeVerified: false,
    };
  }
  if (state.original !== null && state.workspace !== workspace)
    return {
      ...state,
      options: structuredClone(options),
      scopeVerified: false,
      draft: savedDraft(state.original),
      status: "held",
      notice:
        "The current project workspace changed. The exact saved original and UUID are retained; no request was sent.",
    };
  const draft = state.original
    ? savedDraft(state.original)
    : prefillKeeperShiftDraft(state.source, options);
  if (id === null && state.original !== null)
    return {
      ...state,
      options: structuredClone(options),
      workspace,
      scopeVerified:
        options.availability.start &&
        (state.original === null || state.workspace === workspace),
      draft,
      status: "held",
      notice:
        "The exact reviewed Start is retained, but its identity was not confirmed in storage. Explicitly retry the same original to save its UUID before delivery.",
    };
  if (id !== null)
    return {
      ...state,
      options: structuredClone(options),
      workspace,
      scopeVerified:
        options.availability.start &&
        (state.original === null || state.workspace === workspace),
      draft,
      requestId: id,
      status: "held",
      notice:
        "This proposal already has a held Shift UUID. Recover its exact original before continuing; no replacement will be made.",
    };
  if (!options.availability.start)
    return {
      ...state,
      options: structuredClone(options),
      workspace,
      scopeVerified: false,
      draft,
      status: "held",
      notice:
        options.availability.reason ??
        "Starting a Shift is unavailable for the current project scope.",
    };
  return {
    ...state,
    options: structuredClone(options),
    workspace,
    scopeVerified: true,
    draft,
    status: "ready",
    notice:
      "Review the complete Shift bounds. Only explicit Start authorizes it.",
  };
}

export function editKeeperShiftDraft(
  state: KeeperShiftReviewState,
  update: Partial<ProjectShiftDraft>,
): KeeperShiftReviewState {
  if (state.status !== "ready" || !state.draft || state.original) return state;
  return { ...state, draft: { ...state.draft, ...structuredClone(update) } };
}

/** Builds the separately reviewed full request; proposal fields remain independently hashed. */
export async function buildKeeperShiftStart(
  state: KeeperShiftReviewState,
  requestId: string,
): Promise<
  | {
      ok: true;
      request: KeeperShiftStartRequest;
      startHash: string;
      reviewHash: string;
    }
  | { ok: false; reason: string }
> {
  if (
    state.status !== "ready" ||
    state.requestId !== null ||
    state.original !== null ||
    !state.options ||
    !state.workspace ||
    !state.draft
  )
    return {
      ok: false,
      reason: "This Shift review is held until its original is checked.",
    };
  const checked = reviewedProjectShift(state.options, state.draft);
  if (!checked.ok) return checked;
  const request = keeperShiftStartRequestSchema.safeParse({
    sourceHash: state.source.sourceHash,
    expectedRevision: state.revision,
    start: { ...checked.input, requestId },
  });
  if (!request.success)
    return {
      ok: false,
      reason: "Review a valid full Shift request before Start.",
    };
  const hashes = await keeperShiftStartHashesInBrowser(
    state.source.projectId,
    state.source.id,
    state.workspace,
    proposalBounds(state.source),
    request.data,
  );
  return { ok: true, request: request.data, ...hashes };
}

/** A 404 or failed read holds the existing UUID and never creates a replacement or replays. */
export function holdKeeperShiftReview(
  state: KeeperShiftReviewState,
  notice: string,
): KeeperShiftReviewState {
  return { ...state, status: "held", notice };
}

export function keeperShiftReceiptStatus(
  receipt: KeeperShiftStartReceipt,
): Extract<KeeperShiftReviewStatus, "recorded" | "failed" | "unknown"> {
  if (receipt.record.phase === "failed") return "failed";
  if (receipt.record.phase !== "done") return "unknown";
  const shift = receipt.shift;
  if (shift && shift.observation.actual !== null) return "recorded";
  if (
    shift?.observation.phase === "failed" ||
    (shift?.observation.phase === "stopped" &&
      typeof shift.intent.startupStop?.completedAt === "string")
  )
    return "failed";
  return "unknown";
}

function savedDraft(request: KeeperShiftStartRequest): ProjectShiftDraft {
  const { start } = request,
    { options } = start;
  return {
    expectedCatalogRevision: start.expectedCatalogRevision,
    for: options.for,
    concurrency: String(options.concurrency),
    maxBeads: String(options.maxBeads),
    maxUsd: String(options.maxUsd),
    repairs: String(options.repairs),
    base: options.base,
    epic: options.epic ?? "",
    smith: options.smith ?? "",
    runTimeout: options.runTimeout ?? "",
  };
}

/** Restores only an exact server original and its correlated canonical Shift receipt. */
export async function acceptKeeperShiftReceipt(
  state: KeeperShiftReviewState,
  raw: unknown,
): Promise<KeeperShiftReviewState> {
  const parsed = keeperShiftStartReceiptWireSchema.safeParse(raw);
  if (!parsed.success)
    throw Error("The saved Keeper Shift original could not be verified.");
  const receipt = parsed.data;
  if (!(await verifyKeeperShiftReceiptHashes(receipt)))
    throw Error("The saved Keeper Shift original could not be verified.");
  if (
    receipt.projectId !== state.source.projectId ||
    receipt.proposalId !== state.source.id ||
    receipt.original.sourceHash !== state.source.sourceHash ||
    receipt.record.sourceRequestId !== state.source.sourceRequestId ||
    JSON.stringify(receipt.record.draft) !==
      JSON.stringify(state.source.draft) ||
    (state.workspace !== null &&
      workspaceKey(receipt.workspace) !== state.workspace) ||
    (state.requestId !== null &&
      receipt.original.start.requestId !== state.requestId) ||
    receipt.revision < receipt.original.expectedRevision ||
    (state.original !== null &&
      (state.workspace === null ||
        canonicalProjectShiftStart(
          state.source.projectId,
          state.workspace,
          state.original.start,
        ) !==
          canonicalProjectShiftStart(
            state.source.projectId,
            state.workspace,
            receipt.original.start,
          ) ||
        state.original.sourceHash !== receipt.original.sourceHash ||
        state.original.expectedRevision !== receipt.original.expectedRevision))
  )
    throw Error(
      "The saved Shift original did not match this proposal and exact review.",
    );
  const observedStatus = keeperShiftReceiptStatus(receipt);
  const admittedOutcome =
    state.admittedOutcome === null ||
    (state.admittedOutcome === "recorded" && observedStatus !== "recorded")
      ? observedStatus
      : state.admittedOutcome;
  const status = admittedOutcome,
    notice =
      status === "recorded"
        ? "The canonical Shift record is verified. Its execution state is shown separately."
        : status === "failed"
          ? receipt.record.message
          : "The Shift outcome is not confirmed. Its exact original is kept; it will not replay automatically.";
  return {
    ...state,
    workspace: workspaceKey(receipt.workspace),
    requestId: receipt.original.start.requestId,
    original: structuredClone(receipt.original),
    receipt: structuredClone(receipt),
    draft: savedDraft(receipt.original),
    status,
    admittedOutcome,
    notice,
  };
}

export function keeperShiftObservationPhase(
  state: KeeperShiftReviewState,
): string | null {
  return state.receipt?.shift?.observation.phase ?? null;
}
