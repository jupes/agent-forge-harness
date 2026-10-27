import { z } from "zod";
import {
  canonicalSmithConfigCreateRequest,
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithConfigPreviewRequestSchema,
  smithConfigPreviewSchema,
  smithCreateIdentityIndexSchema,
} from "../../../scripts/config/smith-create-protocol";
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRequest,
  SmithConfigPreview,
  SmithConfigPreviewRequest,
  SmithConfigTarget,
  SmithCreateIdentitySummary,
} from "../../../types/smith-config-create";
import {
  type SmithCreateIdentities,
  type SmithCreateIdentity,
  smithConfigCreateInputHash,
} from "./smith-create-identities";

export type SmithCreatePostResult =
  | { state: "not-sent"; message: string }
  | { state: "sent"; value: unknown }
  | { state: "unknown"; message: string };
export interface SmithCreateEntry {
  identity: SmithCreateIdentity;
  request: SmithConfigCreateRequest | null;
  receipt: SmithConfigCreateReceipt | null;
  state: "held" | "confirmed" | "refused" | "not-sent";
  checking: boolean;
  notice: string;
  serverIdentity: SmithCreateIdentitySummary | null;
  remoteOnly: boolean;
  continueAllowed: boolean;
}
export interface SmithCreateClientState {
  target: SmithConfigTarget;
  smith: SmithConfigPreviewRequest["smith"];
  preview: SmithConfigPreview | null;
  previewing: boolean;
  creating: boolean;
  entries: SmithCreateEntry[];
  activeRequestId: string | null;
  serverDiscoveryReady: boolean;
  notice: string;
}

type SmithReceiptInstall = "installed" | "invalid" | "terminal-conflict";

const canonicalRequestMismatch = (
  left: SmithConfigCreateRequest,
  right: SmithConfigCreateRequest,
) =>
  canonicalSmithConfigCreateRequest(left) !==
  canonicalSmithConfigCreateRequest(right);

const sameSmith = (
  left: SmithConfigPreviewRequest["smith"],
  right: SmithConfigPreviewRequest["smith"],
) =>
  left.name === right.name &&
  left.provider === right.provider &&
  left.model === right.model &&
  left.effort === right.effort &&
  left.enabled === right.enabled &&
  left.tags.length === right.tags.length &&
  left.tags.every((tag, index) => tag === right.tags[index]);
const samePreviewInput = (
  preview: SmithConfigPreview | null,
  target: SmithConfigTarget,
  smith: SmithConfigPreviewRequest["smith"],
) =>
  !!preview &&
  preview.target === target &&
  sameSmith(preview.review.after, smith);

function receiptValue(value: unknown): unknown {
  const envelope = z
    .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
    .strict()
    .safeParse(value);
  return envelope.success ? envelope.data.data : value;
}

