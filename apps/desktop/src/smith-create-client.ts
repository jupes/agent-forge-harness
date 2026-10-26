import { z } from "zod";
import {
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithConfigPreviewRequestSchema,
  smithConfigPreviewSchema,
} from "../../../scripts/config/smith-create-protocol";
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRequest,
  SmithConfigPreview,
  SmithConfigPreviewRequest,
  SmithConfigTarget,
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
}
export interface SmithCreateClientState {
  target: SmithConfigTarget;
  smith: SmithConfigPreviewRequest["smith"];
  preview: SmithConfigPreview | null;
  previewing: boolean;
  creating: boolean;
  entries: SmithCreateEntry[];
  activeRequestId: string | null;
  notice: string;
}

type SmithReceiptInstall = "installed" | "invalid" | "terminal-conflict";

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
  const entry = (requestId: string) =>
    state.entries.find((item) => item.identity.requestId === requestId);
  const canStart = () => {
    try {
      return !deps.identities.list().some((identity) => {
        if (identity.retired) return false;
        const current = entry(identity.requestId);
        return current === undefined || current.state === "held";
      });
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
    if (
      !parsed.success ||
      parsed.data.requestId !== held.identity.requestId ||
      parsed.data.original.target !== held.identity.target ||
      parsed.data.inputHash !== held.identity.inputHash ||
      held.identity.scope !== stored?.scope ||
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
    held.state = parsed.data.result.phase;
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
      const changed = target !== state.target || !sameSmith(state.smith, smith);
      if (!changed) return;
      state.target = target;
      state.smith = structuredClone(smith);
      state.preview = null;
      state.notice = "Draft changed. Review a fresh candidate before creating.";
      generation++;
      emit();
    },
    async preview() {
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
      state.notice = "Saving the original request identity before sending…";
      emit();
      try {
        let reserved: Awaited<ReturnType<SmithCreateIdentities["reserve"]>>;
        try {
          reserved = await deps.identities.reserve(request);
        } catch (error) {
          state.notice =
            error instanceof Error
              ? `${error.message} No create request was sent.`
              : "The original identity could not be verified. No create request was sent.";
          return;
        }
        let held = entry(reserved.identity.requestId);
        if (!held) {
          held = {
            identity: reserved.identity,
            request: structuredClone(request),
            receipt: null,
            state: "held",
            checking: false,
            notice: "Original request identity saved before delivery.",
          };
          state.entries.push(held);
        }
        state.activeRequestId = reserved.identity.requestId;
        if (!reserved.created) {
          state.preview = null;
          state.notice =
            "This request UUID is already held. Check its original receipt before creating anything else.";
          return;
        }
        if (
          disposed ||
          ticket !== generation ||
          !deps.canWrite() ||
          !samePreviewInput(state.preview, state.target, state.smith)
        ) {
          const retired = await retire(held, "operator-not-sent");
          if (retired) {
            held.state = "not-sent";
            held.notice =
              "The original identity is saved, and the request was not sent. Review again before starting a new request.";
          }
          state.preview = null;
          state.notice = held.notice;
          return;
        }
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
          const retired = await retire(held, "operator-not-sent");
          if (retired) {
            held.state = "not-sent";
            held.notice = `${outcome.message} No request was sent.`;
          }
          state.notice = held.notice;
        } else if (outcome.state === "unknown") {
          held.state = "held";
          held.notice =
            "The create outcome is unknown. Check this original request; it will not be sent again automatically.";
          state.notice = held.notice;
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
          } else if (installed === "invalid") held.state = "held";
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
      if (disposed || !deps.canWrite()) return;
      const ids = requestId
        ? [requestId]
        : state.activeRequestId
          ? [state.activeRequestId]
          : [];
      for (const id of ids) {
        let held = entry(id),
          identity: SmithCreateIdentity | null;
        try {
          identity = deps.identities.read(id);
        } catch {
          if (held)
            held.notice =
              "Saved create metadata could not be verified. Its bytes were kept.";
          continue;
        }
        if (!identity) continue;
        if (identity.retired && identity.retirement === "operator-not-sent") {
          if (held) {
            held.identity = identity;
            held.state = "not-sent";
            held.notice =
              "The request was proven not sent. Review again before starting a new request.";
          }
          continue;
        }
        if (held && identity.retired) {
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
        if (!held) {
          held = {
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
          };
          state.entries.push(held);
        }
        if (held.checking) continue;
        held.checking = true;
        emit();
        try {
          const raw = await deps.readOriginal(id);
          if (!disposed) {
            const installed = await installReceipt(held, raw);
            if (installed === "installed") await retireVerifiedReceipt(held);
            else if (
              installed === "invalid" &&
              identity.retired &&
              identity.retirement !== "operator-not-sent"
            )
              held.notice =
                "The saved outcome remains verified, but its protected receipt details could not be checked. No create was resent.";
          }
        } catch {
          if (!disposed && held.state === "held")
            held.notice =
              "The original receipt could not be read. Its UUID remains held; check it again without resending.";
          else if (
            !disposed &&
            identity.retired &&
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
    async recover() {
      if (disposed) return;
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
          });
        else if (identity.retired) {
          existing.identity = identity;
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
      emit();
      for (const identity of identities)
        if (!identity.retired || identity.retirement !== "operator-not-sent")
          await client.check(identity.requestId);
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