/** App-root owner: metadata is durable before POST and uncertainty only checks the same UUID. */
export function createSmithConfigCreateClient(deps: {
  identities: SmithCreateIdentities;
  canWrite(): boolean;
  requestId(): string;
  preview(input: SmithConfigPreviewRequest): Promise<unknown>;
  post(request: SmithConfigCreateRequest): Promise<SmithCreatePostResult>;
  readOriginal(requestId: string): Promise<unknown>;
  reserve(request: SmithConfigCreateRequest): Promise<SmithCreatePostResult>;
  list(): Promise<unknown>;
  retireReserved(requestId: string, inputHash: string): Promise<unknown>;
  changed?(): void;
}) {
  const state: SmithCreateClientState = {
    target: "workspace",
    smith: {
      name: "",
      provider: "",
      model: "",
      effort: "",
      enabled: true,
      tags: [],
    },
    preview: null,
    previewing: false,
    creating: false,
    entries: [],
    activeRequestId: null,
    serverDiscoveryReady: false,
    notice: "",
  };
  const listeners = new Set<() => void>();
  let disposed = false,
    generation = 0;
  const emit = () => {
    if (!disposed) {
      deps.changed?.();
      for (const listener of listeners) listener();
    }
  };
  const updateDraft = (
    target: SmithConfigTarget,
    smith: SmithConfigPreviewRequest["smith"],
  ) => {
    const changed = target !== state.target || !sameSmith(state.smith, smith);
    if (!changed) return;
    state.target = target;
    state.smith = structuredClone(smith);
    state.preview = null;
    state.notice = "Draft changed. Review a fresh candidate before creating.";
    generation++;
    emit();
  };
  const entry = (requestId: string) =>
    state.entries.find((item) => item.identity.requestId === requestId);
  const canStart = () => {
    try {
      return (
        !deps.identities.list().some((identity) => {
          if (identity.retired) return false;
          const current = entry(identity.requestId);
          return current === undefined || current.state === "held";
        }) &&
        state.serverDiscoveryReady &&
        !state.entries.some(
          (item) =>
            item.serverIdentity !== null &&
            (item.serverIdentity.state === "reserved" ||
              item.serverIdentity.state === "held"),
        )
      );
    } catch {
      return false;
    }
  };
  const installReceipt = async (
    held: SmithCreateEntry,
    raw: unknown,
  ): Promise<SmithReceiptInstall> => {
    const parsed = smithConfigCreateReceiptSchema.safeParse(receiptValue(raw));
    let stored: SmithCreateIdentity | null = null;
    try {
      stored = deps.identities.read(held.identity.requestId);
    } catch {
      // Unavailable metadata cannot be replaced by an unverified reply.
    }
    const remote = held.serverIdentity;
    if (
      !parsed.success ||
      parsed.data.requestId !== held.identity.requestId ||
      parsed.data.original.target !== held.identity.target ||
      parsed.data.inputHash !==
        (remote?.inputHash ?? held.identity.inputHash) ||
      (remote
        ? remote.requestId !== parsed.data.requestId ||
          remote.ownerScopeHash !== parsed.data.ownerScopeHash ||
          remote.target !== parsed.data.original.target
        : held.identity.scope !== stored?.scope) ||
      (await smithConfigCreateInputHash(parsed.data.original)) !==
        held.identity.inputHash
    ) {
      held.notice =
        "The original Smith create could not be verified. Its UUID remains held; check the original again.";
      return "invalid";
    }
    const savedTerminalPhase =
      stored?.retired && stored.retirement === "correlated-confirmation"
        ? "confirmed"
        : stored?.retired && stored.retirement === "correlated-refusal"
          ? "refused"
          : null;
    const terminalPhase = savedTerminalPhase ?? held.receipt?.result.phase;
    if (
      (terminalPhase === "confirmed" || terminalPhase === "refused") &&
      parsed.data.result.phase !== terminalPhase
    ) {
      const terminalName =
        terminalPhase === "confirmed" ? "confirmation" : "refusal";
      held.notice = `The protected receipt conflicts with the saved correlated ${terminalName}. The saved ${terminalPhase} remains verified; no create was resent.`;
      return "terminal-conflict";
    }
    const previous = held.receipt?.result.phase;
    if (
      (previous === "confirmed" || previous === "refused") &&
      parsed.data.result.phase !== previous
    ) {
      const terminalName =
        previous === "confirmed" ? "confirmation" : "refusal";
      held.notice = `The protected receipt conflicts with the saved correlated ${terminalName}. The saved ${previous} remains verified; no create was resent.`;
      return "terminal-conflict";
    }
    held.receipt = structuredClone(parsed.data);
    held.request = structuredClone(parsed.data.original);
    held.state = parsed.data.result.phase;
    held.continueAllowed =
      parsed.data.result.phase === "held" &&
      parsed.data.result.stage === "reserved";
    if (remote) {
      const result = parsed.data.result;
      held.serverIdentity = {
        ...remote,
        state:
          result.phase === "confirmed" || result.phase === "refused"
            ? result.phase
            : result.stage === "reserved"
              ? "reserved"
              : "held",
        stage:
          result.phase !== "held"
            ? "terminal"
            : result.stage === "intent"
              ? "legacy"
              : result.stage,
      };
    }
    held.notice =
      parsed.data.result.phase === "confirmed"
        ? "Smith created. The saved original receipt is available for review."
        : parsed.data.result.phase === "refused"
          ? `Smith create was refused before publication: ${parsed.data.result.reason}. Review again before starting a new request.`
          : "Smith create outcome is held. Check the same original request; it will not be sent again automatically.";
    return "installed";
  };
  const retire = async (
    held: SmithCreateEntry,
    proof:
      | "operator-not-sent"
      | "correlated-refusal"
      | "correlated-confirmation",
  ): Promise<boolean> => {
    try {
      held.identity = await deps.identities.retire(held.identity, proof);
      return true;
    } catch {
      held.state = "held";
      held.notice =
        "The settlement could not be saved and verified. Its UUID remains held; check the same original receipt.";
      return false;
    }
  };
  const retireVerifiedReceipt = async (
    held: SmithCreateEntry,
  ): Promise<boolean> => {
    if (held.state !== "confirmed" && held.state !== "refused") return true;
    if (held.remoteOnly) return true;
    return retire(
      held,
      held.state === "confirmed"
        ? "correlated-confirmation"
        : "correlated-refusal",
    );
  };
  const client = {
    get(): SmithCreateClientState {
      return structuredClone(state);
    },
    canStart(): boolean {
      return !disposed && canStart();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(
      target: SmithConfigTarget,
      smith: SmithConfigPreviewRequest["smith"],
    ) {
      updateDraft(target, smith);
    },
    patchDraft(patch: Partial<SmithConfigPreviewRequest["smith"]>) {
      updateDraft(state.target, { ...state.smith, ...patch });
    },
    setTarget(target: SmithConfigTarget) {
      updateDraft(target, state.smith);
    },
    async preview() {
      if (!state.serverDiscoveryReady) await client.recover();
      if (disposed || state.previewing || state.creating || !deps.canWrite())
        return;
      if (!canStart()) {
        state.preview = null;
        state.notice =
          "Saved Smith create identities could not be verified. No new request can start.";
        emit();
        return;
      }
      const checked = smithConfigPreviewRequestSchema.safeParse({
        target: state.target,
        smith: state.smith,
      });
      if (!checked.success) {
        state.preview = null;
        state.notice =
          "Enter a complete valid Smith configuration before reviewing.";
        emit();
        return;
      }
      const ticket = generation,
        draft = structuredClone(checked.data);
      state.previewing = true;
      state.notice = "Preparing a fresh candidate for review…";
      emit();
      try {
        const raw = await deps.preview(draft),
          parsed = smithConfigPreviewSchema.safeParse(receiptValue(raw));
        if (disposed || ticket !== generation) return;
        if (
          !parsed.success ||
          parsed.data.target !== draft.target ||
          !sameSmith(parsed.data.review.after, draft.smith)
        )
          throw Error("The Smith candidate did not match the reviewed draft.");
        state.preview = structuredClone(parsed.data);
        state.notice = "Review the complete candidate before creating it.";
      } catch {
        if (!disposed && ticket === generation) {
          state.preview = null;
          state.notice =
            "The Smith candidate could not be verified. No create request was sent.";
        }
      } finally {
        if (!disposed) {
          state.previewing = false;
          emit();
        }
      }
    },
    async create() {
      if (
        disposed ||
        state.creating ||
        state.previewing ||
        !canStart() ||
        !deps.canWrite() ||
        !samePreviewInput(state.preview, state.target, state.smith)
      )
        return;
      const reviewed = state.preview;
      if (!reviewed) return;
      let request: SmithConfigCreateRequest;
      try {
        request = smithConfigCreateRequestSchema.parse({
          requestId: deps.requestId(),
          target: state.target,
          smith: state.smith,
          expectedRevision: reviewed.expectedRevision,
        });
      } catch {
        state.notice = "The reviewed Smith request could not be verified.";
        emit();
        return;
      }
      const ticket = generation;
      state.creating = true;
      state.notice =
        "Reserving the exact original with the server before any create attempt…";
      emit();
      try {
        let reservation: SmithCreatePostResult;
        try {
          reservation = await deps.reserve(structuredClone(request));
        } catch {
          reservation = {
            state: "unknown",
            message: "The server reservation may have been recorded.",
          };
        }
        if (disposed) return;
        if (reservation.state === "not-sent") {
          state.notice = `${reservation.message} No server reservation or create was recorded.`;
          return;
        }
        if (reservation.state === "unknown") {
          state.serverDiscoveryReady = false;
          state.notice =
            "The reservation response was uncertain. Checking the complete server identity index; no create was sent.";
          await client.recover();
          if (!disposed)
            state.notice =
              "The reservation response was uncertain. No create was sent; any discovered reservation remains held.";
          return;
        }
        const checkedReservation = smithConfigCreateReceiptSchema.safeParse(
          receiptValue(reservation.value),
        );
        if (
          !checkedReservation.success ||
          checkedReservation.data.requestId !== request.requestId ||
          checkedReservation.data.original.target !== request.target ||
          checkedReservation.data.inputHash !==
            (await smithConfigCreateInputHash(request)) ||
          canonicalRequestMismatch(checkedReservation.data.original, request)
        ) {
          state.serverDiscoveryReady = false;
          state.notice =
            "The server reservation did not match the reviewed original. Checking the server index; no create was sent.";
          await client.recover();
          return;
        }
        const result = checkedReservation.data.result,
          summary: SmithCreateIdentitySummary = {
            requestId: request.requestId,
            ownerScopeHash: checkedReservation.data.ownerScopeHash,
            inputHash: checkedReservation.data.inputHash,
            target: request.target,
            state:
              result.phase === "confirmed" || result.phase === "refused"
                ? result.phase
                : result.stage === "reserved"
                  ? "reserved"
                  : "held",
            stage:
              result.phase !== "held"
                ? "terminal"
                : result.stage === "intent"
                  ? "legacy"
                  : result.stage,
            createdAt: checkedReservation.data.createdAt,
          };
        let held = entry(request.requestId);
        if (!held) {
          held = {
            identity: {
              requestId: request.requestId,
              scope: `server:${summary.ownerScopeHash}`,
              target: request.target,
              inputHash: summary.inputHash,
            },
            request: structuredClone(request),
            receipt: structuredClone(checkedReservation.data),
            state:
              summary.state === "confirmed" || summary.state === "refused"
                ? summary.state
                : "held",
            checking: false,
            notice:
              "The exact original is reserved by the server; no create has been attempted yet.",
            serverIdentity: summary,
            remoteOnly: true,
            continueAllowed: true,
          };
          state.entries.push(held);
        } else {
          held.serverIdentity = summary;
          held.request = structuredClone(request);
          held.receipt = structuredClone(checkedReservation.data);
          held.continueAllowed = true;
        }
        state.activeRequestId = request.requestId;
        if (summary.state !== "reserved" || summary.stage !== "reserved") {
          state.preview = null;
          state.notice =
            "This UUID already has a non-reserved server outcome. Its original is available for inspection; no create was sent.";
          return;
        }
        if (
          disposed ||
          ticket !== generation ||
          !deps.canWrite() ||
          !samePreviewInput(state.preview, state.target, state.smith)
        ) {
          held.notice =
            "The server reservation is preserved. Continue this exact original or retire it explicitly.";
          state.preview = null;
          state.notice = held.notice;
          return;
        }
        let local: Awaited<ReturnType<SmithCreateIdentities["reserve"]>>;
        try {
          local = await deps.identities.reserve(structuredClone(request));
        } catch {
          held.notice =
            "The server reservation is safe, but local identity storage could not be verified. Continue or retire the exact server reservation explicitly.";
          state.notice = held.notice;
          return;
        }
        if (
          disposed ||
          ticket !== generation ||
          !deps.canWrite() ||
          !samePreviewInput(state.preview, state.target, state.smith)
        ) {
          held.notice =
            "The server reservation is preserved. Continue this exact original or retire it explicitly.";
          state.notice = held.notice;
          state.preview = null;
          return;
        }
        if (!local.created) {
          held.continueAllowed = false;
          held.notice =
            "The server reservation is preserved, but a local identity already owns this UUID. No create was sent.";
          state.notice = held.notice;
          return;
        }
        held.identity = local.identity;
        held.remoteOnly = false;
        let outcome: SmithCreatePostResult;
        try {
          outcome = await deps.post(structuredClone(request));
        } catch {
          outcome = {
            state: "unknown",
            message: "The request may have reached the server.",
          };
        }
        if (outcome.state === "not-sent") {
          held.state = "held";
          held.continueAllowed = true;
          held.notice = `${outcome.message} The server reservation remains held; continue this exact original or retire it explicitly.`;
          state.notice = held.notice;
        } else if (outcome.state === "unknown") {
          held.state = "held";
          held.continueAllowed = false;
          held.notice =
            "The create outcome is unknown. Check this original request; it will not be sent again automatically.";
          state.notice = held.notice;
          await client.check(request.requestId);
        } else {
          let installed: SmithReceiptInstall = "invalid";
          try {
            installed = await installReceipt(held, outcome.value);
          } catch {
            held.notice =
              "The create response could not be checked. Its UUID remains held; check the original receipt.";
          }
          if (installed === "installed") {
            if (!(await retireVerifiedReceipt(held))) held.state = "held";
          } else if (installed === "invalid") {
            held.state = "held";
            held.continueAllowed = false;
            await client.check(request.requestId);
          }
          state.notice = held.notice;
        }
        state.preview = null;
      } finally {
        if (!disposed) {
          state.creating = false;
          emit();
        }
      }
    },
    async check(requestId?: string) {
      if (disposed) return;
      const ids = requestId
        ? [requestId]
        : state.activeRequestId
          ? [state.activeRequestId]
          : [];
      for (const id of ids) {
        let held = entry(id),
          identity: SmithCreateIdentity | null;
        try {
          identity = held?.remoteOnly ? null : deps.identities.read(id);
        } catch {
          if (held)
            held.notice =
              "Saved create metadata could not be verified. Its bytes were kept.";
          continue;
        }
        if (!identity && !held?.serverIdentity) continue;
        if (
          identity?.retired &&
          identity.retirement === "operator-not-sent" &&
          !held?.serverIdentity
        ) {
          if (held) {
            held.identity = identity;
            held.state = "not-sent";
            held.notice =
              "The request was proven not sent. Review again before starting a new request.";
          }
          continue;
        }
        if (held && identity?.retired && !held.serverIdentity) {
          held.identity = identity;
          held.state =
            identity.retirement === "correlated-refusal"
              ? "refused"
              : "confirmed";
          held.notice =
            identity.retirement === "correlated-refusal"
              ? "A correlated refusal was saved. Checking its protected original for review details."
              : "A correlated confirmation was saved. Checking its protected original for review details.";
        }
        if (!held && identity) {
          const created: SmithCreateEntry = {
            identity,
            request: null,
            receipt: null,
            state: identity.retired
              ? identity.retirement === "correlated-refusal"
                ? "refused"
                : identity.retirement === "correlated-confirmation"
                  ? "confirmed"
                  : "not-sent"
              : "held",
            checking: false,
            notice: identity.retired
              ? "Checking the saved correlated original for review details only."
              : "Checking the saved original only; no create will be sent.",
            serverIdentity: null,
            remoteOnly: false,
            continueAllowed: false,
          };
          held = created;
          state.entries.push(created);
        }
        if (!held) continue;
        if (held.checking) continue;
        held.checking = true;
        emit();
        try {
          const raw = await deps.readOriginal(id);
          if (!disposed) {
            const installed = await installReceipt(held, raw);
            if (installed === "installed") await retireVerifiedReceipt(held);
            else if (held.serverIdentity?.stage === "reserved")
              held.continueAllowed = false;
            else if (
              installed === "invalid" &&
              identity?.retired &&
              identity.retirement !== "operator-not-sent"
            )
              held.notice =
                "The saved outcome remains verified, but its protected receipt details could not be checked. No create was resent.";
          }
        } catch {
          if (held.serverIdentity?.stage === "reserved")
            held.continueAllowed = false;
          if (!disposed && held.state === "held")
            held.notice =
              "The original receipt could not be read. Its UUID remains held; check it again without resending.";
          else if (
            !disposed &&
            identity?.retired &&
            (identity.retirement === "correlated-refusal" ||
              identity.retirement === "correlated-confirmation")
          )
            held.notice =
              "The saved outcome remains verified, but its protected receipt details could not be read. No create was resent.";
        } finally {
          if (!disposed) {
            held.checking = false;
            emit();
          }
        }
      }
    },
    async continueReserved(requestId: string) {
      if (disposed || state.creating || !deps.canWrite()) return;
      const held = entry(requestId),
        receipt = held?.receipt,
        summary = held?.serverIdentity;
      if (
        !held ||
        !summary ||
        summary.stage !== "reserved" ||
        !receipt ||
        receipt.result.phase !== "held" ||
        receipt.result.stage !== "reserved" ||
        !held.continueAllowed ||
        held.checking
      )
        return;
      const request = smithConfigCreateRequestSchema.safeParse(
        receipt.original,
      );
      if (
        !request.success ||
        request.data.requestId !== summary.requestId ||
        (await smithConfigCreateInputHash(request.data)) !== summary.inputHash
      ) {
        held.notice =
          "The saved reserved original could not be verified. No create was sent.";
        emit();
        return;
      }
      const ticket = generation,
        savedInputHash = await smithConfigCreateInputHash(request.data);
      if (
        disposed ||
        ticket !== generation ||
        !deps.canWrite() ||
        summary.inputHash !== savedInputHash
      )
        return;
      held.checking = true;
      held.continueAllowed = false;
      held.notice =
        "Verifying the exact server-reserved original before continuing…";
      emit();
      try {
        const raw = await deps.readOriginal(requestId);
        if (
          disposed ||
          ticket !== generation ||
          entry(requestId) !== held ||
          !deps.canWrite()
        )
          return;
        const installed = await installReceipt(held, raw);
        if (
          installed !== "installed" ||
          held.serverIdentity?.requestId !== requestId ||
          held.serverIdentity.inputHash !== summary.inputHash ||
          held.serverIdentity.ownerScopeHash !== summary.ownerScopeHash ||
          held.serverIdentity.stage !== "reserved" ||
          held.state !== "held" ||
          held.receipt?.result.phase !== "held" ||
          held.receipt.result.stage !== "reserved" ||
          !held.continueAllowed
        ) {
          held.continueAllowed = false;
          held.notice =
            "The protected original is no longer an exact reserved create. No create was sent.";
          emit();
          return;
        }
      } catch {
        if (!disposed && entry(requestId) === held) {
          held.continueAllowed = false;
          held.notice =
            "The protected original could not be verified. Its reservation remains held and no create was sent.";
          emit();
        }
        return;
      } finally {
        if (!disposed && entry(requestId) === held) {
          held.checking = false;
          emit();
        }
      }
      if (
        disposed ||
        ticket !== generation ||
        entry(requestId) !== held ||
        !deps.canWrite() ||
        !held.continueAllowed
      )
        return;
      state.creating = true;
      state.activeRequestId = requestId;
      held.checking = false;
      held.notice =
        "Continuing the exact server-reserved original after explicit review…";
      emit();
      try {
        let outcome: SmithCreatePostResult;
        try {
          outcome = await deps.post(structuredClone(request.data));
        } catch {
          outcome = {
            state: "unknown",
            message: "The create outcome may be unknown.",
          };
        }
        if (disposed || ticket !== generation) return;
        if (outcome.state === "sent") {
          const installed = await installReceipt(held, outcome.value);
          if (installed === "installed" && held.state !== "held") {
            if (!held.remoteOnly && !(await retireVerifiedReceipt(held)))
              held.state = "held";
          } else {
            held.state = "held";
          }
        } else {
          // A not-sent create settles no reservation: the server slot remains until explicit retirement.
          held.state = "held";
          held.continueAllowed = outcome.state === "not-sent";
          held.notice =
            outcome.state === "not-sent"
              ? `${outcome.message} The server reservation remains available for explicit continuation or retirement.`
              : "The create result is uncertain. Check the same protected original; it will not be resent automatically.";
        }
      } finally {
        if (!disposed) {
          state.creating = false;
          emit();
        }
      }
    },
    async retireReservation(requestId: string) {
      if (disposed || state.creating || !deps.canWrite()) return;
      const held = entry(requestId),
        summary = held?.serverIdentity;
      if (!held || held.checking || !summary || summary.stage !== "reserved")
        return;
      const ticket = generation;
      held.checking = true;
      emit();
      try {
        const raw = await deps.retireReserved(requestId, summary.inputHash),
          parsed = smithConfigCreateReceiptSchema.safeParse(receiptValue(raw));
        if (disposed || ticket !== generation || !deps.canWrite()) return;
        if (
          !parsed.success ||
          parsed.data.requestId !== requestId ||
          parsed.data.inputHash !== summary.inputHash ||
          parsed.data.ownerScopeHash !== summary.ownerScopeHash ||
          parsed.data.result.phase !== "refused" ||
          parsed.data.result.reason !== "cancelled-before-attempt"
        )
          throw Error("The server did not confirm exact reserved retirement.");
        const installed = await installReceipt(held, raw);
        if (installed !== "installed" || held.state !== "refused")
          throw Error(
            "The server retirement receipt did not match its original.",
          );
        held.serverIdentity = {
          ...summary,
          state: "refused",
          stage: "terminal",
        };
        held.state = "refused";
        if (!(await retireVerifiedReceipt(held))) return;
        held.notice =
          "The exact server reservation was explicitly retired before any create attempt.";
      } catch {
        held.notice =
          "The reservation could not be verified as retired. Its UUID remains held.";
      } finally {
        if (!disposed) {
          held.checking = false;
          emit();
        }
      }
    },
    async recover() {
      if (disposed) return;
      state.serverDiscoveryReady = false;
      emit();
      try {
        const index = smithCreateIdentityIndexSchema.parse(
          receiptValue(await deps.list()),
        );
        for (const summary of index.entries) {
          let found = entry(summary.requestId);
          if (!found) {
            found = {
              identity: {
                requestId: summary.requestId,
                scope: `server:${summary.ownerScopeHash}`,
                target: summary.target,
                inputHash: summary.inputHash,
              },
              request: null,
              receipt: null,
              state:
                summary.state === "confirmed" || summary.state === "refused"
                  ? summary.state
                  : "held",
              checking: false,
              notice:
                "Checking the server-owned saved original only; no create will be sent.",
              serverIdentity: summary,
              remoteOnly: true,
              continueAllowed: false,
            };
            state.entries.push(found);
          } else {
            found.serverIdentity = summary;
          }
        }
        state.serverDiscoveryReady = true;
      } catch {
        state.notice =
          "Server-owned Smith create identities could not be verified. No new request can start.";
        emit();
        return;
      }
      let identities: SmithCreateIdentity[];
      try {
        identities = deps.identities.list();
      } catch {
        state.notice =
          "Saved Smith create metadata could not be verified. No request was sent.";
        emit();
        return;
      }
      for (const identity of identities) {
        const existing = entry(identity.requestId);
        if (!existing)
          state.entries.push({
            identity,
            request: null,
            receipt: null,
            state: identity.retired
              ? identity.retirement === "correlated-refusal"
                ? "refused"
                : identity.retirement === "correlated-confirmation"
                  ? "confirmed"
                  : "not-sent"
              : "held",
            checking: false,
            notice: identity.retired
              ? identity.retirement === "correlated-refusal"
                ? "A correlated preattempt refusal was saved. Review again before starting a new request."
                : identity.retirement === "correlated-confirmation"
                  ? "A correlated confirmation was saved. Checking the protected original for its receipt."
                  : "The request was proven not sent. Review again before starting a new request."
              : "Checking the saved original only; no create will be sent.",
            serverIdentity: null,
            remoteOnly: false,
            continueAllowed: false,
          });
        else {
          existing.identity = identity;
          existing.remoteOnly = false;
          if (!identity.retired) continue;
          if (existing.serverIdentity) {
            // A matching server terminal summary corroborates local settlement;
            // otherwise local state cannot release or replace the server row.
            const localTerminal =
              identity.retirement === "correlated-refusal"
                ? "refused"
                : identity.retirement === "correlated-confirmation"
                  ? "confirmed"
                  : null;
            if (
              existing.serverIdentity.stage === "terminal" &&
              existing.serverIdentity.state === localTerminal
            ) {
              existing.state = localTerminal;
              existing.continueAllowed = false;
              existing.notice =
                "The server confirms the saved terminal outcome. Checking its protected original for review details.";
            } else {
              existing.state = "held";
              existing.continueAllowed =
                existing.serverIdentity.stage === "reserved" &&
                existing.serverIdentity.state === "reserved";
              existing.notice =
                "A server-owned create reservation exists for this UUID. Checking its protected original; local settlement cannot release it.";
            }
          } else {
            existing.state =
              identity.retirement === "correlated-refusal"
                ? "refused"
                : identity.retirement === "correlated-confirmation"
                  ? "confirmed"
                  : "not-sent";
            existing.notice =
              identity.retirement === "correlated-refusal"
                ? "A correlated preattempt refusal was saved. Review again before starting a new request."
                : identity.retirement === "correlated-confirmation"
                  ? "A correlated confirmation was saved. Checking the protected original for review details."
                  : "The request was proven not sent. Review again before starting a new request.";
          }
        }
      }
      emit();
      const ids = new Set([
        ...identities
          .filter(
            (identity) =>
              !identity.retired ||
              identity.retirement !== "operator-not-sent" ||
              !!entry(identity.requestId)?.serverIdentity,
          )
          .map((identity) => identity.requestId),
        ...state.entries
          .filter((item) => item.serverIdentity !== null)
          .map((item) => item.identity.requestId),
      ]);
      for (const id of ids) await client.check(id);
    },
    dispose() {
      disposed = true;
      generation++;
      listeners.clear();
    },
  };
  return client;
}
export type SmithConfigCreateClient = ReturnType<
  typeof createSmithConfigCreateClient
>;
